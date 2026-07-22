import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { buildCausalContextIdentity, causalInputRow, CAUSAL_PREFIX_SCHEMA_VERSION, type CausalInputRow, type CausalSurfaceId } from '../src/lib/causalRecompute'
import { affectedPublicArtifacts, assertArtifactDependencyPlanMatchesSemanticChanges, type PublicArtifactChange } from '../src/lib/incremental/artifactDependencies'
import { buildCanonicalMatchLedger, canonicalMatchLedgerKey, classifyRankingChange, parseCanonicalMatchLedger } from '../src/lib/incremental/changeClassifier'
import { buildExternalCausalBundle, reconcileExternalCausalBundle, REQUIRED_EXTERNAL_CAUSAL_SURFACES, type ExternalCausalBundle, type ExternalCausalSurfaceInput } from '../src/lib/incremental/externalCausalState'
import { replayRankingState } from '../src/lib/incremental/replayOrchestrator'
import { compareSemanticArtifactMaps, type SemanticArtifactMap } from '../src/lib/incremental/semanticParity'
import { stableDigest, stableJson, type CanonicalMatchLedger, type RankingChangeClassification } from '../src/lib/incremental/types'
import { createRatingReplayContext, replayRatingDates, transparentGprModelMetadata } from '../src/lib/model'
import { RATING_CHECKPOINT_SCHEMA_VERSION, encodeRatingCheckpoint, selectSafeCheckpoint } from '../src/lib/ratingCheckpoint'
import { buildRatingCheckpointEventContract, reconcileRatingCheckpointEvents } from '../src/lib/ratingCheckpointInventory'
import { PUBLIC_ARTIFACT_SCHEMA_VERSION, artifactMetaFor, snapshotKey } from '../src/lib/publicArtifacts/schema'
import { PUBLIC_ARTIFACT_PATHS, publicMatchHistoryPagePath, publicMatchHistoryShardPath, publicScopeArtifactPath, publicTeamHistoryShardPath } from '../src/lib/publicArtifacts/writePlan'
import { deriveTournamentInstances, tournamentInstanceForEvent, type TournamentInstanceId } from '../src/lib/internationalTournaments'
import { prepareSemanticArtifact } from './public-artifact-storage.mjs'
import { buildStaticSnapshot } from './build-static-snapshot.ts'
import { importRankingSourceData, type RankingSourceImport } from './ranking-source-import.ts'
import {
  prepareContentAddressedState,
  prepareStateObject,
  stateObjectReferenceFor,
  syncContentAddressedStateObject,
  writeIncrementalStateManifest,
  type IncrementalStateManifest,
  type StateCompatibility,
} from './incremental-state-storage.mjs'
import type { BucketClient, BucketStorageConfig } from './railway-bucket.mjs'

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
}

export type IncrementalBuildMetrics = {
  classification: RankingChangeClassification['kind']
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
  materializedScopeCount: number
  providerAvailableAt?: string
}

export type IncrementalStateBuild = {
  ledger: CanonicalMatchLedger
  compatibility: StateCompatibility
  sourceReceiptDigest: string
  checkpoints: Array<{
    boundary: { date: string; matchId: string }
    rawPrefix: { matchCount: number; digest: string }
    ratingCheckpoint: Record<string, unknown>
    causalSummaries: {
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
  const manifest = await writeIncrementalStateManifest(client, config, prepared)
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
}): Promise<IncrementalRankingBuildResult> {
  const sourceData = providedSourceData ?? await importRankingSourceData({ manifestPath })
  let observationLedger: CanonicalMatchLedger | undefined
  if (restored) {
    try { observationLedger = parseCanonicalMatchLedger(restored.canonicalLedger) } catch { /* fail closed in the guarded path below */ }
  }
  const context = ledgerContext(sourceData, observationLedger)
  const ledger = buildCanonicalMatchLedger(sourceData.matches, context)
  const forceFull = !enabled || mode === 'legacy' || cause === 'daily-audit' || cause === 'manual-force'
  if (forceFull) {
    const full = await buildSnapshot({ output, publicDataDir, reconciliationOutput, sourceData, generatedAt, env, silent })
    const state = buildStateFromFullReplay(sourceData, ledger, generatedAt)
    return { action: 'publish-full', sourceData, build: full, state, metrics: baseMetrics('full-invalidation', ledger, { fullSnapshotWritten: true }) }
  }

  let classification: RankingChangeClassification | undefined
  let candidateDir: string | undefined
  try {
    if (!restored) throw new Error('incremental-state-missing')
    const previousLedger = parseCanonicalMatchLedger(restored.canonicalLedger)
    classification = classifyRankingChange(previousLedger, ledger, ledger.compatibility)
    if (classification.kind === 'no-change') {
      return { action: 'no-change', sourceData, metrics: baseMetrics('no-change', ledger) }
    }
    if (classification.kind === 'full-invalidation') throw new Error(classification.reasons.join(',') || 'full-invalidation')
    if (classification.kind === 'metadata-only') {
      if (!restored.rootArtifact) throw new Error('metadata-only-root-artifact-missing')
      const rootManifest = metadataOnlyRootArtifact(restored.rootArtifact, sourceData, generatedAt)
      const rootPrepared = prepareSemanticArtifact(rootManifest)
      const state = buildMetadataOnlyState(sourceData, ledger, restored.checkpoints)
      const expectedLogicalPaths = Object.keys(requiredRecord(restored.publicManifest.artifacts, 'public generation artifacts')).sort()
      const changedPath = '/data/ranking-summary.json'
      return {
        action: 'publish-incremental', sourceData, rootManifest, state,
        patch: {
          previousManifest: restored.publicManifest,
          changedArtifacts: [{ logicalPath: changedPath, value: rootManifest }],
          removedLogicalPaths: [], expectedLogicalPaths,
        },
        metrics: {
          ...baseMetrics('metadata-only', ledger), changedPaths: [changedPath],
          reusedPaths: expectedLogicalPaths.filter((path) => path !== changedPath),
          semanticBytes: rootPrepared.bytes,
          compressedBytes: rootPrepared.compressedBytes,
        },
      }
    }

    if (!restored.rootArtifact) throw new Error('verified-active-root-artifact-missing')
    if (!restored.artifacts) throw new Error('verified-active-artifacts-missing')
    const changes = changesForClassification(previousLedger, ledger, classification)
    const preliminaryPlan = scopedDependencyPlan(changes, classification, restored.rootArtifact, restored.publicManifest)
    const affectedLogicalPaths = new Set(preliminaryPlan.logicalPaths.map(stripDataPrefix))
    const affectedSnapshotKeys = snapshotKeysForPlan(restored.rootArtifact, preliminaryPlan.logicalPaths, changes)
    const affectedTournamentIds = tournamentIdsForPlan(preliminaryPlan.logicalPaths, changes)
    const replay = selectReplay(restored.checkpoints, sourceData, classification, generatedAt)
    const replayResult = replayRankingState({
      authoritativeMatches: sourceData.matches,
      teams: sourceData.teams,
      tournamentLifecycles: tournamentLifecyclesFor(sourceData, generatedAt),
      ...(replay.checkpointState ? { checkpointState: replay.checkpointState } : {}),
      ...(replay.replayFromUtcDate ? { replayFromUtcDate: replay.replayFromUtcDate } : {}),
    })
    candidateDir = `${publicDataDir}.incremental-${process.pid}-${Date.now()}`
    const candidate = await buildSnapshot({
      output,
      publicDataDir: candidateDir,
      reconciliationOutput,
      sourceData,
      generatedAt,
      precomputedGlobalRanking: replayResult.model,
      affectedLogicalPaths,
      affectedSnapshotKeys,
      affectedTournamentIds,
      previousArtifacts: restored.artifacts,
      writeFullSnapshot: false,
      replacePublicDirectory: false,
      env,
      silent,
    })
    const previousSemantic = semanticMapFromGeneration(restored.publicManifest)
    const candidateSemantic = semanticMapFromWrites(candidate.publicPlan.writes)
    const currentSemantic = { ...previousSemantic, ...candidateSemantic }
    const dependencyPlan = affectedPublicArtifacts({
      changes,
      inventory: dependencyInventory(restored.rootArtifact, restored.publicManifest),
      previousSemanticArtifacts: previousSemantic,
      currentSemanticArtifacts: currentSemantic,
    })
    assertArtifactDependencyPlanMatchesSemanticChanges(dependencyPlan, previousSemantic, currentSemantic)
    const changed = new Set(dependencyPlan.logicalPaths)
    const currentPaths = Object.keys(currentSemantic).sort()
    const removedPaths: string[] = []
    const changedWrites = candidate.publicPlan.writes.filter((write) => changed.has(`/data/${write.relativePath}`))
    const root = candidate.publicPlan.writes.find((write) => write.relativePath === 'ranking-summary.json')
    if (root && !changedWrites.includes(root)) changedWrites.push(root)
    const state = buildTerminalState(
      sourceData,
      ledger,
      replayResult.state,
      restored.checkpoints,
      generatedAt,
      mode === 'shadow' || replayResult.replayedMatchCount >= 100,
    )
    let parity: boolean | null = null

    if (mode === 'shadow') {
      const full = await buildSnapshot({ output, publicDataDir, reconciliationOutput, sourceData, generatedAt, env, silent })
      const fullState = buildStateFromFullReplay(sourceData, ledger, generatedAt)
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
          metrics: withArtifactBytes(metricsFor(classification, ledger, replay, replayResult.replayedMatchCount, currentSemantic, [], currentPaths, removedPaths, true, false, stateParity, affectedSnapshotKeys.size), candidate.publicPlan.writes),
        }
      }
      await rm(candidateDir, { recursive: true, force: true })
      return {
        action: 'publish-full', sourceData, build: full, state: fullState, metrics: withArtifactBytes(metricsFor(classification, ledger, replay, replayResult.replayedMatchCount, currentSemantic, dependencyPlan.logicalPaths, currentPaths.filter((path) => !changed.has(path)), removedPaths, true, true, true, affectedSnapshotKeys.size), candidate.publicPlan.writes),
      }
    }

    await rm(candidateDir, { recursive: true, force: true })
    return {
      action: 'publish-incremental', sourceData, build: candidate, state,
      patch: {
        previousManifest: restored.publicManifest,
        changedArtifacts: changedWrites.map((write) => ({ logicalPath: `/data/${write.relativePath}`, value: write.value })),
        removedLogicalPaths: removedPaths,
        expectedLogicalPaths: currentPaths,
      },
      metrics: withArtifactBytes(metricsFor(classification, ledger, replay, replayResult.replayedMatchCount, currentSemantic, changedWrites.map((write) => `/data/${write.relativePath}`).sort(), currentPaths.filter((path) => !changed.has(path)), removedPaths, false, parity, null, affectedSnapshotKeys.size), changedWrites),
    }
  } catch (error) {
    if (candidateDir) await rm(candidateDir, { recursive: true, force: true })
    const reason = error instanceof Error ? error.message : String(error)
    const diagnostic = await persistDiagnostic(diagnosticPath, {
      schemaVersion: 1, kind: 'incremental-fallback', reason, ...(classification ? { classification: classification.kind } : {}),
    })
    const full = await buildSnapshot({ output, publicDataDir, reconciliationOutput, sourceData, generatedAt, env, silent })
    const state = buildStateFromFullReplay(sourceData, ledger, generatedAt)
    const metrics = baseMetrics(classification?.kind ?? 'full-invalidation', ledger, { fullSnapshotWritten: true, fallbackReason: reason })
    return { action: 'publish-full', sourceData, build: full, state, diagnostic, metrics }
  }
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

function selectReplay(checkpoints: RestoredCheckpoint[], sourceData: RankingSourceImport, classification: RankingChangeClassification, generatedAt: string) {
  const changedDate = classification.earliestChangedUtcDate
  if (!changedDate) return { replayFromUtcDate: undefined, rejectedCandidates: [], candidateCount: checkpoints.length }
  const selected = selectSafeCheckpoint({
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
          availableProcessedThroughUtcDates: checkpoints.map(({ candidate }) => candidate.boundary.date),
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
          availableProcessedThroughUtcDates: checkpoints.map(({ candidate }) => candidate.boundary.date),
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
  if (selected.status !== 'selected') throw new Error(`checkpoint-${selected.reason}`)
  return {
    checkpointState: selected.checkpoint.state,
    replayFromUtcDate: utcDateAfter(selected.checkpoint.metadata.processedThroughUtcDate),
    selectedBoundary: selected.checkpoint.metadata.processedThroughUtcDate,
    rejectedCandidates: selected.rejectedCandidateIds,
    candidateCount: checkpoints.length,
  }
}

function buildStateFromFullReplay(sourceData: RankingSourceImport, ledger: CanonicalMatchLedger, generatedAt = new Date().toISOString()): IncrementalStateBuild {
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
    sourceReceiptDigest: sha256(stableJson({ schedule: ledger.scheduleReceiptIdentity, context: ledger.contextReceiptIdentity, provenance: ledger.provenanceReceiptIdentity })),
    checkpoints,
  }
}

function buildMetadataOnlyState(sourceData: RankingSourceImport, ledger: CanonicalMatchLedger, restored: RestoredCheckpoint[]): IncrementalStateBuild {
  return {
    ledger,
    compatibility: stateCompatibility(sourceData),
    sourceReceiptDigest: sha256(stableJson({ schedule: ledger.scheduleReceiptIdentity, context: ledger.contextReceiptIdentity, provenance: ledger.provenanceReceiptIdentity })),
    checkpoints: restored.map(({ candidate, bundle }) => ({
      boundary: candidate.boundary,
      rawPrefix: candidate.rawPrefix,
      ratingCheckpoint: requiredRecord(bundle.ratingCheckpoint, 'restored rating checkpoint'),
      causalSummaries: parseCausalSummaries(bundle.causalSummaries),
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
  restored: RestoredCheckpoint[],
  generatedAt: string,
  persistTerminalCheckpoint: boolean,
): IncrementalStateBuild {
  const previous = restored.map(({ candidate, bundle }) => ({
    boundary: candidate.boundary,
    rawPrefix: candidate.rawPrefix,
    ratingCheckpoint: requiredRecord(bundle.ratingCheckpoint, 'restored rating checkpoint'),
    causalSummaries: parseCausalSummaries(bundle.causalSummaries),
  }))
  const final = ledger.rows.at(-1)
  if (!final || !state.processedThroughUtcDate || !state.previousMatch) throw new Error('Cannot persist incremental state without a terminal rated match')
  const byBoundary = new Map(previous.map((checkpoint) => [`${checkpoint.boundary.date}\u0000${checkpoint.boundary.matchId}`, checkpoint]))
  if (persistTerminalCheckpoint) {
    const terminal = checkpointFromState(sourceData, ledger, state, generatedAt)
    byBoundary.set(`${terminal.boundary.date}\u0000${terminal.boundary.matchId}`, terminal)
  }
  return {
    ledger,
    compatibility: stateCompatibility(sourceData),
    sourceReceiptDigest: sha256(stableJson({ schedule: ledger.scheduleReceiptIdentity, context: ledger.contextReceiptIdentity, provenance: ledger.provenanceReceiptIdentity })),
    checkpoints: [...byBoundary.values()].sort((left, right) => left.boundary.date.localeCompare(right.boundary.date) || left.boundary.matchId.localeCompare(right.boundary.matchId)),
  }
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

function parseCausalSummaries(value: unknown): IncrementalStateBuild['checkpoints'][number]['causalSummaries'] {
  const record = requiredRecord(value, 'causal summaries')
  return {
    sourcedPlayer: requiredRecord(record.sourcedPlayer, 'sourcedPlayer'),
    dssTeam: requiredRecord(record.dssTeam, 'dssTeam'),
    dssRegion: requiredRecord(record.dssRegion, 'dssRegion'),
    rosterEra: requiredRecord(record.rosterEra, 'rosterEra'),
    playerResume: requiredRecord(record.playerResume, 'playerResume'),
  }
}

function causalSummariesForBundle(bundle: ExternalCausalBundle): IncrementalStateBuild['checkpoints'][number]['causalSummaries'] {
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
) {
  const inventory = dependencyInventory(rootArtifact, publicManifest, changes)
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
) {
  const artifactPaths = Object.keys(requiredRecord(publicManifest.artifacts, 'public generation artifacts'))
  const snapshotIndex = requiredRecord(rootArtifact.snapshotIndex, 'ranking root snapshot index')
  const scopes = Object.entries(snapshotIndex).flatMap(([key, value]) => {
    const entry = requiredRecord(value, `snapshot index ${key}`)
    const filter = requiredRecord(entry.filter, `snapshot index ${key} filter`)
    if (typeof filter.season !== 'string' || typeof filter.event !== 'string' || typeof filter.region !== 'string') return []
    const pagePrefix = `/data/${publicMatchHistoryPagePath(key, 1).replace(/-1\.json$/, '-')}`
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
      matchPages: artifactPaths
        .filter((path) => path.startsWith(pagePrefix))
        .sort((left, right) => matchPageNumber(left) - matchPageNumber(right) || left.localeCompare(right))
        .map((path) => ({ path, seriesIds: [] })),
    }]
  })
  const historyPaths = scopes.map((scope) => `/data/${publicTeamHistoryShardPath(scope.key)}`)
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

function metricsFor(classification: RankingChangeClassification, ledger: CanonicalMatchLedger, replay: ReturnType<typeof selectReplay>, replayedMatchCount: number, semantic: SemanticArtifactMap, changedPaths: string[], reusedPaths: string[], removedPaths: string[], fullSnapshotWritten: boolean, parity: boolean | null, stateParity: boolean | null, materializedScopeCount: number): IncrementalBuildMetrics {
  const base = baseMetrics(classification.kind, ledger, { fullSnapshotWritten })
  const suffixRows = replay.replayFromUtcDate ? ledger.rows.filter((row) => row.utcDate >= replay.replayFromUtcDate) : ledger.rows
  return {
    ...base, replayFromUtcDate: replay.replayFromUtcDate, replayedMatchCount, candidateCount: replay.candidateCount,
    rejectedCandidates: replay.rejectedCandidates, selectedBoundary: replay.selectedBoundary,
    suffixRows: suffixRows.length, suffixDates: new Set(suffixRows.map((row) => row.utcDate)).size,
    changedPaths, reusedPaths, removedPaths,
    semanticBytes: Object.keys(semantic).length, compressedBytes: 0, parity, stateParity, materializedScopeCount,
    ...(providerAvailabilityForClassification(ledger, classification) ? { providerAvailableAt: providerAvailabilityForClassification(ledger, classification) } : {}),
  }
}

function baseMetrics(classification: RankingChangeClassification['kind'], ledger: CanonicalMatchLedger, overrides: Partial<IncrementalBuildMetrics> = {}): IncrementalBuildMetrics {
  return {
    classification, replayedMatchCount: 0, candidateCount: 0, rejectedCandidates: [], canonicalRows: ledger.rows.length,
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

function compareIncrementalState(expected: IncrementalStateBuild, actual: IncrementalStateBuild) {
  const expectedProjection = { ...expected, checkpoints: expected.checkpoints.slice(-1) }
  const actualProjection = { ...actual, checkpoints: actual.checkpoints.slice(-1) }
  const expectedJson = stableJson(expectedProjection)
  const actualJson = stableJson(actualProjection)
  return {
    equal: expectedJson === actualJson,
    expectedDigest: sha256(expectedJson),
    actualDigest: sha256(actualJson),
    expectedCheckpointDigests: expected.checkpoints.map((checkpoint) => sha256(stableJson(checkpoint))),
    actualCheckpointDigests: actual.checkpoints.map((checkpoint) => sha256(stableJson(checkpoint))),
  }
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

function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }

function utcDateAfter(date: string) {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  parsed.setUTCDate(parsed.getUTCDate() + 1)
  return parsed.toISOString().slice(0, 10)
}

function isString(value: string | undefined): value is string {
  return value !== undefined
}
