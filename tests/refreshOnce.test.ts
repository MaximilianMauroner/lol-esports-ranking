import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Readable } from 'node:stream'
import { defaultRunChild, isDailyAuditDue, publishRefreshRolloutEvidence, runChildProcess, runRefreshOnce, startLeaseHeartbeat } from '../scripts/refresh-once.mjs'
import { completeRefreshMetrics, createRefreshMetrics, readRefreshMetrics, writeRefreshMetrics } from '../scripts/refresh-metrics.mjs'
import type { RefreshRunMetrics } from '../scripts/refresh-metrics.mjs'

type RefreshDataIfChanged = (args?: string[], options?: Record<string, unknown>) => Promise<Record<string, unknown>>
const refreshDataScriptPath: string = '../scripts/refresh-data-if-changed.mjs'
const { refreshDataIfChanged } = await import(refreshDataScriptPath) as unknown as { refreshDataIfChanged: RefreshDataIfChanged }

test('production publication hook emits strict immutable evidence when explicitly enabled', async () => {
  let published: Record<string, unknown> | undefined
  const result = await publishRefreshRolloutEvidence({
    schemaVersion: 2,
    runId: 'production-run',
    result: 'completed',
    startedAt: '2026-07-23T00:00:00Z',
    finishedAt: '2026-07-23T00:00:01Z',
    durationMs: 1000,
    mode: 'shadow',
    cause: 'pending-match',
    peakRssBytes: 3,
    resources: {
      cpuSeconds: 1,
      memoryGbSeconds: 2,
      peakRssBytes: 3,
      processes: [{ processKey: 'fixture:refresh', sampleCount: 2, cpuSeconds: 1, memoryGbSeconds: 2, peakRssBytes: 3 }],
    },
    work: {
      providerRequests: 1, providerRetries: 0, broadFetches: 1, fullBuilds: 1,
      incrementalBuilds: 0, bytesRead: 1, bytesWritten: 1, objectsRead: 1,
      objectsWritten: 1, uploads: 1,
    },
    freshness: { providerAvailableAt: null, detectedAt: null, publishedAt: '2026-07-23T00:00:01Z' },
    checkpoint: { applicable: true },
    affected: { matchIds: ['fixture-match'] },
    coordination: { owner: 'fixture-owner', fencingToken: 1, etag: 'fixture-etag' },
    stages: [
      { name: 'classification', durationMs: 0, input: {}, result: 'completed', output: { classification: 'latest-append', addedCount: 1, changedCount: 0, removedCount: 0 } },
      { name: 'semantic-parity', durationMs: 0, input: {}, result: 'completed', output: { parity: true, stateParity: true, checkpointParity: true } },
      { name: 'crunch', durationMs: 0, input: {}, result: 'completed', output: { fullSnapshotWritten: true } },
      { name: 'promotion', durationMs: 0, input: {}, result: 'completed', output: { generationId: 'generation-1', promotedAt: '2026-07-23T00:00:01Z' } },
    ],
  }, {
    env: {
      RANKING_ROLLOUT_EVIDENCE_ENABLED: 'true',
      RAILWAY_GIT_COMMIT_SHA: 'abc123',
      RAILWAY_DEPLOYMENT_ID: 'deployment-1',
      RAILWAY_ENVIRONMENT_ID: 'environment-1',
      RAILWAY_SERVICE_ID: 'service-1',
    },
    now: '2026-07-23T00:00:01Z',
    config: {},
    client: {},
    evidenceClass: 'production-like-fixture',
    publish: async (value: Record<string, unknown>) => {
      published = value
      return { status: 'uploaded' }
    },
  })
  assert.equal(result.status, 'uploaded')
  assert.equal(published?.artifactKind, 'ranking-rollout-run-evidence')
  assert.equal(published?.evidenceClass, 'production-like-fixture')
})

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

test('startup enforces five-minute gate receipts and lease timing', async () => {
  await assert.rejects(() => runRefreshOnce({
    env: { RANKING_REFRESH_INTERVAL_MINUTES: '5' },
  }), /immutable outer authority/)
  await assert.rejects(() => runRefreshOnce({
    env: { RANKING_REFRESH_MODE: 'gated', RANKING_REFRESH_INTERVAL_MINUTES: '5' },
  }), /immutable outer authority/)
  await assert.rejects(() => runRefreshOnce({
    env: { RANKING_REFRESH_MODE: 'gated', RANKING_REFRESH_LEASE_TTL_MS: '60000', RANKING_REFRESH_JOB_TIMEOUT_MS: '60000' },
  }), /lease TTL/)
})

test('daily audit defaults off, is due from last success, and bypasses unchanged probe work without advancing on failure', async () => {
  assert.equal(isDailyAuditDue({}, {}, '2026-07-23T00:00:00Z'), false)
  assert.equal(isDailyAuditDue({ RANKING_DAILY_AUDIT_ENABLED: 'true' }, {}, '2026-07-23T00:00:00Z'), true)
  assert.equal(isDailyAuditDue({ RANKING_DAILY_AUDIT_ENABLED: 'true' }, { lastSuccessfulDailyAuditAt: '2026-07-22T12:00:00Z' }, '2026-07-23T00:00:00Z'), false)
  let childRuns = 0
  const result = await runRefreshOnce({
    ...baseOptions([]),
    env: { RANKING_REFRESH_MODE: 'gated', RANKING_DAILY_AUDIT_ENABLED: 'true' },
    runChild: async () => { childRuns += 1 },
    readJson: async () => ({ matches: [] }),
  })
  assert.equal(childRuns, 1)
  assert.equal(result.metrics?.cause, 'daily-audit')
  assert.equal((result.state as { lastSuccessfulDailyAuditAt?: string } | undefined)?.lastSuccessfulDailyAuditAt, undefined)
})

test('daily audit success timestamp requires clean parity, promotion, and full-audit receipt', async () => {
  for (const auditCase of [
    { name: 'clean', semantic: true, state: true, checkpoint: true, expected: true },
    { name: 'semantic-mismatch', semantic: false, state: false, checkpoint: false, expected: false },
    { name: 'earlier-checkpoint-mismatch', semantic: true, state: false, checkpoint: false, expected: false },
  ]) {
    const root = await mkdtemp(join(tmpdir(), `daily-audit-${auditCase.name}-`))
    const metricsPath = join(root, 'metrics.json')
    try {
      const result = await runRefreshOnce({
        ...baseOptions([]),
        runId: `audit-${auditCase.name}`,
        env: {
          RANKING_REFRESH_MODE: 'gated',
          RANKING_DAILY_AUDIT_ENABLED: 'true',
          RANKING_REFRESH_METRICS_PATH: metricsPath,
        },
        runChildProcess: async (_command: string, _args: string[], _timeoutMs: number, childEnv: NodeJS.ProcessEnv) => {
          assert.equal(childEnv.RANKING_INCREMENTAL_ENABLED, undefined)
          assert.equal(childEnv.RANKING_REFRESH_MODE, 'gated')
          assert.equal(childEnv.RANKING_REFRESH_FENCING_TOKEN, '1')
          const child = createRefreshMetrics({ runId: `audit-${auditCase.name}`, mode: 'gated', cause: 'daily-audit' })
          child.recordStage('semantic-parity', {
            result: auditCase.semantic && auditCase.state && auditCase.checkpoint ? 'completed' : 'failed',
            output: {
              parity: auditCase.semantic,
              stateParity: auditCase.state,
              checkpointParity: auditCase.checkpoint,
            },
          })
          child.recordStage('promotion', { result: 'completed', output: { promotedAt: '2026-07-22T00:00:00Z' } })
          child.recordStage('full-audit-receipt', { result: 'completed' })
          await writeRefreshMetrics(metricsPath, {
            ...completeRefreshMetrics(child.snapshot({ result: 'completed' })),
            coordination: { owner: 'worker', fencingToken: 1, etag: `promoted-${auditCase.name}` },
          })
        },
        readJson: async () => ({ matches: [] }),
      })
      const state = result.state as { lastSuccessfulDailyAuditAt?: string }
      assert.equal(Boolean(state.lastSuccessfulDailyAuditAt), auditCase.expected)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('default gated child env enables canonical fenced ingestion for every scored cause without a legacy flag', async () => {
  const childEnvironments: NodeJS.ProcessEnv[] = []
  const runProcess = async (_command: string, _args: string[], _timeoutMs: number, childEnv: NodeJS.ProcessEnv) => {
    childEnvironments.push(childEnv)
  }
  const base = {
    reconciliationPath: '/tmp/reconciliation.json',
    metricsPath: '/tmp/metrics.json',
    leaseKey: 'ops/refresh-lease.json',
    owner: 'worker',
    fencingToken: 1,
    promotionEtag: 'promotion',
    affectedIds: [],
  }
  for (const cause of ['pending-match', 'retry', 'manual-force', 'daily-audit'] as const) {
    await defaultRunChild({
      ...base,
      runId: `${cause}-child`,
      env: {
        RANKING_REFRESH_MODE: 'gated',
        ...(cause === 'manual-force' ? { RANKING_FORCE_REFRESH: 'true' } : {}),
      },
      cause,
    }, { runProcess })
  }
  await defaultRunChild({
    ...base,
    runId: 'shadow-child',
    env: {
      RANKING_REFRESH_MODE: 'shadow',
      RANKING_INCREMENTAL_SHADOW_ENABLED: 'true',
    },
    cause: 'daily-audit',
  }, { runProcess })
  assert.equal(childEnvironments.length, 5)
  for (const childEnv of childEnvironments.slice(0, 4)) {
    assert.equal(childEnv.RANKING_REFRESH_MODE, 'gated')
    assert.equal(childEnv.RANKING_REFRESH_FENCING_TOKEN, '1')
    assert.equal(childEnv.RANKING_REFRESH_LEASE_KEY, 'ops/refresh-lease.json')
    assert.equal(childEnv.RANKING_REFRESH_LEASE_OWNER, 'worker')
    assert.equal(childEnv.RANKING_REFRESH_PROMOTION_ETAG, 'promotion')
    assert.equal(childEnv.RANKING_INCREMENTAL_ENABLED, undefined)
  }
  assert.equal(childEnvironments[0].RANKING_FORCE_REFRESH, undefined)
  assert.equal(childEnvironments[1].RANKING_FORCE_REFRESH, undefined)
  assert.equal(childEnvironments[2].RANKING_FORCE_REFRESH, 'true')
  assert.equal(childEnvironments[3].RANKING_FORCE_REFRESH, 'true')
  assert.equal(childEnvironments[4].RANKING_INCREMENTAL_SHADOW_ENABLED, 'true')
  assert.equal(childEnvironments[4].RANKING_INCREMENTAL_ENABLED, undefined)
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

test('gated probe failure persists one canonical record without a publish receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refresh-probe-error-canonical-'))
  const paths = refreshPaths(root)
  const client = memoryS3()
  const logs: string[] = []
  let caught: Error & { refreshMetrics?: RefreshRunMetrics } | undefined
  const options = realParentOptions(paths, client, logs)
  const scheduleError = Object.assign(new Error('schedule-provider-unavailable'), {
    telemetry: {
      requests: 2,
      retryCount: 1,
      retries: [{ attempt: 1, delayMs: 1, reason: 'network-error' }],
      attempts: [],
    },
  })
  try {
    await runRefreshOnce({
      ...options,
      env: { ...options.env, RANKING_TRIGGER_STATE: paths.triggerState },
      runId: 'probe-error-canonical',
      fetchProbe: async () => { throw scheduleError },
      writeLocalState: async (path: string, value: unknown) => {
        await mkdir(paths.raw, { recursive: true })
        await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
      },
    })
  } catch (error) {
    caught = error as Error & { refreshMetrics?: RefreshRunMetrics }
  }
  try {
    assert.ok(caught)
    assert.equal(caught.message, 'schedule-provider-unavailable')
    const metricsFile = JSON.parse(await readFile(paths.metrics, 'utf8'))
    const localTriggerState = JSON.parse(await readFile(paths.triggerState, 'utf8'))
    const localRefreshState = JSON.parse(await readFile(paths.refreshState, 'utf8'))
    const triggerState = JSON.parse(client.objects.get('rankings/raw/refresh-trigger-state.json')!.body)
    const remoteRefreshState = JSON.parse(client.objects.get('rankings/raw/refresh-state.json')!.body)
    assert.deepEqual(caught.refreshMetrics, metricsFile)
    assert.deepEqual(caught.refreshMetrics, localTriggerState.lastRun)
    assert.deepEqual(caught.refreshMetrics, localRefreshState.lastRun)
    assert.deepEqual(caught.refreshMetrics, triggerState.lastRun)
    assert.deepEqual(caught.refreshMetrics, remoteRefreshState.lastRun)
    assert.deepEqual(caught.refreshMetrics, metricLog(logs))
    assert.equal(caught.refreshMetrics?.result, 'failed')
    assert.equal(caught.refreshMetrics?.error, 'schedule-provider-unavailable')
    assert.equal(caught.refreshMetrics?.work?.providerRequests, 2)
    assert.equal(caught.refreshMetrics?.work?.providerRetries, 1)
    assert.deepEqual(caught.refreshMetrics?.stages.find((stage) => stage.name === 'probe')?.output, {
      providerRequests: 2,
      providerRetries: 1,
    })
    assert.equal(client.objects.has('rankings/latest-publish.json'), false)
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
    assert.deepEqual(outcome.result.metrics, outcome.remoteRefreshState.lastRun)
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

test('child telemetry error remains primary when the subprocess wrapper is generic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refresh-child-process-error-'))
  const paths = refreshPaths(root)
  const client = memoryS3()
  const logs: string[] = []
  let caught: Error & { refreshMetrics?: RefreshRunMetrics } | undefined
  try {
    await runRefreshOnce({
      ...realParentOptions(paths, client, logs),
      runId: 'child-process-error',
      runChild: async () => {
        const seed = await readRefreshMetrics(paths.metrics)
        assert.ok(seed)
        await writeRefreshMetrics(paths.metrics, {
          ...seed,
          finishedAt: '2026-07-22T00:00:31.000Z',
          result: 'failed',
          error: 'Leaguepedia provider request failed',
        })
        throw new Error('Refresh job exited with 1')
      },
    })
  } catch (error) {
    caught = error as Error & { refreshMetrics?: RefreshRunMetrics }
  }
  try {
    assert.ok(caught)
    assert.equal(caught.message, 'Leaguepedia provider request failed')
    assert.equal((caught.cause as Error).message, 'Refresh job exited with 1')
    assert.equal(caught.refreshMetrics?.error, 'Leaguepedia provider request failed')
    assert.equal(caught.refreshMetrics?.processError, 'Refresh job exited with 1')
    const refreshState = JSON.parse(await readFile(paths.refreshState, 'utf8'))
    const metricsFile = JSON.parse(await readFile(paths.metrics, 'utf8'))
    const triggerState = JSON.parse(client.objects.get('rankings/raw/refresh-trigger-state.json')!.body)
    const remoteRefreshState = JSON.parse(client.objects.get('rankings/raw/refresh-state.json')!.body)
    assert.deepEqual(caught.refreshMetrics, refreshState.lastRun)
    assert.deepEqual(caught.refreshMetrics, remoteRefreshState.lastRun)
    assert.deepEqual(caught.refreshMetrics, metricsFile)
    assert.deepEqual(caught.refreshMetrics, triggerState.lastRun)
    assert.deepEqual(caught.refreshMetrics, metricLog(logs))
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
    ...(terminal === 'stale-source'
      ? { readJson: async () => { throw new Error('stale-source must not read reconciliation') } }
      : {}),
  }) as ParentResult
  return {
    result,
    client,
    logs,
    refreshState: JSON.parse(await readFile(paths.refreshState, 'utf8')),
    metricsFile: JSON.parse(await readFile(paths.metrics, 'utf8')),
    triggerState: JSON.parse(client.objects.get('rankings/raw/refresh-trigger-state.json')!.body),
    remoteRefreshState: JSON.parse(client.objects.get('rankings/raw/refresh-state.json')!.body),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

function realParentOptions(paths: RefreshTestPaths, client: ReturnType<typeof memoryS3>, logs: string[]) {
  return {
    env: {
      RANKING_REFRESH_MODE: 'gated',
      RANKING_REFRESH_METRICS_PATH: paths.metrics,
      RANKING_REFRESH_STATE: paths.refreshState,
      RANKING_RECONCILIATION_OUTPUT: paths.reconciliation,
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
    triggerState: join(raw, 'refresh-trigger-state.json'),
    refreshState: join(raw, 'refresh-state.json'),
    staging: join(root, 'staging'),
    metrics: join(root, 'metrics.json'),
    reconciliation: join(raw, 'reconciliation.json'),
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
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  const chunks: Buffer[] = []
  for await (const chunk of value as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
