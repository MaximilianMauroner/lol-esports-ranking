import { parsePublicRankingShard, snapshotKey } from './schema'
import { fetchPublicArtifact } from './artifactIdentity'
import type {
  PublicRankingManifest,
  PublicRankingShard,
  PublicTeamHistoryIndex,
  PublicTeamHistoryShard,
  PublicTournamentMovementIndex,
  PublicTournamentMovementIndexEntry,
  PublicTournamentMovementShard,
  SnapshotFilter,
} from './schema'

export type PublicSnapshotCacheEntry =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: PublicRankingShard }
  | { status: 'missing'; message: string }
  | { status: 'error'; message: string }

export type PublicSnapshotState = PublicSnapshotCacheEntry

export async function fetchPublicSnapshotShard(
  url: string,
  key: string,
  expected: PublicRankingManifest['snapshotIndex'][string],
  manifest: PublicRankingManifest,
  {
    signal,
    fetcher = fetch,
  }: {
    signal?: AbortSignal
    fetcher?: typeof fetch
  } = {},
): Promise<PublicRankingShard> {
  let validationError: unknown

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const shard = await fetchPublicArtifact(
        manifest,
        attempt === 0 ? url : cacheRepairUrl(url),
        url,
        parsePublicRankingShard,
        { fetcher, signal, ...(attempt === 1 ? { cache: 'reload' as const } : {}) },
      )
      validatePublicSnapshotShard(key, expected, shard, manifest)
      return shard
    } catch (error) {
      validationError = error
    }
  }

  throw validationError
}

function cacheRepairUrl(url: string) {
  return `${url}${url.includes('?') ? '&' : '?'}cache-repair=${Date.now()}`
}

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

export function validatePublicTournamentMovementIndex(
  index: PublicTournamentMovementIndex,
  manifest: PublicRankingManifest,
) {
  if (index.modelVersion !== manifest.model.version) {
    throw new Error('Tournament movement index modelVersion mismatch')
  }
  if (index.modelConfigHash !== manifest.model.configHash) {
    throw new Error('Tournament movement index modelConfigHash mismatch')
  }
  if (index.generatedAt !== manifest.generatedAt) {
    throw new Error('Tournament movement index generatedAt mismatch')
  }
  if (manifest.artifactMeta && index.artifactMeta.runId !== manifest.artifactMeta.runId) {
    throw new Error('Tournament movement index runId mismatch')
  }
}

export function validatePublicTournamentMovementShard(
  expected: PublicTournamentMovementIndexEntry,
  shard: PublicTournamentMovementShard,
  index: PublicTournamentMovementIndex,
) {
  if (shard.id !== expected.id) throw new Error(`Tournament movement shard id mismatch for ${expected.id}`)
  if (shard.modelVersion !== index.modelVersion) throw new Error(`Tournament movement shard modelVersion mismatch for ${expected.id}`)
  if (shard.modelConfigHash !== index.modelConfigHash) throw new Error(`Tournament movement shard modelConfigHash mismatch for ${expected.id}`)
  if (shard.generatedAt !== index.generatedAt) throw new Error(`Tournament movement shard generatedAt mismatch for ${expected.id}`)
  if (shard.artifactMeta.runId !== index.artifactMeta.runId) throw new Error(`Tournament movement shard runId mismatch for ${expected.id}`)
  if (shard.participantCount !== expected.participantCount) throw new Error(`Tournament movement shard participantCount mismatch for ${expected.id}`)
  for (const key of ['family', 'season', 'label', 'status', 'startDate', 'boundaryDate', 'ratedThroughDate', 'scheduledEndDate', 'dataLag'] as const) {
    if (shard[key] !== expected[key]) throw new Error(`Tournament movement shard ${key} mismatch for ${expected.id}`)
  }
}
