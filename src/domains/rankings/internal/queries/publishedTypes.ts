import type { ChampionPicks, DeservedStandingEligibilityLabel, DeservedStandingLeaderboard, FactorBreakdown, LeagueStrength, MatchRecord, PlayerAppearanceSummary, PlayerDiagnostics, PlayerIndividualResidual, PlayerStanding, PlayerStatsPower, PublishedRatingScale, RatingComponents, RatingUpdateLedger, Region, Role, RosterBasis, SeriesState, SourceTrace, TeamEligibility } from '../../types.ts'
import type { InternationalTournamentFamilyId, TournamentInstanceId, TournamentLifecycleStatus } from '../evidence/internationalTournaments.ts'
import type { WalkForwardMetrics } from '../projections/predictionModel.ts'
import type { RegionStrength } from '../projections/regionStrength.ts'
import type { AwardSignalData, DataCoverage, DataQualityAudit, DataSourceInfo, ModelInfo, SnapshotCheckpointOption, SnapshotFilter, SnapshotSourceBreakdown } from '../projections/snapshot.ts'
import type { PUBLIC_ARTIFACT_SCHEMA_VERSION } from '../published/schema.ts'
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
  matchImpact?: number
  expectedWinProbability?: number
  wins?: number
  losses?: number
  games?: number
  bestOf?: number
  seriesId?: string
  formatBasis?: SourceTrace['formatBasis']
  formatConfidence?: SourceTrace['formatConfidence']
}

export type PublicRollingMovementPoint = [date: string, rank: number]

export type PublicTeamRollingMovement = {
  status: 'active' | 'inactive' | 'missing-baseline'
  baselineRating?: number
  currentRating: number
  ratingDelta?: number
  baselineRank?: number
  currentRank: number
  rankMovement?: number
  scoredSeries: number
  rankPoints: PublicRollingMovementPoint[]
  biggestUpsetWin?: PublicRollingUpsetWin
}

export type PublicRollingUpsetWin = {
  date: string
  event: string
  opponent: string
  expectedWinProbability: number
  ratingDelta: number
}

export type PublicRollingWindow = {
  kind: 'rolling-power-movement'
  days: 30
  startDate: string
  endDate: string
  modelVersion: string
  modelConfigHash: string
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
  rollingMovement?: PublicTeamRollingMovement
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

export type PublicRankingShard = {
  artifactKind: 'public-snapshot-shard'
  artifactMeta?: ArtifactMeta
  ratingScale: PublishedRatingScale
  filter: SnapshotFilter
  modelVersion: string
  modelConfigHash: string
  matchCount: number
  sourceBreakdown: SnapshotSourceBreakdown[]
  rollingWindow?: PublicRollingWindow
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

export type PublicCurrentLineupPlayer = {
  playerId: string
  name: string
  role: Role
  rating?: number
  latestObservedAt?: string
}

export type PublicCurrentLineup = {
  team: string
  teamId: string
  teamCode?: string
  observedAt: string
  observedEvent?: string
  freshnessDays?: number
  sourceProvider: string
  claim?: 'last-observed'
  evidenceBasis?: 'scored-series' | 'official-announcement' | 'official-schedule'
  completeness: 'complete-five-role' | 'partial'
  coveredRoles: Role[]
  missingRoles: Role[]
  starters: PublicCurrentLineupPlayer[]
  substitutes: PublicCurrentLineupPlayer[]
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
  form?: string[]
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
    formatConfidence?: SourceTrace['formatConfidence']
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
  availability?: number
  roleCertainty?: number
  impactDrivers?: PlayerStanding['impactDrivers']
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
  statsPower?: PlayerStatsPower
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
  currentLineups: Record<string, PublicCurrentLineup>
}

export type PublicTeamEntity = {
  teamId: string
  name: string
  code: string
  region: Region
  league: string
  leagueId: string
  providerAliases?: ProviderAliasMap
  lineage?: {
    status: 'unresolved'
    relatedTeamNames: string[]
    note: string
  }
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
  kind?: 'match' | 'tournament-start' | 'tournament-end' | 'tournament-today' | 'tournament-latest-data'
  event?: string
  opponent?: string
  delta?: number
  tier?: string
  result?: 'W' | 'L' | 'T'
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

export type PublicTeamCurrentStanding = {
  asOf: string
  rating: number
  rank: number
  lastMatchRating: number
  adjustment: number
  model?: PublicTeamHistoryModelContext
}

export type PublicTeamHistorySeries = {
  team: string
  code?: string
  region?: Region
  points: PublicTeamHistoryPoint[]
  currentStanding: PublicTeamCurrentStanding
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
  source?: 'league-strength-history' | 'region-power-history'
  contributingTeams?: string[]
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
  leagueStrengthSeries: Record<string, PublicRegionHistorySeries>
  regionPowerSeries: Record<string, PublicRegionHistorySeries>
  metricDefinitions: {
    leagueStrength: string
    regionPower: string
  }
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

export type PublicMatchHistoryTeam = {
  id: string
  name: string
  code: string
}

export type PublicMatchHistoryImpact = {
  unit: 'held' | 'series-applied'
  teamA?: number
  teamB?: number
  expectedTeamA?: number
  eventWeight?: number
}

export type PublicMatchHistoryEntry = {
  id: string
  date: string
  datetimeUtc?: string
  event: string
  phase: string
  league: string
  region: Region
  patch: string
  bestOf: number
  gameNumber: number
  seriesId: string
  seriesState: SeriesState
  seriesWinsA: number
  seriesWinsB: number
  teamA: PublicMatchHistoryTeam
  teamB: PublicMatchHistoryTeam
  winnerId: string
  /** Picks for the entry's teamA and teamB, which can differ from the source's game sides. */
  picks?: { teamA: ChampionPicks; teamB: ChampionPicks }
  impact: PublicMatchHistoryImpact
  source: {
    provider: NonNullable<MatchRecord['sourceProvider']>
    completeness?: string
    gameId?: string
    matchId?: string
    officialGameId?: string
    url?: string
  }
}

export type PublicMatchHistoryScopeIndexEntry = {
  filter: SnapshotFilter
  url: string
  gameCount: number
  seriesCount: number
  pageCount: number
  years?: string[]
  pages?: PublicMatchHistoryPageRef[]
}

export type PublicMatchHistoryIndex = {
  artifactKind: 'match-history-index'
  schemaVersion: typeof PUBLIC_ARTIFACT_SCHEMA_VERSION
  artifactMeta: ArtifactMeta
  generatedAt: string
  modelVersion: string
  modelConfigHash: string
  defaultScopeKey: string
  scopeIndex: Record<string, PublicMatchHistoryScopeIndexEntry>
}

export type PublicMatchHistorySeriesRef = {
  storageYear?: string
  id: string
  date: string
  datetimeUtc?: string
  event: string
  league: string
  teamA: PublicMatchHistoryTeam
  teamB: PublicMatchHistoryTeam
  page: number
  gameCount: number
  startUtcDate?: string
  endUtcDate?: string
}

export type PublicMatchHistoryPageRef = {
  storageYear?: string
  page: number
  url: string
  seriesCount: number
  gameCount: number
  seriesIds?: string[]
  startUtcDate?: string
  endUtcDate?: string
}

export type PublicMatchHistoryCatalog = {
  artifactKind: 'match-history-catalog'
  schemaVersion: typeof PUBLIC_ARTIFACT_SCHEMA_VERSION
  artifactMeta: ArtifactMeta
  generatedAt: string
  modelVersion: string
  modelConfigHash: string
  filter: SnapshotFilter
  gameCount: number
  seriesCount: number
  pages: PublicMatchHistoryPageRef[]
  series: PublicMatchHistorySeriesRef[]
}

export type PublicMatchHistoryPage = {
  artifactKind: 'match-history-page'
  storageYear?: string
  schemaVersion: typeof PUBLIC_ARTIFACT_SCHEMA_VERSION
  artifactMeta: ArtifactMeta
  generatedAt: string
  modelVersion: string
  modelConfigHash: string
  filter: SnapshotFilter
  page: number
  seriesCount: number
  gameCount: number
  matches: PublicMatchHistoryEntry[]
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
  regionHistoryUrl?: string
  tournamentMovementIndexUrl: string
  matchHistoryIndexUrl?: string
  replayPredictionsUrl?: string
  teamCount: number
  snapshotIndex: Record<string, PublicSnapshotIndexEntry>
  snapshots?: Record<string, never>
}

export type PublicStandingCompactionOptions = {
  includeRecentMatches?: boolean
  includeRatingUpdate?: boolean
}
