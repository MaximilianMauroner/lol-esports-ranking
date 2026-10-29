import { PLAYER_METRICS, TEAM_METRICS } from './metrics.ts'
import { MIN_GAMES, playerKey } from './model.ts'
import type { ScopeProfiles, StyleCohorts, StyleEntity, StyleMeasure } from './model.ts'
import type { Role } from '../rankings/types.ts'
import type { StyleMetricKey } from './metrics.ts'

export * from './model.ts'
export * from './metrics.ts'
export { parseStyleProfileArtifact } from './parser.ts'

export function stylePopulation(scope: ScopeProfiles, filter: { kind: 'player'; role: Role } | { kind: 'team'; league: string | null }): StyleEntity[] {
  return filter.kind === 'player' ? scope.players.filter(player => player.role === filter.role)
    : scope.teams.filter(team => filter.league === null || team.league === filter.league)
}

function cohortKey(entity: StyleEntity, metric: string) {
  return `${'role' in entity ? entity.role : 'teams'}/${metric}`
}

export function stylePeers(entity: StyleEntity, metric: string, cohorts: StyleCohorts) {
  return cohorts.get(cohortKey(entity, metric)) ?? []
}

export function buildStyleCohorts(entities: readonly StyleEntity[]): StyleCohorts {
  const cohorts: StyleCohorts = new Map()
  for (const entity of entities) {
    if (entity.games < MIN_GAMES) continue
    const metrics = 'role' in entity ? PLAYER_METRICS : TEAM_METRICS
    for (const metric of metrics) {
      const observed = (entity.observed as Partial<Record<StyleMetricKey, { mean: number; games: number }>>)[metric.key]
      if (!observed || observed.games < MIN_GAMES) continue
      const key = cohortKey(entity, metric.key)
      const peers = cohorts.get(key) ?? []
      peers.push({ key: 'role' in entity ? playerKey(entity) : entity.id, name: entity.name, value: observed.mean })
      cohorts.set(key, peers)
    }
  }
  return cohorts
}

export function styleMeasures(entity: StyleEntity, cohorts: StyleCohorts): StyleMeasure[] {
  const metrics = 'role' in entity ? PLAYER_METRICS : TEAM_METRICS
  return metrics.map(metric => {
    const observed = (entity.observed as Partial<Record<StyleMetricKey, { mean: number; games: number }>>)[metric.key]
    const peers = stylePeers(entity, metric.key, cohorts)
    const base = { metric, value: observed?.mean ?? null, games: observed?.games ?? 0, cohortSize: peers.length }
    if (!observed) return { ...base, status: 'missing', percentile: null }
    if (entity.games < MIN_GAMES) return { ...base, status: 'few-games', percentile: null }
    if (observed.games < MIN_GAMES) return { ...base, status: 'few-metric-games', percentile: null }
    if (peers.length < 2) return { ...base, status: 'small-cohort', percentile: null }
    let furtherIn = 0
    let equal = 0
    for (const peer of peers) {
      if (peer.value === observed.mean) equal++
      else if ((peer.value - observed.mean) * metric.direction < 0) furtherIn++
    }
    return { ...base, status: 'ok', percentile: Math.round(100 * (furtherIn + 0.5 * equal) / peers.length) }
  })
}
