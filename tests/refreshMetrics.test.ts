import assert from 'node:assert/strict'
import test from 'node:test'
import { completeRefreshMetrics, createRefreshMetrics, mergeRefreshMetrics, REFRESH_STAGE_NAMES } from '../scripts/refresh-metrics.mjs'

test('refresh telemetry uses injected wall, monotonic, and RSS clocks deterministically', () => {
  const wall = values([Date.parse('2026-07-22T00:00:00Z'), Date.parse('2026-07-22T00:00:01Z'), Date.parse('2026-07-22T00:00:03Z'), Date.parse('2026-07-22T00:00:04Z')])
  const monotonic = values([100, 120, 370, 500])
  const rss = values([1000, 1200, 1600, 1400])
  const metrics = createRefreshMetrics({
    runId: 'run-1',
    mode: 'gated',
    cause: 'pending-match',
    affectedIds: ['b', 'a', 'a'],
    affectedDate: '2026-07-22',
    now: wall,
    monotonicNow: monotonic,
    rss,
  })
  const finish = metrics.startStage('probe', { inputBytes: 10 })
  finish('completed', { rows: 2 })
  const record = completeRefreshMetrics(metrics.snapshot({ result: 'completed' }))

  assert.equal(record.durationMs, 400)
  assert.equal(record.peakRssBytes, 1600)
  assert.deepEqual(record.affected, { matchIds: ['a', 'b'], date: '2026-07-22' })
  assert.deepEqual(record.checkpoint, { applicable: false, reason: 'incremental-disabled-or-not-classified' })
  assert.equal(record.stages.find((stage) => stage.name === 'probe')?.durationMs, 250)
  assert.deepEqual(record.stages.map((stage) => stage.name), REFRESH_STAGE_NAMES)
})

test('real child stages replace not-applicable placeholders when records merge', () => {
  const parent = fixture('not-applicable')
  const child = fixture('completed')
  assert.equal(mergeRefreshMetrics(parent, child).stages[0].result, 'completed')
  assert.equal(mergeRefreshMetrics(child, parent).stages[0].result, 'completed')
})

test('record aggregation preserves whole-run envelope, freshness, promotion, and peak RSS', () => {
  const parent = {
    ...fixture('completed'),
    startedAt: '2026-07-22T00:00:00.000Z',
    finishedAt: null,
    peakRssBytes: 100,
    freshness: { providerAvailableAt: null, detectedAt: '2026-07-22T00:00:02.000Z', publishedAt: null },
  }
  const build = {
    ...fixture('completed'),
    startedAt: '2026-07-22T00:00:03.000Z',
    finishedAt: '2026-07-22T00:00:08.000Z',
    peakRssBytes: 500,
    freshness: { providerAvailableAt: null, detectedAt: null, publishedAt: null },
    stages: [{ name: 'public-serialization' as const, durationMs: 5000, result: 'completed', input: {}, output: { outputBytes: 20 } }],
  }
  const promotion = {
    ...fixture('completed'),
    startedAt: '2026-07-22T00:00:01.000Z',
    finishedAt: '2026-07-22T00:00:10.000Z',
    peakRssBytes: 300,
    freshness: { providerAvailableAt: null, detectedAt: null, publishedAt: '2026-07-22T00:00:10.000Z' },
    stages: [{
      name: 'promotion' as const,
      durationMs: 10,
      result: 'completed',
      input: {},
      output: { promotedAt: '2026-07-22T00:00:09.000Z' },
    }],
  }
  const merged = mergeRefreshMetrics(mergeRefreshMetrics(parent, build), promotion)
  assert.equal(merged.startedAt, '2026-07-22T00:00:00.000Z')
  assert.equal(merged.finishedAt, '2026-07-22T00:00:10.000Z')
  assert.equal(merged.durationMs, 10_000)
  assert.equal(merged.peakRssBytes, 500)
  assert.equal(merged.freshness.detectedAt, '2026-07-22T00:00:02.000Z')
  assert.equal(merged.freshness.publishedAt, '2026-07-22T00:00:09.000Z')
  assert.ok(merged.stages.some((stage) => stage.name === 'public-serialization'))
})

test('resource telemetry measures CPU seconds and RSS-integrated GB-seconds separately from peak', () => {
  const monotonic = values([0, 1000, 2000, 3000])
  const rss = values([1024 ** 3, 1024 ** 3, 3 * 1024 ** 3, 1024 ** 3])
  const cpu = [{ user: 100_000, system: 50_000 }, { user: 600_000, system: 150_000 }]
  let cpuIndex = 0
  const metrics = createRefreshMetrics({
    runId: 'resources', mode: 'gated', cause: 'pending-match', monotonicNow: monotonic, rss,
    cpuUsage: () => cpu[Math.min(cpuIndex++, cpu.length - 1)],
    processKey: 'worker-1',
  })
  const finish = metrics.startStage('probe')
  finish()
  const result = metrics.snapshot({ result: 'completed' })
  assert.equal(result.resources.cpuSeconds, 0.6)
  assert.equal(result.resources.memoryGbSeconds, 5)
  assert.equal(result.resources.peakRssBytes, 3 * 1024 ** 3)
})

test('work telemetry preserves unknown as null and process merging deduplicates one process', () => {
  const metrics = createRefreshMetrics({ runId: 'work', mode: 'gated', cause: 'pending-match', processKey: 'same' })
  metrics.recordWork({ providerRequests: 2, broadFetches: 0 })
  const first = metrics.snapshot({ result: 'completed' })
  assert.equal(first.work.providerRequests, 2)
  assert.equal(first.work.providerRetries, null)
  assert.equal(first.work.broadFetches, 0)
  const merged = mergeRefreshMetrics(first, first)
  assert.equal(merged.resources.processes.length, 1)
  assert.equal(merged.resources.cpuSeconds, first.resources.cpuSeconds)
  assert.equal(merged.work.providerRequests, 2)
})

test('one unknown subprocess keeps aggregate CPU and integrated memory unknown', () => {
  const metrics = createRefreshMetrics({ runId: 'unknown-child', mode: 'gated', cause: 'pending-match', processKey: 'parent' })
  metrics.recordProcessResource({
    processKey: 'raw-source-subprocess',
    cpuSeconds: null,
    memoryGbSeconds: null,
    peakRssBytes: null,
    sampleCount: 0,
  })
  const result = metrics.snapshot({ result: 'completed' })
  assert.equal(result.resources.processes.length, 2)
  assert.equal(result.resources.cpuSeconds, null)
  assert.equal(result.resources.memoryGbSeconds, null)
})

test('metric aggregation preserves failed stages and all failure messages', () => {
  const parent = { ...fixture('failed'), error: 'parent failure' }
  const child = { ...fixture('completed'), error: 'child failure' }
  const merged = mergeRefreshMetrics(parent, child)
  assert.equal(merged.stages[0].result, 'failed')
  assert.deepEqual(merged.errors, ['parent failure', 'child failure'])
})

function fixture(result: string) {
  return {
    schemaVersion: 1 as const,
    runId: 'run',
    mode: 'gated' as const,
    cause: 'pending-match' as const,
    startedAt: '2026-07-22T00:00:00.000Z',
    finishedAt: null,
    durationMs: 0,
    result: 'running',
    peakRssBytes: 1,
    affected: { matchIds: [] },
    freshness: { providerAvailableAt: null, detectedAt: null, publishedAt: null },
    checkpoint: { applicable: false as const, reason: 'not-implemented' },
    stages: [{ name: 'probe' as const, durationMs: 1, result, input: {}, output: {} }],
  }
}

function values(entries: number[]) {
  let index = 0
  return () => entries[Math.min(index++, entries.length - 1)]
}
