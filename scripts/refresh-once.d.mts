import type { RefreshRunMetrics } from './refresh-metrics.mjs'

export function runRefreshOnce(options?: Record<string, unknown>): Promise<{
  status: string
  reason?: string
  state?: unknown
  metrics?: RefreshRunMetrics
}>

export function startLeaseHeartbeat(options: {
  authority: { lease: Record<string, unknown>; etag?: string }
  leaseKey: string
  ttlMs: number
  now: () => string | number | Date
  renew: (...args: unknown[]) => Promise<
    | { renewed: true; lease: Record<string, unknown>; etag?: string }
    | { renewed: false; reason: string }
  >
  config: unknown
  client: unknown
  setIntervalFn: (callback: () => void, delay: number) => { unref?: () => void } | undefined
  clearIntervalFn: (timer: unknown) => void
}): { error?: Error; stop(): Promise<void> }
