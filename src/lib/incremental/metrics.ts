import type { CrunchMode, CrunchRunMetadata, IncrementalFallbackReason } from './types'

/** `null` means this phase does not yet expose an exact counter; it never means zero. */
export type InstrumentedCount = number | null

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
  artifacts: {
    reused: InstrumentedCount
    regenerated: InstrumentedCount
  }
  bucket: {
    bytesRead: InstrumentedCount
    bytesWritten: InstrumentedCount
  }
  checkpoint: {
    selected?: string
    fallback?: IncrementalFallbackReason
  }
  timingsMs: Record<string, number>
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
    artifacts: { reused: null, regenerated: null },
    bucket: { bytesRead: 0, bytesWritten: 0 },
    checkpoint: {},
    timingsMs: {},
  }
}

export function recordCrunchTiming(
  receipt: IncrementalCrunchReceipt,
  phase: string,
  startedAtMs: number,
  endedAtMs: number,
): void {
  receipt.timingsMs[phase] = Math.max(0, endedAtMs - startedAtMs)
}
