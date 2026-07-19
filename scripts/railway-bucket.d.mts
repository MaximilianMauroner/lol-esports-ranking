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
export type BucketClient = { send(command: unknown): Promise<unknown> }

export function bucketConfigFromEnv(env?: NodeJS.ProcessEnv): BucketConfig | { enabled: false; missing: string[] }
export function createBucketClient(config?: unknown): BucketClient | null
export function readBucketJson(relativeKey: string, options?: { config?: unknown; client?: BucketClient }): Promise<{
  found: boolean
  key?: string
  etag?: string
  value?: Record<string, unknown>
}>
export function readBucketBytes(relativeKey: string, options?: { config?: unknown; client?: BucketClient }): Promise<{
  found: boolean
  key?: string
  etag?: string
  bytes?: Uint8Array
  contentLength?: number
  metadata?: Record<string, string>
  missingConfig?: string[]
}>
export function writeBucketBytes(relativeKey: string, bytes: Uint8Array | string, options?: {
  ifMatch?: string
  ifNoneMatch?: string
  metadata?: Record<string, string>
  contentType?: string
  config?: unknown
  client?: BucketClient
}): Promise<{ written: boolean; conflict?: boolean; key?: string; etag?: string; bytes?: number; missingConfig?: string[] }>
export function listBucketKeys(relativePrefix: string, options?: { config?: unknown; client?: BucketClient }): Promise<{
  enabled: boolean
  keys: Array<{ key: string; bytes: number }>
  missingConfig?: string[]
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
  fenceActiveKey?: string
  config?: unknown
  client?: BucketClient
  beforeAuthorityCas?: (context: { attempt: number; active: unknown; lease: unknown }) => Promise<void>
  afterMirrorPut?: (context: { lease: unknown; mirror: unknown }) => Promise<void>
}): Promise<
  | { acquired: true; lease: { key?: string; owner: string; fencingToken: number; acquiredAt: string; expiresAt: string }; etag?: string; activeEtag?: string; authorityKey?: string; idempotent?: boolean }
  | { acquired: false; reason: string; lease?: unknown }
>
export function releaseBucketLease(relativeKey: string, lease: {
  lease: { owner: string; fencingToken: number; acquiredAt: string; expiresAt: string }
  etag?: string
  authorityKey?: string
}, options?: {
  now?: string | Date
  config?: unknown
  client?: BucketClient
}): Promise<{ released: boolean; reason?: string; etag?: string }>
export function verifyBucketLease(relativeKey: string, expected: {
  owner: string
  fencingToken: number
  etag?: string
  authorityKey?: string
}, options?: Record<string, unknown>): Promise<{ valid: boolean; reason?: string; lease?: unknown; etag?: string }>
export function verifyBucketRefreshAuthority(relativeKey: string, expected: {
  owner: string
  fencingToken: number
  etag?: string
  authorityKey?: string
}, options?: Record<string, unknown>): Promise<{ valid: boolean; reason?: string; lease?: unknown; etag?: string }>
export function uploadRankingArtifacts(options?: {
  publicDataDir?: string
  rawDir?: string
  fullSnapshotPath?: string
  manifestPath?: string
  statePath?: string
  config?: unknown
  client?: BucketClient
  uploadFullSnapshot?: boolean
  refreshStateForUpload?: unknown
  generationId?: string
  fencingToken?: number
  privateState?: Record<string, unknown>
  rollout?: Record<string, unknown>
  rolloutForActive?: (previous: unknown) => Record<string, unknown>
  publishGeneration?: boolean
  leaseGuard?: { key: string; owner: string; fencingToken: number; etag?: string; authorityKey?: string }
  rolloutUpdateId?: string
  clock?: () => string | Date
  beforeActivePointerCas?: () => Promise<void>
}): Promise<Record<string, unknown>>
export function getBucketObject(relativePath: string, options?: Record<string, unknown>): Promise<Record<string, unknown> & { found: boolean }>
export function downloadBucketDirectory(options?: Record<string, unknown>): Promise<Record<string, unknown>>
export function downloadBucketObject(options?: Record<string, unknown>): Promise<Record<string, unknown> & { found: boolean }>
export function uploadDirectory(...args: unknown[]): Promise<unknown[]>
export function uploadRawSourceFiles(...args: unknown[]): Promise<Record<string, unknown>>
export function syncRawFile(...args: unknown[]): Promise<Record<string, unknown>>
export function uploadFile(...args: unknown[]): Promise<Record<string, unknown>>
export function uploadJson(...args: unknown[]): Promise<Record<string, unknown>>
export function deleteObject(...args: unknown[]): Promise<boolean>
export function bucketKey(config: { prefix?: string }, relativeKey: string): string
export function safeObjectPath(path: string): string
export function safeRequestedObjectPath(path: string): string
export function contentTypeForPath(path: string): string
