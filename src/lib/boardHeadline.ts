import { estimatePublicMatchup, type PublicMatchupModel } from './publicMatchup'
import { NEAR_TIE_WIN_PROBABILITY } from './nearTies'
import type { RankingSummaryStanding } from './snapshot'

/**
 * The sentence at the top of the ranking: who leads and how firmly. Every
 * figure comes from the published standings and the public matchup model, so
 * the copy moves with the data.
 *
 * `ranked` must be the ranked teams of one scope, best first.
 */
export function boardHeadline(ranked: readonly RankingSummaryStanding[], model?: PublicMatchupModel): string | undefined {
  const [leader, runnerUp] = ranked
  if (!leader) return undefined
  if (!runnerUp) return `${leader.team} lead the ranking.`

  const leaderChance = Math.round(estimatePublicMatchup(leader, runnerUp, model, { bestOf: 1 }).homeGameWinProbability * 100)
  const gap = Math.round(leader.rating - runnerUp.rating)
  return leaderChance / 100 < NEAR_TIE_WIN_PROBABILITY
    ? `${leader.team} lead, but ${runnerUp.team} are close to level: ${leaderChance}% per game.`
    : `${leader.team} lead ${runnerUp.team} by ${gap} points, a ${leaderChance}% game edge.`
}
