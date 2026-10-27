import type { PlayerPerformanceMetric, Role } from '../../types.ts'

/**
 * Display-score policy only. It changes no replay or forecast state, so it is
 * versioned on each summary and stays out of the player and team model parameters.
 */
export const statsPowerPolicy = {
  version: 'stats-power-v3',
  halfLifeDays: 90,
  priorGames: 20,
  amplitude: 30,
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
  roleMetrics: Record<Role, readonly PlayerPerformanceMetric[]>
}
