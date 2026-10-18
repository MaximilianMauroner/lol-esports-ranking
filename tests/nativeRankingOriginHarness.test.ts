import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fixtureEnvironment } from './nativeRankingOriginProcesses.ts'
import { maliciousUpstream } from './nativeRankingOriginUpstream.ts'

test('origin process environment contains only explicit fixture configuration', () => {
  const environment = fixtureEnvironment({ RANKING_ORIGIN_ENDPOINT: 'http://127.0.0.1:1' })
  assert.deepEqual(Object.keys(environment).sort(), ['LANG', 'PATH', 'RANKING_ORIGIN_ENDPOINT', 'TZ'])
  assert.equal(environment.RANKING_ORIGIN_ENDPOINT, 'http://127.0.0.1:1')
})

test('redirect canary independently detects followed redirects and leaves manual redirects unread', { timeout: 5_000 }, async () => {
  const canary = await maliciousUpstream({ kind: 'bytes', status: 200, body: Buffer.from('canary') })
  const upstream = await maliciousUpstream({ kind: 'redirect', status: 307, location: `${canary.endpoint}/sink` })
  try {
    const manual = await fetch(upstream.endpoint, { redirect: 'manual', signal: AbortSignal.timeout(1_000) })
    assert.equal(manual.status, 307)
    await manual.body?.cancel()
    assert.equal(canary.requests.length, 0)
    const followed = await fetch(upstream.endpoint, { redirect: 'follow', signal: AbortSignal.timeout(1_000) })
    assert.equal(await followed.text(), 'canary')
    assert.deepEqual(canary.requests.map(request => request.path), ['/sink'])
  } finally {
    await upstream.close()
    await canary.close()
  }
  assert.equal(upstream.observe().openSockets, 0)
  assert.equal(canary.observe().openSockets, 0)
})

test('hostile stream exposes status before its body and records socket cancellation without secrets', { timeout: 5_000 }, async () => {
  const upstream = await maliciousUpstream({ kind: 'stream', status: 403, intervalMs: 10 })
  try {
    const response = await fetch(`${upstream.endpoint}/private?sentinel-secret`, {
      headers: { Authorization: 'sentinel-auth', 'x-amz-security-token': 'sentinel-token' },
      signal: AbortSignal.timeout(1_000),
    })
    assert.equal(response.status, 403)
    await response.body?.cancel()
    const deadline = Date.now() + 1_000
    while (upstream.observe().timers > 0 && Date.now() < deadline) await delay(10)
    assert.equal(upstream.observe().timers, 0)
    assert.ok(upstream.observe().closedSockets >= 1)
    assert.deepEqual(upstream.requests, [{ method: 'GET', path: '/private', signed: true, sessionToken: true }])
    assert.doesNotMatch(JSON.stringify(upstream.requests), /sentinel/)
  } finally { await upstream.close() }
  assert.equal(upstream.observe().openSockets, 0)
})

test('hostile fixture cleanup closes a stalled request and all owned sockets', { timeout: 5_000 }, async () => {
  const upstream = await maliciousUpstream({ kind: 'stall' })
  const response = fetch(upstream.endpoint, { signal: AbortSignal.timeout(2_000) })
  const rejected = assert.rejects(response)
  try {
    const deadline = Date.now() + 1_000
    while (upstream.requests.length === 0 && Date.now() < deadline) await delay(10)
    assert.equal(upstream.requests.length, 1)
  } finally { await upstream.close() }
  await rejected
  assert.deepEqual(upstream.observe(), { openSockets: 0, closedSockets: 1, timers: 0 })
})
