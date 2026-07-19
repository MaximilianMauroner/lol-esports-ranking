import type { CrunchMode, CrunchRunMetadata, IncrementalFallbackReason } from './types'

/** `null` means this phase does not yet expose an exact counter; it never means zero. */
export type InstrumentedCount = number | null

export type IncrementalAttemptSourceMetrics = {
  filesScanned: InstrumentedCount
  bytesScanned: InstrumentedCount
  rowsParsed: InstrumentedCount
  observationsNormalized: InstrumentedCount
  observationsReused: InstrumentedCount
  reducerStateBytesRead: InstrumentedCount
  reducerStateBytesWritten: InstrumentedCount
}

export type IncrementalCrunchReceipt = {
  schemaVersion: 1
  run: CrunchRunMetadata
  requestedMode: CrunchMode
  executedMode: 'full' | 'incremental'
  sources: {
    filesScanned: InstrumentedCount
    bytesScanned: InstrumentedCount
  }
  observations: {
    parsed: InstrumentedCount
    normalized: InstrumentedCount
    reused: InstrumentedCount
  }
  canonical: {
    added: InstrumentedCount
    changed: InstrumentedCount
    deleted: InstrumentedCount
  }
  reducers: {
    livePlayerEdgeRows: InstrumentedCount
    teamRows: InstrumentedCount
    playerRows: InstrumentedCount
  }
  snapshotInputs: {
    rankingRequests: InstrumentedCount
    rankingResultCacheHits: InstrumentedCount
    rankingReducerRuns: InstrumentedCount
    rankingRows: InstrumentedCount
    playerRequests: InstrumentedCount
    playerResultCacheHits: InstrumentedCount
    playerReducerRuns: InstrumentedCount
    playerRows: InstrumentedCount
    directRankingBuilds: InstrumentedCount
    directPlayerBuilds: InstrumentedCount
  }
  artifacts: {
    reused: InstrumentedCount
    regenerated: InstrumentedCount
  }
  bucket: {
    bytesRead: InstrumentedCount
    bytesWritten: InstrumentedCount
  }
  durable: {
    restoredObjects: InstrumentedCount
    restoredBytes: InstrumentedCount
    uploadedObjects: InstrumentedCount
    uploadedBytes: InstrumentedCount
    skippedObjects: InstrumentedCount
    skippedBytes: InstrumentedCount
    cacheHits: InstrumentedCount
    cacheMisses: InstrumentedCount
    reusedUnits: InstrumentedCount
    replayedUnits: InstrumentedCount
    fallback?: IncrementalFallbackReason
    parity: 'not-run' | 'match' | 'mismatch'
    audit: 'not-due' | 'scheduled' | 'forced' | 'match' | 'mismatch'
    promotion: 'not-attempted' | 'staged' | 'promoted' | 'no-change' | 'conflict' | 'fenced'
    gc: {
      planned: InstrumentedCount
      deleted: InstrumentedCount
      skipped: InstrumentedCount
    }
  }
  checkpoint: {
    selected?: string
    playerSelected?: string
    fallback?: IncrementalFallbackReason
  }
  timingsMs: Record<string, number>
  attempts: Array<{
    engine: 'incremental' | 'reference'
    outcome: 'succeeded' | 'fallback'
    durationMs: number
    sources: IncrementalAttemptSourceMetrics
  }>
}

export function createIncrementalCrunchReceipt({
  run,
  requestedMode = 'full',
}: {
  run: CrunchRunMetadata
  requestedMode?: CrunchMode
}): IncrementalCrunchReceipt {
  return {
    schemaVersion: 1,
    run,
    requestedMode,
    executedMode: 'full',
    sources: { filesScanned: null, bytesScanned: null },
    observations: { parsed: null, normalized: null, reused: null },
    canonical: { added: null, changed: null, deleted: null },
    reducers: { livePlayerEdgeRows: null, teamRows: null, playerRows: null },
    snapshotInputs: {
      rankingRequests: null,
      rankingResultCacheHits: null,
      rankingReducerRuns: null,
      rankingRows: null,
      playerRequests: null,
      playerResultCacheHits: null,
      playerReducerRuns: null,
      playerRows: null,
      directRankingBuilds: null,
      directPlayerBuilds: null,
    },
    artifacts: { reused: null, regenerated: null },
    bucket: { bytesRead: 0, bytesWritten: 0 },
    durable: {
      restoredObjects: 0,
      restoredBytes: 0,
      uploadedObjects: 0,
      uploadedBytes: 0,
      skippedObjects: 0,
      skippedBytes: 0,
      cacheHits: 0,
      cacheMisses: 0,
      reusedUnits: null,
      replayedUnits: null,
      parity: 'not-run',
      audit: 'not-due',
      promotion: 'not-attempted',
      gc: { planned: 0, deleted: 0, skipped: 0 },
    },
    checkpoint: {},
    timingsMs: {},
    attempts: [],
  }
}

export function recordSnapshotInputMetrics(
  receipt: IncrementalCrunchReceipt,
  metrics: {
    rankingRequests: number
    rankingResultCacheHits: number
    rankingReducerRuns: number
    rankingRows: number
    playerRequests: number
    playerResultCacheHits: number
    playerReducerRuns: number
    playerRows: number
    directRankingBuilds: number
    directPlayerBuilds: number
  },
) {
  receipt.snapshotInputs = { ...metrics }
}

export function recordCrunchTiming(
  receipt: IncrementalCrunchReceipt,
  phase: string,
  startedAtMs: number,
  endedAtMs: number,
): void {
  receipt.timingsMs[phase] = Math.max(0, endedAtMs - startedAtMs)
}

export function recordCrunchAttemptSources(
  receipt: IncrementalCrunchReceipt,
  engine: IncrementalCrunchReceipt['attempts'][number]['engine'],
  sources: IncrementalAttemptSourceMetrics,
): void {
  const attempt = receipt.attempts.findLast((entry) => entry.engine === engine)
  if (attempt) attempt.sources = { ...sources }
}

export function recordIncrementalReducerCandidate(
  receipt: IncrementalCrunchReceipt,
  candidate: {
    livePlayerEdgeRows: number
    teamRows: number
    playerRows?: number
    selectedCheckpoint?: string
    selectedPlayerCheckpoint?: string
  },
): void {
  receipt.reducers.livePlayerEdgeRows = candidate.livePlayerEdgeRows
  receipt.reducers.teamRows = candidate.teamRows
  if (candidate.playerRows !== undefined) receipt.reducers.playerRows = candidate.playerRows
  if (candidate.selectedCheckpoint) receipt.checkpoint.selected = candidate.selectedCheckpoint
  if (candidate.selectedPlayerCheckpoint) receipt.checkpoint.playerSelected = candidate.selectedPlayerCheckpoint
}
