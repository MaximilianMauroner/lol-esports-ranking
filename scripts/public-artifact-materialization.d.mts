export function materializePublicArtifactPatch(
  publicDataDir: string,
  patch: {
    previousManifest: Record<string, unknown>
    changedArtifacts: Array<{ logicalPath: string; value: unknown }>
    removedLogicalPaths?: string[]
    expectedLogicalPaths: string[]
  },
  options?: {
    move?: typeof import('node:fs/promises').rename
    remove?: typeof import('node:fs/promises').rm
  },
): Promise<{
  materialized: true
  logicalArtifactCount: number
  mapping: Record<string, { sha256: string; bytes: number }>
  cleanupWarning?: { stage: 'backup-cleanup'; message: string; backupPath: string }
}>
