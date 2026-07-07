import { eventTierConfig } from '../data/rankingConfig'
import { leaguePriorFor } from '../data/leagueTiers'
import type { MatchRecord } from '../types'
import { isInternationalMatch } from './ratingCalculations'

export function ensureLeague(
  league: string,
  leagueScores: Map<string, number>,
  previousLeagueScores: Map<string, number>,
  leagueWins: Map<string, number>,
  leagueLosses: Map<string, number>,
  leagueExpectedWins: Map<string, number>,
  leagueOpponentRatingSums: Map<string, number>,
  leagueForms: Map<string, string[]>,
  leagueMatchCounts: Map<string, number>,
) {
  if (leagueScores.has(league)) return
  const prior = leaguePriorFor(league)
  leagueScores.set(league, prior)
  previousLeagueScores.set(league, prior)
  leagueWins.set(league, 0)
  leagueLosses.set(league, 0)
  leagueExpectedWins.set(league, 0)
  leagueOpponentRatingSums.set(league, 0)
  leagueForms.set(league, [])
  leagueMatchCounts.set(league, 0)
}

type LeagueStrengthState = {
  leagueScores: Map<string, number>
  previousLeagueScores: Map<string, number>
  leagueWins: Map<string, number>
  leagueLosses: Map<string, number>
  leagueExpectedWins: Map<string, number>
  leagueOpponentRatingSums: Map<string, number>
  leagueForms: Map<string, string[]>
  leagueMatchCounts: Map<string, number>
  leagueLastEvents: Map<string, string>
  leagueLastUpdated: Map<string, string>
}

type LeagueStrengthUpdateBase = LeagueStrengthState & {
  match: MatchRecord
  leagueA: string
  leagueB: string
  leagueScoreA: number
  leagueScoreB: number
  leagueExpectedRatingA: number
  leagueExpectedRatingB: number
  recency: number
}

export type LeagueStrengthSeriesUpdate = LeagueStrengthUpdateBase & {
  expectedOutcomeA: number
  expectedOutcomeB: number
  observedOutcomeA: number
  observedOutcomeB: number
  strengthSignal: number
}

export function updateLeagueStrengthForSeries({
  match,
  leagueA,
  leagueB,
  leagueScoreA,
  leagueScoreB,
  leagueExpectedRatingA,
  leagueExpectedRatingB,
  expectedOutcomeA,
  expectedOutcomeB,
  observedOutcomeA,
  observedOutcomeB,
  strengthSignal,
  recency,
  leagueScores,
  previousLeagueScores,
  leagueWins,
  leagueLosses,
  leagueExpectedWins,
  leagueOpponentRatingSums,
  leagueForms,
  leagueMatchCounts,
  leagueLastEvents,
  leagueLastUpdated,
}: LeagueStrengthSeriesUpdate) {
  return updateLeagueStrength({
    match,
    leagueA,
    leagueB,
    leagueScoreA,
    leagueScoreB,
    leagueExpectedRatingA,
    leagueExpectedRatingB,
    expectedOutcomeA,
    expectedOutcomeB,
    observedOutcomeA,
    observedOutcomeB,
    kFactor: eventTierConfig[match.tier].leagueKFactor * strengthSignal,
    recency,
    leagueScores,
    previousLeagueScores,
    leagueWins,
    leagueLosses,
    leagueExpectedWins,
    leagueOpponentRatingSums,
    leagueForms,
    leagueMatchCounts,
    leagueLastEvents,
    leagueLastUpdated,
  })
}

function updateLeagueStrength({
  match,
  leagueA,
  leagueB,
  leagueScoreA,
  leagueScoreB,
  leagueExpectedRatingA,
  leagueExpectedRatingB,
  expectedOutcomeA,
  expectedOutcomeB,
  observedOutcomeA,
  observedOutcomeB,
  kFactor,
  recency,
  leagueScores,
  previousLeagueScores,
  leagueWins,
  leagueLosses,
  leagueExpectedWins,
  leagueOpponentRatingSums,
  leagueForms,
  leagueMatchCounts,
  leagueLastEvents,
  leagueLastUpdated,
}: LeagueStrengthUpdateBase & {
  expectedOutcomeA: number
  expectedOutcomeB: number
  observedOutcomeA: number
  observedOutcomeB: number
  kFactor: number
}) {
  const leagueKFactor = eventTierConfig[match.tier].leagueKFactor
  if (leagueA === leagueB || leagueA === 'Unknown' || leagueB === 'Unknown' || leagueKFactor === 0 || !isInternationalMatch(match)) {
    return { deltaA: 0, deltaB: 0 }
  }

  const deltaA = Number((kFactor * recency * (observedOutcomeA - expectedOutcomeA)).toFixed(3))
  const deltaB = Number((kFactor * recency * (observedOutcomeB - expectedOutcomeB)).toFixed(3))

  previousLeagueScores.set(leagueA, leagueScoreA)
  previousLeagueScores.set(leagueB, leagueScoreB)
  leagueScores.set(leagueA, leagueScoreA + deltaA)
  leagueScores.set(leagueB, leagueScoreB + deltaB)
  updateLeagueRecord(leagueA, observedOutcomeA > observedOutcomeB, expectedOutcomeA, leagueExpectedRatingB, match, leagueWins, leagueLosses, leagueExpectedWins, leagueOpponentRatingSums, leagueForms, leagueMatchCounts, leagueLastEvents, leagueLastUpdated)
  updateLeagueRecord(leagueB, observedOutcomeB > observedOutcomeA, expectedOutcomeB, leagueExpectedRatingA, match, leagueWins, leagueLosses, leagueExpectedWins, leagueOpponentRatingSums, leagueForms, leagueMatchCounts, leagueLastEvents, leagueLastUpdated)

  return { deltaA, deltaB }
}

function updateLeagueRecord(
  league: string,
  won: boolean,
  expectedWin: number,
  opponentRating: number,
  match: MatchRecord,
  leagueWins: Map<string, number>,
  leagueLosses: Map<string, number>,
  leagueExpectedWins: Map<string, number>,
  leagueOpponentRatingSums: Map<string, number>,
  leagueForms: Map<string, string[]>,
  leagueMatchCounts: Map<string, number>,
  leagueLastEvents: Map<string, string>,
  leagueLastUpdated: Map<string, string>,
) {
  if (won) leagueWins.set(league, (leagueWins.get(league) ?? 0) + 1)
  else leagueLosses.set(league, (leagueLosses.get(league) ?? 0) + 1)
  leagueExpectedWins.set(league, (leagueExpectedWins.get(league) ?? 0) + expectedWin)
  leagueOpponentRatingSums.set(league, (leagueOpponentRatingSums.get(league) ?? 0) + opponentRating)
  leagueForms.set(league, [...(leagueForms.get(league) ?? []), won ? 'W' : 'L'].slice(-6))
  leagueMatchCounts.set(league, (leagueMatchCounts.get(league) ?? 0) + 1)
  leagueLastEvents.set(league, match.event)
  leagueLastUpdated.set(league, match.date)
}
