import type {
  FactorBreakdown,
  LeagueStrength,
  PlayerStanding,
  RatingComponents,
  RatingUpdateLedger,
  Region,
  Role,
  RosterBasis,
  TeamEligibility,
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

export type CompactPlayer = {
  id: string
  name: string
  team: string
  teamCode?: string
  region?: Region
  league?: string
  role: Role
  rank: number
  rating: number
  games: number
  delta: number
  form: string[]
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
}

export type PublicPlayerDirectory = {
  artifactKind: 'player-directory'
  generatedAt: string
  modelVersion: string
  modelConfigHash: string
  sourceProvider: string
  ratedPlayerCount: number
  ratedTeamCount: number
  roles: Role[]
  players: CompactPlayer[]
}

export type PublicTeamHistoryPoint = [string, number, number]

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
}

export type PublicRankingManifest = {
  artifactKind: 'public-ranking-manifest'
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

export function compactStanding(standing: PublicTeamStanding & { history?: unknown }): PublicTeamStanding {
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
    wins: standing.wins,
    losses: standing.losses,
    confidence: standing.confidence,
    uncertainty: standing.uncertainty,
    form: standing.form,
    strongestFactor: standing.strongestFactor,
    eligibility: standing.eligibility,
    factors: standing.factors,
    recentEvents: standing.recentEvents,
  }
}

export function parsePublicRankingManifest(value: unknown): PublicRankingManifest {
  assertObject(value, 'ranking manifest')
  assertEqual(value.artifactKind, 'public-ranking-manifest', 'ranking manifest artifactKind')
  assertEqual(value.schemaVersion, 12, 'ranking manifest schemaVersion')
  assertEqual(value.summaryMode, 'browser-summary', 'ranking manifest summaryMode')
  assertString(value.generatedAt, 'ranking manifest generatedAt')
  assertString(value.defaultSnapshotKey, 'ranking manifest defaultSnapshotKey')
  assertObject(value.model, 'ranking manifest model')
  assertObject(value.coverage, 'ranking manifest coverage')
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
  assertArray(value.players, 'player directory players')
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
