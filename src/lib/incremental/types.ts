import type { MatchRecord, TeamProfile } from '../../types'

export const CANONICAL_MATCH_LEDGER_SCHEMA_VERSION = 2 as const

export type CanonicalScheduleCausalRow = {
  key: string
  utcDate?: string
  digest: string
}

export type RankingCompatibility = {
  modelVersion: string
  modelConfigHash: string
  importerVersion: string
  identityTaxonomyHash: string
}

export type CanonicalMatchLedgerContext = RankingCompatibility & {
  scheduleReceiptIdentity: string
  contextReceiptIdentity: string
  provenanceReceiptIdentity: string
  teams?: Readonly<Record<string, TeamProfile>>
  scheduleCausalRows?: readonly CanonicalScheduleCausalRow[]
  providerAvailableAtForMatch?: (match: MatchRecord) => string | undefined
}

export type CanonicalMatchLedgerRow = {
  key: string
  utcDate: string
  scoringDigest: string
  artifactDigest: string
  scheduleReceiptIdentity: string
  contextReceiptIdentity: string
  provenanceReceiptIdentity: string
  providerAvailableAt?: string
  match: MatchRecord
}

export type CanonicalMatchLedger = {
  schemaVersion: typeof CANONICAL_MATCH_LEDGER_SCHEMA_VERSION
  compatibility: RankingCompatibility
  scheduleReceiptIdentity: string
  contextReceiptIdentity: string
  provenanceReceiptIdentity: string
  scheduleCausalRows: CanonicalScheduleCausalRow[]
  rows: CanonicalMatchLedgerRow[]
  digest: string
}

export type RankingChangeKind =
  | 'no-change'
  | 'metadata-only'
  | 'latest-append'
  | 'same-day-insertion'
  | 'historical-correction'
  | 'full-invalidation'

export type RankingChangeClassification = {
  kind: RankingChangeKind
  earliestChangedUtcDate?: string
  addedKeys: string[]
  removedKeys: string[]
  changedKeys: string[]
  reasons: string[]
  requiresWholeUtcDateReplay: boolean
  requiresFullReplay: boolean
}

export function stableDigest(value: unknown) {
  const text = stableJson(value)
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `fnv1a64-${hash.toString(16).padStart(16, '0')}`
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('Canonical ranking input cannot contain non-finite numbers')
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value instanceof Map) {
    return stableJson([...value.entries()].sort(([left], [right]) => compareCodeUnits(String(left), String(right))))
  }
  if (value instanceof Set) return stableJson([...value].sort())
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`
}

export function compareCodeUnits(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

export function assertUtcDate(date: string) {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : undefined
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid UTC date ${date}`)
  }
}
