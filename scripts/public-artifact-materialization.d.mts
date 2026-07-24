export function materializePublicArtifactPatch(
  publicDataDir: string,
  patch: {
    previousManifest: Record<string, unknown>
    changedArtifacts: Array<{ logicalPath: string; value: unknown }>
    removedLogicalPaths?: string[]
    expectedLogicalPaths: string[]
  },
): Promise<{
  materialized: true
  logicalArtifactCount: number
  mapping: Record<string, { sha256: string; bytes: number }>
}>
