import assert from 'node:assert/strict'
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
