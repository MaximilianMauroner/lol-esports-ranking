import { formatRating } from './display'
import { estimatePublicMatchup, type PublicMatchupModel } from './publicMatchup'
import { NEAR_TIE_WIN_PROBABILITY, nearTieGroups } from './nearTies'
import type { RankingSummaryStanding } from './snapshot'

export type BoardHeadline = {
  headline: string
  details: string[]
}

/** A near-tie run this long is worth a sentence of its own. */
const NOTABLE_RUN_LENGTH = 4

/**
 * The sentence at the top of the ranking: who leads, how firmly, and where
 * the order is too close to trust. Every figure comes from the published
 * standings and the public matchup model, so the copy moves with the data.
 *
 * `ranked` must be the ranked teams of one scope, best first.
 */
export function boardHeadline(ranked: readonly RankingSummaryStanding[], model?: PublicMatchupModel): BoardHeadline | undefined {
  const [leader, runnerUp] = ranked
  if (!leader) return undefined
  if (!runnerUp) return { headline: `${leader.team} lead the ranking.`, details: [] }

  const leaderChance = Math.round(estimatePublicMatchup(leader, runnerUp, model, { bestOf: 1 }).homeGameWinProbability * 100)
  const gap = Math.round(leader.rating - runnerUp.rating)
  const headline = leaderChance / 100 < NEAR_TIE_WIN_PROBABILITY
    ? `${leader.team} lead, but ${runnerUp.team} are close to level: ${leaderChance}% per game.`
    : `${leader.team} lead ${runnerUp.team} by ${gap} points, a ${leaderChance}% game edge.`

  const details: string[] = []
  const exactTie = ranked.slice(1).find((team, index) => {
    const next = ranked[index + 2]
    return next !== undefined && Math.round(team.rating) === Math.round(next.rating)
  })
  if (exactTie) {
    const partner = ranked[ranked.indexOf(exactTie) + 1]
    details.push(`${exactTie.team} and ${partner.team} are tied at ${formatRating(exactTie.rating)}.`)
  }

  const longestRun = nearTieGroups(ranked, model).reduce<RankingSummaryStanding[]>(
    (longest, group) => (group.length > longest.length ? group : longest),
    [],
  )
  if (longestRun.length >= NOTABLE_RUN_LENGTH) {
    const first = longestRun[0]
    const last = longestRun[longestRun.length - 1]
    const spread = Math.round(first.rating - last.rating)
    details.push(`${longestRun.length} teams from ${first.team} to ${last.team} sit within ${spread} points, so one series can reorder them.`)
  }

  return { headline, details }
}
