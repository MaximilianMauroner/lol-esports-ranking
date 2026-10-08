import { createHash } from 'node:crypto'
import { compareCodeUnits } from '../src/lib/codeUnitOrder.mjs'
import { parseProviderInstant, providerDate, providerDatetimeUtc } from '../src/lib/importers/providerTime'
import { stableDigest, stableJson } from '../src/lib/incremental/types'
import { configHashFor } from '../src/lib/modelConfig'
import { canonicalJsonFor, prepareSemanticArtifact } from './public-artifact-storage.mjs'

/**
 * Byte contracts that the planned Rust refresh worker (#84) must reproduce
 * exactly. Each entry pairs an input with the output Node produces today.
 * `tests/fixtures/parity/contracts.json` is generated from this function;
 * regenerate it with `pnpm run fixtures:parity` only when a contract change is
 * intended.
 *
 * Numbers that must keep every bit are stored as `bits`: the IEEE 754 binary64
 * value as 16 big-endian hex digits.
 *
 * `input` fields are plain JSON. `encodedInput` fields also express values
 * that JSON cannot hold. Plain JSON values stand for themselves; an object
 * with a `$type` key is one of:
 * - `{"$type":"undefined"}`
 * - `{"$type":"number","bits":"8000000000000000"}` for -0, NaN, and infinities
 * - `{"$type":"map","entries":[[key, value], ...]}` in insertion order
 * - `{"$type":"set","values":[value, ...]}` in insertion order
 * Keys, entries, and values inside are encoded the same way. Plain input
 * objects never have a `$type` key. An output of `{"throws": true}` means Node
 * throws for that input.
 */
export function buildParityFixtures() {
  return {
    schemaVersion: 1,
    numberText: NUMBERS.map((value) => ({ bits: float64Bits(value), text: JSON.stringify(value) })),
    canonicalJson: SERIALIZER_INPUT.map((value) => ({
      encodedInput: encodeInput(value),
      ...outputOrThrows(() => {
        const canonical = canonicalJsonFor(value)
        return { canonical, sha256: sha256(canonical) }
      }),
    })),
    stableDigest: SERIALIZER_INPUT.map((value) => ({
      encodedInput: encodeInput(value),
      ...outputOrThrows(() => ({ stableJson: stableJson(value), digest: stableDigest(value) })),
    })),
    semanticArtifact: ARTIFACTS.map((value) => {
      const prepared = prepareSemanticArtifact(value, { compress: false })
      return { input: value, canonical: prepared.canonicalJson, sha256: prepared.digest, bytes: prepared.bytes }
    }),
    configHash: JSON_VALUES.map((value) => ({ input: value, hash: configHashFor(value) })),
    codeUnitOrder: { input: ORDER_INPUT, sorted: ORDER_INPUT.toSorted(compareCodeUnits) },
    mathRound: ROUND_INPUT.map((value) => ({ bits: float64Bits(value), result: float64Bits(Math.round(value)) })),
    toFixed: TO_FIXED_INPUT.map(([value, digits]) => ({ bits: float64Bits(value), digits, text: value.toFixed(digits) })),
    math: MATH_INPUT.map(([operation, left, right]) => ({
      operation,
      left: float64Bits(left),
      ...(right === undefined ? {} : { right: float64Bits(right) }),
      result: float64Bits(applyMath(operation, left, right)),
    })),
    providerTime: PROVIDER_TIME_INPUT.map((value) => ({
      input: value,
      instantMs: nullIfNaN(parseProviderInstant(value)),
      date: providerDate(value),
      datetimeUtc: providerDatetimeUtc(value) ?? null,
    })),
  }
}

const NUMBERS = [
  0, -0, 1, -1, 0.1, 0.1 + 0.2, 1 / 3, 2 / 3, 1e21, 1e-7, 1.5e-7, 123456789012345680000, 5e-324,
  Number.MAX_VALUE, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER, 2 ** 53 + 2, 0.000001, 1e20, 1234.5678, -1745.25,
]

const JSON_VALUES: unknown[] = [
  null, true, 'LØS', 'emoji 🙂 and "quotes" \\ \n\t\u0001', 1745.25, -0.0001,
  { b: 1, a: 2, B: 3, _: 4, 10: 'ten', 2: 'two', é: 5, A: [3, 2, 1] },
  { nested: { z: [{ y: 1, x: null }], a: 'LOUD' }, list: ['kt Rolster', 'KaBuM!'], empty: {}, none: [] },
]

const TYPED_VALUES: unknown[] = [
  -0,
  [1, undefined, -0, 0],
  { kept: 1, dropped: undefined, zero: -0 },
  new Map<unknown, unknown>([['b', 1], [10, 'ten'], [9, 'nine'], ['a', { z: undefined, y: -0 }]]),
  new Set<unknown>([{ b: 1 }, { a: 2 }, 10, 9]),
  new Set<unknown>([undefined, 'z', 'undefined', 'a', null]),
  new Map<unknown, unknown>([[undefined, 1], ['z', 2], ['undefined', 3]]),
  { nested: new Set(['b', 'a']), list: [undefined] },
  Number.NaN,
  Number.POSITIVE_INFINITY,
]

const SERIALIZER_INPUT = [...JSON_VALUES, ...TYPED_VALUES]

const ARTIFACTS = [
  {
    artifactKind: 'parity-sample', schemaVersion: 1, generatedAt: '2026-10-08T00:00:00.000Z',
    modelVersion: 'model', modelConfigHash: 'config', artifactMeta: { runId: 'run' },
    teams: [{ teamId: 'team:loud:loud', rating: 1514.25 }, { teamId: 'team:los:l-s', rating: 1490 }],
  },
  { artifactKind: 'parity-sample', schemaVersion: 1, content: { 'ü': 1, u: 2 } },
]

const ORDER_INPUT = ['kt Rolster', 'KaBuM! Esports', 'Édition', 'EDward Gaming', 'Edition', '100 Thieves', '_unknown', 'LØS', 'LOUD', 'a-b', 'a_b', 'ab', '🙂', '￿']

const ROUND_INPUT = [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 0.49999999999999994, -0.49999999999999994, 1745.5, -1745.5, 4503599627370495.5]

const TO_FIXED_INPUT: Array<[number, number]> = [
  [1.005, 2], [2.675, 2], [1.45, 1], [-1.5, 0], [0.5, 0], [2.5, 0], [0.000001, 3], [1e21, 2], [123.456, 0],
  [0.1 + 0.2, 3], [-0.0001, 2], [1745.2549999999999, 2], [0.0005, 3],
]

// V8 computes exp and log with its own routines, so results can differ in the
// last bit from glibc, which Rust's f64::exp and ln call on Linux. The named
// inputs below are known to differ; the seeded samples cover the model's
// ranges: rating gaps and probabilities for exp, ratings and probabilities in
// (0, 1) for log.
const randomUnit = mulberry32(0x84)
const MATH_INPUT: Array<['exp' | 'log' | 'pow', number, number?]> = [
  ['exp', 1], ['exp', -0.5], ['exp', 3.75], ['log', 2], ['log', 0.3], ['log', 1745.25],
  ['exp', 3.116980406359], ['exp', -0.28467832109515534], ['log', 2372.4491771176463], ['log', 1680.9258881962426],
  ...Array.from({ length: 32 }, (): ['exp', number] => ['exp', -6 + 12 * randomUnit()]),
  ...Array.from({ length: 32 }, (): ['log', number] => ['log', 0.01 + (5000 - 0.01) * randomUnit()]),
  ...Array.from({ length: 32 }, (): ['log', number] => ['log', 1e-6 + (1 - 1e-6) * randomUnit()]),
  ['pow', 10, -0.4375], ['pow', 10, 0.0625], ['pow', 2, -1.5], ['pow', 0.5, 37 / 454.1791071114875],
]

const PROVIDER_TIME_INPUT = [
  '2025-01-11 17:13:25', '2026-07-01 08:10:16', '2025-01-11T17:13:25', '2025-01-11 17:13', '2025-01-11 17:13:25.5',
  '2025-01-11T17:13:25Z', '2025-01-11T17:13:25.000+09:00', '2025-01-11', 'not a date', '',
  '2016-12-31T23:59:60Z', '2016-12-31T23:59:60.5Z',
  '2016-12-31 23:59:60', '2016-12-31 23:59:60.5',
  '2016-12-31T23:59:60', '2016-12-31T23:59:60.5',
  '2025-02-29', '2024-02-30 12:34:56', '2025-02-31T12:34:56Z', '2025-04-31T12:34:56+09:00',
  '2025-02-00T00:00Z', '2025-02-32T00:00Z', '2025-13-01T00:00Z',
  '2025-12-31 24:00', '2024-02-30T24:00:00.0000Z', '2025-01-11T24:00:00.0001Z',
  '2025-01-11 24:00:00.0001', '2025-01-11T24:01Z', '2025-01-11T24:00:01Z', '2025-01-11T25:00Z',
  '2025-01-11T17:13Z', '2025-01-11T17:13+0900', '2025-01-11T17:13-09:30',
  '2025-01-11t17:13:25z', '2025-01-11T17:13:25.123456789Z',
  '2025-01-11T17:13:25+24:00', '2025-01-11T17:13:25+09:60',
  '2025-1-11T17:13:25Z', '2025-01-1T17:13:25Z', '2025-01-11T7:13:25Z',
  '2025-01-11T17:3:25Z', '2025-01-11T17:13:5Z', '2025-01-11T17:13:25.Z',
  '0000-01-01T00:00:00+01:00', '9999-12-31T24:00Z', '9999-12-31T23:59:59-01:00',
]

function applyMath(operation: 'exp' | 'log' | 'pow', left: number, right?: number) {
  if (operation === 'exp') return Math.exp(left)
  if (operation === 'log') return Math.log(left)
  return left ** (right ?? Number.NaN)
}

/** Deterministic uniform values in [0, 1), so the math sample never changes between runs. */
function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

type EncodedInput = null | boolean | number | string | EncodedInput[] | { [key: string]: EncodedInput }

function encodeInput(value: unknown): EncodedInput {
  if (value === undefined) return { $type: 'undefined' }
  if (typeof value === 'number') {
    return Number.isFinite(value) && !Object.is(value, -0) ? value : { $type: 'number', bits: float64Bits(value) }
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(encodeInput)
  if (value instanceof Map) return { $type: 'map', entries: [...value].map(([key, entry]) => [encodeInput(key), encodeInput(entry)]) }
  if (value instanceof Set) return { $type: 'set', values: [...value].map(encodeInput) }
  if (typeof value === 'object' && !Object.hasOwn(value, '$type')) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeInput(entry)]))
  }
  throw new Error(`Parity input cannot be encoded: ${String(value)}`)
}

function outputOrThrows<T extends object>(compute: () => T): T | { throws: true } {
  try {
    return compute()
  } catch {
    return { throws: true }
  }
}

function float64Bits(value: number) {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}

function nullIfNaN(value: number) {
  return Number.isNaN(value) ? null : value
}

function sha256(text: string) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
