import type { MatchRecord } from '../types'
import type { EventWeightContext } from './eventWeighting'
import { buildEventTrackers, eventTrackerKey, type PlacementTournamentLifecycle } from './placementResiduals'
import { recencyWeight } from './ratingCalculations'
import type { RatingRunState } from './ratingRunState'

const includedRatingRunStateFields = [
  'ratings',
  'executionRatings',
  'previousDisplayRatings',
  'momentums',
  'rosterPriorOffsets',
  'latestRatingUpdates',
  'leaguePlacementDeltas',
  'wins',
  'losses',
  'forms',
  'histories',
  'factorSums',
  'factorCounts',
  'leagueScores',
  'previousLeagueScores',
  'uncertainties',
  'leagueWins',
  'leagueLosses',
  'leagueExpectedWins',
  'leagueOpponentRatingSums',
  'leagueForms',
  'leagueMatchCounts',
  'leagueLastEvents',
  'leagueLastUpdated',
  'leagueHistory',
  'predictions',
  'sideAdjustmentSamples',
  'lastRosterByTeam',
  'currentRosterContinuity',
  'lastPatchByTeam',
  'lastRosterFingerprintByTeam',
  'eventTrackers',
  'eventWeightContext',
  'previousMatch',
  'processedThroughUtcDate',
  'processedThroughUtcDateMatchIds',
  'processedMatchCount',
] as const satisfies readonly (keyof RatingRunState)[]

export const ratingCheckpointInventory = {
  stateOwner: 'RatingRunState',
  includedFields: includedRatingRunStateFields,
  externalState: [
    {
      engine: 'SourcedPlayerState/player-model',
      status: 'causal-full-recompute',
      causalSurface: 'sourced-player',
      summaryOwner: 'sourced-player causal prefix summary',
      outputs: ['player standings', 'pregame player edges'],
      resumeRequirement: 'Validate the immutable raw prefix and the typed player context identity (rosters, fallbacks, teams, league strengths, and event context), then recompute from the full authoritative corpus.',
    },
    {
      engine: 'deserved-standing-team-state',
      status: 'causal-full-recompute',
      causalSurface: 'dss-team',
      summaryOwner: 'DSS team causal prefix summary',
      outputs: ['team summaries', 'team series ledgers'],
      resumeRequirement: 'Validate matches plus the typed DSS option identity; every custom callback requires an explicit stable semantic id.',
    },
    {
      engine: 'deserved-standing-region-state',
      status: 'causal-full-recompute',
      causalSurface: 'dss-region',
      summaryOwner: 'DSS region causal prefix summary',
      outputs: ['region summaries', 'region ledgers'],
      resumeRequirement: 'Validate matches, team profiles, region options, and explicit callback semantic ids, then rebuild from the full authoritative corpus.',
    },
    {
      engine: 'roster-era-ledger',
      status: 'causal-full-recompute',
      causalSurface: 'roster-era',
      summaryOwner: 'roster-era causal prefix summary plus open-era boundaries',
      outputs: ['roster eras and attribution ledgers'],
      resumeRequirement: 'Validate roster options and attribution callback semantic ids; an append touching an open era is causal from that era start.',
    },
    {
      engine: 'player-resume-ledger',
      status: 'causal-full-recompute',
      causalSurface: 'player-resume-ledger',
      summaryOwner: 'player-resume causal prefix summary',
      outputs: ['player resume ledgers', 'player resume credit entries'],
      resumeRequirement: 'Validate current scope and uncertainty callback identity, then rebuild from the full authoritative corpus.',
    },
    {
      engine: 'event-placement-state',
      status: 'checkpoint-reconciled',
      causalSurface: 'RatingCheckpointEventContract',
      summaryOwner: 'RatingRunState event trackers plus event contract',
      outputs: ['placement residuals', 'event weighting context'],
      resumeRequirement: 'Reconcile tournament lifecycle, participant, match, calendar, and event-context changes before rating resume.',
    },
  ],
  causalContextRequirement: 'Each summary binds a canonical fingerprint of all serializable non-row inputs. Custom functions require caller-supplied semantic ids; missing or mismatched proof always requires a full replay.',
  activation: 'foundation-only-production-disabled',
} as const

export type RatingCheckpointEventInventoryEntry = {
  id: string
  event: string
  season: number
  tier: MatchRecord['tier']
  startDate: string
  endDate: string
  participants: string[]
  matchIds: string[]
  eventWeightMultiplier: number
  lifecycle: PlacementTournamentLifecycle | null
}

export type RatingCheckpointEventContract = {
  eventContextFingerprint: string
  eventInventoryFingerprint: string
  worldsEndDateByCalendarYear: [number, string][]
  events: RatingCheckpointEventInventoryEntry[]
}

type CheckpointForEventReconciliation = {
  state: RatingRunState
  metadata: {
    processedThroughUtcDate: string
    eventContract: RatingCheckpointEventContract
  }
}

export type RatingCheckpointEventReconciliation =
  | {
      status: 'ready'
      state: RatingRunState
      mergedFutureEventIds: string[]
    }
  | {
      status: 'replay-required'
      replayFromUtcDate: string
      resumeAfterUtcDate?: string
      requiresFullReplay: boolean
      reason: 'event-structure-changed' | 'event-context-changed'
      affectedEventIds: string[]
    }

export function buildRatingCheckpointEventContract(
  matches: readonly MatchRecord[],
  eventWeightContext: EventWeightContext,
  tournamentLifecycles: ReadonlyMap<string, PlacementTournamentLifecycle> = new Map(),
): RatingCheckpointEventContract {
  const trackers = buildEventTrackers([...matches], eventWeightContext, tournamentLifecycles)
  return eventContractForTrackers(trackers, eventWeightContext, matchIdsByEvent(matches, trackers))
}

export function validateRatingCheckpointEventContract(
  state: RatingRunState,
  processedThroughUtcDate: string,
  contract: RatingCheckpointEventContract,
) {
  assertUtcDate(processedThroughUtcDate)
  const fromState = eventContractForTrackers(state.eventTrackers, state.eventWeightContext)
  if (stableJson(fromState) !== stableJson(contract)) {
    throw new Error('Rating checkpoint event inventory/context does not match RatingRunState')
  }
  for (const event of contract.events) {
    if (event.endDate > processedThroughUtcDate) {
      throw new Error(`Checkpoint event ${event.id} contains corpus data after its processed boundary`)
    }
    const tracker = state.eventTrackers.get(event.id)
    if (!tracker?.started) throw new Error(`Checkpoint event ${event.id} has not captured pre-event powers`)
    if (
      tracker.preEventPowers.size !== tracker.participants.size
      || [...tracker.participants].some((participant) => !tracker.preEventPowers.has(participant))
    ) {
      throw new Error(`Checkpoint event ${event.id} has incomplete pre-event powers`)
    }
    if (tracker.matches.some((match) => match.date > processedThroughUtcDate)) {
      throw new Error(`Checkpoint event ${event.id} tracked a future match`)
    }
  }
}

export function reconcileRatingCheckpointEvents({
  checkpoint,
  freshMatches,
  freshEventWeightContext,
  freshTournamentLifecycles = new Map(),
  availableProcessedThroughUtcDates = [],
}: {
  checkpoint: CheckpointForEventReconciliation
  freshMatches: readonly MatchRecord[]
  freshEventWeightContext: EventWeightContext
  freshTournamentLifecycles?: ReadonlyMap<string, PlacementTournamentLifecycle>
  availableProcessedThroughUtcDates?: readonly string[]
}): RatingCheckpointEventReconciliation {
  const boundary = checkpoint.metadata.processedThroughUtcDate
  validateRatingCheckpointEventContract(checkpoint.state, boundary, checkpoint.metadata.eventContract)
  const freshTrackers = buildEventTrackers([...freshMatches], freshEventWeightContext, freshTournamentLifecycles)
  const freshContract = eventContractForTrackers(
    freshTrackers,
    freshEventWeightContext,
    matchIdsByEvent(freshMatches, freshTrackers),
  )
  const storedById = new Map(checkpoint.metadata.eventContract.events.map((event) => [event.id, event]))
  const freshById = new Map(freshContract.events.map((event) => [event.id, event]))
  const affectedEvents = new Set<string>()
  const unsafeDates: string[] = []

  for (const [eventId, stored] of storedById) {
    const fresh = freshById.get(eventId)
    if (!fresh || stableJson(stored) !== stableJson(fresh)) {
      affectedEvents.add(eventId)
      unsafeDates.push(codeUnitMinimum(stored.startDate, fresh?.startDate) ?? stored.startDate)
    }
  }
  for (const [eventId, fresh] of freshById) {
    if (storedById.has(eventId) || fresh.startDate > boundary) continue
    affectedEvents.add(eventId)
    unsafeDates.push(fresh.startDate)
  }

  const contextReplayDate = eventContextReplayDate(
    checkpoint.metadata.eventContract.worldsEndDateByCalendarYear,
    freshContract.worldsEndDateByCalendarYear,
    boundary,
  )
  if (contextReplayDate) unsafeDates.push(contextReplayDate)

  if (unsafeDates.length > 0) {
    const replayFromUtcDate = unsafeDates.toSorted(compareCodeUnits)[0]!
    const replay = predecessorReplayBoundary(availableProcessedThroughUtcDates, replayFromUtcDate)
    return {
      status: 'replay-required',
      replayFromUtcDate,
      ...(replay.resumeAfterUtcDate ? { resumeAfterUtcDate: replay.resumeAfterUtcDate } : {}),
      requiresFullReplay: replay.requiresFullReplay,
      reason: contextReplayDate && replayFromUtcDate === contextReplayDate
        ? 'event-context-changed'
        : 'event-structure-changed',
      affectedEventIds: [...affectedEvents].sort(compareCodeUnits),
    }
  }

  const mergedFutureEventIds: string[] = []
  for (const [eventId, fresh] of freshById) {
    if (storedById.has(eventId)) continue
    if (fresh.startDate <= boundary) throw new Error(`Unsafe event ${eventId} passed reconciliation`)
    const tracker = freshTrackers.get(eventId)
    if (!tracker) throw new Error(`Missing fresh tracker ${eventId}`)
    checkpoint.state.eventTrackers.set(eventId, tracker)
    mergedFutureEventIds.push(eventId)
  }
  checkpoint.state.eventWeightContext = freshEventWeightContext
  rebaseFactorRecency(checkpoint.state, freshMatches)
  return {
    status: 'ready',
    state: checkpoint.state,
    mergedFutureEventIds: mergedFutureEventIds.sort(compareCodeUnits),
  }
}

function rebaseFactorRecency(state: RatingRunState, freshMatches: readonly MatchRecord[]) {
  const lastDate = freshMatches
    .map((match) => match.date)
    .sort(compareCodeUnits)
    .at(-1)
  if (!lastDate) return
  for (const [team, factors] of state.factorSums) {
    const histories = state.histories.get(team) ?? []
    state.factorSums.set(team, {
      ...factors,
      recency: histories.reduce((sum, point) => sum + recencyWeight(point.date, lastDate), 0),
    })
  }
}

export function isRatingCheckpointEventContract(value: unknown): value is RatingCheckpointEventContract {
  if (!isRecord(value)) return false
  return typeof value.eventContextFingerprint === 'string'
    && typeof value.eventInventoryFingerprint === 'string'
    && isWorldsEndDateEntries(value.worldsEndDateByCalendarYear)
    && Array.isArray(value.events)
    && value.events.every(isEventInventoryEntry)
}

function eventContractForTrackers(
  trackers: RatingRunState['eventTrackers'],
  eventWeightContext: EventWeightContext,
  corpusMatchIdsByEvent?: ReadonlyMap<string, readonly string[]>,
): RatingCheckpointEventContract {
  const worldsEndDateByCalendarYear = [...eventWeightContext.worldsEndDateByCalendarYear.entries()]
    .sort(([left], [right]) => left - right)
  const events = [...trackers.entries()]
    .map(([id, tracker]): RatingCheckpointEventInventoryEntry => ({
      id,
      event: tracker.event,
      season: tracker.season,
      tier: tracker.tier,
      startDate: tracker.startDate,
      endDate: tracker.endDate,
      participants: [...tracker.participants].sort(compareCodeUnits),
      matchIds: [...(corpusMatchIdsByEvent?.get(id) ?? tracker.matches.map((match) => match.id))]
        .sort(compareCodeUnits),
      eventWeightMultiplier: tracker.eventWeightMultiplier,
      lifecycle: tracker.lifecycle ? { ...tracker.lifecycle } : null,
    }))
    .sort((left, right) => compareCodeUnits(left.id, right.id))
  return {
    eventContextFingerprint: fnv1a64(stableJson(worldsEndDateByCalendarYear)),
    eventInventoryFingerprint: fnv1a64(stableJson(events)),
    worldsEndDateByCalendarYear,
    events,
  }
}

function matchIdsByEvent(
  matches: readonly MatchRecord[],
  trackers: RatingRunState['eventTrackers'],
) {
  const matchIds = new Map<string, string[]>()
  for (const match of matches) {
    const key = eventTrackerKey(match)
    if (!trackers.has(key)) continue
    matchIds.set(key, [...(matchIds.get(key) ?? []), match.id])
  }
  return matchIds
}

function eventContextReplayDate(
  stored: readonly [number, string][],
  fresh: readonly [number, string][],
  boundary: string,
) {
  const storedByYear = new Map(stored)
  const freshByYear = new Map(fresh)
  const years = new Set([...storedByYear.keys(), ...freshByYear.keys()])
  const affectedDates: string[] = []
  for (const year of years) {
    const storedDate = storedByYear.get(year)
    const freshDate = freshByYear.get(year)
    if (storedDate === freshDate) continue
    const earliest = codeUnitMinimum(storedDate, freshDate)
    if (earliest && earliest <= boundary) affectedDates.push(utcDateAfter(earliest))
  }
  return affectedDates.toSorted(compareCodeUnits)[0]
}

function predecessorReplayBoundary(availableDates: readonly string[], changedDate: string) {
  const resumeAfterUtcDate = availableDates
    .filter((date) => {
      assertUtcDate(date)
      return date < changedDate
    })
    .sort(compareCodeUnits)
    .at(-1)
  return resumeAfterUtcDate
    ? { resumeAfterUtcDate, requiresFullReplay: false }
    : { requiresFullReplay: true }
}

function isEventInventoryEntry(value: unknown): value is RatingCheckpointEventInventoryEntry {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && typeof value.event === 'string'
    && typeof value.season === 'number'
    && typeof value.tier === 'string'
    && typeof value.startDate === 'string'
    && typeof value.endDate === 'string'
    && Array.isArray(value.participants)
    && value.participants.every((participant) => typeof participant === 'string')
    && Array.isArray(value.matchIds)
    && value.matchIds.every((matchId) => typeof matchId === 'string')
    && typeof value.eventWeightMultiplier === 'number'
    && (value.lifecycle === null || isLifecycle(value.lifecycle))
}

function isLifecycle(value: unknown): value is PlacementTournamentLifecycle {
  return isRecord(value)
    && typeof value.status === 'string'
    && typeof value.boundaryDate === 'string'
    && typeof value.ratedThroughDate === 'string'
    && typeof value.dataLag === 'boolean'
    && typeof value.resultCoverageComplete === 'boolean'
}

function isWorldsEndDateEntries(value: unknown): value is [number, string][] {
  return Array.isArray(value)
    && value.every((entry) => Array.isArray(entry)
      && entry.length === 2
      && typeof entry[0] === 'number'
      && typeof entry[1] === 'string')
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!isRecord(value)) throw new Error('Event contract contains an unsupported value')
  return `{${Object.keys(value)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`
}

function fnv1a64(text: string) {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `fnv1a64-${hash.toString(16).padStart(16, '0')}`
}

function codeUnitMinimum(left?: string, right?: string) {
  if (!left) return right
  if (!right) return left
  return compareCodeUnits(left, right) <= 0 ? left : right
}

function compareCodeUnits(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function utcDateAfter(date: string) {
  assertUtcDate(date)
  const parsed = new Date(`${date}T00:00:00.000Z`)
  parsed.setUTCDate(parsed.getUTCDate() + 1)
  return parsed.toISOString().slice(0, 10)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export type RatingCheckpointReplayDecision = {
  changedUtcDate: string
  replayFromUtcDate: string
  resumeAfterUtcDate?: string
  requiresFullReplay: boolean
  requiresWholeUtcDateReplay: true
  reason: 'predecessor-boundary' | 'no-predecessor-checkpoint' | 'manual-full-invalidation'
}

export function selectRatingCheckpointReplayBoundary({
  availableProcessedThroughUtcDates,
  changedUtcDate,
  forceFullReplay = false,
}: {
  availableProcessedThroughUtcDates: readonly string[]
  changedUtcDate: string
  forceFullReplay?: boolean
}): RatingCheckpointReplayDecision {
  assertUtcDate(changedUtcDate)
  if (forceFullReplay) {
    return {
      changedUtcDate,
      replayFromUtcDate: changedUtcDate,
      requiresFullReplay: true,
      requiresWholeUtcDateReplay: true,
      reason: 'manual-full-invalidation',
    }
  }

  const predecessor = availableProcessedThroughUtcDates
    .filter((date) => {
      assertUtcDate(date)
      return date < changedUtcDate
    })
    .sort(compareCodeUnits)
    .at(-1)

  return predecessor
    ? {
        changedUtcDate,
        replayFromUtcDate: changedUtcDate,
        resumeAfterUtcDate: predecessor,
        requiresFullReplay: false,
        requiresWholeUtcDateReplay: true,
        reason: 'predecessor-boundary',
      }
    : {
        changedUtcDate,
        replayFromUtcDate: changedUtcDate,
        requiresFullReplay: true,
        requiresWholeUtcDateReplay: true,
        reason: 'no-predecessor-checkpoint',
      }
}

function assertUtcDate(date: string) {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : undefined
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid UTC date ${date}`)
  }
}
