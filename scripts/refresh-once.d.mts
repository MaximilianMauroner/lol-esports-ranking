import type { RefreshRunMetrics } from './refresh-metrics.mjs'

export function runRefreshOnce(options?: Record<string, unknown>): Promise<{
  status: string
  reason?: string
  state?: unknown
  metrics?: RefreshRunMetrics
}>

export function startLeaseHeartbeat(options: {
  authority: { lease: Record<string, unknown>; etag?: string; promotionEtag?: string }
  leaseKey: string
  ttlMs: number
  now: () => string | number | Date
  renew: (...args: unknown[]) => Promise<
    | { renewed: true; lease: Record<string, unknown>; etag?: string; promotionEtag?: string }
    | { renewed: false; reason: string }
  >
  config: unknown
  client: unknown
  setIntervalFn: (callback: () => void, delay: number) => { unref?: () => void } | undefined
  clearIntervalFn: (timer: unknown) => void
}): { error?: Error; runExclusive<T>(operation: () => Promise<T>): Promise<T>; stop(): Promise<void> }

export function runChildProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  options?: Record<string, unknown>,
): Promise<void>
