import type { MatchRecord, MatchRosterSnapshot, Role, RosterBasis } from '../types'

const rosterRoleShares: Record<Role, number> = {
  Top: 0.18,
  Jungle: 0.22,
  Mid: 0.22,
  Bot: 0.2,
  Support: 0.18,
}

export type TeamRosterKnowledge = {
  latestObserved?: MatchRosterSnapshot
  latestComplete?: MatchRosterSnapshot
}

export type RosterContinuityConfig = {
  roleValueWeights: Record<Role, number>
  requiresCompleteLineups: boolean
}

export const defaultRosterContinuityConfig: RosterContinuityConfig = {
  roleValueWeights: rosterRoleShares,
  requiresCompleteLineups: true,
}

export function latestRosterByTeam(matches: MatchRecord[]): Map<string, MatchRosterSnapshot> {
  return new Map(
    [...rosterKnowledgeByTeam(matches)].flatMap(([team, knowledge]) =>
      knowledge.latestObserved ? [[team, knowledge.latestObserved] as const] : []),
  )
}

export function rosterKnowledgeByTeam(matches: readonly MatchRecord[]): Map<string, TeamRosterKnowledge> {
  const knowledge = new Map<string, TeamRosterKnowledge>()

  for (const match of matches.toSorted(compareMatchesByDateAndId)) {
    recordRosterKnowledge(knowledge, match.teamA, match.teamARoster)
    recordRosterKnowledge(knowledge, match.teamB, match.teamBRoster)
  }

  return knowledge
}

export function rosterBasisByTeam(matches: MatchRecord[]): Map<string, RosterBasis> {
  return new Map(
    Array.from(rosterKnowledgeByTeam(matches).entries()).map(([team, knowledge]) => [
      team,
      knowledge.latestComplete ? 'sourced' : 'assumed-continuous',
    ]),
  )
}

export function mergeRosterObservation(
  previous: MatchRosterSnapshot | undefined,
  observed: MatchRosterSnapshot | undefined,
): MatchRosterSnapshot | undefined {
  if (!observed) return previous
  if (!previous || observed.completeness === 'complete-five-role') return observed

  const observedByRole = new Map(observed.players.map((player) => [player.role, player]))
  const players = previous.players
    .map((player) => observedByRole.get(player.role) ?? player)
    .concat(observed.players.filter((player) => !previous.players.some((prior) => prior.role === player.role)))
    .toSorted((left, right) => roleOrder(left.role) - roleOrder(right.role))
  const coveredRoles = new Set(players.map((player) => player.role))
  return {
    ...observed,
    completeness: coveredRoles.size === 5 ? 'complete-five-role' : 'partial',
    players,
  }
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
  return left.date.localeCompare(right.date)
    || (left.datetimeUtc ?? '').localeCompare(right.datetimeUtc ?? '')
    || left.id.localeCompare(right.id)
}

function recordRosterKnowledge(
  knowledge: Map<string, TeamRosterKnowledge>,
  team: string,
  roster: MatchRosterSnapshot | undefined,
) {
  if (!roster) return
  const current = knowledge.get(team) ?? {}
  current.latestObserved = roster
  if (roster.completeness === 'complete-five-role') current.latestComplete = roster
  knowledge.set(team, current)
}

function roleOrder(role: Role) {
  return ['Top', 'Jungle', 'Mid', 'Bot', 'Support'].indexOf(role)
}
