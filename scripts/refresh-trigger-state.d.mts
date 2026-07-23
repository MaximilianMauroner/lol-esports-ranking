export type TriggerMode = 'shadow' | 'gated'

export type PendingMatch = {
  completedAt: string
  detectedAt: string
  attempts: number
  nextAttemptAt: string
  lastReason: string
  reconciliation: { status: string; candidates: unknown[] }
  lastAttemptAt?: string
}

export type RefreshTriggerState = {
  schemaVersion: 1
  generation: number
  mode: TriggerMode
  checkedAt: string | null
  observationWatermark: string | null
  acknowledged: Record<string, { acknowledgedAt: string; canonicalSeriesId?: string; scoredGameIds: string[] }>
  pending: Record<string, PendingMatch>
  metrics: Record<string, number>
  lastProbe?: Record<string, unknown>
  fencingToken?: number
  lastSuccessfulDailyAuditAt?: string
  lastRun?: Record<string, unknown>
}

export type ScheduleEvent = {
  matchId: string
  state?: string
  startTime?: string
  teams: Array<{ id?: string; name?: string; outcome?: string; gameWins?: number }>
}

export function emptyTriggerState(mode?: TriggerMode): RefreshTriggerState
export function parseTriggerState(value: unknown, options?: { mode?: TriggerMode }): RefreshTriggerState
export function completionEvidence(event: ScheduleEvent): { complete: boolean; matchId: string; reasons: string[]; winner?: string }
export function applyScheduleProbe(state: unknown, probe: {
  mode?: TriggerMode
  checkedAt: string | Date
  coverageStart?: string | null
  coverageEnd?: string | null
  coverageComplete: boolean
  events?: ScheduleEvent[]
}): RefreshTriggerState
export function applyProbeFailure(state: unknown, input: { checkedAt: string | Date; reason: unknown }): RefreshTriggerState
export function duePendingMatchIds(state: unknown, now?: string | Date): string[]
export function recordPendingAttempt(state: unknown, matchIds: string[], options?: { attemptedAt?: string | Date; reason?: string }): RefreshTriggerState
export function acknowledgeMatches(state: unknown, reconciliations: Array<{
  matchId: string
  status: string
  canonicalSeriesId?: string
  scoredGameIds?: string[]
}>, acknowledgedAt?: string | Date): RefreshTriggerState
export function shouldFetchScoredProviders(state: unknown, options?: { now?: string | Date; correctionAuditDue?: boolean; manual?: boolean; shadowIngestionEnabled?: boolean }): boolean
export function refreshTriggerCause(state: unknown, options?: { now?: string | Date; correctionAuditDue?: boolean; manual?: boolean }): 'pending-match' | 'daily-audit' | 'manual-force' | 'retry' | 'unchanged-scheduled-probe'
export function assertRefreshCadence(options: { intervalMinutes: number; mode: TriggerMode; commit?: string; deploymentId?: string; receiptAuthority?: unknown; resolveReference?: (key: string) => Promise<unknown>; now?: string | number | Date }): Promise<true>
export function retryDelayMs(attempts: number): number
