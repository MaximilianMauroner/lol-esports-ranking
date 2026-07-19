export type DurableIdentity = {
  compatibilityHash: string
  pipelineVersion: string
  codeHash: string
  modelVersion: string
  modelConfigHash: string
}

export type DurableObjectStore = {
  get(key: string): Promise<{ found: boolean; key?: string; etag?: string; bytes?: Uint8Array; contentLength?: number; metadata?: Record<string, string> }>
  head(key: string): Promise<{ found: boolean; key?: string; etag?: string; contentLength?: number; metadata?: Record<string, string>; storageVerifiedSha256?: string }>
  put(key: string, bytes: Uint8Array, options?: { ifMatch?: string; ifAbsent?: boolean; metadata?: Record<string, string>; contentType?: string }): Promise<{ written: boolean; conflict?: boolean; key?: string; etag?: string; bytes?: number }>
  list(prefix: string): Promise<Array<{ key: string; bytes: number }>>
  delete(key: string): Promise<boolean>
}

export type DurableCandidate = {
  eligibility: 'eligible'
  outcome: string
  manifest: {
    schemaVersion: 1
    kind: 'durable-ranking-generation'
    createdAt: string
    identity: DurableIdentity
    identityHash: string
    stateRoot: string
    eligibility: 'eligible'
    outcome: string
    semanticState: Record<string, unknown>
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
  outcome?: string
  stateSummary?: Record<string, unknown>
  reachablePaths?: string[]
  retention?: { date: string; boundaries: string[] }
  parity?: Record<string, unknown>
  prefix?: string
}): Promise<DurableCandidate>
export function restoreDurableGeneration(options: {
  store: DurableObjectStore
  stateDir: string
  expectedIdentity: DurableIdentity
  validateStateDir?: (stateDir: string, expectedIdentity: DurableIdentity) => Promise<{ stateRoot: string; compatibilityHash: string }>
  fsOps?: {
    writeFile?: (path: string, bytes: Uint8Array) => Promise<unknown>
    rename?: (from: string, to: string) => Promise<unknown>
  }
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
export function planDurableGc(options: { store: DurableObjectStore; activePointer?: Record<string, unknown>; activeEtag?: string; activeKey?: string; now: string; recentDays?: number; stagingGraceMs?: number; prefix?: string }): Promise<Record<string, unknown> & { safe: boolean; plannedDeletes: Array<{ key: string; bytes: number; kind: string }> }>
export function executeDurableGc(options: { store: DurableObjectStore; plan: Record<string, unknown> & { safe: boolean; plannedDeletes: Array<{ key: string; bytes: number }>; reason?: string }; dryRun?: boolean; beforeDelete?: (entry: { key: string; bytes: number }) => Promise<void> }): Promise<Record<string, unknown>>
export function executeRailwayDurableGc(options: { store: DurableObjectStore; plan: Record<string, unknown> & { safe: boolean; plannedDeletes: Array<{ key: string; bytes: number }>; reason?: string }; dryRun?: boolean; maintenanceGuard?: { owner: string; fencingToken: number }; bucketConfig?: unknown; bucketClient?: unknown; beforeAuthorityCheck?: () => Promise<void>; beforeDelete?: (entry: { key: string; bytes: number }) => Promise<void>; replan?: () => Promise<Record<string, unknown> & { safe: boolean; plannedDeletes: Array<{ key: string; bytes: number }>; reason?: string }> }): Promise<Record<string, unknown>>
