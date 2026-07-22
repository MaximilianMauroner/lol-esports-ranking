import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { knownTeamIdentities } from '../src/data/teamIdentity'
import { mergeCommunityMatchSources } from '../src/lib/importers/communitySources'
import { importLeaguepediaSnapshot } from '../src/lib/importers/leaguepedia'
import { importLolEsportsScheduleSnapshot } from '../src/lib/importers/lolEsports'
import { importOraclesElixirCsv } from '../src/lib/importers/oraclesElixir'
import { filterPublishedRatingUniverseInput, filterPublishedRatingUniverseMatches } from '../src/lib/ratingUniverse'
import { deriveTeamProfilesFromMatches, mergeTeamProfiles } from '../src/lib/teamProfiles'
import type { DataSourceInfo, DataSourceWarning } from '../src/lib/snapshot'
import type { MatchRecord, TeamProfile } from '../src/types'
import { manifestWithResolvedFiles } from './local-data-manifest.js'

export type LocalDataManifest = {
  schemaVersion?: number
  start?: string
  end?: string
  generatedAt?: string
  files: { oracleCsv?: string[]; leaguepediaJson?: string[]; lolEsportsJson?: string[] }
  warnings?: string[]
  sources?: Partial<Record<'oracle' | 'leaguepedia' | 'lolesports', {
    status?: string; downloadedCount?: number; reusedCount?: number; failedCount?: number
  }>>
}

export type RankingSourceImport = {
  manifest?: LocalDataManifest
  importedMatches: MatchRecord[]
  matches: MatchRecord[]
  teams: Record<string, TeamProfile>
  mergedTeams: Record<string, TeamProfile>
  source: string
  dataMode: 'scheduled-public-data' | 'no-data'
  externalSources: DataSourceInfo[]
  tournamentScheduleReferences: Array<{
    matchId: string; tournamentId?: string; leagueName?: string; leagueSlug?: string; startTime?: string
    date?: string; state?: string; retrievedAt?: string; coverageStart?: string; coverageEnd?: string; coverageEndComplete?: boolean
  }>
}

export async function importRankingSourceData({
  manifestPath,
  oracleCsvPaths = [],
  leaguepediaJsonPaths = [],
  lolEsportsJsonPaths = [],
}: {
  manifestPath?: string
  oracleCsvPaths?: string[]
  leaguepediaJsonPaths?: string[]
  lolEsportsJsonPaths?: string[]
}): Promise<RankingSourceImport> {
  const resolvedManifestPath = manifestPath ? resolve(manifestPath) : undefined
  const manifest = resolvedManifestPath
    ? manifestWithResolvedFiles(JSON.parse(await readFile(resolvedManifestPath, 'utf8')) as LocalDataManifest, dirname(resolvedManifestPath)) as LocalDataManifest
    : undefined
  const oraclePaths = uniquePaths([...oracleCsvPaths, ...(manifest?.files.oracleCsv ?? [])])
  const leaguepediaPaths = uniquePaths([...leaguepediaJsonPaths, ...(manifest?.files.leaguepediaJson ?? [])])
  const lolEsportsPaths = uniquePaths([...lolEsportsJsonPaths, ...(manifest?.files.lolEsportsJson ?? [])])
  const oracleImports = []
  const leaguepediaImports = []
  const lolEsportsImports = []
  for (const csvPath of oraclePaths) {
    oracleImports.push(importOraclesElixirCsv(await readFile(csvPath, 'utf8'), { sourceFileName: basename(csvPath) }))
  }
  for (const jsonPath of leaguepediaPaths) {
    leaguepediaImports.push(importLeaguepediaSnapshot(JSON.parse(await readFile(jsonPath, 'utf8')), { sourceFileName: basename(jsonPath) }))
  }
  for (const jsonPath of lolEsportsPaths) {
    lolEsportsImports.push(importLolEsportsScheduleSnapshot(JSON.parse(await readFile(jsonPath, 'utf8')), { sourceFileName: basename(jsonPath) }))
  }
  const importedMatches = mergeCommunityMatchSources({
    oracleMatches: oracleImports.flatMap((result) => result.matches),
    leaguepediaMatches: leaguepediaImports.flatMap((result) => result.matches),
    lolEsportsReferences: lolEsportsImports.flatMap((result) => result.events),
  })
  const importedTeams = mergeTeamProfiles([...leaguepediaImports.map((result) => result.teams), ...oracleImports.map((result) => result.teams)])
  const mergedTeams = importedMatches.length > 0
    ? { ...deriveTeamProfilesFromMatches(importedMatches, importedTeams), ...knownTeamIdentities }
    : {}
  const ratingUniverse = filterPublishedRatingUniverseInput(importedMatches, mergedTeams)
  const matches = ratingUniverse.matches
  const teams = ratingUniverse.teams
  const oracleWarnings = manifestSourceWarnings('oracle', manifest?.warnings)
  const leaguepediaWarnings = manifestSourceWarnings('leaguepedia', manifest?.warnings)
  const lolEsportsWarnings = manifestSourceWarnings('lolesports', manifest?.warnings)
  const externalSources: DataSourceInfo[] = [
    ...lolEsportsImports.map((result): DataSourceInfo => ({
      name: result.source.fileName ? `LoL Esports schedule API: ${result.source.fileName}` : 'LoL Esports schedule API',
      kind: 'official-reference', url: result.source.url, retrievedAt: result.source.retrievedAt,
      coverageStart: dateRange(result.events).start, coverageEnd: dateRange(result.events).end,
      rowCount: result.source.eventCount,
      description: `${result.source.eventCount} schedule/result events and ${result.source.gameCount} game IDs cached from LoL Esports persisted APIs. Used only to attach official event/match/game IDs and audit schedule/results; not a rich stat source or standalone model input. ${result.source.attribution}`,
      status: result.source.eventCount > 0 ? 'active' : 'reference-only',
      warnings: [{ kind: 'source-policy', severity: 'warning', message: 'LoL Esports persisted APIs are public site endpoints, not a supported official data API; cache responses and keep them reference-only.' }, ...lolEsportsWarnings],
      ...(sourceRefreshReceipt('lolesports', manifest) ? { refreshReceipt: sourceRefreshReceipt('lolesports', manifest) } : {}),
    })),
    ...oracleImports.map((result): DataSourceInfo => {
      const ratedMatches = filterPublishedRatingUniverseMatches(result.matches, mergedTeams)
      return {
        name: result.source.fileName ? `Oracle's Elixir CSV: ${result.source.fileName}` : "Oracle's Elixir CSV",
        kind: 'game-stats', url: result.source.url, retrievedAt: result.source.retrievedAt,
        coverageStart: dateRange(ratedMatches).start, coverageEnd: dateRange(ratedMatches).end, rowCount: ratedMatches.length,
        description: `${ratedMatches.length} rated games retained from ${result.source.gameCount} Oracle's Elixir imports after the published team-universe filter. ${result.source.attribution}`,
        status: ratedMatches.length > 0 ? 'active' : 'reference-only',
        ...(oracleWarnings.length ? { warnings: oracleWarnings } : {}),
        ...(sourceRefreshReceipt('oracle', manifest) ? { refreshReceipt: sourceRefreshReceipt('oracle', manifest) } : {}),
      }
    }),
    ...leaguepediaImports.map((result): DataSourceInfo => {
      const ratedMatches = filterPublishedRatingUniverseMatches(result.matches, mergedTeams)
      return {
        name: result.source.fileName ? `Leaguepedia Cargo: ${result.source.fileName}` : 'Leaguepedia Cargo',
        kind: 'match-data', url: result.source.url, retrievedAt: result.source.retrievedAt,
        coverageStart: dateRange(ratedMatches).start, coverageEnd: dateRange(ratedMatches).end, rowCount: ratedMatches.length,
        description: `${ratedMatches.length} rated games retained from ${result.source.gameCount} Leaguepedia Cargo imports for requested range ${result.source.start ?? 'unknown'} to ${result.source.end ?? 'unknown'} after the published team-universe filter. ${result.source.attribution}`,
        status: ratedMatches.length > 0 ? 'active' : 'reference-only',
        ...(leaguepediaWarnings.length ? { warnings: leaguepediaWarnings } : {}),
        ...(sourceRefreshReceipt('leaguepedia', manifest) ? { refreshReceipt: sourceRefreshReceipt('leaguepedia', manifest) } : {}),
      }
    }),
  ]
  const tournamentScheduleReferences = lolEsportsImports.flatMap((result) => {
    const coverage = dateRange(result.events)
    return result.events.map((event) => ({
      matchId: event.matchId, tournamentId: event.tournamentId, leagueName: event.leagueName,
      leagueSlug: event.leagueSlug, startTime: event.startTime, date: event.date, state: event.state,
      retrievedAt: result.source.retrievedAt, coverageStart: coverage.start, coverageEnd: coverage.end,
      coverageEndComplete: result.source.coverageEndComplete,
    }))
  })
  return {
    manifest, importedMatches, matches, teams, mergedTeams,
    source: matches.length > 0 ? describeCommunitySource(oracleImports.length, leaguepediaImports.length)
      : importedMatches.length > 0 ? 'no rated public match data available for published team universe' : 'no public match data available',
    dataMode: matches.length > 0 ? 'scheduled-public-data' : 'no-data', externalSources, tournamentScheduleReferences,
  }
}

function uniquePaths(paths: string[]) { return [...new Set(paths.filter(Boolean).map((path) => resolve(path)))] }
function dateRange(matches: { date?: string }[]) {
  const dates = matches.map((match) => match.date).filter((date): date is string => Boolean(date)).sort()
  return { start: dates[0], end: dates.at(-1) }
}
function describeCommunitySource(oracleCount: number, leaguepediaCount: number) {
  return [oracleCount ? "Oracle's Elixir" : '', leaguepediaCount ? 'Leaguepedia Cargo' : ''].filter(Boolean).join(' + ')
}
function sourceRefreshReceipt(provider: 'oracle' | 'leaguepedia' | 'lolesports', manifest?: LocalDataManifest) {
  const source = manifest?.sources?.[provider]
  if (!source?.status) return undefined
  return { requestedStart: manifest?.start, requestedEnd: manifest?.end, attemptedAt: manifest?.generatedAt,
    status: source.status, downloadedCount: source.downloadedCount ?? 0, reusedCount: source.reusedCount ?? 0, failedCount: source.failedCount ?? 0 }
}
function manifestSourceWarnings(provider: 'oracle' | 'leaguepedia' | 'lolesports', warnings?: string[]): DataSourceWarning[] {
  return (warnings ?? []).filter((warning) => warningMatchesProvider(provider, warning)).map((message) => ({
    kind: sourceWarningKind(message), severity: sourceWarningSeverity(message), message,
  }))
}
function warningMatchesProvider(provider: string, warning: string) {
  const lower = warning.toLowerCase()
  return provider === 'oracle' ? lower.includes('oracle') : provider === 'leaguepedia' ? lower.includes('leaguepedia') || lower.includes('cargo') : lower.includes('lol esports')
}
function sourceWarningKind(message: string): DataSourceWarning['kind'] {
  const lower = message.toLowerCase()
  return lower.includes('rate') ? 'rate-limit' : lower.includes('coverage') ? 'coverage' : lower.includes('fresh') ? 'freshness' : 'download'
}
function sourceWarningSeverity(message: string): DataSourceWarning['severity'] { return message.toLowerCase().includes('failed') ? 'error' : 'warning' }
