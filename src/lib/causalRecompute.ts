export const CAUSAL_PREFIX_SCHEMA_VERSION = 2 as const

export type CausalSurfaceId =
  | 'sourced-player'
  | 'dss-team'
  | 'dss-region'
  | 'roster-era'
  | 'player-resume-ledger'

export type CausalInputRow = {
  key: string
  utcDate: string
  value: unknown
}

export type CausalPrefixRow = {
  key: string
  utcDate: string
  digest: string
}

export type CausalPrefixSummary = {
  schemaVersion: typeof CAUSAL_PREFIX_SCHEMA_VERSION
  surface: CausalSurfaceId
  processedThroughUtcDate: string
  contextIdentity: CausalContextIdentity
  rows: CausalPrefixRow[]
  digest: string
}

export type CausalContextIdentity = {
  schemaVersion: typeof CAUSAL_PREFIX_SCHEMA_VERSION
  semanticId: string
  digest: string
}

export type CausalCallbackBinding = {
  name: string
  implementation: unknown
  semanticId?: string
}

export type CausalRecomputeDecision =
  | {
      status: 'recompute-ready'
      surface: CausalSurfaceId
      mode: 'full-authoritative-corpus'
      processedThroughUtcDate: string
      earliestRecomputeUtcDate?: string
      requiresWholeUtcDateReplay: true
    }
  | {
      status: 'replay-required'
      surface: CausalSurfaceId
      reason: 'prefix-changed' | 'context-changed' | 'context-unproven'
      changedUtcDate: string
      replayFromUtcDate: string
      resumeAfterUtcDate?: string
      requiresFullReplay: boolean
      requiresWholeUtcDateReplay: true
      changedKeys: string[]
    }

export function buildCausalPrefixSummary({
  surface,
  processedThroughUtcDate,
  inputs,
  contextIdentity,
}: {
  surface: CausalSurfaceId
  processedThroughUtcDate: string
  inputs: readonly CausalInputRow[]
  contextIdentity: CausalContextIdentity
}): CausalPrefixSummary {
  assertUtcDate(processedThroughUtcDate)
  validateCausalContextIdentity(contextIdentity)
  const rows = canonicalRows(inputs)
  const duplicate = rows.find((row, index) => row.key === rows[index - 1]?.key)
  if (duplicate) throw new Error(`Duplicate causal input key ${duplicate.key}`)
  if (rows.some((row) => row.utcDate > processedThroughUtcDate)) {
    throw new Error(`${surface} prefix summary contains input after ${processedThroughUtcDate}`)
  }
  return {
    schemaVersion: CAUSAL_PREFIX_SCHEMA_VERSION,
    surface,
    processedThroughUtcDate,
    contextIdentity,
    rows,
    digest: digestValue({ contextIdentity, rows }),
  }
}

export function reconcileCausalPrefix({
  summary,
  freshInputs,
  freshContextIdentity,
  availableProcessedThroughUtcDates = [],
  earliestRecomputeUtcDate,
}: {
  summary: CausalPrefixSummary
  freshInputs: readonly CausalInputRow[]
  freshContextIdentity?: CausalContextIdentity
  availableProcessedThroughUtcDates?: readonly string[]
  earliestRecomputeUtcDate?: string
}): CausalRecomputeDecision {
  validateCausalPrefixSummary(summary)
  if (!freshContextIdentity) return contextReplayDecision(summary, 'context-unproven')
  validateCausalContextIdentity(freshContextIdentity)
  if (!sameContextIdentity(summary.contextIdentity, freshContextIdentity)) {
    return contextReplayDecision(summary, 'context-changed')
  }
  const freshRows = canonicalRows(freshInputs)
  assertUniqueRows(freshRows)
  const freshByKey = new Map(freshRows.map((row) => [row.key, row]))
  const storedByKey = new Map(summary.rows.map((row) => [row.key, row]))
  const changed = new Map<string, string>()

  for (const [key, stored] of storedByKey) {
    const fresh = freshByKey.get(key)
    if (!fresh || fresh.digest !== stored.digest || fresh.utcDate !== stored.utcDate) {
      changed.set(key, minimumDate(stored.utcDate, fresh?.utcDate) ?? stored.utcDate)
    }
  }
  for (const [key, fresh] of freshByKey) {
    if (storedByKey.has(key) || fresh.utcDate > summary.processedThroughUtcDate) continue
    changed.set(key, fresh.utcDate)
  }

  if (changed.size > 0) {
    const changedUtcDate = [...changed.values()].sort(compareCodeUnits)[0]!
    const resumeAfterUtcDate = availableProcessedThroughUtcDates
      .filter((date) => {
        assertUtcDate(date)
        return date < changedUtcDate
      })
      .sort(compareCodeUnits)
      .at(-1)
    return {
      status: 'replay-required',
      surface: summary.surface,
      reason: 'prefix-changed',
      changedUtcDate,
      replayFromUtcDate: changedUtcDate,
      ...(resumeAfterUtcDate ? { resumeAfterUtcDate } : {}),
      requiresFullReplay: !resumeAfterUtcDate,
      requiresWholeUtcDateReplay: true,
      changedKeys: [...changed.keys()].sort(compareCodeUnits),
    }
  }

  if (earliestRecomputeUtcDate) assertUtcDate(earliestRecomputeUtcDate)
  return {
    status: 'recompute-ready',
    surface: summary.surface,
    mode: 'full-authoritative-corpus',
    processedThroughUtcDate: summary.processedThroughUtcDate,
    ...(earliestRecomputeUtcDate ? { earliestRecomputeUtcDate } : {}),
    requiresWholeUtcDateReplay: true,
  }
}

export function causalInputRow(key: string, utcDate: string, value: unknown): CausalInputRow {
  assertUtcDate(utcDate)
  if (!key) throw new Error('Causal input row key must be non-empty')
  return { key, utcDate, value }
}

export function buildCausalContextIdentity({
  semanticId,
  serializableInputs,
  callbacks = [],
}: {
  semanticId: string
  serializableInputs: unknown
  callbacks?: readonly CausalCallbackBinding[]
}): CausalContextIdentity | undefined {
  if (!semanticId.trim()) throw new Error('Causal context semantic id must be non-empty')
  const callbackIdentities: { name: string; semanticId: string }[] = []
  for (const callback of callbacks) {
    if (callback.implementation === undefined) continue
    if (typeof callback.implementation !== 'function') {
      throw new Error(`Causal callback ${callback.name} must be a function`)
    }
    if (!callback.semanticId?.trim()) return undefined
    callbackIdentities.push({ name: callback.name, semanticId: callback.semanticId })
  }
  callbackIdentities.sort((left, right) => compareCodeUnits(left.name, right.name))
  return {
    schemaVersion: CAUSAL_PREFIX_SCHEMA_VERSION,
    semanticId,
    digest: digestValue({ serializableInputs, callbackIdentities }),
  }
}

export function validateCausalPrefixSummary(summary: CausalPrefixSummary) {
  if (summary.schemaVersion !== CAUSAL_PREFIX_SCHEMA_VERSION) throw new Error('Unsupported causal prefix schema')
  assertUtcDate(summary.processedThroughUtcDate)
  validateCausalContextIdentity(summary.contextIdentity)
  const rows = summary.rows.toSorted((left, right) => compareCodeUnits(left.key, right.key))
  assertUniqueRows(rows)
  if (rows.some((row) => !row.key || !isUtcDate(row.utcDate) || !row.digest)) {
    throw new Error(`Malformed ${summary.surface} causal prefix row`)
  }
  if (rows.some((row) => row.utcDate > summary.processedThroughUtcDate)) {
    throw new Error(`${summary.surface} causal prefix row exceeds its processed boundary`)
  }
  if (digestValue({ contextIdentity: summary.contextIdentity, rows }) !== summary.digest) {
    throw new Error(`${summary.surface} causal prefix digest mismatch`)
  }
}

export function digestCausalValue(value: unknown) {
  return digestValue(value)
}

function contextReplayDecision(
  summary: CausalPrefixSummary,
  reason: 'context-changed' | 'context-unproven',
): CausalRecomputeDecision {
  const replayFromUtcDate = summary.rows
    .map((row) => row.utcDate)
    .sort(compareCodeUnits)[0] ?? summary.processedThroughUtcDate
  return {
    status: 'replay-required',
    surface: summary.surface,
    reason,
    changedUtcDate: replayFromUtcDate,
    replayFromUtcDate,
    requiresFullReplay: true,
    requiresWholeUtcDateReplay: true,
    changedKeys: ['$context'],
  }
}

function sameContextIdentity(left: CausalContextIdentity, right: CausalContextIdentity) {
  return left.schemaVersion === right.schemaVersion
    && left.semanticId === right.semanticId
    && left.digest === right.digest
}

function validateCausalContextIdentity(identity: CausalContextIdentity | undefined) {
  if (!identity || identity.schemaVersion !== CAUSAL_PREFIX_SCHEMA_VERSION || !identity.semanticId.trim()) {
    throw new Error('Malformed causal context identity')
  }
  if (!/^fnv1a64-[0-9a-f]{16}$/.test(identity.digest)) {
    throw new Error('Malformed causal context digest')
  }
}

function canonicalRows(inputs: readonly CausalInputRow[]) {
  return inputs
    .map((input): CausalPrefixRow => {
      assertUtcDate(input.utcDate)
      if (!input.key) throw new Error('Causal input row key must be non-empty')
      return { key: input.key, utcDate: input.utcDate, digest: digestValue(input.value) }
    })
    .sort((left, right) => compareCodeUnits(left.key, right.key))
}

function assertUniqueRows(rows: readonly CausalPrefixRow[]) {
  const duplicate = rows.find((row, index) => row.key === rows[index - 1]?.key)
  if (duplicate) throw new Error(`Duplicate causal input key ${duplicate.key}`)
}

function digestValue(value: unknown) {
  const text = stableJson(value)
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `fnv1a64-${hash.toString(16).padStart(16, '0')}`
}

function stableJson(value: unknown): string {
  if (value === undefined) return '{"$causal":"undefined"}'
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Causal inputs cannot contain non-finite numbers')
    return Object.is(value, -0) ? '{"$causal":"negative-zero"}' : JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value instanceof Map) {
    const entries = [...value.entries()]
      .map(([key, item]) => [stableJson(key), stableJson(item)] as const)
      .sort(([left], [right]) => compareCodeUnits(left, right))
    return `{"$causal":"map","entries":[${entries.map(([key, item]) => `[${key},${item}]`).join(',')}]}`
  }
  if (value instanceof Set) {
    const entries = [...value].map(stableJson).sort(compareCodeUnits)
    return `{"$causal":"set","values":[${entries.join(',')}]}`
  }
  if (!isRecord(value)) throw new Error(`Unsupported causal input ${typeof value}`)
  return `{${Object.keys(value)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`
}

function minimumDate(left?: string, right?: string) {
  if (!left) return right
  if (!right) return left
  return compareCodeUnits(left, right) <= 0 ? left : right
}

function compareCodeUnits(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isUtcDate(date: string) {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : undefined
  return Boolean(parsed && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date)
}

function assertUtcDate(date: string) {
  if (!isUtcDate(date)) throw new Error(`Invalid causal UTC date ${date}`)
}
