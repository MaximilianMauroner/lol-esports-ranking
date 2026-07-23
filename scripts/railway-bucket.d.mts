export type BucketConfig = {
  enabled: true
  bucket: string
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  prefix?: string
  forcePathStyle?: boolean
}
export type BucketStorageConfig = Omit<BucketConfig, 'enabled'> & { enabled?: boolean }
export type BucketClient = { send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> }
export type PresignedBucketMethod = 'GET' | 'HEAD'
export type ContentAddressedObjectPath = { path: string; sha256: string }
export type BucketObjectHead = {
  found: true
  key: string
  contentLength?: number
  contentType?: string
  contentEncoding?: string
  cacheControl?: string
  metadata?: Record<string, string>
  etag?: string
  lastModified?: Date
}

export const PRESIGNED_URL_EXPIRY_SECONDS: 3600

export function bucketConfigFromEnv(env?: NodeJS.ProcessEnv): BucketConfig | { enabled: false; missing: string[] }
export function createBucketClient(config?: unknown): BucketClient | null
export function readBucketJson(relativeKey: string, options?: { config?: unknown; client?: BucketClient }): Promise<{
  found: boolean
  key?: string
  etag?: string
  value?: Record<string, unknown>
}>
export function readActiveContentAddressedGeneration(options?: { config?: unknown; client?: BucketClient; verifyArtifacts?: boolean }): Promise<
  | { found: false; reason: string; active?: Record<string, unknown>; etag?: string }
  | { found: true; active: Record<string, unknown>; etag?: string; manifest: Record<string, unknown>; rootArtifact: Record<string, unknown>; artifacts: Record<string, unknown>; loadArtifacts(paths: string[]): Promise<Record<string, unknown>> }
>
export function readActiveRawSourceAuthority(options?: { config?: unknown; client?: BucketClient }): Promise<
  | { found: false; reason: string }
  | ({ found: true; active: Record<string, unknown> } & import('./raw-source-generation.mjs').ActiveRawSourceAuthority & {
      receiptReference: import('./raw-source-storage.mjs').RawObjectReference
    })
>
export function writeBucketJson(relativeKey: string, value: unknown, options?: {
  ifMatch?: string
  ifNoneMatch?: string
  config?: unknown
  client?: BucketClient
}): Promise<{ written: boolean; conflict?: boolean; etag?: string }>
export function acquireBucketLease(relativeKey: string, options: {
  owner: string
  ttlMs?: number
  now?: string | Date
  config?: unknown
  client?: BucketClient
}): Promise<
  | { acquired: true; lease: { owner: string; fencingToken: number; acquiredAt: string; expiresAt: string }; etag?: string; promotionEtag?: string }
  | { acquired: false; reason: string; lease?: unknown }
>
export function releaseBucketLease(relativeKey: string, lease: {
  lease: { owner: string; fencingToken: number; acquiredAt: string; expiresAt: string }
  etag?: string
}, options?: {
  now?: string | Date
  config?: unknown
  client?: BucketClient
}): Promise<{ released: boolean; reason?: string; etag?: string }>
export type BucketLeaseAuthority = {
  lease: { owner: string; fencingToken: number; acquiredAt: string; expiresAt: string; renewedAt?: string }
  etag?: string
  promotionEtag?: string
}
export type PreviousGeneration = {
  generationId: string
  manifestKey: string
  promotedAt?: string
  stateManifestKey?: string
  stateManifestDigest?: string
  rawReceiptKey?: string
  rawReceiptDigest?: string
}
export function readPreviousGenerationAuthorities(options?: {
  config?: BucketStorageConfig
  client?: BucketClient
  verifyArtifacts?: boolean
  beforePointerRecheck?: () => void | Promise<void>
}): Promise<
  | { found: false; reason: string }
  | {
      found: true
      previous: PreviousGeneration
      public: { manifest: Record<string, unknown>; digest: string; artifacts: Record<string, unknown> }
      state?: { manifest: import('./incremental-state-storage.mjs').IncrementalStateManifest; canonicalLedger: Record<string, unknown>; checkpoints: unknown[] }
      raw?: { receipt: import('./raw-source-storage.mjs').RawSourceReceipt; receiptReference: import('./raw-source-storage.mjs').RawObjectReference }
    }
>
export type GenerationPublishEntry = { key: string; bytes: number; contentType: string; digest?: string }
export type GenerationPublishAuthority = { key: string; bytes: number; contentType: 'application/json; charset=utf-8'; digest: string }
export type GenerationPublishReceipt = {
  schemaVersion: 1 | 2
  publishedAt: string
  prefix: string
  generationId: string
  artifactCount: number
  uploadedCount: number
  uploadedBytes: number
  unchangedCount: number
  unchangedBytes: number
  artifacts: GenerationPublishEntry[]
  unchanged: GenerationPublishEntry[]
  skipped: Array<{ key: string; reason: string }>
  storageMode?: string
  storage?: Record<string, unknown>
  authorities?: { publicManifest: GenerationPublishAuthority; rawReceipt: GenerationPublishAuthority }
  refreshTelemetry?: unknown
}
export function parseGenerationPublishReceipt(value: unknown, options?: { generationId?: string; prefix?: string }): GenerationPublishReceipt
export function renewBucketLease(relativeKey: string, lease: BucketLeaseAuthority, options?: {
  ttlMs?: number
  now?: string | Date
  config?: unknown
  client?: BucketClient
}): Promise<({ renewed: true } & BucketLeaseAuthority) | { renewed: false; reason: string }>
export function assertBucketLease(relativeKey: string, lease: BucketLeaseAuthority, options?: {
  now?: string | Date
  config?: unknown
  client?: BucketClient
  throwOnFailure?: boolean
  requireEtag?: boolean
}): Promise<{ live: true; lease: Record<string, unknown>; etag?: string } | { live: false; reason: string }>
export function uploadRankingArtifacts(options?: Record<string, unknown> & {
  stateManifestAuthority?: import('./incremental-state-storage.mjs').StateManifestAuthority
  publicArtifactPatch?: PublicArtifactPatch
  rawSourceGeneration?: import('./raw-source-generation.mjs').PreparedRawSourceGeneration
}): Promise<Record<string, unknown>>
export function uploadContentAddressedRawSourceGeneration(
  client: BucketClient,
  config: BucketStorageConfig,
  generation: import('./raw-source-generation.mjs').PreparedRawSourceGeneration,
): Promise<Record<string, unknown>>
export function getBucketObject(relativePath: string, options?: Record<string, unknown>): Promise<Record<string, unknown> & { found: boolean }>
export function headBucketObject(relativePath: string, options?: {
  config?: BucketStorageConfig | { enabled: false; missing?: string[] }
  client?: BucketClient | null
}): Promise<BucketObjectHead | { found: false; key?: string; missingConfig?: string[] }>
export function presignBucketObject(relativePath: string, options?: {
  method?: PresignedBucketMethod
  config?: BucketStorageConfig | { enabled: false; missing?: string[] }
  client?: BucketClient | null
  signer?: (client: BucketClient, command: unknown, options: { expiresIn: 3600 }) => Promise<string>
}): Promise<string>
export type PresignedBucketDelivery =
  | { kind: 'redirect'; location: string }
  | { kind: 'proxy'; bucketHead: BucketObjectHead | { found: false; key?: string } }
  | { kind: 'head-failed' }
  | { kind: 'sign-failed'; bucketHead: BucketObjectHead }
export function preparePresignedBucketDelivery(relativePath: string, options: {
  method?: PresignedBucketMethod
  thresholdBytes: number
  config?: BucketStorageConfig | { enabled: false; missing?: string[] }
  client?: BucketClient | null
  head?: typeof headBucketObject
  presign?: typeof presignBucketObject
}): Promise<PresignedBucketDelivery>
export function parseContentAddressedObjectPath(path: string): ContentAddressedObjectPath
export function downloadBucketDirectory(options?: Record<string, unknown>): Promise<Record<string, unknown>>
export function downloadBucketObject(options?: Record<string, unknown>): Promise<Record<string, unknown> & { found: boolean }>
export function uploadDirectory(...args: unknown[]): Promise<unknown[]>
export type SyncedArtifact = Record<string, unknown> & { key: string; bytes: number }
export function uploadContentAddressedPublicArtifacts(
  client: BucketClient,
  config: BucketStorageConfig,
  dir: string,
  generationId: string,
): Promise<{
  uploaded: SyncedArtifact[]
  unchanged: SyncedArtifact[]
  manifest: Record<string, unknown>
  manifestAuthority: { key: string; etag?: string; bytes: number; digest: string }
  objectCount: number
  logicalArtifactCount: number
  compressedLogicalBytes: number
  semanticLogicalBytes: number
  uniqueCompressedBytes: number
}>
export type PublicArtifactPatch = {
  previousManifest: Record<string, unknown>
  changedArtifacts: Array<{ logicalPath: string; value: unknown }>
  removedLogicalPaths?: string[]
  expectedLogicalPaths?: string[]
}
export function uploadContentAddressedPublicArtifactPatch(
  client: BucketClient,
  config: BucketStorageConfig,
  patch: PublicArtifactPatch & { generationId: string },
): Promise<{
  uploaded: SyncedArtifact[]
  unchanged: SyncedArtifact[]
  manifest: Record<string, unknown>
  manifestAuthority: { key: string; etag?: string; bytes: number; digest: string }
  objectCount: number
  logicalArtifactCount: number
  compressedLogicalBytes: number
  semanticLogicalBytes: number
  uniqueCompressedBytes: number
  changedLogicalPaths: string[]
  reusedLogicalPaths: string[]
  removedLogicalPaths: string[]
}>
export function uploadRawSourceFiles(...args: unknown[]): Promise<Record<string, unknown>>
export function syncRawFile(...args: unknown[]): Promise<Record<string, unknown>>
export function uploadFile(...args: unknown[]): Promise<Record<string, unknown>>
export function uploadJson(...args: unknown[]): Promise<Record<string, unknown>>
export function deleteObject(...args: unknown[]): Promise<boolean>
export function bucketKey(config: { prefix?: string }, relativeKey: string): string
export function safeObjectPath(path: string): string
export function safeRequestedObjectPath(path: string): string
export function contentTypeForPath(path: string): string
