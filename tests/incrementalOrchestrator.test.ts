import assert from 'node:assert/strict'
import test from 'node:test'
import { createCrunchCompatibility, compatibilityFallback } from '../src/lib/incremental/compatibility.ts'
import { createIncrementalCrunchReceipt } from '../src/lib/incremental/metrics.ts'
import { crunchModeFrom, orchestrateCrunch } from '../src/lib/incremental/orchestrator.ts'
import type { CrunchMode } from '../src/lib/incremental/types.ts'

const run = { generatedAt: '2026-07-18T00:00:00.000Z', runId: 'run_contract' }

test('default and explicit full modes invoke the direct reference callback once', async () => {
  for (const mode of [undefined, 'full'] as const) {
    let calls = 0
    const result = await orchestrateCrunch({
      mode,
      runFull: () => {
        calls += 1
        return { engine: 'reference' as const }
      },
    })
    assert.equal(calls, 1)
    assert.deepEqual(result, {
      output: { engine: 'reference' },
      requestedMode: 'full',
      executedMode: 'full',
    })
  }
})

test('unavailable incremental modes fall back explicitly without claiming reuse', async () => {
  for (const mode of ['incremental-shadow', 'incremental'] satisfies CrunchMode[]) {
    let calls = 0
    const receipt = createIncrementalCrunchReceipt({ run, requestedMode: mode })
    const result = await orchestrateCrunch({
      mode,
      receipt,
      runFull: () => {
        calls += 1
        return 'reference-output'
      },
    })
    const fallback = { kind: 'incremental-mode-unavailable' as const, requestedMode: mode }
    assert.equal(calls, 1)
    assert.equal(result.output, 'reference-output')
    assert.equal(result.executedMode, 'full')
    assert.deepEqual(result.fallback, fallback)
    assert.equal(receipt.artifacts.reused, null)
    assert.equal(receipt.reducers.teamRows, null)
    assert.deepEqual(receipt.checkpoint.fallback, fallback)
  }
})

test('mode parsing rejects unknown values', () => {
  assert.equal(crunchModeFrom(undefined), 'full')
  assert.equal(crunchModeFrom('incremental-shadow'), 'incremental-shadow')
  assert.throws(() => crunchModeFrom('optimistic'), /Unsupported ranking crunch mode/)
})

test('compatibility hashes are key-order independent and identify exact mismatches', () => {
  const expected = createCrunchCompatibility({ model: { version: 2 }, calendar: ['2026'] })
  const equivalent = createCrunchCompatibility({ calendar: ['2026'], model: { version: 2 } })
  const incompatible = createCrunchCompatibility({ calendar: ['2027'], model: { version: 2 } })
  assert.equal(expected.hash, equivalent.hash)
  assert.equal(compatibilityFallback(expected, equivalent), undefined)
  assert.deepEqual(compatibilityFallback(expected, incompatible), {
    kind: 'compatibility-hash-mismatch',
    dependency: 'calendar',
    expected: expected.dependencies.calendar,
    actual: incompatible.dependencies.calendar,
  })
  assert.deepEqual(compatibilityFallback(expected, { ...equivalent, hash: 'tampered' }), {
    kind: 'compatibility-hash-mismatch',
    dependency: 'compatibility-envelope',
    expected: equivalent.hash,
    actual: 'tampered',
  })
  const unexpected = createCrunchCompatibility({ calendar: ['2026'], model: { version: 2 }, aliasTable: 1 })
  assert.deepEqual(compatibilityFallback(expected, unexpected), {
    kind: 'compatibility-hash-mismatch',
    dependency: 'aliasTable',
    expected: '<absent>',
    actual: unexpected.dependencies.aliasTable,
  })
})
