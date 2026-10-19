import type { CompactPlayer, RankingSummaryStanding } from '../../domains/rankings/types'

const ROLE_ORDER = new Map(['Top', 'Jungle', 'Mid', 'Bot', 'Support'].map((role, index) => [role, index]))

export function playersForTeam(players: CompactPlayer[] | undefined, team: RankingSummaryStanding) {
  const teamName = team.team.toLowerCase()
  const teamRegion = team.region

  return [...(players ?? [])]
    .filter((player) => {
      if (player.region && teamRegion && player.region !== teamRegion) return false
      if (player.teamId) return player.teamId === team.teamId
      const playerTeam = player.team.toLowerCase()
      return playerTeam === teamName
    })
    .sort((a, b) => a.rank - b.rank || (ROLE_ORDER.get(a.role) ?? 99) - (ROLE_ORDER.get(b.role) ?? 99) || a.name.localeCompare(b.name))
}
