export type ProviderFetchTelemetry = {
  requests: number
  retries: Array<{ attempt: number; delayMs: number; reason: string; retryAfterMs?: number }>
  attempts: Array<{ attempt: number; startedAtMs: number; finishedAtMs: number; status: number | null; retryable: boolean; reason?: string; error?: string }>
}
export class ProviderFetchError extends Error { telemetry?: ReturnType<typeof snapshotProviderFetchTelemetry>; status?: number }
export function fetchWithRetry(
  input: URL | string | Request,
  init?: RequestInit,
  options?: {
    fetcher?: typeof fetch
    now?: () => number
    sleep?: (delayMs: number) => Promise<void>
    random?: () => number
    maxAttempts?: number
    maxElapsedMs?: number
    baseDelayMs?: number
    maxDelayMs?: number
    retryResponse?: (response: Response) => boolean | string | undefined | Promise<boolean | string | undefined>
    telemetry?: ProviderFetchTelemetry
    onRetry?: (retry: ProviderFetchTelemetry['retries'][number], telemetry: ProviderFetchTelemetry) => void
    onTerminal?: (telemetry: ReturnType<typeof snapshotProviderFetchTelemetry>) => void | Promise<void>
    onFailure?: (telemetry: ReturnType<typeof snapshotProviderFetchTelemetry>) => void | Promise<void>
    setTimeoutFn?: typeof setTimeout
    clearTimeoutFn?: typeof clearTimeout
  },
): Promise<Response>
export const providerFetchWithRetry: typeof fetchWithRetry
export function createProviderFetchTelemetry(): ProviderFetchTelemetry
export function snapshotProviderFetchTelemetry(telemetry: ProviderFetchTelemetry, elapsedMs?: number): ProviderFetchTelemetry & { retryCount: number; elapsedMs?: number }
export function parseRetryAfterMs(value: string | null | undefined, nowMs?: number): number | undefined
export function retryDelayMs(options: { attempt: number; baseDelayMs?: number; maxDelayMs?: number; retryAfterMs?: number; random?: () => number }): number
export function providerFetchTelemetryFor(response: Response): ReturnType<typeof snapshotProviderFetchTelemetry> | undefined
