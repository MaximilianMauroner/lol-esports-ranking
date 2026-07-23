import assert from 'node:assert/strict'
import test from 'node:test'
import { runRefreshOnce } from '../scripts/refresh-once.mjs'
import { parseRolloutEvidence, publishRolloutEvidence } from '../scripts/rollout-evidence.mjs'

const liveEnvironment = {
  RANKING_REFRESH_MODE: 'gated',
  RANKING_ROLLOUT_EVIDENCE_ENABLED: 'true',
  RAILWAY_GIT_COMMIT_SHA: 'abc123',
  RAILWAY_DEPLOYMENT_ID: 'deployment-1',
  RAILWAY_ENVIRONMENT_ID: 'environment-1',
  RAILWAY_SERVICE_ID: 'service-1',
}

function options(published: Array<Record<string, unknown>>) {
  const objects = new Map<string, unknown>()
  return {
    env: liveEnvironment,
    runId: 'early-terminal',
    now: () => new Date('2026-07-23T00:00:00Z'),
    monotonicNow: () => 0,
    rss: () => 1024,
    bucketConfig: { enabled: true },
    bucketClient: {},
    publishRolloutEvidence: nativePublisher(objects, published),
    logger: { log() {}, warn() {}, error() {} },
  }
}

test('cadence rejection emits one immutable failed rollout receipt before lease acquisition', async () => {
  const published: Array<Record<string, unknown>> = []
  await assert.rejects(runRefreshOnce({
    ...options(published),
    env: { ...liveEnvironment, RANKING_REFRESH_INTERVAL_MINUTES: '5' },
  }), /authority|gate receipt/i)
  assert.equal(published.length, 1)
  assert.equal((published[0].execution as { result: string }).result, 'failed')
  assert.equal(parseRolloutEvidence(published[0]), published[0])
})

test('lease acquisition failure and skip each emit exactly one immutable terminal receipt', async () => {
  for (const terminal of ['failed', 'skipped'] as const) {
    const published: Array<Record<string, unknown>> = []
    const run = runRefreshOnce({
      ...options(published),
      acquireLease: async () => {
        if (terminal === 'failed') throw new Error('lease-store-failed')
        return { acquired: false as const, reason: 'held-by-peer' }
      },
    })
    if (terminal === 'failed') await assert.rejects(run, /lease-store-failed/)
    else assert.equal((await run).status, 'skipped')
    assert.equal(published.length, 1)
    assert.equal((published[0].execution as { result: string }).result, terminal)
  }
})

test('missing storage fails closed without claiming an immutable receipt', async () => {
  const published: Array<Record<string, unknown>> = []
  await assert.rejects(runRefreshOnce({
    ...options(published),
    bucketConfig: { enabled: false, missing: ['bucket'] },
    bucketClient: undefined,
  }), /Bucket configuration is required/)
  assert.deepEqual(published, [])
})

test('invalid lease TTL emits failed evidence through the native immutable publisher', async () => {
  const published: Array<Record<string, unknown>> = []
  await assert.rejects(runRefreshOnce({
    ...options(published),
    env: {
      ...liveEnvironment,
      RANKING_REFRESH_LEASE_TTL_MS: '120000',
      RANKING_REFRESH_JOB_TIMEOUT_MS: '120000',
    },
  }), /lease TTL/)
  assert.equal(published.length, 1)
  assert.equal((published[0].execution as { result: string }).result, 'failed')
})

test('native rollout publisher creates, reuses, and rejects conflicting complete receipts', async () => {
  const published: Array<Record<string, unknown>> = []
  const objects = new Map<string, unknown>()
  const publish = nativePublisher(objects, published)
  await assert.rejects(runRefreshOnce({
    ...options(published),
    publishRolloutEvidence: publish,
    acquireLease: async () => { throw new Error('lease-store-failed') },
  }), /lease-store-failed/)
  const receipt = published[0]
  assert.equal(parseRolloutEvidence(receipt), receipt)
  const reused = await publish(receipt)
  assert.equal(reused.status, 'unchanged')
  const incomplete = { ...receipt }
  delete incomplete.work
  assert.throws(() => parseRolloutEvidence(incomplete), /missing work/)
  const conflict = structuredClone(receipt)
  ;(conflict.error as { message: string }).message = 'different-terminal-error'
  await assert.rejects(publish(conflict), /Conflicting immutable rollout evidence/)
})

test('publication failure is observable and never changes the terminal outcome into receipt success', async () => {
  const warnings: string[] = []
  const result = await runRefreshOnce({
    ...options([]),
    acquireLease: async () => ({ acquired: false as const, reason: 'held-by-peer' }),
    publishRolloutEvidence: async () => { throw new Error('receipt-store-unavailable') },
    logger: { log() {}, warn: (value: string) => warnings.push(value), error() {} },
  })
  assert.equal(result.status, 'skipped')
  assert.match(warnings.join('\n'), /publication failed.*receipt-store-unavailable/i)
})

function nativePublisher(objects: Map<string, unknown>, published: Array<Record<string, unknown>>) {
  return async (value: Record<string, unknown>) => publishRolloutEvidence(value, {
    config: {},
    client: {},
    writeJson: async (key: string, body: unknown) => {
      if (objects.has(key)) return { written: false, conflict: true }
      objects.set(key, structuredClone(body))
      published.push(body as Record<string, unknown>)
      return { written: true, etag: `etag-${objects.size}` }
    },
    readJson: async (key: string) => objects.has(key)
      ? { found: true, value: structuredClone(objects.get(key)) }
      : { found: false },
  })
}
