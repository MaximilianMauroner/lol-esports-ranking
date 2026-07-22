import assert from 'node:assert/strict'
import test from 'node:test'
import { runRefreshOnce, startLeaseHeartbeat } from '../scripts/refresh-once.mjs'

test('unchanged gated probe performs no broad provider fetch, crunch, or artifact upload', async () => {
  let childRuns = 0
  let writes = 0
  const logs: string[] = []
  const result = await runRefreshOnce({
    env: { RANKING_REFRESH_MODE: 'gated' },
    runId: 'no-change',
    owner: 'worker-1',
    now: () => new Date('2026-07-22T00:00:00Z'),
    monotonicNow: increasingClock(),
    rss: () => 1024,
    bucketConfig: { enabled: true },
    bucketClient: {},
    acquireLease: async () => ({
      acquired: true as const,
      lease: { owner: 'worker-1', fencingToken: 1, acquiredAt: '2026-07-22T00:00:00Z', expiresAt: '2026-07-22T00:45:00Z' },
      etag: 'lease-1',
    }),
    assertLease: async () => ({ live: true as const }),
    renewLease: async () => ({ renewed: true as const, lease: {}, etag: 'lease-2' }),
    releaseLease: async () => ({ released: true }),
    readBucketJson: async () => ({ found: false }),
    writeBucketJson: async () => ({ written: true, etag: `state-${++writes}` }),
    readLocalState: async () => undefined,
    writeLocalState: async () => undefined,
    fetchProbe: async () => ({ checkedAt: '2026-07-22T00:00:00Z', coverageComplete: true, events: [] }),
    runChild: async () => { childRuns += 1 },
    setInterval: () => ({ unref() {} }),
    clearInterval: () => undefined,
    logger: { log: (value: string) => logs.push(value), warn() {}, error() {} },
  })

  assert.equal(result.status, 'completed')
  assert.equal(childRuns, 0)
  assert.equal(writes, 2)
  assert.equal(result.metrics?.cause, 'unchanged-scheduled-probe')
  assert.equal(logs.filter((line) => line.startsWith('REFRESH_RUN_METRIC ')).length, 1)
})

test('lease loss during child work prevents trigger-state mutation after the child', async () => {
  let assertions = 0
  let writes = 0
  await assert.rejects(() => runRefreshOnce({
    env: { RANKING_REFRESH_MODE: 'gated' },
    owner: 'old-worker',
    now: () => new Date('2026-07-22T00:00:00Z'),
    monotonicNow: increasingClock(),
    bucketConfig: { enabled: true },
    bucketClient: {},
    acquireLease: async () => ({ acquired: true as const, lease: { owner: 'old-worker', fencingToken: 1, expiresAt: '2026-07-22T00:45:00Z' }, etag: 'one' }),
    assertLease: async () => {
      assertions += 1
      if (assertions >= 3) throw new Error('Refresh lease is no longer authoritative: lease-changed')
      return { live: true as const }
    },
    releaseLease: async () => ({ released: false, reason: 'lease-changed' }),
    readBucketJson: async () => ({ found: false }),
    writeBucketJson: async () => ({ written: true, etag: `state-${++writes}` }),
    readLocalState: async () => undefined,
    writeLocalState: async () => undefined,
    fetchProbe: async () => ({
      checkedAt: '2026-07-22T00:00:00Z',
      coverageComplete: true,
      events: [{ matchId: 'm1', state: 'completed', teams: [{ id: 'a', gameWins: 1 }, { id: 'b', gameWins: 0 }] }],
    }),
    runChild: async () => undefined,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => undefined,
    logger: { log() {}, warn() {}, error() {} },
  }), /lease-changed/)
  assert.equal(writes, 1)
})

test('heartbeat updates authority so release can use the renewed ETag', async () => {
  const authority = { lease: { owner: 'one', fencingToken: 1 }, etag: 'old' }
  let tick: (() => void) | undefined
  const heartbeat = startLeaseHeartbeat({
    authority,
    leaseKey: 'lease',
    ttlMs: 9000,
    now: () => new Date('2026-07-22T00:00:03Z'),
    renew: async () => ({ renewed: true, lease: { owner: 'one', fencingToken: 1, expiresAt: 'later' }, etag: 'new' }),
    config: {},
    client: {},
    setIntervalFn: (callback: () => void) => { tick = callback; return { unref() {} } },
    clearIntervalFn: () => undefined,
  })
  tick?.()
  await heartbeat.stop()
  assert.equal(authority.etag, 'new')
})

function increasingClock() {
  let value = 0
  return () => ++value
}
