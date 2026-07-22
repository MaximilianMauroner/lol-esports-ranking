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
    affectedLogicalPaths,
    previousArtifacts,
  }: {
    fullSnapshotUrl?: string
    urlForPath?: (relativePath: string) => string
    /** Optional dependency plan; omitted for the authoritative full writer. */
    affectedLogicalPaths?: ReadonlySet<string>
    /** Verified semantic values from the active generation, used to merge partial indexes. */
    previousArtifacts?: Readonly<Record<string, unknown>>
  } = {},
): PublicArtifactWritePlan {
  const artifactVersion = runIdForArtifact({
    generatedAt: data.generatedAt,
    modelVersion: data.model.version,
    modelConfigHash: data.model.configHash,
  })
  const versionedUrlForPath = (relativePath: string) => withArtifactVersion(urlForPath(relativePath), artifactVersion)
  const selected = (relativePath: string) => !affectedLogicalPaths || affectedLogicalPaths.has(relativePath)
  const selectedFamily = (indexPath: string, prefix: string) => !affectedLogicalPaths
    || selected(indexPath)
    || [...affectedLogicalPaths].some((path) => path.startsWith(`${prefix}/`))
  const previous = (relativePath: string) => previousArtifacts?.[`/data/${relativePath}`]
  const playerDirectory = selected(PUBLIC_ARTIFACT_PATHS.players) ? createPlayerDirectory(data) : undefined
  const teamDirectory = selected(PUBLIC_ARTIFACT_PATHS.teams) ? createTeamDirectory(data) : undefined
  const teamHistory = selectedFamily(PUBLIC_ARTIFACT_PATHS.teamHistoryIndex, PUBLIC_ARTIFACT_PATHS.teamHistoryShardDir)
    ? createTeamHistoryArtifacts(data, {
        teamHistoryUrlForKey: (key) => versionedUrlForPath(publicTeamHistoryShardPath(key)),
      })
    : undefined
  const regionHistory = selected(PUBLIC_ARTIFACT_PATHS.regionHistory) ? createRegionHistory(data) : undefined
  const tournamentMovements = selectedFamily(PUBLIC_ARTIFACT_PATHS.tournamentMovementIndex, PUBLIC_ARTIFACT_PATHS.tournamentMovementShardDir)
    ? createTournamentMovementArtifacts(data, {
        tournamentMovementUrlForId: (id) => versionedUrlForPath(publicTournamentMovementShardPath(id)),
      })
    : undefined
  const matchHistory = selectedFamily(PUBLIC_ARTIFACT_PATHS.matchHistoryIndex, PUBLIC_ARTIFACT_PATHS.matchHistoryShardDir)
    ? createMatchHistoryArtifacts(data, {
        matchHistoryCatalogUrlForKey: (key) => versionedUrlForPath(publicMatchHistoryShardPath(key)),
        matchHistoryPageUrlForKey: (key, page) => versionedUrlForPath(publicMatchHistoryPagePath(key, page)),
      })
    : undefined
  const summary = createStaticRankingSummaryData(data, {
    fullSnapshotUrl,
    playerDirectoryUrl: versionedUrlForPath(PUBLIC_ARTIFACT_PATHS.players),
    teamDirectoryUrl: versionedUrlForPath(PUBLIC_ARTIFACT_PATHS.teams),
    teamHistoryIndexUrl: versionedUrlForPath(PUBLIC_ARTIFACT_PATHS.teamHistoryIndex),
    regionHistoryUrl: versionedUrlForPath(PUBLIC_ARTIFACT_PATHS.regionHistory),
    tournamentMovementIndexUrl: versionedUrlForPath(PUBLIC_ARTIFACT_PATHS.tournamentMovementIndex),
    matchHistoryIndexUrl: versionedUrlForPath(PUBLIC_ARTIFACT_PATHS.matchHistoryIndex),
    snapshotUrlForKey: (key) => versionedUrlForPath(publicScopeArtifactPath(key)),
  })
  const mergedSummaryManifest = mergeRecordIndex(summary.manifest, previous(PUBLIC_ARTIFACT_PATHS.manifest), 'snapshotIndex')
  const mergedTeamHistoryIndex = teamHistory ? mergeRecordIndex(teamHistory.index, previous(PUBLIC_ARTIFACT_PATHS.teamHistoryIndex), 'scopeIndex') : undefined
  const mergedMatchHistoryIndex = matchHistory ? mergeRecordIndex(matchHistory.index, previous(PUBLIC_ARTIFACT_PATHS.matchHistoryIndex), 'scopeIndex') : undefined
  const mergedTournamentMovementIndex = tournamentMovements ? mergeArrayIndex(tournamentMovements.index, previous(PUBLIC_ARTIFACT_PATHS.tournamentMovementIndex), 'tournaments', 'id') : undefined

  const allWrites: PublicArtifactWrite[] = [
    ...(playerDirectory ? [write('entity', PUBLIC_ARTIFACT_PATHS.players, playerDirectory, parsePublicPlayerDirectory)] : []),
    ...(teamDirectory ? [write('entity', PUBLIC_ARTIFACT_PATHS.teams, teamDirectory, parsePublicTeamDirectory)] : []),
    ...(selected(PUBLIC_ARTIFACT_PATHS.teamHistoryIndex) && mergedTeamHistoryIndex ? [write('history', PUBLIC_ARTIFACT_PATHS.teamHistoryIndex, mergedTeamHistoryIndex, parsePublicTeamHistoryIndex)] : []),
    ...Object.entries(teamHistory?.shards ?? {}).map(([key, shard]) => (
      write('history', publicTeamHistoryShardPath(key), shard, parsePublicTeamHistoryShard)
    )),
    ...(regionHistory ? [write('history', PUBLIC_ARTIFACT_PATHS.regionHistory, regionHistory, parsePublicRegionHistory)] : []),
    ...(selected(PUBLIC_ARTIFACT_PATHS.tournamentMovementIndex) && mergedTournamentMovementIndex ? [write('history', PUBLIC_ARTIFACT_PATHS.tournamentMovementIndex, mergedTournamentMovementIndex, parsePublicTournamentMovementIndex)] : []),
    ...Object.entries(tournamentMovements?.shards ?? {}).map(([id, shard]) => (
      write('history', publicTournamentMovementShardPath(id as TournamentInstanceId), shard, parsePublicTournamentMovementShard)
    )),
    ...(selected(PUBLIC_ARTIFACT_PATHS.matchHistoryIndex) && mergedMatchHistoryIndex ? [write('history', PUBLIC_ARTIFACT_PATHS.matchHistoryIndex, mergedMatchHistoryIndex, parsePublicMatchHistoryIndex)] : []),
    ...Object.entries(matchHistory?.catalogs ?? {}).map(([key, catalog]) => (
      write('history', publicMatchHistoryShardPath(key), catalog, parsePublicMatchHistoryCatalog)
    )),
    ...Object.entries(matchHistory?.pages ?? {}).flatMap(([key, pages]) => Object.entries(pages).map(([page, shard]) => (
      write('history', publicMatchHistoryPagePath(key, Number(page)), shard, parsePublicMatchHistoryPage)
    ))),
    ...Object.entries(summary.snapshots).map(([key, snapshot]) => (
      write('scope', publicScopeArtifactPath(key), snapshot, parsePublicRankingShard)
    )),
    ...(selected(PUBLIC_ARTIFACT_PATHS.manifest) ? [write('manifest', PUBLIC_ARTIFACT_PATHS.manifest, mergedSummaryManifest, parsePublicRankingManifest, true)] : []),
  ]

  assertPublicArtifactBudgets(allWrites, data.defaultSnapshotKey)
  const writes = affectedLogicalPaths
    ? allWrites.filter((entry) => affectedLogicalPaths.has(entry.relativePath))
    : allWrites

  return {
    manifest: mergedSummaryManifest,
    snapshots: summary.snapshots,
    writes,
    budgets: PUBLIC_ARTIFACT_BUDGETS,
  }
}

function mergeRecordIndex<T extends Record<string, unknown>>(current: T, previous: unknown, key: string): T {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return current
  const before = (previous as Record<string, unknown>)[key]
  const after = current[key]
  if (!before || typeof before !== 'object' || Array.isArray(before)
    || !after || typeof after !== 'object' || Array.isArray(after)) return current
  return { ...current, [key]: { ...(before as Record<string, unknown>), ...(after as Record<string, unknown>) } }
}

function mergeArrayIndex<T extends Record<string, unknown>>(current: T, previous: unknown, key: string, identityKey: string): T {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return current
  const before = (previous as Record<string, unknown>)[key]
  const after = current[key]
  if (!Array.isArray(before) || !Array.isArray(after)) return current
  const merged = new Map<string, unknown>()
  for (const entry of [...before, ...after]) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const identity = (entry as Record<string, unknown>)[identityKey]
      if (typeof identity === 'string') merged.set(identity, entry)
    }
  }
  return { ...current, [key]: [...merged.values()] }
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
