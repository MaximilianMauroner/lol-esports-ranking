export type PublicationObjectOutcome = 'uploaded' | 'unchanged' | 'reused'
export type PublicationObject = {
  key: string
  digest: string
  bytes: number
  outcome: PublicationObjectOutcome
}
export type PublicationAuthority = Omit<PublicationObject, 'outcome'>
export type GenerationPublicationReceipt = {
  artifactKind: 'ranking-generation-publication-readiness'
  schemaVersion: 1
  status: 'ready'
  generationId: string
  preparedAt: string
  prefix: string
  fencing: { token: number; owner: string; promotionEtag: string }
  provenance: {
    modelVersion: string
    modelConfigHash: string
    source: string
    dataMode: string
    sourceProviders: string[]
  }
  authorities: {
    publicManifest: PublicationAuthority
    stateManifest?: PublicationAuthority
    rawReceipt: PublicationAuthority
  }
  objects: PublicationObject[]
}
export const GENERATION_PUBLICATION_SCHEMA_VERSION: 1
export const GENERATION_PUBLICATION_STATUS: 'ready'
export function classifyActiveGenerationPointer(value: unknown): 'legacy' | 'legacy-native' | 'receipt-bound'
export function assertLegacyGenerationCutoverPointer(pointer: Record<string, unknown>, publicManifest: unknown): true
export function assertLegacyNativeGenerationCutoverPointer(
  pointer: Record<string, unknown>,
  publicManifest: unknown,
  publishReceipt: LegacyNativeGenerationPublishReceipt,
): true
export type LegacyNativeGenerationPublishReceipt = {
  schemaVersion: 2
  publishedAt: string
  prefix: string
  generationId: string
  artifactCount: number
  uploadedCount: number
  uploadedBytes: number
  unchangedCount: number
  unchangedBytes: number
  artifacts: Array<{ key: string; bytes: number; contentType: string; digest: string }>
  unchanged: Array<{ key: string; bytes: number; contentType: string; digest: string }>
  skipped: Array<{ key: string; reason: string }>
  storageMode: 'content-addressed-gzip-v1'
  storage?: unknown
  authorities: {
    publicManifest: { key: string; bytes: number; contentType: string; digest: string }
    rawReceipt: { key: string; bytes: number; contentType: string; digest: string }
  }
  refreshTelemetry?: unknown
}
export function readLegacyNativeGenerationPublishReceipt(
  client: { send(command: unknown): Promise<unknown> },
  config: { bucket: string; prefix?: string },
  pointer: Record<string, unknown>,
): Promise<LegacyNativeGenerationPublishReceipt>
export function parseLegacyNativeGenerationPublishReceipt(
  value: unknown,
  options: { generationId: string; prefix?: string },
): LegacyNativeGenerationPublishReceipt
export function createGenerationPublicationReceipt(options: {
  generationId: string
  preparedAt: string
  prefix?: string
  fencingToken: number
  leaseOwner: string
  promotionEtag: string
  provenance: GenerationPublicationReceipt['provenance']
  authorities: GenerationPublicationReceipt['authorities']
  objects: PublicationObject[]
}): GenerationPublicationReceipt
export function parseGenerationPublicationReceipt(
  value: unknown,
  options?: { generationId?: string; prefix?: string },
): GenerationPublicationReceipt
export function publicationReceiptBytes(value: GenerationPublicationReceipt): {
  body: Buffer
  bytes: number
  digest: string
}
export function deduplicatePublicationOutcomes(entries: PublicationObject[]): PublicationObject[]
