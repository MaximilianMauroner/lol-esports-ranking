import { transparentGprModelMetadata } from './modelConfig'
import {
  isRatingCheckpointEventContract,
  validateRatingCheckpointEventContract,
  type RatingCheckpointEventContract,
} from './ratingCheckpointInventory'
import type { RatingRunState } from './ratingRunState'

export const RATING_CHECKPOINT_SCHEMA_VERSION = 3 as const

export type RatingCheckpointIdentity = {
  importerVersion: string
  identityTaxonomyHash: string
  rawLedgerPrefixHash: string
}

export type RatingCheckpointBoundary = {
  processedThroughUtcDate: string
  processedThroughMatchId: string
}

export type RatingCheckpointMetadata = RatingCheckpointIdentity & RatingCheckpointBoundary & {
  schemaVersion: typeof RATING_CHECKPOINT_SCHEMA_VERSION
  modelVersion: string
  modelConfigHash: string
  eventContract: RatingCheckpointEventContract
  payloadDigest: string
}

export type DecodedRatingCheckpoint = {
  metadata: RatingCheckpointMetadata
  state: RatingRunState
}

export type RatingCheckpointInvalidationReason =
  | 'malformed'
  | 'schema-version'
  | 'model-version'
  | 'model-config'
  | 'importer-version'
  | 'identity-taxonomy'
  | 'raw-ledger-prefix'
  | 'event-contract'
  | 'payload-digest'
  | 'boundary-mismatch'

export class InvalidRatingCheckpointError extends Error {
  readonly reason: RatingCheckpointInvalidationReason
  readonly requiresFullReplay = true as const

  constructor(reason: RatingCheckpointInvalidationReason, message: string) {
    super(message)
    this.name = 'InvalidRatingCheckpointError'
    this.reason = reason
  }
}

export type RatingCheckpointValidationResult =
  | { ok: true; checkpoint: DecodedRatingCheckpoint }
  | { ok: false; reason: RatingCheckpointInvalidationReason; requiresFullReplay: true; message: string }

export type SafeRatingCheckpointCandidate = {
  id: string
  processedThroughUtcDate: string
  serialized: string
  expectedIdentity: RatingCheckpointIdentity
}

export type RatingCheckpointCausalProof =
  | { status: 'ready' }
  | {
      status: 'replay-required'
      replayFromUtcDate: string
      requiresFullReplay: boolean
      reason: string
    }

export type SafeRatingCheckpointSelection =
  | {
      status: 'selected'
      candidateId: string
      checkpoint: DecodedRatingCheckpoint
      rejectedCandidateIds: string[]
    }
  | {
      status: 'full-replay'
      reason: 'no-safe-checkpoint' | 'external-causal-proof-missing' | 'causal-proof-requires-full-replay'
      rejectedCandidateIds: string[]
    }

/**
 * Walks newest-to-oldest and only returns a checkpoint after the serialized
 * payload, compatibility, immutable raw prefix, event state, and all external
 * causal surfaces have been proven safe by the caller.
 */
export function selectSafeCheckpoint({
  candidates,
  changedUtcDate,
  reconcileCausalProof,
}: {
  candidates: readonly SafeRatingCheckpointCandidate[]
  changedUtcDate: string
  reconcileCausalProof?: (checkpoint: DecodedRatingCheckpoint) => RatingCheckpointCausalProof
}): SafeRatingCheckpointSelection {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(changedUtcDate)) throw new Error(`Invalid changed UTC date ${changedUtcDate}`)
  if (!reconcileCausalProof) {
    return { status: 'full-replay', reason: 'external-causal-proof-missing', rejectedCandidateIds: [] }
  }
  const eligible = candidates
    .filter((candidate) => candidate.processedThroughUtcDate < changedUtcDate)
    .toSorted((left, right) => right.processedThroughUtcDate.localeCompare(left.processedThroughUtcDate))
  const rejectedCandidateIds: string[] = []
  let requiredEarlierThan = changedUtcDate

  for (const candidate of eligible) {
    if (candidate.processedThroughUtcDate >= requiredEarlierThan) continue
    const validation = validateRatingCheckpoint(candidate.serialized, candidate.expectedIdentity)
    if (!validation.ok
      || validation.checkpoint.metadata.processedThroughUtcDate !== candidate.processedThroughUtcDate) {
      rejectedCandidateIds.push(candidate.id)
      continue
    }
    let proof: RatingCheckpointCausalProof
    try {
      proof = reconcileCausalProof(validation.checkpoint)
    } catch {
      rejectedCandidateIds.push(candidate.id)
      return {
        status: 'full-replay',
        reason: 'causal-proof-requires-full-replay',
        rejectedCandidateIds,
      }
    }
    if (proof.status === 'ready') {
      return {
        status: 'selected',
        candidateId: candidate.id,
        checkpoint: validation.checkpoint,
        rejectedCandidateIds,
      }
    }
    rejectedCandidateIds.push(candidate.id)
    if (proof.requiresFullReplay) {
      return {
        status: 'full-replay',
        reason: 'causal-proof-requires-full-replay',
        rejectedCandidateIds,
      }
    }
    requiredEarlierThan = proof.replayFromUtcDate
  }
  return { status: 'full-replay', reason: 'no-safe-checkpoint', rejectedCandidateIds }
}

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson }

type ParsedRatingCheckpointMetadata = Omit<RatingCheckpointMetadata, 'schemaVersion'> & { schemaVersion: number }

type CheckpointEnvelope = {
  metadata: ParsedRatingCheckpointMetadata
  payload: CanonicalJson
}

export function encodeRatingCheckpoint(
  state: RatingRunState,
  identity: RatingCheckpointIdentity,
  boundary: RatingCheckpointBoundary,
  eventContract: RatingCheckpointEventContract,
) {
  assertBoundary(boundary.processedThroughUtcDate)
  if (state.processedThroughUtcDate !== boundary.processedThroughUtcDate) {
    throw new InvalidRatingCheckpointError(
      'boundary-mismatch',
      `State boundary ${state.processedThroughUtcDate ?? 'unset'} does not match checkpoint boundary ${boundary.processedThroughUtcDate}`,
    )
  }
  if (
    !state.previousMatch
    || state.previousMatch.id !== boundary.processedThroughMatchId
    || state.previousMatch.date !== boundary.processedThroughUtcDate
  ) {
    throw new InvalidRatingCheckpointError(
      'boundary-mismatch',
      'Checkpoint terminal match/date identity does not match RatingRunState.previousMatch',
    )
  }
  if (
    state.processedThroughUtcDateMatchIds.length === 0
    || !state.processedThroughUtcDateMatchIds.includes(checkpointMatchIdentity(state.previousMatch))
  ) {
    throw new InvalidRatingCheckpointError(
      'boundary-mismatch',
      'Checkpoint does not prove a complete terminal UTC date boundary',
    )
  }
  assertIdentity(identity)
  assertEventContract(state, boundary.processedThroughUtcDate, eventContract)

  const payload = encodeCanonical(state)
  const metadata: RatingCheckpointMetadata = {
    schemaVersion: RATING_CHECKPOINT_SCHEMA_VERSION,
    modelVersion: transparentGprModelMetadata.version,
    modelConfigHash: transparentGprModelMetadata.configHash,
    importerVersion: identity.importerVersion,
    identityTaxonomyHash: identity.identityTaxonomyHash,
    rawLedgerPrefixHash: identity.rawLedgerPrefixHash,
    processedThroughUtcDate: boundary.processedThroughUtcDate,
    processedThroughMatchId: boundary.processedThroughMatchId,
    eventContract,
    payloadDigest: digestCanonical(payload),
  }
  return stringifyCanonical({ metadata, payload })
}

export function decodeRatingCheckpoint(
  serialized: string,
  expected: RatingCheckpointIdentity,
): DecodedRatingCheckpoint {
  assertIdentity(expected)
  const envelope = parseEnvelope(serialized)
  const { metadata, payload } = envelope

  if (metadata.schemaVersion !== RATING_CHECKPOINT_SCHEMA_VERSION) {
    invalid('schema-version', `Unsupported rating checkpoint schema ${String(metadata.schemaVersion)}`)
  }
  if (metadata.modelVersion !== transparentGprModelMetadata.version) {
    invalid('model-version', 'Rating checkpoint model implementation version does not match the running model')
  }
  if (metadata.modelConfigHash !== transparentGprModelMetadata.configHash) {
    invalid('model-config', 'Rating checkpoint model configuration does not match the running model')
  }
  if (metadata.importerVersion !== expected.importerVersion) {
    invalid('importer-version', 'Rating checkpoint importer version does not match')
  }
  if (metadata.identityTaxonomyHash !== expected.identityTaxonomyHash) {
    invalid('identity-taxonomy', 'Rating checkpoint identity/taxonomy hash does not match')
  }
  if (metadata.rawLedgerPrefixHash !== expected.rawLedgerPrefixHash) {
    invalid('raw-ledger-prefix', 'Rating checkpoint raw-ledger prefix does not match')
  }
  if (metadata.payloadDigest !== digestCanonical(payload)) {
    invalid('payload-digest', 'Rating checkpoint payload digest does not match')
  }

  const decoded: unknown = decodeCanonical(payload)
  if (!isRatingRunState(decoded)) {
    invalid('malformed', 'Rating checkpoint payload is not a complete RatingRunState')
  }
  assertBoundary(metadata.processedThroughUtcDate)
  if (decoded.processedThroughUtcDate !== metadata.processedThroughUtcDate) {
    invalid('boundary-mismatch', 'Rating checkpoint state and metadata boundaries differ')
  }
  if (
    !decoded.previousMatch
    || decoded.previousMatch.id !== metadata.processedThroughMatchId
    || decoded.previousMatch.date !== metadata.processedThroughUtcDate
  ) {
    invalid('boundary-mismatch', 'Rating checkpoint terminal match/date identity does not match its state')
  }
  if (
    decoded.processedThroughUtcDateMatchIds.length === 0
    || !decoded.processedThroughUtcDateMatchIds.includes(checkpointMatchIdentity(decoded.previousMatch))
  ) {
    invalid('boundary-mismatch', 'Rating checkpoint does not prove a complete terminal UTC date boundary')
  }
  assertEventContract(decoded, metadata.processedThroughUtcDate, metadata.eventContract)

  return {
    metadata: { ...metadata, schemaVersion: RATING_CHECKPOINT_SCHEMA_VERSION },
    state: decoded,
  }
}

export function validateRatingCheckpoint(
  serialized: string,
  expected: RatingCheckpointIdentity,
): RatingCheckpointValidationResult {
  try {
    return { ok: true, checkpoint: decodeRatingCheckpoint(serialized, expected) }
  } catch (error) {
    if (error instanceof InvalidRatingCheckpointError) {
      return {
        ok: false,
        reason: error.reason,
        requiresFullReplay: true,
        message: error.message,
      }
    }
    return {
      ok: false,
      reason: 'malformed',
      requiresFullReplay: true,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function parseEnvelope(serialized: string): CheckpointEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    return invalid('malformed', 'Rating checkpoint is not valid JSON')
  }
  if (!isRecord(parsed) || !isRecord(parsed.metadata) || !isCanonicalJson(parsed.payload)) {
    return invalid('malformed', 'Rating checkpoint envelope is malformed')
  }
  const metadata = parsed.metadata
  const schemaVersion = metadata.schemaVersion
  const modelVersion = metadata.modelVersion
  const modelConfigHash = metadata.modelConfigHash
  const importerVersion = metadata.importerVersion
  const identityTaxonomyHash = metadata.identityTaxonomyHash
  const rawLedgerPrefixHash = metadata.rawLedgerPrefixHash
  const processedThroughUtcDate = metadata.processedThroughUtcDate
  const processedThroughMatchId = metadata.processedThroughMatchId
  const eventContract = metadata.eventContract
  const payloadDigest = metadata.payloadDigest
  if (
    typeof schemaVersion !== 'number'
    || typeof modelVersion !== 'string'
    || typeof modelConfigHash !== 'string'
    || typeof importerVersion !== 'string'
    || typeof identityTaxonomyHash !== 'string'
    || typeof rawLedgerPrefixHash !== 'string'
    || typeof processedThroughUtcDate !== 'string'
    || typeof processedThroughMatchId !== 'string'
    || !isRatingCheckpointEventContract(eventContract)
    || typeof payloadDigest !== 'string'
  ) {
    return invalid('malformed', 'Rating checkpoint metadata is malformed')
  }
  return {
    metadata: {
      schemaVersion,
      modelVersion,
      modelConfigHash,
      importerVersion,
      identityTaxonomyHash,
      rawLedgerPrefixHash,
      processedThroughUtcDate,
      processedThroughMatchId,
      eventContract,
      payloadDigest,
    },
    payload: parsed.payload,
  }
}

function encodeCanonical(value: unknown): CanonicalJson {
  if (value === undefined) return { $checkpointType: 'undefined' }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Rating checkpoints cannot encode non-finite numbers')
    if (Object.is(value, -0)) return { $checkpointType: 'negative-zero' }
    return value
  }
  if (Array.isArray(value)) return value.map(encodeCanonical)
  if (value instanceof Map) {
    const entries = Array.from(value.entries(), ([key, item]) => [
      encodeCanonical(key),
      encodeCanonical(item),
    ] satisfies CanonicalJson[])
      .sort((left, right) => compareCodeUnits(stringifyCanonical(left[0] ?? null), stringifyCanonical(right[0] ?? null)))
    return { $checkpointType: 'map', entries }
  }
  if (value instanceof Set) {
    const values = Array.from(value.values(), encodeCanonical)
      .sort((left, right) => compareCodeUnits(stringifyCanonical(left), stringifyCanonical(right)))
    return { $checkpointType: 'set', values }
  }
  if (isRecord(value)) {
    const encoded: { [key: string]: CanonicalJson } = {}
    for (const key of Object.keys(value).sort()) {
      const item = value[key]
      encoded[key] = encodeCanonical(item)
    }
    return encoded
  }
  throw new Error(`Rating checkpoints cannot encode ${typeof value}`)
}

function decodeCanonical(value: CanonicalJson): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(decodeCanonical)
  if (value.$checkpointType === 'map') {
    if (!Array.isArray(value.entries)) return invalid('malformed', 'Malformed checkpoint map')
    const decoded = new Map<unknown, unknown>()
    for (const entry of value.entries) {
      if (!Array.isArray(entry) || entry.length !== 2) return invalid('malformed', 'Malformed checkpoint map entry')
      decoded.set(decodeCanonical(entry[0]!), decodeCanonical(entry[1]!))
    }
    return decoded
  }
  if (value.$checkpointType === 'set') {
    if (!Array.isArray(value.values)) return invalid('malformed', 'Malformed checkpoint set')
    return new Set(value.values.map(decodeCanonical))
  }
  if (value.$checkpointType === 'undefined' && Object.keys(value).length === 1) return undefined
  if (value.$checkpointType === 'negative-zero' && Object.keys(value).length === 1) return -0
  const decoded: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      return invalid('malformed', `Unsafe checkpoint key ${key}`)
    }
    decoded[key] = decodeCanonical(item)
  }
  return decoded
}

function stringifyCanonical(value: CanonicalJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stringifyCanonical).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stringifyCanonical(value[key]!)}`)
    .join(',')}}`
}

function digestCanonical(value: CanonicalJson) {
  const text = stringifyCanonical(value)
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `fnv1a64-${hash.toString(16).padStart(16, '0')}`
}

function isRatingRunState(value: unknown): value is RatingRunState {
  if (!isRecord(value)) return false
  return [
    'ratings',
    'executionRatings',
    'previousDisplayRatings',
    'momentums',
    'rosterPriorOffsets',
    'leaguePlacementDeltas',
    'wins',
    'losses',
    'factorCounts',
    'leagueScores',
    'previousLeagueScores',
    'uncertainties',
    'leagueWins',
    'leagueLosses',
    'leagueExpectedWins',
    'leagueOpponentRatingSums',
    'leagueMatchCounts',
    'currentRosterContinuity',
  ].every((field) => isMapOf(value[field], isString, isNumber))
    && ['forms', 'leagueForms'].every((field) => isMapOf(value[field], isString, isStringArray))
    && ['leagueLastEvents', 'leagueLastUpdated', 'lastPatchByTeam', 'lastRosterFingerprintByTeam']
      .every((field) => isMapOf(value[field], isString, isString))
    && isMapOf(value.latestRatingUpdates, isString, isSerializableRecord)
    && isMapOf(value.histories, isString, isSerializableRecordArray)
    && isMapOf(value.factorSums, isString, isSerializableRecord)
    && isMapOf(value.sideAdjustmentSamples, isString, isSerializableRecord)
    && isMapOf(value.lastRosterByTeam, isString, isSerializableRecord)
    && isMapOf(value.eventTrackers, isString, isPlacementTracker)
    && isSerializableRecordArray(value.leagueHistory)
    && isSerializableRecordArray(value.predictions)
    && isEventWeightContext(value.eventWeightContext)
    && (value.previousMatch === undefined || isMatchRecord(value.previousMatch))
    && (value.processedThroughUtcDate === undefined || typeof value.processedThroughUtcDate === 'string')
    && isStringArray(value.processedThroughUtcDateMatchIds)
    && typeof value.processedMatchCount === 'number'
    && Number.isInteger(value.processedMatchCount)
    && value.processedMatchCount >= 0
}

function isPlacementTracker(value: unknown): value is RatingRunState['eventTrackers'] extends Map<string, infer Tracker> ? Tracker : never {
  if (!isRecord(value)) return false
  return typeof value.event === 'string'
    && typeof value.season === 'number'
    && typeof value.startDate === 'string'
    && typeof value.endDate === 'string'
    && value.participants instanceof Set
    && Array.from(value.participants).every(isString)
    && isMapOf(value.teamLeagues, isString, isString)
    && isMapOf(value.preEventPowers, isString, isNumber)
    && isMatchRecordArray(value.matches)
    && typeof value.eventWeightMultiplier === 'number'
    && typeof value.started === 'boolean'
    && typeof value.applied === 'boolean'
    && (value.lifecycle === undefined || isSerializableRecord(value.lifecycle))
}

function isEventWeightContext(value: unknown): value is RatingRunState['eventWeightContext'] {
  return isRecord(value) && isMapOf(value.worldsEndDateByCalendarYear, isNumber, isString)
}

function isMatchRecord(value: unknown): value is NonNullable<RatingRunState['previousMatch']> {
  if (!isRecord(value)) return false
  return ['id', 'date', 'event', 'phase', 'region', 'league', 'patch', 'tier', 'teamA', 'teamB', 'winner']
    .every((field) => typeof value[field] === 'string')
    && ['season', 'bestOf', 'teamAKills', 'teamBKills', 'teamAGold', 'teamBGold']
      .every((field) => typeof value[field] === 'number')
}

function isMatchRecordArray(value: unknown): value is NonNullable<RatingRunState['previousMatch']>[] {
  return Array.isArray(value) && value.every(isMatchRecord)
}

function isSerializableRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.values(value).every(isDecodedValue)
}

function isSerializableRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isSerializableRecord)
}

function isDecodedValue(value: unknown): boolean {
  if (value === undefined) return true
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isDecodedValue)
  if (value instanceof Map) return Array.from(value.entries()).every(([key, item]) => isDecodedValue(key) && isDecodedValue(item))
  if (value instanceof Set) return Array.from(value.values()).every(isDecodedValue)
  return isRecord(value) && Object.values(value).every(isDecodedValue)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

function isMapOf<Key, Item>(
  value: unknown,
  keyGuard: (candidate: unknown) => candidate is Key,
  itemGuard: (candidate: unknown) => candidate is Item,
): value is Map<Key, Item> {
  return value instanceof Map
    && Array.from(value.entries()).every(([key, item]) => keyGuard(key) && itemGuard(item))
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCanonicalJson(value: unknown): value is CanonicalJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isCanonicalJson)
  return isRecord(value) && Object.values(value).every(isCanonicalJson)
}

function assertBoundary(date: string) {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : undefined
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    invalid('boundary-mismatch', `Invalid checkpoint UTC boundary ${date}`)
  }
}

function checkpointMatchIdentity(match: NonNullable<RatingRunState['previousMatch']>) {
  return match.officialGameId ?? match.sourceGameId ?? match.id
}

function compareCodeUnits(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertIdentity(identity: RatingCheckpointIdentity) {
  if (!identity.importerVersion || !identity.identityTaxonomyHash || !identity.rawLedgerPrefixHash) {
    invalid('malformed', 'Checkpoint identity values must be non-empty')
  }
}

function assertEventContract(
  state: RatingRunState,
  processedThroughUtcDate: string,
  eventContract: RatingCheckpointEventContract,
) {
  try {
    validateRatingCheckpointEventContract(state, processedThroughUtcDate, eventContract)
  } catch (error) {
    invalid('event-contract', error instanceof Error ? error.message : String(error))
  }
}

function invalid(reason: RatingCheckpointInvalidationReason, message: string): never {
  throw new InvalidRatingCheckpointError(reason, message)
}
