import type { EventTier } from '../types'
import type {
  PublicTeamStanding,
  PublicTournamentMovementIndexEntry,
  PublicTournamentMovementShard,
} from './publicArtifacts/schema'

export type InternationalTournamentFamilyId = 'first-stand' | 'msi' | 'worlds' | 'ewc'
export type TournamentInstanceId = `${InternationalTournamentFamilyId}:${string}`
export type ExactTournamentFilterValue = `tournament:${TournamentInstanceId}`
export type TournamentFilterValue = 'All' | 'international' | ExactTournamentFilterValue
export type TournamentLifecycleStatus = 'ongoing' | 'completed' | 'unknown'

export type TournamentFilterOption = {
  value: TournamentFilterValue
  label: string
  count: number
  status?: TournamentLifecycleStatus
}

export type TournamentScheduleReference = {
  matchId?: string
  tournamentId?: string
  leagueName?: string
  leagueSlug?: string
  startTime?: string
  date?: string
  state?: string
  retrievedAt?: string
  coverageStart?: string
  coverageEnd?: string
  coverageEndComplete?: boolean
}

export type TournamentRatedMatchReference = {
  event: string
  season: number
  date: string
  officialMatchId?: string
  phase?: string
  tier?: EventTier
}

export type NormalizedTournamentInstance = {
  id: TournamentInstanceId
  family: InternationalTournamentFamilyId
  season: string
  label: string
  status: TournamentLifecycleStatus
  startDate: string
  boundaryDate: string
  ratedThroughDate: string
  scheduledEndDate?: string
  dataLag: boolean
  resultCoverageComplete: boolean
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

export function tournamentInstanceForEvent(
  event: string,
  fallbackSeason?: string | number,
): Pick<NormalizedTournamentInstance, 'id' | 'family' | 'season' | 'label'> | undefined {
  const family = tournamentFamilyForEvent(event)
  const season = tournamentSeason(event, fallbackSeason)
  if (!family || !season) return undefined
  return {
    id: `${family}:${season}`,
    family,
    season,
    label: `${tournamentFamilyLabel(family)} ${season}`,
  }
}

export function tournamentInstanceForSchedule(
  reference: TournamentScheduleReference,
): Pick<NormalizedTournamentInstance, 'id' | 'family' | 'season' | 'label'> | undefined {
  const event = [reference.leagueName, reference.leagueSlug].filter(Boolean).join(' ')
  return tournamentInstanceForEvent(event, reference.date?.slice(0, 4) ?? reference.startTime?.slice(0, 4))
}

export function deriveTournamentInstances({
  matches,
  scheduleReferences = [],
  generatedAt,
}: {
  matches: readonly TournamentRatedMatchReference[]
  scheduleReferences?: readonly TournamentScheduleReference[]
  generatedAt: string
}): NormalizedTournamentInstance[] {
  const matchesByInstance = groupByInstance(
    matches.filter(isMainTournamentEvidence),
    (match) => tournamentInstanceForEvent(match.event, match.season),
  )
  const scheduleByInstance = groupByInstance(canonicalScheduleReferences(scheduleReferences), tournamentInstanceForSchedule)
  const generatedDate = generatedAt.slice(0, 10)

  return [...matchesByInstance.entries()]
    .flatMap(([id, instanceMatches]): NormalizedTournamentInstance[] => {
      const schedule = scheduleByInstance.get(id) ?? []
      const scheduleDates = schedule.map(scheduleDate).filter((date): date is string => Boolean(date)).sort()
      const scheduledStartDate = scheduleDates[0]
      const scheduleOpeningIsCovered = Boolean(
        scheduledStartDate
        && coverageLeadDays(schedule.map((reference) => reference.coverageStart), scheduledStartDate) >= 7,
      )
      const reconciledMatches = scheduledStartDate && scheduleOpeningIsCovered
        ? instanceMatches.filter((match) => match.date >= scheduledStartDate)
        : instanceMatches
      if (reconciledMatches.length === 0) return []
      const identity = tournamentInstanceForEvent(reconciledMatches[0]!.event, reconciledMatches[0]!.season)!
      const ratedDates = reconciledMatches.map((match) => match.date).filter(isDateString).sort()
      if (ratedDates.length === 0) return []
      const coverageEnds = schedule.map((reference) => reference.coverageEnd).filter((date): date is string => Boolean(date && isDateString(date))).sort()
      const coverageStarts = schedule.map((reference) => reference.coverageStart).filter((date): date is string => Boolean(date && isDateString(date))).sort()
      const retrievedDates = schedule.map((reference) => reference.retrievedAt?.slice(0, 10)).filter((date): date is string => Boolean(date && isDateString(date))).sort()
      const startDate = ratedDates[0]!
      const ratedThroughDate = ratedDates.at(-1)!
      const scheduledEndDate = scheduleDates.at(-1)
      const coverageEnd = coverageEnds.at(-1)
      const coverageStart = coverageStarts[0]
      const retrievedDate = retrievedDates.at(-1)
      const completedScheduleDate = schedule
        .filter((reference) => isCompletedScheduleState(reference.state))
        .map(scheduleDate)
        .filter((date): date is string => Boolean(date))
        .sort()
        .at(-1)
      const allScheduleRowsCompleted = schedule.length > 0 && schedule.every((reference) => isCompletedScheduleState(reference.state))
      const completedScheduleMatchIds = new Set(
        schedule
          .filter((reference) => isCompletedScheduleState(reference.state) && reference.matchId)
          .map((reference) => reference.matchId!),
      )
      const ratedOfficialMatchIds = new Set(
        reconciledMatches
          .map((match) => match.officialMatchId)
          .filter((matchId): matchId is string => Boolean(matchId)),
      )
      const scheduleCoversTournament = Boolean(
        scheduledStartDate
        && scheduledEndDate
        && coverageStart
        && coverageEnd
        && coverageStart <= scheduledStartDate
        && coverageEnd >= scheduledEndDate
        && schedule.some((reference) => reference.coverageEndComplete),
      )
      const scheduleIsCurrent = Boolean(coverageEnd && coverageEnd >= generatedDate && retrievedDate && daysBetween(retrievedDate, generatedDate) <= 3)
      const hasOpenScheduleRow = schedule.some((reference) => !isCompletedScheduleState(reference.state))
      const status: TournamentLifecycleStatus = allScheduleRowsCompleted && scheduleCoversTournament
        ? 'completed'
        : hasOpenScheduleRow && scheduleIsCurrent && Boolean(scheduledEndDate && scheduledEndDate >= generatedDate)
          ? 'ongoing'
          : 'unknown'
      const boundaryDate = status === 'completed'
        ? scheduledEndDate!
        : status === 'ongoing'
          ? generatedDate
          : ratedThroughDate
      const resultCoverageComplete = allScheduleRowsCompleted
        && completedScheduleMatchIds.size > 0
        && [...completedScheduleMatchIds].every((matchId) => ratedOfficialMatchIds.has(matchId))

      return [{
        ...identity,
        status,
        startDate,
        boundaryDate,
        ratedThroughDate,
        ...(scheduledEndDate ? { scheduledEndDate } : {}),
        dataLag: Boolean(completedScheduleDate && completedScheduleDate > ratedThroughDate),
        resultCoverageComplete,
      }]
    })
    .sort((left, right) => right.startDate.localeCompare(left.startDate) || left.label.localeCompare(right.label))
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
  standing: Pick<PublicTeamStanding, 'teamId' | 'recentMatches' | 'tournamentAppearances'>,
  filter: TournamentFilterValue,
  exactParticipantTeamIds?: ReadonlySet<string>,
) {
  if (filter === 'All') return true
  if (filter === 'international') return tournamentFamiliesForStanding(standing).length > 0
  return exactParticipantTeamIds?.has(standing.teamId) ?? false
}

export function projectTournamentStandings(
  standings: readonly PublicTeamStanding[],
  tournament: PublicTournamentMovementShard,
): PublicTeamStanding[] {
  const standingById = new Map(standings.map((standing) => [standing.teamId, standing]))
  return tournament.teams.flatMap((movement): PublicTeamStanding[] => {
    const standing = standingById.get(movement.teamId)
    if (!standing) return []
    const matchContexts = movement.points.flatMap((point) => point[3]?.result ? [point[3]] : [])
    const wins = matchContexts.filter((context) => context.result === 'W').length
    const losses = matchContexts.filter((context) => context.result === 'L').length
    return [{
      ...standing,
      rating: movement.endRating,
      previousRating: movement.startRating,
      delta: movement.ratingDelta,
      rank: movement.endRank,
      previousRank: movement.startRank,
      movement: movement.rankMovement,
      wins,
      losses,
      form: matchContexts.map((context) => context.result!),
      eligibility: {
        ...standing.eligibility,
        eligible: movement.eligible,
        reasons: movement.eligibilityReasons,
      },
      recentEvents: [tournament.label],
      recentMatches: [],
      deservedStanding: undefined,
    }]
  })
}

export function tournamentFilterOptionsForStandings(
  standings: readonly Pick<PublicTeamStanding, 'recentMatches' | 'tournamentAppearances'>[],
  tournamentEntries: readonly PublicTournamentMovementIndexEntry[] = [],
): TournamentFilterOption[] {
  const internationalCount = standings.filter((standing) => tournamentFamiliesForStanding(standing).length > 0).length

  return [
    { value: 'All', label: 'All', count: standings.length },
    ...(internationalCount > 0 ? [{ value: 'international' as const, label: 'International', count: internationalCount }] : []),
    ...tournamentEntries.map((entry) => ({
      value: `tournament:${entry.id}` as ExactTournamentFilterValue,
      label: `${entry.label} · ${tournamentStatusLabel(entry.status)}`,
      count: entry.participantCount,
      status: entry.status,
    })),
  ]
}

export function tournamentEntriesForScope(
  entries: readonly PublicTournamentMovementIndexEntry[],
  season: string,
  window?: { startDate: string; endDate: string },
) {
  if (season === 'All') return [...entries]
  const seasonEntries = entries.filter((entry) => entry.season === season)
  if (!window) return seasonEntries
  return seasonEntries.filter((entry) => entry.startDate <= window.endDate && entry.ratedThroughDate >= window.startDate)
}

export function tournamentIdFromFilter(filter: TournamentFilterValue): TournamentInstanceId | undefined {
  return filter.startsWith('tournament:') ? filter.slice('tournament:'.length) as TournamentInstanceId : undefined
}

export function tournamentStatusLabel(status: TournamentLifecycleStatus) {
  if (status === 'completed') return 'Completed'
  if (status === 'ongoing') return 'Ongoing'
  return 'Latest data'
}

export function tournamentBoundaryLabel(status: TournamentLifecycleStatus) {
  if (status === 'completed') return 'Final'
  if (status === 'ongoing') return 'Today'
  return 'Latest data'
}

function tournamentFamilyLabel(family: InternationalTournamentFamilyId) {
  return tournamentFamilies.find((definition) => definition.value === family)?.label ?? family
}

function tournamentSeason(event: string, fallbackSeason?: string | number) {
  const explicit = event.match(/\b(20\d{2})\b/)?.[1]
  if (explicit) return explicit
  const fallback = String(fallbackSeason ?? '')
  return /^20\d{2}$/.test(fallback) ? fallback : undefined
}

function groupByInstance<T>(
  values: readonly T[],
  identify: (value: T) => Pick<NormalizedTournamentInstance, 'id'> | undefined,
) {
  const grouped = new Map<TournamentInstanceId, T[]>()
  for (const value of values) {
    const identity = identify(value)
    if (!identity) continue
    const entries = grouped.get(identity.id) ?? []
    entries.push(value)
    grouped.set(identity.id, entries)
  }
  return grouped
}

function scheduleDate(reference: TournamentScheduleReference) {
  const date = reference.date ?? reference.startTime?.slice(0, 10)
  return date && isDateString(date) ? date : undefined
}

function isMainTournamentEvidence(match: TournamentRatedMatchReference) {
  if (match.tier === 'qualifier') return false
  return !/\b(?:online\s+)?qualifiers?\b|\bregional finals?\b|\broad to\b/i.test(`${match.event} ${match.phase ?? ''}`)
}

function coverageLeadDays(values: Array<string | undefined>, scheduledStartDate: string) {
  const coverageStart = values.filter((value): value is string => Boolean(value && isDateString(value))).sort()[0]
  return coverageStart ? daysBetween(coverageStart, scheduledStartDate) : -1
}

function canonicalScheduleReferences(references: readonly TournamentScheduleReference[]) {
  const latestByMatchId = new Map<string, TournamentScheduleReference>()
  const withoutMatchId: TournamentScheduleReference[] = []
  for (const reference of references) {
    if (!reference.matchId) {
      withoutMatchId.push(reference)
      continue
    }
    const current = latestByMatchId.get(reference.matchId)
    if (!current || (reference.retrievedAt ?? '').localeCompare(current.retrievedAt ?? '') > 0) {
      latestByMatchId.set(reference.matchId, reference)
    }
  }
  return [...withoutMatchId, ...latestByMatchId.values()]
}

function daysBetween(start: string, end: string) {
  return Math.max(0, Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000))
}

function isCompletedScheduleState(state: string | undefined) {
  return /^(?:completed|complete)$/i.test(state ?? '')
}

function isDateString(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function uniqueTournamentFamilies(families: InternationalTournamentFamilyId[]) {
  return tournamentFamilies
    .map((family) => family.value)
    .filter((family) => families.includes(family))
}
