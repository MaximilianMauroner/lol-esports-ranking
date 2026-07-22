import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runChildProcess, runRefreshOnce, startLeaseHeartbeat } from '../scripts/refresh-once.mjs'
import { writeRefreshMetrics } from '../scripts/refresh-metrics.mjs'

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

test('remote and local state read failures still stop heartbeat, release lease, and emit terminal metrics', async () => {
  for (const failure of ['remote', 'local'] as const) {
    let cleared = 0
    let released = 0
    const logs: string[] = []
    await assert.rejects(() => runRefreshOnce({
      ...baseOptions(logs),
      readBucketJson: async () => {
        if (failure === 'remote') throw new Error('remote-read-failed')
        return { found: false }
      },
      readLocalState: async () => { throw new Error('local-read-failed') },
      releaseLease: async () => { released += 1; return { released: true } },
      clearInterval: () => { cleared += 1 },
    }), new RegExp(`${failure}-read-failed`))
    assert.equal(cleared, 1)
    assert.equal(released, 1)
    const terminal = metricLog(logs)
    assert.equal(terminal.result, 'failed')
    assert.match(String(terminal.error), new RegExp(`${failure}-read-failed`))
  }
})

test('renewal and assertion serialize across the PUT-to-local-authority update window', async () => {
  const authority = { lease: { owner: 'one', fencingToken: 1 }, etag: 'old', promotionEtag: 'pointer' }
  let tick: (() => void) | undefined
  let finishRenewal: (() => void) | undefined
  const renewalGate = new Promise<void>((resolve) => { finishRenewal = resolve })
  const heartbeat = startLeaseHeartbeat({
    authority,
    leaseKey: 'lease',
    ttlMs: 9000,
    now: () => new Date(),
    renew: async () => {
      await renewalGate
      return { renewed: true, lease: { owner: 'one', fencingToken: 1 }, etag: 'new', promotionEtag: 'pointer' }
    },
    config: {},
    client: {},
    setIntervalFn: (callback: () => void) => { tick = callback; return { unref() {} } },
    clearIntervalFn: () => undefined,
  })
  tick?.()
  let assertedEtag = ''
  const assertion = heartbeat.runExclusive(async () => { assertedEtag = authority.etag })
  await Promise.resolve()
  assert.equal(assertedEtag, '')
  finishRenewal?.()
  await assertion
  await heartbeat.stop()
  assert.equal(assertedEtag, 'new')
})

test('recovery-window work uses match completion date and reports no publication without promotion', async () => {
  const result = await runRefreshOnce({
    ...baseOptions([]),
    fetchProbe: async () => ({
      checkedAt: '2026-07-22T00:00:00Z',
      coverageComplete: true,
      events: [{
        matchId: 'recovered',
        state: 'completed',
        startTime: '2026-07-19T22:00:00Z',
        teams: [{ id: 'a', gameWins: 1 }, { id: 'b', gameWins: 0 }],
      }],
    }),
    runChild: async () => undefined,
    readJson: async () => ({ matches: [] }),
  })
  assert.equal(result.metrics?.affected.date, '2026-07-19')
  assert.equal(result.metrics?.freshness.publishedAt, null)
})

test('startup enforces five-minute evidence flags while six-hour legacy stays compatible', async () => {
  await assert.rejects(() => runRefreshOnce({
    env: { RANKING_REFRESH_MODE: 'legacy', RANKING_REFRESH_INTERVAL_MINUTES: '5' },
    runChild: async () => undefined,
  }), /gated-mode/)
  await assert.rejects(() => runRefreshOnce({
    env: { RANKING_REFRESH_MODE: 'gated', RANKING_REFRESH_INTERVAL_MINUTES: '5' },
  }), /proven-cheap-exit, lease-fencing/)
  const safe = await runRefreshOnce({
    env: { RANKING_REFRESH_MODE: 'legacy', RANKING_REFRESH_INTERVAL_MINUTES: '360' },
    runChild: async () => undefined,
    logger: { log() {}, warn() {}, error() {} },
  })
  assert.equal(safe.status, 'completed')
})

test('release failure cannot replace the primary failure and terminal metric is unconditional', async () => {
  const logs: string[] = []
  await assert.rejects(() => runRefreshOnce({
    ...baseOptions(logs),
    readBucketJson: async () => { throw new Error('primary-read-error') },
    releaseLease: async () => { throw new Error('release-error') },
  }), /primary-read-error/)
  const terminal = metricLog(logs)
  assert.equal(terminal.result, 'failed')
  assert.match(String(terminal.error), /primary-read-error/)
  assert.deepEqual(terminal.finalizationErrors, ['lease-release: release-error'])
})

test('timeout waits for child-tree exit before rejecting and permitting lease release', async () => {
  const child = new EventEmitter() as EventEmitter & { pid?: number; kill(signal: string): void }
  const signals: string[] = []
  child.kill = (signal) => { signals.push(signal) }
  const timers: Array<() => void> = []
  let settled = false
  const running = runChildProcess('node', [], 100, {}, {
    spawn: () => child,
    setTimeout: (callback: () => void) => { timers.push(callback); return { unref() {} } },
    clearTimeout: () => undefined,
  }).finally(() => { settled = true })
  timers[0]()
  await Promise.resolve()
  assert.deepEqual(signals, ['SIGTERM'])
  assert.equal(settled, false)
  child.emit('exit', null, 'SIGTERM')
  await assert.rejects(running, /process tree exited/)
  assert.equal(settled, true)
})

test('published child telemetry remains canonical in result, trigger state, and stable log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refresh-canonical-parent-'))
  const metricsPath = join(root, 'metrics.json')
  const logs: string[] = []
  const canonical = {
    schemaVersion: 1 as const,
    runId: 'canonical-parent',
    mode: 'gated' as const,
    cause: 'pending-match' as const,
    startedAt: '2026-07-19T22:00:00.000Z',
    finishedAt: '2026-07-19T22:00:10.000Z',
    durationMs: 10_000,
    result: 'completed',
    peakRssBytes: 100,
    affected: { matchIds: ['match-1'], date: '2026-07-19' },
    freshness: { providerAvailableAt: null, detectedAt: '2026-07-19T22:00:01.000Z', publishedAt: '2026-07-19T22:00:10.000Z' },
    checkpoint: { applicable: false as const, reason: 'not-implemented' },
    stages: [{ name: 'public-serialization' as const, durationMs: 3, result: 'completed', input: {}, output: { outputBytes: 20 } }],
  }
  try {
    const result = await runRefreshOnce({
      ...baseOptions(logs),
      env: { RANKING_REFRESH_MODE: 'gated', RANKING_REFRESH_METRICS_PATH: metricsPath },
      runId: canonical.runId,
      fetchProbe: async () => ({
        checkedAt: '2026-07-22T00:00:00Z',
        coverageComplete: true,
        events: [{ matchId: 'match-1', state: 'completed', startTime: '2026-07-19T22:00:00Z', teams: [{ id: 'a', gameWins: 1 }, { id: 'b', gameWins: 0 }] }],
      }),
      runChild: async () => { await writeRefreshMetrics(metricsPath, canonical) },
      readJson: async () => ({ matches: [] }),
    })
    assert.deepEqual(result.metrics, canonical)
    assert.deepEqual((result.state as { lastRun: unknown }).lastRun, canonical)
    assert.deepEqual(metricLog(logs), canonical)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function increasingClock() {
  let value = 0
  return () => ++value
}

function baseOptions(logs: string[]) {
  let writes = 0
  return {
    env: { RANKING_REFRESH_MODE: 'gated' },
    owner: 'worker',
    now: () => new Date('2026-07-22T00:00:00Z'),
    monotonicNow: increasingClock(),
    bucketConfig: { enabled: true },
    bucketClient: {},
    acquireLease: async () => ({ acquired: true as const, lease: { owner: 'worker', fencingToken: 1, expiresAt: '2026-07-22T00:45:00Z' }, etag: 'lease' }),
    assertLease: async () => ({ live: true as const }),
    releaseLease: async () => ({ released: true }),
    readBucketJson: async () => ({ found: false }),
    readLocalState: async () => undefined,
    writeLocalState: async () => undefined,
    writeBucketJson: async () => ({ written: true, etag: `state-${++writes}` }),
    fetchProbe: async () => ({ checkedAt: '2026-07-22T00:00:00Z', coverageComplete: true, events: [] }),
    setInterval: () => ({ unref() {} }),
    clearInterval: () => undefined,
    logger: { log: (value: string) => logs.push(value), warn() {}, error() {} },
  }
}

function metricLog(logs: string[]) {
  const line = logs.findLast((entry) => entry.startsWith('REFRESH_RUN_METRIC '))
  assert.ok(line)
  return JSON.parse(line.slice('REFRESH_RUN_METRIC '.length))
}
