export const CONTENT_ADDRESSED_STORAGE_MODE: 'content-addressed-gzip-v1'

export type PreparedSemanticArtifact = {
  semantic: Record<string, unknown>
  canonicalJson: string
  canonicalBytes: Buffer
  digest: string
  bytes: number
  compressed: Buffer
  compressedBytes: number
}

export function prepareSemanticArtifact(value: unknown): PreparedSemanticArtifact
export function createGenerationManifest(options: {
  generationId: string
  rootManifest: Record<string, unknown>
  entries: Array<{ logicalPath: string; digest: string; bytes: number }>
}): Record<string, unknown>
export function canonicalJsonFor(value: unknown): string
