import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateBenchmarkMetrics,
  evaluateIncrementalCompute,
  INCREMENTAL_NORMALIZED_COMPUTE_LIMIT,
  INCREMENTAL_SAFETY_PEAK_RSS_BYTES,
  oracleBaselineRewriteEvidence,
  passesIncrementalSafetyPeak,
} from '../scripts/incremental-benchmark-assertions.ts'

test('incremental safety peak is strict at 700 MiB', () => {
  assert.equal(passesIncrementalSafetyPeak(INCREMENTAL_SAFETY_PEAK_RSS_BYTES - 1), true)
  assert.equal(passesIncrementalSafetyPeak(INCREMENTAL_SAFETY_PEAK_RSS_BYTES), false)
})

test('incremental compute uses the middle calibration run for odd counts', () => {
  const result = evaluateIncrementalCompute([
    { computeMs: 20_000, calibrationMs: 5_000 },
    { computeMs: 20_000, calibrationMs: 3_000 },
    { computeMs: 20_000, calibrationMs: 4_000 },
  ])
  assert.equal(result.calibrationMedianMs, 4_000)
  assert.deepEqual(result.normalized, [5, 5, 5])
  assert.equal(result.pass, true)
})

test('incremental compute averages the two middle calibration runs for even counts', () => {
  // The old upper-middle value (5,000 ms) would normalize 28,000 ms to 5.6 and pass.
  const result = evaluateIncrementalCompute([
    { computeMs: 28_000, calibrationMs: 5_000 },
    { computeMs: 28_000, calibrationMs: 3_000 },
    { computeMs: 28_000, calibrationMs: 2_000 },
    { computeMs: 28_000, calibrationMs: 6_000 },
  ])
  assert.equal(result.calibrationMedianMs, 4_000)
  assert.deepEqual(result.normalized, [7, 7, 7, 7])
  assert.equal(result.pass, false)
})

test('one slow repetition fails incremental compute on its own', () => {
  const result = evaluateIncrementalCompute([
    { computeMs: 20_000, calibrationMs: 4_000 },
    { computeMs: 30_000, calibrationMs: 4_000 },
    { computeMs: 20_000, calibrationMs: 4_000 },
  ])
  assert.deepEqual(result.normalized, [5, 7.5, 5])
  assert.equal(result.pass, false)
})

test('incremental compute limit is strict', () => {
  const calibrationMs = 4_000
  const limitMs = INCREMENTAL_NORMALIZED_COMPUTE_LIMIT * calibrationMs
  const belowLimit = evaluateIncrementalCompute([{ computeMs: limitMs - 1, calibrationMs }])
  // The report consumes this same unrounded value, which would round to 6.5.
  assert.deepEqual(belowLimit.normalized, [6.49975])
  assert.equal(belowLimit.pass, true)
  assert.equal(evaluateIncrementalCompute([{ computeMs: limitMs, calibrationMs }]).pass, false)
})

test('incremental compute fails closed on missing or invalid durations', () => {
  const valid = { computeMs: 20_000, calibrationMs: 4_000 }
  assert.equal(evaluateIncrementalCompute([]).pass, false)
  for (const calibrationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(evaluateIncrementalCompute([valid, { computeMs: 20_000, calibrationMs }, valid]).pass, false, `calibrationMs ${calibrationMs}`)
  }
  for (const computeMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(evaluateIncrementalCompute([valid, { computeMs, calibrationMs: 4_000 }, valid]).pass, false, `computeMs ${computeMs}`)
  }
})

test('raw rewrite evidence follows receipt baseline identities, not byte-size heuristics', () => {
  assert.deepEqual(oracleBaselineRewriteEvidence({
    priorBaselineKeys: ['raw/objects/sha256/baseline'],
    activeBaselineKeys: ['raw/objects/sha256/baseline'],
    uploadedObjectKeys: ['raw/objects/sha256/delta', 'raw/objects/sha256/receipt'],
  }), {
    priorBaselineKeys: ['raw/objects/sha256/baseline'],
    activeBaselineKeys: ['raw/objects/sha256/baseline'],
    baselineKeysUnchanged: true,
    uploadedOracleBaselineKeys: [],
    fullRawRewrite: false,
  })
  assert.equal(oracleBaselineRewriteEvidence({
    priorBaselineKeys: ['raw/objects/sha256/old'],
    activeBaselineKeys: ['raw/objects/sha256/new'],
    uploadedObjectKeys: ['raw/objects/sha256/new'],
  }).fullRawRewrite, true)
})

test('benchmark aggregation reports explicit median and max for every numeric gate metric', () => {
  const aggregate = aggregateBenchmarkMetrics([
    { computeMs: 12, restoreDurationMs: 3, sampledPeakRssBytes: 30, mainMaxRssBytes: 27, rawChildMaxRssBytes: 9, uploadedBytes: 5 },
    { computeMs: 10, restoreDurationMs: 1, sampledPeakRssBytes: 20, mainMaxRssBytes: 18, rawChildMaxRssBytes: 7, uploadedBytes: 4 },
    { computeMs: 11, restoreDurationMs: 2, sampledPeakRssBytes: 25, mainMaxRssBytes: 22, rawChildMaxRssBytes: 8, uploadedBytes: 6 },
  ])
  assert.deepEqual(aggregate.median, {
    computeMs: 11, restoreDurationMs: 2, sampledPeakRssBytes: 25,
    mainMaxRssBytes: 22, rawChildMaxRssBytes: 8, uploadedBytes: 5,
  })
  assert.deepEqual(aggregate.max, {
    computeMs: 12, restoreDurationMs: 3, sampledPeakRssBytes: 30,
    mainMaxRssBytes: 27, rawChildMaxRssBytes: 9, uploadedBytes: 6,
  })
})
