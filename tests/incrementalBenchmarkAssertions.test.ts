import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateBenchmarkMetrics,
  INCREMENTAL_SAFETY_PEAK_RSS_BYTES,
  oracleBaselineRewriteEvidence,
  passesIncrementalSafetyPeak,
} from '../scripts/incremental-benchmark-assertions.ts'

test('incremental safety peak is strict at 700 MiB', () => {
  assert.equal(passesIncrementalSafetyPeak(INCREMENTAL_SAFETY_PEAK_RSS_BYTES - 1), true)
  assert.equal(passesIncrementalSafetyPeak(INCREMENTAL_SAFETY_PEAK_RSS_BYTES), false)
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
