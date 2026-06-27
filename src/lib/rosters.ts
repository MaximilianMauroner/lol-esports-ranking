import { baseRoleShares } from './playerModel'
import type { MatchRecord, MatchRosterSnapshot, Role, RosterBasis } from '../types'

export type RosterContinuityConfig = {
  roleValueWeights: Record<Role, number>
  requiresCompleteLineups: boolean
}

export const defaultRosterContinuityConfig: RosterContinuityConfig = {
  roleValueWeights: baseRoleShares,
  requiresCompleteLineups: true,
}

export function latestRosterByTeam(matches: MatchRecord[]): Map<string, MatchRosterSnapshot> {
  const latest = new Map<string, MatchRosterSnapshot>()

  for (const match of matches.toSorted(compareMatchesByDateAndId)) {
    if (match.teamARoster) latest.set(match.teamA, match.teamARoster)
    if (match.teamBRoster) latest.set(match.teamB, match.teamBRoster)
  }

  return latest
}

export function rosterBasisByTeam(matches: MatchRecord[]): Map<string, RosterBasis> {
  return new Map(
    Array.from(latestRosterByTeam(matches).entries()).map(([team, roster]) => [
      team,
      roster.completeness === 'complete-five-role' ? 'sourced' : 'assumed-continuous',
    ]),
  )
}

export function rosterContinuity(
  prior: MatchRosterSnapshot | undefined,
  current: MatchRosterSnapshot | undefined,
  config: RosterContinuityConfig = defaultRosterContinuityConfig,
) {
  if (!prior || !current) return undefined
  if (config.requiresCompleteLineups && (prior.completeness !== 'complete-five-role' || current.completeness !== 'complete-five-role')) {
    return undefined
  }

  const priorPlayerByRole = new Map(prior.players.map((player) => [player.role, player.id]))
  let retainedValue = 0
  let totalValue = 0

  for (const player of current.players) {
    const roleValue = config.roleValueWeights[player.role] ?? 0
    totalValue += roleValue
    if (priorPlayerByRole.get(player.role) === player.id) {
      retainedValue += roleValue
    }
  }

  if (totalValue <= 0) return undefined
  return retainedValue / totalValue
}

export function rosterFingerprint(roster?: MatchRosterSnapshot) {
  if (!roster || roster.completeness !== 'complete-five-role') return undefined
  return roster.players
    .toSorted((left, right) => roleOrder(left.role) - roleOrder(right.role))
    .map((player) => `${player.role}:${player.id}`)
    .join('|')
}

function compareMatchesByDateAndId(left: MatchRecord, right: MatchRecord) {
  return left.date.localeCompare(right.date) || left.id.localeCompare(right.id)
}

function roleOrder(role: Role) {
  return ['Top', 'Jungle', 'Mid', 'Bot', 'Support'].indexOf(role)
}
