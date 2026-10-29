import type { CompactPlayer, PublicPlayerDirectory, SnapshotFilter } from '../../types.ts'
import { snapshotKey } from '../published/schema.ts'
import { compareCodeUnits } from '../../../../shared/codeUnitOrder.mjs'

export type PlayerScopeBasis = 'current' | 'season-fallback' | 'all-seasons-fallback'

export type ResolvedPlayerScope = {
  players: PublicPlayerDirectory['players']
  currentLineups: PublicPlayerDirectory['currentLineups']
  label: string
}

export function emptyPlayerScope(filter: SnapshotFilter): ResolvedPlayerScope {
  return { players: [], currentLineups: {}, label: playerScopeLabel(filter, 'current') }
}

export type PlayerLeaderboardScore = { kind: 'stats-power' | 'role-power'; value: number }

type PlayerLeaderboardRow = CompactPlayer & { leaderboardRank: number; leaderboardScore: PlayerLeaderboardScore }

/** The one score that orders the Players leaderboard: finite Stats Power, otherwise Role Power. */
export function playerLeaderboardScore(player: Pick<CompactPlayer, 'rating' | 'statsPower'>): PlayerLeaderboardScore {
  const score = player.statsPower?.score
  return typeof score === 'number' && Number.isFinite(score)
    ? { kind: 'stats-power', value: score }
    : { kind: 'role-power', value: player.rating }
}

/**
 * Orders one exact scope by its selected score. Equal scores share a leaderboard rank;
 * stored strength rank and stable IDs only order those ties for display.
 */
export function playerLeaderboardForScope(
  directory: PublicPlayerDirectory | undefined,
  filter: SnapshotFilter,
): PlayerLeaderboardRow[] {
  if (!directory) return []
  const players = filter.season === 'All' && filter.event === 'All' && filter.region === 'All' && !filter.checkpoint
    ? directory.players
    : directory.scopedPlayers?.[snapshotKey(filter)] ?? []
  const ordered = players
    .map((player) => ({ ...player, leaderboardRank: 0, leaderboardScore: playerLeaderboardScore(player) }))
    .sort((left, right) =>
      right.leaderboardScore.value - left.leaderboardScore.value || left.rank - right.rank || compareCodeUnits(left.id, right.id),
    )
  ordered.forEach((player, index) => {
    const previous = ordered[index - 1]
    player.leaderboardRank = previous?.leaderboardScore.value === player.leaderboardScore.value ? previous.leaderboardRank : index + 1
  })
  return ordered
}

export function resolvePlayerScope(
  directory: PublicPlayerDirectory | undefined,
  filter: SnapshotFilter,
): ResolvedPlayerScope {
  const currentScope = emptyPlayerScope(filter)
  if (!directory) return currentScope
  if (filter.season === 'All' && filter.event === 'All' && filter.region === 'All') {
    return { players: directory.players, currentLineups: directory.currentLineups, label: currentScope.label }
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
        currentLineups: directory.currentLineups,
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
