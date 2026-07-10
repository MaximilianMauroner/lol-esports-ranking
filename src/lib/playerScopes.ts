import type { PublicPlayerDirectory, SnapshotFilter } from './publicArtifacts/schema'
import { snapshotKey } from './publicArtifacts/schema'

export type PlayerScopeBasis = 'current' | 'season-fallback' | 'all-seasons-fallback'

export type ResolvedPlayerScope = {
  players: PublicPlayerDirectory['players']
  label: string
}

export function emptyPlayerScope(filter: SnapshotFilter): ResolvedPlayerScope {
  return { players: [], label: playerScopeLabel(filter, 'current') }
}

export function resolvePlayerScope(
  directory: PublicPlayerDirectory | undefined,
  filter: SnapshotFilter,
): ResolvedPlayerScope {
  const currentScope = emptyPlayerScope(filter)
  if (!directory) return currentScope
  if (filter.season === 'All' && filter.event === 'All' && filter.region === 'All') {
    return { players: directory.players, label: currentScope.label }
  }
  if (filter.season !== 'All' && filter.event === 'All' && filter.region === 'All') {
    const exactPlayers = directory.scopedPlayers?.[snapshotKey(filter)]
    const seasonPlayers = filter.checkpoint
      ? directory.scopedPlayers?.[snapshotKey({ season: filter.season, event: 'All', region: 'All' })]
      : undefined
    const scopedPlayers = exactPlayers ?? seasonPlayers
    if (scopedPlayers) {
      const scopedTeams = new Set(scopedPlayers.map((player) => player.team))
      const fallbackPlayers = directory.players.filter((player) => !scopedTeams.has(player.team))
      const basis: PlayerScopeBasis = fallbackPlayers.length > 0
        ? 'all-seasons-fallback'
        : exactPlayers ? 'current' : 'season-fallback'
      return {
        players: [...scopedPlayers, ...fallbackPlayers],
        label: playerScopeLabel(filter, basis),
      }
    }
  }
  return currentScope
}

function playerScopeLabel(filter: SnapshotFilter, basis: PlayerScopeBasis) {
  if (basis === 'all-seasons-fallback') {
    return `${scopeBaseLabel(filter)}; teams without scoped rows use all-season sources`
  }
  if (basis === 'season-fallback') return `the ${filter.season} source season`
  return scopeBaseLabel(filter)
}

function scopeBaseLabel(filter: SnapshotFilter) {
  if (filter.season === 'All' && filter.event === 'All' && filter.region === 'All') return 'all seasons & events'
  if (filter.season !== 'All' && filter.event === 'All' && filter.region === 'All') {
    if (filter.checkpoint) return `the ${filter.season} ${checkpointLabel(filter.checkpoint)} checkpoint`
    return `the ${filter.season} source season`
  }
  if (filter.event !== 'All') return filter.event
  if (filter.region !== 'All') return `${filter.region} region scope`
  return 'the current scope'
}

function checkpointLabel(id: string) {
  return id.replaceAll('-', ' ')
}
