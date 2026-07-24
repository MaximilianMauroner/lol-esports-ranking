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
export function classifyActiveGenerationPointer(value: unknown): 'legacy' | 'receipt-bound'
export function assertLegacyGenerationCutoverPointer(pointer: Record<string, unknown>, publicManifest: unknown): true
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
