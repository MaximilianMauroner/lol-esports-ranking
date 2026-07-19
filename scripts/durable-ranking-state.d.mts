export type DurableIdentity = {
  compatibilityHash: string
  pipelineVersion: string
  codeHash: string
  modelVersion: string
  modelConfigHash: string
}

export type DurableObjectStore = {
  get(key: string): Promise<{ found: boolean; key?: string; etag?: string; bytes?: Uint8Array; contentLength?: number; metadata?: Record<string, string> }>
  put(key: string, bytes: Uint8Array, options?: { ifMatch?: string; ifAbsent?: boolean; metadata?: Record<string, string>; contentType?: string }): Promise<{ written: boolean; conflict?: boolean; key?: string; etag?: string; bytes?: number }>
  list(prefix: string): Promise<Array<{ key: string; bytes: number }>>
  delete(key: string): Promise<boolean>
}

export type DurableCandidate = {
  manifest: {
    schemaVersion: 1
    kind: 'durable-ranking-generation'
    createdAt: string
    identity: DurableIdentity
    identityHash: string
    stateRoot: string
    retention: { date: string; boundaries: string[] }
    parity: Record<string, unknown>
    audit: { key: string; digest: string; bytes: number }
    objects: Array<{ path: string; key: string; bytes: number; digest: string; category: string }>
  }
  manifestKey: string
  manifestDigest: string
  manifestBytes: number
  stateRoot: string
  identityHash: string
  metrics: { uploadedObjects: number; uploadedBytes: number; skippedObjects: number; skippedBytes: number }
}

export const DURABLE_STATE_SCHEMA_VERSION: 1
export const DEFAULT_DURABLE_PREFIX: 'private'
export function createRailwayDurableObjectStore(options: { config: unknown; client: unknown }): DurableObjectStore
export function createMemoryDurableObjectStore(): DurableObjectStore & {
  objects: Map<string, { bytes: Uint8Array; etag: string; metadata: Record<string, string> }>
  failures: { putAfter?: number; getKeys: Set<string>; deleteKeys: Set<string> }
}
export function stageDurableGeneration(options: {
  store: DurableObjectStore
  stateDir: string
  identity: DurableIdentity
  generatedAt: string
  retention?: { date: string; boundaries: string[] }
  parity?: Record<string, unknown>
  prefix?: string
}): Promise<DurableCandidate>
export function restoreDurableGeneration(options: {
  store: DurableObjectStore
  stateDir: string
  expectedIdentity: DurableIdentity
  activeKey?: string
}): Promise<Record<string, unknown> & { restored: boolean }>
export function promoteDurableGeneration(options: {
  store: DurableObjectStore
  candidate: DurableCandidate
  fencingToken: number
  generationId: string
  promotedAt: string
  parityOutcome?: { result: 'match' | 'mismatch'; audit?: boolean }
  activeKey?: string
  expectedActiveEtag?: string
}): Promise<Record<string, unknown> & { promoted: boolean }>
export function decideDurableCrunchMode(options: {
  requestedMode: 'full' | 'incremental-shadow' | 'incremental'
  identity: DurableIdentity
  activePointer?: Record<string, unknown>
  shadowThreshold?: number
  now: string
  auditIntervalMs?: number
  forceAudit?: boolean
}): { effectiveMode: 'full' | 'incremental-shadow' | 'incremental'; reason: string; activationEligible: boolean }
export function recordRolloutOutcome(previous: unknown, options: { identityHash: string; parity?: { result: 'match' | 'mismatch'; audit?: boolean }; at: string }): Record<string, unknown>
export function planDurableGc(options: { store: DurableObjectStore; activePointer?: Record<string, unknown>; now: string; recentDays?: number; prefix?: string }): Promise<Record<string, unknown> & { safe: boolean; plannedDeletes: Array<{ key: string; bytes: number; kind: string }> }>
export function executeDurableGc(options: { store: DurableObjectStore; plan: Record<string, unknown> & { safe: boolean; plannedDeletes: Array<{ key: string; bytes: number }>; reason?: string }; dryRun?: boolean }): Promise<Record<string, unknown>>
