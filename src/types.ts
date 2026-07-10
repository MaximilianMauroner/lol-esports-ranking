export type Region = 'LCK' | 'LPL' | 'LEC' | 'LCS' | 'LCP' | 'CBLOL' | 'VCS' | 'PCS' | 'International'

export type EventTier =
  | 'worlds-playoffs'
  | 'worlds-main'
  | 'msi-bracket'
  | 'msi-play-in'
  | 'major-playoffs'
  | 'regional-regular'
  | 'minor-international'
  | 'qualifier'

export type Role = 'Top' | 'Jungle' | 'Mid' | 'Bot' | 'Support'
export type Side = 'blue' | 'red'

export type LeagueTierName = 'tier-one' | 'tier-two' | 'tier-three' | 'emerging' | 'unknown'
export type RosterBasis = 'sourced' | 'assumed-continuous' | 'unknown'
export type RosterCompleteness = 'complete-five-role' | 'partial'
export type EligibilityReason = 'low-total-volume' | 'low-current-volume' | 'stale' | 'high-uncertainty' | 'unanchored-league'
export type WalkForwardSegmentKey =
  | 'bo1'
  | 'bo3-bo5'
  | 'international'
  | 'cross-region'
  | 'side-known'
  | 'patch-transition'
  | 'roster-change'

export type PregamePredictionVariantKey =
  | 'published'
  | 'team-only'
  | 'player-adjusted'
  | 'execution-baseline'
  | 'execution-adjusted'

export type PublishedRatingScale = {
  version: string
  internalAnchor: number
  publishedAnchor: number
  spreadMultiplier: number
  publishedMinimum: number
  publishedMaximum: number
  label: string
  shortLabel: string
  description: string
}

export type PregamePredictionVariant = {
  teamAGameWinProbability: number
  teamBGameWinProbability: number
  teamASeriesWinProbability: number
  teamBSeriesWinProbability: number
  teamARating?: number
  teamBRating?: number
}

export type PlayerImpactSignals = {
  objectiveImpactZ?: number
  awardResidualZ?: number
  recentFormZ?: number
  availability?: number
  roleCertainty?: number
}

export type PlayerAppearanceFlag =
  | 'multi-team-career'
  | 'thin-latest-team-sample'
  | 'multi-role-career'
  | 'thin-role-sample'
  | 'unresolved-player-id'

export type PlayerTeamAppearance = {
  team: string
  games: number
  latestObservedAt?: string
  latestObservedEvent?: string
}

export type PlayerRoleAppearance = {
  role: Role
  games: number
}

export type PlayerAppearanceSummary = {
  primaryTeam: string
  primaryTeamGames: number
  primaryTeamShare: number
  latestTeamGames: number
  latestTeamShare: number
  roleGames: number
  roleShare: number
  teamsPlayed: number
  rolesPlayed: number
  teamHistory: PlayerTeamAppearance[]
  roleHistory: PlayerRoleAppearance[]
  flags: PlayerAppearanceFlag[]
}

export type SourceTrace = {
  provider?: MatchRecord['sourceProvider']
  gameId?: string
  matchId?: string
  officialEventId?: string
  officialMatchId?: string
  officialGameId?: string
  url?: string
  fileName?: string
  completeness?: string
  date?: string
  event?: string
  bestOf?: number
  seriesId?: string
  formatBasis?: SeriesFormatBasis
  formatConfidence?: SeriesFormatConfidence
  seriesState?: SeriesState
  seriesOutcome?: 0 | 0.5 | 1
}

export type SeriesFormat = 1 | 2 | 3 | 5
export type SeriesFormatBasis = 'official' | 'provider' | 'score-inferred' | 'fallback'
export type SeriesFormatConfidence = 'high' | 'medium' | 'low'
export type SeriesState = 'scheduled' | 'ongoing' | 'completed' | 'unknown'

export type TeamProfile = {
  name: string
  code: string
  region: Region
  league: string
}

export type PlayerProfile = {
  id: string
  name: string
  team: string
  role: Role
  impactSignals?: PlayerImpactSignals
}

export type PlayerGameStats = {
  side: Side
  champion?: string
  won: boolean
  kills: number
  deaths: number
  assists: number
  totalGold?: number
  earnedGold?: number
  damageShare?: number
  earnedGoldShare?: number
  visionScore?: number
  vspm?: number
  gpr?: number
}

export type PlayerDiagnosticAverage = {
  value: number | null
  games: number
  missing: number
}

export type PlayerDiagnostics = {
  sourceProvider: 'oracles-elixir'
  scope: 'rated-complete-role-matchups'
  sampleGames: number
  wins: number
  losses: number
  winRate: number | null
  noWinStatScore: PlayerDiagnosticAverage
  sameRoleMatchupDiff: PlayerDiagnosticAverage
  damageShare: PlayerDiagnosticAverage
  earnedGoldShare: PlayerDiagnosticAverage
  kda: PlayerDiagnosticAverage
  visionScore: PlayerDiagnosticAverage
  vspm: PlayerDiagnosticAverage
}

export type PlayerIndividualResidual = {
  sourceProvider: 'oracles-elixir'
  metricVersion: 'individual-residual-v0'
  scope: 'shadow-rated-complete-role-matchups'
  score: number
  rank?: number
  rolePowerRank?: number
  rankDelta?: number
  confidence: number
  sampleGames: number
  adjustedSameRoleDiff: PlayerDiagnosticAverage
  expectedNoWinStatScore: PlayerDiagnosticAverage
  opponentStrengthProxy: PlayerDiagnosticAverage
  controls: {
    role: Role
    primaryLeague: string
    leagueGames: number
    sideGames: Partial<Record<Side, number>>
    patchCount: number
    eventTierCounts: Partial<Record<EventTier, number>>
  }
  explanation: {
    noWinStatScore: PlayerDiagnosticAverage
    sameRoleMatchupDiff: PlayerDiagnosticAverage
    rolePowerRating: number
    teamWinRate: number | null
  }
}

export type RosterPlayerAppearance = {
  id: string
  name: string
  role: Role
  stats?: PlayerGameStats
}

export type MatchRosterSnapshot = {
  sourceProvider: 'oracles-elixir'
  teamId?: string
  observedAt: string
  completeness: RosterCompleteness
  players: RosterPlayerAppearance[]
}

export type MatchRecord = {
  id: string
  sourceProvider?: 'oracles-elixir' | 'leaguepedia-cargo' | 'seed'
  sourceGameId?: string
  sourceMatchId?: string
  officialEventId?: string
  officialMatchId?: string
  officialGameId?: string
  officialScheduleState?: string
  sourceUrl?: string
  sourceFileName?: string
  dataCompleteness?: string
  date: string
  datetimeUtc?: string
  gameNumber?: number
  season: number
  event: string
  phase: string
  region: Region
  league: string
  teamAHomeLeague?: string
  teamBHomeLeague?: string
  teamARegion?: Region
  teamBRegion?: Region
  teamASeed?: number
  teamBSeed?: number
  teamASide?: Side
  teamBSide?: Side
  teamARoster?: MatchRosterSnapshot
  teamBRoster?: MatchRosterSnapshot
  patch: string
  bestOf: number
  bestOfBasis?: Extract<SeriesFormatBasis, 'official' | 'provider' | 'fallback'>
  tier: EventTier
  teamA: string
  teamB: string
  winner: string
  teamAKills: number
  teamBKills: number
  teamAGold: number
  teamBGold: number
  teamATowers?: number
  teamBTowers?: number
  teamADragons?: number
  teamBDragons?: number
  teamABarons?: number
  teamBBarons?: number
  gameLengthSeconds?: number
}

export type TeamHistoryPoint = {
  date: string
  event: string
  opponent: string
  rating: number
  baseRating: number
  leagueAdjustment: number
  sideAdjustment: number
  ratingComponents: RatingComponents
  ratingUpdate: RatingUpdateLedger
  rank: number
  delta: number
  tier: EventTier
  result: 'W' | 'L'
  source: SourceTrace
}

export type RatingComponents = {
  leagueAnchor: number
  teamStableOffset: number
  rosterPriorOffset: number
  momentum: number
  contextAdjustment: number
  uncertainty: number
}

export type RatingUpdateLedger = {
  teamStableDelta: number
  leagueGameDelta: number
  leaguePlacementDelta: number
  momentumDelta: number
  rosterPriorDelta: number
  uncertaintyDelta: number
  sideAdjustment: number
  patchAdjustment: number
  ratingTarget?: string
  updateUnit?: string
  eventWeight?: number
  resultEvidence?: number
  neutralResultResidual?: number
  seriesStrengthSignal?: number
  teamStableShare?: number
  teamFormShare?: number
  playerSignalShare?: number
  lineupSignalShare?: number
  leagueSignalShare?: number
  directRegionSignalShare?: number
  playerSignalDelta?: number
  lineupSignalDelta?: number
  directRegionSignalDelta?: number
  unavailableChannels?: string[]
}

export type FactorBreakdown = {
  context: number
  recency: number
  execution: number
  opponent: number
  league: number
}

export type LeagueStrength = {
  league: string
  region: Region
  tier: LeagueTierName
  priorScore: number
  rawScore: number
  connectivity: number
  score: number
  adjustment: number
  delta: number
  wins: number
  losses: number
  expectedWins?: number
  winsOverExpected?: number
  opponentAdjustedWinRate?: number
  averageOpponentRating?: number
  internationalMatches: number
  form: string[]
  lastEvent?: string
  lastUpdated?: string
}

export type LeagueStrengthHistoryPoint = {
  date: string
  event: string
  tier: EventTier
  league: string
  region: Region
  opponentLeague: string
  opponentRegion: Region
  result: 'W' | 'L'
  score: number
  delta: number
  wins: number
  losses: number
  expectedWins?: number
  winsOverExpected?: number
  opponentAdjustedWinRate?: number
  averageOpponentRating?: number
  internationalMatches: number
}

export type PregamePrediction = {
  id: string
  seriesId?: string
  date: string
  event: string
  patch: string
  bestOf: number
  formatBasis?: SeriesFormatBasis
  formatConfidence?: SeriesFormatConfidence
  teamA: string
  teamB: string
  teamASide?: Side
  teamBSide?: Side
  actualWinner: string
  predictedWinner: string
  teamAGameWinProbability: number
  teamBGameWinProbability: number
  teamASeriesWinProbability: number
  teamBSeriesWinProbability: number
  teamAExpectedSeriesPoints?: number
  teamBExpectedSeriesPoints?: number
  teamAGameWinProbabilityTeamOnly?: number
  teamBGameWinProbabilityTeamOnly?: number
  teamASeriesWinProbabilityTeamOnly?: number
  teamBSeriesWinProbabilityTeamOnly?: number
  teamAGameWinProbabilityExecutionBaseline?: number
  teamBGameWinProbabilityExecutionBaseline?: number
  teamASeriesWinProbabilityExecutionBaseline?: number
  teamBSeriesWinProbabilityExecutionBaseline?: number
  uncertaintyPenalty: number
  teamARating: number
  teamBRating: number
  teamAUncertainty: number
  teamBUncertainty: number
  teamAPregameWins?: number
  teamAPregameLosses?: number
  teamBPregameWins?: number
  teamBPregameLosses?: number
  teamARosterContinuity?: number
  teamBRosterContinuity?: number
  teamAPlayerRatingAdjustment?: number
  teamBPlayerRatingAdjustment?: number
  teamASideAdjustment?: number
  teamBSideAdjustment?: number
  teamAPlayerRatingCoverage?: number
  teamBPlayerRatingCoverage?: number
  teamAGameWinProbabilityPlayerAdjusted?: number
  teamBGameWinProbabilityPlayerAdjusted?: number
  teamASeriesWinProbabilityPlayerAdjusted?: number
  teamBSeriesWinProbabilityPlayerAdjusted?: number
  playerRatingPredictionWeight?: number
  teamAExecutionResidualAdjustment?: number
  teamBExecutionResidualAdjustment?: number
  teamAGameWinProbabilityExecutionAdjusted?: number
  teamBGameWinProbabilityExecutionAdjusted?: number
  teamASeriesWinProbabilityExecutionAdjusted?: number
  teamBSeriesWinProbabilityExecutionAdjusted?: number
  executionResidualPredictionWeight?: number
  variants: Record<PregamePredictionVariantKey, PregamePredictionVariant>
  segments: WalkForwardSegmentKey[]
  trainingMatchCount: number
  dataCutoff?: string
  modelVersion: string
  modelConfigHash: string
  source: SourceTrace
}

export type TeamEligibility = {
  eligible: boolean
  reasons: EligibilityReason[]
  totalGames: number
  minTotalGames: number
  currentWindowGames: number
  minCurrentWindowGames: number
  windowDays: number
  daysSinceLastMatch?: number
  lastPlayed?: string
}

export type DeservedStandingLeaderboard = 'main-deserved-standings' | 'conservative-deserved-standings' | 'predictive-power'

export type DeservedStandingEligibilityLabel =
  | 'Eligible'
  | 'Provisional'
  | 'Inactive'
  | 'Developmental'
  | 'Insufficient current-roster sample'
  | 'Insufficient league connectivity'

export type DeservedStandingMatchInput = {
  matchId: string
  date: string
  event: string
  stage: string
  region: Region
  league: string
  teamA: string
  teamB: string
  teamALeague: string
  teamBLeague: string
  teamARoster?: MatchRosterSnapshot
  teamBRoster?: MatchRosterSnapshot
  teamACoachId?: string
  teamBCoachId?: string
  bestOf: number
  teamAGamesWon: number
  teamBGamesWon: number
  teamASide?: Side
  teamBSide?: Side
  patch?: string
  venue?: string
  travelContext?: string
  substitutes?: DeservedStandingSubstituteInput[]
}

export type DeservedStandingSubstituteInput = {
  team: string
  playerId: string
  role: Role
  seriesCount?: number
  splitGameShare?: number
  permanent?: boolean
}

export type DeservedStandingPlayerInput = {
  playerId: string
  currentTeam: string
  role: Role
  historicalTeams: string[]
  gameParticipation: number
  rolePerformanceZ?: number
  championPool?: string[]
  internationalExperience?: number
  uncertainty: number
}

export type DeservedStandingLeagueInput = {
  leagueId: string
  region: Region
  tier: LeagueTierName
  flagship: boolean
  prior: number
  internationalMatches: number
  translationRating: number
  connectivity: number
}

export type DeservedStandingRegionInput = {
  regionId: string
  flagshipLeagues: string[]
  internationalWins: number
  internationalLosses: number
  expectedInternationalWins: number
  actualInternationalWins: number
  stageAdvancement: number
  topTeamScore: number
  depthScore: number
  connectivity: number
}

export type DeservedStandingSeriesResumeInput = {
  observedSeriesResult: number
  observedGameWinRate: number
  expectedSeriesResult: number
  expectedGameWinRate: number
}

export type DeservedStandingWeightedSeries = {
  weightedSeriesValue: number
  seriesWeight: number
  rosterValidity: number
  opponentReferenceStrength: number
  standardOpponentReferenceStrength: number
}

export type DeservedStandingTeamComponents = {
  baseScore: number
  resumeRate: number
  volumeReliability: number
  resumePoints: number
  scheduleRate: number
  scheduleStrengthPoints: number
  stagePoints: number
  incomingPlayerBridgeCredit: number
  instabilityPenalty: number
  dss: number
  conservativeDss?: number
}

export type DeservedStandingRosterEra = {
  team: string
  roster: MatchRosterSnapshot
  coachId?: string
  startDate: string
  endDate?: string
  matches: string[]
  resumeLedger: string[]
  playerContributionLedger: string[]
  synergyLedger: string[]
  uncertainty: number
}

export type DeservedStandingPlayerResumeLedger = {
  playerId: string
  careerResumeCredit: number
  currentSeasonResumeCredit: number
  currentSplitResumeCredit: number
  internationalResumeCredit: number
  roleResumeCredit: Partial<Record<Role, number>>
  uncertainty: number
}

export type TeamStanding = {
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
  history: TeamHistoryPoint[]
  recentEvents: string[]
}

export type PlayerStanding = {
  id: string
  name: string
  team: string
  role: Role
  games: number
  ratingBasis?: 'sourced-player-stats' | 'seeded-demo-rosters'
  rating: number
  delta: number
  rank: number
  baseShare: number
  playerShare: number
  impactMultiplier: number
  availability: number
  roleCertainty: number
  impactDrivers: {
    objectiveImpactZ: number
    awardResidualZ: number
    recentFormZ: number
  }
  form: string[]
  history: {
    date: string
    event: string
    opponent?: string
    opponentTeamCode?: string
    playerTeam?: string
    playerTeamCode?: string
    result?: 'W' | 'L'
    bestOf?: number
    teamKills?: number
    opponentKills?: number
    source?: SourceTrace
    rating: number
    delta: number
  }[]
  source?: SourceTrace
  appearance?: PlayerAppearanceSummary
  diagnostics?: PlayerDiagnostics
  individualResidual?: PlayerIndividualResidual
}

export type EventSummary = {
  event: string
  season: number
  tier: EventTier
  region: Region
  matches: number
  ratingImpact: number
  topTeams: string[]
  startDate: string
  endDate: string
  sourceBreakdown: {
    provider: string
    matchCount: number
  }[]
}

export type SeasonSummary = {
  season: number
  matches: number
  events: number
  topTeam: string
  mostImproved: string
  startDate: string
  endDate: string
}
