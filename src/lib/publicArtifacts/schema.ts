import type {
  FactorBreakdown,
  LeagueStrength,
  PlayerAppearanceSummary,
  PlayerDiagnostics,
  PlayerIndividualResidual,
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
  SnapshotCheckpointOption,
  SnapshotSourceBreakdown,
} from '../snapshot'
import type { WalkForwardMetrics } from '../predictionModel'

export type { SnapshotFilter, SnapshotCheckpointOption, SnapshotSourceBreakdown } from '../snapshot'

export const PUBLIC_ARTIFACT_SCHEMA_VERSION = 17 as const

export type ArtifactMeta = {
  schemaVersion: typeof PUBLIC_ARTIFACT_SCHEMA_VERSION
  runId: string
  generatedAt: string
  modelVersion: string
  modelConfigHash: string
}

export type ProviderAliasMap = Partial<Record<'oracles-elixir' | 'leaguepedia-cargo' | 'manual', string[]>>

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
  teamId: string
  leagueId: string
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
  ratingUpdate?: Partial<RatingUpdateLedger>
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
  eligibility: Pick<TeamEligibility, 'eligible' | 'reasons'> & Partial<TeamEligibility>
  factors: FactorBreakdown
  recentEvents: string[]
  recentMatches: PublicRecentMatch[]
}

type PublicTeamStandingInput = Omit<PublicTeamStanding, 'recentMatches' | 'teamId' | 'leagueId'> & Partial<Pick<PublicTeamStanding, 'teamId' | 'leagueId'>> & {
  history?: TeamHistoryPoint[]
  recentMatches?: PublicRecentMatch[]
}

export type PublicRankingShard = {
  artifactKind: 'public-snapshot-shard'
  artifactMeta?: ArtifactMeta
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

export type PlayerComparisonMetricInfo = {
  id: 'individual-residual'
  label: string
  shortLabel: string
  description: string
  metricVersion: 'individual-residual-v0'
  teamResultSignal: 'reduced'
  independentSkillClaim: false
}

export type SameTeamTopFiveClusteringDiagnostic = {
  status: 'diagnostic-not-failure'
  topN: 5
  scope: string
  teams: Array<{
    team: string
    teamCode?: string
    count: number
    roles: Role[]
    players: string[]
  }>
}

export type PlayerDirectoryDiagnostics = {
  sameTeamTopFiveClustering: SameTeamTopFiveClusteringDiagnostic
  scopedSameTeamTopFiveClustering?: Record<string, SameTeamTopFiveClusteringDiagnostic>
}

export type CompactPlayer = {
  id: string
  playerId?: string
  name: string
  team: string
  teamId?: string
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
  diagnostics?: Partial<PlayerDiagnostics> & Pick<PlayerDiagnostics, 'sourceProvider' | 'scope' | 'sampleGames'>
  individualResidual?: Partial<PlayerIndividualResidual> & Pick<PlayerIndividualResidual, 'sourceProvider' | 'metricVersion' | 'scope' | 'score' | 'confidence' | 'sampleGames'>
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
  schemaVersion?: typeof PUBLIC_ARTIFACT_SCHEMA_VERSION
  artifactMeta?: ArtifactMeta
  generatedAt: string
  modelVersion: string
  modelConfigHash: string
  sourceProvider: string
  metric: PlayerMetricInfo
  comparisonMetrics?: PlayerComparisonMetricInfo[]
  diagnostics?: PlayerDirectoryDiagnostics
  ratedPlayerCount: number
  ratedTeamCount: number
  roles: Role[]
  players: CompactPlayer[]
  scopedPlayers?: Record<string, CompactPlayer[]>
}

export type PublicTeamEntity = {
  teamId: string
  name: string
  code: string
  region: Region
  league: string
  leagueId: string
  providerAliases?: ProviderAliasMap
}

export type PublicTeamDirectory = {
  artifactKind: 'team-directory'
  schemaVersion?: typeof PUBLIC_ARTIFACT_SCHEMA_VERSION
  artifactMeta?: ArtifactMeta
  generatedAt: string
  modelVersion: string
  modelConfigHash: string
  teamCount: number
  teams: PublicTeamEntity[]
}

export type PublicTeamHistoryPointContext = {
  kind?: 'match' | 'standing-adjustment'
  adjustmentReason?: 'published-standing-reconciliation'
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
  model?: PublicTeamHistoryModelContext
}

// Compact browser-history model context. Short keys keep team-history.json inside
// the public data budget: e=expected win probability, r=result residual,
// v=result evidence, s=series strength signal, a=update attribution entries,
// c=current rating components [league, stable, roster, form, context].
export type PublicTeamHistoryModelContext = {
  e?: number
  r?: number
  v?: number
  s?: number
  a?: PublicTeamHistoryAttribution
  c?: PublicTeamHistoryComponentSnapshot
}

export type PublicTeamHistoryAttributionKey = 's' | 'l' | 'p' | 'f' | 'r' | 'u'
export type PublicTeamHistoryAttribution = [PublicTeamHistoryAttributionKey, number][]
export type PublicTeamHistoryComponentSnapshot = [number, number, number, number, number]

export type PublicTeamHistoryPoint = [string, number, number, PublicTeamHistoryPointContext?]

export type PublicTeamHistorySeries = {
  team: string
  code?: string
  region?: Region
  points: PublicTeamHistoryPoint[]
}

export type PublicTeamHistoryDirectory = {
  artifactKind: 'team-history'
  schemaVersion?: typeof PUBLIC_ARTIFACT_SCHEMA_VERSION
  artifactMeta?: ArtifactMeta
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
  scopeIndex?: Record<string, string[]>
}

export type PublicTeamHistoryShard = {
  artifactKind: 'team-history-scope'
  schemaVersion: typeof PUBLIC_ARTIFACT_SCHEMA_VERSION
  artifactMeta?: ArtifactMeta
  generatedAt: string
  modelVersion: string
  modelConfigHash: string
  filter: SnapshotFilter
  omissionPolicy: PublicTeamHistoryDirectory['omissionPolicy']
  teamCount: number
  pointCount: number
  series: Record<string, PublicTeamHistorySeries>
}

export type PublicTeamHistoryIndexEntry = {
  filter: SnapshotFilter
  url: string
  teamCount: number
  pointCount: number
}

export type PublicTeamHistoryIndex = {
  artifactKind: 'team-history-index'
  schemaVersion: typeof PUBLIC_ARTIFACT_SCHEMA_VERSION
  artifactMeta?: ArtifactMeta
  generatedAt: string
  modelVersion: string
  modelConfigHash: string
  defaultScopeKey: string
  omissionPolicy: PublicTeamHistoryDirectory['omissionPolicy']
  scopeIndex: Record<string, PublicTeamHistoryIndexEntry>
}

export type PublicRegionHistoryPointContext = {
  event?: string
  tier?: string
  leagues?: string[]
  opponentRegions?: string[]
  wins?: number
  losses?: number
  winsOverExpected?: number
  opponentAdjustedWinRate?: number
  source?: 'league-strength-history'
}

export type PublicRegionHistoryPoint = [string, number, number, PublicRegionHistoryPointContext?]

export type PublicRegionHistorySeries = {
  region: Region | string
  points: PublicRegionHistoryPoint[]
}

export type PublicRegionHistoryScope = {
  filter: SnapshotFilter
  regionCount: number
  pointCount: number
  series: Record<string, PublicRegionHistorySeries>
}

export type PublicRegionHistoryDirectory = {
  artifactKind: 'region-history'
  schemaVersion: typeof PUBLIC_ARTIFACT_SCHEMA_VERSION
  artifactMeta?: ArtifactMeta
  generatedAt: string
  modelVersion: string
  modelConfigHash: string
  defaultScopeKey: string
  scopes: Record<string, PublicRegionHistoryScope>
}

export type PublicRankingManifest = {
  artifactKind: 'public-ranking-manifest'
  schemaVersion: typeof PUBLIC_ARTIFACT_SCHEMA_VERSION
  artifactMeta?: ArtifactMeta
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
    checkpoints?: Record<string, SnapshotCheckpointOption[]>
  }
  defaultFilter: SnapshotFilter
  defaultSnapshotKey: string
  summaryMode: 'browser-summary'
  fullSnapshotUrl?: string
  playerDirectoryUrl?: string
  teamDirectoryUrl?: string
  teamHistoryIndexUrl?: string
  teamHistoryUrl?: string
  regionHistoryUrl?: string
  teamCount: number
  snapshotIndex: Record<string, PublicSnapshotIndexEntry>
  snapshots?: Record<string, never>
}

export function snapshotKey(filter: SnapshotFilter) {
  return [filter.season, filter.event, filter.region, filter.checkpoint].filter((value): value is string => Boolean(value)).map(encodeURIComponent).join('__')
}

export function snapshotShardFileName(key: string) {
  return scopeArtifactFileNameForKey(key)
}

export function snapshotShardUrlPathForKey(key: string, basePath = '/data/scopes') {
  const normalizedBase = basePath.replace(/\/$/, '')
  return `${normalizedBase}/${encodeURIComponent(snapshotShardFileName(key))}`
}

export function scopeArtifactFileNameForKey(key: string) {
  return `${scopeSlugForFilter(filterFromSnapshotKey(key))}.json`
}

export function scopeArtifactFileNameForFilter(filter: SnapshotFilter) {
  return `${scopeSlugForFilter(filter)}.json`
}

export function scopeSlugForFilter(filter: SnapshotFilter) {
  if (filter.season === 'All' && filter.event === 'All' && filter.region === 'All') return 'all'
  if (/^\d{4}$/.test(filter.season) && filter.event === 'All' && filter.region === 'All' && filter.checkpoint) return `season-${filter.season}-${stableArtifactSlug(filter.checkpoint)}`
  if (/^\d{4}$/.test(filter.season) && filter.event === 'All' && filter.region === 'All') return `season-${filter.season}`
  if (filter.season === 'All' && filter.event === 'All' && filter.region !== 'All') return `region-${stableArtifactSlug(filter.region)}`
  return `scope-${stableArtifactSlug(snapshotKey(filter))}`
}

export function filterFromSnapshotKey(key: string): SnapshotFilter {
  const [season = 'All', event = 'All', region = 'All', checkpoint] = key.split('__').map((part) => decodeURIComponent(part))
  return { season, event, region: region as SnapshotFilter['region'], ...(checkpoint ? { checkpoint } : {}) }
}

export function teamHistoryShardFileName(key: string) {
  return `${key}.json`
}

export function teamHistoryShardUrlPathForKey(key: string, basePath = '/data/history/team-series') {
  const normalizedBase = basePath.replace(/\/$/, '')
  return `${normalizedBase}/${encodeURIComponent(teamHistoryShardFileName(key))}`
}

export function artifactMetaFor({
  generatedAt,
  modelVersion,
  modelConfigHash,
}: {
  generatedAt: string
  modelVersion: string
  modelConfigHash: string
}): ArtifactMeta {
  return {
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    runId: runIdForArtifact({ generatedAt, modelVersion, modelConfigHash }),
    generatedAt,
    modelVersion,
    modelConfigHash,
  }
}

export function runIdForArtifact({
  generatedAt,
  modelVersion,
  modelConfigHash,
}: {
  generatedAt: string
  modelVersion: string
  modelConfigHash: string
}) {
  const dateSlug = generatedAt.replace(/[^0-9]/g, '').slice(0, 14) || 'unknown'
  return `run_${dateSlug}_${stableArtifactSlug(modelVersion)}_${stableArtifactSlug(modelConfigHash).slice(0, 16)}`
}

export function teamIdFor(team: { team: string; region?: string; code?: string }) {
  return `team:${stableArtifactSlug(team.code || team.team)}:${stableArtifactSlug(team.team).slice(0, 56)}`
}

export function leagueIdFor(league: { league: string; region?: string }) {
  return `league:${stableArtifactSlug(league.region ?? 'global')}:${stableArtifactSlug(league.league)}`
}

export function eventIdFor(event: { event: string; season?: string | number }) {
  return `event:${stableArtifactSlug(String(event.season ?? 'all'))}:${stableArtifactSlug(event.event)}`
}

export function playerIdFor(player: { id: string }) {
  return player.id
}

function stableArtifactSlug(value: string) {
  const slug = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'unknown'
}

export type PublicStandingCompactionOptions = {
  includeRecentMatches?: boolean
  includeRatingUpdate?: boolean
}

export function compactStanding(
  standing: PublicTeamStandingInput,
  {
    includeRecentMatches = true,
    includeRatingUpdate = true,
  }: PublicStandingCompactionOptions = {},
): PublicTeamStanding {
  const matchRecord = standing.history ? teamMatchRecord(standing.history) : undefined
  return {
    teamId: standing.teamId ?? teamIdFor(standing),
    leagueId: standing.leagueId ?? leagueIdFor(standing),
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
    ...(includeRatingUpdate ? { ratingUpdate: compactRatingUpdate(standing.ratingUpdate) } : {}),
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
    eligibility: compactEligibility(standing.eligibility),
    factors: standing.factors,
    recentEvents: standing.recentEvents,
    recentMatches: includeRecentMatches ? matchRecord?.recentMatches ?? standing.recentMatches ?? [] : [],
  }
}

function compactEligibility(eligibility: PublicTeamStandingInput['eligibility']): PublicTeamStanding['eligibility'] {
  return {
    eligible: eligibility?.eligible ?? true,
    reasons: eligibility?.reasons ?? [],
  }
}

function compactRatingUpdate(update?: Partial<RatingUpdateLedger>): Partial<RatingUpdateLedger> {
  return {
    teamStableDelta: update?.teamStableDelta ?? 0,
    leagueGameDelta: update?.leagueGameDelta ?? 0,
    leaguePlacementDelta: update?.leaguePlacementDelta ?? 0,
    momentumDelta: update?.momentumDelta ?? 0,
    rosterPriorDelta: update?.rosterPriorDelta ?? 0,
    uncertaintyDelta: update?.uncertaintyDelta ?? 0,
    sideAdjustment: update?.sideAdjustment ?? 0,
    patchAdjustment: update?.patchAdjustment ?? 0,
    resultEvidence: update?.resultEvidence ?? 0,
    neutralResultResidual: update?.neutralResultResidual ?? 0,
    seriesStrengthSignal: update?.seriesStrengthSignal ?? 1,
    teamStableShare: update?.teamStableShare ?? 0,
    teamFormShare: update?.teamFormShare ?? 0,
    leagueSignalShare: update?.leagueSignalShare ?? 0,
  }
}

function teamMatchRecord(history: TeamHistoryPoint[] = []) {
  const matches = groupTeamHistoryIntoMatches(history.filter((point) => Boolean(point.date) && Boolean(point.event) && Boolean(point.opponent)))
  const resolvedMatches = matches
    .map((match) => ({ match, result: teamMatchResult(match) }))
    .filter((record): record is { match: TeamMatchGroup; result: 'W' | 'L' } => Boolean(record.result))
  const recentMatches = resolvedMatches.slice(-3).map(({ match, result }) => teamRecentMatch(match, result))
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
  assertSchemaVersion(value, 'ranking manifest')
  assertArtifactMeta(value.artifactMeta, 'ranking manifest artifactMeta')
  assertEqual(value.summaryMode, 'browser-summary', 'ranking manifest summaryMode')
  assertString(value.generatedAt, 'ranking manifest generatedAt')
  assertString(value.defaultSnapshotKey, 'ranking manifest defaultSnapshotKey')
  assertObject(value.model, 'ranking manifest model')
  assertObject(value.coverage, 'ranking manifest coverage')
  assertObject(value.dataQuality, 'ranking manifest dataQuality')
  assertArray(value.sources, 'ranking manifest sources')
  value.sources.forEach((source, index) => assertDataSourceInfo(source, `ranking manifest sources[${index}]`))
  assertObject(value.playerData, 'ranking manifest playerData')
  assertObject(value.playerData.metric, 'ranking manifest playerData metric')
  assertObject(value.walkForward, 'ranking manifest walkForward')
  assertObject(value.filterOptions, 'ranking manifest filterOptions')
  assertStringArray(value.filterOptions.seasons, 'ranking manifest filterOptions seasons')
  assertStringArray(value.filterOptions.events, 'ranking manifest filterOptions events')
  assertStringArray(value.filterOptions.regions, 'ranking manifest filterOptions regions')
  if (value.filterOptions.checkpoints !== undefined) assertCheckpointOptions(value.filterOptions.checkpoints, 'ranking manifest filterOptions checkpoints')
  assertSnapshotFilter(value.defaultFilter, 'ranking manifest defaultFilter')
  if (snapshotKey(value.defaultFilter) !== value.defaultSnapshotKey) {
    throw new Error('Invalid public artifact: ranking manifest defaultSnapshotKey must match defaultFilter')
  }
  assertOptionalDataUrlPath(value.fullSnapshotUrl, 'ranking manifest fullSnapshotUrl')
  assertOptionalDataUrlPath(value.playerDirectoryUrl, 'ranking manifest playerDirectoryUrl')
  assertOptionalDataUrlPath(value.teamDirectoryUrl, 'ranking manifest teamDirectoryUrl')
  assertOptionalDataUrlPath(value.teamHistoryIndexUrl, 'ranking manifest teamHistoryIndexUrl', '/data/history')
  assertOptionalDataUrlPath(value.teamHistoryUrl, 'ranking manifest teamHistoryUrl', '/data/history')
  assertOptionalDataUrlPath(value.regionHistoryUrl, 'ranking manifest regionHistoryUrl', '/data/history')
  assertNonNegativeInteger(value.teamCount, 'ranking manifest teamCount')
  assertObject(value.snapshotIndex, 'ranking manifest snapshotIndex')
  if (value.snapshots !== undefined) {
    assertObject(value.snapshots, 'ranking manifest snapshots')
    if (Object.keys(value.snapshots).length > 0) {
      throw new Error('Invalid public artifact: ranking manifest must not embed snapshots')
    }
  }
  for (const [key, entry] of Object.entries(value.snapshotIndex)) {
    assertPublicSnapshotIndexEntry(key, entry)
  }
  if (!value.snapshotIndex[value.defaultSnapshotKey]) {
    throw new Error('Invalid public artifact: ranking manifest defaultSnapshotKey must exist in snapshotIndex')
  }
  return value as PublicRankingManifest
}

export function parsePublicRankingShard(value: unknown): PublicRankingShard {
  assertObject(value, 'ranking shard')
  assertEqual(value.artifactKind, 'public-snapshot-shard', 'ranking shard artifactKind')
  assertArtifactMeta(value.artifactMeta, 'ranking shard artifactMeta')
  assertSnapshotFilter(value.filter, 'ranking shard filter')
  assertString(value.modelVersion, 'ranking shard modelVersion')
  assertString(value.modelConfigHash, 'ranking shard modelConfigHash')
  assertNonNegativeInteger(value.matchCount, 'ranking shard matchCount')
  assertArray(value.sourceBreakdown, 'ranking shard sourceBreakdown')
  assertArray(value.standings, 'ranking shard standings')
  assertArray(value.leagues, 'ranking shard leagues')
  assertArray(value.regions, 'ranking shard regions')
  value.regions.forEach((region, index) => assertRegionStrength(region, `ranking shard regions[${index}]`))
  return value as PublicRankingShard
}

export function parsePublicPlayerDirectory(value: unknown): PublicPlayerDirectory {
  assertObject(value, 'player directory')
  assertEqual(value.artifactKind, 'player-directory', 'player directory artifactKind')
  assertSchemaVersion(value, 'player directory')
  assertArtifactMeta(value.artifactMeta, 'player directory artifactMeta')
  assertString(value.generatedAt, 'player directory generatedAt')
  assertString(value.modelVersion, 'player directory modelVersion')
  assertString(value.modelConfigHash, 'player directory modelConfigHash')
  assertObject(value.metric, 'player directory metric')
  if ('comparisonMetrics' in value) assertArray(value.comparisonMetrics, 'player directory comparisonMetrics')
  if ('diagnostics' in value) assertObject(value.diagnostics, 'player directory diagnostics')
  assertArray(value.players, 'player directory players')
  if ('scopedPlayers' in value) assertObject(value.scopedPlayers, 'player directory scopedPlayers')
  return value as PublicPlayerDirectory
}

export function parsePublicTeamDirectory(value: unknown): PublicTeamDirectory {
  assertObject(value, 'team directory')
  assertEqual(value.artifactKind, 'team-directory', 'team directory artifactKind')
  assertSchemaVersion(value, 'team directory')
  assertArtifactMeta(value.artifactMeta, 'team directory artifactMeta')
  assertString(value.generatedAt, 'team directory generatedAt')
  assertString(value.modelVersion, 'team directory modelVersion')
  assertString(value.modelConfigHash, 'team directory modelConfigHash')
  assertNonNegativeInteger(value.teamCount, 'team directory teamCount')
  assertArray(value.teams, 'team directory teams')
  for (const [index, team] of value.teams.entries()) {
    assertTeamEntity(team, `team directory teams[${index}]`)
  }
  if (value.teams.length !== value.teamCount) {
    throw new Error('Invalid public artifact: team directory teamCount must match teams length')
  }
  return value as PublicTeamDirectory
}

export function parsePublicTeamHistory(value: unknown): PublicTeamHistoryDirectory {
  assertObject(value, 'team history')
  assertEqual(value.artifactKind, 'team-history', 'team history artifactKind')
  assertSchemaVersion(value, 'team history')
  assertArtifactMeta(value.artifactMeta, 'team history artifactMeta')
  assertString(value.generatedAt, 'team history generatedAt')
  assertString(value.modelVersion, 'team history modelVersion')
  assertString(value.modelConfigHash, 'team history modelConfigHash')
  const seriesCounts = assertTeamHistorySeriesRecord(value.series, 'team history series')
  assertNonNegativeInteger(value.teamCount, 'team history teamCount')
  assertNonNegativeInteger(value.pointCount, 'team history pointCount')
  if (seriesCounts.seriesCount !== value.teamCount) {
    throw new Error('Invalid public artifact: team history teamCount must match series count')
  }
  if (seriesCounts.pointCount !== value.pointCount) {
    throw new Error('Invalid public artifact: team history pointCount must match series points')
  }
  if (value.scopeIndex !== undefined) {
    assertObject(value.scopeIndex, 'team history scopeIndex')
    for (const [key, teamIds] of Object.entries(value.scopeIndex)) {
      assertStringArray(teamIds, `team history scopeIndex ${key}`)
    }
  }
  return value as PublicTeamHistoryDirectory
}

export function parsePublicTeamHistoryIndex(value: unknown): PublicTeamHistoryIndex {
  assertObject(value, 'team history index')
  assertEqual(value.artifactKind, 'team-history-index', 'team history index artifactKind')
  assertSchemaVersion(value, 'team history index')
  assertArtifactMeta(value.artifactMeta, 'team history index artifactMeta')
  assertString(value.generatedAt, 'team history index generatedAt')
  assertString(value.modelVersion, 'team history index modelVersion')
  assertString(value.modelConfigHash, 'team history index modelConfigHash')
  assertString(value.defaultScopeKey, 'team history index defaultScopeKey')
  assertTeamHistoryOmissionPolicy(value.omissionPolicy, 'team history index omissionPolicy')
  assertObject(value.scopeIndex, 'team history index scopeIndex')
  for (const [key, entry] of Object.entries(value.scopeIndex)) {
    assertTeamHistoryIndexEntry(key, entry)
  }
  if (!value.scopeIndex[value.defaultScopeKey]) {
    throw new Error('Invalid public artifact: team history index defaultScopeKey must exist in scopeIndex')
  }
  return value as PublicTeamHistoryIndex
}

export function parsePublicTeamHistoryShard(value: unknown): PublicTeamHistoryShard {
  assertObject(value, 'team history shard')
  assertEqual(value.artifactKind, 'team-history-scope', 'team history shard artifactKind')
  assertSchemaVersion(value, 'team history shard')
  assertArtifactMeta(value.artifactMeta, 'team history shard artifactMeta')
  assertString(value.generatedAt, 'team history shard generatedAt')
  assertString(value.modelVersion, 'team history shard modelVersion')
  assertString(value.modelConfigHash, 'team history shard modelConfigHash')
  assertSnapshotFilter(value.filter, 'team history shard filter')
  assertTeamHistoryOmissionPolicy(value.omissionPolicy, 'team history shard omissionPolicy')
  assertNonNegativeInteger(value.teamCount, 'team history shard teamCount')
  assertNonNegativeInteger(value.pointCount, 'team history shard pointCount')
  const seriesCounts = assertTeamHistorySeriesRecord(value.series, 'team history shard series')
  if (seriesCounts.seriesCount !== value.teamCount) {
    throw new Error('Invalid public artifact: team history shard teamCount must match series count')
  }
  if (seriesCounts.pointCount !== value.pointCount) {
    throw new Error('Invalid public artifact: team history shard pointCount must match series points')
  }
  return value as PublicTeamHistoryShard
}

export function parsePublicRegionHistory(value: unknown): PublicRegionHistoryDirectory {
  assertObject(value, 'region history')
  assertEqual(value.artifactKind, 'region-history', 'region history artifactKind')
  assertSchemaVersion(value, 'region history')
  assertArtifactMeta(value.artifactMeta, 'region history artifactMeta')
  assertString(value.generatedAt, 'region history generatedAt')
  assertString(value.modelVersion, 'region history modelVersion')
  assertString(value.modelConfigHash, 'region history modelConfigHash')
  assertString(value.defaultScopeKey, 'region history defaultScopeKey')
  assertObject(value.scopes, 'region history scopes')
  for (const [key, scope] of Object.entries(value.scopes)) {
    assertRegionHistoryScope(key, scope)
  }
  if (!value.scopes[value.defaultScopeKey]) {
    throw new Error('Invalid public artifact: region history defaultScopeKey must exist in scopes')
  }
  return value as PublicRegionHistoryDirectory
}

function assertPublicSnapshotIndexEntry(key: string, value: unknown): asserts value is PublicSnapshotIndexEntry {
  assertObject(value, `ranking manifest snapshotIndex ${key}`)
  assertSnapshotFilter(value.filter, `ranking manifest snapshotIndex ${key} filter`)
  if (snapshotKey(value.filter) !== key) {
    throw new Error(`Invalid public artifact: ranking manifest snapshotIndex key ${key} must match its filter`)
  }
  const url = value.url
  assertArtifactUrl(url, `ranking manifest snapshotIndex ${key} url`, '/data/scopes')
  if (isLocalDataUrl(url)) assertEqual(url, snapshotShardUrlPathForKey(key), `ranking manifest snapshotIndex ${key} url`)
  assertNonNegativeInteger(value.matchCount, `ranking manifest snapshotIndex ${key} matchCount`)
  assertArray(value.sourceBreakdown, `ranking manifest snapshotIndex ${key} sourceBreakdown`)
}

function assertDataSourceInfo(value: unknown, label: string): asserts value is DataSourceInfo {
  assertObject(value, label)
  assertString(value.name, `${label} name`)
  assertEnum(value.kind, ['match-data', 'game-stats', 'official-reference', 'seed'], `${label} kind`)
  assertString(value.description, `${label} description`)
  assertEnum(value.status, ['active', 'planned', 'reference-only'], `${label} status`)
  assertOptionalString(value.url, `${label} url`)
  assertOptionalString(value.retrievedAt, `${label} retrievedAt`)
  assertOptionalString(value.coverageStart, `${label} coverageStart`)
  assertOptionalString(value.coverageEnd, `${label} coverageEnd`)
  assertOptionalNonNegativeInteger(value.rowCount, `${label} rowCount`)
  if (value.warnings !== undefined) {
    assertArray(value.warnings, `${label} warnings`)
    value.warnings.forEach((warning, index) => assertDataSourceWarning(warning, `${label} warnings[${index}]`))
  }
}

function assertDataSourceWarning(value: unknown, label: string) {
  assertObject(value, label)
  assertEnum(value.kind, ['freshness', 'rate-limit', 'download', 'coverage', 'source-policy'], `${label} kind`)
  assertEnum(value.severity, ['info', 'warning', 'error'], `${label} severity`)
  assertString(value.message, `${label} message`)
  assertOptionalString(value.observedAt, `${label} observedAt`)
}

function assertTeamHistoryIndexEntry(key: string, value: unknown): asserts value is PublicTeamHistoryIndexEntry {
  assertObject(value, `team history index scopeIndex ${key}`)
  assertSnapshotFilter(value.filter, `team history index scopeIndex ${key} filter`)
  if (snapshotKey(value.filter) !== key) {
    throw new Error(`Invalid public artifact: team history index scopeIndex key ${key} must match its filter`)
  }
  const url = value.url
  assertArtifactUrl(url, `team history index scopeIndex ${key} url`, '/data/history')
  if (isLocalDataUrl(url)) assertEqual(url, teamHistoryShardUrlPathForKey(key), `team history index scopeIndex ${key} url`)
  assertNonNegativeInteger(value.teamCount, `team history index scopeIndex ${key} teamCount`)
  assertNonNegativeInteger(value.pointCount, `team history index scopeIndex ${key} pointCount`)
}

function assertTeamEntity(value: unknown, label: string): asserts value is PublicTeamEntity {
  assertObject(value, label)
  assertString(value.teamId, `${label} teamId`)
  assertString(value.name, `${label} name`)
  assertString(value.code, `${label} code`)
  assertString(value.region, `${label} region`)
  assertString(value.league, `${label} league`)
  assertString(value.leagueId, `${label} leagueId`)
  if (value.providerAliases !== undefined) {
    assertObject(value.providerAliases, `${label} providerAliases`)
    for (const [provider, aliases] of Object.entries(value.providerAliases)) {
      assertEnum(provider, ['oracles-elixir', 'leaguepedia-cargo', 'manual'], `${label} providerAliases provider`)
      assertStringArray(aliases, `${label} providerAliases ${provider}`)
    }
  }
}

function assertRegionHistoryScope(key: string, value: unknown): asserts value is PublicRegionHistoryScope {
  assertObject(value, `region history scopes ${key}`)
  assertSnapshotFilter(value.filter, `region history scopes ${key} filter`)
  if (snapshotKey(value.filter) !== key) {
    throw new Error(`Invalid public artifact: region history scopes key ${key} must match its filter`)
  }
  assertNonNegativeInteger(value.regionCount, `region history scopes ${key} regionCount`)
  assertNonNegativeInteger(value.pointCount, `region history scopes ${key} pointCount`)
  const seriesCounts = assertRegionHistorySeriesRecord(value.series, `region history scopes ${key} series`)
  if (seriesCounts.seriesCount !== value.regionCount) {
    throw new Error(`Invalid public artifact: region history scopes ${key} regionCount must match series count`)
  }
  if (seriesCounts.pointCount !== value.pointCount) {
    throw new Error(`Invalid public artifact: region history scopes ${key} pointCount must match series points`)
  }
}

function assertTeamHistorySeriesRecord(value: unknown, label: string) {
  assertObject(value, label)
  let pointCount = 0
  for (const [key, series] of Object.entries(value)) {
    assertTeamHistorySeries(series, `${label} ${key}`)
    pointCount += series.points.length
  }
  return { seriesCount: Object.keys(value).length, pointCount }
}

function assertTeamHistorySeries(value: unknown, label: string): asserts value is PublicTeamHistorySeries {
  assertObject(value, label)
  assertString(value.team, `${label} team`)
  assertOptionalString(value.code, `${label} code`)
  assertOptionalString(value.region, `${label} region`)
  assertArray(value.points, `${label} points`)
  for (const [index, point] of value.points.entries()) {
    assertHistoryPoint(point, `${label} points[${index}]`, assertTeamHistoryPointContext)
  }
}

function assertRegionHistorySeriesRecord(value: unknown, label: string) {
  assertObject(value, label)
  let pointCount = 0
  for (const [key, series] of Object.entries(value)) {
    assertRegionHistorySeries(series, `${label} ${key}`)
    pointCount += series.points.length
  }
  return { seriesCount: Object.keys(value).length, pointCount }
}

function assertRegionHistorySeries(value: unknown, label: string): asserts value is PublicRegionHistorySeries {
  assertObject(value, label)
  assertString(value.region, `${label} region`)
  assertArray(value.points, `${label} points`)
  for (const [index, point] of value.points.entries()) {
    assertHistoryPoint(point, `${label} points[${index}]`, assertRegionHistoryPointContext)
  }
}

function assertHistoryPoint(
  value: unknown,
  label: string,
  assertContext: (value: Record<string, unknown>, label: string) => void,
) {
  assertArray(value, label)
  if (value.length < 3 || value.length > 4) {
    throw new Error(`Invalid public artifact: ${label} must be a [date, score, rank, context?] tuple`)
  }
  assertDateString(value[0], `${label} date`)
  assertNumber(value[1], `${label} score`)
  assertNonNegativeInteger(value[2], `${label} rank`)
  if (value[3] !== undefined) {
    assertObject(value[3], `${label} context`)
    assertContext(value[3], `${label} context`)
  }
}

function assertTeamHistoryPointContext(value: Record<string, unknown>, label: string) {
  assertOptionalEnum(value.kind, ['match', 'standing-adjustment'], `${label} kind`)
  assertOptionalEnum(value.adjustmentReason, ['published-standing-reconciliation'], `${label} adjustmentReason`)
  assertOptionalString(value.event, `${label} event`)
  assertOptionalString(value.opponent, `${label} opponent`)
  assertOptionalNumber(value.delta, `${label} delta`)
  assertOptionalString(value.tier, `${label} tier`)
  assertOptionalEnum(value.result, ['W', 'L'], `${label} result`)
  assertOptionalNonNegativeInteger(value.wins, `${label} wins`)
  assertOptionalNonNegativeInteger(value.losses, `${label} losses`)
  assertOptionalNonNegativeInteger(value.games, `${label} games`)
  assertOptionalNonNegativeInteger(value.bestOf, `${label} bestOf`)
  assertOptionalString(value.sourceProvider, `${label} sourceProvider`)
  assertOptionalString(value.sourceGameId, `${label} sourceGameId`)
  assertOptionalString(value.sourceMatchId, `${label} sourceMatchId`)
  assertOptionalString(value.sourceFileName, `${label} sourceFileName`)
  assertOptionalString(value.sourceUrl, `${label} sourceUrl`)
  if (value.sourceGameIds !== undefined) assertStringArray(value.sourceGameIds, `${label} sourceGameIds`)
  if (value.model !== undefined) assertTeamHistoryModelContext(value.model, `${label} model`)
}

function assertTeamHistoryModelContext(value: unknown, label: string) {
  assertObject(value, label)
  assertOptionalNumber(value.e, `${label} e`)
  assertOptionalNumber(value.r, `${label} r`)
  assertOptionalNumber(value.v, `${label} v`)
  assertOptionalNumber(value.s, `${label} s`)
  if (value.a !== undefined) {
    assertArray(value.a, `${label} a`)
    for (const [index, entry] of value.a.entries()) {
      assertArray(entry, `${label} a[${index}]`)
      if (entry.length !== 2) {
        throw new Error(`Invalid public artifact: ${label} a[${index}] must be a [key, value] tuple`)
      }
      assertEnum(entry[0], ['s', 'l', 'p', 'f', 'r', 'u'], `${label} a[${index}] key`)
      assertNumber(entry[1], `${label} a[${index}] value`)
    }
  }
  if (value.c !== undefined) {
    assertArray(value.c, `${label} c`)
    if (value.c.length !== 5) {
      throw new Error(`Invalid public artifact: ${label} c must be a five-number component tuple`)
    }
    for (const [index, entry] of value.c.entries()) {
      assertNumber(entry, `${label} c[${index}]`)
    }
  }
}

function assertRegionHistoryPointContext(value: Record<string, unknown>, label: string) {
  assertOptionalString(value.event, `${label} event`)
  assertOptionalString(value.tier, `${label} tier`)
  if (value.leagues !== undefined) assertStringArray(value.leagues, `${label} leagues`)
  if (value.opponentRegions !== undefined) assertStringArray(value.opponentRegions, `${label} opponentRegions`)
  assertOptionalNonNegativeInteger(value.wins, `${label} wins`)
  assertOptionalNonNegativeInteger(value.losses, `${label} losses`)
  assertOptionalNumber(value.winsOverExpected, `${label} winsOverExpected`)
  assertOptionalNumber(value.opponentAdjustedWinRate, `${label} opponentAdjustedWinRate`)
  assertOptionalEnum(value.source, ['league-strength-history'], `${label} source`)
}

function assertSnapshotFilter(value: unknown, label: string): asserts value is SnapshotFilter {
  assertObject(value, label)
  assertString(value.season, `${label} season`)
  assertString(value.event, `${label} event`)
  assertString(value.region, `${label} region`)
  assertOptionalString(value.checkpoint, `${label} checkpoint`)
}

function assertCheckpointOptions(value: unknown, label: string): asserts value is Record<string, SnapshotCheckpointOption[]> {
  assertObject(value, label)
  for (const [season, entries] of Object.entries(value)) {
    assertArray(entries, `${label} ${season}`)
    entries.forEach((entry, index) => assertCheckpointOption(entry, `${label} ${season}[${index}]`))
  }
}

function assertCheckpointOption(value: unknown, label: string): asserts value is SnapshotCheckpointOption {
  assertObject(value, label)
  assertString(value.id, `${label} id`)
  assertString(value.season, `${label} season`)
  assertString(value.label, `${label} label`)
  assertString(value.startDate, `${label} startDate`)
  assertString(value.endDate, `${label} endDate`)
  assertString(value.boundaryEvent, `${label} boundaryEvent`)
  assertOptionalString(value.previousEndDate, `${label} previousEndDate`)
  assertString(value.description, `${label} description`)
}

function assertSchemaVersion(value: Record<string, unknown>, label: string) {
  assertEqual(value.schemaVersion, PUBLIC_ARTIFACT_SCHEMA_VERSION, `${label} schemaVersion`)
}

function assertArtifactMeta(value: unknown, label: string): asserts value is ArtifactMeta {
  assertObject(value, label)
  assertEqual(value.schemaVersion, PUBLIC_ARTIFACT_SCHEMA_VERSION, `${label} schemaVersion`)
  assertString(value.runId, `${label} runId`)
  assertString(value.generatedAt, `${label} generatedAt`)
  assertString(value.modelVersion, `${label} modelVersion`)
  assertString(value.modelConfigHash, `${label} modelConfigHash`)
}

function assertOptionalDataUrlPath(value: unknown, label: string, basePath = '/data') {
  if (value === undefined) return
  assertArtifactUrl(value, label, basePath)
}

function assertArtifactUrl(value: unknown, label: string, basePath = '/data'): asserts value is string {
  assertString(value, label)
  if (isLocalDataUrl(value)) {
    assertDataUrlPath(value, label, basePath)
    return
  }
  assertHttpsArtifactUrl(value, label)
}

function assertDataUrlPath(value: unknown, label: string, basePath = '/data'): asserts value is string {
  assertString(value, label)
  const normalizedBase = basePath.replace(/\/$/, '')
  if (!value.startsWith(`${normalizedBase}/`)) {
    throw new Error(`Invalid public artifact: ${label} must be rooted under ${normalizedBase}/`)
  }
  assertCleanUrlPath(value, label)
  const segments = value.split('/')
  assertCleanPathSegments(segments, label)
}

function assertHttpsArtifactUrl(value: string, label: string) {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`Invalid public artifact: ${label} must be a /data path or https URL`)
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(`Invalid public artifact: ${label} must be a clean https URL`)
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`Invalid public artifact: ${label} must be a clean URL path`)
  }
  assertCleanUrlPath(value, label)
  assertCleanPathSegments(parsed.pathname.split('/'), label)
}

function assertCleanUrlPath(value: string, label: string) {
  if (value.includes('\\') || value.includes('?') || value.includes('#') || hasControlCharacter(value)) {
    throw new Error(`Invalid public artifact: ${label} must be a clean URL path`)
  }
}

function assertCleanPathSegments(segments: string[], label: string) {
  if (segments.some((segment, index) => index > 0 && segment.length === 0)) {
    throw new Error(`Invalid public artifact: ${label} must not contain empty path segments`)
  }
  for (const segment of segments.slice(1)) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      throw new Error(`Invalid public artifact: ${label} must use valid percent encoding`)
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw new Error(`Invalid public artifact: ${label} must not contain traversal or encoded path separators`)
    }
  }
}

function isLocalDataUrl(value: string) {
  return value.startsWith('/data/')
}

function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) return true
  }
  return false
}

function assertRegionStrength(value: unknown, label: string): asserts value is RegionStrength {
  assertObject(value, label)
  assertString(value.region, `${label} region`)
  assertNumber(value.rank, `${label} rank`)
  assertNumber(value.score, `${label} score`)
  assertNumber(value.topTeamRating, `${label} topTeamRating`)
  assertNonNegativeInteger(value.teamCount, `${label} teamCount`)
  assertNonNegativeInteger(value.ecosystemTeamCount, `${label} ecosystemTeamCount`)
  assertNonNegativeInteger(value.leagueCount, `${label} leagueCount`)
  assertNonNegativeInteger(value.ecosystemLeagueCount, `${label} ecosystemLeagueCount`)
  assertStringArray(value.flagshipLeagues, `${label} flagshipLeagues`)
  assertNumber(value.connectivity, `${label} connectivity`)
  assertNumber(value.internationalWins, `${label} internationalWins`)
  assertNumber(value.internationalLosses, `${label} internationalLosses`)
  if (value.internationalWinRate !== undefined) assertNumber(value.internationalWinRate, `${label} internationalWinRate`)
  if (value.expectedWins !== undefined) assertNumber(value.expectedWins, `${label} expectedWins`)
  if (value.winsOverExpected !== undefined) assertNumber(value.winsOverExpected, `${label} winsOverExpected`)
  if (value.opponentAdjustedWinRate !== undefined) assertNumber(value.opponentAdjustedWinRate, `${label} opponentAdjustedWinRate`)
  if (value.averageOpponentRating !== undefined) assertNumber(value.averageOpponentRating, `${label} averageOpponentRating`)
  if (value.flagshipLeague !== undefined) assertString(value.flagshipLeague, `${label} flagshipLeague`)
  if (value.tier !== undefined) assertString(value.tier, `${label} tier`)
  assertArray(value.topTeams, `${label} topTeams`)
  value.topTeams.forEach((team, index) => assertRegionTopTeam(team, `${label} topTeams[${index}]`))
}

function assertRegionTopTeam(value: unknown, label: string) {
  assertObject(value, label)
  assertString(value.team, `${label} team`)
  if (value.code !== undefined) assertString(value.code, `${label} code`)
  assertNumber(value.rating, `${label} rating`)
  if (value.rank !== undefined) assertNumber(value.rank, `${label} rank`)
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

function assertOptionalString(value: unknown, label: string): asserts value is string | undefined {
  if (value === undefined) return
  assertString(value, label)
}

function assertDateString(value: unknown, label: string): asserts value is string {
  assertString(value, label)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid public artifact: ${label} must be an ISO date string`)
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  assertArray(value, label)
  for (const [index, entry] of value.entries()) {
    assertString(entry, `${label}[${index}]`)
  }
}

function assertNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid public artifact: ${label} must be a finite number`)
  }
}

function assertOptionalNumber(value: unknown, label: string): asserts value is number | undefined {
  if (value === undefined) return
  assertNumber(value, label)
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  assertNumber(value, label)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid public artifact: ${label} must be a non-negative integer`)
  }
}

function assertOptionalNonNegativeInteger(value: unknown, label: string): asserts value is number | undefined {
  if (value === undefined) return
  assertNonNegativeInteger(value, label)
}

function assertEnum<T extends string>(value: unknown, options: readonly T[], label: string): asserts value is T {
  assertString(value, label)
  if (!options.includes(value as T)) {
    throw new Error(`Invalid public artifact: ${label} must be one of ${options.join(', ')}`)
  }
}

function assertOptionalEnum<T extends string>(value: unknown, options: readonly T[], label: string): asserts value is T | undefined {
  if (value === undefined) return
  assertEnum(value, options, label)
}

function assertTeamHistoryOmissionPolicy(value: unknown, label: string) {
  assertObject(value, label)
  assertNonNegativeInteger(value.minimumPointsPerSeries, `${label} minimumPointsPerSeries`)
  assertNonNegativeInteger(value.omittedSeriesCount, `${label} omittedSeriesCount`)
  assertString(value.reason, `${label} reason`)
}

function assertEqual<T>(value: unknown, expected: T, label: string): asserts value is T {
  if (value !== expected) {
    throw new Error(`Invalid public artifact: ${label} must be ${String(expected)}`)
  }
}
