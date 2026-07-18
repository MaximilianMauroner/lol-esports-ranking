import { regionalSplitCalendars } from '../../data/rankingCalendar'
import type { MatchRecord, TeamProfile } from '../../types'
import { stableHash } from './hash'

export type CanonicalContextDigests = {
  identities: string
  profiles: string
  eventWeights: string
  schedules: string
  calendar: string
}

export function canonicalContextDigests({
  identities,
  profiles,
  eventWeightContext,
  schedules,
}: {
  identities: unknown
  profiles: Record<string, TeamProfile>
  eventWeightContext: unknown
  schedules: unknown
}): CanonicalContextDigests {
  return {
    identities: stableHash(identities),
    profiles: stableHash(profiles),
    eventWeights: stableHash(eventWeightContext),
    schedules: stableHash(schedules),
    calendar: stableHash(regionalSplitCalendars),
  }
}

export function earliestAppearance(matches: MatchRecord[], identities: Iterable<string>): string | undefined {
  const affected = new Set(identities)
  return matches
    .filter((match) => affected.has(match.teamA) || affected.has(match.teamB))
    .map((match) => match.date)
    .sort()[0]
}
