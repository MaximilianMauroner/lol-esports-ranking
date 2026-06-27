import { snapshotKey } from './schema'
import type { PublicRankingManifest, PublicRankingShard, SnapshotFilter } from './schema'

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
  const embedded = data.snapshots[key]
  if (embedded) return { status: 'ready', snapshot: embedded }

  const cached = cache[key]
  if (cached) return cached

  if (key === data.defaultSnapshotKey) {
    return { status: 'missing', message: 'The default ranking snapshot is missing from the manifest.' }
  }

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
