import type { PublicTeamStanding } from './publicArtifacts/schema'

export type InternationalTournamentFamilyId = 'first-stand' | 'msi' | 'worlds' | 'ewc'
export type TournamentFilterValue = 'All' | 'international' | InternationalTournamentFamilyId

export type TournamentFilterOption = {
  value: TournamentFilterValue
  label: string
  count: number
}

type TournamentFamilyDefinition = {
  value: InternationalTournamentFamilyId
  label: string
  matches: (event: string) => boolean
}

const tournamentFamilies: TournamentFamilyDefinition[] = [
  {
    value: 'first-stand',
    label: 'First Stand',
    matches: (event) => /\b(?:fst|first stand)\b/i.test(event),
  },
  {
    value: 'msi',
    label: 'MSI',
    matches: (event) => /\b(?:msi|mid-season invitational)\b/i.test(event) && !/\broad to msi\b/i.test(event),
  },
  {
    value: 'worlds',
    label: 'Worlds',
    matches: (event) => /\b(?:worlds|wlds|world championship)\b/i.test(event),
  },
  {
    value: 'ewc',
    label: 'Esports World Cup',
    matches: (event) => /\b(?:ewc|esports world cup)\b/i.test(event) && !/\b(?:online\s+)?qualifiers?\b/i.test(event),
  },
]

export function tournamentFamilyForEvent(event: string): InternationalTournamentFamilyId | undefined {
  return tournamentFamilies.find((family) => family.matches(event))?.value
}

export function tournamentFamiliesForStanding(
  standing: Pick<PublicTeamStanding, 'recentMatches' | 'tournamentAppearances'>,
): InternationalTournamentFamilyId[] {
  if (standing.tournamentAppearances?.length) {
    return uniqueTournamentFamilies(standing.tournamentAppearances.map((appearance) => appearance.family))
  }

  return uniqueTournamentFamilies(
    standing.recentMatches
      .map((match) => tournamentFamilyForEvent(match.event))
      .filter((family): family is InternationalTournamentFamilyId => Boolean(family)),
  )
}

export function teamMatchesTournamentFilter(
  standing: Pick<PublicTeamStanding, 'recentMatches' | 'tournamentAppearances'>,
  filter: TournamentFilterValue,
) {
  if (filter === 'All') return true
  const families = tournamentFamiliesForStanding(standing)
  if (filter === 'international') return families.length > 0
  return families.includes(filter)
}

export function tournamentFilterOptionsForStandings(
  standings: readonly Pick<PublicTeamStanding, 'recentMatches' | 'tournamentAppearances'>[],
): TournamentFilterOption[] {
  const counts = new Map<InternationalTournamentFamilyId, number>()
  let internationalCount = 0

  for (const standing of standings) {
    const families = tournamentFamiliesForStanding(standing)
    if (families.length === 0) continue
    internationalCount += 1
    for (const family of families) {
      counts.set(family, (counts.get(family) ?? 0) + 1)
    }
  }

  return [
    { value: 'All', label: 'All', count: standings.length },
    ...(internationalCount > 0 ? [{ value: 'international' as const, label: 'International', count: internationalCount }] : []),
    ...tournamentFamilies
      .map((family) => ({ value: family.value, label: family.label, count: counts.get(family.value) ?? 0 }))
      .filter((option) => option.count > 0),
  ]
}

function uniqueTournamentFamilies(families: InternationalTournamentFamilyId[]) {
  return tournamentFamilies
    .map((family) => family.value)
    .filter((family) => families.includes(family))
}
