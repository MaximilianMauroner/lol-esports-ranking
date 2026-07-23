export type RefreshMode = 'shadow' | 'gated'
export type RefreshCause = 'pending-match' | 'daily-audit' | 'manual-force' | 'retry' | 'unchanged-scheduled-probe'
export type RefreshStageName = 'restore' | 'probe' | 'provider-fetch' | 'fingerprint-import' | 'raw-authority-read' | 'raw-prepare' | 'raw-materialization' | 'classification' | 'checkpoint-restore' | 'checkpoint-validation' | 'replay' | 'external-causal-recompute' | 'player-build' | 'player-compaction' | 'dependency-materialization' | 'semantic-parity' | 'state-persistence' | 'full-audit-object' | 'crunch' | 'public-serialization' | 'hashing' | 'raw-synchronization' | 'artifact-upload' | 'promotion' | 'full-audit-receipt'
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
export type RefreshWork = {
  providerRequests: number | null
  providerRetries: number | null
  broadFetches: number | null
  fullBuilds: number | null
  incrementalBuilds: number | null
  bytesRead: number | null
  bytesWritten: number | null
  objectsRead: number | null
  objectsWritten: number | null
  uploads: number | null
}
export type ProcessResources = { processKey: string; cpuSeconds: number | null; memoryGbSeconds: number | null; peakRssBytes: number | null; sampleCount: number | null }
export type RefreshResources = { cpuSeconds: number | null; memoryGbSeconds: number | null; peakRssBytes: number | null; processes: ProcessResources[] }
export type RefreshRunMetrics = {
  schemaVersion: 1 | 2
  runId: string
  mode: RefreshMode
  cause: RefreshCause
  startedAt: string
  finishedAt: string | null
  durationMs: number
  result: string
  peakRssBytes: number | null
  resources?: RefreshResources
  work?: RefreshWork
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
  errors?: string[]
  processError?: string
  coordination?: { owner: string; fencingToken: number; etag: string }
}
export type CompleteRefreshRunMetrics = RefreshRunMetrics & { resources: RefreshResources; work: RefreshWork }
export function createRefreshMetrics(options: {
  runId: string
  mode: RefreshMode
  cause: RefreshCause
  affectedIds?: string[]
  affectedDate?: string
  now?: () => number
  monotonicNow?: () => number
  rss?: () => number
  cpuUsage?: () => { user: number; system: number }
  processKey?: string
  sampleIntervalMs?: number
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
}): {
  setContext(context: { cause?: RefreshCause; affectedIds?: string[]; affectedDate?: string }): void
  setCheckpoint(checkpoint: RefreshRunMetrics['checkpoint']): void
  setEvidence(evidence: Record<string, unknown>): void
  recordWork(work: Partial<RefreshWork>): void
  recordProcessResource(resource: ProcessResources): void
  startStage(name: RefreshStageName, input?: Record<string, unknown>): (result?: string, output?: Record<string, unknown>) => void
  recordStage(name: RefreshStageName, stage?: Partial<Omit<RefreshStage, 'name'>>): void
  snapshot(options?: { result?: string; freshness?: Partial<RefreshRunMetrics['freshness']>; error?: unknown }): CompleteRefreshRunMetrics
}
export function mergeRefreshMetrics(parent: RefreshRunMetrics, child?: RefreshRunMetrics): CompleteRefreshRunMetrics
export function completeRefreshMetrics(record: RefreshRunMetrics): CompleteRefreshRunMetrics
export function readRefreshMetrics(path?: string): Promise<RefreshRunMetrics | undefined>
export function writeRefreshMetrics(path: string | undefined, record: RefreshRunMetrics): Promise<void>
export function appendRefreshStages(path: string | undefined, record: RefreshRunMetrics): Promise<void>
export function emptyRefreshWork(): RefreshWork
export function mergeRefreshWork(left?: Partial<RefreshWork>, right?: Partial<RefreshWork>): RefreshWork
