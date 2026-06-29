import { snapshotKey } from './schema'
import type { PublicRankingManifest, PublicRankingShard, PublicTeamHistoryIndex, PublicTeamHistoryShard, SnapshotFilter } from './schema'

export type PublicSnapshotCacheEntry =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: PublicRankingShard }
  | { status: 'missing'; message: string }
  | { status: 'error'; message: string }

export type PublicSnapshotState = PublicSnapshotCacheEntry

export function resolvePublicSnapshotState(
  data: PublicRankingManifest | undefined,
  filter: SnapshotFilter,
  cache: Record<string, PublicSnapshotCacheEntry>,
): PublicSnapshotState {
  if (!data) return { status: 'loading' }

  const key = snapshotKey(filter)
  const cached = cache[key]
  if (cached?.status === 'ready') return cached

  const embedded = data.snapshots?.[key]
  if (embedded) return { status: 'ready', snapshot: embedded }

  if (cached) return cached

  if (!data.snapshotIndex[key]) {
    return { status: 'missing', message: 'No generated snapshot exists for the selected scope.' }
  }

  return { status: 'loading' }
}

export function validatePublicSnapshotShard(
  key: string,
  expected: PublicRankingManifest['snapshotIndex'][string],
  shard: PublicRankingShard,
  manifest: PublicRankingManifest,
) {
  const actualKey = snapshotKey(shard.filter)
  if (actualKey !== key) {
    throw new Error(`Filtered snapshot key mismatch: expected ${key}, got ${actualKey}`)
  }
  if (shard.modelVersion !== manifest.model.version) {
    throw new Error(`Filtered snapshot modelVersion mismatch for ${key}`)
  }
  if (shard.modelConfigHash !== manifest.model.configHash) {
    throw new Error(`Filtered snapshot modelConfigHash mismatch for ${key}`)
  }
  if (shard.matchCount !== expected.matchCount) {
    throw new Error(`Filtered snapshot matchCount mismatch for ${key}`)
  }
  if (JSON.stringify(shard.filter) !== JSON.stringify(expected.filter)) {
    throw new Error(`Filtered snapshot filter mismatch for ${key}`)
  }
}

export function validatePublicTeamHistoryShard(
  key: string,
  expected: PublicTeamHistoryIndex['scopeIndex'][string],
  shard: PublicTeamHistoryShard,
  index: PublicTeamHistoryIndex,
) {
  const actualKey = snapshotKey(shard.filter)
  if (actualKey !== key) {
    throw new Error(`Team history shard key mismatch: expected ${key}, got ${actualKey}`)
  }
  if (shard.modelVersion !== index.modelVersion) {
    throw new Error(`Team history shard modelVersion mismatch for ${key}`)
  }
  if (shard.modelConfigHash !== index.modelConfigHash) {
    throw new Error(`Team history shard modelConfigHash mismatch for ${key}`)
  }
  if (shard.generatedAt !== index.generatedAt) {
    throw new Error(`Team history shard generatedAt mismatch for ${key}`)
  }
  if (shard.teamCount !== expected.teamCount) {
    throw new Error(`Team history shard teamCount mismatch for ${key}`)
  }
  if (shard.pointCount !== expected.pointCount) {
    throw new Error(`Team history shard pointCount mismatch for ${key}`)
  }
  if (JSON.stringify(shard.filter) !== JSON.stringify(expected.filter)) {
    throw new Error(`Team history shard filter mismatch for ${key}`)
  }
}
