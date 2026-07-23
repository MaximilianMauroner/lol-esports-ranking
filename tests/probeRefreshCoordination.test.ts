import assert from 'node:assert/strict'
import test from 'node:test'
import { acquireProbeCoordination, releaseProbeCoordination, renewProbeCoordination, rolloutProbeKey } from '../scripts/probe-refresh-coordination.mjs'

test('probe coordination uses only its isolated key and supports exclusion, renewal, release, and monotonic takeover', async () => {
  let stored: { value: Record<string, unknown>; etag: string } | undefined
  let version = 0
  const keys: string[] = []
  const readJson = async (key: string) => { keys.push(key); return stored ? { found: true, ...stored } : { found: false } }
  const writeJson = async (key: string, value: Record<string, unknown>, options: { ifMatch?: string; ifNoneMatch?: string }) => {
    keys.push(key)
    if (options.ifNoneMatch === '*' && stored) return { written: false, conflict: true }
    if (options.ifMatch && options.ifMatch !== stored?.etag) return { written: false, conflict: true }
    stored = { value, etag: String(++version) }
    return { written: true, etag: stored.etag }
  }
  const dependencies = { config: {}, client: {}, readJson, writeJson }
  const first = await acquireProbeCoordination('safe-probe', { ...dependencies, owner: 'one', ttlMs: 1000, now: '2026-07-23T00:00:00Z' })
  assert.equal(first.acquired, true)
  assert.equal(first.authority?.fencingToken, 1)
  const excluded = await acquireProbeCoordination('safe-probe', { ...dependencies, owner: 'two', now: '2026-07-23T00:00:00.500Z' })
  assert.equal(excluded.reason, 'active-probe')
  const renewed = await renewProbeCoordination('safe-probe', first, { ...dependencies, ttlMs: 2000, now: '2026-07-23T00:00:00.500Z' })
  assert.equal(renewed.renewed, true)
  const staleRelease = await releaseProbeCoordination('safe-probe', first, { ...dependencies, now: '2026-07-23T00:00:00.600Z' })
  assert.equal(staleRelease.reason, 'stale-probe')
  const released = await releaseProbeCoordination('safe-probe', renewed, { ...dependencies, now: '2026-07-23T00:00:00.600Z' })
  assert.equal(released.released, true)
  const takeover = await acquireProbeCoordination('safe-probe', { ...dependencies, owner: 'two', now: '2026-07-23T00:00:00.700Z' })
  assert.equal(takeover.authority?.fencingToken, 2)
  assert.equal(keys.includes('active-generation.json'), false)
  assert.ok(keys.every((key) => key === 'ops/rollout-probes/safe-probe.json'))
})

test('probe CAS yields exactly one concurrent winner and validates safe ids', async () => {
  assert.equal(rolloutProbeKey('a-b_1.2'), 'ops/rollout-probes/a-b_1.2.json')
  assert.throws(() => rolloutProbeKey('../active-generation'), /Invalid rollout probe id/)
  let first = true
  const options = {
    owner: 'worker', config: {}, client: {},
    readJson: async () => ({ found: false }),
    writeJson: async () => first ? (first = false, { written: true, etag: 'winner' }) : ({ written: false, conflict: true }),
  }
  const winners = await Promise.all([acquireProbeCoordination('race', options), acquireProbeCoordination('race', options)])
  assert.equal(winners.filter((entry) => entry.acquired).length, 1)
})
