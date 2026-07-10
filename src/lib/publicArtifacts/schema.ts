import type {
  DeservedStandingEligibilityLabel,
  DeservedStandingLeaderboard,
  FactorBreakdown,
  LeagueStrength,
  PlayerAppearanceSummary,
  PlayerDiagnostics,
  PlayerIndividualResidual,
  PlayerStanding,
  PublishedRatingScale,
  RatingComponents,
  RatingUpdateLedger,
  Region,
  Role,
  RosterBasis,
  SourceTrace,
  TeamEligibility,
  TeamHistoryPoint,
} from '../../types'
import type { RegionStrength } from '../regionStrength'
import {
  tournamentFamilyForEvent,
  type InternationalTournamentFamilyId,
  type TournamentInstanceId,
  type TournamentLifecycleStatus,
} from '../internationalTournaments'
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

export const PUBLIC_ARTIFACT_SCHEMA_VERSION = 22 as const
const PUBLIC_TEAM_RECENT_MATCH_LIMIT = 25

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
  result: 'W' | 'L' | 'T'
  rating: number
  delta: number
  wins?: number
  losses?: number
  games?: number
  bestOf?: number
  seriesId?: string
  formatBasis?: SourceTrace['formatBasis']
  formatConfidence?: SourceTrace['formatConfidence']
}

export type PublicTournamentAppearance = {
  family: InternationalTournamentFamilyId
  event: string
  lastDate: string
  matchCount: number
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
  recordBasis: PublicRecordBasis
  scoreFamily: PublicScoreFamilyId
  confidence: number
  uncertainty: number
  form: string[]
  strongestFactor: keyof FactorBreakdown
  eligibility: Pick<TeamEligibility, 'eligible' | 'reasons'> & Partial<TeamEligibility>
  factors: FactorBreakdown
  recentEvents: string[]
  tournamentAppearances?: PublicTournamentAppearance[]
  recentMatches: PublicRecentMatch[]
  deservedStanding?: PublicDeservedStandingComparison
}

export type PublicDeservedStandingComparison = {
  leaderboard: DeservedStandingLeaderboard
  rank: number
  score: number
  rankDeltaFromPower: number
  scoreDeltaFromPower: number
  eligibility: DeservedStandingEligibilityLabel
  rosterValidity: number
  winsAboveExpectation: number
  gameDifferentialAboveExpectation: number
  resumePoints: number
  scheduleStrengthPoints: number
  stagePoints: number
  incomingPlayerBridgeCredit: number
}

export type PublicRecordBasis = 'standing-record-from-ranking-model' | 'grouped-match-record-from-scope-history'
export type PublicScoreFamilyId = 'power-index' | 'deserved-standing'
export type PublicScoreFamilyInfo = {
  id: PublicScoreFamilyId
  label: string
  description: string
  rankField: string
  scoreField: string
  target: string
  recordBasis?: PublicRecordBasis
}

export const publicScoreFamilies = [
  {
    id: 'power-index',
    label: 'Power Index',
    description: 'Predictive latent team-strength score; records are evidence, not the rank target.',
    rankField: 'rank',
    scoreField: 'rating',
    target: 'context-neutral-latent-team-strength',
  },
  {
    id: 'deserved-standing',
    label: 'Deserved Standing',
    description: 'Resume check based on scoped results, opponent strength, schedule, event weight, and current-roster validity.',
    rankField: 'deservedStanding.rank',
    scoreField: 'deservedStanding.score',
    target: 'current-scope-resume',
    recordBasis: 'grouped-match-record-from-scope-history',
  },
] as const satisfies readonly PublicScoreFamilyInfo[]

type PublicTeamStandingInput = Omit<PublicTeamStanding, 'recentMatches' | 'teamId' | 'leagueId' | 'recordBasis' | 'scoreFamily'> & Partial<Pick<PublicTeamStanding, 'teamId' | 'leagueId' | 'recordBasis' | 'scoreFamily'>> & {
  history?: TeamHistoryPoint[]
  recentMatches?: PublicRecentMatch[]
}

export type PublicRankingShard = {
  artifactKind: 'public-snapshot-shard'
  artifactMeta?: ArtifactMeta
  ratingScale: PublishedRatingScale
  filter: SnapshotFilter
  modelVersion: string
  modelConfigHash: string
  matchCount: number
  sourceBreakdown: SnapshotSourceBreakdown[]
  scoreFamilies: PublicScoreFamilyInfo[]
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
    result: 'W' | 'L' | 'T'
    wins?: number
    losses?: number
    games?: number
    bestOf?: number
    seriesId?: string
    formatBasis?: SourceTrace['formatBasis']
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
  kind?: 'match' | 'standing-adjustment' | 'tournament-start' | 'tournament-end' | 'tournament-today' | 'tournament-latest-data'
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
  seriesId?: string
  formatBasis?: SourceTrace['formatBasis']
  formatConfidence?: SourceTrace['formatConfidence']
  seriesState?: SourceTrace['seriesState']
  sourceProvider?: string
  sourceGameId?: string
  sourceMatchId?: string
  officialEventId?: string
  officialMatchId?: string
  officialGameId?: string
  sourceGameIds?: string[]
  sourceFileName?: string
  sourceUrl?: string
  model?: PublicTeamHistoryModelContext
}

// Compact browser-history model context. Short keys keep team-history.json inside
// the public data budget: e=expected win probability, r=result residual,
// v=result evidence, s=series strength signal, w=applied event weight, a=update attribution entries,
// c=current rating components [league, stable, roster, form, context].
export type PublicTeamHistoryModelContext = {
  e?: number
  r?: number
  v?: number
  s?: number
  w?: number
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
  ratingScale: PublishedRatingScale
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
  ratingScale: PublishedRatingScale
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
  ratingScale: PublishedRatingScale
  generatedAt: string
  modelVersion: string
  modelConfigHash: string
  defaultScopeKey: string
  omissionPolicy: PublicTeamHistoryDirectory['omissionPolicy']
  scopeIndex: Record<string, PublicTeamHistoryIndexEntry>
}

export type PublicTournamentMovementIndexEntry = {
  id: TournamentInstanceId
  family: InternationalTournamentFamilyId
  season: string
  label: string
  status: TournamentLifecycleStatus
  startDate: string
  boundaryDate: string
  ratedThroughDate: string
  scheduledEndDate?: string
  dataLag: boolean
  participantCount: number
  url: string
}

export type PublicTournamentMovementTeam = {
  teamId: string
  team: string
  code: string
  eligible: boolean
  eligibilityReasons: TeamEligibility['reasons']
  startRank: number
  endRank: number
  rankMovement: number
  startRating: number
  endRating: number
  ratingDelta: number
  points: PublicTeamHistoryPoint[]
}

export type PublicTournamentMovementIndex = {
  artifactKind: 'tournament-movement-index'
  schemaVersion: typeof PUBLIC_ARTIFACT_SCHEMA_VERSION
  artifactMeta: ArtifactMeta
  ratingScale: PublishedRatingScale
  generatedAt: string
  modelVersion: string
  modelConfigHash: string
  tournaments: PublicTournamentMovementIndexEntry[]
}

export type PublicTournamentMovementShard = {
  artifactKind: 'tournament-movement'
  schemaVersion: typeof PUBLIC_ARTIFACT_SCHEMA_VERSION
  artifactMeta: ArtifactMeta
  ratingScale: PublishedRatingScale
  generatedAt: string
  modelVersion: string
  modelConfigHash: string
  id: TournamentInstanceId
  family: InternationalTournamentFamilyId
  season: string
  label: string
  status: TournamentLifecycleStatus
  startDate: string
  boundaryDate: string
  ratedThroughDate: string
  scheduledEndDate?: string
  dataLag: boolean
  participantCount: number
  teams: PublicTournamentMovementTeam[]
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
  source?: 'league-strength-history' | 'published-region-score'
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
  ratingScale: PublishedRatingScale
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
  ratingScale: PublishedRatingScale
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
  tournamentMovementIndexUrl: string
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

export function tournamentMovementShardFileName(id: TournamentInstanceId) {
  return `${id.replace(':', '-')}.json`
}

export function tournamentMovementShardUrlPathForId(id: TournamentInstanceId, basePath = '/data/history/tournament-moves') {
  const normalizedBase = basePath.replace(/\/$/, '')
  return `${normalizedBase}/${encodeURIComponent(tournamentMovementShardFileName(id))}`
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
  const tournamentAppearances = matchRecord?.tournamentAppearances ?? standing.tournamentAppearances ?? []
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
    recordBasis: standing.recordBasis ?? (matchRecord ? 'grouped-match-record-from-scope-history' : 'standing-record-from-ranking-model'),
    scoreFamily: standing.scoreFamily ?? 'power-index',
    confidence: standing.confidence,
    uncertainty: standing.uncertainty,
    form: matchRecord?.form ?? standing.form,
    strongestFactor: standing.strongestFactor,
    eligibility: compactEligibility(standing.eligibility),
    factors: standing.factors,
    recentEvents: standing.recentEvents,
    ...(tournamentAppearances.length ? { tournamentAppearances } : {}),
    recentMatches: includeRecentMatches ? matchRecord?.recentMatches ?? standing.recentMatches ?? [] : [],
    ...(standing.deservedStanding ? { deservedStanding: standing.deservedStanding } : {}),
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
    .filter((record): record is { match: TeamMatchGroup; result: 'W' | 'L' | 'T' } => Boolean(record.result))
  const recentMatches = resolvedMatches.slice(-PUBLIC_TEAM_RECENT_MATCH_LIMIT).map(({ match, result }) => teamRecentMatch(match, result))
  const wins = resolvedMatches.filter((match) => match.result === 'W').length
  const losses = resolvedMatches.filter((match) => match.result === 'L').length

  return {
    wins,
    losses,
    form: resolvedMatches.slice(-5).map((match) => match.result),
    tournamentAppearances: tournamentAppearancesForMatches(resolvedMatches.map((record) => record.match)),
    recentMatches,
  }
}

function tournamentAppearancesForMatches(matches: TeamMatchGroup[]): PublicTournamentAppearance[] {
  const appearances = new Map<InternationalTournamentFamilyId, PublicTournamentAppearance>()

  for (const match of matches) {
    const latest = match.entries.at(-1)
    if (!latest) continue
    const family = tournamentFamilyForEvent(latest.event)
    if (!family) continue

    const current = appearances.get(family)
    appearances.set(family, {
      family,
      event: !current || latest.date >= current.lastDate ? latest.event : current.event,
      lastDate: !current || latest.date >= current.lastDate ? latest.date : current.lastDate,
      matchCount: (current?.matchCount ?? 0) + 1,
    })
  }

  return [...appearances.values()].sort((left, right) => right.lastDate.localeCompare(left.lastDate) || left.family.localeCompare(right.family))
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
  if (point.source?.seriesId) return ['canonical-series', point.source.seriesId].join('\u0000')
  return [
    'series',
    point.date,
    point.opponent,
  ].join('\u0000')
}

function teamRecentMatch(group: TeamMatchGroup, result: 'W' | 'L' | 'T'): PublicRecentMatch {
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
    ...(latest.source.seriesId ? { seriesId: latest.source.seriesId } : {}),
    ...(latest.source.formatBasis ? { formatBasis: latest.source.formatBasis } : {}),
    ...(latest.source.formatConfidence ? { formatConfidence: latest.source.formatConfidence } : {}),
  }
}

function teamMatchResult(group: TeamMatchGroup) {
  const latest = group.entries.at(-1)
  if (latest?.source?.seriesState !== undefined) {
    if (latest.source.seriesState !== 'completed') return undefined
    if (latest.source.seriesOutcome === 0.5) return 'T'
    if (latest.source.seriesOutcome === 1) return 'W'
    if (latest.source.seriesOutcome === 0) return 'L'
    return undefined
  }
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
  assertPublishedRatingScale(value.ratingScale, 'ranking manifest ratingScale')
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
  assertArtifactUrl(value.tournamentMovementIndexUrl, 'ranking manifest tournamentMovementIndexUrl', '/data/history/tournament-moves')
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
  assertPublishedRatingScale(value.ratingScale, 'ranking shard ratingScale')
  assertSnapshotFilter(value.filter, 'ranking shard filter')
  assertString(value.modelVersion, 'ranking shard modelVersion')
  assertString(value.modelConfigHash, 'ranking shard modelConfigHash')
  assertNonNegativeInteger(value.matchCount, 'ranking shard matchCount')
  assertArray(value.sourceBreakdown, 'ranking shard sourceBreakdown')
  assertArray(value.scoreFamilies, 'ranking shard scoreFamilies')
  value.scoreFamilies.forEach((family, index) => assertPublicScoreFamily(family, `ranking shard scoreFamilies[${index}]`))
  assertArray(value.standings, 'ranking shard standings')
  assertArray(value.leagues, 'ranking shard leagues')
  assertArray(value.regions, 'ranking shard regions')
  value.sourceBreakdown.forEach((source, index) => assertSnapshotSourceBreakdown(source, `ranking shard sourceBreakdown[${index}]`))
  value.standings.forEach((standing, index) => assertPublicTeamStanding(standing, `ranking shard standings[${index}]`))
  value.leagues.forEach((league, index) => assertLeagueStrength(league, `ranking shard leagues[${index}]`))
  value.regions.forEach((region, index) => assertRegionStrength(region, `ranking shard regions[${index}]`))
  return value as PublicRankingShard
}

function assertPublicScoreFamily(value: unknown, label: string): asserts value is PublicScoreFamilyInfo {
  assertObject(value, label)
  assertEnum(value.id, ['power-index', 'deserved-standing'], `${label} id`)
  assertString(value.label, `${label} label`)
  assertString(value.description, `${label} description`)
  assertString(value.rankField, `${label} rankField`)
  assertString(value.scoreField, `${label} scoreField`)
  assertString(value.target, `${label} target`)
  if (value.recordBasis !== undefined) {
    assertEnum(value.recordBasis, ['standing-record-from-ranking-model', 'grouped-match-record-from-scope-history'], `${label} recordBasis`)
  }
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
  assertPublishedRatingScale(value.ratingScale, 'team history ratingScale')
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
  assertPublishedRatingScale(value.ratingScale, 'team history index ratingScale')
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
  assertPublishedRatingScale(value.ratingScale, 'team history shard ratingScale')
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

export function parsePublicTournamentMovementIndex(value: unknown): PublicTournamentMovementIndex {
  assertObject(value, 'tournament movement index')
  assertEqual(value.artifactKind, 'tournament-movement-index', 'tournament movement index artifactKind')
  assertSchemaVersion(value, 'tournament movement index')
  assertArtifactMeta(value.artifactMeta, 'tournament movement index artifactMeta')
  assertPublishedRatingScale(value.ratingScale, 'tournament movement index ratingScale')
  assertString(value.generatedAt, 'tournament movement index generatedAt')
  assertString(value.modelVersion, 'tournament movement index modelVersion')
  assertString(value.modelConfigHash, 'tournament movement index modelConfigHash')
  assertArray(value.tournaments, 'tournament movement index tournaments')
  const ids = new Set<string>()
  for (const [index, entry] of value.tournaments.entries()) {
    assertTournamentMovementIndexEntry(entry, `tournament movement index tournaments[${index}]`)
    if (ids.has(entry.id)) throw new Error(`Invalid public artifact: duplicate tournament movement id ${entry.id}`)
    ids.add(entry.id)
  }
  return value as PublicTournamentMovementIndex
}

export function parsePublicTournamentMovementShard(value: unknown): PublicTournamentMovementShard {
  assertObject(value, 'tournament movement shard')
  assertEqual(value.artifactKind, 'tournament-movement', 'tournament movement shard artifactKind')
  assertSchemaVersion(value, 'tournament movement shard')
  assertArtifactMeta(value.artifactMeta, 'tournament movement shard artifactMeta')
  assertPublishedRatingScale(value.ratingScale, 'tournament movement shard ratingScale')
  assertString(value.generatedAt, 'tournament movement shard generatedAt')
  assertString(value.modelVersion, 'tournament movement shard modelVersion')
  assertString(value.modelConfigHash, 'tournament movement shard modelConfigHash')
  assertTournamentIdentity(value, 'tournament movement shard')
  assertDateString(value.startDate, 'tournament movement shard startDate')
  assertDateString(value.boundaryDate, 'tournament movement shard boundaryDate')
  assertDateString(value.ratedThroughDate, 'tournament movement shard ratedThroughDate')
  if (value.scheduledEndDate !== undefined) assertDateString(value.scheduledEndDate, 'tournament movement shard scheduledEndDate')
  assertBoolean(value.dataLag, 'tournament movement shard dataLag')
  assertNonNegativeInteger(value.participantCount, 'tournament movement shard participantCount')
  assertArray(value.teams, 'tournament movement shard teams')
  value.teams.forEach((team, index) => assertTournamentMovementTeam(team, `tournament movement shard teams[${index}]`))
  if (value.teams.length !== value.participantCount) {
    throw new Error('Invalid public artifact: tournament movement shard participantCount must match teams length')
  }
  return value as PublicTournamentMovementShard
}

export function parsePublicRegionHistory(value: unknown): PublicRegionHistoryDirectory {
  assertObject(value, 'region history')
  assertEqual(value.artifactKind, 'region-history', 'region history artifactKind')
  assertSchemaVersion(value, 'region history')
  assertArtifactMeta(value.artifactMeta, 'region history artifactMeta')
  assertPublishedRatingScale(value.ratingScale, 'region history ratingScale')
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
  if (isLocalDataUrl(url)) assertEqual(localDataUrlPath(url), snapshotShardUrlPathForKey(key), `ranking manifest snapshotIndex ${key} url`)
  assertNonNegativeInteger(value.matchCount, `ranking manifest snapshotIndex ${key} matchCount`)
  assertArray(value.sourceBreakdown, `ranking manifest snapshotIndex ${key} sourceBreakdown`)
  value.sourceBreakdown.forEach((source, index) => assertSnapshotSourceBreakdown(source, `ranking manifest snapshotIndex ${key} sourceBreakdown[${index}]`))
}

function assertSnapshotSourceBreakdown(value: unknown, label: string): asserts value is SnapshotSourceBreakdown {
  assertObject(value, label)
  assertString(value.provider, `${label} provider`)
  assertNonNegativeInteger(value.matchCount, `${label} matchCount`)
  assertStringArray(value.completeness, `${label} completeness`)
}

function assertPublicTeamStanding(value: unknown, label: string): asserts value is PublicTeamStanding {
  assertObject(value, label)
  assertString(value.teamId, `${label} teamId`)
  assertString(value.leagueId, `${label} leagueId`)
  assertString(value.team, `${label} team`)
  assertString(value.code, `${label} code`)
  assertString(value.region, `${label} region`)
  assertString(value.league, `${label} league`)
  assertEnum(value.rosterBasis, ['sourced', 'assumed-continuous', 'unknown'], `${label} rosterBasis`)
  assertOptionalNumber(value.rosterContinuity, `${label} rosterContinuity`)
  assertNumber(value.baseRating, `${label} baseRating`)
  assertNumber(value.leagueScore, `${label} leagueScore`)
  assertNumber(value.leagueAdjustment, `${label} leagueAdjustment`)
  assertNumber(value.leagueDelta, `${label} leagueDelta`)
  assertRatingComponents(value.ratingComponents, `${label} ratingComponents`)
  if (value.ratingUpdate !== undefined) assertRatingUpdate(value.ratingUpdate, `${label} ratingUpdate`)
  assertNumber(value.rating, `${label} rating`)
  assertNumber(value.previousRating, `${label} previousRating`)
  assertNumber(value.delta, `${label} delta`)
  assertNonNegativeInteger(value.rank, `${label} rank`)
  assertNonNegativeInteger(value.previousRank, `${label} previousRank`)
  assertNumber(value.movement, `${label} movement`)
  assertNonNegativeInteger(value.wins, `${label} wins`)
  assertNonNegativeInteger(value.losses, `${label} losses`)
  assertEnum(value.recordBasis, ['standing-record-from-ranking-model', 'grouped-match-record-from-scope-history'], `${label} recordBasis`)
  assertEnum(value.scoreFamily, ['power-index', 'deserved-standing'], `${label} scoreFamily`)
  assertNumber(value.confidence, `${label} confidence`)
  assertNumber(value.uncertainty, `${label} uncertainty`)
  assertStringArray(value.form, `${label} form`)
  assertEnum(value.strongestFactor, ['context', 'recency', 'execution', 'opponent', 'league'], `${label} strongestFactor`)
  assertTeamEligibility(value.eligibility, `${label} eligibility`)
  assertFactorBreakdown(value.factors, `${label} factors`)
  assertStringArray(value.recentEvents, `${label} recentEvents`)
  if (value.tournamentAppearances !== undefined) {
    assertArray(value.tournamentAppearances, `${label} tournamentAppearances`)
    value.tournamentAppearances.forEach((appearance, index) => assertPublicTournamentAppearance(appearance, `${label} tournamentAppearances[${index}]`))
  }
  assertArray(value.recentMatches, `${label} recentMatches`)
  value.recentMatches.forEach((match, index) => assertPublicRecentMatch(match, `${label} recentMatches[${index}]`))
  if (value.deservedStanding !== undefined) assertPublicDeservedStanding(value.deservedStanding, `${label} deservedStanding`)
}

function assertLeagueStrength(value: unknown, label: string): asserts value is LeagueStrength {
  assertObject(value, label)
  assertString(value.league, `${label} league`)
  assertString(value.region, `${label} region`)
  assertEnum(value.tier, ['tier-one', 'tier-two', 'tier-three', 'emerging', 'unknown'], `${label} tier`)
  assertNumber(value.priorScore, `${label} priorScore`)
  assertNumber(value.rawScore, `${label} rawScore`)
  assertNumber(value.connectivity, `${label} connectivity`)
  assertNumber(value.score, `${label} score`)
  assertNumber(value.adjustment, `${label} adjustment`)
  assertNumber(value.delta, `${label} delta`)
  assertNonNegativeNumber(value.wins, `${label} wins`)
  assertNonNegativeNumber(value.losses, `${label} losses`)
  assertOptionalNumber(value.expectedWins, `${label} expectedWins`)
  assertOptionalNumber(value.winsOverExpected, `${label} winsOverExpected`)
  assertOptionalNumber(value.opponentAdjustedWinRate, `${label} opponentAdjustedWinRate`)
  assertOptionalNumber(value.averageOpponentRating, `${label} averageOpponentRating`)
  assertNonNegativeInteger(value.internationalMatches, `${label} internationalMatches`)
  assertStringArray(value.form, `${label} form`)
  assertOptionalString(value.lastEvent, `${label} lastEvent`)
  assertOptionalString(value.lastUpdated, `${label} lastUpdated`)
}

function assertRatingComponents(value: unknown, label: string): asserts value is RatingComponents {
  assertObject(value, label)
  assertNumber(value.leagueAnchor, `${label} leagueAnchor`)
  assertNumber(value.teamStableOffset, `${label} teamStableOffset`)
  assertNumber(value.rosterPriorOffset, `${label} rosterPriorOffset`)
  assertNumber(value.momentum, `${label} momentum`)
  assertNumber(value.contextAdjustment, `${label} contextAdjustment`)
  assertNumber(value.uncertainty, `${label} uncertainty`)
}

function assertRatingUpdate(value: unknown, label: string): asserts value is Partial<RatingUpdateLedger> {
  assertObject(value, label)
  for (const key of [
    'teamStableDelta',
    'leagueGameDelta',
    'leaguePlacementDelta',
    'momentumDelta',
    'rosterPriorDelta',
    'uncertaintyDelta',
    'sideAdjustment',
    'patchAdjustment',
    'resultEvidence',
    'neutralResultResidual',
    'seriesStrengthSignal',
    'teamStableShare',
    'teamFormShare',
    'playerSignalShare',
    'lineupSignalShare',
    'leagueSignalShare',
    'directRegionSignalShare',
    'playerSignalDelta',
    'lineupSignalDelta',
    'directRegionSignalDelta',
  ]) {
    assertOptionalNumber(value[key], `${label} ${key}`)
  }
  assertOptionalString(value.ratingTarget, `${label} ratingTarget`)
  assertOptionalString(value.updateUnit, `${label} updateUnit`)
  if (value.unavailableChannels !== undefined) assertStringArray(value.unavailableChannels, `${label} unavailableChannels`)
}

function assertTeamEligibility(value: unknown, label: string): asserts value is PublicTeamStanding['eligibility'] {
  assertObject(value, label)
  assertBoolean(value.eligible, `${label} eligible`)
  assertStringArray(value.reasons, `${label} reasons`)
  assertOptionalNonNegativeInteger(value.totalGames, `${label} totalGames`)
  assertOptionalNonNegativeInteger(value.minTotalGames, `${label} minTotalGames`)
  assertOptionalNonNegativeInteger(value.currentWindowGames, `${label} currentWindowGames`)
  assertOptionalNonNegativeInteger(value.minCurrentWindowGames, `${label} minCurrentWindowGames`)
  assertOptionalNonNegativeInteger(value.windowDays, `${label} windowDays`)
  assertOptionalNonNegativeInteger(value.daysSinceLastMatch, `${label} daysSinceLastMatch`)
  assertOptionalString(value.lastPlayed, `${label} lastPlayed`)
}

function assertFactorBreakdown(value: unknown, label: string): asserts value is FactorBreakdown {
  assertObject(value, label)
  assertNumber(value.context, `${label} context`)
  assertNumber(value.recency, `${label} recency`)
  assertNumber(value.execution, `${label} execution`)
  assertNumber(value.opponent, `${label} opponent`)
  assertNumber(value.league, `${label} league`)
}

function assertPublicTournamentAppearance(value: unknown, label: string): asserts value is PublicTournamentAppearance {
  assertObject(value, label)
  assertEnum(value.family, ['first-stand', 'msi', 'worlds', 'ewc'], `${label} family`)
  assertString(value.event, `${label} event`)
  assertDateString(value.lastDate, `${label} lastDate`)
  assertNonNegativeInteger(value.matchCount, `${label} matchCount`)
}

function assertPublicRecentMatch(value: unknown, label: string): asserts value is PublicRecentMatch {
  assertObject(value, label)
  assertDateString(value.date, `${label} date`)
  assertString(value.event, `${label} event`)
  assertString(value.opponent, `${label} opponent`)
  assertEnum(value.result, ['W', 'L', 'T'], `${label} result`)
  assertNumber(value.rating, `${label} rating`)
  assertNumber(value.delta, `${label} delta`)
  assertOptionalNonNegativeInteger(value.wins, `${label} wins`)
  assertOptionalNonNegativeInteger(value.losses, `${label} losses`)
  assertOptionalNonNegativeInteger(value.games, `${label} games`)
  assertOptionalNonNegativeInteger(value.bestOf, `${label} bestOf`)
  assertOptionalString(value.seriesId, `${label} seriesId`)
  assertOptionalEnum(value.formatBasis, ['official', 'provider', 'score-inferred', 'fallback'], `${label} formatBasis`)
  assertOptionalEnum(value.formatConfidence, ['high', 'medium', 'low'], `${label} formatConfidence`)
}

function assertPublicDeservedStanding(value: unknown, label: string): asserts value is PublicDeservedStandingComparison {
  assertObject(value, label)
  assertEnum(value.leaderboard, ['main-deserved-standings', 'conservative-deserved-standings', 'predictive-power'], `${label} leaderboard`)
  assertNonNegativeInteger(value.rank, `${label} rank`)
  assertNumber(value.score, `${label} score`)
  assertNumber(value.rankDeltaFromPower, `${label} rankDeltaFromPower`)
  assertNumber(value.scoreDeltaFromPower, `${label} scoreDeltaFromPower`)
  assertString(value.eligibility, `${label} eligibility`)
  assertNumber(value.rosterValidity, `${label} rosterValidity`)
  assertNumber(value.winsAboveExpectation, `${label} winsAboveExpectation`)
  assertNumber(value.gameDifferentialAboveExpectation, `${label} gameDifferentialAboveExpectation`)
  assertNumber(value.resumePoints, `${label} resumePoints`)
  assertNumber(value.scheduleStrengthPoints, `${label} scheduleStrengthPoints`)
  assertNumber(value.stagePoints, `${label} stagePoints`)
  assertNumber(value.incomingPlayerBridgeCredit, `${label} incomingPlayerBridgeCredit`)
}

function assertDataSourceInfo(value: unknown, label: string): asserts value is DataSourceInfo {
  assertObject(value, label)
  assertString(value.name, `${label} name`)
  assertEnum(value.kind, ['match-data', 'game-stats', 'official-reference', 'static-metadata', 'experimental-api', 'seed'], `${label} kind`)
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
  if (isLocalDataUrl(url)) assertEqual(localDataUrlPath(url), teamHistoryShardUrlPathForKey(key), `team history index scopeIndex ${key} url`)
  assertNonNegativeInteger(value.teamCount, `team history index scopeIndex ${key} teamCount`)
  assertNonNegativeInteger(value.pointCount, `team history index scopeIndex ${key} pointCount`)
}

function assertTournamentMovementIndexEntry(value: unknown, label: string): asserts value is PublicTournamentMovementIndexEntry {
  assertObject(value, label)
  assertTournamentIdentity(value, label)
  assertDateString(value.startDate, `${label} startDate`)
  assertDateString(value.boundaryDate, `${label} boundaryDate`)
  assertDateString(value.ratedThroughDate, `${label} ratedThroughDate`)
  if (value.scheduledEndDate !== undefined) assertDateString(value.scheduledEndDate, `${label} scheduledEndDate`)
  assertBoolean(value.dataLag, `${label} dataLag`)
  assertNonNegativeInteger(value.participantCount, `${label} participantCount`)
  assertArtifactUrl(value.url, `${label} url`, '/data/history/tournament-moves')
  if (isLocalDataUrl(value.url)) {
    assertEqual(localDataUrlPath(value.url), tournamentMovementShardUrlPathForId(value.id as TournamentInstanceId), `${label} url`)
  }
}

function assertTournamentIdentity(value: Record<string, unknown>, label: string) {
  assertString(value.id, `${label} id`)
  if (!/^(?:first-stand|msi|worlds|ewc):20\d{2}$/.test(value.id)) {
    throw new Error(`Invalid public artifact: ${label} id must be a family:season identifier`)
  }
  assertEnum(value.family, ['first-stand', 'msi', 'worlds', 'ewc'], `${label} family`)
  assertString(value.season, `${label} season`)
  assertString(value.label, `${label} label`)
  assertEnum(value.status, ['ongoing', 'completed', 'unknown'], `${label} status`)
  if (value.id !== `${value.family}:${value.season}`) {
    throw new Error(`Invalid public artifact: ${label} id must match family and season`)
  }
}

function assertTournamentMovementTeam(value: unknown, label: string): asserts value is PublicTournamentMovementTeam {
  assertObject(value, label)
  assertString(value.teamId, `${label} teamId`)
  assertString(value.team, `${label} team`)
  assertString(value.code, `${label} code`)
  assertBoolean(value.eligible, `${label} eligible`)
  assertStringArray(value.eligibilityReasons, `${label} eligibilityReasons`)
  assertNonNegativeInteger(value.startRank, `${label} startRank`)
  assertNonNegativeInteger(value.endRank, `${label} endRank`)
  assertNumber(value.rankMovement, `${label} rankMovement`)
  assertNumber(value.startRating, `${label} startRating`)
  assertNumber(value.endRating, `${label} endRating`)
  assertNumber(value.ratingDelta, `${label} ratingDelta`)
  assertArray(value.points, `${label} points`)
  value.points.forEach((point, index) => assertHistoryPoint(point, `${label} points[${index}]`, assertTeamHistoryPointContext))
  if (value.points.length < 2) throw new Error(`Invalid public artifact: ${label} must include start and endpoint boundaries`)
  const points = value.points as PublicTeamHistoryPoint[]
  const startKind = points[0]?.[3]?.kind
  const endKind = points.at(-1)?.[3]?.kind
  if (startKind !== 'tournament-start') throw new Error(`Invalid public artifact: ${label} must start with a tournament-start boundary`)
  if (!['tournament-end', 'tournament-today', 'tournament-latest-data'].includes(endKind ?? '')) {
    throw new Error(`Invalid public artifact: ${label} must end with a tournament boundary`)
  }
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
  assertOptionalEnum(value.kind, ['match', 'standing-adjustment', 'tournament-start', 'tournament-end', 'tournament-today', 'tournament-latest-data'], `${label} kind`)
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
  assertOptionalString(value.seriesId, `${label} seriesId`)
  assertOptionalEnum(value.formatBasis, ['official', 'provider', 'score-inferred', 'fallback'], `${label} formatBasis`)
  assertOptionalEnum(value.formatConfidence, ['high', 'medium', 'low'], `${label} formatConfidence`)
  assertOptionalEnum(value.seriesState, ['scheduled', 'ongoing', 'completed', 'unknown'], `${label} seriesState`)
  assertOptionalString(value.sourceProvider, `${label} sourceProvider`)
  assertOptionalString(value.sourceGameId, `${label} sourceGameId`)
  assertOptionalString(value.sourceMatchId, `${label} sourceMatchId`)
  assertOptionalString(value.officialEventId, `${label} officialEventId`)
  assertOptionalString(value.officialMatchId, `${label} officialMatchId`)
  assertOptionalString(value.officialGameId, `${label} officialGameId`)
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
  assertOptionalNumber(value.w, `${label} w`)
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
  assertOptionalEnum(value.source, ['league-strength-history', 'published-region-score'], `${label} source`)
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
  assertCleanLocalDataUrl(value, label)
  const path = localDataUrlPath(value)
  const normalizedBase = basePath.replace(/\/$/, '')
  if (!path.startsWith(`${normalizedBase}/`)) {
    throw new Error(`Invalid public artifact: ${label} must be rooted under ${normalizedBase}/`)
  }
  assertCleanUrlPath(path, label)
  const segments = path.split('/')
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

function localDataUrlPath(value: string) {
  return value.split('?', 1)[0]
}

function assertCleanLocalDataUrl(value: string, label: string) {
  if (value.includes('#') || hasControlCharacter(value)) {
    throw new Error(`Invalid public artifact: ${label} must be a clean URL path`)
  }
  const queryStart = value.indexOf('?')
  if (queryStart === -1) return

  const search = value.slice(queryStart + 1)
  const params = new URLSearchParams(search)
  const entries = Array.from(params.entries())
  const version = entries[0]?.[1]
  if (entries.length !== 1 || entries[0][0] !== 'v' || !version || !/^[A-Za-z0-9._~-]+$/.test(version)) {
    throw new Error(`Invalid public artifact: ${label} may only include a non-empty v query parameter`)
  }
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
  if (value.deservedStanding !== undefined) assertRegionDeservedStanding(value.deservedStanding, `${label} deservedStanding`)
  assertNumber(value.topTeamRating, `${label} topTeamRating`)
  assertNumber(value.topThreeTeamRating, `${label} topThreeTeamRating`)
  assertNumber(value.totalTeamRating, `${label} totalTeamRating`)
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

function assertRegionDeservedStanding(value: unknown, label: string) {
  assertObject(value, label)
  assertNumber(value.rank, `${label} rank`)
  assertNumber(value.score, `${label} score`)
  assertNumber(value.rankDeltaFromPower, `${label} rankDeltaFromPower`)
  assertNumber(value.scoreDeltaFromPower, `${label} scoreDeltaFromPower`)
  assertNumber(value.internationalResumePoints, `${label} internationalResumePoints`)
  assertNumber(value.seedPerformancePoints, `${label} seedPerformancePoints`)
  assertNumber(value.stagePoints, `${label} stagePoints`)
  assertNumber(value.seedPerformanceRate, `${label} seedPerformanceRate`)
  assertNumber(value.internationalWinsAboveExpectation, `${label} internationalWinsAboveExpectation`)
  assertNumber(value.connectivity, `${label} connectivity`)
}

function assertRegionTopTeam(value: unknown, label: string) {
  assertObject(value, label)
  assertString(value.team, `${label} team`)
  if (value.code !== undefined) assertString(value.code, `${label} code`)
  assertNumber(value.rating, `${label} rating`)
  if (value.rank !== undefined) assertNumber(value.rank, `${label} rank`)
}

function assertPublishedRatingScale(value: unknown, label: string): asserts value is PublishedRatingScale {
  assertObject(value, label)
  assertString(value.version, `${label} version`)
  assertNumber(value.internalAnchor, `${label} internalAnchor`)
  assertNumber(value.publishedAnchor, `${label} publishedAnchor`)
  assertNumber(value.spreadMultiplier, `${label} spreadMultiplier`)
  assertNumber(value.publishedMinimum, `${label} publishedMinimum`)
  assertNumber(value.publishedMaximum, `${label} publishedMaximum`)
  assertString(value.label, `${label} label`)
  assertString(value.shortLabel, `${label} shortLabel`)
  assertString(value.description, `${label} description`)
  if (value.spreadMultiplier <= 0) {
    throw new Error(`Invalid public artifact: ${label} spreadMultiplier must be positive`)
  }
  if (value.publishedMinimum >= value.publishedMaximum) {
    throw new Error(`Invalid public artifact: ${label} minimum must be lower than maximum`)
  }
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

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid public artifact: ${label} must be a boolean`)
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

function assertNonNegativeNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid public artifact: ${label} must be a non-negative number`)
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
