import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { manifestWithResolvedFiles } from './local-data-manifest.js'
import { replaceDirectory } from './replace-directory.ts'
import {
  attachIncrementalArtifactCache,
  attachIncrementalPlayerCheckpoints,
  attachIncrementalReducerCheckpoint,
  attachIncrementalSnapshotModelCache,
  describeIncrementalInputTransition,
  describeIncrementalStateTransition,
  loadIncrementalCommunityImports,
  promoteIncrementalState,
  stageIncrementalState,
  validateIncrementalStateTree,
  type IncrementalCommunityImports,
  type IncrementalCheckpointLoader,
  type IncrementalStatePromotion,
  type ProviderAuthorities,
} from './incremental-provider-state.ts'
import { knownTeamIdentities } from '../src/data/teamIdentity'
import { mergeCommunityMatchSources } from '../src/lib/importers/communitySources'
import { importLeaguepediaSnapshot, type LeaguepediaImportResult, type LeaguepediaSnapshot } from '../src/lib/importers/leaguepedia'
import { importLolEsportsScheduleSnapshot, type LolEsportsReferenceImportResult } from '../src/lib/importers/lolEsports'
import { importOraclesElixirRecords, parseOraclesElixirCsvRecords, type OracleImportResult } from '../src/lib/importers/oraclesElixir'
import { createStaticRankingData, type DataSourceWarning } from '../src/lib/snapshot'
import {
  createPublicArtifactWritePlan,
  createSemanticPublicArtifactWritePlan,
  PUBLIC_ARTIFACT_PATHS,
} from '../src/lib/publicArtifacts/writePlan'
import { filterPublishedRatingUniverseInput, filterPublishedRatingUniverseMatches } from '../src/lib/ratingUniverse'
import { resolveCanonicalSeries } from '../src/lib/seriesResolver'
import { deriveTeamProfilesFromMatches, mergeTeamProfiles } from '../src/lib/teamProfiles'
import { transparentGprModelMetadata } from '../src/lib/model'
import { runIdForArtifact } from '../src/lib/publicArtifacts/schema'
import {
  createIncrementalCrunchReceipt,
  recordCrunchAttemptSources,
  recordCrunchTiming,
  recordIncrementalReducerCandidate,
  recordSnapshotInputMetrics,
  type IncrementalCrunchReceipt,
} from '../src/lib/incremental/metrics'
import {
  crunchModeFrom,
  orchestrateCrunch,
  type CrunchOrchestrationResult,
} from '../src/lib/incremental/orchestrator'
import type { CrunchRunMetadata } from '../src/lib/incremental/types'
import { incrementalStateDirectory } from '../src/lib/incremental/canonicalState'
import { assertCrunchParity } from '../src/lib/incremental/parity'
import type { CanonicalRankingInput } from '../src/lib/incremental/canonicalState'
import { createCrunchCompatibility } from '../src/lib/incremental/compatibility'
import { CANONICAL_LEDGER_SCHEMA_VERSION } from '../src/lib/incremental/canonicalLedger'
import { PROVIDER_LEDGER_SCHEMA_VERSION } from '../src/lib/incremental/providerLedger'
import { regionalSplitCalendars } from '../src/data/rankingCalendar'
import { canonicalCodeProvenanceHash } from './canonical-code-provenance.ts'
import type { RankingModelResult } from '../src/lib/model.ts'
import type { PlayerProfile, PlayerStanding } from '../src/types.ts'
import { deriveTournamentInstances } from '../src/lib/internationalTournaments.ts'
import { runIncrementalRankingReducers } from '../src/lib/incremental/rankingReducer.ts'
import { buildReducerDependencyPlan, type IncrementalReducerCheckpoint } from '../src/lib/incremental/reducerCheckpoint.ts'
import { playerReducerDependencyHash, runIncrementalPlayerReducer } from '../src/lib/incremental/playerReducer.ts'
import type { IncrementalPlayerCheckpoint } from '../src/lib/incremental/playerReducer.ts'
import { eventWeightContextForMatches } from '../src/lib/eventWeighting.ts'
import { playerModelModeForMatches, sortPlayerModelMatches } from '../src/lib/playerModel.ts'
import {
  createIncrementalSnapshotModelProvider,
  type SnapshotInputMetrics,
  type SnapshotModelProvider,
  type PersistedSnapshotModelState,
} from '../src/lib/incremental/snapshotInputs.ts'
import { buildPublicArtifactDag, type PersistedArtifactNode } from '../src/lib/incremental/artifactDag.ts'
import { stableHash } from '../src/lib/incremental/hash.ts'
import { decodePrivateState } from '../src/lib/incremental/canonicalCodec.ts'
import { assertExternalShadowParity } from './external-shadow-parity.ts'
import {
  cleanupStagedShadowModelState,
  readStagedShadowModelState,
  stageShadowModelState,
  type StagedShadowModelState,
} from './shadow-model-state.ts'
import {
  createIncrementalSemanticInputRoot,
  deriveRankingTemporalContext,
} from '../src/lib/incremental/semanticInputRoot.ts'
import { bucketConfigFromEnv, createBucketClient } from './railway-bucket.mjs'
import {
  createRailwayDurableObjectStore,
  decideDurableCrunchMode,
  restoreDurableGeneration,
  stageDurableGeneration,
  type DurableCandidate,
  type DurableIdentity,
} from './durable-ranking-state.mjs'

const output = resolve(readArg('output') ?? 'data/derived/ranking-snapshot.full.json')
const publicDataTargetDir = resolve(readArg('public-data-dir') ?? '.generated/ranking-data')
const reconciliationOutput = readArg('reconciliation-output') ? resolve(readArg('reconciliation-output')!) : undefined
const receiptOutput = readArg('receipt') ? resolve(readArg('receipt')!) : undefined
const publicDataDir = `${publicDataTargetDir}.next-${process.pid}`
const generatedAt = readArg('generated-at') ?? new Date().toISOString()
const runMetadata: CrunchRunMetadata = {
  generatedAt,
  runId: readArg('run-id') ?? runIdForArtifact({
    generatedAt,
    modelVersion: transparentGprModelMetadata.version,
    modelConfigHash: transparentGprModelMetadata.configHash,
  }),
}
const requestedMode = process.argv.includes('--full')
  ? 'full'
  : crunchModeFrom(readArg('mode') ?? process.env.RANKING_CRUNCH_MODE)
let mode = requestedMode
const enforcePublicArtifactBudgets = !process.argv.includes('--allow-public-artifact-budget-overage')
const externalShadowReference = mode === 'incremental-shadow'
  && process.env.RANKING_EXTERNAL_SHADOW_REFERENCE_SNAPSHOT
  && process.env.RANKING_EXTERNAL_SHADOW_REFERENCE_PUBLIC_DIR
  ? {
      snapshot: resolve(process.env.RANKING_EXTERNAL_SHADOW_REFERENCE_SNAPSHOT),
      publicDir: resolve(process.env.RANKING_EXTERNAL_SHADOW_REFERENCE_PUBLIC_DIR),
    }
  : undefined
const receipt = createIncrementalCrunchReceipt({ run: runMetadata, requestedMode })
const privateStateDir = resolve(incrementalStateDirectory(readArg('incremental-state-dir') ?? process.env.RANKING_INCREMENTAL_STATE_DIR))
const durableCandidateOutput = readArg('durable-candidate-output') ?? process.env.RANKING_DURABLE_CANDIDATE_OUTPUT
const manifestPath = readArg('manifest')
const resolvedManifestPath = manifestPath ? resolve(manifestPath) : undefined
const manifest = resolvedManifestPath
  ? manifestWithResolvedFiles(JSON.parse(await readFile(resolvedManifestPath, 'utf8')) as LocalDataManifest, dirname(resolvedManifestPath)) as LocalDataManifest
  : undefined
const staticPlayerRosters = await loadStaticPlayerRosters(readArg('static-player-json') ?? process.env.RANKING_STATIC_PLAYER_JSON)
const normalizedOracleChunks = normalizedChunksFor(manifest, resolvedManifestPath, 'oracles-elixir')
const oracleCsvPaths = uniquePaths([
  ...readArgList('oracle-csv'),
  ...(normalizedOracleChunks.length > 0 ? normalizedOracleChunks.map((chunk) => chunk.path) : manifest?.files.oracleCsv ?? []),
])
const leaguepediaJsonPaths = uniquePaths([...readArgList('leaguepedia-json'), ...(manifest?.files.leaguepediaJson ?? [])])
const lolEsportsJsonPaths = uniquePaths([...readArgList('lolesports-json'), ...(manifest?.files.lolEsportsJson ?? [])])
const providerSourceIds = {
  'oracles-elixir': logicalSourceIds(oracleCsvPaths, resolvedManifestPath, 'oracle-source-id', readArgList('oracle-source-id')),
  'leaguepedia-cargo': logicalSourceIds(leaguepediaJsonPaths, resolvedManifestPath, 'leaguepedia-source-id', readArgList('leaguepedia-source-id')),
  'lol-esports-api': logicalSourceIds(lolEsportsJsonPaths, resolvedManifestPath, 'lolesports-source-id', readArgList('lolesports-source-id')),
}
const trustedProviderSources = {
  'oracles-elixir': Object.fromEntries(normalizedOracleChunks.map((chunk) => [chunk.logicalId, { digest: chunk.digest, bytes: chunk.bytes }])),
}
const oracleWarnings = manifestSourceWarnings('oracle', manifest?.warnings)
const leaguepediaWarnings = manifestSourceWarnings('leaguepedia', manifest?.warnings)
const lolEsportsWarnings = manifestSourceWarnings('lolesports', manifest?.warnings)
const authorities = providerAuthorities(manifest)
const codeProvenanceHash = await canonicalCodeProvenanceHash()
const pipelineVersion = process.env.RANKING_INCREMENTAL_PIPELINE_VERSION ?? 'incremental-canonical-v2'
const compatibility = createCrunchCompatibility({
  pipelineVersion,
  importerVersion: 'community-importers-v1',
  reconciliationVersion: 'community-reconciliation-v1',
  ratingUniverseVersion: 'published-rating-universe-v1',
  identityAliasTaxonomyVersion: 'team-identity-2026-07-18',
  teamIdentities: knownTeamIdentities,
  scheduleNormalizationVersion: 'lol-esports-schedule-v1',
  providerSchemaVersion: PROVIDER_LEDGER_SCHEMA_VERSION,
  canonicalSchemaVersion: CANONICAL_LEDGER_SCHEMA_VERSION,
  calendar: regionalSplitCalendars,
  modelVersion: transparentGprModelMetadata.version,
  modelConfigHash: transparentGprModelMetadata.configHash,
  modelMetadata: transparentGprModelMetadata,
  codeProvenanceHash,
})
const durableIdentity: DurableIdentity = {
  compatibilityHash: compatibility.hash,
  pipelineVersion: compatibility.dependencies.pipelineVersion ?? '<missing>',
  codeHash: compatibility.dependencies.codeProvenanceHash ?? '<missing>',
  modelVersion: transparentGprModelMetadata.version,
  modelConfigHash: transparentGprModelMetadata.configHash,
}
const durableBucketConfig = bucketConfigFromEnv()
const durableBucketClient = createBucketClient(durableBucketConfig)
const durableStore = process.env.RANKING_DURABLE_STATE_ENABLED !== 'false' && durableBucketConfig.enabled && durableBucketClient
  ? createRailwayDurableObjectStore({ config: durableBucketConfig, client: durableBucketClient })
  : undefined
let durableActivePointer: Record<string, unknown> | undefined
let durableRolloutReason = 'durable-state-disabled'
let durableBootstrapEligible = false
let durableRestoreFailed = false
let previousDurableRetentionBoundaries: Array<{ processedDate?: string; classes: string[] }> = []
let previousDurableSemanticState: Record<string, unknown> | undefined
if (durableStore && requestedMode !== 'full') {
  const restore = await restoreDurableGeneration({
    store: durableStore,
    stateDir: privateStateDir,
    expectedIdentity: durableIdentity,
    validateStateDir: (stateDir) => validateIncrementalStateTree(stateDir, durableIdentity.compatibilityHash),
  })
  const restoreMetrics = recordValue(restore.metrics)
  receipt.durable.restoredObjects = numberValue(restoreMetrics.restoredObjects)
  receipt.durable.restoredBytes = numberValue(restoreMetrics.restoredBytes)
  receipt.durable.cacheHits = numberValue(restoreMetrics.cacheHits)
  receipt.durable.cacheMisses = numberValue(restoreMetrics.cacheMisses)
  if (restore.restored) {
    durableActivePointer = recordValue(restore.active)
    const restoredManifest = recordValue(restore.manifest)
    const restoredSemanticState = recordValue(restoredManifest.semanticState)
    previousDurableSemanticState = restoredSemanticState
    previousDurableRetentionBoundaries = retentionBoundaryValues(restoredSemanticState.retentionBoundaries)
    const rollout = decideDurableCrunchMode({
      requestedMode,
      identity: durableIdentity,
      activePointer: durableActivePointer,
      shadowThreshold: positiveIntegerEnv('RANKING_INCREMENTAL_SHADOW_THRESHOLD', 3),
      now: runMetadata.generatedAt,
      auditIntervalMs: positiveIntegerEnv('RANKING_INCREMENTAL_AUDIT_INTERVAL_MS', 7 * 24 * 60 * 60_000),
      forceAudit: process.env.RANKING_INCREMENTAL_FORCE_AUDIT === 'true',
    })
    mode = rollout.effectiveMode
    durableRolloutReason = rollout.reason
    if (rollout.reason === 'forced-audit') receipt.durable.audit = 'forced'
    else if (rollout.reason === 'scheduled-audit') receipt.durable.audit = 'scheduled'
  } else {
    const fallback = durableFallback(restore.fallback)
    receipt.durable.fallback = fallback
    receipt.checkpoint.fallback = fallback
    durableBootstrapEligible = requestedMode === 'incremental-shadow'
    durableRestoreFailed = !durableBootstrapEligible
    mode = durableBootstrapEligible ? 'incremental-shadow' : 'full'
    durableRolloutReason = fallback.kind
  }
}

if (process.argv.includes('--seeded-sample')) {
  throw new Error('Seeded sample generation has been removed from the production build path. Provide public source files or use tests/fixtures/rankingFixtures.ts for unit fixtures.')
}

function buildCrunchOutput({
  oracleImports,
  leaguepediaImports,
  lolEsportsImports,
  metrics,
  canonical,
}: CommunityImports, precomputedGlobalRanking?: RankingModelResult, precomputedGlobalPlayers?: PlayerStanding[], reducerRows?: ReducerRows, selectedCheckpointDate?: string, selectedPlayerCheckpointDate?: string, modelProvider?: SnapshotModelProvider): CrunchOutput {
const directSnapshotInputMetrics = modelProvider ? undefined : emptySnapshotInputMetrics()
const directImportedMatches = canonical ? undefined : mergeCommunityMatchSources({
  oracleMatches: oracleImports.flatMap((result) => result.matches),
  leaguepediaMatches: leaguepediaImports.flatMap((result) => result.matches),
  lolEsportsReferences: lolEsportsImports.flatMap((result) => result.events),
})
const importedMatches = canonical?.importedMatches ?? directImportedMatches ?? []
const importedTeams = mergeTeamProfiles([...leaguepediaImports.map((result) => result.teams), ...oracleImports.map((result) => result.teams)])
const mergedTeams = canonical
  ? { ...canonical.teams, ...knownTeamIdentities }
  : importedMatches.length > 0 ? { ...deriveTeamProfilesFromMatches(importedMatches, importedTeams), ...knownTeamIdentities } : {}
const ratingUniverse = canonical
  ? filterPublishedRatingUniverseInput(canonical.matches, mergedTeams)
  : filterPublishedRatingUniverseInput(importedMatches, mergedTeams)
const matches = ratingUniverse.matches
const teams = ratingUniverse.teams
const snapshot = createStaticRankingData({
  matches,
  teams,
  rosters: staticPlayerRosters,
  runMetadata,
  source: matches.length > 0
    ? describeCommunitySource(oracleImports.length, leaguepediaImports.length)
    : importedMatches.length > 0 ? 'no rated public match data available for published team universe' : 'no public match data available',
  dataMode: matches.length > 0 ? 'scheduled-public-data' : 'no-data',
  externalSources: [
    ...lolEsportsImports.map((result) => ({
      name: result.source.fileName ? `LoL Esports schedule API: ${result.source.fileName}` : 'LoL Esports schedule API',
      kind: 'official-reference' as const,
      url: result.source.url,
      retrievedAt: result.source.retrievedAt,
      coverageStart: dateRange(result.events).start,
      coverageEnd: dateRange(result.events).end,
      rowCount: result.source.eventCount,
      description: `${result.source.eventCount} schedule/result events and ${result.source.gameCount} game IDs cached from LoL Esports persisted APIs. Used only to attach official event/match/game IDs and audit schedule/results; not a rich stat source or standalone model input. ${result.source.attribution}`,
      status: result.source.eventCount > 0 ? 'active' as const : 'reference-only' as const,
      warnings: [
        {
          kind: 'source-policy' as const,
          severity: 'warning' as const,
          message: 'LoL Esports persisted APIs are public site endpoints, not a supported official data API; cache responses and keep them reference-only.',
        },
        ...lolEsportsWarnings,
      ],
      ...(sourceRefreshReceipt('lolesports', manifest) ? { refreshReceipt: sourceRefreshReceipt('lolesports', manifest) } : {}),
    })),
    ...oracleImports.map((result) => {
      const ratedMatches = filterPublishedRatingUniverseMatches(result.matches, mergedTeams)
      return {
        name: result.source.fileName ? `Oracle's Elixir CSV: ${result.source.fileName}` : "Oracle's Elixir CSV",
        kind: 'game-stats' as const,
        url: result.source.url,
        retrievedAt: result.source.retrievedAt,
        coverageStart: dateRange(ratedMatches).start,
        coverageEnd: dateRange(ratedMatches).end,
        rowCount: ratedMatches.length,
        description: `${ratedMatches.length} rated games retained from ${result.source.gameCount} Oracle's Elixir imports after the published team-universe filter. ${result.source.attribution}`,
        status: ratedMatches.length > 0 ? 'active' as const : 'reference-only' as const,
        ...(oracleWarnings.length > 0 ? { warnings: oracleWarnings } : {}),
        ...(sourceRefreshReceipt('oracle', manifest) ? { refreshReceipt: sourceRefreshReceipt('oracle', manifest) } : {}),
      }
    }),
    ...leaguepediaImports.map((result) => {
      const ratedMatches = filterPublishedRatingUniverseMatches(result.matches, mergedTeams)
      return {
        name: result.source.fileName ? `Leaguepedia Cargo: ${result.source.fileName}` : 'Leaguepedia Cargo',
        kind: 'match-data' as const,
        url: result.source.url,
        retrievedAt: result.source.retrievedAt,
        coverageStart: dateRange(ratedMatches).start,
        coverageEnd: dateRange(ratedMatches).end,
        rowCount: ratedMatches.length,
        description: `${ratedMatches.length} rated games retained from ${result.source.gameCount} Leaguepedia Cargo imports for requested range ${result.source.start ?? 'unknown'} to ${result.source.end ?? 'unknown'} after the published team-universe filter. ${result.source.attribution}`,
        status: ratedMatches.length > 0 ? 'active' as const : 'reference-only' as const,
        ...(leaguepediaWarnings.length > 0 ? { warnings: leaguepediaWarnings } : {}),
        ...(sourceRefreshReceipt('leaguepedia', manifest) ? { refreshReceipt: sourceRefreshReceipt('leaguepedia', manifest) } : {}),
      }
    }),
  ],
  tournamentScheduleReferences: tournamentScheduleReferencesFor(lolEsportsImports),
  pipelineAudit: { importedMatchCount: importedMatches.length },
  precomputedGlobalRanking,
  precomputedGlobalPlayers: Object.keys(staticPlayerRosters).length > 0 ? undefined : precomputedGlobalPlayers,
  modelProvider,
  modelMetrics: directSnapshotInputMetrics,
})
  return {
    snapshot,
    importedMatches,
    metrics,
    ...(reducerRows ? { reducerRows } : {}),
    ...(selectedCheckpointDate ? { selectedCheckpointDate } : {}),
    ...(selectedPlayerCheckpointDate ? { selectedPlayerCheckpointDate } : {}),
    snapshotInputMetrics: modelProvider?.metrics() ?? directSnapshotInputMetrics,
    ...(modelProvider?.persistedState && mode === 'incremental' ? { snapshotModelState: modelProvider.persistedState() } : {}),
    ...(modelProvider?.persistedState && mode !== 'incremental'
      ? { snapshotModelStateFactory: () => modelProvider.persistedState!() }
      : {}),
  }
}

const crunchStartedAt = performance.now()
const runFull = async () => buildCrunchOutput(await loadFullCommunityImports())
let pendingPromotion: IncrementalStatePromotion | undefined
let incrementalAttemptMetrics: SourceMetrics | undefined
let incrementalTemporalContext: ReturnType<typeof rankingTemporalContext> | undefined
let previousArtifactCache: PersistedArtifactNode[] = []
let preloadedIncrementalResult: Awaited<ReturnType<typeof loadIncrementalCommunityImports>> | undefined
const loadIncrementalResult = () => loadIncrementalCommunityImports({
  stateDir: privateStateDir,
  oracleCsvPaths,
  leaguepediaJsonPaths,
  lolEsportsJsonPaths,
  oracleRetrievedAt: manifest?.generatedAt ?? runMetadata.generatedAt,
  now: runMetadata.generatedAt,
  authorities,
  compatibility,
  sourceIds: providerSourceIds,
  trustedSources: trustedProviderSources,
})
const runIncremental = async () => {
  const result = preloadedIncrementalResult ?? await loadIncrementalResult()
  preloadedIncrementalResult = undefined
  incrementalAttemptMetrics = result.metrics
  incrementalTemporalContext = result.imports ? rankingTemporalContext(result.imports) : undefined
  previousArtifactCache = result.artifactCache ?? []
  assertLateIncrementalWorkAllowed('reducers-and-models')
  let modelRun: Awaited<ReturnType<typeof incrementalGlobalModels>> | undefined
  try {
    modelRun = result.imports
      ? await incrementalGlobalModels(result.imports, result.reducerCheckpoints, result.playerCheckpoints, result.checkpointLoader)
      : undefined
  } catch (error) {
    return {
      fallback: {
        kind: 'checkpoint-corrupt' as const,
        detail: error instanceof Error ? error.message : String(error),
      },
    }
  }
  const modelProvider = modelRun
      ? createIncrementalSnapshotModelProvider({
        cloneResults: false,
        compatibilityHash: compatibility.hash,
        previous: result.snapshotModelCache,
      })
    : undefined
  if (result.promotion && modelRun) {
    const rankingPromotion = attachIncrementalReducerCheckpoint(result.promotion, privateStateDir, modelRun.ranking.checkpoints)
    pendingPromotion = attachIncrementalPlayerCheckpoints(rankingPromotion, privateStateDir, modelRun.players.checkpoints)
    result.metrics.reducerStateBytesWritten = pendingPromotion.reducerStateBytesWritten
  } else {
    pendingPromotion = result.promotion
  }
  if (pendingPromotion && externalShadowReference) {
    await stageIncrementalState(pendingPromotion)
    pendingPromotion = compactStagedPromotion(pendingPromotion, privateStateDir)
  }
  Reflect.deleteProperty(result, 'promotion')
  const incrementalOutput = result.imports && modelRun
    ? buildCrunchOutput(
        result.imports,
        modelRun.ranking.ranking,
        modelRun.players.players,
        { ...modelRun.ranking.rows, playerRows: modelRun.players.rows },
        modelRun.ranking.selectedCheckpointDate,
        modelRun.players.selectedCheckpointDate,
        modelProvider,
      )
    : undefined
  if (externalShadowReference && pendingPromotion && incrementalOutput?.snapshotModelStateFactory) {
    pendingPromotion = attachIncrementalSnapshotModelCache(
      pendingPromotion,
      privateStateDir,
      incrementalOutput.snapshotModelStateFactory(),
    )
    await stageIncrementalState(pendingPromotion)
    pendingPromotion = compactStagedPromotion(pendingPromotion, privateStateDir)
    Reflect.deleteProperty(incrementalOutput, 'snapshotModelStateFactory')
  }
  if (result.fallback) return {
    fallback: result.fallback,
    ...(incrementalOutput ? { output: incrementalOutput } : {}),
  }
  if (!result.imports) return { fallback: { kind: 'dependency-unknown' as const, dependency: 'provider-ledger-output' } }
  return { output: incrementalOutput! }
}

if (mode === 'incremental'
  && typeof previousDurableSemanticState?.inputRoot === 'string'
  && typeof previousDurableSemanticState.stateRoot === 'string') {
  preloadedIncrementalResult = await loadIncrementalResult()
  const current = preloadedIncrementalResult
  if (current.imports && current.promotion && !current.fallback) {
    const roots = await describeIncrementalInputTransition(current.promotion, privateStateDir)
    const staticPlayerRoot = stableHash(staticPlayerRosters)
    const { inputRoot } = createIncrementalSemanticInputRoot({
      ...roots,
      staticPlayerRoot,
      temporalContext: rankingTemporalContext(current.imports),
    })
    if (inputRoot === previousDurableSemanticState.inputRoot) {
      await finalizeEarlyNoChange({ ...current, imports: current.imports, promotion: current.promotion }, inputRoot, staticPlayerRoot)
      process.exit(0)
    }
  }
}
const orchestration: CrunchOrchestrationResult<CrunchOutput, PreparedCrunchOutput> = await orchestrateCrunch<CrunchOutput, PreparedCrunchOutput>({
  mode: externalShadowReference ? 'incremental' : mode,
  receipt,
  runFull,
  runIncremental,
  requireReferenceParity: mode !== 'incremental',
  acceptFallbackCandidate: Boolean(externalShadowReference),
  prepareShadow: async (output) => {
    const prepared = prepareCrunchOutputForParity(output)
    if (pendingPromotion) {
      await stageIncrementalState(pendingPromotion)
      pendingPromotion = compactStagedPromotion(pendingPromotion, privateStateDir)
    }
    return prepared
  },
})
const stagedShadowModelState = orchestration.shadowOutput?.snapshotModelStateStage
try {
receipt.requestedMode = requestedMode
const { snapshot, importedMatches, metrics } = orchestration.output
recordCrunchTiming(receipt, 'crunch-total', crunchStartedAt, performance.now())
receipt.sources = {
  filesScanned: metrics.filesScanned,
  bytesScanned: metrics.bytesScanned,
}
receipt.observations.parsed = metrics.rowsParsed
receipt.observations.normalized = metrics.observationsNormalized
receipt.observations.reused = metrics.observationsReused
receipt.bucket.bytesRead = incrementalAttemptMetrics?.reducerStateBytesRead ?? 0
receipt.bucket.bytesWritten = 0
const incrementalCandidate: CrunchOutput | PreparedCrunchOutput | undefined = orchestration.executedMode === 'incremental'
  ? orchestration.output
  : orchestration.shadowOutput
if (incrementalCandidate?.reducerRows) {
  recordIncrementalReducerCandidate(receipt, {
    ...incrementalCandidate.reducerRows,
    selectedCheckpoint: incrementalCandidate.selectedCheckpointDate,
    selectedPlayerCheckpoint: incrementalCandidate.selectedPlayerCheckpointDate,
  })
}
const selectedSnapshotInputMetrics = orchestration.output.snapshotInputMetrics ?? incrementalCandidate?.snapshotInputMetrics
if (selectedSnapshotInputMetrics) {
  recordSnapshotInputMetrics(receipt, selectedSnapshotInputMetrics)
}
const selectedAttempt = receipt.attempts.findLast((attempt) => (
  orchestration.executedMode === 'incremental' ? attempt.engine === 'incremental' : attempt.engine === 'reference'
))
if (selectedAttempt) recordCrunchAttemptSources(receipt, selectedAttempt.engine, {
  filesScanned: metrics.filesScanned,
  bytesScanned: metrics.bytesScanned,
  rowsParsed: metrics.rowsParsed,
  observationsNormalized: metrics.observationsNormalized,
  observationsReused: metrics.observationsReused,
  reducerStateBytesRead: metrics.reducerStateBytesRead,
  reducerStateBytesWritten: metrics.reducerStateBytesWritten,
})
const incrementalAttempt = receipt.attempts.find((attempt) => attempt.engine === 'incremental')
if (incrementalAttempt && incrementalAttemptMetrics) recordCrunchAttemptSources(receipt, 'incremental', {
  filesScanned: incrementalAttemptMetrics.filesScanned,
  bytesScanned: incrementalAttemptMetrics.bytesScanned,
  rowsParsed: incrementalAttemptMetrics.rowsParsed,
  observationsNormalized: incrementalAttemptMetrics.observationsNormalized,
  observationsReused: incrementalAttemptMetrics.observationsReused,
  reducerStateBytesRead: incrementalAttemptMetrics.reducerStateBytesRead,
  reducerStateBytesWritten: incrementalAttemptMetrics.reducerStateBytesWritten,
})
if (orchestration.shadowOutput) {
  if (incrementalAttempt) recordCrunchAttemptSources(receipt, 'incremental', {
    filesScanned: orchestration.shadowOutput.metrics.filesScanned,
    bytesScanned: orchestration.shadowOutput.metrics.bytesScanned,
    rowsParsed: orchestration.shadowOutput.metrics.rowsParsed,
    observationsNormalized: orchestration.shadowOutput.metrics.observationsNormalized,
    observationsReused: orchestration.shadowOutput.metrics.observationsReused,
    reducerStateBytesRead: orchestration.shadowOutput.metrics.reducerStateBytesRead,
    reducerStateBytesWritten: orchestration.shadowOutput.metrics.reducerStateBytesWritten,
  })
}

await mkdir(dirname(output), { recursive: true })
await writeJsonFile(output, snapshot)
if (reconciliationOutput) {
  await mkdir(dirname(reconciliationOutput), { recursive: true })
  await writeFile(reconciliationOutput, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: snapshot.generatedAt,
    matches: reconciliationEntries(importedMatches),
  }, null, 2)}\n`)
}
assertLateIncrementalWorkAllowed('public-artifact-serialization')
const publicPlan = createPublicArtifactWritePlan(snapshot, { enforceBudgets: enforcePublicArtifactBudgets, runMetadata })
let incrementalPlan = orchestration.shadowOutput?.publicPlan
  ?? (orchestration.executedMode === 'incremental'
    ? publicPlan
    : undefined)
let durableParity: { result: 'match' | 'mismatch'; audit?: boolean; detail?: string } | undefined
if (externalShadowReference) {
  try {
    if (process.env.RANKING_TEST_FORCE_PARITY_MISMATCH === 'true') throw new Error('injected incremental parity mismatch')
    await assertExternalShadowParity({
      expectedSnapshot: externalShadowReference.snapshot,
      actualSnapshot: output,
      expectedPublicDir: externalShadowReference.publicDir,
      actualPublicWrites: publicPlan.writes,
    })
    durableParity = { result: 'match' }
    receipt.durable.parity = 'match'
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    durableParity = { result: 'mismatch', detail }
    receipt.durable.parity = 'mismatch'
    receipt.checkpoint.fallback = { kind: 'dependency-unknown', dependency: `external-shadow-parity:${detail}` }
    pendingPromotion = undefined
    incrementalPlan = undefined
    await sendDurableAlert('incremental-parity-mismatch', detail)
  }
} else if (orchestration.shadowOutput) {
  try {
    if (process.env.RANKING_TEST_FORCE_PARITY_MISMATCH === 'true') {
      throw new Error('injected incremental parity mismatch')
    }
    const referenceFullSnapshotHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
    assertCrunchParity(
      { fullSnapshot: '', publicWrites: publicPlan.writes },
      { fullSnapshot: '', publicWrites: incrementalPlan!.writes },
    )
    if (referenceFullSnapshotHash !== orchestration.shadowOutput.fullSnapshotHash) {
      throw new Error(`Full snapshot hash mismatch (${referenceFullSnapshotHash} != ${orchestration.shadowOutput.fullSnapshotHash})`)
    }
    durableParity = { result: 'match', ...(receipt.durable.audit === 'scheduled' || receipt.durable.audit === 'forced' ? { audit: true } : {}) }
    receipt.durable.parity = 'match'
    if (durableParity.audit) receipt.durable.audit = 'match'
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    durableParity = { result: 'mismatch', detail, ...(receipt.durable.audit === 'scheduled' || receipt.durable.audit === 'forced' ? { audit: true } : {}) }
    receipt.durable.parity = 'mismatch'
    if (durableParity.audit) receipt.durable.audit = 'mismatch'
    receipt.checkpoint.fallback = { kind: 'dependency-unknown', dependency: `shadow-parity:${detail}` }
    pendingPromotion = undefined
    incrementalPlan = undefined
    await sendDurableAlert('incremental-parity-mismatch', detail)
  }
}
let writesToPublish = publicPlan.writes
let dagFallback = false
if (incrementalPlan && incrementalCandidate) {
  assertLateIncrementalWorkAllowed('artifact-dag')
  const dagResult = buildPublicArtifactDag({
    actual: incrementalPlan,
    semantic: orchestration.shadowOutput?.semanticPlan
      ?? createSemanticPublicArtifactWritePlan(orchestration.output.snapshot, { enforceBudgets: enforcePublicArtifactBudgets }),
    previous: previousArtifactCache,
  })
  if (dagResult.fallback) {
    dagFallback = true
    receipt.checkpoint.fallback = dagResult.fallback
    receipt.artifacts.reused = 0
    receipt.artifacts.regenerated = publicPlan.writes.length
    pendingPromotion = undefined
  } else {
    const changedPaths = new Set(dagResult.dag.writes.map((write) => write.relativePath))
    writesToPublish = publicPlan.writes.filter((write) => changedPaths.has(write.relativePath))
    receipt.artifacts.reused = dagResult.dag.semanticReused
    receipt.artifacts.regenerated = dagResult.dag.regenerated
    if (pendingPromotion) {
      if (incrementalCandidate.snapshotModelState) {
        pendingPromotion = attachIncrementalSnapshotModelCache(
          pendingPromotion,
          privateStateDir,
          incrementalCandidate.snapshotModelState,
        )
      } else if ('snapshotModelStateStage' in incrementalCandidate && incrementalCandidate.snapshotModelStateStage) {
        const isolatedState = readStagedShadowModelState(incrementalCandidate.snapshotModelStateStage, compatibility.hash)
        pendingPromotion = attachIncrementalSnapshotModelCache(
          pendingPromotion,
          privateStateDir,
          isolatedState,
        )
      }
      pendingPromotion = attachIncrementalArtifactCache(pendingPromotion, privateStateDir, dagResult.dag.cache)
      if (incrementalAttemptMetrics) incrementalAttemptMetrics.reducerStateBytesWritten = pendingPromotion.reducerStateBytesWritten
    }
  }
} else {
  receipt.artifacts.reused = 0
  receipt.artifacts.regenerated = publicPlan.writes.length
}
const incrementalOutcomeEligible = requestedMode !== 'full'
  && Boolean(incrementalCandidate)
  && !durableRestoreFailed
  && (!orchestration.fallback || durableBootstrapEligible)
  && durableParity?.result !== 'mismatch'
  && !dagFallback
let stateTransition: Awaited<ReturnType<typeof describeIncrementalStateTransition>> | undefined
if (pendingPromotion && incrementalOutcomeEligible) {
  stateTransition = await describeIncrementalStateTransition(pendingPromotion, privateStateDir)
}
const semanticNoChange = Boolean(stateTransition?.semanticNoChange && incrementalOutcomeEligible)
if (!incrementalOutcomeEligible || semanticNoChange) pendingPromotion = undefined
if (semanticNoChange) {
  writesToPublish = []
  receipt.artifacts.reused = publicPlan.writes.length
  receipt.artifacts.regenerated = 0
  receipt.durable.promotion = 'no-change'
}
const selectedPublicPaths = new Set(writesToPublish.map((write) => write.relativePath))
for (const write of semanticNoChange ? [] : publicPlan.writes) {
  if (selectedPublicPaths.has(write.relativePath)) continue
  if (await isRegularFile(resolve(publicDataTargetDir, write.relativePath))) continue
  writesToPublish.push(write)
  selectedPublicPaths.add(write.relativePath)
}
receipt.artifacts.regenerated = writesToPublish.length
const summaryOutput = resolve(publicDataTargetDir, PUBLIC_ARTIFACT_PATHS.manifest)
const summarySnapshots = Object.entries(publicPlan.snapshots)
const publicWrites = writesToPublish.map((entry) => ({
  path: resolve(publicDataDir, entry.relativePath),
  contents: entry.contents,
  validate: entry.validate,
}))

if (publicWrites.length > 0) await rm(publicDataDir, { recursive: true, force: true })
try {
  for (const write of publicWrites) {
    write.validate(JSON.parse(write.contents))
  }
  for (const write of publicWrites) {
    await atomicWriteFile(write.path, write.contents)
  }

  if (publicWrites.length > 0) {
    await replaceDirectory(publicDataDir, publicDataTargetDir, {
      publishLast: PUBLIC_ARTIFACT_PATHS.manifest,
      preserveTarget: true,
      expectedFiles: publicPlan.writes.map((write) => write.relativePath),
    })
  }
  if (pendingPromotion) {
    const promoted = await promoteIncrementalState(pendingPromotion)
    receipt.bucket.bytesWritten = promoted.reducerStateBytesWritten
  }
  if (durableStore && pendingPromotion === undefined && incrementalOutcomeEligible && !semanticNoChange) {
    throw new Error('Eligible incremental state was not promoted locally')
  }
  if (durableStore && incrementalOutcomeEligible && !semanticNoChange && await isDirectory(privateStateDir)) {
    if (!incrementalTemporalContext) throw new Error('Eligible incremental output is missing its semantic input context')
    const validatedState = await validateIncrementalStateTree(privateStateDir, durableIdentity.compatibilityHash)
    const staticPlayerRoot = stableHash(staticPlayerRosters)
    const semanticInput = createIncrementalSemanticInputRoot({
      providerRoot: validatedState.providerRoot,
      canonicalRoot: validatedState.canonicalRoot,
      contextRoot: validatedState.contextRoot,
      staticPlayerRoot,
      temporalContext: incrementalTemporalContext,
    })
    const stateSummary = {
      ...validatedState,
      staticPlayerRoot,
      ...semanticInput,
    }
    const candidateParity = {
      ...(durableParity ?? { kind: 'not-run' }),
      ...(durableBootstrapEligible ? { bootstrapReason: durableRolloutReason } : {}),
    }
    const candidate = await stageDurableGeneration({
      store: durableStore,
      stateDir: privateStateDir,
      identity: durableIdentity,
      generatedAt: runMetadata.generatedAt,
      outcome: durableBootstrapEligible ? `shadow-bootstrap-match:${durableRolloutReason}` : orchestration.executedMode === 'incremental' ? 'incremental-success' : 'shadow-match',
      stateSummary,
      reachablePaths: stateSummary.reachablePaths,
      parity: candidateParity,
      retention: {
        date: runMetadata.generatedAt.slice(0, 10),
        boundaries: durableRetentionBoundaries(snapshot, stateSummary.retentionBoundaries, previousDurableRetentionBoundaries),
      },
    })
    recordDurableCandidateMetrics(receipt, candidate)
    receipt.durable.promotion = 'staged'
    if (durableCandidateOutput) await atomicWriteFile(resolve(durableCandidateOutput), `${JSON.stringify(durableCandidateReceipt(candidate, candidateParity), null, 2)}\n`)
  } else if (durableCandidateOutput) {
    const eligibility = semanticNoChange ? 'no-change' : 'ineligible'
    const outcome = semanticNoChange
      ? 'semantic-no-change'
      : requestedMode === 'full' ? 'full-requested'
        : durableRestoreFailed ? 'restore-fallback'
          : durableParity?.result === 'mismatch' ? 'parity-mismatch'
            : dagFallback ? 'artifact-dag-fallback'
              : orchestration.fallback ? 'incremental-fallback'
                : 'incremental-output-unavailable'
    await atomicWriteFile(resolve(durableCandidateOutput), `${JSON.stringify({
      schemaVersion: 1,
      runId: runMetadata.runId,
      eligibility,
      outcome,
      identity: durableIdentity,
      identityHash: stableHash(durableIdentity),
      stateRoot: stateTransition?.next.stateRoot,
      parity: durableParity ?? { kind: 'not-run' },
      metrics: { uploadedObjects: 0, uploadedBytes: 0, skippedObjects: 0, skippedBytes: 0 },
    }, null, 2)}\n`)
  }
  receipt.durable.reusedUnits = sumInstrumented([
    receipt.observations.reused,
    receipt.snapshotInputs.rankingResultCacheHits,
    receipt.snapshotInputs.playerResultCacheHits,
    receipt.artifacts.reused,
  ])
  receipt.durable.replayedUnits = sumInstrumented([
    receipt.snapshotInputs.rankingRows,
    receipt.snapshotInputs.playerRows,
  ])
  const publicDataBytes = await directorySize(publicDataTargetDir)
  if (receiptOutput) {
    await mkdir(dirname(receiptOutput), { recursive: true })
    await writeFile(receiptOutput, `${JSON.stringify(receipt, null, 2)}\n`)
  }

  console.log(`Wrote ${Object.keys(snapshot.snapshots).length} ranking snapshots to ${output}`)
  console.log(`Wrote browser summary to ${summaryOutput}`)
  console.log(`Wrote ${summarySnapshots.length} public ranking scopes to ${resolve(publicDataTargetDir, PUBLIC_ARTIFACT_PATHS.scopeDir)}`)
  console.log(`Public data budget: ${publicDataBytes} bytes`)
} catch (error) {
  if (publicWrites.length > 0) await rm(publicDataDir, { recursive: true, force: true })
  throw error
}
} finally {
  cleanupStagedShadowModelState(stagedShadowModelState)
}

type SourceMetrics = {
  filesScanned: number
  bytesScanned: number
  rowsParsed: number | null
  observationsNormalized: number | null
  observationsReused: number | null
  reducerStateBytesRead: number
  reducerStateBytesWritten: number
}

async function finalizeEarlyNoChange(
  result: Awaited<ReturnType<typeof loadIncrementalCommunityImports>> & { imports: IncrementalCommunityImports; promotion: IncrementalStatePromotion },
  inputRoot: string,
  staticPlayerRoot: string,
) {
  receipt.requestedMode = requestedMode
  receipt.executedMode = 'incremental'
  receipt.sources = { filesScanned: result.metrics.filesScanned, bytesScanned: result.metrics.bytesScanned }
  receipt.observations = {
    parsed: result.metrics.rowsParsed,
    normalized: result.metrics.observationsNormalized,
    reused: result.metrics.observationsReused,
  }
  receipt.reducers = { livePlayerEdgeRows: 0, teamRows: 0, playerRows: 0 }
  receipt.snapshotInputs = {
    rankingRequests: 0,
    rankingResultCacheHits: 0,
    rankingReducerRuns: 0,
    rankingRows: 0,
    playerRequests: 0,
    playerResultCacheHits: 0,
    playerReducerRuns: 0,
    playerRows: 0,
    directRankingBuilds: 0,
    directPlayerBuilds: 0,
  }
  receipt.artifacts = { reused: 0, regenerated: 0 }
  receipt.bucket.bytesRead = result.metrics.reducerStateBytesRead
  receipt.bucket.bytesWritten = 0
  receipt.durable.reusedUnits = result.metrics.observationsReused
  receipt.durable.replayedUnits = 0
  receipt.durable.promotion = 'no-change'
  receipt.attempts.push({
    engine: 'incremental',
    outcome: 'succeeded',
    durationMs: 0,
    sources: {
      filesScanned: result.metrics.filesScanned,
      bytesScanned: result.metrics.bytesScanned,
      rowsParsed: result.metrics.rowsParsed,
      observationsNormalized: result.metrics.observationsNormalized,
      observationsReused: result.metrics.observationsReused,
      reducerStateBytesRead: result.metrics.reducerStateBytesRead,
      reducerStateBytesWritten: 0,
    },
  })
  if (reconciliationOutput) {
    await mkdir(dirname(reconciliationOutput), { recursive: true })
    await writeFile(reconciliationOutput, `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: runMetadata.generatedAt,
      matches: reconciliationEntries(result.imports.canonical.importedMatches),
    }, null, 2)}\n`)
  }
  if (durableCandidateOutput) {
    await atomicWriteFile(resolve(durableCandidateOutput), `${JSON.stringify({
      schemaVersion: 1,
      runId: runMetadata.runId,
      eligibility: 'no-change',
      outcome: 'semantic-input-no-change',
      identity: durableIdentity,
      identityHash: stableHash(durableIdentity),
      stateRoot: previousDurableSemanticState!.stateRoot,
      inputRoot,
      staticPlayerRoot,
      parity: { kind: 'not-run' },
      metrics: { uploadedObjects: 0, uploadedBytes: 0, skippedObjects: 0, skippedBytes: 0 },
    }, null, 2)}\n`)
  }
  recordCrunchTiming(receipt, 'crunch-total', crunchStartedAt, performance.now())
  if (receiptOutput) {
    await mkdir(dirname(receiptOutput), { recursive: true })
    await writeFile(receiptOutput, `${JSON.stringify(receipt, null, 2)}\n`)
  }
  console.log('Canonical/context inputs unchanged; reused active public and private ranking authority.')
}

function assertLateIncrementalWorkAllowed(phase: string) {
  if (process.env.RANKING_TEST_FORBID_LATE_INCREMENTAL_WORK === 'true') {
    throw new Error(`Late incremental work invoked after no-change eligibility: ${phase}`)
  }
}

type CommunityImports = {
  oracleImports: OracleImportResult[]
  leaguepediaImports: LeaguepediaImportResult[]
  lolEsportsImports: LolEsportsReferenceImportResult[]
  metrics: SourceMetrics
  canonical?: CanonicalRankingInput
}

type CrunchOutput = {
  snapshot: ReturnType<typeof createStaticRankingData>
  importedMatches: ReturnType<typeof mergeCommunityMatchSources>
  metrics: SourceMetrics
  reducerRows?: ReducerRows
  selectedCheckpointDate?: string
  selectedPlayerCheckpointDate?: string
  snapshotInputMetrics?: SnapshotInputMetrics
  snapshotModelState?: PersistedSnapshotModelState
  snapshotModelStateFactory?: () => PersistedSnapshotModelState
}

type PreparedCrunchOutput = Omit<CrunchOutput, 'snapshot' | 'importedMatches' | 'snapshotModelStateFactory'> & {
  fullSnapshotHash: string
  publicPlan: ReturnType<typeof createPublicArtifactWritePlan>
  semanticPlan: ReturnType<typeof createSemanticPublicArtifactWritePlan>
  snapshotModelStateStage?: StagedShadowModelState
}

function compactStagedPromotion(promotion: IncrementalStatePromotion, stateDir: string): IncrementalStatePromotion {
  const decodedPointer = decodePrivateState(promotion.pointerWrite.contents)
  if (typeof decodedPointer !== 'object' || decodedPointer === null || !('generationHash' in decodedPointer)
    || typeof decodedPointer.generationHash !== 'string') throw new Error('Pending incremental generation pointer is invalid')
  const pointer = decodedPointer
  const generationPath = resolve(stateDir, 'generations', `${pointer.generationHash}.json`)
  const generationWrite = promotion.stagedWrites.find((write) => write.path === generationPath)
  if (!generationWrite) throw new Error('Pending incremental generation is unavailable after staging')
  return { ...promotion, stagedWrites: [generationWrite] }
}


function prepareCrunchOutputForParity(output: CrunchOutput): PreparedCrunchOutput {
  const { fullSnapshotHash, publicPlan, semanticPlan } = (() => {
    const snapshot = output.snapshot
    return {
      fullSnapshotHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
      publicPlan: createPublicArtifactWritePlan(snapshot, { enforceBudgets: enforcePublicArtifactBudgets, runMetadata }),
      semanticPlan: createSemanticPublicArtifactWritePlan(snapshot, { enforceBudgets: enforcePublicArtifactBudgets }),
    }
  })()
  const snapshotModelStateStage = output.snapshotModelStateFactory
    ? stageShadowModelState(privateStateDir, output.snapshotModelStateFactory())
    : undefined
  Reflect.deleteProperty(output, 'snapshot')
  Reflect.deleteProperty(output, 'importedMatches')
  Reflect.deleteProperty(output, 'snapshotModelStateFactory')
  const metadata = output as Omit<CrunchOutput, 'snapshot' | 'importedMatches' | 'snapshotModelStateFactory'>
  return { ...metadata, fullSnapshotHash, publicPlan, semanticPlan, ...(snapshotModelStateStage ? { snapshotModelStateStage } : {}) }
}

type ReducerRows = {
  livePlayerEdgeRows: number
  teamRows: number
  playerRows: number
}

function emptySnapshotInputMetrics(): SnapshotInputMetrics {
  return {
    rankingRequests: 0,
    rankingResultCacheHits: 0,
    rankingReducerRuns: 0,
    rankingRows: 0,
    playerRequests: 0,
    playerResultCacheHits: 0,
    playerReducerRuns: 0,
    playerRows: 0,
    directRankingBuilds: 0,
    directPlayerBuilds: 0,
  }
}

async function incrementalGlobalModels(
  imports: IncrementalCommunityImports,
  rankingCheckpointHistory: IncrementalReducerCheckpoint[] = [],
  playerCheckpointHistory: IncrementalPlayerCheckpoint[] = [],
  checkpointLoader?: IncrementalCheckpointLoader,
) {
  const tournamentLifecycles = tournamentLifecyclesFor(imports)
  const dependencyPlan = buildReducerDependencyPlan({
    matches: imports.canonical.matches,
    teams: imports.canonical.teams,
    tournamentLifecycles,
  })
  const loadedRankingHistory = checkpointLoader
    ? await checkpointLoader.loadReducerCheckpoints(imports.canonical.matches, dependencyPlan)
    : rankingCheckpointHistory
  const ranking = incrementalGlobalRanking(imports, loadedRankingHistory, tournamentLifecycles)
  const sortedPlayerMatches = sortPlayerModelMatches(imports.canonical.matches, playerModelModeForMatches(imports.canonical.matches))
  const playerContext = {
    teams: imports.canonical.teams,
    leagueStrengths: ranking.ranking.leagues,
    eventWeightContext: eventWeightContextForMatches(sortedPlayerMatches),
  }
  const playerDependency = playerReducerDependencyHash({ matches: sortedPlayerMatches, rosters: {}, context: playerContext })
  const loadedPlayerHistory = checkpointLoader
    ? await checkpointLoader.loadPlayerCheckpoints(sortedPlayerMatches, playerDependency)
    : playerCheckpointHistory
  const players = runIncrementalPlayerReducer({
    matches: imports.canonical.matches,
    rosters: {},
    teams: imports.canonical.teams,
    leagueStrengths: ranking.ranking.leagues,
    checkpointHistory: loadedPlayerHistory,
  })
  return { ranking, players }
}

function incrementalGlobalRanking(
  imports: IncrementalCommunityImports,
  checkpointHistory: IncrementalReducerCheckpoint[] = [],
  tournamentLifecycles = tournamentLifecyclesFor(imports),
) {
  const canonical = imports.canonical
  return runIncrementalRankingReducers({
    matches: canonical.matches,
    teams: canonical.teams,
    tournamentLifecycles,
    checkpointHistory,
  })
}

function tournamentLifecyclesFor(imports: IncrementalCommunityImports) {
  return new Map(
    deriveTournamentInstances({
      matches: imports.canonical.matches,
      scheduleReferences: tournamentScheduleReferencesFor(imports.lolEsportsImports),
      generatedAt: runMetadata.generatedAt,
    }).map((instance) => [instance.id, {
      status: instance.status,
      boundaryDate: instance.boundaryDate,
      ratedThroughDate: instance.ratedThroughDate,
      dataLag: instance.dataLag,
      resultCoverageComplete: instance.resultCoverageComplete,
    }] as const),
  )
}

function tournamentScheduleReferencesFor(imports: LolEsportsReferenceImportResult[]) {
  return imports.flatMap((result) => {
    const coverage = dateRange(result.events)
    return result.events.map((event) => ({
      matchId: event.matchId,
      tournamentId: event.tournamentId,
      leagueName: event.leagueName,
      leagueSlug: event.leagueSlug,
      startTime: event.startTime,
      date: event.date,
      state: event.state,
      retrievedAt: result.source.retrievedAt,
      coverageStart: coverage.start,
      coverageEnd: coverage.end,
      coverageEndComplete: result.source.coverageEndComplete,
    }))
  })
}

function rankingTemporalContext(imports: IncrementalCommunityImports) {
  return deriveRankingTemporalContext({
    matches: imports.canonical.matches,
    scheduleReferences: tournamentScheduleReferencesFor(imports.lolEsportsImports),
    generatedAt: runMetadata.generatedAt,
    calendarHash: stableHash(regionalSplitCalendars),
    modelVersion: transparentGprModelMetadata.version,
    modelConfigHash: transparentGprModelMetadata.configHash,
  })
}

async function loadFullCommunityImports(): Promise<CommunityImports> {
  const oracleImports: OracleImportResult[] = []
  const leaguepediaImports: LeaguepediaImportResult[] = []
  const lolEsportsImports: LolEsportsReferenceImportResult[] = []
  let bytesScanned = 0
  let rowsParsed = 0
  let observationsNormalized = 0
  for (const [index, csvPath] of oracleCsvPaths.entries()) {
    const csvText = await readFile(csvPath, 'utf8')
    assertTrustedSource(providerSourceIds['oracles-elixir'][index], csvText, trustedProviderSources['oracles-elixir'])
    bytesScanned += Buffer.byteLength(csvText)
    const records = parseOraclesElixirCsvRecords(csvText)
    rowsParsed += records.length
    const imported = importOraclesElixirRecords(records, {
      sourceFileName: providerSourceIds['oracles-elixir'][index] ?? basename(csvPath),
      retrievedAt: manifest?.generatedAt ?? runMetadata.generatedAt,
    })
    observationsNormalized += imported.matches.length
    oracleImports.push(imported)
  }
  for (const [index, jsonPath] of leaguepediaJsonPaths.entries()) {
    const jsonText = await readFile(jsonPath, 'utf8')
    bytesScanned += Buffer.byteLength(jsonText)
    const parsed = JSON.parse(jsonText) as LeaguepediaSnapshot
    rowsParsed += parsed.matches?.length ?? 0
    const imported = importLeaguepediaSnapshot(parsed, { sourceFileName: providerSourceIds['leaguepedia-cargo'][index] ?? basename(jsonPath) })
    observationsNormalized += imported.matches.length
    leaguepediaImports.push(imported)
  }
  for (const [index, jsonPath] of lolEsportsJsonPaths.entries()) {
    const jsonText = await readFile(jsonPath, 'utf8')
    bytesScanned += Buffer.byteLength(jsonText)
    const imported = importLolEsportsScheduleSnapshot(JSON.parse(jsonText), { sourceFileName: providerSourceIds['lol-esports-api'][index] ?? basename(jsonPath) })
    rowsParsed += imported.events.length
    observationsNormalized += imported.events.length
    lolEsportsImports.push(imported)
  }
  return {
    oracleImports,
    leaguepediaImports,
    lolEsportsImports,
    metrics: {
      filesScanned: oracleCsvPaths.length + leaguepediaJsonPaths.length + lolEsportsJsonPaths.length,
      bytesScanned,
      rowsParsed,
      observationsNormalized,
      observationsReused: 0,
      reducerStateBytesRead: 0,
      reducerStateBytesWritten: 0,
    },
  }
}

function assertTrustedSource(
  sourceId: string | undefined,
  contents: string,
  trustedSources: Record<string, { digest: string; bytes: number }>,
) {
  if (!sourceId) return
  const trusted = trustedSources[sourceId]
  if (!trusted) return
  const bytes = Buffer.byteLength(contents)
  const digest = createHash('sha256').update(contents).digest('hex')
  if (bytes !== trusted.bytes || digest !== trusted.digest) throw new Error(`Trusted provider chunk mismatch for ${sourceId}`)
}

function readArg(name: string) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function readArgList(name: string) {
  const values: string[] = []
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== `--${name}`) continue
    const next = process.argv[index + 1]
    if (!next || next.startsWith('--')) continue
    values.push(...next.split(',').map((value) => value.trim()).filter(Boolean))
  }
  return values
}

function logicalSourceIds(paths: string[], manifestFile: string | undefined, flag: string, explicit: string[]) {
  if (explicit.length > 0) {
    if (explicit.length !== paths.length) throw new Error(`--${flag} count must match source path count`)
    return explicit
  }
  const manifestRoot = manifestFile ? dirname(manifestFile) : undefined
  return paths.map((path) => {
    if (manifestRoot) {
      const candidate = relative(manifestRoot, path)
      if (candidate && candidate !== '..' && !candidate.startsWith(`..${sep}`)) return candidate.replaceAll(sep, '/')
    }
    return basename(path)
  })
}

function normalizedChunksFor(
  value: LocalDataManifest | undefined,
  manifestFile: string | undefined,
  provider: NormalizedProviderChunk['provider'],
) {
  const descriptor = value?.normalizedProviderChunks
  if (!descriptor) return []
  if (descriptor.schemaVersion !== 1 || !Array.isArray(descriptor.chunks) || !manifestFile) {
    throw new Error('Invalid normalized provider chunk descriptor')
  }
  const root = dirname(manifestFile)
  const chunks = descriptor.chunks.filter((chunk) => chunk.provider === provider).map((chunk) => {
    if (!chunk.logicalId || chunk.logicalId.startsWith('/') || chunk.logicalId.split('/').includes('..')
      || !/^[a-f0-9]{64}$/.test(chunk.digest) || !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0
      || !Number.isSafeInteger(chunk.rows) || chunk.rows < 0 || chunk.start > chunk.end) {
      throw new Error(`Invalid normalized provider chunk: ${chunk.logicalId || '<missing>'}`)
    }
    return { ...chunk, path: resolve(root, chunk.logicalId) }
  })
  if (new Set(chunks.map((chunk) => chunk.logicalId)).size !== chunks.length) {
    throw new Error(`Duplicate normalized ${provider} logical chunk path`)
  }
  if (provider === 'oracles-elixir') {
    const declared = (value?.files.normalizedOracleCsv ?? []).map((path) => resolve(path)).toSorted()
    const described = chunks.map((chunk) => chunk.path).toSorted()
    if (stableHash(declared) !== stableHash(described)) throw new Error('Normalized Oracle chunk files do not match their descriptor')
  }
  return chunks
}

function uniquePaths(paths: string[]) {
  return Array.from(new Set(paths.filter(Boolean).map((path) => resolve(path))))
}

function reconciliationEntries(importedMatches: CrunchOutput['importedMatches']) {
  return resolveCanonicalSeries(importedMatches).flatMap((series) => {
    const officialIds = [...new Set(series.games.map((game) => game.officialMatchId).filter((value): value is string => Boolean(value)))]
    if (officialIds.length !== 1) return []
    return [{
      matchId: officialIds[0],
      status: series.state === 'completed' ? 'exact' : 'unresolved',
      canonicalSeriesId: series.id,
      scoredGameIds: series.games.map((game) => game.officialGameId ?? game.sourceGameId ?? game.id),
    }]
  })
}

type LocalDataManifest = {
  start?: string
  end?: string
  generatedAt?: string
  files: {
    oracleCsv?: string[]
    normalizedOracleCsv?: string[]
    leaguepediaJson?: string[]
    lolEsportsJson?: string[]
  }
  normalizedProviderChunks?: {
    schemaVersion: 1
    generatedAt: string
    chunks: NormalizedProviderChunk[]
  }
  warnings?: string[]
  sources?: Partial<Record<'oracle' | 'leaguepedia' | 'lolesports', {
    status?: string
    downloadedCount?: number
    reusedCount?: number
    failedCount?: number
  }>>
}

type NormalizedProviderChunk = {
  provider: 'oracles-elixir' | 'leaguepedia-cargo' | 'lol-esports-api'
  logicalId: string
  path: string
  digest: string
  bytes: number
  start: string
  end: string
  rows: number
}

function sourceRefreshReceipt(provider: 'oracle' | 'leaguepedia' | 'lolesports', value: LocalDataManifest | undefined) {
  const source = value?.sources?.[provider]
  if (!source?.status) return undefined
  return {
    requestedStart: value?.start,
    requestedEnd: value?.end,
    attemptedAt: value?.generatedAt,
    status: source.status,
    downloadedCount: source.downloadedCount ?? 0,
    reusedCount: source.reusedCount ?? 0,
    failedCount: source.failedCount ?? 0,
  }
}

function providerAuthorities(value: LocalDataManifest | undefined): ProviderAuthorities {
  const authorityFor = (provider: 'oracle' | 'leaguepedia' | 'lolesports') => {
    const source = value?.sources?.[provider]
    const warnings = value?.warnings ?? []
    const providerWarnings = warnings.filter((warning) => warningMatchesProvider(provider, warning))
    const authoritative = source?.status === 'downloaded'
      && (source.failedCount ?? 0) === 0
      && providerWarnings.every((warning) => !/preserv|partial|rate-limit|unavailable|failed/i.test(warning))
    return {
      receiptId: `${value?.generatedAt ?? 'no-manifest'}:${provider}:${source?.status ?? 'unknown'}`,
      fileSetAuthoritative: authoritative,
      contentReplacementAuthoritative: authoritative,
    }
  }
  return {
    'oracles-elixir': authorityFor('oracle'),
    'leaguepedia-cargo': authorityFor('leaguepedia'),
    'lol-esports-api': authorityFor('lolesports'),
  }
}

function manifestSourceWarnings(provider: 'oracle' | 'leaguepedia' | 'lolesports', warnings: string[] | undefined): DataSourceWarning[] {
  return (warnings ?? [])
    .filter((warning) => warningMatchesProvider(provider, warning))
    .map((message) => ({
      kind: sourceWarningKind(message),
      severity: sourceWarningSeverity(message),
      message,
    }))
}

function warningMatchesProvider(provider: 'oracle' | 'leaguepedia' | 'lolesports', warning: string) {
  const lower = warning.toLowerCase()
  if (provider === 'oracle') return lower.includes('oracle')
  if (provider === 'lolesports') return lower.includes('lol esports') || lower.includes('lolesports')
  return lower.includes('leaguepedia') || lower.includes('cargo')
}

function sourceWarningKind(message: string): DataSourceWarning['kind'] {
  const lower = message.toLowerCase()
  if (lower.includes('rate-limit')) return 'rate-limit'
  if (lower.includes('download')) return 'download'
  if (lower.includes('coverage') || lower.includes('through') || lower.includes('preserved')) return 'coverage'
  return 'source-policy'
}

function sourceWarningSeverity(message: string): DataSourceWarning['severity'] {
  const lower = message.toLowerCase()
  if (lower.includes('failed') || lower.includes('unavailable')) return 'error'
  if (lower.includes('rate-limit') || lower.includes('preserved')) return 'warning'
  return 'info'
}

function describeCommunitySource(oracleCount: number, leaguepediaCount: number) {
  if (oracleCount > 0 && leaguepediaCount > 0) return "Oracle's Elixir primary with Leaguepedia Cargo gap-fill"
  if (oracleCount > 0) return "Oracle's Elixir CSV import"
  return 'Leaguepedia Cargo import'
}

function dateRange(matches: { date?: string }[]) {
  const dates = matches.map((match) => match.date).filter(Boolean).sort()
  return {
    start: dates[0],
    end: dates.at(-1),
  }
}

async function directorySize(dir: string): Promise<number> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let total = 0
  for (const entry of entries) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      total += await directorySize(path)
    } else if (entry.isFile()) {
      total += (await stat(path)).size
    }
  }
  return total
}

async function isRegularFile(path: string) {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function isDirectory(path: string) {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function loadStaticPlayerRosters(path: string | undefined): Promise<Record<string, PlayerProfile[]>> {
  if (!path) return {}
  const value: unknown = JSON.parse(await readFile(resolve(path), 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Static player roster input must be a team-keyed object')
  for (const [team, players] of Object.entries(value)) {
    if (!team || !Array.isArray(players)) throw new Error('Static player roster input contains an invalid team entry')
  }
  return value as Record<string, PlayerProfile[]>
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function sumInstrumented(values: Array<number | null>) {
  const measured = values.filter((value): value is number => value !== null)
  return measured.length > 0 ? measured.reduce((sum, value) => sum + value, 0) : null
}

function positiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function durableFallback(value: unknown): NonNullable<IncrementalCrunchReceipt['durable']['fallback']> {
  const fallback = recordValue(value)
  const detail = typeof fallback.detail === 'string' ? fallback.detail : 'durable-state-unavailable'
  if (fallback.kind === 'compatibility-hash-mismatch') {
    return { kind: 'compatibility-hash-mismatch', dependency: detail, expected: durableIdentity.compatibilityHash }
  }
  if (fallback.kind === 'checkpoint-corrupt') return { kind: 'checkpoint-corrupt', detail }
  return { kind: 'checkpoint-unavailable', detail }
}

function recordDurableCandidateMetrics(target: IncrementalCrunchReceipt, candidate: DurableCandidate) {
  target.durable.uploadedObjects = candidate.metrics.uploadedObjects
  target.durable.uploadedBytes = candidate.metrics.uploadedBytes
  target.durable.skippedObjects = candidate.metrics.skippedObjects
  target.durable.skippedBytes = candidate.metrics.skippedBytes
}

function durableCandidateReceipt(candidate: DurableCandidate, parity: Record<string, unknown> | undefined) {
  return {
    schemaVersion: 1,
    runId: runMetadata.runId,
    eligibility: candidate.eligibility,
    outcome: candidate.outcome,
    manifestKey: candidate.manifestKey,
    manifestDigest: candidate.manifestDigest,
    manifestBytes: candidate.manifestBytes,
    stateRoot: candidate.stateRoot,
    identityHash: candidate.identityHash,
    retention: candidate.manifest.retention,
    identity: durableIdentity,
    metrics: candidate.metrics,
    parity: parity ?? { kind: 'not-run' },
  }
}

function durableRetentionBoundaries(
  data: CrunchOutput['snapshot'],
  retention: Array<{ processedDate?: string; classes: string[] }> = [],
  previous: Array<{ processedDate?: string; classes: string[] }> = [],
) {
  const boundaries = new Set<string>()
  const date = runMetadata.generatedAt.slice(0, 10)
  const tomorrow = new Date(`${date}T00:00:00.000Z`)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  if (tomorrow.getUTCMonth() !== new Date(`${date}T00:00:00.000Z`).getUTCMonth()) boundaries.add('month-end')
  if (Object.values(data.tournamentMovements).some((entry) => entry.status === 'completed' && entry.boundaryDate === date)) boundaries.add('international-event')
  if (Object.values(data.filterOptions.checkpoints ?? {}).flat().some((checkpoint) => checkpoint.endDate === date)) boundaries.add('season-split')
  const previousKeys = new Set(previous.map(retentionBoundaryKey))
  const newClasses = retention.filter((entry) => !previousKeys.has(retentionBoundaryKey(entry))).flatMap((entry) => entry.classes)
  if (newClasses.includes('monthly')) boundaries.add('month-end')
  if (newClasses.includes('season-boundary')) boundaries.add('season-split')
  if (newClasses.includes('international-boundary')) boundaries.add('international-event')
  return [...boundaries].sort()
}

function retentionBoundaryValues(value: unknown): Array<{ processedDate?: string; classes: string[] }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const record = recordValue(entry)
    if (!Array.isArray(record.classes) || record.classes.some((item) => typeof item !== 'string')) return []
    return [{ ...(typeof record.processedDate === 'string' ? { processedDate: record.processedDate } : {}), classes: record.classes }]
  })
}

function retentionBoundaryKey(value: { processedDate?: string; classes: string[] }) {
  return `${value.processedDate ?? ''}:${[...value.classes].sort().join(',')}`
}

async function sendDurableAlert(kind: string, message: string) {
  const url = process.env.RANKING_ALERT_WEBHOOK_URL
  if (!url) {
    console.warn(`Alert ${kind}: ${message}`)
    return
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, message, service: 'lol-esports-ranking', at: runMetadata.generatedAt }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) console.error(`Alert webhook failed with ${response.status}`)
  } catch (error) {
    console.error(`Alert webhook failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function atomicWriteFile(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, contents)
  await rename(tempPath, path)
}

async function writeJsonFile(path: string, value: unknown) {
  const stream = createWriteStream(path, { encoding: 'utf8' })

  async function writeChunk(chunk: string) {
    if (!stream.write(chunk)) await once(stream, 'drain')
  }

  try {
    await writeJsonValue(writeChunk, value, 0, false)
    await writeChunk('\n')
    stream.end()
    await once(stream, 'finish')
  } catch (error) {
    stream.destroy()
    throw error
  }
}

async function writeJsonValue(
  writeChunk: (chunk: string) => Promise<void>,
  value: unknown,
  depth: number,
  inArray: boolean,
) {
  if (typeof value === 'object' && value !== null && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    value = (value as { toJSON: () => unknown }).toJSON()
  }

  if (value === null || typeof value !== 'object') {
    await writeChunk(JSON.stringify(value) ?? (inArray ? 'null' : 'null'))
    return
  }

  if (Array.isArray(value)) {
    await writeChunk('[')
    for (let index = 0; index < value.length; index += 1) {
      await writeChunk(`${index === 0 ? '\n' : ',\n'}${indent(depth + 1)}`)
      await writeJsonValue(writeChunk, value[index] ?? null, depth + 1, true)
    }
    if (value.length > 0) await writeChunk(`\n${indent(depth)}`)
    await writeChunk(']')
    return
  }

  const entries = Object.entries(value).filter(([, entryValue]) => {
    return entryValue !== undefined && typeof entryValue !== 'function' && typeof entryValue !== 'symbol'
  })
  await writeChunk('{')
  for (let index = 0; index < entries.length; index += 1) {
    const [key, entryValue] = entries[index]
    await writeChunk(`${index === 0 ? '\n' : ',\n'}${indent(depth + 1)}${JSON.stringify(key)}: `)
    await writeJsonValue(writeChunk, entryValue, depth + 1, false)
  }
  if (entries.length > 0) await writeChunk(`\n${indent(depth)}`)
  await writeChunk('}')
}

function indent(depth: number) {
  return '  '.repeat(depth)
}
