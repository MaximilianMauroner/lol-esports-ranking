import type { BucketClient, BucketStorageConfig } from './railway-bucket.mjs'

export type InventoryError = { key: string; reason: string; message?: string }
export type RankingBucketInventory = {
  artifactKind: 'ranking-bucket-gc-inventory'
  schemaVersion: 1
  inventoryDate: string
  activePointer: { key: string; etag: string }
  policy: {
    retainAllGenerationDays: 14
    retainNewestGenerationCount: 50
    retainAuditDays: 14
    minimumDeleteAgeHours: 48
    generationCutoff: string
    auditCutoff: string
  }
  valid: boolean
  errors: InventoryError[]
  protected: Array<{ key: string; bytes: number; lastModified: string; reasons: string[] }>
  deletionCandidates: Array<{ key: string; bytes: number; lastModified: string; ageHours: number; reason: string }>
  danglingReferences: Array<{ key: string; reason: string }>
  missingReferences: Array<{ fromKey: string; referencedKey: string; reason: string }>
  totals: { objectCount: number; beforeBytes: number; protectedBytes: number; deletionCandidateBytes: number; estimatedAfterBytes: number }
  inventorySha256: string
}
export type GcDeletionReceipt = {
  artifactKind: 'ranking-bucket-gc-deletion-receipt'
  schemaVersion: 1
  inventorySha256: string
  activePointer: { key: string; etag: string }
  policy: RankingBucketInventory['policy']
  completedAt: string
  deleted: Array<{ key: string; bytes: number; lastModified: string; reason: string }>
  deletedBytes: number
  estimatedBeforeBytes: number
  estimatedAfterBytes: number
}
export type GcCliOptions = { delete: false } | { delete: true; approvedInventorySha256: string }

export function parseGcArgs(argv?: string[]): GcCliOptions
export function buildRankingBucketInventory(options: {
  config: BucketStorageConfig
  client: BucketClient
  now?: () => Date
}): Promise<RankingBucketInventory>
export function deleteApprovedRankingBucketInventory(options: {
  delete: true
  approvedInventorySha256: string
  config: BucketStorageConfig
  client: BucketClient
  now?: () => Date
  batchSize?: 1
  deleteTimeoutMs?: number
  buildInventory?: typeof buildRankingBucketInventory
  beforeFirstBatch?: (inventory: RankingBucketInventory) => void | Promise<void>
  betweenBatches?: (input: { inventory: RankingBucketInventory; offset: number; deleted: GcDeletionReceipt['deleted'] }) => void | Promise<void>
}): Promise<GcDeletionReceipt>
