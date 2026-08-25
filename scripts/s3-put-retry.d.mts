export function sendPutWithRetry<TBody, TResult>(options: {
  client: { send(command: unknown): Promise<TResult> }
  command(body: TBody): unknown
  body(): TBody
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  sleep?: (delayMs: number) => Promise<void>
  random?: () => number
}): Promise<TResult>

export function isRetryableS3Error(error: unknown): boolean
