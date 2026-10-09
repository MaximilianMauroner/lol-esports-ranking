import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { stableJson } from '../src/lib/incremental/types.ts'
import { stableJsonSha256 } from '../scripts/stable-json-digest.ts'

test('streamed state identity preserves the existing canonical byte contract', () => {
  const values: unknown[] = [null, true, -0, 1e-7, 1e21, '\ud800😀',
    { z: undefined, b: 1, a: ['x', null, { '😀': 1, '\uffff': 2 }] },
    [undefined], [undefined, null, undefined], new Array(3),
    new Map([['z', 1], ['a', 2]]), new Set(['z', 'a']),
    // Flush boundaries must not split UTF-16 surrogate pairs into different UTF-8 bytes.
    { text: '😀'.repeat(40_000), next: '😀' },
    Array.from({ length: 3_000 }, (_, index) => ({ index, text: '0123456789'.repeat(10) })),
  ]
  for (const value of values) {
    assert.equal(stableJsonSha256(value), createHash('sha256').update(stableJson(value)).digest('hex'))
  }
  for (const value of [NaN, Infinity, -Infinity, { value: Infinity }]) {
    assert.throws(() => stableJsonSha256(value), /non-finite/)
  }
})

test('state identity detects mutations at both sides of a flush boundary', () => {
  const values = Array.from({ length: 2_000 }, (_, index) => ({ index, payload: 'x'.repeat(100) }))
  const original = stableJsonSha256(values)
  for (const index of [0, 1_999]) {
    const changed = structuredClone(values)
    changed[index]!.payload += 'y'
    assert.notEqual(stableJsonSha256(changed), original)
  }
})
