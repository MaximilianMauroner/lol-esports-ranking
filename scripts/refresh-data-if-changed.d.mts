type DurableCandidateReceipt = Record<string, unknown>

export type RefreshDataResult = {
  changed: boolean
  status?: string
  reason?: string
  fingerprint?: string
  healthFingerprint?: string
  previousFingerprint?: string
  durableCandidate:
    | { kind: 'not-produced'; reason: 'stale-source' | 'unchanged-source-data' | 'skip-crunch' }
    | { kind: 'produced'; receipt: DurableCandidateReceipt }
}

export function refreshDataIfChanged(
  rawArgs?: string[],
  options?: {
    env?: NodeJS.ProcessEnv
    bucketConfig?: unknown
    bucketClient?: unknown
    run?: (command: string, args: string[]) => Promise<void>
  },
): Promise<RefreshDataResult>

export function createSourceFingerprint(manifest: unknown, options?: {
  additionalFiles?: Array<{ kind: string; path: string }>
}): Promise<Record<string, unknown>>
