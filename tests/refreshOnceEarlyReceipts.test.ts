import assert from 'node:assert/strict'
import test from 'node:test'
import { runRefreshOnce } from '../scripts/refresh-once.mjs'

const liveEnvironment = {
  RANKING_REFRESH_MODE: 'gated',
  RANKING_ROLLOUT_EVIDENCE_ENABLED: 'true',
  RAILWAY_GIT_COMMIT_SHA: 'abc123',
  RAILWAY_DEPLOYMENT_ID: 'deployment-1',
  RAILWAY_ENVIRONMENT_ID: 'environment-1',
  RAILWAY_SERVICE_ID: 'service-1',
}

function options(published: Array<Record<string, unknown>>) {
  return {
    env: liveEnvironment,
    runId: 'early-terminal',
    now: () => new Date('2026-07-23T00:00:00Z'),
    monotonicNow: () => 0,
    rss: () => 1024,
    bucketConfig: { enabled: true },
    bucketClient: {},
    publishRolloutEvidence: async (value: Record<string, unknown>) => {
      published.push(value)
      return { status: 'uploaded' }
    },
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
