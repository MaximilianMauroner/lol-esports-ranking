import type { BucketClient, BucketLeaseAuthority, BucketStorageConfig } from './railway-bucket.mjs'
import type { StateManifestAuthority, StateObjectReference } from './incremental-state-storage.mjs'
import type { PreparedRawSourceGeneration } from './raw-source-generation.mjs'
import type { RawObjectReference, RawSourceReceipt } from './raw-source-storage.mjs'

export type FullAuditCause = 'daily-audit' | 'manual-force'
export type FullAuditObjectReference = {
  key: `audits/objects/sha256/${string}`
  sha256: string
  bytes: number
  compressedBytes: number
  storageEncoding: 'gzip'
}
export type FullSnapshotDescriptor = {
  artifactKind: 'full-ranking-artifact'
  schemaVersion: number
  generatedAt: string
  source: string
  sources: Array<{ name: string }>
  model: { version: string; configHash: string }
  sha256: string
  bytes: number
}
export type FullAuditPublicManifest = {
  generatedAt: string
  source: string
  sources: Array<{ name: string }>
  model: { version: string; configHash: string }
}
export type FullAuditPublicManifestAuthority = FullAuditPublicManifest | { manifest: FullAuditPublicManifest }
export type FullAuditReceipt = {
  artifactKind: 'full-ranking-audit-receipt'
  schemaVersion: 1
  auditDate: string
  cause: FullAuditCause
  generationId: string
  runId: string
  fencingToken: number
  promotedAt: string
  model: { version: string; configHash: string }
  sourceReceipt: RawObjectReference
  rawLedger: StateObjectReference
  fullSnapshot: FullAuditObjectReference
}
export type StagedFullAudit = FullAuditObjectReference & {
  status: 'uploaded' | 'unchanged'
  reference: FullAuditObjectReference
  descriptor: FullSnapshotDescriptor
}
export type FullAuditPublishResult = {
  status: 'uploaded' | 'replaced' | 'unchanged'
  key: string
  receipt: FullAuditReceipt
  digest: string
  bytes: number
  etag?: string
}

export function isFullAuditEligible(input?: Record<string, unknown>): boolean
export function stageFullAuditSnapshot(options: {
  fullSnapshotPath: string
  snapshotPath?: string
  snapshotDescriptor: FullSnapshotDescriptor
  config: BucketStorageConfig
  client: BucketClient
  publicManifest?: FullAuditPublicManifestAuthority
}): Promise<StagedFullAudit>
type RawReceiptAuthority =
  | { reference: RawObjectReference; receiptReference?: never; receipt: RawSourceReceipt }
  | { receiptReference: RawObjectReference; reference?: never; receipt: RawSourceReceipt }
type FullAuditSnapshotAuthority =
  | { stagedSnapshot: StagedFullAudit; fullSnapshot?: never; snapshotDescriptor?: never }
  | { stagedSnapshot?: never; fullSnapshot: FullAuditObjectReference; snapshotDescriptor: FullSnapshotDescriptor }
type FullAuditRawAuthority =
  | { rawReceiptAuthority: RawReceiptAuthority; rawSourceGeneration?: never }
  | { rawReceiptAuthority?: never; rawSourceGeneration: PreparedRawSourceGeneration }
export function publishFullAuditDayReceipt(options: {
  cause: FullAuditCause
  generationId?: string
  fencingToken?: number
  promotion: { completed: true; generationId: string; fencingToken: number; promotedAt: string; etag: string }
  publicManifest: FullAuditPublicManifestAuthority
  stateManifestAuthority: StateManifestAuthority
  leaseAuthority: BucketLeaseAuthority & { key: string }
  leaseKey?: string
  config: BucketStorageConfig
  client: BucketClient
  now?: () => Date
  beforeReceiptWrite?: () => void | Promise<void>
} & FullAuditSnapshotAuthority & FullAuditRawAuthority): Promise<FullAuditPublishResult>
export function parseFullAuditReceipt(value: unknown): FullAuditReceipt
