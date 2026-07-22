import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { CAUSAL_PREFIX_SCHEMA_VERSION } from '../src/lib/causalRecompute'
import { affectedPublicArtifacts, assertArtifactDependencyPlanMatchesSemanticChanges } from '../src/lib/incremental/artifactDependencies'
import { buildCanonicalMatchLedger, classifyRankingChange, parseCanonicalMatchLedger } from '../src/lib/incremental/changeClassifier'
import { replayRankingState } from '../src/lib/incremental/replayOrchestrator'
import { compareSemanticArtifactMaps, type SemanticArtifactMap } from '../src/lib/incremental/semanticParity'
import { stableDigest, stableJson, type CanonicalMatchLedger, type RankingChangeClassification } from '../src/lib/incremental/types'
import { createRatingReplayContext, replayRatingDates, transparentGprModelMetadata } from '../src/lib/model'
import { RATING_CHECKPOINT_SCHEMA_VERSION, encodeRatingCheckpoint, selectSafeCheckpoint } from '../src/lib/ratingCheckpoint'
import { buildRatingCheckpointEventContract } from '../src/lib/ratingCheckpointInventory'
import { PUBLIC_ARTIFACT_SCHEMA_VERSION, artifactMetaFor } from '../src/lib/publicArtifacts/schema'
import { deriveTournamentInstances } from '../src/lib/internationalTournaments'
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
  const context = ledgerContext(sourceData)
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

    const replay = selectReplay(restored.checkpoints, sourceData, ledger, classification)
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
      writeFullSnapshot: false,
      replacePublicDirectory: false,
      env,
      silent,
    })
    const previousSemantic = semanticMapFromGeneration(restored.publicManifest)
    const currentSemantic = semanticMapFromWrites(candidate.publicPlan.writes)
    const changes = changesForClassification(previousLedger, ledger, classification)
    const dependencyPlan = affectedPublicArtifacts({
      changes,
      inventory: emptyDependencyInventory(),
      previousSemanticArtifacts: previousSemantic,
      currentSemanticArtifacts: currentSemantic,
    })
    assertArtifactDependencyPlanMatchesSemanticChanges(dependencyPlan, previousSemantic, currentSemantic)
    const changed = new Set(dependencyPlan.logicalPaths)
    const currentPaths = Object.keys(currentSemantic).sort()
    const removedPaths = Object.keys(previousSemantic).filter((path) => !Object.hasOwn(currentSemantic, path)).sort()
    const changedWrites = candidate.publicPlan.writes.filter((write) => changed.has(`/data/${write.relativePath}`))
    const root = candidate.publicPlan.writes.find((write) => write.relativePath === 'ranking-summary.json')
    if (root && !changedWrites.includes(root)) changedWrites.push(root)
    const state = buildTerminalState(sourceData, ledger, replayResult.state, restored.checkpoints, generatedAt)
    let parity: boolean | null = null

    if (mode === 'shadow') {
      const full = await buildSnapshot({ output, publicDataDir, reconciliationOutput, sourceData, generatedAt, env, silent })
      const report = compareSemanticArtifactMaps(
        semanticMapFromWrites(full.publicPlan.writes, true),
        semanticMapFromWrites(candidate.publicPlan.writes, true),
      )
      parity = report.equal
      if (!report.equal) {
        const diagnostic = await persistDiagnostic(diagnosticPath, {
          schemaVersion: 1, kind: 'shadow-parity', reason: 'semantic-parity-mismatch', classification: classification.kind, parity: report,
        })
        await rm(candidateDir, { recursive: true, force: true })
        return {
          action: 'publish-full', sourceData, build: full, state: buildStateFromFullReplay(sourceData, ledger, generatedAt), diagnostic,
          metrics: withArtifactBytes(metricsFor(classification, ledger, replay, replayResult.replayedMatchCount, currentSemantic, [], currentPaths, removedPaths, true, false), candidate.publicPlan.writes),
        }
      }
      await rm(candidateDir, { recursive: true, force: true })
      return {
        action: 'publish-full', sourceData, build: full, state, metrics: withArtifactBytes(metricsFor(classification, ledger, replay, replayResult.replayedMatchCount, currentSemantic, dependencyPlan.logicalPaths, currentPaths.filter((path) => !changed.has(path)), removedPaths, true, true), candidate.publicPlan.writes),
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
      metrics: withArtifactBytes(metricsFor(classification, ledger, replay, replayResult.replayedMatchCount, currentSemantic, changedWrites.map((write) => `/data/${write.relativePath}`).sort(), currentPaths.filter((path) => !changed.has(path)), removedPaths, false, parity), changedWrites),
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

function ledgerContext(sourceData: RankingSourceImport) {
  return {
    modelVersion: transparentGprModelMetadata.version,
    modelConfigHash: transparentGprModelMetadata.configHash,
    importerVersion: RANKING_INCREMENTAL_IMPORTER_VERSION,
    identityTaxonomyHash: stableDigest(sourceData.teams),
    scheduleReceiptIdentity: stableDigest(sourceData.tournamentScheduleReferences),
    contextReceiptIdentity: stableDigest(sourceData.teams),
    provenanceReceiptIdentity: stableDigest(sourceData.externalSources),
    teams: sourceData.teams,
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

function selectReplay(checkpoints: RestoredCheckpoint[], sourceData: RankingSourceImport, ledger: CanonicalMatchLedger, classification: RankingChangeClassification) {
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
      return stored && validateCausalProof(stored.bundle.causalSummaries, sourceData, ledger, checkpoint.metadata.processedThroughUtcDate)
        ? { status: 'ready' }
        : { status: 'replay-required', replayFromUtcDate: changedDate, requiresFullReplay: true, reason: 'context-unproven' }
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
    if (terminalDates.has(date)) checkpoints.push(checkpointFromState(sourceData, ledger, state, generatedAt))
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
      causalSummaries: causalProof(sourceData, ledger, candidate.boundary.date),
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

function buildTerminalState(sourceData: RankingSourceImport, ledger: CanonicalMatchLedger, state: ReturnType<typeof replayRankingState>['state'], restored: RestoredCheckpoint[], generatedAt: string): IncrementalStateBuild {
  const previous = restored.map(({ candidate, bundle }) => ({
    boundary: candidate.boundary,
    rawPrefix: candidate.rawPrefix,
    ratingCheckpoint: requiredRecord(bundle.ratingCheckpoint, 'restored rating checkpoint'),
    causalSummaries: parseCausalSummaries(bundle.causalSummaries),
  }))
  const final = ledger.rows.at(-1)
  if (!final || !state.processedThroughUtcDate || !state.previousMatch) throw new Error('Cannot persist incremental state without a terminal rated match')
  const terminal = checkpointFromState(sourceData, ledger, state, generatedAt)
  const byBoundary = new Map(previous.map((checkpoint) => [`${checkpoint.boundary.date}\u0000${checkpoint.boundary.matchId}`, checkpoint]))
  byBoundary.set(`${terminal.boundary.date}\u0000${terminal.boundary.matchId}`, terminal)
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
    causalSummaries: causalProof(sourceData, ledger, date),
  }
}

function causalProof(sourceData: RankingSourceImport, ledger: CanonicalMatchLedger, throughDate: string) {
  const proof = {
    schemaVersion: 1,
    processedThroughUtcDate: throughDate,
    prefixDigest: rawPrefix(ledger, throughDate).digest,
    contextDigest: stableDigest({ teams: sourceData.teams, schedule: sourceData.tournamentScheduleReferences }),
  }
  return { sourcedPlayer: proof, dssTeam: proof, dssRegion: proof, rosterEra: proof, playerResume: proof }
}

function tournamentLifecyclesFor(sourceData: RankingSourceImport, generatedAt: string) {
  return new Map(deriveTournamentInstances({
    matches: sourceData.matches,
    scheduleReferences: sourceData.tournamentScheduleReferences,
    generatedAt,
  }).map((instance) => [instance.id, {
    status: instance.status,
    boundaryDate: instance.boundaryDate,
    ratedThroughDate: instance.ratedThroughDate,
    dataLag: instance.dataLag,
    resultCoverageComplete: instance.resultCoverageComplete,
  }] as const))
}

function validateCausalProof(value: unknown, sourceData: RankingSourceImport, ledger: CanonicalMatchLedger, throughDate: string) {
  const expected = causalProof(sourceData, ledger, throughDate)
  try { return stableJson(parseCausalSummaries(value)) === stableJson(expected) } catch { return false }
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

function changesForClassification(previous: CanonicalMatchLedger, current: CanonicalMatchLedger, classification: RankingChangeClassification) {
  const before = new Map(previous.rows.map((row) => [row.key, row.match]))
  const after = new Map(current.rows.map((row) => [row.key, row.match]))
  if (classification.kind === 'metadata-only') return [{ metadataOnly: true }]
  return [...new Set([...classification.addedKeys, ...classification.removedKeys, ...classification.changedKeys])].map((key) => ({
    before: before.get(key), after: after.get(key), kind: classification.kind, rollingBaselineChanged: true,
  }))
}

function emptyDependencyInventory() {
  return {
    manifestPath: '/data/ranking-summary.json', playerDirectoryPath: '/data/entities/players.json',
    teamDirectoryPath: '/data/entities/teams.json', regionHistoryPath: '/data/history/region-series.json',
    teamHistoryIndexPath: '/data/history/team-series/index.json', tournamentMovementIndexPath: '/data/history/tournament-moves/index.json',
    matchHistoryIndexPath: '/data/matches/index.json', scopes: [], teamHistoryPaths: {}, tournamentMovementPaths: {},
  }
}

function metricsFor(classification: RankingChangeClassification, ledger: CanonicalMatchLedger, replay: ReturnType<typeof selectReplay>, replayedMatchCount: number, semantic: SemanticArtifactMap, changedPaths: string[], reusedPaths: string[], removedPaths: string[], fullSnapshotWritten: boolean, parity: boolean | null): IncrementalBuildMetrics {
  const base = baseMetrics(classification.kind, ledger, { fullSnapshotWritten })
  const suffixRows = replay.replayFromUtcDate ? ledger.rows.filter((row) => row.utcDate >= replay.replayFromUtcDate) : ledger.rows
  return {
    ...base, replayFromUtcDate: replay.replayFromUtcDate, replayedMatchCount, candidateCount: replay.candidateCount,
    rejectedCandidates: replay.rejectedCandidates, selectedBoundary: replay.selectedBoundary,
    suffixRows: suffixRows.length, suffixDates: new Set(suffixRows.map((row) => row.utcDate)).size,
    changedPaths, reusedPaths, removedPaths,
    semanticBytes: Object.keys(semantic).length, compressedBytes: 0, parity,
  }
}

function baseMetrics(classification: RankingChangeClassification['kind'], ledger: CanonicalMatchLedger, overrides: Partial<IncrementalBuildMetrics> = {}): IncrementalBuildMetrics {
  return {
    classification, replayedMatchCount: 0, candidateCount: 0, rejectedCandidates: [], canonicalRows: ledger.rows.length,
    canonicalBytes: Buffer.byteLength(stableJson(ledger)), suffixRows: 0, suffixDates: 0, changedPaths: [], reusedPaths: [], removedPaths: [],
    semanticBytes: 0, compressedBytes: 0, fullSnapshotWritten: false, parity: null, ...overrides,
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
