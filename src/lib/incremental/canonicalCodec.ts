import {
  PROVIDER_LEDGER_SCHEMA_VERSION,
  type ProviderFileLedger,
  type ProviderPartitionIndex,
  type ProviderTombstone,
} from './providerLedger'
import { CANONICAL_LEDGER_SCHEMA_VERSION, type CanonicalLedger } from './canonicalLedger'

export function encodePrivateState(value: unknown): string {
  return `${JSON.stringify(encodeValue(value))}\n`
}

export function decodePrivateState(contents: string): unknown {
  return decodeValue(JSON.parse(contents))
}

export function decodeCanonicalLedger(contents: string): CanonicalLedger {
  const value = decodePrivateState(contents)
  if (!isRecord(value) || value.schemaVersion !== CANONICAL_LEDGER_SCHEMA_VERSION) throw new Error('Incompatible canonical ledger schema')
  if (!Array.isArray(value.matches) || !Array.isArray(value.partitions) || !isRecord(value.observationToGroups)) {
    throw new Error('Invalid canonical ledger')
  }
  return value as CanonicalLedger
}

export function decodeProviderFileLedger(contents: string): ProviderFileLedger {
  const value = decodePrivateState(contents)
  if (!isRecord(value) || value.schemaVersion !== PROVIDER_LEDGER_SCHEMA_VERSION) throw new Error('Incompatible provider ledger schema')
  if (!isRecord(value.fingerprint) || !Array.isArray(value.observations) || !isRecord(value.teams)) throw new Error('Invalid provider ledger')
  return value as ProviderFileLedger
}

export function decodeProviderPartitionIndex(contents: string): ProviderPartitionIndex {
  const value = decodePrivateState(contents)
  if (!isRecord(value) || value.schemaVersion !== PROVIDER_LEDGER_SCHEMA_VERSION || !isRecord(value.partitions)) {
    throw new Error('Invalid provider partition index')
  }
  return value as ProviderPartitionIndex
}

export function decodeProviderTombstones(contents: string): ProviderTombstone[] {
  const value = decodePrivateState(contents)
  if (!Array.isArray(value) || value.some((entry) => !isRecord(entry) || entry.schemaVersion !== PROVIDER_LEDGER_SCHEMA_VERSION)) {
    throw new Error('Invalid provider tombstones')
  }
  return value as ProviderTombstone[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type EncodedValue =
  | ['undefined']
  | ['null']
  | ['boolean', boolean]
  | ['number', number | 'NaN' | 'Infinity' | '-Infinity' | '-0']
  | ['string', string]
  | ['array', EncodedValue[]]
  | ['map', Array<[EncodedValue, EncodedValue]>]
  | ['set', EncodedValue[]]
  | ['object', Array<[string, EncodedValue]>]

function encodeValue(value: unknown): EncodedValue {
  if (value === undefined) return ['undefined']
  if (value === null) return ['null']
  if (typeof value === 'boolean') return ['boolean', value]
  if (typeof value === 'string') return ['string', value]
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['number', 'NaN']
    if (Object.is(value, -0)) return ['number', '-0']
    if (value === Infinity) return ['number', 'Infinity']
    if (value === -Infinity) return ['number', '-Infinity']
    return ['number', value]
  }
  if (Array.isArray(value)) return ['array', value.map(encodeValue)]
  if (value instanceof Map) return ['map', [...value.entries()].map(([key, entry]) => [encodeValue(key), encodeValue(entry)])]
  if (value instanceof Set) return ['set', [...value].map(encodeValue)]
  if (isRecord(value)) return ['object', Object.entries(value).map(([key, entry]) => [key, encodeValue(entry)])]
  throw new TypeError(`Unsupported private-state value: ${typeof value}`)
}

function decodeValue(value: unknown): unknown {
  if (!Array.isArray(value) || typeof value[0] !== 'string') throw new Error('Invalid tagged private-state value')
  const [tag, payload] = value
  if (tag === 'undefined') return undefined
  if (tag === 'null') return null
  if (tag === 'boolean' && typeof payload === 'boolean') return payload
  if (tag === 'string' && typeof payload === 'string') return payload
  if (tag === 'number') {
    if (typeof payload === 'number') return payload
    if (payload === 'NaN') return Number.NaN
    if (payload === 'Infinity') return Infinity
    if (payload === '-Infinity') return -Infinity
    if (payload === '-0') return -0
  }
  if (tag === 'array' && Array.isArray(payload)) return payload.map(decodeValue)
  if (tag === 'map' && Array.isArray(payload)) {
    return new Map(payload.map((entry) => {
      if (!Array.isArray(entry)) throw new Error('Invalid tagged private-state map entry')
      return [decodeValue(entry[0]), decodeValue(entry[1])]
    }))
  }
  if (tag === 'set' && Array.isArray(payload)) return new Set(payload.map(decodeValue))
  if (tag === 'object' && Array.isArray(payload)) {
    return Object.fromEntries(payload.map((entry) => {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') throw new Error('Invalid tagged private-state object entry')
      return [entry[0], decodeValue(entry[1])]
    }))
  }
  throw new Error(`Invalid tagged private-state value: ${tag}`)
}
