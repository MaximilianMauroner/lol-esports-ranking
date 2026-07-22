export type RefreshMode = 'legacy' | 'shadow' | 'gated'
export type RefreshCause = 'pending-match' | 'daily-audit' | 'manual-force' | 'retry' | 'unchanged-scheduled-probe'
export type RefreshStageName = 'restore' | 'probe' | 'provider-fetch' | 'fingerprint-import' | 'raw-authority-read' | 'raw-prepare' | 'raw-materialization' | 'classification' | 'checkpoint-restore' | 'checkpoint-validation' | 'replay' | 'external-causal-recompute' | 'player-build' | 'player-compaction' | 'dependency-materialization' | 'semantic-parity' | 'state-persistence' | 'crunch' | 'public-serialization' | 'hashing' | 'raw-synchronization' | 'artifact-upload' | 'promotion'
export const REFRESH_STAGE_NAMES: readonly RefreshStageName[]
export type RefreshStage = {
  name: RefreshStageName
  startedAt?: string
  finishedAt?: string
  durationMs: number
  result: string
  input: Record<string, unknown>
  output: Record<string, unknown>
}
export type RefreshRunMetrics = {
  schemaVersion: 1
  runId: string
  mode: RefreshMode
  cause: RefreshCause
  startedAt: string
  finishedAt: string | null
  durationMs: number
  result: string
  peakRssBytes: number
  affected: { matchIds: string[]; date?: string }
  freshness: { providerAvailableAt: string | null; detectedAt: string | null; publishedAt: string | null }
  checkpoint: {
    applicable: boolean
    classification?: string
    selectedBoundary?: string
    replayFromUtcDate?: string
    replayedMatchCount?: number
    candidateCount?: number
    rejectedCandidates?: string[]
    fallbackReason?: string
    reason?: string
  }
  stages: RefreshStage[]
  error?: string
  processError?: string
  coordination?: { owner: string; fencingToken: number; etag: string }
}
export function createRefreshMetrics(options: {
  runId: string
  mode: RefreshMode
  cause: RefreshCause
  affectedIds?: string[]
  affectedDate?: string
  now?: () => number
  monotonicNow?: () => number
  rss?: () => number
}): {
  setContext(context: { cause?: RefreshCause; affectedIds?: string[]; affectedDate?: string }): void
  setCheckpoint(checkpoint: RefreshRunMetrics['checkpoint']): void
  startStage(name: RefreshStageName, input?: Record<string, unknown>): (result?: string, output?: Record<string, unknown>) => void
  recordStage(name: RefreshStageName, stage?: Partial<Omit<RefreshStage, 'name'>>): void
  snapshot(options?: { result?: string; freshness?: Partial<RefreshRunMetrics['freshness']>; error?: unknown }): RefreshRunMetrics
}
export function mergeRefreshMetrics(parent: RefreshRunMetrics, child?: RefreshRunMetrics): RefreshRunMetrics
export function completeRefreshMetrics(record: RefreshRunMetrics): RefreshRunMetrics
export function readRefreshMetrics(path?: string): Promise<RefreshRunMetrics | undefined>
export function writeRefreshMetrics(path: string | undefined, record: RefreshRunMetrics): Promise<void>
export function appendRefreshStages(path: string | undefined, record: RefreshRunMetrics): Promise<void>
