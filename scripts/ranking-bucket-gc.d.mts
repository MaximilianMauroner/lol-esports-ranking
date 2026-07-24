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
export type GcCliOptions = Record<string, never>

export function parseGcArgs(argv?: string[]): GcCliOptions
export function buildRankingBucketInventory(options: {
  config: BucketStorageConfig
  client: BucketClient
  now?: () => Date
}): Promise<RankingBucketInventory>
