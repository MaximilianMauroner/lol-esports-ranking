import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { manifestWithResolvedFiles } from './local-data-manifest.js'
import { replaceDirectory } from './replace-directory.ts'
import {
  attachIncrementalPlayerCheckpoints,
  attachIncrementalReducerCheckpoint,
  loadIncrementalCommunityImports,
  promoteIncrementalState,
  type IncrementalCommunityImports,
  type IncrementalStatePromotion,
  type ProviderAuthorities,
} from './incremental-provider-state.ts'
import { knownTeamIdentities } from '../src/data/teamIdentity'
import { mergeCommunityMatchSources } from '../src/lib/importers/communitySources'
import { importLeaguepediaSnapshot, type LeaguepediaImportResult } from '../src/lib/importers/leaguepedia'
import { importLolEsportsScheduleSnapshot, type LolEsportsReferenceImportResult } from '../src/lib/importers/lolEsports'
import { importOraclesElixirCsv, type OracleImportResult } from '../src/lib/importers/oraclesElixir'
import { createStaticRankingData, type DataSourceWarning } from '../src/lib/snapshot'
import { createPublicArtifactWritePlan, PUBLIC_ARTIFACT_PATHS } from '../src/lib/publicArtifacts/writePlan'
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
} from '../src/lib/incremental/metrics'
import { crunchModeFrom, orchestrateCrunch } from '../src/lib/incremental/orchestrator'
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
import type { PlayerStanding } from '../src/types.ts'
import { deriveTournamentInstances } from '../src/lib/internationalTournaments.ts'
import { runIncrementalRankingReducers } from '../src/lib/incremental/rankingReducer.ts'
import type { IncrementalReducerCheckpoint } from '../src/lib/incremental/reducerCheckpoint.ts'
import { runIncrementalPlayerReducer } from '../src/lib/incremental/playerReducer.ts'
import type { IncrementalPlayerCheckpoint } from '../src/lib/incremental/playerReducer.ts'

const output = resolve(readArg('output') ?? 'data/derived/ranking-snapshot.full.json')
const publicDataTargetDir = resolve(readArg('public-data-dir') ?? 'public/data')
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
const mode = process.argv.includes('--full')
  ? 'full'
  : crunchModeFrom(readArg('mode') ?? process.env.RANKING_CRUNCH_MODE)
const receipt = createIncrementalCrunchReceipt({ run: runMetadata, requestedMode: mode })
const privateStateDir = resolve(incrementalStateDirectory(readArg('incremental-state-dir') ?? process.env.RANKING_INCREMENTAL_STATE_DIR))
const manifestPath = readArg('manifest')
const resolvedManifestPath = manifestPath ? resolve(manifestPath) : undefined
const manifest = resolvedManifestPath
  ? manifestWithResolvedFiles(JSON.parse(await readFile(resolvedManifestPath, 'utf8')) as LocalDataManifest, dirname(resolvedManifestPath)) as LocalDataManifest
  : undefined
const oracleCsvPaths = uniquePaths([...readArgList('oracle-csv'), ...(manifest?.files.oracleCsv ?? [])])
const leaguepediaJsonPaths = uniquePaths([...readArgList('leaguepedia-json'), ...(manifest?.files.leaguepediaJson ?? [])])
const lolEsportsJsonPaths = uniquePaths([...readArgList('lolesports-json'), ...(manifest?.files.lolEsportsJson ?? [])])
const oracleWarnings = manifestSourceWarnings('oracle', manifest?.warnings)
const leaguepediaWarnings = manifestSourceWarnings('leaguepedia', manifest?.warnings)
const lolEsportsWarnings = manifestSourceWarnings('lolesports', manifest?.warnings)
const authorities = providerAuthorities(manifest)
const codeProvenanceHash = await canonicalCodeProvenanceHash()
const compatibility = createCrunchCompatibility({
  pipelineVersion: 'incremental-canonical-v2',
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

if (process.argv.includes('--seeded-sample')) {
  throw new Error('Seeded sample generation has been removed from the production build path. Provide public source files or use tests/fixtures/rankingFixtures.ts for unit fixtures.')
}

function buildCrunchOutput({
  oracleImports,
  leaguepediaImports,
  lolEsportsImports,
  metrics,
  canonical,
}: CommunityImports, precomputedGlobalRanking?: RankingModelResult, precomputedGlobalPlayers?: PlayerStanding[], reducerRows?: ReducerRows, selectedCheckpointDate?: string, selectedPlayerCheckpointDate?: string): CrunchOutput {
const directImportedMatches = canonical ? undefined : mergeCommunityMatchSources({
  oracleMatches: oracleImports.flatMap((result) => result.matches),
  leaguepediaMatches: leaguepediaImports.flatMap((result) => result.matches),
  lolEsportsReferences: lolEsportsImports.flatMap((result) => result.events),
})
const importedMatches = canonical?.importedMatches ?? directImportedMatches ?? []
const importedTeams = mergeTeamProfiles([...leaguepediaImports.map((result) => result.teams), ...oracleImports.map((result) => result.teams)])
const mergedTeams = canonical?.teams ?? (importedMatches.length > 0 ? { ...deriveTeamProfilesFromMatches(importedMatches, importedTeams), ...knownTeamIdentities } : {})
const ratingUniverse = canonical ?? filterPublishedRatingUniverseInput(importedMatches, mergedTeams)
const matches = ratingUniverse.matches
const teams = ratingUniverse.teams
const snapshot = createStaticRankingData({
  matches,
  teams,
  rosters: {},
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
  precomputedGlobalPlayers,
})
  return {
    snapshot,
    importedMatches,
    metrics,
    ...(reducerRows ? { reducerRows } : {}),
    ...(selectedCheckpointDate ? { selectedCheckpointDate } : {}),
    ...(selectedPlayerCheckpointDate ? { selectedPlayerCheckpointDate } : {}),
  }
}

const crunchStartedAt = performance.now()
const runFull = async () => buildCrunchOutput(await loadFullCommunityImports())
let pendingPromotion: IncrementalStatePromotion | undefined
let incrementalAttemptMetrics: SourceMetrics | undefined
const runIncremental = async () => {
  const result = await loadIncrementalCommunityImports({
    stateDir: privateStateDir,
    oracleCsvPaths,
    leaguepediaJsonPaths,
    lolEsportsJsonPaths,
    oracleRetrievedAt: manifest?.generatedAt ?? runMetadata.generatedAt,
    now: runMetadata.generatedAt,
    authorities,
    compatibility,
  })
  incrementalAttemptMetrics = result.metrics
  const modelRun = result.imports
    ? incrementalGlobalModels(result.imports, result.reducerCheckpoints, result.playerCheckpoints)
    : undefined
  if (result.promotion && modelRun) {
    const rankingPromotion = attachIncrementalReducerCheckpoint(result.promotion, privateStateDir, modelRun.ranking.checkpoints)
    pendingPromotion = attachIncrementalPlayerCheckpoints(rankingPromotion, privateStateDir, modelRun.players.checkpoints)
    result.metrics.reducerStateBytesWritten = pendingPromotion.reducerStateBytesWritten
  } else {
    pendingPromotion = result.promotion
  }
  const incrementalOutput = result.imports && modelRun
    ? buildCrunchOutput(
        result.imports,
        modelRun.ranking.ranking,
        modelRun.players.players,
        { ...modelRun.ranking.rows, playerRows: modelRun.players.rows },
        modelRun.ranking.selectedCheckpointDate,
        modelRun.players.selectedCheckpointDate,
      )
    : undefined
  if (result.fallback) return {
    fallback: result.fallback,
    ...(incrementalOutput ? { output: incrementalOutput } : {}),
  }
  if (!result.imports) return { fallback: { kind: 'dependency-unknown' as const, dependency: 'provider-ledger-output' } }
  return { output: incrementalOutput! }
}
const orchestration = await orchestrateCrunch<CrunchOutput>({
  mode,
  receipt,
  runFull,
  runIncremental,
  requireReferenceParity: true,
})
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
const incrementalCandidate = orchestration.executedMode === 'incremental'
  ? orchestration.output
  : orchestration.shadowOutput
if (incrementalCandidate?.reducerRows) {
  recordIncrementalReducerCandidate(receipt, {
    ...incrementalCandidate.reducerRows,
    selectedCheckpoint: incrementalCandidate.selectedCheckpointDate,
    selectedPlayerCheckpoint: incrementalCandidate.selectedPlayerCheckpointDate,
  })
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
const publicPlan = createPublicArtifactWritePlan(snapshot, { runMetadata })
if (orchestration.shadowOutput) {
  const shadowPlan = createPublicArtifactWritePlan(orchestration.shadowOutput.snapshot, { runMetadata })
  assertCrunchParity(
    { fullSnapshot: snapshot, publicWrites: publicPlan.writes },
    { fullSnapshot: orchestration.shadowOutput.snapshot, publicWrites: shadowPlan.writes },
  )
}
receipt.artifacts.reused = 0
receipt.artifacts.regenerated = publicPlan.writes.length + 1
const summaryOutput = resolve(publicDataTargetDir, PUBLIC_ARTIFACT_PATHS.manifest)
const summarySnapshots = Object.entries(publicPlan.snapshots)
const publicWrites = publicPlan.writes.map((entry) => ({
  path: resolve(publicDataDir, entry.relativePath),
  contents: entry.contents,
  validate: entry.validate,
}))

await rm(publicDataDir, { recursive: true, force: true })
try {
  for (const write of publicWrites) {
    write.validate(JSON.parse(write.contents))
  }
  for (const write of publicWrites) {
    await atomicWriteFile(write.path, write.contents)
  }

  await replaceDirectory(publicDataDir, publicDataTargetDir, {
    publishLast: PUBLIC_ARTIFACT_PATHS.manifest,
    preserveTarget: true,
  })
  if (pendingPromotion) {
    const promoted = await promoteIncrementalState(pendingPromotion)
    receipt.bucket.bytesWritten = promoted.reducerStateBytesWritten
  }
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
  await rm(publicDataDir, { recursive: true, force: true })
  throw error
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
}

type ReducerRows = {
  livePlayerEdgeRows: number
  teamRows: number
  playerRows: number
}

function incrementalGlobalModels(
  imports: IncrementalCommunityImports,
  rankingCheckpointHistory: IncrementalReducerCheckpoint[] = [],
  playerCheckpointHistory: IncrementalPlayerCheckpoint[] = [],
) {
  const ranking = incrementalGlobalRanking(imports, rankingCheckpointHistory)
  const players = runIncrementalPlayerReducer({
    matches: imports.canonical.matches,
    rosters: {},
    teams: imports.canonical.teams,
    leagueStrengths: ranking.ranking.leagues,
    checkpointHistory: playerCheckpointHistory,
  })
  return { ranking, players }
}

function incrementalGlobalRanking(
  imports: IncrementalCommunityImports,
  checkpointHistory: IncrementalReducerCheckpoint[] = [],
) {
  const canonical = imports.canonical
  const tournamentLifecycles = new Map(
    deriveTournamentInstances({
      matches: canonical.matches,
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
  return runIncrementalRankingReducers({
    matches: canonical.matches,
    teams: canonical.teams,
    tournamentLifecycles,
    checkpointHistory,
  })
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

async function loadFullCommunityImports(): Promise<CommunityImports> {
  const oracleImports: OracleImportResult[] = []
  const leaguepediaImports: LeaguepediaImportResult[] = []
  const lolEsportsImports: LolEsportsReferenceImportResult[] = []
  let bytesScanned = 0
  for (const csvPath of oracleCsvPaths) {
    const csvText = await readFile(csvPath, 'utf8')
    bytesScanned += Buffer.byteLength(csvText)
    oracleImports.push(importOraclesElixirCsv(csvText, {
      sourceFileName: basename(csvPath),
      retrievedAt: manifest?.generatedAt ?? runMetadata.generatedAt,
    }))
  }
  for (const jsonPath of leaguepediaJsonPaths) {
    const jsonText = await readFile(jsonPath, 'utf8')
    bytesScanned += Buffer.byteLength(jsonText)
    leaguepediaImports.push(importLeaguepediaSnapshot(JSON.parse(jsonText), { sourceFileName: basename(jsonPath) }))
  }
  for (const jsonPath of lolEsportsJsonPaths) {
    const jsonText = await readFile(jsonPath, 'utf8')
    bytesScanned += Buffer.byteLength(jsonText)
    lolEsportsImports.push(importLolEsportsScheduleSnapshot(JSON.parse(jsonText), { sourceFileName: basename(jsonPath) }))
  }
  return {
    oracleImports,
    leaguepediaImports,
    lolEsportsImports,
    metrics: {
      filesScanned: oracleCsvPaths.length + leaguepediaJsonPaths.length + lolEsportsJsonPaths.length,
      bytesScanned,
      rowsParsed: null,
      observationsNormalized: null,
      observationsReused: null,
      reducerStateBytesRead: 0,
      reducerStateBytesWritten: 0,
    },
  }
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
    leaguepediaJson?: string[]
    lolEsportsJson?: string[]
  }
  warnings?: string[]
  sources?: Partial<Record<'oracle' | 'leaguepedia' | 'lolesports', {
    status?: string
    downloadedCount?: number
    reusedCount?: number
    failedCount?: number
  }>>
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
  const entries = await readdir(dir, { withFileTypes: true })
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
