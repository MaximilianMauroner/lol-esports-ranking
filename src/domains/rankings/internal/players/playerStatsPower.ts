import type { MatchRecord, PlayerStatsPower, Role, TeamProfile } from '../../types.ts'
import { homeLeagueForMatch } from '../evidence/matchContext.ts'
import { playerBaselineForLeague, playerSignalMultiplierForLeague } from '../policy/playerPolicy.ts'
import { statsPowerPolicy } from '../policy/statsPowerPolicy.ts'
import { eventWeightForMatch, type EventWeightContext } from '../replay/eventWeighting.ts'
import { playerPerformanceValues } from './playerPerformance.ts'
import { isCompleteSourcedMatchup } from './rosters.ts'
import { compareCodeUnits } from '../../../../shared/codeUnitOrder.mjs'

type MetricFit = { weight: number; weightedValue: number; squaredDifference: number; pairs: number }

type MetricEvidence = { observed: number; weight: number; squaredWeight: number; weightedValue: number }

type PlayerRoleEvidence = {
  weight: number
  weightedBaseline: number
  weightedSignal: number
  observedMetricIndexMasks: number[]
  metrics: MetricEvidence[]
  evidenceThrough: string
}

type Normalization = { center: number; scale: number } | undefined

export function buildPlayerStatsPower(
  matches: readonly MatchRecord[],
  context: { teams?: Record<string, TeamProfile>; eventWeightContext?: EventWeightContext },
  leagueRatings: ReadonlyMap<string, number>,
): Map<string, Map<Role, PlayerStatsPower>> {
  const referenceDay = matches.reduce((latest, match) => Math.max(latest, utcDay(match.date)), -Infinity)
  const fits = new Map<Role, MetricFit[]>()
  const evidence = new Map<string, Map<Role, PlayerRoleEvidence>>()

  for (const match of matches) {
    const recency = 2 ** (-(referenceDay - utcDay(match.date)) / statsPowerPolicy.halfLifeDays)
    const eventWeight = eventWeightForMatch(match, context.eventWeightContext, statsPowerPolicy.eventWeights)
    for (const [side, roster, opponentRoster] of [
      ['A', match.teamARoster, match.teamBRoster],
      ['B', match.teamBRoster, match.teamARoster],
    ] as const) {
      if (!roster || !opponentRoster || !isCompleteSourcedMatchup(roster, opponentRoster)) continue
      const league = homeLeagueForMatch(match, side, context.teams ?? {})
      const signal = playerSignalMultiplierForLeague(league)
      const weight = eventWeight * signal * recency
      const baseline = playerBaselineForLeague(league, leagueRatings)
      for (const player of roster.players) {
        const opponent = opponentRoster.players.find((candidate) => candidate.role === player.role)
        if (!player.stats || !opponent?.stats) continue
        const metrics = statsPowerPolicy.roleMetrics[player.role]
        const fit = mapEntry(fits, player.role, () => metrics.map(() => ({ weight: 0, weightedValue: 0, squaredDifference: 0, pairs: 0 })))
        const current = mapEntry(mapEntry(evidence, player.id, () => new Map()), player.role, () => ({
          weight: 0,
          weightedBaseline: 0,
          weightedSignal: 0,
          observedMetricIndexMasks: [],
          metrics: metrics.map(() => ({ observed: 0, weight: 0, squaredWeight: 0, weightedValue: 0 })),
          evidenceThrough: match.date,
        }))
        const values = playerPerformanceValues(player.stats)
        const opponentValues = playerPerformanceValues(opponent.stats)
        let observedMask = 0
        metrics.forEach((metric, index) => {
          const value = values[metric]
          if (value === undefined) return
          observedMask |= 1 << index
          fit[index]!.weight += weight
          fit[index]!.weightedValue += weight * value
          const opponentValue = opponentValues[metric]
          if (opponentValue !== undefined) {
            fit[index]!.squaredDifference += (value - opponentValue) ** 2
            fit[index]!.pairs += 1
          }
          const metricEvidence = current.metrics[index]!
          metricEvidence.observed += 1
          metricEvidence.weight += weight
          metricEvidence.squaredWeight += weight ** 2
          metricEvidence.weightedValue += weight * value
        })
        current.weight += weight
        current.weightedBaseline += weight * baseline
        current.weightedSignal += weight * signal
        current.observedMetricIndexMasks.push(observedMask)
        if (compareCodeUnits(match.date, current.evidenceThrough) > 0) current.evidenceThrough = match.date
      }
    }
  }

  const normalization = new Map([...fits].map(([role, fit]) => [role, fit.map(({ weight, weightedValue, squaredDifference, pairs }): Normalization => {
    const scale = pairs > 0 ? Math.sqrt(squaredDifference / pairs) : 0
    return scale > 0 ? { center: weightedValue / weight, scale } : undefined
  })]))

  return new Map([...evidence].map(([playerId, roles]) => [playerId, new Map([...roles].map(([role, roleEvidence]) => [
    role,
    statsPowerSummary(role, roleEvidence, normalization.get(role) ?? []),
  ]))]))
}

function statsPowerSummary(role: Role, evidence: PlayerRoleEvidence, normalization: readonly Normalization[]): PlayerStatsPower {
  const metrics = statsPowerPolicy.roleMetrics[role]
  let usableMask = 0
  let contributionTotal = 0
  metrics.forEach((_, index) => {
    const { observed, weight, squaredWeight, weightedValue } = evidence.metrics[index]!
    const fit = normalization[index]
    if (!fit || observed === 0) return
    usableMask |= 1 << index
    const effectiveGames = weight ** 2 / squaredWeight
    contributionTotal += ((weightedValue / weight - fit.center) / fit.scale)
      * (effectiveGames / (effectiveGames + statsPowerPolicy.priorGames))
  })
  const leagueAnchor = evidence.weightedBaseline / evidence.weight
  const signal = evidence.weightedSignal / evidence.weight
  const sampleGames = evidence.observedMetricIndexMasks.filter((mask) => (mask & usableMask) !== 0).length
  const eligibleGames = evidence.observedMetricIndexMasks.length
  return {
    version: statsPowerPolicy.version,
    score: leagueAnchor + statsPowerPolicy.amplitude * signal * Math.tanh(contributionTotal / metrics.length),
    role,
    sampleGames,
    eligibleGames,
    priorOnly: sampleGames === 0,
    leagueAnchor,
    evidenceThrough: evidence.evidenceThrough,
    metrics: Object.fromEntries(metrics.map((metric, index) => {
      const { observed, weight, squaredWeight } = evidence.metrics[index]!
      return [metric, {
        observed,
        missing: eligibleGames - observed,
        effectiveGames: observed === 0 ? 0 : Number((weight ** 2 / squaredWeight).toFixed(2)),
      }]
    })),
  }
}

function mapEntry<K, V>(map: Map<K, V>, key: K, create: () => V) {
  const existing = map.get(key)
  if (existing) return existing
  const created = create()
  map.set(key, created)
  return created
}

function utcDay(date: string) {
  return Date.parse(`${date}T00:00:00Z`) / 86_400_000
}
