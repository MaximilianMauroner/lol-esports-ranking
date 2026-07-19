export function refreshDataIfChanged(
  rawArgs?: string[],
  options?: {
    env?: NodeJS.ProcessEnv
    bucketConfig?: unknown
    bucketClient?: unknown
    run?: (command: string, args: string[]) => Promise<void>
  },
): Promise<Record<string, unknown>>

export function createSourceFingerprint(manifest: unknown, options?: {
  additionalFiles?: Array<{ kind: string; path: string }>
}): Promise<Record<string, unknown>>
