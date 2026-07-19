import type { MatchRecord, TeamProfile } from '../../types.ts'
import { eventWeightContextForMatches, isWorldsEventMatch } from '../eventWeighting.ts'
import type { TeamReducerCheckpoint } from '../model.ts'
import {
  isPlacementDependencyEvent,
  placementEventKeyForMatch,
  type PlacementTournamentLifecycle,
} from '../placementResiduals.ts'
import type { LivePlayerEdgeCheckpoint } from '../playerModel.ts'
import { encodePrivateState } from './canonicalCodec.ts'
import { sha256Hex, stableHash } from './hash.ts'

export const REDUCER_CHECKPOINT_SCHEMA_VERSION = 1 as const

export type ReducerCheckpointRetention =
  | 'recent-daily'
  | 'monthly'
  | 'season-boundary'
  | 'international-boundary'

export type IncrementalReducerCheckpoint = {
  schemaVersion: typeof REDUCER_CHECKPOINT_SCHEMA_VERSION
  processedDate?: string
  canonicalPrefixHash: string
  dependencyHash: string
  dependencyPlan: ReducerDependencyPlan
  retention: ReducerCheckpointRetention[]
  livePlayerEdge: LivePlayerEdgeCheckpoint
  team: TeamReducerCheckpoint
}

export type ReducerDependencyBoundary = {
  key: string
  startDate: string
  hash: string
}

export type ReducerDependencyPlan = {
  schemaVersion: 1
  stableHash: string
  boundaries: ReducerDependencyBoundary[]
}

export type PersistedReducerCheckpointCore = Omit<IncrementalReducerCheckpoint, 'team'> & {
  team: Omit<TeamReducerCheckpoint, 'journals'>
  teamJournalHashes: ReducerJournalHashes
}

export type ReducerJournalHashes = {
  histories: string
  predictions: string
  leagueHistory: string
}

export function canonicalPrefixHash(matches: MatchRecord[], throughDate?: string) {
  return stableHash(matches
    .filter((match) => !throughDate || match.date <= throughDate)
    .toSorted((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id)))
}

export function selectLatestReducerCheckpoint(
  checkpoints: IncrementalReducerCheckpoint[],
  matches: MatchRecord[],
  dependencyPlan: ReducerDependencyPlan,
) {
  return checkpoints
    .filter((checkpoint) => reducerCheckpointCanResume(checkpoint, matches, dependencyPlan))
    .toSorted((left, right) => (left.processedDate ?? '').localeCompare(right.processedDate ?? ''))
    .at(-1)
}

export function reducerCheckpointCanResume(
  checkpoint: IncrementalReducerCheckpoint,
  matches: MatchRecord[],
  dependencyPlan: ReducerDependencyPlan,
) {
  const dependencyChange = reducerDependencyChange(checkpoint.dependencyPlan, dependencyPlan)
  if (!dependencyChange.stableCompatible) return false
  if (dependencyChange.influenceDate && (!checkpoint.processedDate || checkpoint.processedDate >= dependencyChange.influenceDate)) return false
  if (checkpoint.processedDate !== checkpoint.livePlayerEdge.processedDate
    || checkpoint.processedDate !== checkpoint.team.processedDate) return false
  if (checkpoint.processedDate && !matches.some((match) => match.date === checkpoint.processedDate)) return false
  return checkpoint.canonicalPrefixHash === canonicalPrefixHash(matches, checkpoint.processedDate)
}

export function buildReducerDependencyPlan({
  matches,
  teams,
  tournamentLifecycles = new Map(),
}: {
  matches: MatchRecord[]
  teams: Record<string, TeamProfile>
  tournamentLifecycles?: ReadonlyMap<string, PlacementTournamentLifecycle>
}): ReducerDependencyPlan {
  const sortedMatches = matches.toSorted((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id))
  const boundaries: ReducerDependencyBoundary[] = []
  const firstDate = sortedMatches[0]?.date
  if (firstDate) {
    const participatingTeams = [...new Set(sortedMatches.flatMap((match) => [match.teamA, match.teamB]))].sort()
    boundaries.push({
      key: 'profiles',
      startDate: firstDate,
      hash: privateStateHash(participatingTeams.map((team) => [team, teams[team]])),
    })
  }
  const placementMatches = groupMatches(sortedMatches.filter(isPlacementDependencyEvent), placementEventKeyForMatch)
  for (const [key, eventMatches] of placementMatches) {
    boundaries.push({
      key: `placement:${key}`,
      startDate: eventMatches[0]!.date,
      hash: privateStateHash({ matches: eventMatches, lifecycle: tournamentLifecycles.get(key) }),
    })
  }
  const worldsMatches = groupMatches(sortedMatches.filter(isWorldsEventMatch), (match) => match.date.slice(0, 4))
  const eventWeightContext = eventWeightContextForMatches(sortedMatches)
  for (const [year, eventMatches] of worldsMatches) {
    boundaries.push({
      key: `worlds:${year}`,
      startDate: eventMatches[0]!.date,
      hash: privateStateHash({ matches: eventMatches, endDate: eventWeightContext.worldsEndDateByCalendarYear.get(Number(year)) }),
    })
  }
  return {
    schemaVersion: 1,
    stableHash: privateStateHash({ reducerSchema: 'incremental-ranking-reducer-v2' }),
    boundaries: boundaries.toSorted((left, right) => left.startDate.localeCompare(right.startDate) || left.key.localeCompare(right.key)),
  }
}

export function reducerDependencyChange(previous: ReducerDependencyPlan, current: ReducerDependencyPlan) {
  if (previous.schemaVersion !== current.schemaVersion || previous.stableHash !== current.stableHash) {
    return { stableCompatible: false, influenceDate: undefined }
  }
  const previousByKey = new Map(previous.boundaries.map((boundary) => [boundary.key, boundary]))
  const currentByKey = new Map(current.boundaries.map((boundary) => [boundary.key, boundary]))
  const changedDates = [...new Set([...previousByKey.keys(), ...currentByKey.keys()])].flatMap((key) => {
    const before = previousByKey.get(key)
    const after = currentByKey.get(key)
    return before?.hash === after?.hash ? [] : [before?.startDate, after?.startDate].filter((date): date is string => Boolean(date))
  })
  return { stableCompatible: true, influenceDate: changedDates.sort()[0] }
}

export function retainReducerCheckpointCatalog(
  checkpoints: IncrementalReducerCheckpoint[],
  matches: MatchRecord[],
  recentDailyCount = 32,
) {
  const ordered = [...new Map(checkpoints.map((checkpoint) => [checkpoint.processedDate ?? '', checkpoint])).values()]
    .toSorted((left, right) => (left.processedDate ?? '').localeCompare(right.processedDate ?? ''))
  const retention = reducerCheckpointRetentionDates(matches, recentDailyCount)
  if (ordered.length === 1 && ordered[0]?.processedDate === undefined) retention.set('', ['recent-daily'])
  return ordered.flatMap((checkpoint) => {
    const classes = retention.get(checkpoint.processedDate ?? '') ?? []
    return classes.length > 0 ? [{ ...checkpoint, retention: classes }] : []
  })
}

export function reducerCheckpointRetentionDates(matches: MatchRecord[], recentDailyCount = 32) {
  const checkpointDates = [...new Set(matches.map((match) => match.date))].sort()
  const retention = new Map(checkpointDates.map((date) => [date, new Set<ReducerCheckpointRetention>()]))
  for (const date of checkpointDates.slice(-recentDailyCount)) retention.get(date)?.add('recent-daily')
  const lastByMonth = new Map<string, string>()
  for (const date of checkpointDates) lastByMonth.set(date.slice(0, 7), date)
  for (const date of lastByMonth.values()) markDate(retention, date, 'monthly')

  const datesBySeason = groupMatchDates(matches, (match) => String(match.season))
  for (const dates of datesBySeason.values()) {
    markDate(retention, dates.at(0), 'season-boundary')
    markDate(retention, dates.at(-1), 'season-boundary')
  }
  const internationalDates = groupMatchDates(
    matches.filter(isPlacementDependencyEvent),
    (match) => `${match.season}\u0000${match.event}`,
  )
  for (const dates of internationalDates.values()) {
    const first = dates.at(0)
    markDate(retention, first, 'international-boundary')
    markDate(retention, dates.at(-1), 'international-boundary')
    if (first) markDate(retention, checkpointDates.filter((date) => date < first).at(-1), 'international-boundary')
  }
  return new Map([...retention].map(([date, classes]) => [date, [...classes].sort()]))
}

function groupMatchDates(matches: MatchRecord[], keyFor: (match: MatchRecord) => string) {
  const groups = new Map<string, string[]>()
  for (const match of matches.toSorted((left, right) => left.date.localeCompare(right.date))) {
    const key = keyFor(match)
    const dates = groups.get(key) ?? []
    if (dates.at(-1) !== match.date) dates.push(match.date)
    groups.set(key, dates)
  }
  return groups
}

function markDate(
  retention: Map<string, Set<ReducerCheckpointRetention>>,
  date: string | undefined,
  retentionClass: ReducerCheckpointRetention,
) {
  if (date) retention.get(date)?.add(retentionClass)
}

function groupMatches(matches: MatchRecord[], keyFor: (match: MatchRecord) => string) {
  const groups = new Map<string, MatchRecord[]>()
  for (const match of matches) groups.set(keyFor(match), [...(groups.get(keyFor(match)) ?? []), match])
  return groups
}

export function reducerDependencyHash(value: unknown) {
  return privateStateHash(value)
}

export function privateStateHash(value: unknown) {
  return sha256Hex(encodePrivateState(value))
}

export function isIncrementalReducerCheckpoint(value: unknown): value is IncrementalReducerCheckpoint {
  if (!isRecord(value)
    || value.schemaVersion !== REDUCER_CHECKPOINT_SCHEMA_VERSION
    || typeof value.canonicalPrefixHash !== 'string'
    || typeof value.dependencyHash !== 'string'
    || !isReducerDependencyPlan(value.dependencyPlan)
    || value.dependencyHash !== privateStateHash(value.dependencyPlan)
    || !Array.isArray(value.retention)
    || value.retention.some((entry) => !isRetentionClass(entry))
    || !isRecord(value.livePlayerEdge)
    || value.livePlayerEdge.schemaVersion !== 1
    || !isRecord(value.livePlayerEdge.state)
    || !(value.livePlayerEdge.journal instanceof Map)
    || !isRecord(value.team)
    || value.team.schemaVersion !== 1
    || !isRecord(value.team.state)
    || !isRecord(value.team.journals)) return false
  const journals = value.team.journals
  return journals.histories instanceof Map
    && Array.isArray(journals.predictions)
    && Array.isArray(journals.leagueHistory)
}

function isReducerDependencyPlan(value: unknown): value is ReducerDependencyPlan {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.stableHash === 'string'
    && Array.isArray(value.boundaries)
    && value.boundaries.every((boundary) => isRecord(boundary)
      && typeof boundary.key === 'string'
      && typeof boundary.startDate === 'string'
      && typeof boundary.hash === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRetentionClass(value: unknown): value is ReducerCheckpointRetention {
  return value === 'recent-daily'
    || value === 'monthly'
    || value === 'season-boundary'
    || value === 'international-boundary'
}
