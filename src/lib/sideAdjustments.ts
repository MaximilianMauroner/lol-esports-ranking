import type { MatchRecord } from '../types'
import { sideAdjustmentShrinkageGames } from './modelConfig'

export type SideAdjustmentSamples = Map<string, { blueWins: number; total: number }>

export function sideAdjustmentsFromSamples(samples: SideAdjustmentSamples) {
  return new Map(
    Array.from(samples.entries()).map(([key, sample]) => {
      const blueWins = sample.blueWins + 0.5
      const redWins = sample.total - sample.blueWins + 0.5
      const rawEdge = (400 / Math.log(10)) * Math.log(blueWins / redWins)
      const shrinkage = sample.total / (sample.total + sideAdjustmentShrinkageGames)
      return [key, rawEdge * shrinkage]
    }),
  )
}

export function recordSideAdjustmentSample(match: MatchRecord, samples: SideAdjustmentSamples) {
  const blueWon = blueSideWon(match)
  if (blueWon === undefined) return
  for (const key of [match.patch || 'all', 'all']) {
    const current = samples.get(key) ?? { blueWins: 0, total: 0 }
    samples.set(key, {
      blueWins: current.blueWins + (blueWon ? 1 : 0),
      total: current.total + 1,
    })
  }
}

export function sideAdjustmentFor(match: MatchRecord, team: 'A' | 'B', sideAdjustments: Map<string, number>) {
  const side = team === 'A' ? match.teamASide : match.teamBSide
  if (!side) return 0
  const blueEdge = sideAdjustments.get(match.patch) ?? sideAdjustments.get('all') ?? 0
  return side === 'blue' ? blueEdge / 2 : -blueEdge / 2
}

function blueSideWon(match: MatchRecord) {
  if (match.teamASide === 'blue') return match.winner === match.teamA
  if (match.teamBSide === 'blue') return match.winner === match.teamB
  return undefined
}
