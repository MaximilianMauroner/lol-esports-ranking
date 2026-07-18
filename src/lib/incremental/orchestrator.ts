import type { IncrementalCrunchReceipt } from './metrics'
import type { CrunchMode, IncrementalFallbackReason } from './types'

export type CrunchOrchestrationResult<T> = {
  output: T
  requestedMode: CrunchMode
  executedMode: 'full' | 'incremental'
  fallback?: IncrementalFallbackReason
  receipt?: IncrementalCrunchReceipt
}

/**
 * Phase-0 shell: every mode deliberately invokes the direct reference engine.
 * Incremental restoration is not attempted until its compatibility contract exists.
 */
export async function orchestrateCrunch<T>({
  mode = 'full',
  runFull,
  receipt,
}: {
  mode?: CrunchMode
  runFull: () => T | Promise<T>
  receipt?: IncrementalCrunchReceipt
}): Promise<CrunchOrchestrationResult<T>> {
  const fallback: IncrementalFallbackReason | undefined = mode === 'full'
    ? undefined
    : { kind: 'incremental-mode-unavailable', requestedMode: mode }
  if (receipt) {
    receipt.requestedMode = mode
    receipt.executedMode = 'full'
    receipt.checkpoint = fallback ? { fallback } : {}
  }
  return {
    output: await runFull(),
    requestedMode: mode,
    executedMode: 'full',
    ...(fallback ? { fallback } : {}),
    ...(receipt ? { receipt } : {}),
  }
}

export function crunchModeFrom(value: string | undefined): CrunchMode {
  if (value === undefined || value === 'full') return 'full'
  if (value === 'incremental-shadow' || value === 'incremental') return value
  throw new Error(`Unsupported ranking crunch mode: ${value}`)
}
