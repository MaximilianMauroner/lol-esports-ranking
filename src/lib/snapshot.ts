import type {
  EventSummary,
  LeagueStrength,
  MatchRecord,
  PlayerProfile,
  PlayerStanding,
  Region,
  SeasonSummary,
  TeamProfile,
  TeamStanding,
} from '../types'
import { buildPlayerModel, buildRankingModel, transparentGprModelMetadata } from './model'

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

export type SnapshotSourceBreakdown = {
  provider: string
  matchCount: number
  completeness: string[]
}

export type ComputedRankingSnapshot = {
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
  regions: Region[]
}

export type StaticRankingData = {
  schemaVersion: 2
  generatedAt: string
  source: string
  sources: DataSourceInfo[]
  model: ModelInfo
  coverage: DataCoverage
  playerData: {
    status: 'no-data' | 'seeded-demo-rosters' | 'sourced-player-stats'
    description: string
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

export function snapshotKey(filter: SnapshotFilter) {
  return [filter.season, filter.event, filter.region].map(encodeURIComponent).join('__')
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

  for (const filter of buildSnapshotFilters(matches, teams)) {
    const filteredMatches = filterMatches(matches, teams, filter)
    const filteredTeamNames = teamNamesForFilter(filteredMatches, teams, filter)
    snapshots[snapshotKey(filter)] = {
      filter,
      modelVersion: transparentGprModelMetadata.version,
      modelConfigHash: transparentGprModelMetadata.configHash,
      matchCount: filteredMatches.length,
      sourceBreakdown: sourceBreakdown(filteredMatches),
      standings: filteredStandings(globalRanking.standings, filteredMatches, filteredTeamNames, filter),
      leagues: globalRanking.leagues.filter((league) => filter.region === 'All' || league.region === filter.region),
      players: globalPlayers.filter((player) => filteredTeamNames.has(player.team)),
      events: filterEventSummaries(globalRanking.events, filteredMatches),
      seasons: filterSeasonSummaries(globalRanking.seasons, filteredMatches),
      regions: Array.from(new Set(globalRanking.regions.filter((candidate) => filter.region === 'All' || candidate === filter.region))).sort(),
    }
  }

  const defaultFilter: SnapshotFilter = { season: 'All', event: 'All', region: 'All' }

  return {
    schemaVersion: 2,
    generatedAt,
    source,
    sources: [
      ...externalSources,
      {
        name: 'Seeded sample match records',
        kind: 'seed',
        description: 'Checked-in sample matches used until scheduled public-data import is connected.',
        status: resolvedDataMode === 'seeded-sample' ? 'active' : 'reference-only',
        retrievedAt: generatedAt,
        coverageStart: coverageFor(matches).coverageStart,
        coverageEnd: coverageFor(matches).coverageEnd,
        rowCount: matches.filter((match) => (match.sourceProvider ?? 'seed') === 'seed').length,
      },
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
      {
        name: 'Riot LoL Esports GPR page',
        kind: 'official-reference',
        url: 'https://lolesports.com/en-US/gpr/2026/current',
        description: "Official comparison snapshot only; the transparent model does not clone Riot's private formula.",
        status: 'reference-only',
      },
    ],
    model: transparentGprModelMetadata,
    coverage: coverageFor(matches),
    playerData: {
      status: matches.length === 0 ? 'no-data' : 'seeded-demo-rosters',
      description: matches.length === 0 ? 'No player timelines are available because no match rows were loaded.' : 'Player timelines use checked-in demo rosters and a transparent dynamic-share model, not official sourced player ratings.',
    },
    dataMode: resolvedDataMode,
    filterOptions: { seasons, events, regions },
    defaultFilter,
    defaultSnapshotKey: snapshotKey(defaultFilter),
    snapshots,
    teams,
  }
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
    const matchRegions = regionsForMatch(match, teams)
    addFilter({ season, event: 'All', region: 'All' })
    addFilter({ season: 'All', event: match.event, region: 'All' })
    addFilter({ season, event: match.event, region: 'All' })

    for (const region of matchRegions) {
      addFilter({ season: 'All', event: 'All', region })
      addFilter({ season, event: 'All', region })
      addFilter({ season: 'All', event: match.event, region })
      addFilter({ season, event: match.event, region })
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
