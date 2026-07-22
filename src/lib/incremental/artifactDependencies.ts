import type { MatchRecord } from '../../types'
import type { SnapshotFilter } from '../snapshot'
import { changedSemanticArtifactPaths, type SemanticArtifactMap } from './semanticParity'
import { compareCodeUnits, type RankingChangeKind } from './types'

export type ArtifactScopeDependency = {
  key: string
  filter: SnapshotFilter
  rankingPath: string
  matchCatalogPath: string
  matchPages: readonly {
    path: string
    seriesIds: readonly string[]
    startUtcDate?: string
    endUtcDate?: string
  }[]
}

export type PublicArtifactDependencyInventory = {
  manifestPath: string
  playerDirectoryPath: string
  teamDirectoryPath: string
  regionHistoryPath: string
  teamHistoryIndexPath: string
  tournamentMovementIndexPath: string
  matchHistoryIndexPath: string
  scopes: readonly ArtifactScopeDependency[]
  teamHistoryPaths: Readonly<Record<string, readonly string[]>>
  playerPaths?: Readonly<Record<string, readonly string[]>>
  tournamentMovementPaths: Readonly<Record<string, string>>
}

export type PublicArtifactChange = {
  before?: MatchRecord
  after?: MatchRecord
  playerIds?: readonly string[]
  tournamentIds?: readonly string[]
  metadataOnly?: boolean
  rollingBaselineChanged?: boolean
  kind?: RankingChangeKind
}

export type AffectedPublicArtifactPlan = {
  logicalPaths: string[]
  reasonsByLogicalPath: Record<string, string[]>
}

/** Central dependency graph used by the incremental writer before activation. */
export function affectedPublicArtifacts({
  changes,
  inventory,
  previousSemanticArtifacts,
  currentSemanticArtifacts,
}: {
  changes: readonly PublicArtifactChange[]
  inventory: PublicArtifactDependencyInventory
  previousSemanticArtifacts?: SemanticArtifactMap
  currentSemanticArtifacts?: SemanticArtifactMap
}): AffectedPublicArtifactPlan {
  const reasons = new Map<string, Set<string>>()
  const add = (path: string, reason: string) => {
    const entries = reasons.get(path) ?? new Set<string>()
    entries.add(reason)
    reasons.set(path, entries)
  }
  if (changes.length === 0) return { logicalPaths: [], reasonsByLogicalPath: {} }
  add(inventory.manifestPath, 'generation-provenance')

  for (const change of changes) {
    if (change.metadataOnly) {
      add(inventory.manifestPath, 'metadata')
      continue
    }
    const matches = [change.before, change.after].filter(isMatch)
    const teams = new Set(matches.flatMap((match) => [match.teamA, match.teamB]))
    const seriesIds = new Set(matches.flatMap((match) => [
      match.officialMatchId,
      match.sourceMatchId,
      match.id,
    ].filter(isString)))
    add(inventory.playerDirectoryPath, 'player-and-roster-state')
    add(inventory.teamDirectoryPath, 'team-state')
    add(inventory.regionHistoryPath, 'region-and-rolling-baseline')
    add(inventory.teamHistoryIndexPath, 'team-history-index')
    add(inventory.matchHistoryIndexPath, 'match-history-index')
    if (change.tournamentIds?.length) add(inventory.tournamentMovementIndexPath, 'tournament-movement-index')

    for (const team of teams) {
      for (const path of inventory.teamHistoryPaths[team] ?? []) add(path, `team:${team}`)
    }
    for (const playerId of change.playerIds ?? []) {
      for (const path of inventory.playerPaths?.[playerId] ?? []) add(path, `player:${playerId}`)
    }
    for (const tournamentId of change.tournamentIds ?? []) {
      const path = inventory.tournamentMovementPaths[tournamentId]
      if (path) add(path, `tournament:${tournamentId}`)
    }
    for (const scope of inventory.scopes) {
      if (!matches.some((match) => matchTouchesScope(match, scope.filter))) continue
      add(scope.rankingPath, `scope:${scope.key}`)
      add(scope.matchCatalogPath, `match-catalog:${scope.key}`)
      const matchedPageIndexes = scope.matchPages.flatMap((page, index) => (
        page.seriesIds.some((id) => [...seriesIds].some((candidate) => seriesIdMatches(id, candidate))) ? [index] : []
      ))
      const earliestMatchDate = matches.map((match) => match.date).sort(compareCodeUnits)[0]
      const datedPageIndex = earliestMatchDate
        ? scope.matchPages.findIndex((page) => page.endUtcDate !== undefined && page.endUtcDate >= earliestMatchDate)
        : -1
      const firstAffectedPage = matchedPageIndexes[0] ?? (datedPageIndex >= 0 ? datedPageIndex : scope.matchPages.length - 1)
      const pages = change.kind === 'latest-append'
        ? scope.matchPages.slice(-1)
        : scope.matchPages.slice(Math.max(0, firstAffectedPage))
      for (const page of pages) add(page.path, `match-page:${scope.key}`)
    }
    if (change.rollingBaselineChanged) add(inventory.regionHistoryPath, 'rolling-baseline')
  }

  const semanticChanges = previousSemanticArtifacts && currentSemanticArtifacts
    ? changedSemanticArtifactPaths(previousSemanticArtifacts, currentSemanticArtifacts)
    : undefined
  if (semanticChanges) {
    for (const path of semanticChanges) {
      add(path, 'semantic-digest-changed')
    }
  }
  // During shadow verification the semantic diff is authoritative. Returning
  // exactly that set prevents conservative graph overreach from becoming
  // unnecessary uploads while still retaining graph reasons for diagnosis.
  const logicalPaths = semanticChanges ?? [...reasons.keys()].sort(compareCodeUnits)
  return {
    logicalPaths,
    reasonsByLogicalPath: Object.fromEntries(logicalPaths.map((path) => [path, [...reasons.get(path)!].sort(compareCodeUnits)])),
  }
}

export function assertArtifactDependencyPlanMatchesSemanticChanges(
  plan: AffectedPublicArtifactPlan,
  previous: SemanticArtifactMap,
  current: SemanticArtifactMap,
) {
  const expected = changedSemanticArtifactPaths(previous, current)
  const actual = plan.logicalPaths
  const missing = expected.filter((path) => !actual.includes(path))
  const unexpected = actual.filter((path) => !expected.includes(path))
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`Artifact dependency plan differs from semantic changes; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`)
  }
  return { expected, covered: actual }
}

function matchTouchesScope(match: MatchRecord, filter: SnapshotFilter) {
  if (filter.season !== 'All' && Number(filter.season) !== match.season) return false
  if (filter.event !== 'All' && filter.event !== match.event) return false
  if (filter.region !== 'All'
    && filter.region !== match.region
    && filter.region !== match.teamARegion
    && filter.region !== match.teamBRegion) return false
  // Checkpoint scopes are conservatively regenerated because checkpoint date
  // ranges are owned by snapshot configuration rather than this graph.
  return true
}

function isMatch(value: MatchRecord | undefined): value is MatchRecord {
  return value !== undefined
}

function isString(value: string | undefined): value is string {
  return value !== undefined
}

function seriesIdMatches(canonicalSeriesId: string, candidate: string) {
  return canonicalSeriesId === candidate
    || canonicalSeriesId.includes(`\u0000${candidate}\u0000`)
    || canonicalSeriesId.endsWith(`\u0000${candidate}`)
}
