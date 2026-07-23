const RESPONSE_TELEMETRY = new WeakMap()

export class ProviderFetchError extends Error {
  constructor(message, { cause, telemetry } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'ProviderFetchError'
    this.telemetry = telemetry
  }
}

/**
 * Retries one provider request. Callers must keep broad/paginated fetch loops
 * outside this helper so a failed page cannot duplicate already completed work.
 */
export async function fetchWithRetry(input, init = {}, options = {}) {
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)))
  const random = options.random ?? Math.random
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
  const maxAttempts = positiveInteger(options.maxAttempts, 5)
  const maxElapsedMs = nonNegativeNumber(options.maxElapsedMs, 120_000)
  const baseDelayMs = nonNegativeNumber(options.baseDelayMs, 500)
  const maxDelayMs = nonNegativeNumber(options.maxDelayMs, 30_000)
  const telemetry = options.telemetry ?? createProviderFetchTelemetry()
  const startedAt = now()
  let lastError
  let failureNotified = false
  const notifyFailure = async (terminal) => {
    if (failureNotified) return
    failureNotified = true
    await options.onFailure?.(terminal)
  }
  const notifyFailureSafely = async (terminal, outcome) => {
    try {
      await notifyFailure(terminal)
    } catch (persistenceError) {
      attachTelemetryPersistenceError(outcome, persistenceError)
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (init.signal?.aborted) {
      const terminal = snapshotProviderFetchTelemetry(telemetry, now() - startedAt)
      const reason = attachTelemetry(init.signal.reason ?? abortError(), terminal)
      await notifyFailureSafely(terminal, reason)
      throw reason
    }
    const remainingMs = maxElapsedMs - (now() - startedAt)
    if (remainingMs <= 0) break
    telemetry.requests += 1
    const attemptStartedAt = now()
    const attemptController = new AbortController()
    let deadlineExpired = false
    const forwardAbort = () => attemptController.abort(init.signal?.reason ?? abortError())
    init.signal?.addEventListener('abort', forwardAbort, { once: true })
    const attemptTimeout = setTimeoutFn(() => {
      deadlineExpired = true
      attemptController.abort(new DOMException('Provider request exceeded maxElapsedMs', 'TimeoutError'))
    }, Math.max(1, remainingMs))
    try {
      let response
      let bodyRetryReason
      try {
        response = await fetcher(input, { ...init, signal: attemptController.signal })
        bodyRetryReason = await options.retryResponse?.(response.clone?.() ?? response)
      } finally {
        try {
          clearTimeoutFn(attemptTimeout)
        } finally {
          init.signal?.removeEventListener('abort', forwardAbort)
        }
      }
      const retryReason = bodyRetryReason
        ? String(bodyRetryReason === true ? 'provider-rate-limited-body' : bodyRetryReason)
        : isRetryableStatus(response.status) ? `http-${response.status}` : undefined
      telemetry.attempts.push({
        attempt,
        startedAtMs: attemptStartedAt,
        finishedAtMs: now(),
        status: response.status,
        retryable: Boolean(retryReason),
        ...(retryReason ? { reason: retryReason } : {}),
      })
      if (!retryReason) {
        const terminal = snapshotProviderFetchTelemetry(telemetry, now() - startedAt)
        RESPONSE_TELEMETRY.set(response, terminal)
        if (!response.ok) await notifyFailureSafely(terminal, response)
        await options.onTerminal?.(terminal)
        return response
      }
      lastError = new ProviderFetchError(`Retryable provider response: ${retryReason}`)
      if (attempt >= maxAttempts) {
        const error = terminalResponseError(response, retryReason, telemetry, now() - startedAt)
        await notifyFailureSafely(error.telemetry, error)
        throw error
      }
      const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after'), now())
      const delayMs = retryDelayMs({ attempt, baseDelayMs, maxDelayMs, retryAfterMs, random })
      if (!canRetry({ now, startedAt, maxElapsedMs, delayMs })) {
        const error = terminalResponseError(response, retryReason, telemetry, now() - startedAt)
        await notifyFailureSafely(error.telemetry, error)
        throw error
      }
      recordRetry(telemetry, { attempt, delayMs, reason: retryReason, retryAfterMs })
      options.onRetry?.(telemetry.retries.at(-1), telemetry)
      await sleep(delayMs)
    } catch (error) {
      if (init.signal?.aborted) {
        const reason = init.signal.reason ?? error
        if (!telemetry.attempts.some((entry) => entry.attempt === attempt)) {
          telemetry.attempts.push({
            attempt,
            startedAtMs: attemptStartedAt,
            finishedAtMs: now(),
            status: null,
            retryable: false,
            reason: reason?.name === 'TimeoutError' ? 'caller-timeout' : 'caller-abort',
            error: errorMessage(reason),
          })
        }
        const terminal = snapshotProviderFetchTelemetry(telemetry, now() - startedAt)
        attachTelemetry(reason, terminal)
        await notifyFailureSafely(terminal, reason)
        throw reason
      }
      if (error instanceof ProviderFetchError && Number.isInteger(error.status)) {
        await options.onTerminal?.(error.telemetry)
        throw error
      }
      lastError = error
      telemetry.attempts.push({
        attempt,
        startedAtMs: attemptStartedAt,
        finishedAtMs: now(),
        status: null,
        retryable: true,
        reason: deadlineExpired ? 'max-elapsed' : 'network-error',
        error: errorMessage(error),
      })
      if (deadlineExpired || attempt >= maxAttempts) break
      const delayMs = retryDelayMs({ attempt, baseDelayMs, maxDelayMs, random })
      if (!canRetry({ now, startedAt, maxElapsedMs, delayMs })) break
      recordRetry(telemetry, { attempt, delayMs, reason: 'network-error' })
      options.onRetry?.(telemetry.retries.at(-1), telemetry)
      await sleep(delayMs)
    }
  }

  const terminal = snapshotProviderFetchTelemetry(telemetry, now() - startedAt)
  const terminalError = new ProviderFetchError(`Provider request failed after ${telemetry.requests} attempt(s): ${errorMessage(lastError)}`, {
    cause: lastError,
    telemetry: terminal,
  })
  await options.onTerminal?.(terminal)
  await notifyFailureSafely(terminal, terminalError)
  throw terminalError
}

export const providerFetchWithRetry = fetchWithRetry

export function createProviderFetchTelemetry() {
  return { requests: 0, retries: [], attempts: [] }
}

export function snapshotProviderFetchTelemetry(telemetry, elapsedMs) {
  return {
    requests: Number(telemetry?.requests) || 0,
    retryCount: Array.isArray(telemetry?.retries) ? telemetry.retries.length : 0,
    retries: [...(telemetry?.retries ?? [])],
    attempts: [...(telemetry?.attempts ?? [])],
    ...(Number.isFinite(elapsedMs) ? { elapsedMs: Math.max(0, elapsedMs) } : {}),
  }
}

export function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const dateMs = Date.parse(value)
  if (!Number.isFinite(dateMs)) return undefined
  return Math.max(0, dateMs - nowMs)
}

export function retryDelayMs({ attempt, baseDelayMs = 500, maxDelayMs = 30_000, retryAfterMs, random = Math.random }) {
  const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)))
  const jitter = 0.5 + Math.min(1, Math.max(0, random()))
  const backoff = Math.min(maxDelayMs, Math.round(exponential * jitter))
  return Math.max(backoff, Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0)
}

export function providerFetchTelemetryFor(response) { return RESPONSE_TELEMETRY.get(response) }

function isRetryableStatus(status) { return status === 429 || (status >= 500 && status <= 599) }

function terminalResponseError(response, reason, telemetry, elapsedMs) {
  const terminal = snapshotProviderFetchTelemetry(telemetry, elapsedMs)
  const error = new ProviderFetchError(`Provider request exhausted retries: ${reason}`, { telemetry: terminal })
  error.status = response.status
  return error
}

function recordRetry(telemetry, retry) {
  telemetry.retries.push({ ...retry })
}

function canRetry({ now, startedAt, maxElapsedMs, delayMs }) {
  return now() - startedAt + delayMs <= maxElapsedMs
}

function abortError() {
  return new DOMException('The operation was aborted', 'AbortError')
}

function attachTelemetry(error, telemetry) {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    try {
      Object.defineProperty(error, 'telemetry', { configurable: true, value: telemetry })
    } catch {
      // Preserve the original abort even if the runtime error object is not extensible.
    }
  }
  return error
}

function attachTelemetryPersistenceError(error, persistenceError) {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    try {
      Object.defineProperty(error, 'telemetryPersistenceError', { configurable: true, value: persistenceError })
    } catch {
      // Preserve the original abort when diagnostic attachment is unavailable.
    }
  }
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function nonNegativeNumber(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
