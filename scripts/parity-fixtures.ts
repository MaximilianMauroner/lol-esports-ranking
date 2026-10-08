import { createHash } from 'node:crypto'
import { compareCodeUnits } from '../src/lib/codeUnitOrder.mjs'
import { parseProviderInstant, providerDate, providerDatetimeUtc } from '../src/lib/importers/providerTime'
import { stableDigest, stableJson } from '../src/lib/incremental/types'
import { configHashFor, transparentGprModelMetadata } from '../src/lib/modelConfig'
import { canonicalJsonFor, prepareSemanticArtifact } from './public-artifact-storage.mjs'

/**
 * Byte contracts that the planned Rust refresh worker (#84) must reproduce
 * exactly. Each entry pairs an input with the output Node produces today. `tests/fixtures/parity/contracts.json` is generated from this
 * function; regenerate it with `pnpm run fixtures:parity` only when a contract
 * change is intended.
 */
export function buildParityFixtures() {
  return {
    schemaVersion: 1,
    numberText: NUMBERS.map((value) => ({ bits: float64Bits(value), text: JSON.stringify(value) })),
    canonicalJson: JSON_VALUES.map((value) => {
      const canonical = canonicalJsonFor(value)
      return { input: value, canonical, sha256: sha256(canonical) }
    }),
    stableDigest: JSON_VALUES.map((value) => ({ input: value, stableJson: stableJson(value), digest: stableDigest(value) })),
    semanticArtifact: ARTIFACTS.map((value) => {
      const prepared = prepareSemanticArtifact(value, { compress: false })
      return { input: value, canonical: prepared.canonicalJson, sha256: prepared.digest, bytes: prepared.bytes }
    }),
    configHash: [
      ...JSON_VALUES.map((value) => ({ input: value, hash: configHashFor(value) })),
      { input: transparentGprModelMetadata.parameters, hash: transparentGprModelMetadata.configHash },
    ],
    codeUnitOrder: { input: ORDER_INPUT, sorted: ORDER_INPUT.toSorted(compareCodeUnits) },
    mathRound: ROUND_INPUT.map((value) => ({ bits: float64Bits(value), result: Math.round(value) })),
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

const MATH_INPUT: Array<['exp' | 'log' | 'pow', number, number?]> = [
  ['exp', 1], ['exp', -0.5], ['exp', 3.75], ['log', 2], ['log', 0.3], ['log', 1745.25],
  ['pow', 10, -0.4375], ['pow', 10, 0.0625], ['pow', 2, -1.5], ['pow', 0.5, 37 / 454.1791071114875],
]

const PROVIDER_TIME_INPUT = [
  '2025-01-11 17:13:25', '2026-07-01 08:10:16', '2025-01-11T17:13:25', '2025-01-11 17:13', '2025-01-11 17:13:25.5',
  '2025-01-11T17:13:25Z', '2025-01-11T17:13:25.000+09:00', '2025-01-11', 'not a date', '',
]

function applyMath(operation: 'exp' | 'log' | 'pow', left: number, right?: number) {
  if (operation === 'exp') return Math.exp(left)
  if (operation === 'log') return Math.log(left)
  return left ** (right ?? Number.NaN)
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
