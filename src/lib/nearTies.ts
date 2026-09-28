import { estimatePublicMatchup, type PublicMatchupModel } from './publicMatchup'
import type { RankingSummaryStanding } from './snapshot'

/**
 * Two teams are a near tie when the higher one wins fewer than this share of
 * neutral single games against the lower one. The estimate comes from the
 * same matchup model the comparison uses, so the board never calls a gap
 * "clear" that the model itself calls a coin flip. The published model is
 * conservative (100 points is about 57%), so this sits at roughly a 45-point
 * gap.
 */
export const NEAR_TIE_WIN_PROBABILITY = 0.53

export type NearTiePosition = 'start' | 'middle' | 'end'

export function isNearTie(higher: RankingSummaryStanding, lower: RankingSummaryStanding, model?: PublicMatchupModel) {
  const estimate = estimatePublicMatchup(higher, lower, model, { bestOf: 1 })
  return Math.max(estimate.homeGameWinProbability, estimate.awayGameWinProbability) < NEAR_TIE_WIN_PROBABILITY
}

/**
 * Splits rows, in the order given, into runs where every pair is a near tie.
 * Each run is measured from its first row, not from the previous one: chaining
 * neighbour to neighbour would link a whole table of small gaps into one run
 * whose ends are far apart. Rows that tie with nobody form a run of one.
 */
export function nearTieGroups<T extends RankingSummaryStanding>(rows: readonly T[], model?: PublicMatchupModel): T[][] {
  const groups: T[][] = []
  for (const row of rows) {
    const current = groups.at(-1)
    if (current && isNearTie(current[0], row, model)) current.push(row)
    else groups.push([row])
  }
  return groups
}

/** Where each row sits inside its near-tie run, keyed by `keyFor`. Rows outside a run are absent. */
export function nearTiePositions<T extends RankingSummaryStanding>(
  groups: readonly (readonly T[])[],
  keyFor: (row: T) => string,
) {
  const positions = new Map<string, NearTiePosition>()
  for (const group of groups) {
    if (group.length < 2) continue
    group.forEach((row, index) => {
      positions.set(keyFor(row), index === 0 ? 'start' : index === group.length - 1 ? 'end' : 'middle')
    })
  }
  return positions
}
