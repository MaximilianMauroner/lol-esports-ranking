import type { PlayerGameStats, PlayerPerformanceMetric, PlayerPerformanceSummary } from '../types'

export const playerPerformancePolicy = {
  version: 'observed-player-performance-v1',
  aggregation: 'unweighted-per-game-mean',
  ratingEffect: 'none',
} as const

export const playerPerformanceMetrics = {
  killParticipation: { label: 'Kill participation', format: 'percent', decimals: 4, description: 'Average of (kills + assists) / team kills per game. Games with zero or unknown team kills are unavailable.' },
  damageGoldShareGap: { label: 'Damage–gold share gap', format: 'points', decimals: 4, description: 'Damage share minus earned gold share in the same game, in percentage points. Describes resource/output balance; it is not adjusted for champion or role.' },
  goldDiffAt15: { label: 'Gold difference at 15', format: 'signed', decimals: 1, description: 'Gold relative to the opposing player at 15 minutes. Includes team assistance and matchup effects.' },
  xpDiffAt15: { label: 'XP difference at 15', format: 'signed', decimals: 1, description: 'Experience relative to the opposing player at 15 minutes.' },
  csDiffAt15: { label: 'CS difference at 15', format: 'signed', decimals: 1, description: 'Creep score relative to the opposing player at 15 minutes.' },
  damagePerMinute: { label: 'Damage / min', format: 'number', decimals: 1, description: 'Champion damage per minute. Depends on champion, role, opponents, and game state.' },
  csPerMinute: { label: 'CS / min', format: 'number', decimals: 2, description: 'Creep score per minute. Describes farming and resource allocation.' },
  wardsPlacedPerMinute: { label: 'Wards placed / min', format: 'number', decimals: 2, description: 'Ward placement activity per minute; does not measure ward quality.' },
  wardsClearedPerMinute: { label: 'Wards cleared / min', format: 'number', decimals: 2, description: 'Ward clearing activity per minute; depends on available enemy wards and map control.' },
} as const satisfies Record<PlayerPerformanceMetric, { label: string; format: string; decimals: number; description: string }>

export const playerPerformanceMetricKeys = Object.keys(playerPerformanceMetrics) as PlayerPerformanceMetric[]

export function playerPerformanceValues(stats?: PlayerGameStats): Record<PlayerPerformanceMetric, number | undefined> {
  const damageShare = bounded(stats?.damageShare, 0, 1)
  const goldShare = bounded(stats?.earnedGoldShare, 0, 1)
  return {
    killParticipation: bounded(stats?.killParticipation, 0, 1),
    damageGoldShareGap: damageShare === undefined || goldShare === undefined ? undefined : damageShare - goldShare,
    goldDiffAt15: finite(stats?.goldDiffAt15),
    xpDiffAt15: finite(stats?.xpDiffAt15),
    csDiffAt15: finite(stats?.csDiffAt15),
    damagePerMinute: bounded(stats?.damagePerMinute, 0),
    csPerMinute: bounded(stats?.csPerMinute, 0),
    wardsPlacedPerMinute: bounded(stats?.wardsPlacedPerMinute, 0),
    wardsClearedPerMinute: bounded(stats?.wardsClearedPerMinute, 0),
  }
}

export type PlayerPerformanceAccumulator = Record<PlayerPerformanceMetric, { total: number; games: number }>

export function createPlayerPerformanceAccumulator(): PlayerPerformanceAccumulator {
  return Object.fromEntries(playerPerformanceMetricKeys.map((key) => [key, { total: 0, games: 0 }])) as PlayerPerformanceAccumulator
}

export function recordPlayerPerformance(accumulator: PlayerPerformanceAccumulator, stats?: PlayerGameStats) {
  const values = playerPerformanceValues(stats)
  for (const key of playerPerformanceMetricKeys) {
    const value = values[key]
    if (value === undefined) continue
    accumulator[key].total += value
    accumulator[key].games += 1
  }
}

export function summarizePlayerPerformance(accumulator: PlayerPerformanceAccumulator, sampleGames: number): PlayerPerformanceSummary {
  return {
    ...playerPerformancePolicy,
    metrics: Object.fromEntries(playerPerformanceMetricKeys.map((key) => {
      const { total, games } = accumulator[key]
      return [key, {
        value: games ? Number((total / games).toFixed(playerPerformanceMetrics[key].decimals)) : null,
        games,
        missing: sampleGames - games,
      }]
    })) as PlayerPerformanceSummary['metrics'],
  }
}

function finite(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function bounded(value: number | undefined, min: number, max = Infinity) {
  const number = finite(value)
  return number !== undefined && number >= min && number <= max ? number : undefined
}
