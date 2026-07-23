import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { buildCausalContextIdentity, causalInputRow, CAUSAL_PREFIX_SCHEMA_VERSION, type CausalInputRow, type CausalSurfaceId } from '../src/lib/causalRecompute'
import { affectedPublicArtifacts, assertArtifactDependencyPlanMatchesSemanticChanges, type ArtifactScopeDependency, type PublicArtifactChange } from '../src/lib/incremental/artifactDependencies'
import { buildCanonicalMatchLedger, canonicalMatchLedgerKey, classifyRankingChange, parseCanonicalMatchLedger } from '../src/lib/incremental/changeClassifier'
import { buildExternalCausalBundle, reconcileExternalCausalBundle, REQUIRED_EXTERNAL_CAUSAL_SURFACES, type ExternalCausalBundle, type ExternalCausalSurfaceInput } from '../src/lib/incremental/externalCausalState'
import { replayRankingState } from '../src/lib/incremental/replayOrchestrator'
import { compareSemanticArtifactMaps, type SemanticArtifactMap } from '../src/lib/incremental/semanticParity'
import { stableDigest, stableJson, type CanonicalMatchLedger, type RankingChangeClassification } from '../src/lib/incremental/types'
import { createRatingReplayContext, replayRatingDates, transparentGprModelMetadata } from '../src/lib/model'
import { RATING_CHECKPOINT_SCHEMA_VERSION, encodeRatingCheckpoint, selectSafeCheckpoint } from '../src/lib/ratingCheckpoint'
import { buildRatingCheckpointEventContract, reconcileRatingCheckpointEvents } from '../src/lib/ratingCheckpointInventory'
import { PUBLIC_ARTIFACT_SCHEMA_VERSION, artifactMetaFor, snapshotKey } from '../src/lib/publicArtifacts/schema'
import { PUBLIC_ARTIFACT_PATHS, publicMatchHistoryPagePath, publicMatchHistoryShardPath, publicScopeArtifactPath, publicTeamHistoryShardPath, publicTournamentMovementShardPath } from '../src/lib/publicArtifacts/writePlan'
import { deriveTournamentInstances, tournamentInstanceForEvent, type TournamentInstanceId } from '../src/lib/internationalTournaments'
import type { MatchRecord } from '../src/types'
import { prepareSemanticArtifact } from './public-artifact-storage.mjs'
import { buildStaticSnapshot, writeReconciliationOutput } from './build-static-snapshot.ts'
import { importRankingSourceData, type RankingSourceImport } from './ranking-source-import.ts'
import {
  prepareContentAddressedState,
  prepareStateObject,
  stateObjectReferenceFor,
  syncContentAddressedStateObject,
  writeIncrementalStateManifest,
  type IncrementalStateManifest,
  type StateCompatibility,
  type StateObjectReference,
} from './incremental-state-storage.mjs'
import type { BucketClient, BucketStorageConfig } from './railway-bucket.mjs'
import { collectRefreshGarbage } from './refresh-worker-memory.mjs'

export const RANKING_INCREMENTAL_IMPORTER_VERSION = 'community-source-import-v1'

type RestoredCheckpoint = {
  candidate: IncrementalStateManifest['checkpoints'][number]
  bundle: Record<string, unknown>
}

export type RestoredIncrementalAuthority = {
  stateManifest: IncrementalStateManifest
  canonicalLedger: Record<string, unknown>
  checkpoints: RestoredCheckpoint[]
  publicManifest: Record<string, unknown>
  rootArtifact?: Record<string, unknown>
  artifacts?: Record<string, unknown>
  loadArtifacts?: (paths: string[]) => Promise<Record<string, unknown>>
  loadCheckpoints?: (candidates?: IncrementalStateManifest['checkpoints']) => Promise<RestoredCheckpoint[]>
}

export type IncrementalBuildMetrics = {
  classification: RankingChangeClassification['kind']
  addedCount: number
  changedCount: number
  removedCount: number
  replayFromUtcDate?: string
  replayedMatchCount: number
  candidateCount: number
  rejectedCandidates: string[]
  selectedBoundary?: string
  fallbackReason?: string
  canonicalRows: number
  canonicalBytes: number
  suffixRows: number
  suffixDates: number
  changedPaths: string[]
  reusedPaths: string[]
  removedPaths: string[]
  semanticBytes: number
  compressedBytes: number
  fullSnapshotWritten: boolean
  parity: boolean | null
  stateParity: boolean | null
  semanticParityReport?: ReturnType<typeof compareSemanticArtifactMaps>
  stateParityReport?: ReturnType<typeof compareIncrementalState>
  materializedScopeCount: number
  providerAvailableAt?: string
  playerLifecycleStages?: Array<{
    name: 'player-build' | 'player-compaction'
    durationMs: number
    input: Record<string, unknown>
    output: Record<string, unknown>
  }>
  memoryCollections?: {
    afterInputRelease?: { heapUsedBytes: number; heapTotalBytes: number; rssBytes: number }
    afterReplayState?: { heapUsedBytes: number; heapTotalBytes: number; rssBytes: number }
  }
}

export type IncrementalStateBuild = {
  ledger: CanonicalMatchLedger
  compatibility: StateCompatibility
  sourceReceiptDigest: string
  checkpoints: Array<{
    boundary: { date: string; matchId: string }
    rawPrefix: { matchCount: number; digest: string }
    ratingCheckpoint?: Record<string, unknown>
    storedObjectReference?: StateObjectReference
    causalSummaries?: {
      sourcedPlayer: Record<string, unknown>
      dssTeam: Record<string, unknown>
      dssRegion: Record<string, unknown>
      rosterEra: Record<string, unknown>
      playerResume: Record<string, unknown>
    }
  }>
}

type SnapshotBuild = Awaited<ReturnType<typeof buildStaticSnapshot>>

export type IncrementalRankingBuildResult =
  | { action: 'no-change'; sourceData: RankingSourceImport; metrics: IncrementalBuildMetrics }
  | {
      action: 'publish-full'
      sourceData: RankingSourceImport
      build: SnapshotBuild
      state: IncrementalStateBuild
      diagnostic?: IncrementalDiagnostic
      metrics: IncrementalBuildMetrics
    }
  | {
      action: 'publish-incremental'
      sourceData: RankingSourceImport
      build?: SnapshotBuild
      rootManifest?: Record<string, unknown>
      state: IncrementalStateBuild
      patch: {
        previousManifest: Record<string, unknown>
        changedArtifacts: Array<{ logicalPath: string; value: unknown }>
        removedLogicalPaths: string[]
        expectedLogicalPaths: string[]
      }
      diagnostic?: IncrementalDiagnostic
      metrics: IncrementalBuildMetrics
    }

export type IncrementalDiagnostic = {
  schemaVersion: 1
  kind: 'incremental-fallback' | 'shadow-parity'
  reason: string
  classification?: string
  parity?: ReturnType<typeof compareSemanticArtifactMaps>
  stateParity?: { equal: boolean; expectedDigest: string; actualDigest: string; expectedCheckpointDigests: string[]; actualCheckpointDigests: string[] }
}

/** Release replay inputs once state persistence has completed and only the public patch remains to publish. */
export function releasePersistedIncrementalInputs(
  result: Exclude<IncrementalRankingBuildResult, { action: 'no-change' }>,
  restored?: RestoredIncrementalAuthority,
) {
  result.sourceData.matches.length = 0
  result.sourceData.importedMatches.length = 0
  result.state.ledger.rows.length = 0
  result.state.checkpoints.length = 0
  if (restored) {
    restored.checkpoints.length = 0
    const rows = restored.canonicalLedger.rows
    if (Array.isArray(rows)) rows.length = 0
  }
}

function releaseRestoredReplayPayloads(restored: RestoredIncrementalAuthority) {
  restored.checkpoints = []
  restored.canonicalLedger = {}
  restored.loadCheckpoints = undefined
}

export async function persistIncrementalStateBuild({
  state,
  generationId,
  runId = generationId,
  baseGenerationId = null,
  baseRunId = null,
  client,
  config,
}: {
  state: IncrementalStateBuild
  generationId: string
  runId?: string
  baseGenerationId?: string | null
  baseRunId?: string | null
  client: BucketClient
  config: BucketStorageConfig
}) {
  const ledgerPrepared = prepareStateObject(state.ledger)
  const ledgerSync = await syncContentAddressedStateObject(client, config, ledgerPrepared)
  const prepared = prepareContentAddressedState({
    generationId, runId, baseGenerationId, baseRunId,
    canonicalLedgerReference: stateObjectReferenceFor(ledgerPrepared),
    sourceReceiptDigest: state.sourceReceiptDigest,
    compatibility: state.compatibility,
    checkpoints: state.checkpoints,
  })
  const objectResults = []
  for (const object of prepared.objects) objectResults.push(await syncContentAddressedStateObject(client, config, object))
  // Promotion validates the ledger and every checkpoint body before activation,
  // so avoid repeating that exhaustive audit while writing the immutable manifest.
  const manifest = await writeIncrementalStateManifest(client, config, prepared, { verifyObjects: false })
  return {
    authority: manifest.authority,
    uploadedBytes: [ledgerSync, ...objectResults, manifest.result]
      .filter((entry) => entry.status === 'uploaded').reduce((sum, entry) => sum + Number(entry.bytes), 0),
    objectCount: 2 + objectResults.length,
    ledgerBytes: ledgerPrepared.bytes,
    ledgerCompressedBytes: ledgerPrepared.compressedBytes,
    checkpointCount: state.checkpoints.length,
  }
}

export async function buildRankingIncrementally({
  mode,
  cause,
  enabled,
  manifestPath,
  output,
  publicDataDir,
  reconciliationOutput,
  generatedAt = new Date().toISOString(),
  restored,
  diagnosticPath,
  env = process.env,
  sourceData: providedSourceData,
  silent = false,
  buildSnapshot = buildStaticSnapshot,
  sourceReceiptDigest,
}: {
  mode: 'legacy' | 'shadow' | 'gated'
  cause: string
  enabled: boolean
  manifestPath: string
  output: string
  publicDataDir: string
  reconciliationOutput?: string
  generatedAt?: string
  restored?: RestoredIncrementalAuthority
  diagnosticPath?: string
  env?: NodeJS.ProcessEnv
  sourceData?: RankingSourceImport
  silent?: boolean
  buildSnapshot?: typeof buildStaticSnapshot
  sourceReceiptDigest?: string
}): Promise<IncrementalRankingBuildResult> {
  const sourceData = providedSourceData ?? await importRankingSourceData({ manifestPath })
  const importedMatchCount = sourceData.importedMatches.length
  restored = restored ? { ...restored } : undefined
  const ledger = buildCurrentCanonicalLedger(sourceData, restored)
  const auditComparison = cause === 'daily-audit'
  const comparisonMode = mode === 'shadow' || auditComparison
  const forceFull = !enabled || mode === 'legacy' || cause === 'manual-force'
  if (forceFull) {
    const full = await buildSnapshot({ output, publicDataDir, reconciliationOutput, sourceData, generatedAt, env, silent })
    const state = buildStateFromFullReplay(sourceData, ledger, generatedAt, sourceReceiptDigest)
    return {
      action: 'publish-full', sourceData, build: full, state,
      metrics: baseMetrics('full-invalidation', ledger, { fullSnapshotWritten: true }),
    }
  }

  let classification: RankingChangeClassification | undefined
  let candidateDir: string | undefined
  const memoryCollections: NonNullable<IncrementalBuildMetrics['memoryCollections']> = {}
  try {
    if (!restored) throw new Error('incremental-state-missing')
    let previousLedger: CanonicalMatchLedger | undefined = parseCanonicalMatchLedger(restored.canonicalLedger)
    classification = classifyRankingChange(previousLedger, ledger, ledger.compatibility)
    if (classification.kind === 'no-change' && !auditComparison) {
      await emitReconciliation(reconciliationOutput, sourceData.importedMatches, generatedAt)
      return { action: 'no-change', sourceData, metrics: baseMetrics('no-change', ledger) }
    }
    if (classification.kind === 'no-change' && auditComparison) {
      const full = await buildSnapshot({ output, publicDataDir, reconciliationOutput, sourceData, generatedAt, env, silent })
      const fullState = buildStateFromFullReplay(sourceData, ledger, generatedAt, sourceReceiptDigest)
      const candidateState = await stateFromRestoredAudit(restored, ledger)
      const parity = compareSemanticArtifactMaps(semanticMapFromWrites(full.publicPlan.writes), semanticMapFromGeneration(restored.publicManifest))
      const stateReport = compareIncrementalState(fullState, candidateState)
      return {
        action: 'publish-full', sourceData, build: full, state: fullState,
        metrics: baseMetrics('no-change', ledger, {
          fullSnapshotWritten: true, parity: parity.equal, stateParity: stateReport.equal,
          semanticParityReport: parity, stateParityReport: stateReport,
          candidateCount: restored.stateManifest.checkpoints.length,
        }),
      }
    }
    if (classification.kind === 'full-invalidation') throw new Error(classification.reasons.join(',') || 'full-invalidation')
    if (classification.kind === 'metadata-only') {
      if (!restored.rootArtifact) throw new Error('metadata-only-root-artifact-missing')
      const rootManifest = metadataOnlyRootArtifact(restored.rootArtifact, sourceData, generatedAt)
      const rootPrepared = prepareSemanticArtifact(rootManifest)
      const state = buildMetadataOnlyState(sourceData, ledger, restored, sourceReceiptDigest)
      const expectedLogicalPaths = Object.keys(requiredRecord(restored.publicManifest.artifacts, 'public generation artifacts')).sort()
      const changedPath = '/data/ranking-summary.json'
      await emitReconciliation(reconciliationOutput, sourceData.importedMatches, generatedAt)
      return {
        action: 'publish-incremental', sourceData, rootManifest, state,
        patch: {
          previousManifest: restored.publicManifest,
          changedArtifacts: [{ logicalPath: changedPath, value: rootManifest }],
          removedLogicalPaths: [], expectedLogicalPaths,
        },
        metrics: {
          ...baseMetrics('metadata-only', ledger, {
            addedCount: classification.addedKeys.length,
            changedCount: classification.changedKeys.length,
            removedCount: classification.removedKeys.length,
          }), changedPaths: [changedPath],
          reusedPaths: expectedLogicalPaths.filter((path) => path !== changedPath),
          semanticBytes: rootPrepared.bytes,
          compressedBytes: rootPrepared.compressedBytes,
        },
      }
    }

    if (!restored.rootArtifact) throw new Error('verified-active-root-artifact-missing')
    if (mode === 'gated' && !comparisonMode) {
      sourceData.mergedTeams = {}
    }
    const changes = changesForClassification(previousLedger, ledger, classification)
    previousLedger = undefined
    if (mode === 'gated' && !comparisonMode) memoryCollections.afterInputRelease = collectRefreshGarbage()
    const replay = await selectReplay(restored, sourceData, ledger, classification, generatedAt)
    releaseRestoredReplayPayloads(restored)
    const {
      replayModel,
      state,
      replayedMatchCount,
    } = replayAndBuildTerminalState(
      sourceData,
      ledger,
      restored,
      replay,
      generatedAt,
      comparisonMode,
      sourceReceiptDigest,
    )
    replay.checkpointState = undefined
    if (mode === 'gated' && !comparisonMode) memoryCollections.afterReplayState = collectRefreshGarbage()
    const dependencyArtifacts = restored.loadArtifacts
      ? { ...restored.artifacts, ...await restored.loadArtifacts([
          `/data/${PUBLIC_ARTIFACT_PATHS.matchHistoryIndex}`,
          `/data/${PUBLIC_ARTIFACT_PATHS.teamHistoryIndex}`,
          `/data/${PUBLIC_ARTIFACT_PATHS.tournamentMovementIndex}`,
        ]) }
      : restored.artifacts
    const preliminaryPlan = scopedDependencyPlan(changes, classification, restored.rootArtifact, restored.publicManifest, dependencyArtifacts)
    const affectedLogicalPaths = new Set(preliminaryPlan.logicalPaths.map(stripDataPrefix))
    const affectedSnapshotKeys = snapshotKeysForPlan(restored.rootArtifact, preliminaryPlan.logicalPaths, changes)
    const affectedTournamentIds = tournamentIdsForPlan(preliminaryPlan.logicalPaths, changes)
    const previousArtifacts = restored.loadArtifacts
      ? { ...restored.artifacts, ...await restored.loadArtifacts(previousArtifactMergePaths(preliminaryPlan.logicalPaths)) }
      : restored.artifacts
    if (!previousArtifacts) throw new Error('verified-active-artifacts-missing')
    candidateDir = `${publicDataDir}.incremental-${process.pid}-${Date.now()}`
    const candidate = await buildSnapshot({
      output,
      publicDataDir: candidateDir,
      reconciliationOutput,
      sourceData,
      generatedAt,
      precomputedGlobalRanking: replayModel,
      affectedLogicalPaths,
      affectedSnapshotKeys,
      affectedTournamentIds,
      previousArtifacts,
      importedMatchCount,
      releaseImportAuditBeforeSnapshot: mode === 'gated' && !comparisonMode,
      writeFullSnapshot: false,
      replacePublicDirectory: false,
      env,
      silent,
    })
    const validScopeKeys = publishedScopeKeys(candidate.publicPlan.manifest)
    const validTournamentIds = new Set(deriveTournamentInstances({
      matches: sourceData.matches,
      scheduleReferences: sourceData.tournamentScheduleReferences,
      generatedAt,
    }).map((instance) => instance.id))
    const playerDirectoryWrite = candidate.publicPlan.writes.find((write) => write.relativePath === PUBLIC_ARTIFACT_PATHS.players)
    const previousPlayerDirectory = optionalRecord(previousArtifacts[`/data/${PUBLIC_ARTIFACT_PATHS.players}`])
    if (playerDirectoryWrite && previousPlayerDirectory) {
      playerDirectoryWrite.value = mergePartialPlayerDirectoryArtifact(
        requiredRecord(playerDirectoryWrite.value, 'candidate player directory'),
        previousPlayerDirectory,
        affectedSnapshotKeys,
        validScopeKeys,
      )
    }
    prunePartialPublicIndexes(candidate.publicPlan.writes, validScopeKeys, validTournamentIds)
    const previousSemantic = semanticMapFromGeneration(restored.publicManifest)
    const candidateSemantic = semanticMapFromWrites(candidate.publicPlan.writes)
    const currentSemantic = { ...previousSemantic, ...candidateSemantic }
    const removedPaths = obsoletePublicArtifactPaths({
      previousPaths: Object.keys(previousSemantic),
      previousRoot: restored.rootArtifact,
      candidateWrites: candidate.publicPlan.writes,
      validScopeKeys,
      validTournamentIds,
    })
    for (const path of removedPaths) delete currentSemantic[path]
    const dependencyPlan = affectedPublicArtifacts({
      changes,
      inventory: dependencyInventory(restored.rootArtifact, restored.publicManifest, changes, previousArtifacts),
      previousSemanticArtifacts: previousSemantic,
      currentSemanticArtifacts: currentSemantic,
    })
    assertArtifactDependencyPlanMatchesSemanticChanges(dependencyPlan, previousSemantic, currentSemantic)
    const changed = new Set(dependencyPlan.logicalPaths)
    const currentPaths = Object.keys(currentSemantic).sort()
    const changedWrites = candidate.publicPlan.writes.filter((write) => changed.has(`/data/${write.relativePath}`))
    const root = candidate.publicPlan.writes.find((write) => write.relativePath === 'ranking-summary.json')
    if (root && !changedWrites.includes(root)) changedWrites.push(root)
    let parity: boolean | null = null

    if (comparisonMode) {
      const full = await buildSnapshot({ output, publicDataDir, reconciliationOutput, sourceData, generatedAt, env, silent })
      const fullState = buildStateFromFullReplay(sourceData, ledger, generatedAt, sourceReceiptDigest)
      const report = compareSemanticArtifactMaps(
        semanticMapFromWrites(full.publicPlan.writes),
        currentSemantic,
      )
      const stateReport = compareIncrementalState(fullState, state)
      const stateParity = stateReport.equal
      parity = report.equal && stateParity
      if (!parity) {
        const diagnostic = await persistDiagnostic(diagnosticPath, {
          schemaVersion: 1, kind: 'shadow-parity', reason: report.equal ? 'checkpoint-state-parity-mismatch' : 'semantic-parity-mismatch', classification: classification.kind, parity: report, stateParity: stateReport,
        })
        await rm(candidateDir, { recursive: true, force: true })
        return {
          action: 'publish-full', sourceData, build: full, state: fullState, diagnostic,
          metrics: { ...withMemoryCollections(withPlayerLifecycle(withArtifactBytes(metricsFor(classification, ledger, replay, replayedMatchCount, currentSemantic, [], currentPaths, removedPaths, true, false, stateParity, affectedSnapshotKeys.size), candidate.publicPlan.writes), candidate), memoryCollections), semanticParityReport: report, stateParityReport: stateReport },
        }
      }
      await rm(candidateDir, { recursive: true, force: true })
      return {
        action: 'publish-full', sourceData, build: full, state: fullState, metrics: { ...withMemoryCollections(withPlayerLifecycle(withArtifactBytes(metricsFor(classification, ledger, replay, replayedMatchCount, currentSemantic, dependencyPlan.logicalPaths, currentPaths.filter((path) => !changed.has(path)), removedPaths, true, true, true, affectedSnapshotKeys.size), candidate.publicPlan.writes), candidate), memoryCollections), semanticParityReport: report, stateParityReport: stateReport },
      }
    }

    await rm(candidateDir, { recursive: true, force: true })
    releaseMatchRosterPayloads(sourceData.matches)
    return {
      action: 'publish-incremental', sourceData, state,
      patch: {
        previousManifest: restored.publicManifest,
        changedArtifacts: changedWrites.map((write) => ({ logicalPath: `/data/${write.relativePath}`, value: write.value })),
        removedLogicalPaths: removedPaths,
        expectedLogicalPaths: currentPaths,
      },
      metrics: withMemoryCollections(withPlayerLifecycle(withArtifactBytes(metricsFor(classification, ledger, replay, replayedMatchCount, currentSemantic, changedWrites.map((write) => `/data/${write.relativePath}`).sort(), currentPaths.filter((path) => !changed.has(path)), removedPaths, false, parity, null, affectedSnapshotKeys.size), changedWrites), candidate), memoryCollections),
    }
  } catch (error) {
    if (candidateDir) await rm(candidateDir, { recursive: true, force: true })
    const reason = error instanceof Error ? error.message : String(error)
    const diagnostic = await persistDiagnostic(diagnosticPath, {
      schemaVersion: 1, kind: 'incremental-fallback', reason,
      ...(classification ? {
        classification: classification.kind,
        classificationReasons: classification.reasons,
        addedKeys: classification.addedKeys,
        removedKeys: classification.removedKeys,
        changedKeys: classification.changedKeys,
      } : {}),
    })
    const full = await buildSnapshot({ output, publicDataDir, reconciliationOutput, sourceData, generatedAt, importedMatchCount, env, silent })
    const state = buildStateFromFullReplay(sourceData, ledger, generatedAt, sourceReceiptDigest)
    const metrics = baseMetrics(classification?.kind ?? 'full-invalidation', ledger, {
      fullSnapshotWritten: true,
      fallbackReason: reason,
      addedCount: classification?.addedKeys.length ?? 0,
      changedCount: classification?.changedKeys.length ?? 0,
      removedCount: classification?.removedKeys.length ?? 0,
    })
    return { action: 'publish-full', sourceData, build: full, state, diagnostic, metrics }
  }
}

async function emitReconciliation(
  reconciliationOutput: string | undefined,
  importedMatches: MatchRecord[],
  generatedAt: string | undefined,
) {
  if (!reconciliationOutput) return
  await writeReconciliationOutput({
    reconciliationOutput,
    importedMatches,
    generatedAt: generatedAt ?? new Date().toISOString(),
  })
}

function buildCurrentCanonicalLedger(
  sourceData: RankingSourceImport,
  restored: RestoredIncrementalAuthority | undefined,
) {
  let previous: CanonicalMatchLedger | undefined
  if (restored) {
    try { previous = parseCanonicalMatchLedger(restored.canonicalLedger) } catch { /* fail closed in the guarded path below */ }
  }
  return buildCanonicalMatchLedger(sourceData.matches, ledgerContext(sourceData, previous))
}

function replayAndBuildTerminalState(
  sourceData: RankingSourceImport,
  ledger: CanonicalMatchLedger,
  restored: RestoredIncrementalAuthority,
  replay: Awaited<ReturnType<typeof selectReplay>>,
  generatedAt: string,
  persistTerminalCheckpoint: boolean,
  sourceReceiptDigest?: string,
) {
  const result = replayRankingState({
    authoritativeMatches: sourceData.matches,
    teams: sourceData.teams,
    tournamentLifecycles: tournamentLifecyclesFor(sourceData, generatedAt),
    ...(replay.checkpointState ? { checkpointState: replay.checkpointState } : {}),
    ...(replay.replayFromUtcDate ? { replayFromUtcDate: replay.replayFromUtcDate } : {}),
  })
  return {
    replayModel: result.model,
    replayedMatchCount: result.replayedMatchCount,
    state: buildTerminalState(
      sourceData,
      ledger,
      result.state,
      restored,
      generatedAt,
      persistTerminalCheckpoint || result.replayedMatchCount >= 100,
      sourceReceiptDigest,
    ),
  }
}

function releaseMatchRosterPayloads(matches: MatchRecord[]) {
  for (const match of matches) {
    match.teamARoster = undefined
    match.teamBRoster = undefined
  }
}

function previousArtifactMergePaths(logicalPaths: string[]) {
  const mergePaths = new Set([
    `/data/${PUBLIC_ARTIFACT_PATHS.manifest}`,
    `/data/${PUBLIC_ARTIFACT_PATHS.teamHistoryIndex}`,
    `/data/${PUBLIC_ARTIFACT_PATHS.matchHistoryIndex}`,
    `/data/${PUBLIC_ARTIFACT_PATHS.tournamentMovementIndex}`,
    `/data/${PUBLIC_ARTIFACT_PATHS.regionHistory}`,
    `/data/${PUBLIC_ARTIFACT_PATHS.players}`,
  ])
  return logicalPaths.filter((path) => mergePaths.has(path))
}

function publishedScopeKeys(manifest: Record<string, unknown>) {
  const keys = new Set([snapshotKey({ season: 'All', event: 'All', region: 'All' })])
  const options = optionalRecord(manifest.filterOptions)
  for (const season of Array.isArray(options?.seasons) ? options.seasons : []) {
    if (typeof season === 'string' && season !== 'All') keys.add(snapshotKey({ season, event: 'All', region: 'All' }))
  }
  const checkpoints = optionalRecord(options?.checkpoints)
  for (const [season, values] of Object.entries(checkpoints ?? {})) {
    if (!Array.isArray(values)) continue
    for (const value of values) {
      const checkpoint = optionalRecord(value)
      if (typeof checkpoint?.id === 'string') keys.add(snapshotKey({ season, event: 'All', region: 'All', checkpoint: checkpoint.id }))
    }
  }
  return keys
}

function prunePartialPublicIndexes(
  writes: SnapshotBuild['publicPlan']['writes'],
  validScopeKeys: ReadonlySet<string>,
  validTournamentIds: ReadonlySet<string>,
) {
  for (const write of writes) {
    const value = optionalRecord(write.value)
    if (!value) continue
    if (write.relativePath === PUBLIC_ARTIFACT_PATHS.manifest) {
      write.value = pruneRecordEntries(value, 'snapshotIndex', validScopeKeys)
    } else if (write.relativePath === PUBLIC_ARTIFACT_PATHS.teamHistoryIndex
      || write.relativePath === PUBLIC_ARTIFACT_PATHS.matchHistoryIndex) {
      write.value = pruneRecordEntries(value, 'scopeIndex', validScopeKeys)
    } else if (write.relativePath === PUBLIC_ARTIFACT_PATHS.regionHistory) {
      write.value = pruneRecordEntries(value, 'scopes', validScopeKeys)
    } else if (write.relativePath === PUBLIC_ARTIFACT_PATHS.tournamentMovementIndex && Array.isArray(value.tournaments)) {
      write.value = {
        ...value,
        tournaments: value.tournaments.filter((entry) => {
          const tournament = optionalRecord(entry)
          return typeof tournament?.id === 'string' && validTournamentIds.has(tournament.id)
        }),
      }
    }
  }
}

function pruneRecordEntries(value: Record<string, unknown>, key: string, allowed: ReadonlySet<string>) {
  const entries = optionalRecord(value[key])
  if (!entries) return value
  return { ...value, [key]: Object.fromEntries(Object.entries(entries).filter(([entryKey]) => allowed.has(entryKey))) }
}

export function mergePartialPlayerDirectoryArtifact(
  candidate: Record<string, unknown>,
  previous: Record<string, unknown>,
  affectedScopeKeys: ReadonlySet<string>,
  validScopeKeys: ReadonlySet<string>,
) {
  const merged = { ...candidate }
  const scopedPlayers = mergeUnaffectedScopedRecords(
    optionalRecord(previous.scopedPlayers),
    optionalRecord(candidate.scopedPlayers),
    affectedScopeKeys,
    validScopeKeys,
  )
  if (Object.keys(scopedPlayers).length > 0) merged.scopedPlayers = scopedPlayers
  else delete merged.scopedPlayers

  const candidateDiagnostics = optionalRecord(candidate.diagnostics) ?? {}
  const previousDiagnostics = optionalRecord(previous.diagnostics)
  const scopedDiagnostics = mergeUnaffectedScopedRecords(
    optionalRecord(previousDiagnostics?.scopedSameTeamTopFiveClustering),
    optionalRecord(candidateDiagnostics.scopedSameTeamTopFiveClustering),
    affectedScopeKeys,
    validScopeKeys,
  )
  const diagnostics = { ...candidateDiagnostics }
  if (Object.keys(scopedDiagnostics).length > 0) diagnostics.scopedSameTeamTopFiveClustering = scopedDiagnostics
  else delete diagnostics.scopedSameTeamTopFiveClustering
  merged.diagnostics = diagnostics
  return merged
}

function mergeUnaffectedScopedRecords(
  previous: Record<string, unknown> | undefined,
  candidate: Record<string, unknown> | undefined,
  affectedScopeKeys: ReadonlySet<string>,
  validScopeKeys: ReadonlySet<string>,
) {
  return Object.fromEntries([
    ...Object.entries(previous ?? {}).filter(([key]) => validScopeKeys.has(key) && !affectedScopeKeys.has(key)),
    ...Object.entries(candidate ?? {}).filter(([key]) => validScopeKeys.has(key)),
  ])
}

function obsoletePublicArtifactPaths({
  previousPaths,
  previousRoot,
  candidateWrites,
  validScopeKeys,
  validTournamentIds,
}: {
  previousPaths: string[]
  previousRoot: Record<string, unknown>
  candidateWrites: SnapshotBuild['publicPlan']['writes']
  validScopeKeys: ReadonlySet<string>
  validTournamentIds: ReadonlySet<string>
}) {
  const removed = new Set<string>()
  const previousScopeKeys = Object.keys(requiredRecord(previousRoot.snapshotIndex, 'ranking root snapshot index'))
  for (const key of previousScopeKeys) {
    if (validScopeKeys.has(key)) continue
    removed.add(`/data/${publicScopeArtifactPath(key)}`)
    removed.add(`/data/${publicTeamHistoryShardPath(key)}`)
    removed.add(`/data/${publicMatchHistoryShardPath(key)}`)
    const pagePrefix = `/data/${publicMatchHistoryPagePath(key, 1).replace(/-1\.json$/, '-')}`
    for (const path of previousPaths) if (isNumberedPagePath(path, pagePrefix)) removed.add(path)
  }
  const tournamentPrefix = `/data/${PUBLIC_ARTIFACT_PATHS.tournamentMovementShardDir}/`
  const validTournamentPaths = new Set([...validTournamentIds].map((id) => `/data/${publicTournamentMovementShardPath(id as TournamentInstanceId)}`))
  for (const path of previousPaths) {
    if (!path.startsWith(tournamentPrefix) || path.endsWith('/index.json')) continue
    if (!validTournamentPaths.has(path)) removed.add(path)
  }
  for (const write of candidateWrites) {
    if (!write.relativePath.startsWith(`${PUBLIC_ARTIFACT_PATHS.matchHistoryShardDir}/`)
      || write.relativePath === PUBLIC_ARTIFACT_PATHS.matchHistoryIndex
      || write.relativePath.startsWith(`${PUBLIC_ARTIFACT_PATHS.matchHistoryPageDir}/`)) continue
    const catalog = optionalRecord(write.value)
    const filter = optionalRecord(catalog?.filter)
    if (!filter || !Array.isArray(catalog?.pages)) continue
    const key = snapshotKey(filter as Parameters<typeof snapshotKey>[0])
    const validPages = new Set(catalog.pages.flatMap((page) => {
      const entry = optionalRecord(page)
      const path = logicalUrlPath(entry?.url)
      return path ? [path] : []
    }))
    const pagePrefix = `/data/${publicMatchHistoryPagePath(key, 1).replace(/-1\.json$/, '-')}`
    for (const path of previousPaths) if (isNumberedPagePath(path, pagePrefix) && !validPages.has(path)) removed.add(path)
  }
  return [...removed].filter((path) => previousPaths.includes(path)).sort()
}

function isNumberedPagePath(path: string, prefix: string) {
  return path.startsWith(prefix) && /^\d+\.json$/.test(path.slice(prefix.length))
}

function ledgerContext(sourceData: RankingSourceImport, previous?: CanonicalMatchLedger) {
  const previousByKey = new Map(previous?.rows.map((row) => [row.key, row]) ?? [])
  const scheduleCausalRows = scheduleCausalRowsFor(sourceData)
  return {
    modelVersion: transparentGprModelMetadata.version,
    modelConfigHash: transparentGprModelMetadata.configHash,
    importerVersion: RANKING_INCREMENTAL_IMPORTER_VERSION,
    identityTaxonomyHash: stableDigest(sourceData.teams),
    scheduleReceiptIdentity: stableDigest(scheduleCausalRows),
    contextReceiptIdentity: stableDigest(sourceData.teams),
    provenanceReceiptIdentity: stableDigest(sourceData.externalSources),
    teams: sourceData.teams,
    scheduleCausalRows,
    providerAvailableAtForMatch: (match: RankingSourceImport['matches'][number]) => {
      const prior = previousByKey.get(canonicalMatchLedgerKey(match))
      const teamContext = { teamA: sourceData.teams[match.teamA], teamB: sourceData.teams[match.teamB] }
      if (prior?.scoringDigest === stableDigest({ match, teamContext }) && prior.providerAvailableAt) return prior.providerAvailableAt
      return providerReceiptForMatch(sourceData, match)
    },
  }
}

function stateCompatibility(sourceData: RankingSourceImport): StateCompatibility {
  return {
    modelVersion: transparentGprModelMetadata.version,
    modelConfigHash: transparentGprModelMetadata.configHash,
    importerVersion: RANKING_INCREMENTAL_IMPORTER_VERSION,
    taxonomyVersion: stableDigest(sourceData.teams),
    ratingCheckpointSchemaVersion: RATING_CHECKPOINT_SCHEMA_VERSION,
    causalPrefixSchemaVersion: CAUSAL_PREFIX_SCHEMA_VERSION,
    publicArtifactSchemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
  }
}

async function selectReplay(
  restored: RestoredIncrementalAuthority,
  sourceData: RankingSourceImport,
  ledger: CanonicalMatchLedger,
  classification: RankingChangeClassification,
  generatedAt: string,
) {
  const changedDate = classification.earliestChangedUtcDate
  if (!changedDate) return { replayFromUtcDate: undefined, rejectedCandidates: [], candidateCount: restored.stateManifest.checkpoints.length }
  const eligibleReferences = restored.stateManifest.checkpoints
    .filter((candidate) => candidate.boundary.date < changedDate && rawPrefixMatchesLedger(candidate.rawPrefix, ledger, candidate.boundary.date))
    .toReversed()
  const checkpointIdentity = (candidate: IncrementalStateManifest['checkpoints'][number]) =>
    `${candidate.boundary.date}\u0000${candidate.boundary.matchId}\u0000${candidate.object.sha256}`
  const loadedByObject = new Map(restored.checkpoints.map((checkpoint) => [checkpointIdentity(checkpoint.candidate), checkpoint]))
  const checkpoints: RestoredCheckpoint[] = []
  const availableProcessedThroughUtcDates = eligibleReferences.map((candidate) => candidate.boundary.date)
  const selectLoadedCheckpoint = () => selectSafeCheckpoint({
    changedUtcDate: changedDate,
    candidates: checkpoints.map(({ candidate, bundle }) => ({
      id: `${candidate.boundary.date}/${candidate.boundary.matchId}`,
      processedThroughUtcDate: candidate.boundary.date,
      serialized: stableJson(bundle.ratingCheckpoint),
      expectedIdentity: {
        importerVersion: RANKING_INCREMENTAL_IMPORTER_VERSION,
        identityTaxonomyHash: stableDigest(sourceData.teams),
        rawLedgerPrefixHash: candidate.rawPrefix.digest,
      },
    })),
    reconcileCausalProof: (checkpoint) => {
      const stored = checkpoints.find(({ candidate }) => candidate.boundary.date === checkpoint.metadata.processedThroughUtcDate
        && candidate.boundary.matchId === checkpoint.metadata.processedThroughMatchId)
      if (!stored) return { status: 'replay-required', replayFromUtcDate: changedDate, requiresFullReplay: true, reason: 'context-unproven' }
      try {
        const throughDate = checkpoint.metadata.processedThroughUtcDate
        const freshContext = createRatingReplayContext(sourceData.matches, sourceData.teams, {
          tournamentLifecycles: tournamentLifecyclesFor(sourceData, generatedAt, throughDate),
        })
        const eventReconciliation = reconcileRatingCheckpointEvents({
          checkpoint,
          freshMatches: freshContext.authoritativeMatches,
          freshEventWeightContext: freshContext.eventWeightContext,
          freshTournamentLifecycles: tournamentLifecyclesFor(sourceData, generatedAt, throughDate),
          availableProcessedThroughUtcDates,
        })
        if (eventReconciliation.status === 'replay-required') {
          return {
            status: 'replay-required', replayFromUtcDate: eventReconciliation.replayFromUtcDate,
            requiresFullReplay: eventReconciliation.requiresFullReplay, reason: eventReconciliation.reason,
          }
        }
        const bundle = externalBundleFromSummaries(stored.bundle.causalSummaries, throughDate)
        const prefixMatches = sourceData.matches.filter((match) => match.date <= throughDate)
        const reconciliation = reconcileExternalCausalBundle({
          bundle,
          authoritativeMatches: prefixMatches,
          eventWeightContext: checkpoint.state.eventWeightContext,
          tournamentLifecycles: tournamentLifecyclesFor(sourceData, generatedAt, throughDate),
          surfaces: externalCausalSurfacesFor(sourceData, throughDate),
          availableProcessedThroughUtcDates,
        })
        return reconciliation.status === 'ready'
          ? { status: 'ready' }
          : {
              status: 'replay-required', replayFromUtcDate: reconciliation.replayFromUtcDate,
              requiresFullReplay: reconciliation.requiresFullReplay, reason: reconciliation.reasons.join(','),
            }
      } catch {
        return { status: 'replay-required', replayFromUtcDate: changedDate, requiresFullReplay: true, reason: 'context-unproven' }
      }
    },
  })
  for (const candidate of eligibleReferences) {
    const identity = checkpointIdentity(candidate)
    let loaded = loadedByObject.get(identity)
    if (!loaded && restored.loadCheckpoints) {
      loaded = (await restored.loadCheckpoints([candidate]))[0]
      if (loaded) loadedByObject.set(identity, loaded)
    }
    if (!loaded) continue
    checkpoints.push(loaded)
    const selected = selectLoadedCheckpoint()
    if (selected.status === 'selected') {
      return {
        checkpointState: selected.checkpoint.state,
        replayFromUtcDate: utcDateAfter(selected.checkpoint.metadata.processedThroughUtcDate),
        selectedBoundary: selected.checkpoint.metadata.processedThroughUtcDate,
        rejectedCandidates: selected.rejectedCandidateIds,
        candidateCount: eligibleReferences.length,
      }
    }
    if (selected.reason !== 'no-safe-checkpoint') throw new Error(`checkpoint-${selected.reason}`)
  }
  throw new Error('checkpoint-no-safe-checkpoint')
}

function buildStateFromFullReplay(
  sourceData: RankingSourceImport,
  ledger: CanonicalMatchLedger,
  generatedAt = new Date().toISOString(),
  sourceReceiptDigest?: string,
): IncrementalStateBuild {
  const lifecycles = tournamentLifecyclesFor(sourceData, generatedAt)
  const context = createRatingReplayContext(sourceData.matches, sourceData.teams, { tournamentLifecycles: lifecycles })
  const terminalDates = new Set<string>()
  const lastBySeason = new Map<number, string>()
  const lastByEvent = new Map<string, string>()
  for (const match of context.authoritativeMatches) {
    lastBySeason.set(match.season, match.date)
    lastByEvent.set(match.event, match.date)
  }
  for (const date of [...lastBySeason.values(), ...lastByEvent.values()]) terminalDates.add(date)
  const finalDate = context.authoritativeMatches.at(-1)?.date
  if (finalDate) terminalDates.add(finalDate)
  let state: ReturnType<typeof replayRatingDates> | undefined
  const checkpoints: IncrementalStateBuild['checkpoints'] = []
  for (const date of [...new Set(context.authoritativeMatches.map((match) => match.date))]) {
    const dateMatches = context.authoritativeMatches.filter((match) => match.date === date)
    state = replayRatingDates({ context, ...(state ? { state } : {}), replayMatches: dateMatches })
    if (terminalDates.has(date)) {
      try {
        checkpoints.push(checkpointFromState(sourceData, ledger, state, generatedAt))
      } catch (error) {
        if (date === finalDate) throw error
      }
    }
  }
  if (!state || checkpoints.length === 0) throw new Error('Cannot bootstrap incremental checkpoints without rated matches')
  return {
    ledger, compatibility: stateCompatibility(sourceData),
    sourceReceiptDigest: resolvedSourceReceiptDigest(sourceReceiptDigest, ledger),
    checkpoints,
  }
}

function buildMetadataOnlyState(
  sourceData: RankingSourceImport,
  ledger: CanonicalMatchLedger,
  restored: RestoredIncrementalAuthority,
  sourceReceiptDigest?: string,
): IncrementalStateBuild {
  return {
    ledger,
    compatibility: stateCompatibility(sourceData),
    sourceReceiptDigest: resolvedSourceReceiptDigest(sourceReceiptDigest, ledger),
    checkpoints: restored.stateManifest.checkpoints.map((candidate) => ({
      boundary: candidate.boundary,
      rawPrefix: candidate.rawPrefix,
      storedObjectReference: candidate.object,
    })),
  }
}

function metadataOnlyRootArtifact(previous: Record<string, unknown>, sourceData: RankingSourceImport, generatedAt: string) {
  return {
    ...previous,
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    generatedAt,
    source: sourceData.source,
    dataMode: sourceData.dataMode,
    sources: sourceData.externalSources,
    model: { version: transparentGprModelMetadata.version, configHash: transparentGprModelMetadata.configHash },
    artifactMeta: artifactMetaFor({
      generatedAt,
      modelVersion: transparentGprModelMetadata.version,
      modelConfigHash: transparentGprModelMetadata.configHash,
    }),
  }
}

function buildTerminalState(
  sourceData: RankingSourceImport,
  ledger: CanonicalMatchLedger,
  state: ReturnType<typeof replayRankingState>['state'],
  restored: RestoredIncrementalAuthority,
  generatedAt: string,
  persistTerminalCheckpoint: boolean,
  sourceReceiptDigest?: string,
): IncrementalStateBuild {
  const previous = restored.stateManifest.checkpoints
    .filter((candidate) => rawPrefixMatchesLedger(candidate.rawPrefix, ledger, candidate.boundary.date))
    .map((candidate) => ({
    boundary: candidate.boundary,
    rawPrefix: candidate.rawPrefix,
    storedObjectReference: candidate.object,
  }))
  const final = ledger.rows.at(-1)
  if (!final || !state.processedThroughUtcDate || !state.previousMatch) throw new Error('Cannot persist incremental state without a terminal rated match')
  const byBoundary = new Map<string, IncrementalStateBuild['checkpoints'][number]>(
    previous.map((checkpoint) => [`${checkpoint.boundary.date}\u0000${checkpoint.boundary.matchId}`, checkpoint]),
  )
  if (persistTerminalCheckpoint || previous.length === 0) {
    const terminal = checkpointFromState(sourceData, ledger, state, generatedAt)
    byBoundary.set(`${terminal.boundary.date}\u0000${terminal.boundary.matchId}`, terminal)
  }
  return {
    ledger,
    compatibility: stateCompatibility(sourceData),
    sourceReceiptDigest: resolvedSourceReceiptDigest(sourceReceiptDigest, ledger),
    checkpoints: [...byBoundary.values()].sort((left, right) => left.boundary.date.localeCompare(right.boundary.date) || left.boundary.matchId.localeCompare(right.boundary.matchId)),
  }
}

function resolvedSourceReceiptDigest(provided: string | undefined, ledger: CanonicalMatchLedger) {
  const digest = provided ?? sha256(stableJson({
    schedule: ledger.scheduleReceiptIdentity,
    context: ledger.contextReceiptIdentity,
    provenance: ledger.provenanceReceiptIdentity,
  }))
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('sourceReceiptDigest must be a SHA-256 digest')
  return digest
}

function checkpointFromState(sourceData: RankingSourceImport, ledger: CanonicalMatchLedger, state: ReturnType<typeof replayRatingDates>, generatedAt: string) {
  if (!state.processedThroughUtcDate || !state.previousMatch) throw new Error('Cannot encode an incomplete rating boundary')
  const date = state.processedThroughUtcDate
  const prefix = rawPrefix(ledger, date)
  const prefixMatches = sourceData.matches.filter((match) => match.date <= date)
  const eventContract = buildRatingCheckpointEventContract(prefixMatches, state.eventWeightContext, tournamentLifecyclesFor(sourceData, generatedAt))
  const encoded = encodeRatingCheckpoint(state, {
    importerVersion: RANKING_INCREMENTAL_IMPORTER_VERSION,
    identityTaxonomyHash: stableDigest(sourceData.teams),
    rawLedgerPrefixHash: prefix.digest,
  }, { processedThroughUtcDate: date, processedThroughMatchId: state.previousMatch.id }, eventContract)
  return {
    boundary: { date, matchId: state.previousMatch.id }, rawPrefix: prefix,
    ratingCheckpoint: requiredRecord(JSON.parse(encoded), 'encoded rating checkpoint'),
    causalSummaries: causalSummariesForBundle(buildExternalCausalBundle({
      prefixMatches,
      processedThroughUtcDate: date,
      eventWeightContext: state.eventWeightContext,
      tournamentLifecycles: tournamentLifecyclesFor(sourceData, generatedAt, date),
      surfaces: externalCausalSurfacesFor(sourceData, date),
    })),
  }
}

function tournamentLifecyclesFor(sourceData: RankingSourceImport, generatedAt: string, throughDate?: string) {
  const matches = throughDate ? sourceData.matches.filter((match) => match.date <= throughDate) : sourceData.matches
  const matchIds = new Set(matches.flatMap((match) => [match.officialMatchId, match.sourceMatchId].filter(isString)))
  const scheduleReferences = throughDate
    ? sourceData.tournamentScheduleReferences.filter((reference) => {
        const date = scheduleReferenceDate(reference)
        return date ? date <= throughDate : Boolean(reference.matchId && matchIds.has(reference.matchId))
      })
    : sourceData.tournamentScheduleReferences
  return new Map(deriveTournamentInstances({
    matches,
    scheduleReferences,
    generatedAt,
  }).map((instance) => [instance.id, {
    status: instance.status,
    boundaryDate: instance.boundaryDate,
    ratedThroughDate: instance.ratedThroughDate,
    dataLag: instance.dataLag,
    resultCoverageComplete: instance.resultCoverageComplete,
  }] as const))
}

function parseCausalSummaries(value: unknown): NonNullable<IncrementalStateBuild['checkpoints'][number]['causalSummaries']> {
  const record = requiredRecord(value, 'causal summaries')
  return {
    sourcedPlayer: requiredRecord(record.sourcedPlayer, 'sourcedPlayer'),
    dssTeam: requiredRecord(record.dssTeam, 'dssTeam'),
    dssRegion: requiredRecord(record.dssRegion, 'dssRegion'),
    rosterEra: requiredRecord(record.rosterEra, 'rosterEra'),
    playerResume: requiredRecord(record.playerResume, 'playerResume'),
  }
}

function causalSummariesForBundle(bundle: ExternalCausalBundle): NonNullable<IncrementalStateBuild['checkpoints'][number]['causalSummaries']> {
  return {
    sourcedPlayer: { summary: bundle.surfaces['sourced-player'], eventContract: bundle.eventContract, bundleDigest: bundle.digest },
    dssTeam: { summary: bundle.surfaces['dss-team'] },
    dssRegion: { summary: bundle.surfaces['dss-region'] },
    rosterEra: { summary: bundle.surfaces['roster-era'] },
    playerResume: { summary: bundle.surfaces['player-resume-ledger'] },
  }
}

function externalBundleFromSummaries(value: unknown, throughDate: string): ExternalCausalBundle {
  const summaries = parseCausalSummaries(value)
  const sourced = requiredRecord(summaries.sourcedPlayer, 'sourcedPlayer external causal wrapper')
  const surfaces = {
    'sourced-player': requiredRecord(sourced.summary, 'sourced-player causal summary'),
    'dss-team': requiredRecord(summaries.dssTeam.summary, 'dss-team causal summary'),
    'dss-region': requiredRecord(summaries.dssRegion.summary, 'dss-region causal summary'),
    'roster-era': requiredRecord(summaries.rosterEra.summary, 'roster-era causal summary'),
    'player-resume-ledger': requiredRecord(summaries.playerResume.summary, 'player-resume causal summary'),
  } as ExternalCausalBundle['surfaces']
  if (typeof sourced.bundleDigest !== 'string') throw new Error('External causal bundle digest is missing')
  return {
    schemaVersion: 1,
    processedThroughUtcDate: throughDate,
    eventContract: requiredRecord(sourced.eventContract, 'external causal event contract') as ExternalCausalBundle['eventContract'],
    surfaces,
    digest: sourced.bundleDigest,
  }
}

function externalCausalSurfacesFor(sourceData: RankingSourceImport, throughDate: string): ExternalCausalSurfaceInput[] {
  const matches = sourceData.matches.filter((match) => match.date <= throughDate)
  const touchedTeams = new Set(matches.flatMap((match) => [match.teamA, match.teamB]))
  const teams = Object.fromEntries(Object.entries(sourceData.teams).filter(([name]) => touchedTeams.has(name)))
  const contexts = new Map<CausalSurfaceId, ReturnType<typeof buildCausalContextIdentity>>()
  for (const surface of REQUIRED_EXTERNAL_CAUSAL_SURFACES) {
    contexts.set(surface, buildCausalContextIdentity({
      semanticId: `${surface}-production-v1`,
      serializableInputs: { modelVersion: transparentGprModelMetadata.version, modelConfigHash: transparentGprModelMetadata.configHash, teams },
    }))
  }
  const rows: Record<CausalSurfaceId, CausalInputRow[]> = {
    'sourced-player': matches.map((match) => causalInputRow(`match:${canonicalMatchLedgerKey(match)}`, match.date, {
      teamA: match.teamA, teamB: match.teamB, teamARoster: match.teamARoster, teamBRoster: match.teamBRoster,
      tier: match.tier,
    })),
    'dss-team': matches.map((match) => causalInputRow(`series:${match.sourceProvider ?? 'unknown'}:${match.sourceMatchId ?? match.id}:${match.id}`, match.date, {
      teamA: match.teamA, teamB: match.teamB, winner: match.winner, event: match.event, tier: match.tier,
      bestOf: match.bestOf, phase: match.phase, gameNumber: match.gameNumber,
    })),
    'dss-region': matches.map((match) => causalInputRow(`match:${canonicalMatchLedgerKey(match)}`, match.date, {
      teamA: match.teamA, teamB: match.teamB, winner: match.winner, league: match.league, region: match.region,
      teamARegion: match.teamARegion, teamBRegion: match.teamBRegion, tier: match.tier,
    })),
    'roster-era': matches.map((match) => causalInputRow(`match:${canonicalMatchLedgerKey(match)}`, match.date, {
      teamA: match.teamA, teamB: match.teamB, teamARoster: match.teamARoster, teamBRoster: match.teamBRoster,
    })),
    'player-resume-ledger': matches.map((match) => causalInputRow(`series:${match.sourceProvider ?? 'unknown'}:${match.sourceMatchId ?? match.id}:${match.id}`, match.date, {
      teamA: match.teamA, teamB: match.teamB, winner: match.winner, teamARoster: match.teamARoster, teamBRoster: match.teamBRoster,
      event: match.event, tier: match.tier, bestOf: match.bestOf,
    })),
  }
  return REQUIRED_EXTERNAL_CAUSAL_SURFACES.map((surface) => {
    const contextIdentity = contexts.get(surface)
    if (!contextIdentity) throw new Error(`External causal context is incomplete for ${surface}`)
    return { surface, inputs: rows[surface], contextIdentity }
  })
}

function rawPrefix(ledger: CanonicalMatchLedger, throughDate: string) {
  const rows = ledger.rows.filter((row) => row.utcDate <= throughDate)
  return { matchCount: rows.length, digest: sha256(stableJson(rows.map((row) => ({ key: row.key, scoringDigest: row.scoringDigest, utcDate: row.utcDate })))) }
}

function rawPrefixMatchesLedger(prefix: { matchCount: number; digest: string }, ledger: CanonicalMatchLedger, throughDate: string) {
  const current = rawPrefix(ledger, throughDate)
  return current.matchCount === prefix.matchCount && current.digest === prefix.digest
}

function semanticMapFromWrites(writes: SnapshotBuild['publicPlan']['writes'], includeProvenance = false): SemanticArtifactMap {
  return Object.fromEntries(writes.map((write) => {
    const prepared = prepareSemanticArtifact(write.value)
    return [`/data/${write.relativePath}`, {
      digest: prepared.digest,
      ...(includeProvenance ? { provenanceDigest: stableDigest(provenanceFor(write.value)) } : {}),
    }]
  }))
}

function semanticMapFromGeneration(manifest: Record<string, unknown>): SemanticArtifactMap {
  const artifacts = requiredRecord(manifest.artifacts, 'public generation artifacts')
  return Object.fromEntries(Object.entries(artifacts).map(([path, value]) => {
    const identity = requiredRecord(value, `public generation artifact ${path}`)
    if (typeof identity.sha256 !== 'string') throw new Error(`Public generation artifact ${path} has no digest`)
    return [path, { digest: identity.sha256 }]
  }))
}

function provenanceFor(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { artifactMeta: (value as Record<string, unknown>).artifactMeta, generatedAt: (value as Record<string, unknown>).generatedAt }
    : {}
}

function changesForClassification(previous: CanonicalMatchLedger, current: CanonicalMatchLedger, classification: RankingChangeClassification): PublicArtifactChange[] {
  const before = new Map(previous.rows.map((row) => [row.key, row.match]))
  const after = new Map(current.rows.map((row) => [row.key, row.match]))
  if (classification.kind === 'metadata-only') return [{ metadataOnly: true }]
  const changes = [...new Set([...classification.addedKeys, ...classification.removedKeys, ...classification.changedKeys])].map((key) => ({
    before: before.get(key), after: after.get(key), kind: classification.kind, rollingBaselineChanged: true,
  }))
  return changes.length > 0 || !classification.reasons.some((reason) => reason.startsWith('schedule-context'))
    ? changes
    : [{ rollingBaselineChanged: true, kind: classification.kind }]
}

function scopedDependencyPlan(
  changes: ReturnType<typeof changesForClassification>,
  classification: RankingChangeClassification,
  rootArtifact: Record<string, unknown>,
  publicManifest: Record<string, unknown>,
  artifacts?: Record<string, unknown>,
) {
  const inventory = dependencyInventory(rootArtifact, publicManifest, changes, artifacts)
  const plan = affectedPublicArtifacts({ changes, inventory })
  if (classification.kind === 'latest-append') {
    for (const scope of inventory.scopes) {
      const lastPage = scope.matchPages.at(-1)?.path
      if (!lastPage || !plan.logicalPaths.includes(lastPage)) continue
      const nextPage = nextMatchPagePath(lastPage)
      if (nextPage) plan.logicalPaths.push(nextPage)
    }
    plan.logicalPaths = [...new Set(plan.logicalPaths)].sort()
  }
  if (classification.reasons.some((reason) => reason.startsWith('schedule-context'))) {
    const additions = [inventory.manifestPath, inventory.regionHistoryPath, inventory.tournamentMovementIndexPath,
      ...inventory.scopes.map((scope) => scope.rankingPath), ...Object.values(inventory.tournamentMovementPaths)]
    plan.logicalPaths = [...new Set([...plan.logicalPaths, ...additions])].sort()
  }
  return plan
}

function nextMatchPagePath(path: string) {
  const match = /^(.*-)(\d+)(\.json)$/.exec(path)
  return match ? `${match[1]}${Number(match[2]) + 1}${match[3]}` : undefined
}

function dependencyInventory(
  rootArtifact: Record<string, unknown>,
  publicManifest: Record<string, unknown>,
  changes: ReturnType<typeof changesForClassification> = [],
  artifacts?: Record<string, unknown>,
) {
  const artifactPaths = Object.keys(requiredRecord(publicManifest.artifacts, 'public generation artifacts'))
  const snapshotIndex = requiredRecord(rootArtifact.snapshotIndex, 'ranking root snapshot index')
  const matchHistoryIndex = optionalRecord(artifacts?.[`/data/${PUBLIC_ARTIFACT_PATHS.matchHistoryIndex}`])
  const matchScopeIndex = optionalRecord(matchHistoryIndex?.scopeIndex)
  const scopes = Object.entries(snapshotIndex).flatMap(([key, value]) => {
    const entry = requiredRecord(value, `snapshot index ${key}`)
    const filter = requiredRecord(entry.filter, `snapshot index ${key} filter`)
    if (typeof filter.season !== 'string' || typeof filter.event !== 'string' || typeof filter.region !== 'string') return []
    const pagePrefix = `/data/${publicMatchHistoryPagePath(key, 1).replace(/-1\.json$/, '-')}`
    const checkpoint = typeof filter.checkpoint === 'string'
      ? checkpointBounds(rootArtifact, filter.season, filter.checkpoint)
      : undefined
    const scopeMatchInventory = optionalRecord(matchScopeIndex?.[key])
    const indexedPages = Array.isArray(scopeMatchInventory?.pages) ? scopeMatchInventory.pages : []
    return [{
      key,
      filter: {
        season: filter.season,
        event: filter.event,
        region: filter.region as Parameters<typeof snapshotKey>[0]['region'],
        ...(typeof filter.checkpoint === 'string' ? { checkpoint: filter.checkpoint } : {}),
      },
      rankingPath: logicalUrlPath(entry.url) ?? `/data/${publicScopeArtifactPath(key)}`,
      matchCatalogPath: `/data/${publicMatchHistoryShardPath(key)}`,
      ...(checkpoint ? { checkpointStartUtcDate: checkpoint.startDate, checkpointEndUtcDate: checkpoint.endDate } : {}),
      matchPages: indexedPages.length > 0
        ? indexedPages.flatMap((page) => {
            const entry = optionalRecord(page)
            const path = logicalUrlPath(entry?.url)
            if (!path || !Array.isArray(entry?.seriesIds)) return []
            return [{
              path,
              seriesIds: entry.seriesIds.filter(isString),
              ...(typeof entry.startUtcDate === 'string' ? { startUtcDate: entry.startUtcDate } : {}),
              ...(typeof entry.endUtcDate === 'string' ? { endUtcDate: entry.endUtcDate } : {}),
            }]
          }).sort((left, right) => matchPageNumber(left.path) - matchPageNumber(right.path) || left.path.localeCompare(right.path))
        : artifactPaths
          .filter((path) => path.startsWith(pagePrefix))
          .sort((left, right) => matchPageNumber(left) - matchPageNumber(right) || left.localeCompare(right))
          .map((path) => ({ path, seriesIds: [] })),
    }]
  })
  const historyPaths = scopes
    .filter((scope) => changes.length === 0 || changes.some((change) => [change.before, change.after]
      .filter((match): match is RankingSourceImport['matches'][number] => Boolean(match))
      .some((match) => changeTouchesSnapshotScope(match, scope, change.kind))))
    .map((scope) => `/data/${publicTeamHistoryShardPath(scope.key)}`)
  const changedTeams = new Set(changes.flatMap((change) => [change.before?.teamA, change.before?.teamB, change.after?.teamA, change.after?.teamB].filter(isString)))
  const tournamentMovementPaths = Object.fromEntries(artifactPaths
    .filter((path) => path.startsWith('/data/history/tournament-moves/') && !path.endsWith('/index.json'))
    .map((path) => [decodeURIComponent(path.split('/').at(-1)!.replace(/\.json$/, '')), path]))
  return {
    manifestPath: '/data/ranking-summary.json', playerDirectoryPath: '/data/entities/players.json',
    teamDirectoryPath: '/data/entities/teams.json', regionHistoryPath: '/data/history/region-series.json',
    teamHistoryIndexPath: '/data/history/team-series/index.json', tournamentMovementIndexPath: '/data/history/tournament-moves/index.json',
    matchHistoryIndexPath: '/data/matches/index.json', scopes,
    teamHistoryPaths: Object.fromEntries([...changedTeams].map((team) => [team, historyPaths])),
    tournamentMovementPaths,
  }
}

function changeTouchesSnapshotScope(
  match: RankingSourceImport['matches'][number],
  scope: ArtifactScopeDependency,
  kind?: RankingChangeClassification['kind'],
) {
  const filter = scope.filter
  const scopeSeason = filter.season === 'All' ? undefined : Number(filter.season)
  if (kind === 'historical-correction' && scopeSeason !== undefined && Number.isFinite(scopeSeason)) {
    if (scopeSeason > match.season) return true
    if (scopeSeason === match.season && filter.checkpoint && scope.checkpointEndUtcDate && match.date <= scope.checkpointEndUtcDate) return true
  }
  if (filter.season !== 'All' && Number(filter.season) !== match.season) return false
  if (filter.event !== 'All' && filter.event !== match.event) return false
  if (filter.region !== 'All'
    && filter.region !== match.region
    && filter.region !== match.teamARegion
    && filter.region !== match.teamBRegion) return false
  if (filter.checkpoint) {
    return Boolean(scope.checkpointStartUtcDate && scope.checkpointEndUtcDate
      && match.date >= scope.checkpointStartUtcDate && match.date <= scope.checkpointEndUtcDate)
  }
  return filter.region === 'All'
    || filter.region === match.region
    || filter.region === match.teamARegion
    || filter.region === match.teamBRegion
}

function checkpointBounds(rootArtifact: Record<string, unknown>, season: unknown, checkpointId: string) {
  if (typeof season !== 'string') return undefined
  const filterOptions = optionalRecord(rootArtifact.filterOptions)
  const checkpoints = optionalRecord(filterOptions?.checkpoints)
  const entries = checkpoints?.[season]
  if (!Array.isArray(entries)) return undefined
  for (const value of entries) {
    const entry = optionalRecord(value)
    if (entry?.id === checkpointId && typeof entry.startDate === 'string' && typeof entry.endDate === 'string') {
      return { startDate: entry.startDate, endDate: entry.endDate }
    }
  }
  return undefined
}

function matchPageNumber(path: string) {
  const value = /-(\d+)\.json$/.exec(path)?.[1]
  return value ? Number(value) : Number.MAX_SAFE_INTEGER
}

function snapshotKeysForPlan(
  rootArtifact: Record<string, unknown>,
  logicalPaths: readonly string[],
  changes: ReturnType<typeof changesForClassification>,
) {
  const selected = new Set<string>()
  const paths = new Set(logicalPaths)
  const index = requiredRecord(rootArtifact.snapshotIndex, 'ranking root snapshot index')
  for (const [key, value] of Object.entries(index)) {
    const entry = requiredRecord(value, `snapshot index ${key}`)
    const candidates = [logicalUrlPath(entry.url), `/data/${publicTeamHistoryShardPath(key)}`, `/data/${publicMatchHistoryShardPath(key)}`]
    if (candidates.some((path) => path && paths.has(path))) selected.add(key)
  }
  selected.add(snapshotKey({ season: 'All', event: 'All', region: 'All' }))
  for (const change of changes) {
    for (const match of [change.before, change.after]) {
      if (match) selected.add(snapshotKey({ season: String(match.season), event: 'All', region: 'All' }))
    }
  }
  return selected
}

function tournamentIdsForPlan(
  logicalPaths: readonly string[],
  changes: ReturnType<typeof changesForClassification>,
) {
  const selected = new Set<TournamentInstanceId>()
  const prefix = `/data/${PUBLIC_ARTIFACT_PATHS.tournamentMovementShardDir}/`
  for (const path of logicalPaths) {
    if (!path.startsWith(prefix) || path.endsWith('/index.json')) continue
    selected.add(decodeURIComponent(path.slice(prefix.length).replace(/\.json$/, '')) as TournamentInstanceId)
  }
  for (const change of changes) {
    for (const match of [change.before, change.after]) {
      const id = match ? tournamentInstanceForEvent(match.event, match.season)?.id : undefined
      if (id) selected.add(id)
    }
  }
  return selected
}

function logicalUrlPath(value: unknown) {
  if (typeof value !== 'string') return undefined
  const url = new URL(value, 'https://ranking.invalid')
  return url.pathname.startsWith('/data/') ? url.pathname : undefined
}

function stripDataPrefix(value: string) {
  if (!value.startsWith('/data/')) throw new Error(`Dependency path is not public data: ${value}`)
  return value.slice('/data/'.length)
}

function scheduleCausalRowsFor(sourceData: RankingSourceImport) {
  return sourceData.tournamentScheduleReferences.map((reference, index) => {
    const utcDate = scheduleReferenceDate(reference)
    const key = reference.matchId
      ? `match:${reference.matchId}`
      : `schedule:${reference.tournamentId ?? reference.leagueSlug ?? reference.leagueName ?? 'unknown'}:${reference.startTime ?? reference.date ?? index}`
    return {
      key,
      ...(utcDate ? { utcDate } : {}),
      digest: stableDigest({
        matchId: reference.matchId, tournamentId: reference.tournamentId, leagueName: reference.leagueName,
        leagueSlug: reference.leagueSlug, startTime: reference.startTime, date: reference.date, state: reference.state,
        coverageStart: reference.coverageStart, coverageEnd: reference.coverageEnd, coverageEndComplete: reference.coverageEndComplete,
      }),
    }
  })
}

function scheduleReferenceDate(reference: RankingSourceImport['tournamentScheduleReferences'][number]) {
  const candidate = reference.date ?? reference.startTime?.slice(0, 10)
  return candidate && /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : undefined
}

function providerReceiptForMatch(sourceData: RankingSourceImport, match: RankingSourceImport['matches'][number]) {
  const expectedKind = match.sourceProvider === 'oracles-elixir'
    ? 'game-stats'
    : match.sourceProvider === 'leaguepedia-cargo'
      ? 'match-data'
      : undefined
  const observations = sourceData.externalSources
    .filter((source) => source.status === 'active' && (!expectedKind || source.kind === expectedKind))
    .filter((source) => (!source.coverageStart || source.coverageStart <= match.date) && (!source.coverageEnd || source.coverageEnd >= match.date))
    .map((source) => source.retrievedAt)
    .filter(isString)
    .sort()
  return observations.at(-1) ?? sourceData.manifest?.generatedAt
}

function providerAvailabilityForClassification(ledger: CanonicalMatchLedger, classification: RankingChangeClassification) {
  const affected = new Set([...classification.addedKeys, ...classification.changedKeys])
  return ledger.rows.filter((row) => affected.has(row.key)).map((row) => row.providerAvailableAt).filter(isString).sort()[0]
}

function metricsFor(classification: RankingChangeClassification, ledger: CanonicalMatchLedger, replay: Awaited<ReturnType<typeof selectReplay>>, replayedMatchCount: number, semantic: SemanticArtifactMap, changedPaths: string[], reusedPaths: string[], removedPaths: string[], fullSnapshotWritten: boolean, parity: boolean | null, stateParity: boolean | null, materializedScopeCount: number): IncrementalBuildMetrics {
  const base = baseMetrics(classification.kind, ledger, { fullSnapshotWritten })
  const suffixRows = replay.replayFromUtcDate ? ledger.rows.filter((row) => row.utcDate >= replay.replayFromUtcDate) : ledger.rows
  return {
    ...base, replayFromUtcDate: replay.replayFromUtcDate, replayedMatchCount, candidateCount: replay.candidateCount,
    addedCount: classification.addedKeys.length,
    changedCount: classification.changedKeys.length,
    removedCount: classification.removedKeys.length,
    rejectedCandidates: replay.rejectedCandidates, selectedBoundary: replay.selectedBoundary,
    suffixRows: suffixRows.length, suffixDates: new Set(suffixRows.map((row) => row.utcDate)).size,
    changedPaths, reusedPaths, removedPaths,
    semanticBytes: Object.keys(semantic).length, compressedBytes: 0, parity, stateParity, materializedScopeCount,
    ...(providerAvailabilityForClassification(ledger, classification) ? { providerAvailableAt: providerAvailabilityForClassification(ledger, classification) } : {}),
  }
}

function baseMetrics(classification: RankingChangeClassification['kind'], ledger: CanonicalMatchLedger, overrides: Partial<IncrementalBuildMetrics> = {}): IncrementalBuildMetrics {
  return {
    classification, addedCount: 0, changedCount: 0, removedCount: 0,
    replayedMatchCount: 0, candidateCount: 0, rejectedCandidates: [], canonicalRows: ledger.rows.length,
    canonicalBytes: Buffer.byteLength(stableJson(ledger)), suffixRows: 0, suffixDates: 0, changedPaths: [], reusedPaths: [], removedPaths: [],
    semanticBytes: 0, compressedBytes: 0, fullSnapshotWritten: false, parity: null, stateParity: null, materializedScopeCount: 0, ...overrides,
  }
}

function withArtifactBytes(metrics: IncrementalBuildMetrics, writes: SnapshotBuild['publicPlan']['writes']) {
  const prepared = writes.map((write) => prepareSemanticArtifact(write.value))
  return {
    ...metrics,
    semanticBytes: prepared.reduce((sum, artifact) => sum + artifact.bytes, 0),
    compressedBytes: prepared.reduce((sum, artifact) => sum + artifact.compressedBytes, 0),
  }
}

function withPlayerLifecycle(metrics: IncrementalBuildMetrics, build: SnapshotBuild): IncrementalBuildMetrics {
  return {
    ...metrics,
    playerLifecycleStages: build.playerLifecycleStages,
  }
}

function withMemoryCollections(
  metrics: IncrementalBuildMetrics,
  memoryCollections: NonNullable<IncrementalBuildMetrics['memoryCollections']>,
): IncrementalBuildMetrics {
  return { ...metrics, memoryCollections }
}

async function stateFromRestoredAudit(restored: RestoredIncrementalAuthority, ledger: CanonicalMatchLedger): Promise<IncrementalStateBuild> {
  const loaded = restored.loadCheckpoints
    ? await restored.loadCheckpoints(restored.stateManifest.checkpoints)
    : restored.checkpoints
  const byBoundary = new Map(loaded.map((entry) => [`${entry.candidate.boundary.date}\u0000${entry.candidate.boundary.matchId}`, entry]))
  return {
    ledger,
    compatibility: restored.stateManifest.compatibility,
    sourceReceiptDigest: restored.stateManifest.sourceReceiptDigest,
    checkpoints: restored.stateManifest.checkpoints.map((candidate) => {
      const entry = byBoundary.get(`${candidate.boundary.date}\u0000${candidate.boundary.matchId}`)
      if (!entry) throw new Error(`daily-audit-checkpoint-missing:${candidate.boundary.date}/${candidate.boundary.matchId}`)
      return {
        boundary: candidate.boundary,
        rawPrefix: candidate.rawPrefix,
        ratingCheckpoint: requiredRecord(entry.bundle.ratingCheckpoint, 'daily audit rating checkpoint'),
        causalSummaries: parseCausalSummaries(entry.bundle.causalSummaries),
      }
    }),
  }
}

function compareIncrementalState(expected: IncrementalStateBuild, actual: IncrementalStateBuild) {
  const expectedProjection = comparableIncrementalState(expected)
  const actualProjection = comparableIncrementalState(actual)
  const expectedJson = stableJson(expectedProjection)
  const actualJson = stableJson(actualProjection)
  return {
    equal: expectedJson === actualJson,
    sourceReceiptEqual: expected.sourceReceiptDigest === actual.sourceReceiptDigest,
    expectedSourceReceiptDigest: expected.sourceReceiptDigest,
    actualSourceReceiptDigest: actual.sourceReceiptDigest,
    checkpointEqual: expected.checkpoints.length === actual.checkpoints.length
      && expected.checkpoints.every((checkpoint, index) => stableJson(checkpoint) === stableJson(actual.checkpoints[index])),
    expectedDigest: sha256(expectedJson),
    actualDigest: sha256(actualJson),
    expectedCheckpointDigests: expected.checkpoints.map((checkpoint) => sha256(stableJson(checkpoint))),
    actualCheckpointDigests: actual.checkpoints.map((checkpoint) => sha256(stableJson(checkpoint))),
    mismatchPaths: firstMismatchPaths(expectedProjection, actualProjection),
  }
}

function comparableIncrementalState(state: IncrementalStateBuild) {
  return {
    ledger: state.ledger,
    compatibility: state.compatibility,
    checkpoints: state.checkpoints,
  }
}

function firstMismatchPaths(expected: unknown, actual: unknown, path = '$', found: string[] = []): string[] {
  if (found.length >= 20 || stableJson(expected) === stableJson(actual)) return found
  if (!expected || !actual || typeof expected !== 'object' || typeof actual !== 'object') {
    found.push(path)
    return found
  }
  const expectedRecord = expected as Record<string, unknown>
  const actualRecord = actual as Record<string, unknown>
  for (const key of [...new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)])].sort()) {
    firstMismatchPaths(expectedRecord[key], actualRecord[key], `${path}.${key}`, found)
    if (found.length >= 20) break
  }
  return found
}

async function persistDiagnostic(path: string | undefined, diagnostic: IncrementalDiagnostic) {
  if (path) {
    await mkdir(dirname(resolve(path)), { recursive: true })
    await writeFile(resolve(path), `${JSON.stringify(diagnostic, null, 2)}\n`)
  }
  return diagnostic
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }

function utcDateAfter(date: string) {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  parsed.setUTCDate(parsed.getUTCDate() + 1)
  return parsed.toISOString().slice(0, 10)
}

function isString(value: string | undefined): value is string {
  return value !== undefined
}
