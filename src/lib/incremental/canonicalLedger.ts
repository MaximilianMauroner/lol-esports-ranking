import { communityMatchInfluenceKeys } from '../importers/communitySources'
import { canonicalSeriesId } from '../seriesResolver'
import { stableHash } from './hash'
import type { CanonicalContextDigests } from './dependencyDigests'
import type { CanonicalRankingInput } from './canonicalState'
import type { ProviderObservation } from './providerLedger'
import type { IncrementalFallbackReason } from './types'

export const CANONICAL_LEDGER_SCHEMA_VERSION = 1 as const

export type CanonicalDatePartition = {
  date: string
  matchIds: string[]
  payloadHash: string
  prefixRoot: string
}

export type CanonicalLedger = {
  schemaVersion: typeof CANONICAL_LEDGER_SCHEMA_VERSION
  matches: CanonicalRankingInput['matches']
  teams: CanonicalRankingInput['teams']
  importedMatches: CanonicalRankingInput['importedMatches']
  partitions: CanonicalDatePartition[]
  observationToGroups: Record<string, string[]>
  groupToObservations: Record<string, string[]>
  contextDigests: CanonicalContextDigests
  rootHash: string
}

export function buildCanonicalLedger({
  canonical,
  observations,
  contextDigests,
}: {
  canonical: CanonicalRankingInput
  observations: ProviderObservation[]
  contextDigests: CanonicalContextDigests
}): CanonicalLedger {
  const observationToGroups: Record<string, string[]> = {}
  const groupToObservations: Record<string, string[]> = {}
  for (const observation of observations) {
    const groups = influenceGroups(observation)
    observationToGroups[observation.id] = [...new Set([...(observationToGroups[observation.id] ?? []), ...groups])].sort()
    for (const group of groups) {
      groupToObservations[group] = [...new Set([...(groupToObservations[group] ?? []), observation.id])].sort()
    }
  }

  let prefixRoot = stableHash({ schemaVersion: CANONICAL_LEDGER_SCHEMA_VERSION, contextDigests })
  const matchesByDate = new Map<string, CanonicalRankingInput['matches']>()
  for (const match of canonical.matches) matchesByDate.set(match.date, [...(matchesByDate.get(match.date) ?? []), match])
  const partitions = [...matchesByDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, matches]) => {
      const ordered = matches.toSorted((left, right) => left.id.localeCompare(right.id))
      const payloadHash = stableHash(ordered)
      prefixRoot = stableHash({ prefixRoot, date, payloadHash })
      return { date, matchIds: ordered.map((match) => match.id), payloadHash, prefixRoot }
    })
  return {
    schemaVersion: CANONICAL_LEDGER_SCHEMA_VERSION,
    ...canonical,
    partitions,
    observationToGroups,
    groupToObservations,
    contextDigests,
    rootHash: stableHash({
      matches: canonical.matches,
      importedMatches: canonical.importedMatches,
      teams: canonical.teams,
      partitions,
      contextDigests,
      observationToGroups,
      groupToObservations,
    }),
  }
}

export function affectedObservationClosure({
  previous,
  changedObservationIds,
  currentObservations,
}: {
  previous: CanonicalLedger
  changedObservationIds: string[]
  currentObservations: ProviderObservation[]
}): { observationIds: string[]; fallback?: IncrementalFallbackReason } {
  const currentById = new Map<string, ProviderObservation[]>()
  const currentGroupToIds = new Map<string, Set<string>>()
  for (const observation of currentObservations) {
    currentById.set(observation.id, [...(currentById.get(observation.id) ?? []), observation])
    for (const group of influenceGroups(observation)) {
      const ids = currentGroupToIds.get(group) ?? new Set<string>()
      ids.add(observation.id)
      currentGroupToIds.set(group, ids)
    }
  }
  const pending = [...changedObservationIds]
  const affected = new Set<string>()
  while (pending.length > 0) {
    const observationId = pending.pop()
    if (!observationId || affected.has(observationId)) continue
    const previousGroups = previous.observationToGroups[observationId]
    const current = currentById.get(observationId) ?? []
    if (!previousGroups && current.length === 0) {
      return {
        observationIds: [],
        fallback: { kind: 'dependency-unknown', dependency: `canonical-closure:${observationId}` },
      }
    }
    affected.add(observationId)
    const groups = new Set([...(previousGroups ?? []), ...current.flatMap(influenceGroups)])
    for (const group of groups) {
      for (const related of previous.groupToObservations[group] ?? []) pending.push(related)
      for (const related of currentGroupToIds.get(group) ?? []) pending.push(related)
    }
  }
  return { observationIds: [...affected].sort() }
}

function influenceGroups(observation: ProviderObservation): string[] {
  if (observation.kind === 'schedule') {
    const teams = observation.payload.teams.map((team) => team.name).sort().join('::')
    return [`official:${observation.payload.matchId}`, `schedule:${observation.payload.date ?? 'unknown'}:${teams}`]
  }
  return [...new Set([
    ...communityMatchInfluenceKeys(observation.payload),
    `series:${canonicalSeriesId(observation.payload)}`,
  ])].sort()
}
