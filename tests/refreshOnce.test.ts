import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Readable } from 'node:stream'
import { runChildProcess, runRefreshOnce, startLeaseHeartbeat } from '../scripts/refresh-once.mjs'
import { mergeRefreshMetrics, readRefreshMetrics, writeRefreshMetrics } from '../scripts/refresh-metrics.mjs'
import { uploadRankingArtifacts } from '../scripts/railway-bucket.mjs'
import type { RefreshRunMetrics } from '../scripts/refresh-metrics.mjs'

type RefreshDataIfChanged = (args?: string[], options?: Record<string, unknown>) => Promise<Record<string, unknown>>
const refreshDataScriptPath: string = '../scripts/refresh-data-if-changed.mjs'
const { refreshDataIfChanged } = await import(refreshDataScriptPath) as unknown as { refreshDataIfChanged: RefreshDataIfChanged }

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
    renewLease: async (_key: string, authority: { lease: Record<string, unknown> }) => ({
      renewed: true as const,
      lease: { ...authority.lease, expiresAt: '2026-07-22T00:45:00Z' },
      etag: 'renewed',
      promotionEtag: 'renewed',
    }),
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
  await assert.rejects(() => runRefreshOnce({
    env: { RANKING_REFRESH_MODE: 'gated', RANKING_REFRESH_LEASE_TTL_MS: '60000', RANKING_REFRESH_JOB_TIMEOUT_MS: '60000' },
  }), /lease TTL/)
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
  assert.deepEqual(finalizationLog(logs).errors, ['lease-release: release-error'])
})

test('release failure leaves successful canonical metric immutable and emits separate evidence', async () => {
  const logs: string[] = []
  const result = await runRefreshOnce({
    ...baseOptions(logs),
    releaseLease: async () => { throw new Error('release-after-success') },
  })
  assert.deepEqual(metricLog(logs), result.metrics)
  assert.deepEqual(finalizationLog(logs).errors, ['lease-release: release-after-success'])
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

test('real bucket child promotion hands authoritative ETag to parent before queued renewal and release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refresh-parent-child-etag-'))
  const publicDir = join(root, 'public')
  const metricsPath = join(root, 'metrics.json')
  const client = memoryS3()
  const config = bucketConfig()
  const acquiredAt = Date.parse('2026-07-22T00:00:00Z')
  let currentMs = acquiredAt
  let childLeaseRemainingMs = 0
  let heartbeatTick: (() => void) | undefined
  try {
    await mkdir(publicDir, { recursive: true })
    await writeFile(join(publicDir, 'ranking-summary.json'), '{}\n')
    const result = await runRefreshOnce({
      env: { RANKING_REFRESH_MODE: 'gated', RANKING_REFRESH_METRICS_PATH: metricsPath },
      runId: 'parent-child-etag',
      owner: 'worker',
      now: () => new Date(currentMs),
      monotonicNow: increasingClock(),
      bucketConfig: config,
      bucketClient: client,
      readLocalState: async () => undefined,
      writeLocalState: async () => undefined,
      fetchProbe: async () => {
        currentMs = acquiredAt + (14 * 60_000) + 59_000
        return {
          checkedAt: new Date(currentMs).toISOString(),
          coverageComplete: true,
          events: [{ matchId: 'match-1', state: 'completed', startTime: '2026-07-21T23:50:00Z', teams: [{ id: 'a', gameWins: 1 }, { id: 'b', gameWins: 0 }] }],
        }
      },
      readJson: async () => ({ matches: [] }),
      runChild: async ({ leaseKey, owner, fencingToken, promotionEtag }: { leaseKey: string; owner: string; fencingToken: number; promotionEtag: string }) => {
        const leaseAtChildStart = client.objects.get('rankings/active-generation.json')!
        const activeLease = JSON.parse(leaseAtChildStart.body) as { leaseExpiresAt: string }
        childLeaseRemainingMs = Date.parse(activeLease.leaseExpiresAt) - currentMs
        assert.equal(promotionEtag, leaseAtChildStart.etag)
        const seed = await readRefreshMetrics(metricsPath)
        assert.ok(seed)
        const uploaded = await uploadRankingArtifacts({
          publicDataDir: publicDir,
          generationId: 'generation-1',
          fencingToken,
          leaseAuthority: { key: leaseKey, lease: { owner, fencingToken } },
          now: () => new Date('2026-07-22T00:00:30Z'),
          beforePromotionWrite: async () => { heartbeatTick?.() },
          refreshTelemetry: (promotion: { promotedAt: string; etag: string }) => ({
            ...seed,
            result: 'completed',
            finishedAt: '2026-07-22T00:00:31.000Z',
            freshness: { ...seed.freshness, publishedAt: promotion.promotedAt },
            stages: seed.stages.map((stage) => stage.name === 'promotion'
              ? { ...stage, result: 'completed', output: { promotedAt: promotion.promotedAt, etag: promotion.etag } }
              : stage),
            coordination: { owner, fencingToken, etag: promotion.etag },
          }),
          config,
          client,
        })
        await writeRefreshMetrics(metricsPath, uploaded.refreshTelemetry as Awaited<ReturnType<typeof readRefreshMetrics>> & {})
      },
      setInterval: (callback: () => void) => { heartbeatTick = callback; return { unref() {} } },
      clearInterval: () => undefined,
      logger: { log() {}, warn() {}, error() {} },
    })
    const activeObject = client.objects.get('rankings/active-generation.json')!
    const active = JSON.parse(activeObject.body)
    assert.equal(result.status, 'completed')
    assert.equal(active.generationId, 'generation-1')
    assert.ok(childLeaseRemainingMs >= (30 * 60_000) + 60_000)
    assert.equal(typeof active.leaseRenewedAt, 'string')
    assert.equal(typeof active.leaseReleasedAt, 'string')
    assert.notEqual((result.metrics as { coordination?: { etag: string } }).coordination?.etag, activeObject.etag)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy parent returns the same finalized child record stored in state, receipt, file, and log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refresh-legacy-canonical-'))
  const publicDir = join(root, 'public')
  const statePath = join(root, 'refresh-state.json')
  const metricsPath = join(root, 'metrics.json')
  const client = memoryS3()
  const config = bucketConfig()
  const logs: string[] = []
  try {
    await mkdir(publicDir, { recursive: true })
    await writeFile(join(publicDir, 'ranking-summary.json'), '{}\n')
    await writeFile(statePath, '{}\n')
    const result = await runRefreshOnce({
      env: { RANKING_REFRESH_MODE: 'legacy', RANKING_REFRESH_METRICS_PATH: metricsPath },
      runId: 'legacy-canonical',
      runChild: async ({ cause }: { cause: string }) => {
        assert.equal(cause, 'daily-audit')
        const seed = await readRefreshMetrics(metricsPath)
        assert.ok(seed)
        const child = {
          ...seed,
          cause: 'daily-audit' as const,
          finishedAt: '2026-07-22T00:00:10.000Z',
          result: 'no-promotion',
          peakRssBytes: seed.peakRssBytes + 100,
          stages: seed.stages.map((stage) => stage.name === 'public-serialization' || stage.name === 'provider-fetch'
            ? { ...stage, result: 'completed', output: { outputBytes: 3 } }
            : stage),
        }
        const canonical = mergeRefreshMetrics(seed, child)
        const uploaded = await uploadRankingArtifacts({
          publicDataDir: publicDir,
          statePath,
          refreshTelemetry: canonical,
          refreshStateForUpload: ({ refreshTelemetry }: { refreshTelemetry: unknown }) => ({ lastRun: refreshTelemetry }),
          config,
          client,
        })
        await writeRefreshMetrics(metricsPath, uploaded.refreshTelemetry as typeof canonical)
      },
      logger: { log: (value: string) => logs.push(value), warn() {}, error: (value: string) => logs.push(value) },
    })
    const receipt = JSON.parse(client.objects.get('rankings/latest-publish.json')!.body)
    const refreshState = JSON.parse(client.objects.get('rankings/raw/refresh-state.json')!.body)
    const fileRecord = JSON.parse(await readFile(metricsPath, 'utf8'))
    assert.deepEqual(result.metrics, receipt.refreshTelemetry)
    assert.deepEqual(result.metrics, refreshState.lastRun)
    assert.deepEqual(result.metrics, fileRecord)
    assert.deepEqual(result.metrics, metricLog(logs))
    assert.equal(result.metrics?.cause, 'daily-audit')
    assert.equal(result.metrics?.freshness.publishedAt, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const terminal of ['unchanged', 'stale-source'] as const) {
  test(`${terminal} child record is identical across applicable non-publishing surfaces`, async () => {
    const outcome = await runNonPublishingCase(terminal)
    assert.deepEqual(outcome.result.metrics, outcome.refreshState.lastRun)
    assert.deepEqual(outcome.result.metrics, outcome.metricsFile)
    assert.deepEqual(outcome.result.metrics, outcome.result.state && (outcome.result.state as { lastRun: unknown }).lastRun)
    assert.deepEqual(outcome.result.metrics, outcome.triggerState.lastRun)
    assert.deepEqual(outcome.result.metrics, metricLog(outcome.logs))
    assert.equal(outcome.result.metrics?.result, terminal)
    assert.equal(outcome.result.metrics?.cause, 'pending-match')
    assert.equal(outcome.result.metrics?.freshness.publishedAt, null)
    assert.equal(outcome.client.objects.has('rankings/latest-publish.json'), false, 'non-publishing runs intentionally have no receipt')
    await outcome.cleanup()
  })
}

test('child error preserves one canonical failed record across refresh, metrics, trigger, error, and log surfaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refresh-child-error-canonical-'))
  const paths = refreshPaths(root)
  const client = memoryS3()
  const logs: string[] = []
  let caught: Error & { refreshMetrics?: unknown } | undefined
  try {
    await runRefreshOnce({
      ...realParentOptions(paths, client, logs),
      runId: 'child-error-canonical',
      runChild: async (context: Record<string, unknown>) => {
        await runRefreshChildCase('error', paths, context)
      },
    })
  } catch (error) {
    caught = error as Error & { refreshMetrics?: unknown }
  }
  try {
    assert.ok(caught)
    assert.match(caught.message, /provider-child-error/)
    const refreshState = JSON.parse(await readFile(paths.refreshState, 'utf8'))
    const metricsFile = JSON.parse(await readFile(paths.metrics, 'utf8'))
    const triggerState = JSON.parse(client.objects.get('rankings/raw/refresh-trigger-state.json')!.body)
    const remoteRefreshState = JSON.parse(client.objects.get('rankings/raw/refresh-state.json')!.body)
    assert.deepEqual(caught.refreshMetrics, refreshState.lastRun)
    assert.deepEqual(caught.refreshMetrics, remoteRefreshState.lastRun)
    assert.deepEqual(caught.refreshMetrics, metricsFile)
    assert.deepEqual(caught.refreshMetrics, triggerState.lastRun)
    assert.deepEqual(caught.refreshMetrics, metricLog(logs))
    assert.equal((caught.refreshMetrics as { result: string }).result, 'failed')
    assert.equal(client.objects.has('rankings/latest-publish.json'), false, 'failed pre-publish runs intentionally have no receipt')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function increasingClock() {
  let value = 0
  return () => ++value
}

type RefreshTestPaths = ReturnType<typeof refreshPaths>
type ParentResult = { status: string; metrics?: RefreshRunMetrics; state?: unknown }

async function runNonPublishingCase(terminal: 'unchanged' | 'stale-source') {
  const root = await mkdtemp(join(tmpdir(), `refresh-${terminal}-canonical-`))
  const paths = refreshPaths(root)
  const client = memoryS3()
  const logs: string[] = []
  const result = await runRefreshOnce({
    ...realParentOptions(paths, client, logs),
    runId: `${terminal}-canonical`,
    runChild: async (context: Record<string, unknown>) => {
      await runRefreshChildCase(terminal, paths, context)
    },
  }) as ParentResult
  return {
    result,
    client,
    logs,
    refreshState: JSON.parse(await readFile(paths.refreshState, 'utf8')),
    metricsFile: JSON.parse(await readFile(paths.metrics, 'utf8')),
    triggerState: JSON.parse(client.objects.get('rankings/raw/refresh-trigger-state.json')!.body),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

function realParentOptions(paths: RefreshTestPaths, client: ReturnType<typeof memoryS3>, logs: string[]) {
  return {
    env: {
      RANKING_REFRESH_MODE: 'gated',
      RANKING_REFRESH_METRICS_PATH: paths.metrics,
      RANKING_REFRESH_STATE: paths.refreshState,
    },
    owner: 'worker',
    now: () => new Date('2026-07-22T00:00:30Z'),
    monotonicNow: increasingClock(),
    bucketConfig: bucketConfig(),
    bucketClient: client,
    readLocalState: async () => undefined,
    writeLocalState: async () => undefined,
    fetchProbe: async () => ({
      checkedAt: '2026-07-22T00:00:30Z',
      coverageComplete: true,
      events: [{ matchId: 'match-1', state: 'completed', startTime: '2026-07-21T23:50:00Z', teams: [{ id: 'a', gameWins: 1 }, { id: 'b', gameWins: 0 }] }],
    }),
    readJson: async () => ({ matches: [] }),
    setInterval: () => ({ unref() {} }),
    clearInterval: () => undefined,
    logger: { log: (value: string) => logs.push(value), warn() {}, error: (value: string) => logs.push(value) },
  }
}

async function runRefreshChildCase(kind: 'unchanged' | 'stale-source' | 'error', paths: RefreshTestPaths, context: Record<string, unknown>) {
  let downloadCount = 0
  const fakeRun = async (_command: string, args: string[]) => {
    if (!args.includes('scripts/download-local-data.mjs')) throw new Error(`Unexpected child command ${args.join(' ')}`)
    if (kind === 'error') throw new Error('provider-child-error')
    downloadCount += 1
    const outDir = argValue(args, '--out-dir')
    const manifestPath = argValue(args, '--manifest')
    if (kind === 'stale-source') {
      await writeFile(manifestPath, `${JSON.stringify({
        schemaVersion: 1,
        start: '2026-07-21',
        end: '2026-07-22',
        files: { leaguepediaJson: [], oracleCsv: [], lolEsportsJson: [] },
        sources: { leaguepedia: { status: 'failed' }, oracle: { status: 'failed' } },
        warnings: ['provider unavailable'],
      })}\n`)
      return
    }
    const sourcePath = join(outDir, 'leaguepedia', 'scoreboard-games.json')
    await mkdir(join(outDir, 'leaguepedia'), { recursive: true })
    await writeFile(sourcePath, JSON.stringify({ fetchedAt: `2026-07-22T00:00:0${downloadCount}Z`, matches: [{ id: 'same', winner: 'Blue' }] }))
    await writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      start: '2026-07-21',
      end: '2026-07-22',
      files: { leaguepediaJson: [sourcePath], oracleCsv: [], lolEsportsJson: [] },
      sources: { leaguepedia: { status: 'downloaded' }, oracle: { status: 'skipped' } },
      warnings: [],
    })}\n`)
  }
  const env = {
    RANKING_REFRESH_MODE: 'gated',
    RANKING_REFRESH_RUN_ID: String(context.runId),
    RANKING_REFRESH_CAUSE: String(context.cause),
    RANKING_REFRESH_AFFECTED_IDS: JSON.stringify(context.affectedIds ?? []),
    ...(context.affectedDate ? { RANKING_REFRESH_AFFECTED_DATE: String(context.affectedDate) } : {}),
    RANKING_REFRESH_METRICS_PATH: paths.metrics,
    RANKING_REFRESH_STATE: paths.refreshState,
    RANKING_BUCKET_RESTORE_RAW: 'false',
    RANKING_BUCKET_UPLOAD_ENABLED: 'false',
  }
  const args = [
    '--raw-dir', paths.raw,
    '--manifest', paths.manifest,
    '--state', paths.refreshState,
    '--staging-dir', paths.staging,
    '--skip-crunch',
    '--end', '2026-07-22',
  ]
  await refreshDataIfChanged(args, { run: fakeRun, env })
  if (kind === 'unchanged') await refreshDataIfChanged(args, { run: fakeRun, env })
}

function refreshPaths(root: string) {
  const raw = join(root, 'raw')
  return {
    root,
    raw,
    manifest: join(raw, 'manifest.json'),
    refreshState: join(raw, 'refresh-state.json'),
    staging: join(root, 'staging'),
    metrics: join(root, 'metrics.json'),
  }
}

function argValue(args: string[], flag: string) {
  const index = args.indexOf(flag)
  assert.notEqual(index, -1)
  return args[index + 1]
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
    renewLease: async (_key: string, authority: { lease: Record<string, unknown> }) => ({
      renewed: true as const,
      lease: { ...authority.lease, expiresAt: '2026-07-22T00:45:00Z' },
      etag: 'renewed',
      promotionEtag: 'renewed',
    }),
    releaseLease: async () => ({ released: true }),
    readBucketJson: async () => ({ found: false }),
    readLocalState: async () => undefined,
    writeLocalState: async () => undefined,
    writeBucketJson: async () => ({ written: true, etag: `state-${++writes}` }),
    fetchProbe: async () => ({ checkedAt: '2026-07-22T00:00:00Z', coverageComplete: true, events: [] }),
    setInterval: () => ({ unref() {} }),
    clearInterval: () => undefined,
    logger: { log: (value: string) => logs.push(value), warn() {}, error: (value: string) => logs.push(value) },
  }
}

function metricLog(logs: string[]) {
  const line = logs.findLast((entry) => entry.startsWith('REFRESH_RUN_METRIC '))
  assert.ok(line)
  return JSON.parse(line.slice('REFRESH_RUN_METRIC '.length))
}

function finalizationLog(logs: string[]) {
  const line = logs.findLast((entry) => entry.startsWith('REFRESH_FINALIZATION_ERROR '))
  assert.ok(line)
  return JSON.parse(line.slice('REFRESH_FINALIZATION_ERROR '.length))
}

function bucketConfig() {
  return {
    enabled: true,
    bucket: 'bucket',
    endpoint: 'https://example.invalid',
    region: 'auto',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    prefix: 'rankings',
  }
}

function memoryS3() {
  const objects = new Map<string, { body: string; etag: string }>()
  let version = 0
  return {
    objects,
    async send(command: unknown) {
      const value = command as { constructor: { name: string }; input: Record<string, unknown> }
      const key = String(value.input.Key)
      if (value.constructor.name === 'GetObjectCommand') {
        const object = objects.get(key)
        if (!object) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
        return { Body: Readable.from([object.body]), ETag: object.etag, ContentLength: Buffer.byteLength(object.body) }
      }
      if (value.constructor.name === 'PutObjectCommand') {
        const current = objects.get(key)
        if (value.input.IfNoneMatch === '*' && current) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        if (value.input.IfMatch && value.input.IfMatch !== current?.etag) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        const body = await streamText(value.input.Body)
        const etag = `"${++version}"`
        objects.set(key, { body, etag })
        return { ETag: etag }
      }
      throw new Error(`Unsupported command ${value.constructor.name}`)
    },
  }
}

async function streamText(value: unknown) {
  if (typeof value === 'string') return value
  const chunks: Buffer[] = []
  for await (const chunk of value as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
