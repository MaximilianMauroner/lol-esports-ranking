import assert from 'node:assert/strict'
import test from 'node:test'
import { createCrunchCompatibility, compatibilityFallback } from '../src/lib/incremental/compatibility.ts'
import { createIncrementalCrunchReceipt, recordCrunchAttemptSources } from '../src/lib/incremental/metrics.ts'
import { crunchModeFrom, orchestrateCrunch } from '../src/lib/incremental/orchestrator.ts'
import { assertCrunchParity } from '../src/lib/incremental/parity.ts'
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
    assert.deepEqual(receipt.attempts.map(({ engine, outcome }) => ({ engine, outcome })), [
      { engine: 'incremental', outcome: 'fallback' },
      { engine: 'reference', outcome: 'succeeded' },
    ])
  }
})

test('incremental and shadow modes use an available canonical reuse path safely', async () => {
  let fullCalls = 0
  let incrementalCalls = 0
  const incremental = await orchestrateCrunch({
    mode: 'incremental',
    runFull: () => {
      fullCalls += 1
      return 'full'
    },
    runIncremental: () => {
      incrementalCalls += 1
      return { output: 'incremental' }
    },
  })
  assert.equal(incremental.output, 'incremental')
  assert.equal(incremental.executedMode, 'incremental')
  assert.equal(fullCalls, 0)
  assert.equal(incrementalCalls, 1)

  const shadow = await orchestrateCrunch({
    mode: 'incremental-shadow',
    runFull: () => {
      fullCalls += 1
      return 'full'
    },
    runIncremental: () => ({ output: 'candidate' }),
  })
  assert.equal(shadow.output, 'full')
  assert.equal(shadow.shadowOutput, 'candidate')
  assert.equal(shadow.executedMode, 'full')
  assert.equal(fullCalls, 1)
})

test('shadow mode compacts the candidate before starting the reference replay', async () => {
  let prepared = false
  const result = await orchestrateCrunch<{ snapshot: string }, { serialized: string }>({
    mode: 'incremental-shadow',
    runIncremental: () => ({ output: { snapshot: 'candidate' } }),
    prepareShadow: (candidate) => {
      prepared = true
      return { serialized: JSON.stringify(candidate) }
    },
    runFull: () => {
      assert.equal(prepared, true)
      return { snapshot: 'reference' }
    },
  })

  assert.deepEqual(result.output, { snapshot: 'reference' })
  assert.deepEqual(result.shadowOutput, { serialized: '{"snapshot":"candidate"}' })
})

test('receipts preserve both shadow attempts instead of overwriting fallback work', async () => {
  const receipt = createIncrementalCrunchReceipt({ run, requestedMode: 'incremental-shadow' })
  const result = await orchestrateCrunch({
    mode: 'incremental-shadow',
    receipt,
    runFull: () => 'full',
    runIncremental: () => ({ output: 'candidate' }),
  })
  assert.equal(result.output, 'full')
  assert.deepEqual(receipt.attempts.map(({ engine, outcome }) => ({ engine, outcome })), [
    { engine: 'incremental', outcome: 'succeeded' },
    { engine: 'reference', outcome: 'succeeded' },
  ])
})

test('reference parity gate keeps ordinary incremental candidates in shadow until activation', async () => {
  let fullCalls = 0
  const result = await orchestrateCrunch({
    mode: 'incremental',
    requireReferenceParity: true,
    runFull: () => {
      fullCalls += 1
      return { snapshot: 'reference', publicWrites: ['reference'] }
    },
    runIncremental: () => ({ output: { snapshot: 'candidate', publicWrites: ['candidate'] } }),
  })
  assert.equal(fullCalls, 1)
  assert.equal(result.executedMode, 'full')
  assert.deepEqual(result.output, { snapshot: 'reference', publicWrites: ['reference'] })
  assert.deepEqual(result.shadowOutput, { snapshot: 'candidate', publicWrites: ['candidate'] })
  let promoted = false
  assert.throws(() => {
    assertCrunchParity(
      { fullSnapshot: result.output.snapshot, publicWrites: result.output.publicWrites.map((contents) => ({ relativePath: 'scope.json', contents })) },
      { fullSnapshot: result.shadowOutput!.snapshot, publicWrites: result.shadowOutput!.publicWrites.map((contents) => ({ relativePath: 'scope.json', contents })) },
    )
    promoted = true
  }, /Incremental candidate mismatch/)
  assert.equal(promoted, false)
})

test('typed fallback preserves a faulty cold candidate for mandatory parity rejection', async () => {
  const fallback = { kind: 'compatibility-hash-mismatch' as const, dependency: 'code', expected: 'new', actual: 'old' }
  const result = await orchestrateCrunch({
    mode: 'incremental',
    runFull: () => ({ snapshot: 'reference' }),
    runIncremental: () => ({ output: { snapshot: 'faulty-candidate' }, fallback }),
  })
  assert.deepEqual(result.output, { snapshot: 'reference' })
  assert.deepEqual(result.shadowOutput, { snapshot: 'faulty-candidate' })
  assert.deepEqual(result.fallback, fallback)
  assert.equal(result.executedMode, 'full')
  assert.throws(() => assertCrunchParity(
    { fullSnapshot: result.output, publicWrites: [] },
    { fullSnapshot: result.shadowOutput, publicWrites: [] },
  ), /Incremental candidate mismatch/)
})

test('externally verified shadow protocol can isolate a cold fallback candidate', async () => {
  let fullCalls = 0
  const fallback = { kind: 'dependency-unknown' as const, dependency: 'cold-state' }
  const result = await orchestrateCrunch({
    mode: 'incremental',
    acceptFallbackCandidate: true,
    runIncremental: () => ({ output: { snapshot: 'candidate' }, fallback }),
    runFull: () => {
      fullCalls += 1
      return { snapshot: 'reference' }
    },
  })

  assert.equal(fullCalls, 0)
  assert.equal(result.executedMode, 'incremental')
  assert.deepEqual(result.output, { snapshot: 'candidate' })
  assert.deepEqual(result.fallback, fallback)
})

test('fallback receipts retain exact incremental scan metrics independently of reference work', async () => {
  const receipt = createIncrementalCrunchReceipt({ run, requestedMode: 'incremental' })
  await orchestrateCrunch({
    mode: 'incremental',
    receipt,
    runFull: () => 'reference',
    runIncremental: () => ({ fallback: { kind: 'dependency-unknown', dependency: 'ambiguous-provider-deletion' } }),
  })
  const sources = {
    filesScanned: 2,
    bytesScanned: 4096,
    rowsParsed: 12,
    observationsNormalized: 3,
    observationsReused: 7,
    reducerStateBytesRead: 8192,
    reducerStateBytesWritten: 2048,
  }
  recordCrunchAttemptSources(receipt, 'incremental', sources)
  assert.deepEqual(receipt.attempts.find((attempt) => attempt.engine === 'incremental')?.sources, sources)
  assert.deepEqual(receipt.attempts.find((attempt) => attempt.engine === 'reference')?.sources, {
    filesScanned: null,
    bytesScanned: null,
    rowsParsed: null,
    observationsNormalized: null,
    observationsReused: null,
    reducerStateBytesRead: null,
    reducerStateBytesWritten: null,
  })
})

test('full mode never reads a missing or corrupt ledger path', async () => {
  let ledgerReads = 0
  const result = await orchestrateCrunch({
    mode: 'full',
    runFull: () => 'clean-full',
    runIncremental: () => {
      ledgerReads += 1
      throw new Error('corrupt ledger')
    },
  })
  assert.equal(result.output, 'clean-full')
  assert.equal(ledgerReads, 0)
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
