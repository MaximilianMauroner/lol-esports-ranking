import type { IncrementalCrunchReceipt } from './metrics'
import type { CrunchMode, IncrementalFallbackReason } from './types'

export type CrunchOrchestrationResult<T> = {
  output: T
  requestedMode: CrunchMode
  executedMode: 'full' | 'incremental'
  fallback?: IncrementalFallbackReason
  receipt?: IncrementalCrunchReceipt
  shadowOutput?: T
}

export type IncrementalCrunchAttempt<T> =
  | { output: T; fallback?: undefined }
  | { output?: T; fallback: IncrementalFallbackReason }

/** Runs the selected engine, preserving an explicit reference fallback path. */
export async function orchestrateCrunch<T>({
  mode = 'full',
  runFull,
  runIncremental,
  receipt,
  requireReferenceParity = false,
}: {
  mode?: CrunchMode
  runFull: () => T | Promise<T>
  runIncremental?: () => IncrementalCrunchAttempt<T> | Promise<IncrementalCrunchAttempt<T>>
  receipt?: IncrementalCrunchReceipt
  requireReferenceParity?: boolean
}): Promise<CrunchOrchestrationResult<T>> {
  if (mode === 'full') {
    if (receipt) {
      receipt.requestedMode = mode
      receipt.executedMode = 'full'
      receipt.checkpoint = {}
    }
    const output = await runAndRecordAttempt(runFull, 'reference', receipt)
    return {
      output,
      requestedMode: mode,
      executedMode: 'full',
      ...(receipt ? { receipt } : {}),
    }
  }
  const incrementalStartedAt = performance.now()
  const attempt = runIncremental
    ? await runIncremental()
    : { fallback: { kind: 'incremental-mode-unavailable' as const, requestedMode: mode } }
  if (receipt) receipt.attempts.push({
    engine: 'incremental',
    outcome: attempt.fallback ? 'fallback' : 'succeeded',
    durationMs: Math.max(0, performance.now() - incrementalStartedAt),
    sources: emptyAttemptSources(),
  })
  const fallback = attempt.fallback
  if (receipt) {
    receipt.requestedMode = mode
    receipt.executedMode = fallback || mode === 'incremental-shadow' || requireReferenceParity ? 'full' : 'incremental'
    receipt.checkpoint = fallback ? { fallback } : {}
  }
  if (fallback) {
    return {
      output: await runAndRecordAttempt(runFull, 'reference', receipt),
      ...(attempt.output === undefined ? {} : { shadowOutput: attempt.output }),
      requestedMode: mode,
      executedMode: 'full',
      fallback,
      ...(receipt ? { receipt } : {}),
    }
  }
  if (mode === 'incremental-shadow' || requireReferenceParity) {
    return {
      output: await runAndRecordAttempt(runFull, 'reference', receipt),
      shadowOutput: attempt.output,
      requestedMode: mode,
      executedMode: 'full',
      ...(receipt ? { receipt } : {}),
    }
  }
  return {
    output: attempt.output,
    requestedMode: mode,
    executedMode: 'incremental',
    ...(receipt ? { receipt } : {}),
  }
}

async function runAndRecordAttempt<T>(
  run: () => T | Promise<T>,
  engine: 'reference' | 'incremental',
  receipt?: IncrementalCrunchReceipt,
): Promise<T> {
  const startedAt = performance.now()
  const output = await run()
  if (receipt) receipt.attempts.push({
    engine,
    outcome: 'succeeded',
    durationMs: Math.max(0, performance.now() - startedAt),
    sources: emptyAttemptSources(),
  })
  return output
}

function emptyAttemptSources() {
  return {
    filesScanned: null,
    bytesScanned: null,
    rowsParsed: null,
    observationsNormalized: null,
    observationsReused: null,
    reducerStateBytesRead: null,
    reducerStateBytesWritten: null,
  }
}

export function crunchModeFrom(value: string | undefined): CrunchMode {
  if (value === undefined || value === 'full') return 'full'
  if (value === 'incremental-shadow' || value === 'incremental') return value
  throw new Error(`Unsupported ranking crunch mode: ${value}`)
}
