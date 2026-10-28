import type { EventTier, PlayerPerformanceMetric, Role } from '../../types.ts'

/**
 * Display-score policy only. It changes no replay or forecast state, so it is
 * versioned on each summary and stays out of the player and team model parameters.
 */
export const statsPowerPolicy = {
  version: 'stats-power-v3',
  halfLifeDays: 90,
  priorGames: 20,
  amplitude: 30,
  eventWeights: {
    'worlds-playoffs': 2.7857142857142856,
    'worlds-main': 1.9285714285714286,
    'msi-bracket': 2.4285714285714284,
    'msi-play-in': 1.9285714285714286,
    'major-playoffs': 1.5714285714285714,
    'regional-regular': 1,
    'minor-international': 1.5714285714285714,
    'qualifier': 0.8571428571428571,
  },
  roleMetrics: {
    Top: ['goldDiffAt15', 'xpDiffAt15', 'csDiffAt15'],
    Jungle: ['goldDiffAt15', 'xpDiffAt15', 'csDiffAt15', 'killParticipation'],
    Mid: ['goldDiffAt15', 'xpDiffAt15', 'csDiffAt15'],
    Bot: ['goldDiffAt15', 'xpDiffAt15', 'csDiffAt15'],
    Support: ['killParticipation', 'wardsPlacedPerMinute', 'wardsClearedPerMinute'],
  },
} as const satisfies {
  version: string
  halfLifeDays: number
  priorGames: number
  amplitude: number
  eventWeights: Record<EventTier, number>
  roleMetrics: Record<Role, readonly PlayerPerformanceMetric[]>
}
