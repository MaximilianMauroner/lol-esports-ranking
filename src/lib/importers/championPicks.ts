import type { ChampionPicks, Role } from '../../types'

export const PICK_ROLES: readonly Role[] = ['Top', 'Jungle', 'Mid', 'Bot', 'Support']

/** Reads five role-ordered names. A game with no recorded champion has no picks. */
export function championPicks(names: readonly (string | undefined)[]): ChampionPicks | undefined {
  if (names.length !== PICK_ROLES.length || names.every((name) => !name)) return undefined
  return names.map((name) => name || null) as ChampionPicks
}
