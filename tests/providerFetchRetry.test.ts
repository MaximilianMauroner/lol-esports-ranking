import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { createProviderFetchTelemetry, fetchWithRetry, parseRetryAfterMs, providerFetchTelemetryFor, snapshotProviderFetchTelemetry } from '../scripts/provider-fetch-retry.mjs'

test('provider retry honors Retry-After seconds and date with injected telemetry', async () => {
  const delays: number[] = []
  let clock = Date.parse('2026-07-23T00:00:00Z')
  let calls = 0
  const telemetry = createProviderFetchTelemetry()
  const response = await fetchWithRetry('https://provider.invalid', {}, {
    fetcher: async () => {
      calls += 1
      return calls === 1
        ? new Response('busy', { status: 429, headers: { 'retry-after': '2' } })
        : new Response('ok', { status: 200 })
    },
    now: () => clock,
    sleep: async (delay) => { delays.push(delay); clock += delay },
    random: () => 0,
    telemetry,
  })
  assert.equal(response.status, 200)
  assert.equal(providerFetchTelemetryFor(response)?.requests, 2)
  assert.deepEqual(delays, [2000])
  assert.equal(telemetry.requests, 2)
  assert.equal(telemetry.retries.length, 1)
  assert.equal(parseRetryAfterMs('Thu, 23 Jul 2026 00:00:03 GMT', Date.parse('2026-07-23T00:00:00Z')), 3000)
})

test('provider retry treats every 5xx as retryable and surfaces terminal telemetry', async () => {
  for (const status of [500, 501, 599]) {
    let calls = 0
    let terminal: { requests: number; retryCount: number } | undefined
    await assert.rejects(fetchWithRetry('https://provider.invalid', {}, {
      fetcher: async () => { calls += 1; return new Response('failed', { status }) },
      maxAttempts: 2,
      sleep: async () => undefined,
      onTerminal: (value) => { terminal = value },
    }), /exhausted retries/)
    assert.equal(calls, 2)
    assert.equal(terminal?.requests, 2)
    assert.equal(terminal?.retryCount, 1)
  }
})

test('provider retry handles network and body rate limits but not hard 4xx or aborts', async () => {
  let networkCalls = 0
  const network = await fetchWithRetry('https://provider.invalid', {}, {
    fetcher: async () => {
      networkCalls += 1
      if (networkCalls === 1) throw new TypeError('network down')
      return new Response(JSON.stringify(networkCalls === 2 ? { error: { code: 'ratelimited' } } : { ok: true }), { status: networkCalls === 2 ? 200 : 201 })
    },
    retryResponse: async (response) => (await response.json() as { error?: { code?: string } }).error?.code === 'ratelimited',
    sleep: async () => undefined,
    random: () => 0,
  })
  assert.equal(network.status, 201)
  assert.equal(networkCalls, 3)

  let hardCalls = 0
  let hardFailure: ReturnType<typeof snapshotProviderFetchTelemetry> | undefined
  const hard = await fetchWithRetry('https://provider.invalid', {}, {
    fetcher: async () => { hardCalls += 1; return new Response('no', { status: 400 }) },
    onFailure: (telemetry) => { hardFailure = telemetry },
  })
  assert.equal(hard.status, 400)
  assert.equal(hardCalls, 1)
  assert.equal(hardFailure?.attempts.at(-1)?.status, 400)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(fetchWithRetry('https://provider.invalid', { signal: controller.signal }), /abort/i)
})

test('provider retry caps attempts, backoff, and elapsed time', async () => {
  let clock = 0
  let calls = 0
  await assert.rejects(fetchWithRetry('https://provider.invalid', {}, {
    fetcher: async () => { calls += 1; throw new Error('offline') },
    maxAttempts: 10,
    maxElapsedMs: 999,
    baseDelayMs: 1000,
    maxDelayMs: 1000,
    random: () => 1,
    now: () => clock,
    sleep: async (delay) => { clock += delay },
  }), /after 1 attempt/)
  assert.equal(calls, 1)
})

test('maxElapsed aborts an in-flight provider attempt and emits failure telemetry before rejection', async () => {
  let failure: { requests: number; attempts: Array<{ reason?: string }> } | undefined
  await assert.rejects(fetchWithRetry('https://provider.invalid', {}, {
    fetcher: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }),
    maxAttempts: 3,
    maxElapsedMs: 10,
    onFailure: async (telemetry) => { failure = telemetry },
  }), /maxElapsedMs|failed after/)
  assert.equal(failure?.requests, 1)
  assert.equal(failure?.attempts.at(-1)?.reason, 'max-elapsed')
})

test('attempt deadline stays active until the response body is consumed', async () => {
  let deadline: ReturnType<typeof setTimeout> | undefined
  let cleared = false
  let finishBody: (() => void) | undefined
  const setDeadline = ((callback: () => void, delay?: number) => {
    deadline = setTimeout(callback, delay)
    return deadline
  }) as typeof setTimeout
  const response = await fetchWithRetry('https://provider.invalid', {}, {
    fetcher: async () => {
      assert.equal(deadline?.hasRef(), true)
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('ok'))
          finishBody = () => controller.close()
        },
      }), { status: 200 })
    },
    setTimeoutFn: setDeadline,
    clearTimeoutFn: (timeout) => {
      cleared = true
      clearTimeout(timeout)
    },
  })
  assert.equal(response.status, 200)
  assert.equal(cleared, false)
  finishBody?.()
  assert.equal(await response.text(), 'ok')
  assert.equal(cleared, true)
})

for (const abort of ['caller abort', 'caller timeout', 'helper deadline'] as const) {
  test(`${abort} stops a provider body that stalls after headers`, async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"ok":')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/stalled`
    const controller = new AbortController()
    const signal = abort === 'caller timeout' ? AbortSignal.timeout(500) : controller.signal
    let guard: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await fetchWithRetry(url, { signal }, {
        maxElapsedMs: abort === 'helper deadline' ? 500 : 5_000,
      })
      assert.equal(response.url, url)
      const body = response.json()
      if (abort === 'caller abort') controller.abort()
      const outcome = await Promise.race([
        body.then(() => 'body completed', (error: Error) => error.name),
        new Promise<string>((resolve) => { guard = setTimeout(() => resolve('body stayed open'), 1_500) }),
      ])
      assert.match(outcome, /^(AbortError|TimeoutError)$/)
    } finally {
      clearTimeout(guard)
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
}

test('caller abort still governs an unread provider body after the payload arrives', async () => {
  const controller = new AbortController()
  const response = await fetchWithRetry('https://provider.invalid', { signal: controller.signal }, {
    fetcher: async (_input, init) => new Response(new ReadableStream({
      start(body) {
        body.enqueue(new TextEncoder().encode('{"ok":true}'))
        body.close()
        init?.signal?.addEventListener('abort', () => body.error(init.signal?.reason), { once: true })
      },
    })),
  })
  controller.abort()
  await assert.rejects(response.json(), { name: 'AbortError' })
})

for (const cancellation of ['caller abort', 'helper deadline'] as const) {
  test(`${cancellation} rejects an inspected unread body and releases the caller listener`, async (t) => {
    const server = createServer((_request, response) => response.end('{"ok":true}'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => {
      server.closeAllConnections()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const controller = new AbortController()
    let expire: (() => void) | undefined
    const response = await fetchWithRetry(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, {
      signal: controller.signal,
    }, {
      retryResponse: async (inspection) => { assert.deepEqual(await inspection.json(), { ok: true }); return undefined },
      setTimeoutFn: ((callback: () => void, delay: number) => {
        expire = callback
        return setTimeout(callback, delay)
      }) as typeof setTimeout,
    })
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
    if (cancellation === 'caller abort') controller.abort()
    else expire!()
    const result = await response.json().then(() => 'body completed', (error: Error) => error.name)
    assert.equal(result, cancellation === 'caller abort' ? 'AbortError' : 'TimeoutError')
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  })
}

test('clones retain fetched response metadata through repeated cloning', async (t) => {
  const server = createServer((request, response) => {
    if (request.url === '/redirect') response.writeHead(302, { location: '/final' }).end()
    else response.writeHead(201, { 'x-fixture': 'retained' }).end('{"ok":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const controller = new AbortController()
  const response = await fetchWithRetry(`${base}/redirect`, { signal: controller.signal })
  const clone = response.clone()
  const secondClone = clone.clone()
  for (const copy of [response, clone, secondClone]) {
    assert.equal(copy.url, `${base}/final`)
    assert.equal(copy.redirected, true)
    assert.equal(copy.type, 'basic')
    assert.equal(copy.status, 201)
    assert.equal(copy.headers.get('x-fixture'), 'retained')
  }
  assert.deepEqual(await Promise.all([response, clone, secondClone].map((copy) => copy.json())), [
    { ok: true }, { ok: true }, { ok: true },
  ])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

for (const outcome of ['retry', 'max attempts', 'max elapsed', 'inspection error', 'terminal callback error'] as const) {
  test(`provider releases discarded bodies on ${outcome}`, async () => {
    let released = false
    let calls = 0
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('busy')) },
      cancel() { released = true },
    })
    const request = fetchWithRetry('https://provider.invalid', {}, {
      fetcher: async () => {
        calls += 1
        if (calls > 1) {
          assert.equal(released, true, 'Release the previous response before another request')
          return new Response('ok')
        }
        return new Response(body, { status: outcome === 'terminal callback error' ? 200 : 503 })
      },
      maxAttempts: outcome === 'max attempts' || outcome === 'inspection error' || outcome === 'terminal callback error' ? 1 : 2,
      maxElapsedMs: outcome === 'max elapsed' ? 10 : 5_000,
      baseDelayMs: outcome === 'max elapsed' ? 100 : 0,
      retryResponse: outcome === 'inspection error' ? () => { throw new Error('inspection failed') } : undefined,
      onTerminal: outcome === 'terminal callback error' ? () => { throw new Error('terminal callback failed') } : undefined,
      sleep: async () => { assert.equal(released, true, 'Release the response before backoff') },
    })
    if (outcome === 'retry') assert.equal(await (await request).text(), 'ok')
    else await assert.rejects(request)
    assert.equal(released, true, 'Release the response before returning a terminal failure')
  })
}

test('provider releases both branches of an inspected retry response', async () => {
  let released = false
  let calls = 0
  const response = await fetchWithRetry('https://provider.invalid', {}, {
    fetcher: async () => {
      calls += 1
      if (calls > 1) {
        assert.equal(released, true)
        return new Response('ok')
      }
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('busy')) },
        cancel() { released = true },
      }))
    },
    retryResponse: () => calls === 1,
    baseDelayMs: 0,
    sleep: async () => { assert.equal(released, true) },
  })
  assert.equal(await response.text(), 'ok')
})

test('caller timeout preserves abort semantics and attaches one persisted terminal attempt', async () => {
  let failureCalls = 0
  let persisted: ReturnType<typeof snapshotProviderFetchTelemetry> | undefined
  let caught: (Error & { telemetry?: ReturnType<typeof snapshotProviderFetchTelemetry> }) | undefined
  try {
    await fetchWithRetry('https://provider.invalid', {
      signal: AbortSignal.timeout(10),
    }, {
      fetcher: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      }),
      onFailure: async (telemetry) => {
        failureCalls += 1
        persisted = structuredClone(telemetry)
      },
    })
  } catch (error) {
    caught = error as typeof caught
  }
  assert.ok(caught)
  assert.equal(caught.name, 'TimeoutError')
  assert.equal(failureCalls, 1)
  assert.equal(persisted?.requests, 1)
  assert.equal(persisted?.attempts.length, 1)
  assert.equal(persisted?.attempts[0]?.reason, 'caller-timeout')
  assert.deepEqual(caught.telemetry, persisted)
})

test('failure persistence rejection never retries or masks the original HTTP/provider outcome', async () => {
  const persistenceError = new Error('telemetry-store-unavailable')
  let hardCalls = 0
  const hard = await fetchWithRetry('https://provider.invalid', {}, {
    fetcher: async () => {
      hardCalls += 1
      return new Response('invalid', { status: 400 })
    },
    onFailure: async () => { throw persistenceError },
  }) as Response & { telemetryPersistenceError?: Error }
  assert.equal(hard.status, 400)
  assert.equal(hardCalls, 1)
  assert.equal(hard.telemetryPersistenceError, persistenceError)

  let retryableCalls = 0
  let retryable: (Error & { status?: number; telemetryPersistenceError?: Error }) | undefined
  try {
    await fetchWithRetry('https://provider.invalid', {}, {
      fetcher: async () => {
        retryableCalls += 1
        return new Response('unavailable', { status: 503 })
      },
      maxAttempts: 1,
      onFailure: async () => { throw persistenceError },
    })
  } catch (error) {
    retryable = error as typeof retryable
  }
  assert.ok(retryable)
  assert.match(retryable.message, /exhausted retries: http-503/)
  assert.equal(retryable.status, 503)
  assert.equal(retryableCalls, 1)
  assert.equal(retryable.telemetryPersistenceError, persistenceError)

  const providerCause = new TypeError('socket-failed')
  let provider: (Error & { cause?: Error; telemetryPersistenceError?: Error }) | undefined
  try {
    await fetchWithRetry('https://provider.invalid', {}, {
      fetcher: async () => { throw providerCause },
      maxAttempts: 1,
      onFailure: async () => { throw persistenceError },
    })
  } catch (error) {
    provider = error as typeof provider
  }
  assert.ok(provider)
  assert.equal(provider.cause, providerCause)
  assert.equal(provider.telemetryPersistenceError, persistenceError)
})
