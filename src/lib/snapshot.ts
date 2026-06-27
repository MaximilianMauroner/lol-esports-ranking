import type {
  EventSummary,
  LeagueStrength,
  LeagueTierName,
  MatchRecord,
  PlayerProfile,
  PlayerStanding,
  Region,
  Role,
  SeasonSummary,
  TeamProfile,
  TeamStanding,
} from '../types'
import { leagueTierFor } from '../data/leagueTiers'
import { deriveRegionStrength, type RegionStrength } from './regionStrength'
import { buildPlayerModel, buildRankingModel, transparentGprModelMetadata } from './model'
import { summarizePredictions, type WalkForwardMetrics } from './predictionModel'
import { compactStanding as compactPublicStanding, snapshotKey, snapshotShardUrlPathForKey } from './publicArtifacts/schema'
import type {
  CompactPlayer,
  CompactPlayerRating,
  PlayerRatingProof,
  PublicPlayerDirectory,
  PublicRankingManifest,
  PublicRankingShard,
  PublicTeamHistoryDirectory,
  PublicTeamHistoryPoint,
  PublicTeamHistorySeries,
  PublicTeamStanding,
  PublicSnapshotIndexEntry,
} from './publicArtifacts/schema'

export type { CompactPlayer, CompactPlayerRating, PlayerRatingProof } from './publicArtifacts/schema'
export { snapshotKey } from './publicArtifacts/schema'

export type SnapshotFilter = {
  season: string
  event: string
  region: Region | 'All'
}

export type DataSourceInfo = {
  name: string
  kind: 'match-data' | 'game-stats' | 'official-reference' | 'seed'
  url?: string
  description: string
  status: 'active' | 'planned' | 'reference-only'
  retrievedAt?: string
  coverageStart?: string
  coverageEnd?: string
  rowCount?: number
}

export type ModelInfo = {
  name: string
  version: string
  configHash: string
  parameters: unknown
}

export type DataCoverage = {
  matchCount: number
  coverageStart?: string
  coverageEnd?: string
  latestMatchDate?: string
  sourceProviders: string[]
  seededSample: boolean
}

export type DataQualityLeagueSummary = {
  league: string
  region?: Region
  tier?: LeagueTierName
  teamCount: number
  matchTouches: number
  sampleTeams: string[]
}

export type DataQualityAudit = {
  matchCount: number
  sourceProviderCounts: Record<string, number>
  dataCompletenessCounts: Record<string, number>
  missing: {
    sourceProviderCount: number
    sourceGameIdCount: number
    patchCount: number
    sideCount: number
  }
  rosterCoverage: {
    rosterSides: number
    completeRosterSides: number
    partialRosterSides: number
    missingRosterSides: number
    playerStatRows: number
  }
  identityCoverage: {
    teamProfileCount: number
    mappedTeamProfileCount: number
    unknownLeagueTeamCount: number
    internationalRegionTeamCount: number
    unresolvedLeagueSummaries: DataQualityLeagueSummary[]
  }
  notes: string[]
}

export type PlayerDirectory = PublicPlayerDirectory
export type TeamHistoryPointCompact = PublicTeamHistoryPoint
export type TeamHistorySeries = PublicTeamHistorySeries
export type TeamHistoryDirectory = PublicTeamHistoryDirectory

/**
 * Flattens per-team rating history from the default snapshot into a compact,
 * browser-loadable time series keyed by team standing key, so the team view can
 * draw rating-over-time charts without the full artifact.
 */
export function createTeamHistory(data: StaticRankingData): TeamHistoryDirectory {
  const defaultSnapshot = data.snapshots[data.defaultSnapshotKey]
  const series: Record<string, TeamHistorySeries> = {}
  const minimumPointsPerSeries = 2
  let omittedSeriesCount = 0
  let pointCount = 0

  for (const standing of defaultSnapshot?.standings ?? []) {
    const points = (standing.history ?? [])
      .filter((point) => Boolean(point.date) && Number.isFinite(point.rating))
      .map((point): TeamHistoryPointCompact => [point.date, Math.round(point.rating), point.rank])
      .sort((left, right) => left[0].localeCompare(right[0]))
    if (points.length < minimumPointsPerSeries) {
      omittedSeriesCount += 1
      continue
    }
    pointCount += points.length
    series[teamStandingKey(standing)] = {
      team: standing.team,
      code: standing.code,
      region: standing.region,
      points,
    }
  }

  return {
    artifactKind: 'team-history',
    generatedAt: data.generatedAt,
    modelVersion: data.model.version,
    modelConfigHash: data.model.configHash,
    omissionPolicy: {
      minimumPointsPerSeries,
      omittedSeriesCount,
      reason: 'Standings with fewer than two valid rating-history points are omitted because a trend line needs at least two points.',
    },
    teamCount: Object.keys(series).length,
    pointCount,
    series,
  }
}

/** Mirrors the UI `teamKey` so history can be looked up from a summary standing. */
export function teamStandingKey(standing: Pick<TeamStanding, 'team' | 'region' | 'code'>) {
  return `${standing.team}__${standing.region ?? ''}__${standing.code ?? ''}`
}

export type AwardSignalData = {
  status: 'source-missing' | 'sourced-award-signals'
  description: string
  sourceProvidersChecked: string[]
  awardResidualsApplied: boolean
}

export type SnapshotSourceBreakdown = {
  provider: string
  matchCount: number
  completeness: string[]
}

export type ComputedRankingSnapshot = {
  artifactKind: 'full-ranking-snapshot'
  filter: SnapshotFilter
  modelVersion: string
  modelConfigHash: string
  matchCount: number
  sourceBreakdown: SnapshotSourceBreakdown[]
  standings: TeamStanding[]
  leagues: LeagueStrength[]
  players: PlayerStanding[]
  events: EventSummary[]
  seasons: SeasonSummary[]
  regions: RegionStrength[]
}

export type StaticRankingData = {
  artifactKind: 'full-ranking-artifact'
  schemaVersion: 12
  generatedAt: string
  source: string
  sources: DataSourceInfo[]
  model: ModelInfo
  coverage: DataCoverage
  dataQuality: DataQualityAudit
  playerData: {
    status: 'no-data' | 'seeded-demo-rosters' | 'sourced-player-stats'
    description: string
    awardSignals: AwardSignalData
    ratingProof?: PlayerRatingProof
  }
  walkForward: {
    metrics: WalkForwardMetrics
  }
  dataMode: 'no-data' | 'seeded-sample' | 'scheduled-public-data'
  filterOptions: {
    seasons: string[]
    events: string[]
    regions: Array<Region | 'All'>
  }
  defaultFilter: SnapshotFilter
  defaultSnapshotKey: string
  snapshots: Record<string, ComputedRankingSnapshot>
  teams: Record<string, TeamProfile>
}

export type RankingSummaryStanding = PublicTeamStanding
export type RankingSummarySnapshot = PublicRankingShard
export type SnapshotIndexEntry = PublicSnapshotIndexEntry
export type StaticRankingSummaryData = PublicRankingManifest

export function createStaticRankingSummaryData(
  data: StaticRankingData,
  {
    fullSnapshotUrl,
    playerDirectoryUrl,
    teamHistoryUrl,
    snapshotUrlForKey = snapshotShardUrlPathForKey,
  }: {
    fullSnapshotUrl?: string
    playerDirectoryUrl?: string
    teamHistoryUrl?: string
    snapshotUrlForKey?: (key: string) => string
  } = {},
): {
  manifest: StaticRankingSummaryData
  snapshots: Record<string, RankingSummarySnapshot>
} {
  const snapshots = Object.fromEntries(
    Object.entries(data.snapshots).map(([key, snapshot]) => [key, compactSnapshot(snapshot)]),
  )
  const defaultSnapshot = snapshots[data.defaultSnapshotKey]
  const snapshotIndex = Object.fromEntries(
    Object.entries(snapshots).map(([key, snapshot]) => [
      key,
      {
        filter: snapshot.filter,
        url: snapshotUrlForKey(key),
        matchCount: snapshot.matchCount,
        sourceBreakdown: snapshot.sourceBreakdown,
      },
    ]),
  )
  const manifestSnapshots = defaultSnapshot ? { [data.defaultSnapshotKey]: defaultSnapshot } : {}
  const { artifactKind: _artifactKind, snapshots: _snapshots, teams: _teams, ...manifestBase } = data
  void _artifactKind
  void _snapshots
  void _teams

  return {
    manifest: {
      ...manifestBase,
      artifactKind: 'public-ranking-manifest',
      summaryMode: 'browser-summary',
      ...(fullSnapshotUrl ? { fullSnapshotUrl } : {}),
      ...(playerDirectoryUrl ? { playerDirectoryUrl } : {}),
      ...(teamHistoryUrl ? { teamHistoryUrl } : {}),
      teamCount: Object.keys(data.teams).length,
      snapshotIndex,
      snapshots: manifestSnapshots,
    },
    snapshots,
  }
}

function compactSnapshot(snapshot: ComputedRankingSnapshot): RankingSummarySnapshot {
  const {
    artifactKind: _artifactKind,
    standings,
    players: _players,
    events: _events,
    seasons: _seasons,
    ...summary
  } = snapshot
  void _artifactKind
  void _players
  void _events
  void _seasons

  return {
    ...summary,
    artifactKind: 'public-snapshot-shard',
    standings: standings.map(compactPublicStanding),
  }
}

export function createStaticRankingData({
  matches,
  teams,
  rosters,
  generatedAt = new Date().toISOString(),
  source = 'seeded sample data',
  dataMode,
  externalSources = [],
}: {
  matches: MatchRecord[]
  teams: Record<string, TeamProfile>
  rosters: Record<string, PlayerProfile[]>
  generatedAt?: string
  source?: string
  dataMode?: StaticRankingData['dataMode']
  externalSources?: DataSourceInfo[]
}): StaticRankingData {
  const resolvedDataMode = dataMode ?? (matches.length === 0 ? 'no-data' : 'seeded-sample')
  const hasOracleSource = matches.some((match) => match.sourceProvider === 'oracles-elixir')
  const hasLeaguepediaSource = matches.some((match) => match.sourceProvider === 'leaguepedia-cargo')
  const seasons = ['All', ...Array.from(new Set(matches.map((match) => String(match.season)))).sort().reverse()]
  const events = ['All', ...Array.from(new Set(matches.map((match) => match.event))).sort()]
  const regions = ['All', ...Array.from(new Set(Object.values(teams).map((team) => team.region))).sort()] as Array<Region | 'All'>
  const snapshots: Record<string, ComputedRankingSnapshot> = {}
  const globalRanking = buildRankingModel(matches, teams)
  const globalPlayers = buildPlayerModel(matches, rosters)
  const hasRosters = Object.keys(rosters).length > 0
  const hasObservedGameRosters = matches.some((match) => match.teamARoster || match.teamBRoster)
  const playerRatingProof = buildPlayerRatingProof(globalPlayers)
  const seedMatches = matches.filter((match) => (match.sourceProvider ?? 'seed') === 'seed')
  const defaultFilter: SnapshotFilter = { season: 'All', event: 'All', region: 'All' }

  for (const filter of buildSnapshotFilters(matches, teams)) {
    const filteredMatches = filterMatches(matches, teams, filter)
    const filteredTeamNames = teamNamesForFilter(filteredMatches, teams, filter)
    const snapshotStandings = filteredStandings(globalRanking.standings, filteredMatches, filteredTeamNames, filter)
    const snapshotLeagues = globalRanking.leagues.filter((league) => filter.region === 'All' || league.region === filter.region)
    snapshots[snapshotKey(filter)] = {
      artifactKind: 'full-ranking-snapshot',
      filter,
      modelVersion: transparentGprModelMetadata.version,
      modelConfigHash: transparentGprModelMetadata.configHash,
      matchCount: filteredMatches.length,
      sourceBreakdown: sourceBreakdown(filteredMatches),
      standings: snapshotStandings,
      leagues: snapshotLeagues,
      players: snapshotKey(filter) === snapshotKey(defaultFilter) ? globalPlayers : [],
      events: filterEventSummaries(globalRanking.events, filteredMatches),
      seasons: filterSeasonSummaries(globalRanking.seasons, filteredMatches),
      regions: deriveRegionStrength(snapshotLeagues, snapshotStandings),
    }
  }

  return {
    artifactKind: 'full-ranking-artifact',
    schemaVersion: 12,
    generatedAt,
    source,
    sources: [
      ...externalSources,
      ...(seedMatches.length > 0
        ? [{
            name: 'Seeded sample match records',
            kind: 'seed' as const,
            description: 'Checked-in sample matches used only when seeded sample mode is explicitly enabled.',
            status: resolvedDataMode === 'seeded-sample' ? 'active' as const : 'reference-only' as const,
            retrievedAt: generatedAt,
            coverageStart: coverageFor(seedMatches).coverageStart,
            coverageEnd: coverageFor(seedMatches).coverageEnd,
            rowCount: seedMatches.length,
          }]
        : []),
      {
        name: 'Leaguepedia Cargo API',
        kind: 'match-data',
        url: 'https://lol.fandom.com/wiki/Help:Leaguepedia_API',
        description: 'Planned canonical source for broad historical events, teams, players, rosters, and match metadata.',
        status: hasLeaguepediaSource ? 'active' : 'planned',
      },
      {
        name: "Oracle's Elixir CSVs",
        kind: 'game-stats',
        url: 'https://oracleselixir.com/tools/downloads',
        description: 'Primary planned source for game-level and player-level stats from yearly CSV snapshots.',
        status: hasOracleSource ? 'active' : 'planned',
      },
    ],
    model: transparentGprModelMetadata,
    coverage: coverageFor(matches),
    dataQuality: dataQualityFor(matches, teams),
    playerData: {
      status: hasObservedGameRosters || playerRatingProof ? 'sourced-player-stats' : matches.length === 0 || !hasRosters ? 'no-data' : 'seeded-demo-rosters',
      description: playerRatingProof
        ? "Oracle's Elixir player rows provide observed game rosters, value-weighted roster continuity for team ratings, role-conditioned player ratings, and gated prior-only player-rating prediction adjustments."
        : hasObservedGameRosters
          ? "Oracle's Elixir player rows provide observed game rosters and value-weighted roster continuity for team ratings; player ratings require sourced player stat rows."
        : matches.length === 0 || !hasRosters
          ? 'No sourced player timeline or roster-continuity data is available for this snapshot.'
          : 'Player timelines use checked-in demo rosters and a transparent dynamic-share model, not official sourced player ratings.',
      awardSignals: {
        status: 'source-missing',
        description: 'Oracle CSVs and Leaguepedia ScoreboardGames do not provide dated human MVP/POG/All-Pro signal in this local pipeline, so AwardResidualZ remains unapplied instead of inferred from visible stats.',
        sourceProvidersChecked: ['oracles-elixir', 'leaguepedia-cargo'],
        awardResidualsApplied: false,
      },
      ratingProof: playerRatingProof,
    },
    walkForward: {
      metrics: summarizePredictions(globalRanking.predictions),
    },
    dataMode: resolvedDataMode,
    filterOptions: { seasons, events, regions },
    defaultFilter,
    defaultSnapshotKey: snapshotKey(defaultFilter),
    snapshots,
    teams,
  }
}

const ROLE_ORDER: Role[] = ['Top', 'Jungle', 'Mid', 'Bot', 'Support']

/**
 * Flattens the full sourced-player list from the default snapshot into a compact,
 * browser-loadable directory. Region and league are joined from team standings so
 * the player view can group and filter without the 195MB full artifact.
 */
export function createPlayerDirectory(data: StaticRankingData): PlayerDirectory {
  const defaultSnapshot = data.snapshots[data.defaultSnapshotKey]
  const sourced = (defaultSnapshot?.players ?? [])
    .filter((player) => player.ratingBasis === 'sourced-player-stats' && player.games > 0)
    .toSorted((left, right) => left.rank - right.rank)

  const teamMeta = new Map<string, { code?: string; region?: Region; league?: string }>()
  for (const standing of defaultSnapshot?.standings ?? []) {
    teamMeta.set(standing.team, { code: standing.code, region: standing.region, league: standing.league })
  }
  for (const team of Object.values(data.teams)) {
    if (!teamMeta.has(team.name)) {
      teamMeta.set(team.name, { code: team.code, region: team.region, league: team.league })
    }
  }

  const players: CompactPlayer[] = sourced.map((player) => {
    const meta = teamMeta.get(player.team)
    return {
      id: player.id,
      name: player.name,
      team: player.team,
      teamCode: meta?.code,
      region: meta?.region,
      league: meta?.league,
      role: player.role,
      rank: player.rank,
      rating: player.rating,
      games: player.games,
      delta: player.delta,
      form: player.form,
      impactMultiplier: player.impactMultiplier,
      availability: player.availability,
      roleCertainty: player.roleCertainty,
      impactDrivers: player.impactDrivers,
      ratingBasis: player.ratingBasis,
      sourceProvider: player.source?.provider,
      sourceFileName: player.source?.fileName,
      sourceGameId: player.source?.gameId,
      sourceUrl: player.source?.url,
      latestObservedAt: player.source?.date,
      latestObservedEvent: player.source?.event,
    }
  })

  return {
    artifactKind: 'player-directory',
    generatedAt: data.generatedAt,
    modelVersion: data.model.version,
    modelConfigHash: data.model.configHash,
    sourceProvider: 'oracles-elixir',
    ratedPlayerCount: players.length,
    ratedTeamCount: new Set(players.map((player) => player.team)).size,
    roles: ROLE_ORDER.filter((role) => players.some((player) => player.role === role)),
    players,
  }
}

function buildPlayerRatingProof(players: PlayerStanding[]): PlayerRatingProof | undefined {
  const sourcedPlayers = players
    .filter((player) => player.ratingBasis === 'sourced-player-stats' && player.games > 0)
    .toSorted((left, right) => left.rank - right.rank)

  if (sourcedPlayers.length === 0) return undefined

  return {
    sourceProvider: 'oracles-elixir',
    modelVersion: transparentGprModelMetadata.version,
    modelConfigHash: transparentGprModelMetadata.configHash,
    ratedPlayerCount: sourcedPlayers.length,
    ratedTeamCount: new Set(sourcedPlayers.map((player) => player.team)).size,
    sampleSize: sourcedPlayers.reduce((total, player) => total + player.games, 0),
    topPlayers: sourcedPlayers.slice(0, 10).map(compactPlayerRating),
  }
}

function compactPlayerRating(player: PlayerStanding): CompactPlayerRating {
  return {
    id: player.id,
    name: player.name,
    team: player.team,
    role: player.role,
    rank: player.rank,
    rating: player.rating,
    games: player.games,
    ratingBasis: player.ratingBasis,
    sourceProvider: player.source?.provider,
    sourceFileName: player.source?.fileName,
    sourceGameId: player.source?.gameId,
    sourceUrl: player.source?.url,
    latestObservedAt: player.source?.date,
    latestObservedEvent: player.source?.event,
  }
}

function dataQualityFor(matches: MatchRecord[], teams: Record<string, TeamProfile>): DataQualityAudit {
  const rosterSides = matches.flatMap((match) => [match.teamARoster, match.teamBRoster])
  const sourceProviderCounts = countBy(matches, (match) => match.sourceProvider ?? 'unknown')
  const dataCompletenessCounts = countBy(matches, (match) => match.dataCompleteness ?? 'unspecified')
  const unresolvedLeagueSummaries = unresolvedLeagueSummariesFor(matches, teams)
  const unknownLeagueTeamCount = Object.values(teams).filter((team) => team.league === 'Unknown').length
  const internationalRegionTeamCount = Object.values(teams).filter((team) => team.region === 'International').length
  const missingPatchCount = matches.filter((match) => !match.patch).length
  const missingSideCount = matches.filter((match) => !match.teamASide || !match.teamBSide).length
  const missingSourceProviderCount = matches.filter((match) => !match.sourceProvider).length
  const missingSourceGameIdCount = matches.filter((match) => !match.sourceGameId).length
  const missingRosterSides = rosterSides.filter((roster) => !roster).length

  return {
    matchCount: matches.length,
    sourceProviderCounts,
    dataCompletenessCounts,
    missing: {
      sourceProviderCount: missingSourceProviderCount,
      sourceGameIdCount: missingSourceGameIdCount,
      patchCount: missingPatchCount,
      sideCount: missingSideCount,
    },
    rosterCoverage: {
      rosterSides: rosterSides.length,
      completeRosterSides: rosterSides.filter((roster) => roster?.completeness === 'complete-five-role').length,
      partialRosterSides: rosterSides.filter((roster) => roster?.completeness === 'partial').length,
      missingRosterSides,
      playerStatRows: rosterSides.reduce((total, roster) => total + (roster?.players.filter((player) => player.stats).length ?? 0), 0),
    },
    identityCoverage: {
      teamProfileCount: Object.keys(teams).length,
      mappedTeamProfileCount: Object.values(teams).filter((team) => team.league !== 'Unknown' && team.region !== 'International').length,
      unknownLeagueTeamCount,
      internationalRegionTeamCount,
      unresolvedLeagueSummaries,
    },
    notes: dataQualityNotes({
      missingPatchCount,
      missingSideCount,
      missingSourceProviderCount,
      missingSourceGameIdCount,
      missingRosterSides,
      unknownLeagueTeamCount,
      internationalRegionTeamCount,
      unresolvedLeagueSummaries,
    }),
  }
}

function dataQualityNotes({
  missingPatchCount,
  missingSideCount,
  missingSourceProviderCount,
  missingSourceGameIdCount,
  missingRosterSides,
  unknownLeagueTeamCount,
  internationalRegionTeamCount,
  unresolvedLeagueSummaries,
}: {
  missingPatchCount: number
  missingSideCount: number
  missingSourceProviderCount: number
  missingSourceGameIdCount: number
  missingRosterSides: number
  unknownLeagueTeamCount: number
  internationalRegionTeamCount: number
  unresolvedLeagueSummaries: DataQualityLeagueSummary[]
}) {
  const notes: string[] = []
  if (missingSourceProviderCount > 0) notes.push(`${missingSourceProviderCount} matches are missing source provider metadata.`)
  if (missingSourceGameIdCount > 0) notes.push(`${missingSourceGameIdCount} matches are missing source game ids.`)
  if (missingPatchCount > 0) notes.push(`${missingPatchCount} matches are missing patch metadata.`)
  if (missingSideCount > 0) notes.push(`${missingSideCount} matches are missing side-selection metadata; these rows cannot train side priors.`)
  if (missingRosterSides > 0) notes.push(`${missingRosterSides} team-sides have no sourced roster snapshot; roster continuity falls back to assumed/unknown basis.`)
  if (unknownLeagueTeamCount > 0 || internationalRegionTeamCount > 0) {
    notes.push(`${unknownLeagueTeamCount} teams have unknown league profiles and ${internationalRegionTeamCount} teams still map to International region profiles.`)
  }
  if (unresolvedLeagueSummaries.length > 0) {
    notes.push('Unresolved league summaries list the largest remaining identity gaps by team count and match touches.')
  }
  return notes
}

function unresolvedLeagueSummariesFor(matches: MatchRecord[], teams: Record<string, TeamProfile>): DataQualityLeagueSummary[] {
  const matchTouches = new Map<string, number>()
  for (const match of matches) {
    for (const teamName of [match.teamA, match.teamB]) {
      matchTouches.set(teamName, (matchTouches.get(teamName) ?? 0) + 1)
    }
  }

  const byLeague = new Map<string, { league: string; region?: Region; tier?: LeagueTierName; teams: TeamProfile[]; matchTouches: number }>()
  for (const team of Object.values(teams)) {
    const tier = leagueTierFor(team.league).tier
    if (team.league !== 'Unknown' && team.region !== 'International' && tier !== 'unknown') continue
    const key = `${team.league}\u0000${team.region}`
    const summary = byLeague.get(key) ?? { league: team.league, region: team.region, tier, teams: [], matchTouches: 0 }
    summary.teams.push(team)
    summary.matchTouches += matchTouches.get(team.name) ?? 0
    byLeague.set(key, summary)
  }

  return Array.from(byLeague.values())
    .map((summary) => ({
      league: summary.league,
      region: summary.region,
      tier: summary.tier,
      teamCount: summary.teams.length,
      matchTouches: summary.matchTouches,
      sampleTeams: summary.teams
        .slice()
        .sort((left, right) => (matchTouches.get(right.name) ?? 0) - (matchTouches.get(left.name) ?? 0) || left.name.localeCompare(right.name))
        .slice(0, 5)
        .map((team) => team.name),
    }))
    .sort((left, right) => right.teamCount - left.teamCount || right.matchTouches - left.matchTouches || left.league.localeCompare(right.league))
    .slice(0, 12)
}

function countBy<T>(items: T[], keyFor: (item: T) => string) {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const key = keyFor(item)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

function coverageFor(matches: MatchRecord[]): DataCoverage {
  const dates = datesFor(matches)
  const sourceProviders = Array.from(new Set(matches.map((match) => match.sourceProvider ?? 'unknown'))).sort()
  return {
    matchCount: matches.length,
    coverageStart: dates[0],
    coverageEnd: dates.at(-1),
    latestMatchDate: dates.at(-1),
    sourceProviders,
    seededSample: sourceProviders.includes('seed'),
  }
}

function datesFor(matches: MatchRecord[]) {
  const dates: string[] = []
  for (const match of matches) {
    if (match.date) dates.push(match.date)
  }
  return dates.sort()
}

function sourceBreakdown(matches: MatchRecord[]): SnapshotSourceBreakdown[] {
  const byProvider = new Map<string, MatchRecord[]>()
  for (const match of matches) {
    const provider = match.sourceProvider ?? 'unknown'
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), match])
  }

  return Array.from(byProvider.entries())
    .map(([provider, providerMatches]) => ({
      provider,
      matchCount: providerMatches.length,
      completeness: Array.from(new Set(providerMatches.map((match) => match.dataCompleteness).filter((value): value is string => Boolean(value)))).sort(),
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

function filterMatches(matches: MatchRecord[], teams: Record<string, TeamProfile>, filter: SnapshotFilter) {
  return matches.filter((match) => {
    const seasonMatches = filter.season === 'All' || String(match.season) === filter.season
    const eventMatches = filter.event === 'All' || match.event === filter.event
    const regionMatches =
      filter.region === 'All' || match.region === filter.region || teams[match.teamA]?.region === filter.region || teams[match.teamB]?.region === filter.region
    return seasonMatches && eventMatches && regionMatches
  })
}

function buildSnapshotFilters(matches: MatchRecord[], teams: Record<string, TeamProfile>) {
  const filters = new Map<string, SnapshotFilter>()
  const addFilter = (filter: SnapshotFilter) => filters.set(snapshotKey(filter), filter)
  addFilter({ season: 'All', event: 'All', region: 'All' })

  for (const match of matches) {
    const season = String(match.season)
    addFilter({ season, event: 'All', region: 'All' })
    addFilter({ season: 'All', event: match.event, region: 'All' })

    for (const region of regionsForMatch(match, teams)) {
      addFilter({ season: 'All', event: 'All', region })
    }
  }

  return Array.from(filters.values()).sort((left, right) => {
    if (snapshotKey(left) === snapshotKey({ season: 'All', event: 'All', region: 'All' })) return -1
    if (snapshotKey(right) === snapshotKey({ season: 'All', event: 'All', region: 'All' })) return 1
    return snapshotKey(left).localeCompare(snapshotKey(right))
  })
}

function regionsForMatch(match: MatchRecord, teams: Record<string, TeamProfile>) {
  const regions = [
    match.region,
    match.teamARegion,
    match.teamBRegion,
    teams[match.teamA]?.region,
    teams[match.teamB]?.region,
  ].filter((region): region is Region => Boolean(region))
  return Array.from(new Set(regions))
}

function filteredStandings(
  standings: TeamStanding[],
  matches: MatchRecord[],
  teamNames: Set<string>,
  filter: SnapshotFilter,
) {
  if (isDefaultFilter(filter)) {
    return standings.filter((standing) => teamNames.has(standing.team))
  }

  const historyKeys = historyKeysForMatches(matches)
  return standings
    .filter((standing) => teamNames.has(standing.team))
    .map((standing) => {
      const history = standing.history.filter((point) => historyKeys.has(historyKey(standing.team, point.date, point.event, point.opponent)))
      return {
        ...standing,
        history,
        recentEvents: Array.from(new Set(history.slice(-4).map((point) => point.event))).reverse(),
      }
    })
}

function historyKeysForMatches(matches: MatchRecord[]) {
  const keys = new Set<string>()
  for (const match of matches) {
    keys.add(historyKey(match.teamA, match.date, match.event, match.teamB))
    keys.add(historyKey(match.teamB, match.date, match.event, match.teamA))
  }
  return keys
}

function historyKey(team: string, date: string, event: string, opponent: string) {
  return `${team}\u0000${date}\u0000${event}\u0000${opponent}`
}

function isDefaultFilter(filter: SnapshotFilter) {
  return filter.season === 'All' && filter.event === 'All' && filter.region === 'All'
}

function teamNamesForFilter(matches: MatchRecord[], teams: Record<string, TeamProfile>, filter: SnapshotFilter) {
  if (filter.season === 'All' && filter.event === 'All' && filter.region === 'All') {
    return new Set(Object.keys(teams))
  }

  const teamNames = new Set(matches.flatMap((match) => [match.teamA, match.teamB]))
  if (filter.region !== 'All') {
    for (const [teamName, team] of Object.entries(teams)) {
      if (team.region === filter.region) teamNames.add(teamName)
    }
  }
  return teamNames
}

function filterEventSummaries(events: EventSummary[], matches: MatchRecord[]) {
  const eventNames = new Set(matches.map((match) => match.event))
  return events.filter((event) => eventNames.has(event.event))
}

function filterSeasonSummaries(seasons: SeasonSummary[], matches: MatchRecord[]) {
  const seasonNumbers = new Set(matches.map((match) => match.season))
  return seasons.filter((season) => seasonNumbers.has(season.season))
}
