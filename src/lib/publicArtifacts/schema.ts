import type {
  FactorBreakdown,
  LeagueStrength,
  PlayerAppearanceSummary,
  PlayerStanding,
  RatingComponents,
  RatingUpdateLedger,
  Region,
  Role,
  RosterBasis,
  TeamEligibility,
  TeamHistoryPoint,
} from '../../types'
import type { RegionStrength } from '../regionStrength'
import type {
  AwardSignalData,
  DataCoverage,
  DataQualityAudit,
  DataSourceInfo,
  ModelInfo,
  SnapshotFilter,
  SnapshotSourceBreakdown,
} from '../snapshot'
import type { WalkForwardMetrics } from '../predictionModel'

export type { SnapshotFilter, SnapshotSourceBreakdown } from '../snapshot'

export type PublicRecentMatch = {
  date: string
  event: string
  opponent: string
  result: 'W' | 'L'
  rating: number
  delta: number
  wins?: number
  losses?: number
  games?: number
  bestOf?: number
}

export type PublicTeamStanding = {
  team: string
  code: string
  region: Region
  league: string
  rosterBasis: RosterBasis
  rosterContinuity?: number
  baseRating: number
  leagueScore: number
  leagueAdjustment: number
  leagueDelta: number
  ratingComponents: RatingComponents
  ratingUpdate: RatingUpdateLedger
  rating: number
  previousRating: number
  delta: number
  rank: number
  previousRank: number
  movement: number
  wins: number
  losses: number
  confidence: number
  uncertainty: number
  form: string[]
  strongestFactor: keyof FactorBreakdown
  eligibility: TeamEligibility
  factors: FactorBreakdown
  recentEvents: string[]
  recentMatches: PublicRecentMatch[]
}

type PublicTeamStandingInput = Omit<PublicTeamStanding, 'recentMatches'> & {
  history?: TeamHistoryPoint[]
  recentMatches?: PublicRecentMatch[]
}

export type PublicRankingShard = {
  artifactKind: 'public-snapshot-shard'
  filter: SnapshotFilter
  modelVersion: string
  modelConfigHash: string
  matchCount: number
  sourceBreakdown: SnapshotSourceBreakdown[]
  standings: PublicTeamStanding[]
  leagues: LeagueStrength[]
  regions: RegionStrength[]
}

export type PublicSnapshotIndexEntry = {
  filter: SnapshotFilter
  url: string
  matchCount: number
  sourceBreakdown: SnapshotSourceBreakdown[]
}

export type CompactPlayerRating = {
  id: string
  name: string
  team: string
  role: PlayerStanding['role']
  rank: number
  rating: number
  games: number
  ratingBasis?: PlayerStanding['ratingBasis']
  sourceProvider?: string
  sourceFileName?: string
  sourceGameId?: string
  sourceUrl?: string
  latestObservedAt?: string
  latestObservedEvent?: string
  appearance?: PlayerAppearanceSummary
}

export type PlayerRatingProof = {
  sourceProvider: 'oracles-elixir'
  modelVersion: string
  modelConfigHash: string
  ratedPlayerCount: number
  ratedTeamCount: number
  sampleSize: number
  topPlayers: CompactPlayerRating[]
}

export type PlayerMetricInfo = {
  id: 'role-power'
  label: string
  shortLabel: string
  description: string
  interpretation: string
  teamResultSignal: 'included'
  independentSkillClaim: false
}

export type CompactPlayer = {
  id: string
  name: string
  team: string
  teamCode?: string
  teamGames?: number
  teamShare?: number
  region?: Region
  league?: string
  role: Role
  rank: number
  rating: number
  games: number
  delta: number
  form: string[]
  recentMatches?: {
    date: string
    event: string
    opponent: string
    opponentTeamCode?: string
    playerTeam?: string
    playerTeamCode?: string
    result: 'W' | 'L'
    wins?: number
    losses?: number
    games?: number
    bestOf?: number
    teamKills?: number
    opponentKills?: number
    sourceProvider?: string
    sourceFileName?: string
    sourceGameId?: string
    sourceMatchId?: string
    sourceGameIds?: string[]
    sourceUrl?: string
  }[]
  impactMultiplier: number
  availability: number
  roleCertainty: number
  impactDrivers: PlayerStanding['impactDrivers']
  ratingBasis?: PlayerStanding['ratingBasis']
  sourceProvider?: string
  sourceFileName?: string
  sourceGameId?: string
  sourceUrl?: string
  latestObservedAt?: string
  latestObservedEvent?: string
  appearance?: PlayerAppearanceSummary
}

export type PublicPlayerDirectory = {
  artifactKind: 'player-directory'
  generatedAt: string
  modelVersion: string
  modelConfigHash: string
  sourceProvider: string
  metric: PlayerMetricInfo
  ratedPlayerCount: number
  ratedTeamCount: number
  roles: Role[]
  players: CompactPlayer[]
  scopedPlayers?: Record<string, CompactPlayer[]>
}

export type PublicTeamHistoryPointContext = {
  event?: string
  opponent?: string
  delta?: number
  tier?: string
  result?: 'W' | 'L'
  wins?: number
  losses?: number
  games?: number
  bestOf?: number
  sourceProvider?: string
  sourceGameId?: string
  sourceMatchId?: string
  sourceGameIds?: string[]
  sourceFileName?: string
  sourceUrl?: string
}

export type PublicTeamHistoryPoint = [string, number, number, PublicTeamHistoryPointContext?]

export type PublicTeamHistorySeries = {
  team: string
  code?: string
  region?: Region
  points: PublicTeamHistoryPoint[]
}

export type PublicTeamHistoryDirectory = {
  artifactKind: 'team-history'
  generatedAt: string
  modelVersion: string
  modelConfigHash: string
  omissionPolicy: {
    minimumPointsPerSeries: number
    omittedSeriesCount: number
    reason: string
  }
  teamCount: number
  pointCount: number
  series: Record<string, PublicTeamHistorySeries>
  scopedSeries?: Record<string, Record<string, PublicTeamHistorySeries>>
}

export type PublicRankingManifest = {
  artifactKind: 'public-ranking-manifest'
  schemaVersion: 14
  generatedAt: string
  source: string
  sources: DataSourceInfo[]
  model: ModelInfo
  coverage: DataCoverage
  dataQuality: DataQualityAudit
  playerData: {
    status: 'no-data' | 'seeded-demo-rosters' | 'sourced-player-stats'
    description: string
    metric: PlayerMetricInfo
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
  summaryMode: 'browser-summary'
  fullSnapshotUrl?: string
  playerDirectoryUrl?: string
  teamHistoryUrl?: string
  teamCount: number
  snapshotIndex: Record<string, PublicSnapshotIndexEntry>
  snapshots: Record<string, PublicRankingShard>
}

export function snapshotKey(filter: SnapshotFilter) {
  return [filter.season, filter.event, filter.region].map(encodeURIComponent).join('__')
}

export function snapshotShardFileName(key: string) {
  return `${key}.json`
}

export function snapshotShardUrlPathForKey(key: string, basePath = '/data/snapshots') {
  const normalizedBase = basePath.replace(/\/$/, '')
  return `${normalizedBase}/${encodeURIComponent(snapshotShardFileName(key))}`
}

export function compactStanding(standing: PublicTeamStandingInput): PublicTeamStanding {
  const matchRecord = standing.history ? teamMatchRecord(standing.history) : undefined
  return {
    team: standing.team,
    code: standing.code,
    region: standing.region,
    league: standing.league,
    rosterBasis: standing.rosterBasis,
    rosterContinuity: standing.rosterContinuity,
    baseRating: standing.baseRating,
    leagueScore: standing.leagueScore,
    leagueAdjustment: standing.leagueAdjustment,
    leagueDelta: standing.leagueDelta,
    ratingComponents: standing.ratingComponents,
    ratingUpdate: standing.ratingUpdate,
    rating: standing.rating,
    previousRating: standing.previousRating,
    delta: standing.delta,
    rank: standing.rank,
    previousRank: standing.previousRank,
    movement: standing.movement,
    wins: matchRecord?.wins ?? standing.wins,
    losses: matchRecord?.losses ?? standing.losses,
    confidence: standing.confidence,
    uncertainty: standing.uncertainty,
    form: matchRecord?.form ?? standing.form,
    strongestFactor: standing.strongestFactor,
    eligibility: standing.eligibility,
    factors: standing.factors,
    recentEvents: standing.recentEvents,
    recentMatches: matchRecord?.recentMatches ?? standing.recentMatches ?? [],
  }
}

function teamMatchRecord(history: TeamHistoryPoint[] = []) {
  const matches = groupTeamHistoryIntoMatches(history.filter((point) => Boolean(point.date) && Boolean(point.event) && Boolean(point.opponent)))
  const resolvedMatches = matches
    .map((match) => ({ match, result: teamMatchResult(match) }))
    .filter((record): record is { match: TeamMatchGroup; result: 'W' | 'L' } => Boolean(record.result))
  const recentMatches = resolvedMatches.slice(-5).map(({ match, result }) => teamRecentMatch(match, result))
  const wins = resolvedMatches.filter((match) => match.result === 'W').length
  const losses = resolvedMatches.length - wins

  return {
    wins,
    losses,
    form: resolvedMatches.slice(-5).map((match) => match.result),
    recentMatches,
  }
}

type TeamMatchGroup = {
  key: string
  entries: TeamHistoryPoint[]
}

function groupTeamHistoryIntoMatches(history: TeamHistoryPoint[]): TeamMatchGroup[] {
  const groups: TeamMatchGroup[] = []

  for (const point of history) {
    const key = teamHistoryMatchKey(point)
    const current = groups.at(-1)
    if (current?.key === key) {
      current.entries.push(point)
      continue
    }
    groups.push({ key, entries: [point] })
  }

  return groups
}

function teamHistoryMatchKey(point: TeamHistoryPoint) {
  return [
    'series',
    point.date,
    point.opponent,
  ].join('\u0000')
}

function teamRecentMatch(group: TeamMatchGroup, result: 'W' | 'L'): PublicRecentMatch {
  const latest = group.entries.at(-1)!
  const wins = group.entries.filter((entry) => entry.result === 'W').length
  const losses = group.entries.length - wins
  const bestOf = bestOfForScore(wins, losses, latest.source.bestOf)

  return {
    date: latest.date,
    event: latest.event,
    opponent: latest.opponent,
    result,
    rating: Math.round(latest.rating),
    delta: group.entries.reduce((total, entry) => total + Math.round(entry.delta), 0),
    wins,
    losses,
    games: group.entries.length,
    ...(typeof bestOf === 'number' ? { bestOf } : {}),
  }
}

function teamMatchResult(group: TeamMatchGroup) {
  const wins = group.entries.filter((entry) => entry.result === 'W').length
  const losses = group.entries.length - wins
  if (wins === losses) return undefined
  return wins > losses ? 'W' : 'L'
}

function bestOfForScore(wins: number, losses: number, explicit?: number) {
  const games = wins + losses
  if (games <= 0) return explicit
  const requiredWins = Math.max(wins, losses)
  const inferred = wins === losses ? games : Math.max(games, requiredWins * 2 - 1)
  if (typeof explicit !== 'number' || !Number.isFinite(explicit)) return inferred

  const explicitGames = Math.trunc(explicit)
  const winsNeeded = Math.floor(explicitGames / 2) + 1
  return games <= explicitGames && requiredWins >= winsNeeded ? explicitGames : inferred
}

export function parsePublicRankingManifest(value: unknown): PublicRankingManifest {
  assertObject(value, 'ranking manifest')
  assertEqual(value.artifactKind, 'public-ranking-manifest', 'ranking manifest artifactKind')
  assertEqual(value.schemaVersion, 14, 'ranking manifest schemaVersion')
  assertEqual(value.summaryMode, 'browser-summary', 'ranking manifest summaryMode')
  assertString(value.generatedAt, 'ranking manifest generatedAt')
  assertString(value.defaultSnapshotKey, 'ranking manifest defaultSnapshotKey')
  assertObject(value.model, 'ranking manifest model')
  assertObject(value.coverage, 'ranking manifest coverage')
  assertObject(value.playerData, 'ranking manifest playerData')
  assertObject(value.playerData.metric, 'ranking manifest playerData metric')
  assertObject(value.snapshotIndex, 'ranking manifest snapshotIndex')
  assertObject(value.snapshots, 'ranking manifest snapshots')
  return value as PublicRankingManifest
}

export function parsePublicRankingShard(value: unknown): PublicRankingShard {
  assertObject(value, 'ranking shard')
  assertEqual(value.artifactKind, 'public-snapshot-shard', 'ranking shard artifactKind')
  assertObject(value.filter, 'ranking shard filter')
  assertString(value.modelVersion, 'ranking shard modelVersion')
  assertString(value.modelConfigHash, 'ranking shard modelConfigHash')
  assertNumber(value.matchCount, 'ranking shard matchCount')
  assertArray(value.sourceBreakdown, 'ranking shard sourceBreakdown')
  assertArray(value.standings, 'ranking shard standings')
  assertArray(value.regions, 'ranking shard regions')
  return value as PublicRankingShard
}

export function parsePublicPlayerDirectory(value: unknown): PublicPlayerDirectory {
  assertObject(value, 'player directory')
  assertEqual(value.artifactKind, 'player-directory', 'player directory artifactKind')
  assertString(value.generatedAt, 'player directory generatedAt')
  assertString(value.modelVersion, 'player directory modelVersion')
  assertString(value.modelConfigHash, 'player directory modelConfigHash')
  assertObject(value.metric, 'player directory metric')
  assertArray(value.players, 'player directory players')
  if ('scopedPlayers' in value) assertObject(value.scopedPlayers, 'player directory scopedPlayers')
  return value as PublicPlayerDirectory
}

export function parsePublicTeamHistory(value: unknown): PublicTeamHistoryDirectory {
  assertObject(value, 'team history')
  assertEqual(value.artifactKind, 'team-history', 'team history artifactKind')
  assertString(value.generatedAt, 'team history generatedAt')
  assertString(value.modelVersion, 'team history modelVersion')
  assertString(value.modelConfigHash, 'team history modelConfigHash')
  assertObject(value.series, 'team history series')
  return value as PublicTeamHistoryDirectory
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid public artifact: ${label} must be an object`)
  }
}

function assertArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid public artifact: ${label} must be an array`)
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid public artifact: ${label} must be a non-empty string`)
  }
}

function assertNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid public artifact: ${label} must be a finite number`)
  }
}

function assertEqual<T>(value: unknown, expected: T, label: string): asserts value is T {
  if (value !== expected) {
    throw new Error(`Invalid public artifact: ${label} must be ${String(expected)}`)
  }
}
