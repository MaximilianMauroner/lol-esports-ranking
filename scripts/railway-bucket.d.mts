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
export type BucketClient = { send(command: unknown): Promise<unknown> }

export function bucketConfigFromEnv(env?: NodeJS.ProcessEnv): BucketConfig | { enabled: false; missing: string[] }
export function createBucketClient(config?: unknown): BucketClient | null
export function readBucketJson(relativeKey: string, options?: { config?: unknown; client?: BucketClient }): Promise<{
  found: boolean
  key?: string
  etag?: string
  value?: Record<string, unknown>
}>
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
}): Promise<Record<string, unknown>>
export function getBucketObject(relativePath: string, options?: Record<string, unknown>): Promise<Record<string, unknown> & { found: boolean }>
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
export function uploadRawSourceFiles(...args: unknown[]): Promise<Record<string, unknown>>
export function syncRawFile(...args: unknown[]): Promise<Record<string, unknown>>
export function uploadFile(...args: unknown[]): Promise<Record<string, unknown>>
export function uploadJson(...args: unknown[]): Promise<Record<string, unknown>>
export function deleteObject(...args: unknown[]): Promise<boolean>
export function bucketKey(config: { prefix?: string }, relativeKey: string): string
export function safeObjectPath(path: string): string
export function safeRequestedObjectPath(path: string): string
export function contentTypeForPath(path: string): string
