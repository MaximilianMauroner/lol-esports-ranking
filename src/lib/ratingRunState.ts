import type {
  FactorBreakdown,
  LeagueStrengthHistoryPoint,
  MatchRecord,
  MatchRosterSnapshot,
  PregamePrediction,
  RatingUpdateLedger,
  TeamHistoryPoint,
  TeamProfile,
} from '../types'
import {
  initialTeamRating,
  maximumUncertainty,
} from './modelConfig'
import { eventWeightContextForMatches, type EventWeightContext } from './eventWeighting'
import { buildEventTrackers, type PlacementTournamentLifecycle } from './placementResiduals'
import { emptyRatingUpdateLedger } from './ratingCalculations'
import type { SideAdjustmentSamples } from './sideAdjustments'

export type RatingRunState = {
  ratings: Map<string, number>
  executionRatings: Map<string, number>
  previousDisplayRatings: Map<string, number>
  momentums: Map<string, number>
  rosterPriorOffsets: Map<string, number>
  latestRatingUpdates: Map<string, RatingUpdateLedger>
  leaguePlacementDeltas: Map<string, number>
  wins: Map<string, number>
  losses: Map<string, number>
  forms: Map<string, string[]>
  histories: Map<string, TeamHistoryPoint[]>
  factorSums: Map<string, FactorBreakdown>
  factorCounts: Map<string, number>
  leagueScores: Map<string, number>
  previousLeagueScores: Map<string, number>
  uncertainties: Map<string, number>
  leagueWins: Map<string, number>
  leagueLosses: Map<string, number>
  leagueExpectedWins: Map<string, number>
  leagueOpponentRatingSums: Map<string, number>
  leagueForms: Map<string, string[]>
  leagueMatchCounts: Map<string, number>
  leagueLastEvents: Map<string, string>
  leagueLastUpdated: Map<string, string>
  leagueHistory: LeagueStrengthHistoryPoint[]
  predictions: PregamePrediction[]
  sideAdjustmentSamples: SideAdjustmentSamples
  lastRosterByTeam: Map<string, MatchRosterSnapshot>
  currentRosterContinuity: Map<string, number>
  lastPatchByTeam: Map<string, string>
  lastRosterFingerprintByTeam: Map<string, string>
  eventTrackers: ReturnType<typeof buildEventTrackers>
  eventWeightContext: EventWeightContext
  previousMatch?: MatchRecord
  processedMatchCount: number
}

export function createRatingRunState(
  sortedMatches: MatchRecord[],
  teams: Record<string, TeamProfile>,
  eventWeightContext: EventWeightContext = eventWeightContextForMatches(sortedMatches),
  tournamentLifecycles: ReadonlyMap<string, PlacementTournamentLifecycle> = new Map(),
): RatingRunState {
  const state: RatingRunState = {
    ratings: new Map(),
    executionRatings: new Map(),
    previousDisplayRatings: new Map(),
    momentums: new Map(),
    rosterPriorOffsets: new Map(),
    latestRatingUpdates: new Map(),
    leaguePlacementDeltas: new Map(),
    wins: new Map(),
    losses: new Map(),
    forms: new Map(),
    histories: new Map(),
    factorSums: new Map(),
    factorCounts: new Map(),
    leagueScores: new Map(),
    previousLeagueScores: new Map(),
    uncertainties: new Map(),
    leagueWins: new Map(),
    leagueLosses: new Map(),
    leagueExpectedWins: new Map(),
    leagueOpponentRatingSums: new Map(),
    leagueForms: new Map(),
    leagueMatchCounts: new Map(),
    leagueLastEvents: new Map(),
    leagueLastUpdated: new Map(),
    leagueHistory: [],
    predictions: [],
    sideAdjustmentSamples: new Map(),
    lastRosterByTeam: new Map(),
    currentRosterContinuity: new Map(),
    lastPatchByTeam: new Map(),
    lastRosterFingerprintByTeam: new Map(),
    eventTrackers: buildEventTrackers(sortedMatches, eventWeightContext, tournamentLifecycles),
    eventWeightContext,
    processedMatchCount: 0,
  }

  for (const team of Object.keys(teams)) {
    ensureTeamState(state, team, teams)
  }

  return state
}

export function ensureMatchRunEntities(
  state: RatingRunState,
  match: MatchRecord,
  teams: Record<string, TeamProfile>,
) {
  ensureTeamState(state, match.teamA, teams)
  ensureTeamState(state, match.teamB, teams)
  if (!state.executionRatings.has(match.teamA)) state.executionRatings.set(match.teamA, initialTeamRating)
  if (!state.executionRatings.has(match.teamB)) state.executionRatings.set(match.teamB, initialTeamRating)
  if (!state.uncertainties.has(match.teamA)) state.uncertainties.set(match.teamA, maximumUncertainty)
  if (!state.uncertainties.has(match.teamB)) state.uncertainties.set(match.teamB, maximumUncertainty)
}

export function makeRankMap(ratings: Map<string, number>) {
  return new Map(
    Array.from(ratings.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([team], index) => [team, index + 1]),
  )
}

function ensureTeamState(
  state: RatingRunState,
  team: string,
  teams: Record<string, TeamProfile>,
) {
  if (state.ratings.has(team)) return
  state.ratings.set(team, initialTeamRating)
  state.executionRatings.set(team, initialTeamRating)
  state.previousDisplayRatings.set(team, initialTeamRating)
  state.momentums.set(team, 0)
  state.rosterPriorOffsets.set(team, 0)
  state.latestRatingUpdates.set(team, emptyRatingUpdateLedger())
  state.uncertainties.set(team, maximumUncertainty)
  state.wins.set(team, 0)
  state.losses.set(team, 0)
  state.forms.set(team, [])
  state.histories.set(team, [])
  state.factorSums.set(team, { context: 0, recency: 0, execution: 0, opponent: 0, league: 0.5 })
  state.factorCounts.set(team, 0)
  if (!teams[team]) {
    teams[team] = { name: team, code: team.slice(0, 3).toUpperCase(), region: 'International', league: 'Unknown' }
  }
}
