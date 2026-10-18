import assert from 'node:assert/strict'
import test from 'node:test'
import { Agent, createServer, get } from 'node:http'
import { once } from 'node:events'
import { channel } from 'node:diagnostics_channel'
import { setTimeout as delay } from 'node:timers/promises'
import { fixtureEnvironment, observeHttpTransport, sdkErrorDiagnostic } from './nativeRankingOriginProcesses.ts'
import { maliciousUpstream } from './nativeRankingOriginUpstream.ts'

test('origin process environment contains only explicit fixture configuration', () => {
  const environment = fixtureEnvironment({ RANKING_ORIGIN_ENDPOINT: 'http://127.0.0.1:1' })
  assert.deepEqual(Object.keys(environment).sort(), ['LANG', 'PATH', 'RANKING_ORIGIN_ENDPOINT', 'TZ'])
  assert.equal(environment.RANKING_ORIGIN_ENDPOINT, 'http://127.0.0.1:1')
})

test('SDK diagnostics distinguish response status from retry-only metadata without exposing request secrets', () => {
  const secret = 'sentinel-secret'
  const error = Object.assign(new TypeError(`Authorization: ${secret}`), {
    name: 'TypeError', code: 'ERR_STREAM_PREMATURE_CLOSE',
    cause: Object.assign(new Error(secret), { code: 'ECONNRESET' }),
    $metadata: { attempts: 1, totalRetryDelay: 0, requestId: secret },
    request: { url: `http://user:${secret}@127.0.0.1/?X-Amz-Signature=${secret}` },
  })
  Object.defineProperty(error, '$response', { value: {
    statusCode: 403, headers: { Authorization: secret }, body: secret,
  } })
  assert.deepEqual(sdkErrorDiagnostic(error), {
    class: 'TypeError', name: 'TypeError', code: 'ERR_STREAM_PREMATURE_CLOSE', causeCode: 'ECONNRESET',
    $metadata: { httpStatusCode: null, attempts: 1, totalRetryDelay: 0 },
    $response: { statusCode: 403 },
  })
  assert.doesNotMatch(JSON.stringify(sdkErrorDiagnostic(error)), /sentinel|Authorization|Signature/)
  assert.equal(sdkErrorDiagnostic(Object.assign(new Error(), {
    name: 'AccessDenied', $metadata: { httpStatusCode: 403 },
  })).$metadata.httpStatusCode, 403)
})

test('SDK diagnostics omit unsafe or unbounded scalar values', () => {
  const diagnostic = sdkErrorDiagnostic({
    name: 'sentinel\nAuthorization: secret', code: 'a'.repeat(81),
    cause: { code: 'https://user:secret@host/?signature=secret' },
    $metadata: { httpStatusCode: '403', attempts: Infinity, totalRetryDelay: { secret: true } },
    $response: { statusCode: NaN },
  })
  assert.deepEqual(diagnostic, {
    class: null, name: null, code: null, causeCode: null,
    $metadata: { httpStatusCode: null, attempts: null, totalRetryDelay: null },
    $response: { statusCode: null },
  })
  assert.doesNotThrow(() => sdkErrorDiagnostic(null))
})

test('transport observation preserves response bytes and records reuse and close without request secrets', { timeout: 5_000 }, async () => {
  const secret = 'sentinel-secret'
  const upstream = await maliciousUpstream({ kind: 'bytes', status: 403,
    headers: { Connection: 'keep-alive', 'x-private': secret }, body: Buffer.from(secret) })
  const agent = new Agent({ keepAlive: true })
  const subscription = channel('http.client.request.created').hasSubscribers
  const transport = observeHttpTransport()
  function read() {
    return new Promise<Buffer>((resolve, reject) => {
      get(`${upstream.endpoint}/${secret}?signature=${secret}`, {
        agent, headers: { Authorization: secret },
      }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.once('end', () => resolve(Buffer.concat(chunks)))
        response.once('error', reject)
      }).once('error', reject)
    })
  }
  try {
    assert.equal((await read()).toString(), secret)
    for (let i = 0; i < 2; i += 1) {
      assert.equal((await transport.run('denied-read', read)).toString(), secret)
    }
    const sockets = Object.values(agent.freeSockets).flatMap(value => value ?? [])
    const closed = Promise.all(sockets.map(socket => once(socket, 'close')))
    agent.destroy()
    await closed
  } finally {
    agent.destroy()
    await upstream.close()
    transport.close()
  }
  const { events, dropped } = transport.snapshot()
  const assignments = events.filter(event => event.event === 'request-socket')
  assert.equal(assignments.length, 2)
  assert.ok(assignments.every(event => event.reusedSocket))
  assert.equal(assignments[0].socketId, assignments[1].socketId)
  assert.deepEqual(events.filter(event => event.event === 'response').map(event => [event.statusCode, event.connection]),
    [[403, 'keep-alive'], [403, 'keep-alive']])
  assert.ok(events.some(event => event.event === 'socket-close'))
  assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1))
  assert.ok(events.every(event => event.elapsedMs >= 0))
  assert.equal(dropped, 0)
  assert.doesNotMatch(JSON.stringify(events), /sentinel|Authorization|signature|x-private/)
  assert.equal(channel('http.client.request.created').hasSubscribers, subscription)
})

test('transport observation distinguishes a fresh pre-response reset from a reused pre-response reset', { timeout: 5_000 }, async () => {
  let reset = true
  const server = createServer((request, response) => {
    if (reset) request.socket.destroy()
    else response.end('unchanged')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const agent = new Agent({ keepAlive: true })
  const transport = observeHttpTransport()
  function read() {
    return new Promise<void>((resolve, reject) => {
      get({ hostname: '127.0.0.1', port: address.port, agent }, response => {
        response.resume()
        response.once('end', resolve)
        response.once('error', reject)
      }).once('error', reject)
    })
  }
  try {
    await assert.rejects(() => transport.run('fresh-reset', read), { code: 'ECONNRESET' })
    reset = false
    await transport.run('good-read', read)
    reset = true
    await assert.rejects(() => transport.run('reused-reset', read), { code: 'ECONNRESET' })
  } finally {
    agent.destroy()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    transport.close()
  }
  const { events } = transport.snapshot()
  assert.deepEqual(events.filter(event => event.event === 'request-socket').map(event => event.reusedSocket), [false, false, true])
  assert.deepEqual(events.filter(event => event.event === 'request-error').map(event => event.code), ['ECONNRESET', 'ECONNRESET'])
  assert.deepEqual(events.filter(event => event.event === 'response').map(event => event.operation), ['good-read'])
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
