import type { BucketClient, BucketStorageConfig } from './railway-bucket.mjs'

export const INCREMENTAL_STATE_STORAGE_MODE: 'content-addressed-state-gzip-v1'
export const INCREMENTAL_STATE_MANIFEST_KIND: 'incremental-state-generation-manifest'
export const INCREMENTAL_STATE_CHECKPOINT_KIND: 'incremental-state-checkpoint-bundle'

export type StateCompatibility = {
  modelVersion: string
  modelConfigHash: string
  importerVersion: string
  taxonomyVersion: string
  ratingCheckpointSchemaVersion: number
  causalPrefixSchemaVersion: number
  publicArtifactSchemaVersion: number
}
export type StateBoundary = { date: string; matchId: string }
export type StateRawPrefix = { matchCount: number; digest: string }
export type StateCausalSummaries = {
  sourcedPlayer: Record<string, unknown>
  dssTeam: Record<string, unknown>
  dssRegion: Record<string, unknown>
  rosterEra: Record<string, unknown>
  playerResume: Record<string, unknown>
}
export type StateObjectReference = {
  key: string
  sha256: string
  bytes: number
  compressedBytes: number
  storageEncoding: 'gzip'
}
export type PreparedStateObject = {
  value: Record<string, unknown>
  canonicalJson: string
  canonicalBytes: Buffer
  digest: string
  bytes: number
  compressed: Buffer
  compressedBytes: number
}
export type IncrementalStateManifest = {
  artifactKind: 'incremental-state-generation-manifest'
  schemaVersion: 1
  storageMode: 'content-addressed-state-gzip-v1'
  generationId: string
  runId: string
  baseGenerationId: string | null
  baseRunId: string | null
  canonicalLedger: StateObjectReference
  sourceReceiptDigest: string
  compatibility: StateCompatibility
  checkpoints: Array<{ boundary: StateBoundary; rawPrefix: StateRawPrefix; object: StateObjectReference }>
}
export type StateManifestAuthority = {
  key: string
  etag?: string
  bytes: number
  digest: string
  manifest?: IncrementalStateManifest
}

export function prepareStateObject(value: object): PreparedStateObject
export function stateObjectReferenceFor(prepared: PreparedStateObject): StateObjectReference
export function readStoredJsonStateObject(client: BucketClient, config: BucketStorageConfig, reference: StateObjectReference): Promise<Record<string, unknown>>
export function prepareContentAddressedState(options: {
  generationId: string
  runId?: string
  baseGenerationId?: string | null
  baseRunId?: string | null
  canonicalLedgerReference: StateObjectReference
  sourceReceiptDigest: string
  compatibility: StateCompatibility
  checkpoints: Array<{
    boundary: StateBoundary
    rawPrefix: StateRawPrefix
    compatibility?: StateCompatibility
    ratingCheckpoint: Record<string, unknown>
    causalSummaries: StateCausalSummaries
  }>
}): { manifest: IncrementalStateManifest; manifestPrepared: PreparedStateObject; objects: PreparedStateObject[] }
export function syncContentAddressedStateObject(
  client: BucketClient,
  config: BucketStorageConfig,
  prepared: PreparedStateObject,
): Promise<Record<string, unknown> & { key: string; bytes: number; digest: string }>
export function writeIncrementalStateManifest(
  client: BucketClient,
  config: BucketStorageConfig,
  preparedState: { manifest: IncrementalStateManifest; manifestPrepared?: PreparedStateObject },
): Promise<{ result: Record<string, unknown>; authority: StateManifestAuthority }>
export function assertStateManifestAuthority(
  client: BucketClient,
  config: BucketStorageConfig,
  authority: StateManifestAuthority,
  options?: { verifyObjects?: boolean },
): Promise<StateManifestAuthority & { manifest: IncrementalStateManifest }>
export function readActiveIncrementalState(options: {
  client: BucketClient
  config: BucketStorageConfig
  verifyObjects?: boolean
}): Promise<
  | { found: false; reason: 'active-generation-missing' }
  | { found: false; reason: 'legacy-active-generation'; active: Record<string, unknown>; etag?: string }
  | {
    found: true
    active: Record<string, unknown>
    etag?: string
    manifest: IncrementalStateManifest
    canonicalLedger: Record<string, unknown>
    checkpoints: Array<{
      candidate: IncrementalStateManifest['checkpoints'][number]
      bundle: Record<string, unknown>
    }>
  }
>
export function parseIncrementalStateManifest(value: unknown): IncrementalStateManifest
