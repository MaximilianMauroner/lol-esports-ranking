import type { FactorBreakdown, LeagueStrengthHistoryPoint, RatingComponents, RatingUpdateLedger, Role, SeriesFormat } from '../../types.ts'
import type { ContinuityRetention } from '../players/playerModel.ts'
import type { SeriesResultUpdate } from './seriesResultUpdate.ts'

export type Pair<T> = readonly [T, T]
export type SeriesPassRoster = Readonly<{
  completeness: 'complete-five-role' | 'partial'
  players: readonly Readonly<{ role: Role; id: string }>[]
}>
export type SeriesPassSource = 'prior' | Readonly<{ member: Readonly<{ series: number; member: number; side: number }> }>
export type SeriesPassSample = Readonly<{ blueWins: number; total: number }>
export type SeriesPassSamples = readonly (readonly [string, SeriesPassSample])[]

export type SeriesPassTeamBefore = Readonly<{
  team: string
  rating: number | null
  executionRating: number | null
  uncertainty: number | null
  momentum: number | null
  rosterPriorOffset: number | null
  rosterContinuity: number | null
  previousDisplayRating: number | null
  wins: number | null
  losses: number | null
  form: readonly string[] | null
  factors: FactorBreakdown | null
  factorCount: number | null
  lastRoster: SeriesPassRoster | null
  lastPatch: string | null
  lastRosterFingerprint: string | null
  hasLatestRatingUpdate: boolean
}>
export type SeriesPassLeague = Readonly<{
  league: string
  score: number | null
  previousScore: number | null
  wins: number | null
  losses: number | null
  expectedWins: number | null
  opponentRatingSum: number | null
  matchCount: number | null
  form: readonly string[] | null
  lastEvent: string | null
  lastUpdated: string | null
}>
export type SeriesPassSide = Readonly<{
  team: number
  league: number
  region: string
  colour: 'blue' | 'red' | null
  sideAdjustment: number
  playerAdjustment: number | null
  roster: SeriesPassRoster | null
  kills: number
  gold: number
  towers: number | null
  dragons: number | null
  barons: number | null
}>
export type SeriesPassMember = Readonly<{
  matchId: string
  id: string
  ordering: Readonly<{
    datetimeUtc: string | null
    gameNumber: number
    officialGameId: string | null
    sourceGameId: string | null
  }>
  sides: Pair<SeriesPassSide>
  winner: number
  international: boolean
  eventK: number
  eventWeight: number
  patch: string
  event: string
  tier: string
}>
export type SeriesPassSeries = Readonly<{
  seriesId: string
  teams: Pair<number>
  leagues: Pair<number>
  bestOf: SeriesFormat
  wins: Pair<number>
  members: readonly SeriesPassMember[]
  continuityRetention?: Pair<ContinuityRetention>
}>
export type SeriesPassFrame = Readonly<{
  utcDate: string
  lastDate: string
  authoritativeMatchIds: readonly string[]
  teams: readonly SeriesPassTeamBefore[]
  leagues: readonly SeriesPassLeague[]
  sideSamples: SeriesPassSamples
  processedMatchCount: number
  series: readonly SeriesPassSeries[]
}>
export type SeriesPassTeamAfter = Omit<SeriesPassTeamBefore, 'lastRoster' | 'hasLatestRatingUpdate'> & Readonly<{
  lastRoster: SeriesPassSource | null
  latestRatingUpdate: SeriesPassSource | null
}>
export type SeriesPassContinuity = Pick<SeriesPassTeamBefore, 'rosterContinuity' | 'rating' | 'executionRating' | 'uncertainty'>
export type SeriesPassInputTrail = Readonly<{
  currentPowerRating: Pair<number>
  uncertainty: Pair<number>
  rosterContinuity: Pair<number | null>
  observedOutcome: Pair<number>
  strengthSignal: number
  eventK: number
  international: boolean
}>
export type SeriesPassSideCalculation = Readonly<{
  snapshotRating: number
  localExecutionBefore: number
  snapshotLeagueScore: number
  snapshotMomentum: number
  powerRating: number
  executionPowerRating: number
  currentPowerRating: number
  effectiveRating: number
  executionEffectiveRating: number
  liveRatingBefore: number
  liveLeagueBefore: number
  liveMomentumBefore: number
  liveUncertaintyBefore: number
  previousComponents: RatingComponents
  executionIndex: number
  executionExpected: number
  executionOutcome: number
  executionDelta: number
  localExecutionRating: number | null
  seriesDelta: number
  publishedRosterPriorOffset: number
  updatedRosterPriorOffset: number
  leagueDelta: number
  updatedLeagueScore: number
  components: RatingComponents
  displayRating: number
  historyDelta: number
  factors: FactorBreakdown
}>
export type SeriesPassSideTrail = SeriesPassSideCalculation & Readonly<{
  executionRating: number | null
  rating: number | null
  previousDisplayRating: number | null
  rosterPriorOffset: number | null
  uncertainty: number | null
  momentum: number | null
  history: Readonly<{
    rating: number
    baseRating: number
    leagueAdjustment: number
    sideAdjustment: number
    delta: number
    result: 'W' | 'L'
  }>
  latestRatingUpdate: RatingUpdateLedger
  factorSums: FactorBreakdown | null
  factorCount: number | null
  wins: number | null
  losses: number | null
  form: readonly string[] | null
  lastPatch: string | null
  lastRoster: SeriesPassSource | null
  lastRosterFingerprint: string | null
  league: SeriesPassLeague
}>
export type SeriesPassLeaguePoint = Omit<LeagueStrengthHistoryPoint,
  'expectedWins' | 'winsOverExpected' | 'opponentAdjustedWinRate' | 'averageOpponentRating'> & Readonly<{
    expectedWins: number | null
    winsOverExpected: number | null
    opponentAdjustedWinRate: number | null
    averageOpponentRating: number | null
  }>
export type SeriesPassMemberTrail = Readonly<{
  seriesFinal: boolean
  gameK: number
  recency: number
  sides: Pair<SeriesPassSideTrail>
  leagueHistory: readonly SeriesPassLeaguePoint[]
  sideSamples: SeriesPassSamples
  processedMatchCount: number
}>
export type SeriesPassSeriesTrail = Readonly<{
  state: 'scheduled' | 'ongoing' | 'completed' | 'unknown'
  outcomeA: number
  continuity: Pair<SeriesPassContinuity>
  input: SeriesPassInputTrail
  result: SeriesResultUpdate
  members: readonly SeriesPassMemberTrail[]
}>
export const seriesPassTeamMaps = {
  ratings: 'ratings', executionRatings: 'executionRatings', uncertainties: 'uncertainties', momentums: 'momentums',
  rosterPriorOffsets: 'rosterPriorOffsets', currentRosterContinuity: 'rosterContinuity', previousDisplayRatings: 'previousDisplayRatings',
  wins: 'wins', losses: 'losses', forms: 'forms', factorSums: 'factorSums', factorCounts: 'factorCounts',
  lastRosterByTeam: 'lastRosters', lastPatchByTeam: 'lastPatches', lastRosterFingerprintByTeam: 'lastRosterFingerprints',
  latestRatingUpdates: 'latestRatingUpdates',
} as const
export const seriesPassLeagueMaps = {
  leagueScores: 'scores', previousLeagueScores: 'previousScores', leagueWins: 'wins', leagueLosses: 'losses',
  leagueExpectedWins: 'expectedWins', leagueOpponentRatingSums: 'opponentRatingSums', leagueForms: 'forms',
  leagueMatchCounts: 'matchCounts', leagueLastEvents: 'lastEvents', leagueLastUpdated: 'lastUpdated',
} as const

export type SeriesPassExpectation = Readonly<{
  utcDate: string
  series: readonly SeriesPassSeriesTrail[]
  teams: readonly SeriesPassTeamAfter[]
  leagues: readonly SeriesPassLeague[]
  sideSamples: SeriesPassSamples
  inserted: Readonly<{
    teams: Readonly<Record<typeof seriesPassTeamMaps[keyof typeof seriesPassTeamMaps], readonly number[]>>
    leagues: Readonly<Record<typeof seriesPassLeagueMaps[keyof typeof seriesPassLeagueMaps], readonly number[]>>
  }>
  processedMatchCount: number
}>
export type SeriesPassCapture = Readonly<{ frame: SeriesPassFrame; expected: SeriesPassExpectation }>
export type SeriesPassObserver = (capture: SeriesPassCapture) => void
