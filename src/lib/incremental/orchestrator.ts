import type { IncrementalCrunchReceipt } from './metrics'
import type { CrunchMode, IncrementalFallbackReason } from './types'

export type CrunchOrchestrationResult<T, TShadow = T> = {
  output: T
  requestedMode: CrunchMode
  executedMode: 'full' | 'incremental'
  fallback?: IncrementalFallbackReason
  receipt?: IncrementalCrunchReceipt
  shadowOutput?: TShadow
}

export type IncrementalCrunchAttempt<T> =
  | { output: T; fallback?: undefined }
  | { output?: T; fallback: IncrementalFallbackReason }

/** Runs the selected engine, preserving an explicit reference fallback path. */
type OrchestrateCrunchOptions<T, TShadow> = {
  mode?: CrunchMode
  runFull: () => T | Promise<T>
  runIncremental?: () => IncrementalCrunchAttempt<T> | Promise<IncrementalCrunchAttempt<T>>
  receipt?: IncrementalCrunchReceipt
  requireReferenceParity?: boolean
  prepareShadow?: (output: T) => TShadow | Promise<TShadow>
  acceptFallbackCandidate?: boolean
}

export function orchestrateCrunch<T>(
  options: Omit<OrchestrateCrunchOptions<T, T>, 'prepareShadow'> & { prepareShadow?: undefined },
): Promise<CrunchOrchestrationResult<T>>
export function orchestrateCrunch<T, TShadow>(
  options: OrchestrateCrunchOptions<T, TShadow> & { prepareShadow: (output: T) => TShadow | Promise<TShadow> },
): Promise<CrunchOrchestrationResult<T, TShadow>>
export async function orchestrateCrunch<T, TShadow>({
  mode = 'full',
  runFull,
  runIncremental,
  receipt,
  requireReferenceParity = false,
  prepareShadow,
  acceptFallbackCandidate = false,
}: OrchestrateCrunchOptions<T, TShadow>): Promise<CrunchOrchestrationResult<T, T | TShadow>> {
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
  const fallback = attempt.fallback
  const candidate = { output: attempt.output }
  Reflect.deleteProperty(attempt, 'output')
  if (receipt) receipt.attempts.push({
    engine: 'incremental',
    outcome: fallback ? 'fallback' : 'succeeded',
    durationMs: Math.max(0, performance.now() - incrementalStartedAt),
    sources: emptyAttemptSources(),
  })
  if (receipt) {
    receipt.requestedMode = mode
    receipt.executedMode = fallback || mode === 'incremental-shadow' || requireReferenceParity ? 'full' : 'incremental'
    receipt.checkpoint = fallback ? { fallback } : {}
  }
  if (fallback) {
    if (acceptFallbackCandidate && candidate.output !== undefined) {
      if (receipt) receipt.executedMode = 'incremental'
      return {
        output: candidate.output,
        requestedMode: mode,
        executedMode: 'incremental',
        fallback,
        ...(receipt ? { receipt } : {}),
      }
    }
    const shadowOutput = candidate.output === undefined
      ? undefined
      : prepareShadow ? await prepareShadow(candidate.output) : candidate.output
    releaseCandidate(candidate)
    return {
      output: await runAndRecordAttempt(runFull, 'reference', receipt),
      ...(shadowOutput === undefined ? {} : { shadowOutput }),
      requestedMode: mode,
      executedMode: 'full',
      fallback,
      ...(receipt ? { receipt } : {}),
    }
  }
  if (mode === 'incremental-shadow' || requireReferenceParity) {
    const shadowOutput = prepareShadow
      ? await prepareShadow(candidate.output!)
      : candidate.output!
    releaseCandidate(candidate)
    return {
      output: await runAndRecordAttempt(runFull, 'reference', receipt),
      shadowOutput,
      requestedMode: mode,
      executedMode: 'full',
      ...(receipt ? { receipt } : {}),
    }
  }
  return {
    output: candidate.output!,
    requestedMode: mode,
    executedMode: 'incremental',
    ...(receipt ? { receipt } : {}),
  }
}

function releaseCandidate<T>(candidate: { output: T | undefined }) {
  candidate.output = undefined
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
