import assert from 'node:assert/strict'
import test from 'node:test'
import { aggregateRolloutEvidence, createRefreshRolloutEvidence, hasRolloutFailure, parseRolloutEvidence, publishRolloutEvidence } from '../scripts/rollout-evidence.mjs'
import { rolloutEvidence } from './rolloutTestFixtures.ts'

test('rollout evidence requires every receipt section and publishes immutably', async () => {
  const value = rolloutEvidence()
  assert.equal(parseRolloutEvidence(value), value)
  const incomplete = { ...value } as Record<string, unknown>
  delete incomplete.lease
  assert.throws(() => parseRolloutEvidence(incomplete), /missing lease/)

  const writes: string[] = []
  const uploaded = await publishRolloutEvidence(value, {
    config: {}, client: {},
    writeJson: async (key: string) => { writes.push(key); return { written: true, etag: 'one' } },
  })
  assert.equal(uploaded.status, 'uploaded')
  assert.deepEqual(writes, ['ops/rollout-evidence/runs/abc123/latest-append-run.json'])

  const unchanged = await publishRolloutEvidence(value, {
    config: {}, client: {},
    writeJson: async () => ({ written: false, conflict: true }),
    readJson: async () => ({ found: true, value, etag: 'one' }),
  })
  assert.equal(unchanged.status, 'unchanged')
  await assert.rejects(publishRolloutEvidence(value, {
    config: {}, client: {},
    writeJson: async () => ({ written: false, conflict: true }),
    readJson: async () => ({ found: true, value: {
      ...value,
      execution: { ...value.execution, result: 'failed' },
      error: 'different',
    } }),
  }), /Conflicting immutable/)
})

test('fractional production timings are valid and cheap unchanged is successful without invented parity', () => {
  assert.doesNotThrow(() => parseRolloutEvidence(rolloutEvidence({
    execution: { result: 'completed', durationMs: 0.25 },
    timings: { totalMs: 0.5 },
  })))
  const unchanged = createRefreshRolloutEvidence({
    runId: 'fixture-unchanged',
    result: 'completed',
    startedAt: '2026-07-23T00:00:00Z',
    finishedAt: '2026-07-23T00:00:00.100Z',
    durationMs: 100.5,
    mode: 'gated',
    cause: 'unchanged-scheduled-probe',
    checkpoint: { applicable: false },
    freshness: { providerAvailableAt: null, detectedAt: null, publishedAt: null },
    resources: { cpuSeconds: 0.1, memoryGbSeconds: 0.2, peakRssBytes: 3, processes: [] },
    work: {
      providerRequests: 1, providerRetries: 0, broadFetches: 0, fullBuilds: 0,
      incrementalBuilds: 0, bytesRead: 0, bytesWritten: 0, objectsRead: 0,
      objectsWritten: 0, uploads: 0,
    },
    stages: [{ name: 'classification', output: { classification: 'no-change', addedCount: 0, changedCount: 0, removedCount: 0 } }],
  }, {
    evidenceClass: 'production-like-fixture',
    commit: 'abc123',
    expiresAt: '2027-01-01T00:00:00Z',
    deployment: { deploymentId: 'deployment-1', environmentId: 'environment-1', serviceId: 'service-1' },
  })
  assert.deepEqual(unchanged.parity, { semantic: null, state: null, checkpoint: null })
  assert.deepEqual(unchanged.comparison, { authoritative: false, equal: false, partial: false })
  assert.equal(hasRolloutFailure(unchanged), false)
})

test('zero-mutation daily audit is authoritative and excluded from cheap unchanged and changed populations', () => {
  const audit = createRefreshRolloutEvidence({
    runId: 'fixture-daily-audit',
    result: 'completed',
    startedAt: '2026-07-23T00:00:00Z',
    finishedAt: '2026-07-23T00:00:02Z',
    durationMs: 2000,
    mode: 'gated',
    cause: 'daily-audit',
    checkpoint: { applicable: false },
    freshness: { providerAvailableAt: null, detectedAt: null, publishedAt: '2026-07-23T00:00:02Z' },
    resources: { cpuSeconds: 1, memoryGbSeconds: 2, peakRssBytes: 3, processes: [] },
    work: {
      providerRequests: 1, providerRetries: 0, broadFetches: 1, fullBuilds: 1,
      incrementalBuilds: 0, bytesRead: 1, bytesWritten: 1, objectsRead: 1,
      objectsWritten: 1, uploads: 1,
    },
    stages: [
      { name: 'classification', output: { classification: 'no-change', addedCount: 0, changedCount: 0, removedCount: 0 } },
      { name: 'semantic-parity', result: 'completed', output: { parity: true, stateParity: true, checkpointParity: true } },
      { name: 'crunch', result: 'completed', output: { fullSnapshotWritten: true } },
      { name: 'promotion', result: 'completed', output: { generationId: 'generation-1' } },
      { name: 'full-audit-receipt', result: 'completed', output: { generationId: 'generation-1' } },
    ],
  }, {
    evidenceClass: 'live',
    commit: 'abc123',
    expiresAt: '2027-01-01T00:00:00Z',
    deployment: { deploymentId: 'deployment-1', environmentId: 'environment-1', serviceId: 'service-1' },
  })
  assert.equal(audit.scenario, 'daily-audit')
  assert.equal(audit.comparison.equal, true)
  assert.equal(audit.promotion.completed, true)
  assert.equal(hasRolloutFailure(audit), false)

  const aggregate = aggregateRolloutEvidence([
    rolloutEvidence({ evidenceClass: 'live', runId: 'changed-live' }),
    rolloutEvidence({ evidenceClass: 'live', scenario: 'unchanged', runId: 'unchanged-live' }),
    audit,
  ])
  assert.equal(aggregate.changedCount, 1)
  assert.equal(aggregate.unchangedCount, 1)
  assert.equal(aggregate.dailyAuditCount, 1)
  assert.throws(() => parseRolloutEvidence({
    ...audit,
    promotion: { completed: false },
  }), /Daily audit rollout evidence/)
})

test('evidence aggregation deduplicates identical runs, rejects conflicts, preserves failures, and computes p50/p95', () => {
  const unchanged = [1, 2, 3, 4, 100].map((duration, index) => rolloutEvidence({
    scenario: 'unchanged', runId: `u-${index}`, timings: { totalMs: duration },
  }))
  const failed = rolloutEvidence({ runId: 'failed', error: 'provider failure', execution: { result: 'failed' } })
  const aggregate = aggregateRolloutEvidence([...unchanged, unchanged[0], failed])
  assert.equal(aggregate.runCount, 6)
  assert.equal(aggregate.failureCount, 1)
  assert.deepEqual(aggregate.failureRunIds, ['failed'])
  assert.equal(aggregate.unchangedZeroWorkCount, 0)
  assert.deepEqual(aggregate.unchangedTimingsMs, { p50: null, p95: null })
  assert.throws(() => aggregateRolloutEvidence([
    unchanged[0],
    { ...unchanged[0], timings: { ...unchanged[0].timings, totalMs: 999 } },
  ]), /Conflicting rollout evidence/)
})
