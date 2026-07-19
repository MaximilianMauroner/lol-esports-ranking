import {
  createPlayerDirectory,
  createRegionHistory,
  createMatchHistoryArtifacts,
  createStaticRankingSummaryData,
  createTeamDirectory,
  createTeamHistoryArtifacts,
  createTournamentMovementArtifacts,
} from '../snapshot'
import {
  parsePublicPlayerDirectory,
  parsePublicRankingManifest,
  parsePublicRankingShard,
  parsePublicRegionHistory,
  parsePublicMatchHistoryCatalog,
  parsePublicMatchHistoryIndex,
  parsePublicMatchHistoryPage,
  parsePublicTeamDirectory,
  parsePublicTeamHistoryIndex,
  parsePublicTeamHistoryShard,
  parsePublicTournamentMovementIndex,
  parsePublicTournamentMovementShard,
  runIdForArtifact,
  scopeArtifactFileNameForKey,
  teamHistoryShardFileName,
  tournamentMovementShardFileName,
} from './schema'
import type { TournamentInstanceId } from '../internationalTournaments'
import type { CrunchRunMetadata } from '../incremental/types'

type StaticRankingData = Parameters<typeof createStaticRankingSummaryData>[0]

export type PublicArtifactWrite = {
  family: 'manifest' | 'scope' | 'entity' | 'history'
  relativePath: string
  url: string
  value: unknown
  contents: string
  validate: (value: unknown) => unknown
}

export type PublicArtifactWritePlan = {
  manifest: ReturnType<typeof createStaticRankingSummaryData>['manifest']
  snapshots: ReturnType<typeof createStaticRankingSummaryData>['snapshots']
  writes: PublicArtifactWrite[]
  budgets: typeof PUBLIC_ARTIFACT_BUDGETS
}

export const PUBLIC_ARTIFACT_BUDGETS = {
  manifestBytes: 250_000,
  defaultScopeBytes: 1_000_000,
  playersBytes: 1_100_000,
  totalPublicDataBytes: 25_000_000,
} as const

export const PUBLIC_ARTIFACT_PATHS = {
  manifest: 'ranking-summary.json',
  players: 'entities/players.json',
  teams: 'entities/teams.json',
  teamHistory: 'history/team-series.json',
  teamHistoryIndex: 'history/team-series/index.json',
  teamHistoryShardDir: 'history/team-series',
  regionHistory: 'history/region-series.json',
  tournamentMovementIndex: 'history/tournament-moves/index.json',
  tournamentMovementShardDir: 'history/tournament-moves',
  matchHistoryIndex: 'matches/index.json',
  matchHistoryShardDir: 'matches',
  matchHistoryPageDir: 'matches/pages',
  scopeDir: 'scopes',
} as const

export function localPublicDataUrl(relativePath: string) {
  return `/data/${relativePath}`
}

export function versionedPublicDataUrl(relativePath: string, version: string) {
  return `${localPublicDataUrl(relativePath)}?v=${encodeURIComponent(version)}`
}

export function publicScopeArtifactPath(key: string) {
  return `${PUBLIC_ARTIFACT_PATHS.scopeDir}/${scopeArtifactFileNameForKey(key)}`
}

export function publicTeamHistoryShardPath(key: string) {
  return `${PUBLIC_ARTIFACT_PATHS.teamHistoryShardDir}/${encodeURIComponent(teamHistoryShardFileName(key))}`
}

export function publicTournamentMovementShardPath(id: TournamentInstanceId) {
  return `${PUBLIC_ARTIFACT_PATHS.tournamentMovementShardDir}/${tournamentMovementShardFileName(id)}`
}

export function publicMatchHistoryShardPath(key: string) {
  return `${PUBLIC_ARTIFACT_PATHS.matchHistoryShardDir}/${scopeArtifactFileNameForKey(key)}`
}

export function publicMatchHistoryPagePath(key: string, page: number) {
  return `${PUBLIC_ARTIFACT_PATHS.matchHistoryPageDir}/${scopeArtifactFileNameForKey(key).replace(/\.json$/, '')}-${page}.json`
}

export function createPublicArtifactWritePlan(
  data: StaticRankingData,
  {
    fullSnapshotUrl,
    urlForPath = localPublicDataUrl,
    runMetadata,
  }: {
    fullSnapshotUrl?: string
    urlForPath?: (relativePath: string) => string
    runMetadata?: CrunchRunMetadata
  } = {},
): PublicArtifactWritePlan {
  const artifactVersion = runMetadata?.runId ?? runIdForArtifact({
    generatedAt: data.generatedAt,
    modelVersion: data.model.version,
    modelConfigHash: data.model.configHash,
  })
  const versionedUrlForPath = (relativePath: string) => withArtifactVersion(urlForPath(relativePath), artifactVersion)
  const playerDirectory = createPlayerDirectory(data, { runMetadata })
  const teamDirectory = createTeamDirectory(data, { runMetadata })
  const teamHistory = createTeamHistoryArtifacts(data, {
    teamHistoryUrlForKey: (key) => versionedUrlForPath(publicTeamHistoryShardPath(key)),
    runMetadata,
  })
  const regionHistory = createRegionHistory(data, { runMetadata })
  const tournamentMovements = createTournamentMovementArtifacts(data, {
    tournamentMovementUrlForId: (id) => versionedUrlForPath(publicTournamentMovementShardPath(id)),
    runMetadata,
  })
  const matchHistory = createMatchHistoryArtifacts(data, {
    matchHistoryCatalogUrlForKey: (key) => versionedUrlForPath(publicMatchHistoryShardPath(key)),
    matchHistoryPageUrlForKey: (key, page) => versionedUrlForPath(publicMatchHistoryPagePath(key, page)),
    runMetadata,
  })
  const summary = createStaticRankingSummaryData(data, {
    fullSnapshotUrl,
    playerDirectoryUrl: versionedUrlForPath(PUBLIC_ARTIFACT_PATHS.players),
    teamDirectoryUrl: versionedUrlForPath(PUBLIC_ARTIFACT_PATHS.teams),
    teamHistoryIndexUrl: versionedUrlForPath(PUBLIC_ARTIFACT_PATHS.teamHistoryIndex),
    regionHistoryUrl: versionedUrlForPath(PUBLIC_ARTIFACT_PATHS.regionHistory),
    tournamentMovementIndexUrl: versionedUrlForPath(PUBLIC_ARTIFACT_PATHS.tournamentMovementIndex),
    matchHistoryIndexUrl: versionedUrlForPath(PUBLIC_ARTIFACT_PATHS.matchHistoryIndex),
    snapshotUrlForKey: (key) => versionedUrlForPath(publicScopeArtifactPath(key)),
    runMetadata,
  })

  const writes: PublicArtifactWrite[] = [
    write('entity', PUBLIC_ARTIFACT_PATHS.players, playerDirectory, parsePublicPlayerDirectory),
    write('entity', PUBLIC_ARTIFACT_PATHS.teams, teamDirectory, parsePublicTeamDirectory),
    write('history', PUBLIC_ARTIFACT_PATHS.teamHistoryIndex, teamHistory.index, parsePublicTeamHistoryIndex),
    ...Object.entries(teamHistory.shards).map(([key, shard]) => (
      write('history', publicTeamHistoryShardPath(key), shard, parsePublicTeamHistoryShard)
    )),
    write('history', PUBLIC_ARTIFACT_PATHS.regionHistory, regionHistory, parsePublicRegionHistory),
    write('history', PUBLIC_ARTIFACT_PATHS.tournamentMovementIndex, tournamentMovements.index, parsePublicTournamentMovementIndex),
    ...Object.entries(tournamentMovements.shards).map(([id, shard]) => (
      write('history', publicTournamentMovementShardPath(id as TournamentInstanceId), shard, parsePublicTournamentMovementShard)
    )),
    write('history', PUBLIC_ARTIFACT_PATHS.matchHistoryIndex, matchHistory.index, parsePublicMatchHistoryIndex),
    ...Object.entries(matchHistory.catalogs).map(([key, catalog]) => (
      write('history', publicMatchHistoryShardPath(key), catalog, parsePublicMatchHistoryCatalog)
    )),
    ...Object.entries(matchHistory.pages).flatMap(([key, pages]) => Object.entries(pages).map(([page, shard]) => (
      write('history', publicMatchHistoryPagePath(key, Number(page)), shard, parsePublicMatchHistoryPage)
    ))),
    ...Object.entries(summary.snapshots).map(([key, snapshot]) => (
      write('scope', publicScopeArtifactPath(key), snapshot, parsePublicRankingShard)
    )),
    write('manifest', PUBLIC_ARTIFACT_PATHS.manifest, summary.manifest, parsePublicRankingManifest, true),
  ]

  assertPublicArtifactBudgets(writes, data.defaultSnapshotKey)

  return {
    manifest: summary.manifest,
    snapshots: summary.snapshots,
    writes,
    budgets: PUBLIC_ARTIFACT_BUDGETS,
  }
}

const semanticEnvelopeGeneratedAt = '1970-01-01T00:00:00.000Z'
const semanticEnvelopeRunId = 'semantic-public-artifact-v1'

/** Rehydrates known public run envelopes with constants so DAG hashes contain domain semantics only. */
export function createSemanticPublicArtifactWritePlan(data: StaticRankingData): PublicArtifactWritePlan {
  const normalized: StaticRankingData = {
    ...data,
    generatedAt: semanticEnvelopeGeneratedAt,
    tournamentMovements: Object.fromEntries(Object.entries(data.tournamentMovements).map(([id, shard]) => [id, {
      ...shard,
      generatedAt: semanticEnvelopeGeneratedAt,
      artifactMeta: {
        ...shard.artifactMeta,
        generatedAt: semanticEnvelopeGeneratedAt,
        runId: semanticEnvelopeRunId,
      },
    }])) as StaticRankingData['tournamentMovements'],
  }
  return createPublicArtifactWritePlan(normalized, {
    runMetadata: { generatedAt: semanticEnvelopeGeneratedAt, runId: semanticEnvelopeRunId },
  })
}

function withArtifactVersion(url: string, version: string) {
  if (!url.startsWith('/data/')) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}v=${encodeURIComponent(version)}`
}

export function assertPublicArtifactBudgets(writes: PublicArtifactWrite[], defaultSnapshotKey: string) {
  const total = writes.reduce((sum, entry) => sum + byteLength(entry.contents), 0)
  const manifest = writes.find((entry) => entry.relativePath === PUBLIC_ARTIFACT_PATHS.manifest)
  const players = writes.find((entry) => entry.relativePath === PUBLIC_ARTIFACT_PATHS.players)
  const defaultScope = writes.find((entry) => entry.relativePath === publicScopeArtifactPath(defaultSnapshotKey))

  if (manifest && byteLength(manifest.contents) > PUBLIC_ARTIFACT_BUDGETS.manifestBytes) {
    throw new Error(`Public manifest budget exceeded: ${byteLength(manifest.contents)} bytes > ${PUBLIC_ARTIFACT_BUDGETS.manifestBytes} bytes`)
  }
  if (players && byteLength(players.contents) > PUBLIC_ARTIFACT_BUDGETS.playersBytes) {
    throw new Error(`Public players budget exceeded: ${byteLength(players.contents)} bytes > ${PUBLIC_ARTIFACT_BUDGETS.playersBytes} bytes`)
  }
  if (defaultScope && byteLength(defaultScope.contents) > PUBLIC_ARTIFACT_BUDGETS.defaultScopeBytes) {
    throw new Error(`Default ranking scope budget exceeded: ${byteLength(defaultScope.contents)} bytes > ${PUBLIC_ARTIFACT_BUDGETS.defaultScopeBytes} bytes`)
  }
  if (total > PUBLIC_ARTIFACT_BUDGETS.totalPublicDataBytes) {
    throw new Error(`Public data budget exceeded: ${total} bytes > ${PUBLIC_ARTIFACT_BUDGETS.totalPublicDataBytes} bytes`)
  }
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length
}

function write(
  family: PublicArtifactWrite['family'],
  relativePath: string,
  value: unknown,
  validate: (value: unknown) => unknown,
  pretty = false,
): PublicArtifactWrite {
  return {
    family,
    relativePath,
    url: localPublicDataUrl(relativePath),
    value,
    contents: `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`,
    validate,
  }
}
