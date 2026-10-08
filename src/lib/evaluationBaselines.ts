import { eventTierConfig } from '../data/rankingConfig'
import type { MatchRecord } from '../types'
import { groupEvaluationBy } from './rankingEvaluation'
import { canonicalSeriesForMatches } from './seriesResolver'
import { compareCodeUnits } from './codeUnitOrder.mjs'

type Rating = { rating: number; deviation: number; lastDate: string }
const q = Math.log(10) / 400
const g = (deviation: number) => 1 / Math.sqrt(1 + 3 * q ** 2 * deviation ** 2 / Math.PI ** 2)

/** Offline controls: one frozen UTC-date rating period; tournament K applies to Elo. */
export function evaluationBaselineProbabilities(matches: readonly MatchRecord[]) {
  const elo = new Map<string, number>()
  const glicko = new Map<string, Rating>()
  const records = new Map<string, { wins: number; games: number }>()
  const series = canonicalSeriesForMatches(matches)
  const probabilities = new Map<string, { elo: number; glicko: number; winRate: number; coinFlip: number }>()
  const sorted = [...matches].sort((a, b) => compareCodeUnits(a.date, b.date) || compareCodeUnits(a.id, b.id))
  for (const [date, day] of groupEvaluationBy(sorted, (match) => match.date)) {
    const eloDeltas = new Map<string, number>()
    const evidence = new Map<string, Array<{ opponent: Rating; outcome: number }>>()
    const period = new Map<string, Rating>()
    for (const team of new Set(day.flatMap((match) => [match.teamA, match.teamB]))) {
      period.set(team, glickoRatingAt(glicko.get(team), date))
    }
    for (const match of day) {
      const a = period.get(match.teamA)!
      const b = period.get(match.teamB)!
      const recordA = records.get(match.teamA) ?? { wins: 0, games: 0 }
      const recordB = records.get(match.teamB) ?? { wins: 0, games: 0 }
      const rateA = (recordA.wins + 1) / (recordA.games + 2)
      const rateB = (recordB.wins + 1) / (recordB.games + 2)
      const p = 1 / (1 + 10 ** (((elo.get(match.teamB) ?? 1500) - (elo.get(match.teamA) ?? 1500)) / 400))
      probabilities.set(match.id, { elo: p, glicko: glickoProbability(a, b), winRate: rateA / (rateA + rateB), coinFlip: .5 })
      // Predict incomplete series, but do not update control state from an unverified prefix.
      if (series.get(match.id)?.state !== 'completed') continue
      const won = Number(match.winner === match.teamA)
      const delta = eventTierConfig[match.tier].kFactor * (won - p)
      eloDeltas.set(match.teamA, (eloDeltas.get(match.teamA) ?? 0) + delta)
      eloDeltas.set(match.teamB, (eloDeltas.get(match.teamB) ?? 0) - delta)
      evidence.set(match.teamA, [...(evidence.get(match.teamA) ?? []), { opponent: b, outcome: won }])
      evidence.set(match.teamB, [...(evidence.get(match.teamB) ?? []), { opponent: a, outcome: 1 - won }])
    }
    for (const [team, delta] of eloDeltas) elo.set(team, (elo.get(team) ?? 1500) + delta)
    for (const [team, outcomes] of evidence) glicko.set(team, updateGlicko(period.get(team)!, outcomes))
    for (const match of day) {
      if (series.get(match.id)?.state !== 'completed') continue
      for (const team of [match.teamA, match.teamB]) {
        const record = records.get(team) ?? { wins: 0, games: 0 }
        records.set(team, { wins: record.wins + Number(team === match.winner), games: record.games + 1 })
      }
    }
  }
  return probabilities
}

export function glickoRatingAt(previous: Rating | undefined, date: string): Rating {
  const gap = previous ? Math.max(0, (Date.parse(date) - Date.parse(previous.lastDate)) / 86_400_000) : 0
  return { rating: previous?.rating ?? 1500,
    deviation: Math.min(350, Math.sqrt((previous?.deviation ?? 350) ** 2 + gap * 25)), lastDate: date }
}

export function glickoProbability(a: Pick<Rating, 'rating' | 'deviation'>, b: Pick<Rating, 'rating' | 'deviation'>) {
  return 1 / (1 + 10 ** (g(Math.hypot(a.deviation, b.deviation)) * (b.rating - a.rating) / 400))
}

export function updateGlicko(prior: Rating, evidence: Array<{ opponent: Rating; outcome: number }>): Rating {
  if (!evidence.length) return { ...prior }
  let information = 0; let residual = 0
  for (const { opponent, outcome } of evidence) {
    const opponentG = g(opponent.deviation)
    const probability = 1 / (1 + 10 ** (opponentG * (opponent.rating - prior.rating) / 400))
    information += q ** 2 * opponentG ** 2 * probability * (1 - probability)
    residual += opponentG * (outcome - probability)
  }
  const variance = 1 / (1 / prior.deviation ** 2 + information)
  return { rating: prior.rating + q * variance * residual, deviation: Math.sqrt(variance), lastDate: prior.lastDate }
}
