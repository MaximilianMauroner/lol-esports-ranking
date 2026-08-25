const RETRYABLE_NAMES = new Set([
  'InternalError',
  'RequestTimeout',
  'RequestTimeoutException',
  'ServiceUnavailable',
  'SlowDown',
  'Throttling',
  'ThrottlingException',
  'TooManyRequestsException',
])

export async function sendPutWithRetry({
  client,
  command,
  body,
  maxAttempts = 5,
  baseDelayMs = 500,
  maxDelayMs = 8_000,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  random = Math.random,
}) {
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await client.send(command(body()))
    } catch (error) {
      lastError = error
      if (!isRetryableS3Error(error) || attempt === maxAttempts) throw error
      const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)))
      const jittered = Math.max(1, Math.round(exponential * (0.75 + random() * 0.5)))
      await sleep(jittered)
    }
  }
  throw lastError
}

export function isRetryableS3Error(error) {
  const status = Number(error?.$metadata?.httpStatusCode ?? error?.statusCode ?? error?.status)
  return RETRYABLE_NAMES.has(error?.name)
    || status === 429
    || (status >= 500 && status <= 599)
}
