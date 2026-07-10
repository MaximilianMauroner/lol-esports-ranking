import type {
  EventSummary,
  LeagueStrengthHistoryPoint,
  LeagueStrength,
  LeagueTierName,
  MatchRecord,
  PlayerAppearanceSummary,
  PlayerProfile,
  PlayerIndividualResidual,
  PlayerStanding,
  Region,
  Role,
  SeasonSummary,
  TeamEligibility,
  TeamHistoryPoint,
  TeamProfile,
  TeamStanding,
  PublishedRatingScale,
} from '../types'
import { leagueTierFor } from '../data/leagueTiers'
import { currentTopTierRegionForLeague, currentTopTierRegions, isCurrentTopTierRegion } from '../data/regionTaxonomy'
import { regionForLeague } from '../data/teamIdentity'
import { deriveRegionStrength, type RegionStrength } from './regionStrength'
import { buildPlayerModel, buildRankingModel, isDevelopmentalTeamName, transparentGprModelMetadata } from './model'
import { publishedRatingScale } from './modelConfig'
import {
  teamNamesForDssContext,
  withDeservedStandingComparison,
  withDeservedStandingRegionComparison,
  type ComputedTeamStanding,
} from './deservedStandingPublicComparison'
import {
  publishedRating,
  toPublishedLeagueStrength,
  toPublishedRegionStrength,
  toPublishedTeamStanding,
} from './publishedRatingArtifacts'
import { evaluateTeamEligibility, matchLevelEligibilityHistory } from './eligibility'
import { playerModelParameters } from './playerModel'
import { summarizePredictions, type WalkForwardMetrics } from './predictionModel'
import { filterPublishedRatingUniverseInput } from './ratingUniverse'
import {
  PUBLIC_ARTIFACT_SCHEMA_VERSION,
  artifactMetaFor,
  compactStanding as compactPublicStanding,
  leagueIdFor,
  publicScoreFamilies,
  snapshotKey,
  snapshotShardUrlPathForKey,
  teamIdFor,
  teamHistoryShardUrlPathForKey,
  tournamentMovementShardUrlPathForId,
} from './publicArtifacts/schema'
import { isCompetitionOnlyLeague, isUnknownLeague } from './teamProfiles'
import {
  deriveTournamentInstances,
  tournamentInstanceForEvent,
  type TournamentInstanceId,
  type TournamentScheduleReference,
} from './internationalTournaments'
import {
  groupAdjacentTimelineEntries,
  groupEntriesByDate,
  groupTimelineEntriesByKey,
  inferBestOfForScore,
  isResolvedTimelineResult,
  summarizeTimelineResults,
  timelineGroupKey,
  timelineSourceSummary,
  uniqueValues,
} from './timelineCompaction'
import { homeLeagueForMatch } from './matchContext'
import type {
  CompactPlayer,
  CompactPlayerRating,
  PlayerComparisonMetricInfo,
  PlayerMetricInfo,
  PlayerRatingProof,
  PublicPlayerDirectory,
  PublicRegionHistoryDirectory,
  PublicRegionHistoryPoint,
  PublicRegionHistoryPointContext,
  PublicRegionHistorySeries,
  PublicRegionHistoryScope,
  PublicRankingManifest,
  PublicRankingShard,
  PublicTeamHistoryIndex,
  PublicTeamHistoryDirectory,
  PublicTeamHistoryShard,
  PublicTeamHistoryModelContext,
  PublicTeamHistoryPoint,
  PublicTeamHistoryPointContext,
  PublicTeamHistorySeries,
  PublicTeamStanding,
  PublicTournamentMovementIndex,
  PublicTournamentMovementShard,
  PublicTournamentMovementTeam,
  PublicSnapshotIndexEntry,
  PublicTeamDirectory,
  SameTeamTopFiveClusteringDiagnostic,
} from './publicArtifacts/schema'

export type { CompactPlayer, CompactPlayerRating, PlayerRatingProof } from './publicArtifacts/schema'
export { snapshotKey } from './publicArtifacts/schema'

export const rolePowerPlayerMetric: PlayerMetricInfo = {
  id: 'role-power',
  label: 'Role Power',
  shortLabel: 'Role Power',
  description: 'Role-conditioned player rating from sourced game stats.',
  interpretation: 'This metric includes team-result signal and should not be read as independent best-in-role proof.',
  teamResultSignal: 'included',
  independentSkillClaim: false,
}

export const individualResidualComparisonMetric: PlayerComparisonMetricInfo = {
  id: 'individual-residual',
  label: 'Individual Residual',
  shortLabel: 'Residual',
  description: 'Shadow player stat-residual score after reducing shared team-result and contextual bucket effects.',
  metricVersion: 'individual-residual-v0',
  teamResultSignal: 'reduced',
  independentSkillClaim: false,
}

const scopedPlayerDirectoryLimit = 60

export type SnapshotFilter = {
  season: string
  event: string
  region: Region | 'All'
  checkpoint?: string
}

export type SnapshotCheckpointOption = {
  id: string
  season: string
  label: string
  startDate: string
  endDate: string
  boundaryEvent: string
  previousEndDate?: string
  description: string
}

type RankingModel = ReturnType<typeof buildRankingModel>
type RankingScope = {
  ranking: RankingModel
  teams: Record<string, TeamProfile>
}

export type DataSourceInfo = {
  name: string
  kind: 'match-data' | 'game-stats' | 'official-reference' | 'static-metadata' | 'experimental-api' | 'seed'
  url?: string
  description: string
  status: 'active' | 'planned' | 'reference-only'
  retrievedAt?: string
  coverageStart?: string
  coverageEnd?: string
  rowCount?: number
  warnings?: DataSourceWarning[]
}

export type DataSourceWarning = {
  kind: 'freshness' | 'rate-limit' | 'download' | 'coverage' | 'source-policy'
  severity: 'info' | 'warning' | 'error'
  message: string
  observedAt?: string
}

export type ModelInfo = {
  name: string
  version: string
  configHash: string
  ratingScale?: PublishedRatingScale
  parameters: unknown
}

export type DataCoverage = {
  matchCount: number
  coverageStart?: string
  coverageEnd?: string
  latestMatchDate?: string
  sourceProviders: string[]
  seededSample: boolean
}

export type DataQualityLeagueSummary = {
  league: string
  region?: Region
  tier?: LeagueTierName
  teamCount: number
  matchTouches: number
  sampleTeams: string[]
}

export type DataQualityAudit = {
  matchCount: number
  sourceProviderCounts: Record<string, number>
  dataCompletenessCounts: Record<string, number>
  missing: {
    sourceProviderCount: number
    sourceGameIdCount: number
    patchCount: number
    sideCount: number
  }
  rosterCoverage: {
    rosterSides: number
    completeRosterSides: number
    partialRosterSides: number
    missingRosterSides: number
    playerStatRows: number
  }
  identityCoverage: {
    teamProfileCount: number
    mappedTeamProfileCount: number
    unknownLeagueTeamCount: number
    internationalRegionTeamCount: number
    unresolvedLeagueSummaries: DataQualityLeagueSummary[]
  }
  notes: string[]
}

export type PlayerDirectory = PublicPlayerDirectory
export type TeamDirectory = PublicTeamDirectory
export type TeamHistoryPointCompact = PublicTeamHistoryPoint
export type TeamHistorySeries = PublicTeamHistorySeries
export type TeamHistoryDirectory = PublicTeamHistoryDirectory
export type TeamHistoryArtifacts = {
  index: PublicTeamHistoryIndex
  shards: Record<string, PublicTeamHistoryShard>
}
export type TournamentMovementArtifacts = {
  index: PublicTournamentMovementIndex
  shards: Record<TournamentInstanceId, PublicTournamentMovementShard>
}
export type RegionHistoryDirectory = PublicRegionHistoryDirectory

/**
 * Flattens per-team rating history from the default snapshot into a compact,
 * browser-loadable time series keyed by team standing key, so the team view can
 * draw rating-over-time charts without the full artifact.
 */
export function createTeamHistory(data: StaticRankingData): TeamHistoryDirectory {
  const defaultSnapshot = data.snapshots[data.defaultSnapshotKey]
  const minimumPointsPerSeries = 2
  const ratingScale = data.model.ratingScale ?? publishedRatingScale
  const defaultHistory = buildTeamHistorySeries(publishedTeamStandings(defaultSnapshot?.standings ?? [], ratingScale), minimumPointsPerSeries)
  const scopeIndex = Object.fromEntries(
    Object.entries(data.snapshots)
      .filter(([, snapshot]) => isSeasonHistoryScope(snapshot.filter))
      .map(([key, snapshot]) => [
        key,
        Object.keys(buildTeamHistorySeries(publishedTeamStandings(snapshot.standings, ratingScale), minimumPointsPerSeries, { includeContext: false }).series),
      ]),
  )

  return {
    artifactKind: 'team-history',
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    artifactMeta: artifactMetaFor({
      generatedAt: data.generatedAt,
      modelVersion: data.model.version,
      modelConfigHash: data.model.configHash,
    }),
    generatedAt: data.generatedAt,
    modelVersion: data.model.version,
    modelConfigHash: data.model.configHash,
    ratingScale,
    omissionPolicy: {
      minimumPointsPerSeries,
      omittedSeriesCount: defaultHistory.omittedSeriesCount,
      reason: 'Standings with fewer than two resolved rating-history points are omitted because a trend line needs at least two points; unresolved tied match groups are skipped.',
    },
    teamCount: Object.keys(defaultHistory.series).length,
    pointCount: defaultHistory.pointCount,
    series: defaultHistory.series,
    ...(Object.keys(scopeIndex).length > 0 ? { scopeIndex } : {}),
  }
}

export function createTeamHistoryArtifacts(
  data: StaticRankingData,
  {
    teamHistoryUrlForKey = teamHistoryShardUrlPathForKey,
  }: {
    teamHistoryUrlForKey?: (key: string) => string
  } = {},
): TeamHistoryArtifacts {
  const ratingScale = data.model.ratingScale ?? publishedRatingScale
  const historyScopes = Object.entries(data.snapshots)
    .filter(([key, snapshot]) => key === data.defaultSnapshotKey || isSeasonHistoryScope(snapshot.filter))
  const shards = Object.fromEntries(
    historyScopes.map(([key, snapshot]) => [key, createTeamHistoryShard(data, snapshot, ratingScale)]),
  )
  const defaultShard = shards[data.defaultSnapshotKey]
  const omissionPolicy = defaultShard?.omissionPolicy ?? {
    minimumPointsPerSeries: 2,
    omittedSeriesCount: 0,
    reason: 'Standings with fewer than two resolved rating-history points are omitted because a trend line needs at least two points; unresolved tied match groups are skipped.',
  }

  return {
    index: {
      artifactKind: 'team-history-index',
      schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
      artifactMeta: artifactMetaFor({
        generatedAt: data.generatedAt,
        modelVersion: data.model.version,
        modelConfigHash: data.model.configHash,
      }),
      generatedAt: data.generatedAt,
      modelVersion: data.model.version,
      modelConfigHash: data.model.configHash,
      ratingScale,
      defaultScopeKey: data.defaultSnapshotKey,
      omissionPolicy,
      scopeIndex: Object.fromEntries(
        Object.entries(shards).map(([key, shard]) => [
          key,
          {
            filter: shard.filter,
            url: teamHistoryUrlForKey(key),
            teamCount: shard.teamCount,
            pointCount: shard.pointCount,
          },
        ]),
      ),
    },
    shards,
  }
}

export function createTournamentMovementArtifacts(
  data: StaticRankingData,
  {
    tournamentMovementUrlForId = tournamentMovementShardUrlPathForId,
  }: {
    tournamentMovementUrlForId?: (id: TournamentInstanceId) => string
  } = {},
): TournamentMovementArtifacts {
  const ratingScale = data.model.ratingScale ?? publishedRatingScale
  const shards = data.tournamentMovements
  return {
    index: {
      artifactKind: 'tournament-movement-index',
      schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
      artifactMeta: artifactMetaFor({
        generatedAt: data.generatedAt,
        modelVersion: data.model.version,
        modelConfigHash: data.model.configHash,
      }),
      ratingScale,
      generatedAt: data.generatedAt,
      modelVersion: data.model.version,
      modelConfigHash: data.model.configHash,
      tournaments: Object.values(shards)
        .map((shard) => ({
          id: shard.id,
          family: shard.family,
          season: shard.season,
          label: shard.label,
          status: shard.status,
          startDate: shard.startDate,
          boundaryDate: shard.boundaryDate,
          ratedThroughDate: shard.ratedThroughDate,
          ...(shard.scheduledEndDate ? { scheduledEndDate: shard.scheduledEndDate } : {}),
          dataLag: shard.dataLag,
          participantCount: shard.participantCount,
          url: tournamentMovementUrlForId(shard.id),
        }))
        .sort((left, right) => right.startDate.localeCompare(left.startDate) || left.label.localeCompare(right.label)),
    },
    shards,
  }
}

function createTeamHistoryShard(
  data: StaticRankingData,
  snapshot: ComputedRankingSnapshot | undefined,
  ratingScale: PublishedRatingScale = data.model.ratingScale ?? publishedRatingScale,
): PublicTeamHistoryShard {
  const minimumPointsPerSeries = 2
  const history = buildTeamHistorySeries(publishedTeamStandings(snapshot?.standings ?? [], ratingScale), minimumPointsPerSeries)
  return {
    artifactKind: 'team-history-scope',
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    artifactMeta: artifactMetaFor({
      generatedAt: data.generatedAt,
      modelVersion: data.model.version,
      modelConfigHash: data.model.configHash,
    }),
    generatedAt: data.generatedAt,
    modelVersion: data.model.version,
    modelConfigHash: data.model.configHash,
    ratingScale,
    filter: snapshot?.filter ?? data.defaultFilter,
    omissionPolicy: {
      minimumPointsPerSeries,
      omittedSeriesCount: history.omittedSeriesCount,
      reason: 'Standings with fewer than two resolved rating-history points are omitted because a trend line needs at least two points; unresolved tied match groups are skipped.',
    },
    teamCount: Object.keys(history.series).length,
    pointCount: history.pointCount,
    series: history.series,
  }
}

export function createRegionHistory(data: StaticRankingData): RegionHistoryDirectory {
  const ratingScale = data.model.ratingScale ?? publishedRatingScale
  const scopes = Object.fromEntries(
    Object.entries(data.snapshots)
      .filter(([key, snapshot]) => key === data.defaultSnapshotKey || isSeasonHistoryScope(snapshot.filter))
      .map(([key, snapshot]) => [key, createRegionHistoryScope(snapshot, ratingScale)]),
  )

  return {
    artifactKind: 'region-history',
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    artifactMeta: artifactMetaFor({
      generatedAt: data.generatedAt,
      modelVersion: data.model.version,
      modelConfigHash: data.model.configHash,
    }),
    generatedAt: data.generatedAt,
    modelVersion: data.model.version,
    modelConfigHash: data.model.configHash,
    ratingScale,
    defaultScopeKey: data.defaultSnapshotKey,
    scopes,
  }
}

const REGION_HISTORY_TIER_RANK: Record<LeagueTierName, number> = {
  'tier-one': 0,
  'tier-two': 1,
  'tier-three': 2,
  emerging: 3,
  unknown: 4,
}

function createRegionHistoryScope(
  snapshot: ComputedRankingSnapshot,
  ratingScale: PublishedRatingScale,
): PublicRegionHistoryScope {
  const series: Record<string, PublicRegionHistorySeries> = Object.fromEntries(
    snapshot.regions.map((region) => [region.region, { region: region.region, points: [] }]),
  )
  const publishedRegions = new Set(Object.keys(series))
  const latestByLeague = new Map<string, LeagueStrengthHistoryPoint>()
  const pointsByDate = groupRegionLeagueHistoryByDate(snapshot.leagueHistory)

  for (const [date, points] of pointsByDate) {
    for (const point of points) {
      latestByLeague.set(point.league, point)
    }
    const rankedRegions = rankRegionHistoryRows(latestByLeague, publishedRegions)
    const touchedRegions = new Set<string>()
    for (const point of points) {
      const region = currentTopTierRegionForLeague(point.league, point.region)
      const row = rankedRegions.get(region)
      if (row?.flagshipLeagues.includes(point.league)) touchedRegions.add(region)
    }
    for (const region of touchedRegions) {
      const row = rankedRegions.get(region)
      const target = series[region]
      if (!row || !target) continue
      const context = regionHistoryContext(region, points, row.flagshipLeagues)
      const point: PublicRegionHistoryPoint = context
        ? [date, publishedRating(row.score, ratingScale), row.rank, context]
        : [date, publishedRating(row.score, ratingScale), row.rank]
      const previous = target.points.at(-1)
      if (previous && previous[0] === point[0] && previous[1] === point[1] && previous[2] === point[2]) continue
      target.points.push(point)
    }
  }

  alignFinalRegionHistoryPoints(series, snapshot.regions, ratingScale)
  return {
    filter: snapshot.filter,
    regionCount: Object.keys(series).length,
    pointCount: Object.values(series).reduce((total, entry) => total + entry.points.length, 0),
    series,
  }
}

function groupRegionLeagueHistoryByDate(points: LeagueStrengthHistoryPoint[]) {
  return groupEntriesByDate(points, (point) => point.date)
    .map(({ date, entries }) => [date, entries] as const)
}

function rankRegionHistoryRows(latestByLeague: Map<string, LeagueStrengthHistoryPoint>, publishedRegions: Set<string>) {
  const pointsByRegion = new Map<string, LeagueStrengthHistoryPoint[]>()
  for (const point of latestByLeague.values()) {
    const region = currentTopTierRegionForLeague(point.league, point.region)
    if (!publishedRegions.has(region)) continue
    const bucket = pointsByRegion.get(region) ?? []
    bucket.push(point)
    pointsByRegion.set(region, bucket)
  }

  const rows = [...pointsByRegion.entries()]
    .map(([region, points]) => {
      const flagshipPoints = flagshipRegionHistoryPoints(points)
      return {
        region,
        score: regionHistoryScore(flagshipPoints),
        flagshipLeagues: uniqueValues(flagshipPoints.map((point) => point.league)),
      }
    })
    .filter((row) => row.flagshipLeagues.length > 0 && Number.isFinite(row.score))
    .sort((left, right) => right.score - left.score || left.region.localeCompare(right.region))

  return new Map(rows.map((row, index) => [row.region, { ...row, rank: index + 1 }]))
}

function regionHistoryScore(flagshipPoints: LeagueStrengthHistoryPoint[]) {
  if (flagshipPoints.length === 0) return 0
  let weightedTotal = 0
  let weightTotal = 0
  for (const point of flagshipPoints) {
    const weight = Math.max(1, point.internationalMatches)
    weightedTotal += point.score * weight
    weightTotal += weight
  }
  return Number((weightTotal > 0 ? weightedTotal / weightTotal : meanRegionHistoryScore(flagshipPoints)).toFixed(1))
}

function flagshipRegionHistoryPoints(points: LeagueStrengthHistoryPoint[]) {
  if (points.length === 0) return []
  const bestTierRank = Math.min(...points.map((point) => REGION_HISTORY_TIER_RANK[leagueTierFor(point.league).tier]))
  return points.filter((point) => REGION_HISTORY_TIER_RANK[leagueTierFor(point.league).tier] === bestTierRank)
}

function meanRegionHistoryScore(points: LeagueStrengthHistoryPoint[]) {
  if (points.length === 0) return 0
  return points.reduce((total, point) => total + point.score, 0) / points.length
}

function regionHistoryContext(region: string, points: LeagueStrengthHistoryPoint[], flagshipLeagues: string[]): PublicRegionHistoryPointContext | undefined {
  const flagshipLeagueNames = new Set(flagshipLeagues)
  const regionPoints = points.filter((point) => currentTopTierRegionForLeague(point.league, point.region) === region && flagshipLeagueNames.has(point.league))
  if (regionPoints.length === 0) return undefined
  const latest = regionPoints.at(-1)!
  const context: PublicRegionHistoryPointContext = {
    event: latest.event,
    tier: latest.tier,
    leagues: uniqueValues(regionPoints.map((point) => point.league)),
    opponentRegions: uniqueValues(regionPoints.map((point) => currentTopTierRegionForLeague(point.opponentLeague, point.opponentRegion))),
    wins: regionPoints.reduce((total, point) => total + (point.result === 'W' ? 1 : 0), 0),
    losses: regionPoints.reduce((total, point) => total + (point.result === 'L' ? 1 : 0), 0),
    winsOverExpected: roundOptional(regionPoints.reduce((total, point) => total + (point.winsOverExpected ?? 0), 0), 2, { keepZero: true }),
    opponentAdjustedWinRate: roundOptional(latest.opponentAdjustedWinRate, 3, { keepZero: true }),
    source: 'league-strength-history',
  }
  return omitUndefined(context)
}

function alignFinalRegionHistoryPoints(
  series: Record<string, PublicRegionHistorySeries>,
  regions: RegionStrength[],
  ratingScale: PublishedRatingScale,
) {
  const latestDate = Object.values(series)
    .flatMap((entry) => entry.points.map((point) => point[0]))
    .sort()
    .at(-1)
  if (!latestDate) return

  for (const region of regions) {
    const target = series[region.region]
    const finalScore = toPublishedRegionStrength(region, ratingScale).score
    if (!target) continue
    const latest = target.points.at(-1)
    if (latest && latest[1] === finalScore && latest[2] === region.rank) continue
    target.points.push([
      latestDate,
      finalScore,
      region.rank,
      {
        event: 'Published region score',
        source: 'published-region-score',
      },
    ])
  }
}

function buildTeamHistorySeries(standings: TeamStanding[], minimumPointsPerSeries: number, { includeContext = true }: { includeContext?: boolean } = {}) {
  const series: Record<string, TeamHistorySeries> = {}
  let omittedSeriesCount = 0
  let pointCount = 0

  for (const standing of standings) {
    const validHistory = (standing.history ?? []).filter((point) => Boolean(point.date) && Number.isFinite(point.rating))
    const points = alignFinalTeamHistoryPoint(
      standing,
      groupTeamHistoryPointsIntoMatches(validHistory)
        .filter(isResolvedTeamHistoryMatchGroup)
        .map((group): TeamHistoryPointCompact => compactTeamHistoryMatchPoint(group, includeContext))
        .sort((left, right) => left[0].localeCompare(right[0])),
    )
    if (points.length < minimumPointsPerSeries) {
      omittedSeriesCount += 1
      continue
    }
    const key = teamStandingKey(standing)
    pointCount -= series[key]?.points.length ?? 0
    pointCount += points.length
    series[key] = {
      team: standing.team,
      code: standing.code,
      region: standing.region,
      points,
    }
  }

  return { series, omittedSeriesCount, pointCount }
}

function publishedTeamStandings(standings: ComputedTeamStanding[], ratingScale: PublishedRatingScale) {
  return standings.map((standing) => toPublishedTeamStanding(standing, ratingScale))
}

function alignFinalTeamHistoryPoint(standing: TeamStanding, points: TeamHistoryPointCompact[]) {
  const finalRating = Math.round(standing.rating)
  const finalRank = standing.rank
  if (points.length === 0 || !Number.isFinite(finalRating) || !Number.isFinite(finalRank)) return points

  const latest = points.at(-1)!
  if (latest[1] === finalRating && latest[2] === finalRank) return points
  const adjustment = finalRating - latest[1]
  const context = compactStandingAdjustmentContext(standing, adjustment)
  const aligned: TeamHistoryPointCompact = context
    ? [latest[0], finalRating, finalRank, context]
    : [latest[0], finalRating, finalRank]
  return [...points, aligned]
}

function compactStandingAdjustmentContext(
  standing: TeamStanding,
  adjustment: number,
): PublicTeamHistoryPointContext | undefined {
  const components = compactTeamHistoryComponents(standing.ratingComponents)
  const context: PublicTeamHistoryPointContext = {
    kind: 'standing-adjustment',
    adjustmentReason: 'published-standing-reconciliation',
    event: 'Published standing adjustment',
    delta: Number(adjustment.toFixed(1)),
    ...(components ? { model: { c: components } } : {}),
  }
  return omitUndefined(context)
}

type TeamHistoryPublicMatchGroup = {
  key: string
  entries: TeamHistoryPoint[]
}

function groupTeamHistoryPointsIntoMatches(history: TeamHistoryPoint[]): TeamHistoryPublicMatchGroup[] {
  return groupAdjacentTimelineEntries(history, teamHistoryPublicMatchKey)
}

function isResolvedTeamHistoryMatchGroup(group: TeamHistoryPublicMatchGroup) {
  const canonicalState = group.entries.at(-1)?.source?.seriesState
  if (canonicalState !== undefined) return canonicalState === 'completed'
  return isResolvedTimelineResult(summarizeTimelineResults(group.entries, (entry) => entry.result))
}

function teamHistoryPublicMatchKey(point: TeamHistoryPoint) {
  if (point.source?.seriesId) return timelineGroupKey(['canonical-series', point.source.seriesId])
  return timelineGroupKey([
    'series',
    point.date,
    point.event ?? '',
    point.opponent ?? '',
    point.source?.provider ?? '',
    teamHistorySourceSeriesKey(point),
    point.source?.fileName ?? '',
    String(point.source?.bestOf ?? ''),
  ])
}

function teamHistorySourceSeriesKey(point: TeamHistoryPoint) {
  const source = point.source
  if (source?.officialMatchId) return `official-match:${source.officialMatchId}`
  if (source?.matchId) return `source-match:${sourceSeriesId(source.matchId)}`
  const sourceGameSeriesId = teamHistorySourceGameSeriesId(source?.gameId, source?.bestOf)
  return sourceGameSeriesId ? `source-game-series:${sourceGameSeriesId}` : ''
}

function teamHistorySourceGameSeriesId(sourceGameId: string | undefined, bestOf: number | undefined) {
  if (!sourceGameId) return undefined
  const explicitGameSuffix = /(?:[_-]game[_-][1-5])$/i
  if (explicitGameSuffix.test(sourceGameId)) return sourceGameId.replace(explicitGameSuffix, '')
  if (typeof bestOf === 'number' && bestOf > 1 && /_[1-5]$/.test(sourceGameId)) {
    return sourceGameId.replace(/_[1-5]$/, '')
  }
  return undefined
}

function compactTeamHistoryMatchPoint(group: TeamHistoryPublicMatchGroup, includeContext: boolean): TeamHistoryPointCompact {
  const latest = group.entries.at(-1)!
  const base: TeamHistoryPointCompact = [latest.date, Math.round(latest.rating), latest.rank]
  if (!includeContext) return base

  const resultSummary = summarizeTimelineResults(group.entries, (entry) => entry.result)
  const result = latest.source?.seriesOutcome === 0.5 ? 'T' : resultSummary.result
  const bestOf = inferBestOfForScore(resultSummary.wins, resultSummary.losses, latest.source?.bestOf)
  const sourceSummary = timelineSourceSummary(group.entries, (entry) => entry.source)
  const delta = group.entries.reduce((total, entry) => (
    typeof entry.delta === 'number' && Number.isFinite(entry.delta) ? total + entry.delta : total
  ), 0)
  const modelContext = compactTeamHistoryModelContext(group.entries, result)

  return [
    latest.date,
    Math.round(latest.rating),
    latest.rank,
    {
      event: latest.event,
      opponent: latest.opponent,
      delta: Number(delta.toFixed(1)),
      tier: latest.tier,
      result,
      wins: resultSummary.wins,
      losses: resultSummary.losses,
      games: resultSummary.games,
      ...(typeof bestOf === 'number' ? { bestOf } : {}),
      ...sourceSummary,
      ...(modelContext ? { model: modelContext } : {}),
    },
  ]
}

function compactTeamHistoryModelContext(
  entries: TeamHistoryPoint[],
  result: 'W' | 'L' | 'T' | undefined,
): PublicTeamHistoryModelContext | undefined {
  const update = latestInformativeRatingUpdate(entries)
  const residual = finiteNumber(update?.neutralResultResidual)
  const observed = result === 'W' ? 1 : result === 'L' ? 0 : result === 'T' ? 0.5 : undefined
  const expected = typeof observed === 'number' && typeof residual === 'number'
    ? clamp01(observed - residual)
    : undefined
  const components = compactTeamHistoryComponents(entries.at(-1)?.ratingComponents)
  const context: PublicTeamHistoryModelContext = {
    e: roundOptional(expected, 3, { keepZero: true }),
    w: roundOptional(update?.eventWeight, 3, { keepZero: true }),
    ...(components ? { c: components } : {}),
  }
  return omitUndefined(context)
}

function compactTeamHistoryComponents(
  components: TeamHistoryPoint['ratingComponents'] | undefined,
): PublicTeamHistoryModelContext['c'] | undefined {
  if (!components) return undefined
  const values = [
    finiteNumber(components.leagueAnchor),
    finiteNumber(components.teamStableOffset),
    finiteNumber(components.rosterPriorOffset),
    finiteNumber(components.momentum),
    finiteNumber(components.contextAdjustment),
  ]
  if (values.some((value) => typeof value !== 'number')) return undefined
  return values.map((value) => roundRequired(value ?? 0, 1)) as PublicTeamHistoryModelContext['c']
}

function latestInformativeRatingUpdate(entries: TeamHistoryPoint[]) {
  return entries
    .toReversed()
    .map((entry) => entry.ratingUpdate)
    .find((update) => Boolean(update && (
      update.updateUnit !== 'series-member-no-team-update'
      || hasFiniteRatingUpdateField(update, 'resultEvidence')
      || hasFiniteRatingUpdateField(update, 'neutralResultResidual')
      || hasFiniteRatingUpdateField(update, 'seriesStrengthSignal')
    )))
}

function hasFiniteRatingUpdateField(update: TeamHistoryPoint['ratingUpdate'], key: keyof TeamHistoryPoint['ratingUpdate']) {
  return typeof finiteNumber(update[key]) === 'number'
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function roundOptional(value: number | undefined, decimals: number, { keepZero = false }: { keepZero?: boolean } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const factor = 10 ** decimals
  const rounded = Math.round(value * factor) / factor
  const normalized = Object.is(rounded, -0) ? 0 : rounded
  if (!keepZero && Math.abs(normalized) < 0.05) return undefined
  return normalized
}

function roundRequired(value: number, decimals: number) {
  const factor = 10 ** decimals
  const rounded = Math.round(value * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
  return entries.length > 0 ? Object.fromEntries(entries) as T : undefined
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value))
}

function isSeasonHistoryScope(filter: SnapshotFilter | undefined) {
  return Boolean(filter && filter.season !== 'All' && filter.event === 'All' && filter.region === 'All')
}

function isSeasonPlayerScope(filter: SnapshotFilter | undefined) {
  return isSeasonHistoryScope(filter)
}

/** Mirrors the UI `teamKey` so history can be looked up from a summary standing. */
export function teamStandingKey(standing: Pick<TeamStanding, 'team' | 'region' | 'code'>) {
  return teamIdFor(standing)
}

export type AwardSignalData = {
  status: 'source-missing' | 'sourced-award-signals'
  description: string
  sourceProvidersChecked: string[]
  awardResidualsApplied: boolean
}

export type SnapshotSourceBreakdown = {
  provider: string
  matchCount: number
  completeness: string[]
}

export type ComputedRankingSnapshot = {
  artifactKind: 'full-ranking-snapshot'
  filter: SnapshotFilter
  modelVersion: string
  modelConfigHash: string
  matchCount: number
  sourceBreakdown: SnapshotSourceBreakdown[]
  standings: ComputedTeamStanding[]
  leagues: LeagueStrength[]
  leagueHistory: LeagueStrengthHistoryPoint[]
  players: PlayerStanding[]
  events: EventSummary[]
  seasons: SeasonSummary[]
  regions: RegionStrength[]
}

export type StaticRankingData = {
  artifactKind: 'full-ranking-artifact'
  schemaVersion: typeof PUBLIC_ARTIFACT_SCHEMA_VERSION
  generatedAt: string
  source: string
  sources: DataSourceInfo[]
  model: ModelInfo
  coverage: DataCoverage
  dataQuality: DataQualityAudit
  playerData: {
    status: 'no-data' | 'seeded-demo-rosters' | 'sourced-player-stats'
    description: string
    metric: PlayerMetricInfo
    awardSignals: AwardSignalData
    ratingProof?: PlayerRatingProof
  }
  walkForward: {
    metrics: WalkForwardMetrics
  }
  dataMode: 'no-data' | 'seeded-sample' | 'scheduled-public-data'
  filterOptions: {
    seasons: string[]
    events: string[]
    regions: Array<Region | 'All'>
    checkpoints?: Record<string, SnapshotCheckpointOption[]>
  }
  defaultFilter: SnapshotFilter
  defaultSnapshotKey: string
  snapshots: Record<string, ComputedRankingSnapshot>
  tournamentMovements: Record<TournamentInstanceId, PublicTournamentMovementShard>
  teams: Record<string, TeamProfile>
}

export type RankingSummaryStanding = PublicTeamStanding
export type RankingSummarySnapshot = PublicRankingShard
export type SnapshotIndexEntry = PublicSnapshotIndexEntry
export type StaticRankingSummaryData = PublicRankingManifest

export function createStaticRankingSummaryData(
  data: StaticRankingData,
  {
    fullSnapshotUrl,
    playerDirectoryUrl,
    teamDirectoryUrl,
    teamHistoryIndexUrl,
    teamHistoryUrl,
    regionHistoryUrl,
    tournamentMovementIndexUrl = '/data/history/tournament-moves/index.json',
    snapshotUrlForKey = snapshotShardUrlPathForKey,
  }: {
    fullSnapshotUrl?: string
    playerDirectoryUrl?: string
    teamDirectoryUrl?: string
    teamHistoryIndexUrl?: string
    teamHistoryUrl?: string
    regionHistoryUrl?: string
    tournamentMovementIndexUrl?: string
    snapshotUrlForKey?: (key: string) => string
  } = {},
): {
  manifest: StaticRankingSummaryData
  snapshots: Record<string, RankingSummarySnapshot>
} {
  const ratingScale = data.model.ratingScale ?? publishedRatingScale
  const snapshots = Object.fromEntries(
    Object.entries(data.snapshots)
      .filter(([key, snapshot]) => shouldPublishPublicScope(key, snapshot, data.defaultSnapshotKey))
      .map(([key, snapshot]) => [key, compactSnapshot(snapshot, data.generatedAt, ratingScale)]),
  )
  const snapshotIndex = Object.fromEntries(
    Object.entries(snapshots).map(([key, snapshot]) => [
      key,
      {
        filter: snapshot.filter,
        url: snapshotUrlForKey(key),
        matchCount: snapshot.matchCount,
        sourceBreakdown: snapshot.sourceBreakdown,
      },
    ]),
  )
  const {
    artifactKind: _artifactKind,
    snapshots: _snapshots,
    tournamentMovements: _tournamentMovements,
    teams: _teams,
    ...manifestBase
  } = data
  void _artifactKind
  void _snapshots
  void _tournamentMovements
  void _teams

  return {
    manifest: {
      ...manifestBase,
      artifactKind: 'public-ranking-manifest',
      artifactMeta: artifactMetaFor({
        generatedAt: data.generatedAt,
        modelVersion: data.model.version,
        modelConfigHash: data.model.configHash,
      }),
      ratingScale,
      summaryMode: 'browser-summary',
      ...(fullSnapshotUrl ? { fullSnapshotUrl } : {}),
      ...(playerDirectoryUrl ? { playerDirectoryUrl } : {}),
      ...(teamDirectoryUrl ? { teamDirectoryUrl } : {}),
      ...(teamHistoryIndexUrl ? { teamHistoryIndexUrl } : {}),
      ...(teamHistoryUrl ? { teamHistoryUrl } : {}),
      ...(regionHistoryUrl ? { regionHistoryUrl } : {}),
      tournamentMovementIndexUrl,
      teamCount: Object.keys(data.teams).length,
      snapshotIndex,
    },
    snapshots,
  }
}

function compactSnapshot(
  snapshot: ComputedRankingSnapshot,
  generatedAt: string,
  ratingScale: PublishedRatingScale,
): RankingSummarySnapshot {
  const {
    artifactKind: _artifactKind,
    standings,
    leagues,
    regions,
    players: _players,
    events: _events,
    seasons: _seasons,
    leagueHistory: _leagueHistory,
    ...summary
  } = snapshot
  void _artifactKind
  void _players
  void _events
  void _seasons
  void _leagueHistory

  return {
    ...summary,
    artifactKind: 'public-snapshot-shard',
    artifactMeta: artifactMetaFor({
      generatedAt,
      modelVersion: summary.modelVersion,
      modelConfigHash: summary.modelConfigHash,
    }),
    ratingScale,
    scoreFamilies: [...publicScoreFamilies],
    leagues: leagues.map((league) => toPublishedLeagueStrength(league, ratingScale)),
    regions: regions.map((region) => toPublishedRegionStrength(region, ratingScale)),
    standings: standings.map((standing, index) => compactPublicStanding(toPublishedTeamStanding(standing, ratingScale), {
      includeRecentMatches: index < 100,
      includeRatingUpdate: false,
    })),
  }
}

function shouldPublishPublicScope(key: string, snapshot: ComputedRankingSnapshot, defaultSnapshotKey: string) {
  return key === defaultSnapshotKey || isSeasonHistoryScope(snapshot.filter)
}

function createTournamentMovementShards({
  matches,
  teams,
  generatedAt,
  scheduleReferences,
}: {
  matches: MatchRecord[]
  teams: Record<string, TeamProfile>
  generatedAt: string
  scheduleReferences: TournamentScheduleReference[]
}): Record<TournamentInstanceId, PublicTournamentMovementShard> {
  const instances = deriveTournamentInstances({ matches, scheduleReferences, generatedAt })
  const ratingScale = transparentGprModelMetadata.ratingScale ?? publishedRatingScale
  const artifactMeta = artifactMetaFor({
    generatedAt,
    modelVersion: transparentGprModelMetadata.version,
    modelConfigHash: transparentGprModelMetadata.configHash,
  })

  return Object.fromEntries(instances.map((instance) => {
    const instanceMatches = matches.filter((match) => (
      tournamentInstanceForEvent(match.event, match.season)?.id === instance.id
      && match.date >= instance.startDate
      && match.date <= instance.ratedThroughDate
    ))
    const entrantNames = new Set(instanceMatches.flatMap((match) => [match.teamA, match.teamB]))
    const baselineMatches = matches.filter((match) => match.date < instance.startDate && isCalendarAlignedSeasonMatch(match))
    const endpointMatches = matches.filter((match) => match.date <= instance.boundaryDate && isCalendarAlignedSeasonMatch(match))
    const baseline = buildRankingModel(baselineMatches, teamProfilesForRankingScope(baselineMatches, teams))
    const endpoint = buildRankingModel(endpointMatches, teamProfilesForRankingScope(endpointMatches, teams))
    const baselineByTeam = new Map(baseline.standings.map((standing) => [standing.team, standing]))
    const endpointByTeam = new Map(endpoint.standings.map((standing) => [standing.team, standing]))
    const movementTeams = [...entrantNames]
      .flatMap((teamName): PublicTournamentMovementTeam[] => {
        const startStanding = baselineByTeam.get(teamName)
        const endStanding = endpointByTeam.get(teamName)
        if (!startStanding || !endStanding) return []
        const publishedStart = toPublishedTeamStanding(startStanding, ratingScale)
        const publishedEnd = toPublishedTeamStanding(endStanding, ratingScale)
        const matchPoints = groupTeamHistoryPointsIntoMatches(
          publishedEnd.history.filter((point) => (
            tournamentInstanceForEvent(point.event, instance.season)?.id === instance.id
            && point.date >= instance.startDate
            && point.date <= instance.ratedThroughDate
          )),
        )
          .filter(isResolvedTeamHistoryMatchGroup)
          .map((group) => compactTeamHistoryMatchPoint(group, true))
          .sort((left, right) => left[0].localeCompare(right[0]))
        const endpointKind: NonNullable<PublicTeamHistoryPointContext['kind']> = instance.status === 'completed'
          ? 'tournament-end'
          : instance.status === 'ongoing'
            ? 'tournament-today'
            : 'tournament-latest-data'
        const points: PublicTeamHistoryPoint[] = [
          [
            instance.startDate,
            publishedStart.rating,
            publishedStart.rank,
            { kind: 'tournament-start', event: `${instance.label} start` },
          ],
          ...matchPoints,
          [
            instance.boundaryDate,
            publishedEnd.rating,
            publishedEnd.rank,
            { kind: endpointKind, event: `${instance.label} ${tournamentEndpointLabel(instance.status)}` },
          ],
        ]
        return [{
          teamId: teamIdFor(publishedEnd),
          team: publishedEnd.team,
          code: publishedEnd.code,
          eligible: publishedEnd.eligibility.eligible,
          eligibilityReasons: publishedEnd.eligibility.reasons,
          startRank: publishedStart.rank,
          endRank: publishedEnd.rank,
          rankMovement: publishedStart.rank - publishedEnd.rank,
          startRating: publishedStart.rating,
          endRating: publishedEnd.rating,
          ratingDelta: publishedEnd.rating - publishedStart.rating,
          points,
        }]
      })
      .sort((left, right) => left.endRank - right.endRank || right.endRating - left.endRating || left.team.localeCompare(right.team))

    const shard: PublicTournamentMovementShard = {
      artifactKind: 'tournament-movement',
      schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
      artifactMeta,
      ratingScale,
      generatedAt,
      modelVersion: transparentGprModelMetadata.version,
      modelConfigHash: transparentGprModelMetadata.configHash,
      ...instance,
      participantCount: movementTeams.length,
      teams: movementTeams,
    }
    return [instance.id, shard]
  })) as Record<TournamentInstanceId, PublicTournamentMovementShard>
}

function tournamentEndpointLabel(status: 'ongoing' | 'completed' | 'unknown') {
  if (status === 'completed') return 'final'
  if (status === 'ongoing') return 'today'
  return 'latest data'
}

export function createStaticRankingData({
  matches,
  teams,
  rosters,
  generatedAt = new Date().toISOString(),
  source = 'seeded sample data',
  dataMode,
  externalSources = [],
  tournamentScheduleReferences = [],
}: {
  matches: MatchRecord[]
  teams: Record<string, TeamProfile>
  rosters: Record<string, PlayerProfile[]>
  generatedAt?: string
  source?: string
  dataMode?: StaticRankingData['dataMode']
  externalSources?: DataSourceInfo[]
  tournamentScheduleReferences?: TournamentScheduleReference[]
}): StaticRankingData {
  const ratingUniverse = filterPublishedRatingUniverseInput(matches, teams)
  matches = ratingUniverse.matches
  teams = ratingUniverse.teams
  const resolvedDataMode = dataMode ?? (matches.length === 0 ? 'no-data' : 'seeded-sample')
  const hasOracleSource = matches.some((match) => match.sourceProvider === 'oracles-elixir')
  const hasLeaguepediaSource = matches.some((match) => match.sourceProvider === 'leaguepedia-cargo')
  const hasExternalSource = (sourceName: string) => externalSources.some((source) => source.name.toLowerCase().includes(sourceName))
  const seasons = ['All', ...Array.from(new Set(matches.map(matchSeasonKey))).sort().reverse()]
  const events = ['All', ...Array.from(new Set(matches.map((match) => match.event))).sort()]
  const checkpointOptions = buildSeasonCheckpointOptions(matches)
  const checkpointByFilterKey = new Map(
    Object.values(checkpointOptions)
      .flat()
      .map((checkpoint) => [checkpointFilterKey(checkpoint.season, checkpoint.id), checkpoint]),
  )
  const observedCurrentRegions = new Set(
    Object.values(teams)
      .map((team) => currentTopTierRegionForLeague(team.league, team.region))
      .filter(isCurrentTopTierRegion),
  )
  const regions = ['All', ...currentTopTierRegions.filter((region) => observedCurrentRegions.has(region))] as Array<Region | 'All'>
  const snapshots: Record<string, ComputedRankingSnapshot> = {}
  const globalRanking = buildRankingModel(matches, teams)
  const globalRankingScope: RankingScope = { ranking: globalRanking, teams }
  const seasonRankingCache = new Map<string, RankingScope>()
  const rankingScopeForFilter = (filter: SnapshotFilter): RankingScope => {
    if (filter.season === 'All') return globalRankingScope
    const cacheKey = snapshotKey(filter)
    const cached = seasonRankingCache.get(cacheKey)
    if (cached) return cached

    const checkpoint = checkpointForFilter(filter, checkpointByFilterKey)
    const scopeMatches = checkpoint ? matchesThroughDate(matches, checkpoint.endDate) : matchesThroughSeason(matches, filter.season)
    const scopeTeams = teamProfilesForRankingScope(scopeMatches, teams)
    const scope = { ranking: buildRankingModel(scopeMatches, scopeTeams), teams: scopeTeams }
    seasonRankingCache.set(cacheKey, scope)
    return scope
  }
  const globalPlayers = buildPlayerModel(matches, rosters, { teams, leagueStrengths: globalRanking.leagues })
  const seasonPlayerCache = new Map<string, PlayerStanding[]>()
  const playersForFilter = (filter: SnapshotFilter, filteredMatches: MatchRecord[], scope: RankingScope): PlayerStanding[] => {
    if (filter.event !== 'All' || filter.region !== 'All') return []
    if (filter.season === 'All') return globalPlayers
    const cacheKey = snapshotKey(filter)
    const cached = seasonPlayerCache.get(cacheKey)
    if (cached) return cached
    const players = buildPlayerModel(filteredMatches, rosters, { teams: scope.teams, leagueStrengths: scope.ranking.leagues })
    seasonPlayerCache.set(cacheKey, players)
    return players
  }
  const hasRosters = Object.keys(rosters).length > 0
  const hasObservedGameRosters = matches.some((match) => match.teamARoster || match.teamBRoster)
  const playerRatingProof = buildPlayerRatingProof(globalPlayers)
  const seedMatches = matches.filter((match) => (match.sourceProvider ?? 'seed') === 'seed')
  const defaultFilter: SnapshotFilter = { season: 'All', event: 'All', region: 'All' }

  for (const filter of buildSnapshotFilters(matches, teams, checkpointOptions)) {
    const checkpoint = checkpointForFilter(filter, checkpointByFilterKey)
    const filteredMatches = filterMatches(matches, teams, filter, checkpoint)
    const snapshotScope = rankingScopeForFilter(filter)
    const filteredTeamNames = teamNamesForFilter(filteredMatches, snapshotScope.teams, filter)
    const snapshotLeagues = snapshotScope.ranking.leagues.filter((league) => filter.region === 'All' || currentTopTierRegionForLeague(league.league, league.region) === filter.region)
    const checkpointBaselineStandings = checkpoint ? baselineRankingForCheckpoint(checkpoint, matches, teams).standings : undefined
    const snapshotStandings = withCheckpointMovement(
      filteredStandings(snapshotScope.ranking.standings, filteredMatches, filteredTeamNames, filter, snapshotScope.teams),
      checkpointBaselineStandings,
    )
    const dssContextStandings = filter.region === 'All'
      ? snapshotStandings
      : withCheckpointMovement(
          filteredStandings(
            snapshotScope.ranking.standings,
            filteredMatches,
            teamNamesForDssContext(filteredMatches),
            filter,
            snapshotScope.teams,
          ),
          checkpointBaselineStandings,
        )
    const standingsWithDss = withDeservedStandingComparison(snapshotStandings, filteredMatches, {
      contextStandings: dssContextStandings,
      useCheckpointBaseline: Boolean(checkpoint),
    })
    const snapshotLeagueHistory = leagueHistoryForFilter(snapshotScope.ranking.leagueHistory, filteredMatches, snapshotScope.teams, filter)
    const snapshotRegions = withDeservedStandingRegionComparison(
      deriveRegionStrength(snapshotLeagues, standingsWithDss),
      filteredMatches,
      snapshotScope.teams,
      standingsWithDss,
      { contextStandings: dssContextStandings, useCheckpointBaseline: Boolean(checkpoint) },
    )
    snapshots[snapshotKey(filter)] = {
      artifactKind: 'full-ranking-snapshot',
      filter,
      modelVersion: transparentGprModelMetadata.version,
      modelConfigHash: transparentGprModelMetadata.configHash,
      matchCount: filteredMatches.length,
      sourceBreakdown: sourceBreakdown(filteredMatches),
      standings: standingsWithDss,
      leagues: snapshotLeagues,
      leagueHistory: snapshotLeagueHistory,
      players: playersForFilter(filter, filteredMatches, snapshotScope),
      events: filterEventSummaries(snapshotScope.ranking.events, filteredMatches),
      seasons: filterSeasonSummaries(snapshotScope.ranking.seasons, filteredMatches),
      regions: snapshotRegions,
    }
  }

  return {
    artifactKind: 'full-ranking-artifact',
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    generatedAt,
    source,
    sources: [
      ...externalSources,
      ...(seedMatches.length > 0
        ? [{
            name: 'Seeded sample match records',
            kind: 'seed' as const,
            description: 'Checked-in sample matches used only when seeded sample mode is explicitly enabled.',
            status: resolvedDataMode === 'seeded-sample' ? 'active' as const : 'reference-only' as const,
            retrievedAt: generatedAt,
            coverageStart: coverageFor(seedMatches).coverageStart,
            coverageEnd: coverageFor(seedMatches).coverageEnd,
            rowCount: seedMatches.length,
          }]
        : []),
      ...(hasExternalSource('lol esports schedule api')
        ? []
        : [{
            name: 'LoL Esports schedule API',
            kind: 'official-reference' as const,
            url: 'https://esports-api.lolesports.com/persisted/gw/getSchedule',
            description: 'Planned cached reference layer for schedule windows, event states, series results, match IDs, game IDs, sides, and VOD references. It uses public LoL Esports site endpoints and must remain unsupported/reference-only.',
            status: 'planned' as const,
            warnings: [{
              kind: 'source-policy' as const,
              severity: 'warning' as const,
              message: 'LoL Esports persisted APIs are public site endpoints, not a supported official data API; cache responses and keep them reference-only.',
            }],
          }]),
      {
        name: 'Leaguepedia Cargo API',
        kind: 'match-data',
        url: 'https://lol.fandom.com/wiki/Help:Leaguepedia_API',
        description: 'Throttled backup and audit source for broad historical events, team aliases, match metadata, and result gap-fill when Oracle stats are unavailable.',
        status: hasLeaguepediaSource ? 'active' : 'planned',
      },
      {
        name: "Oracle's Elixir CSVs",
        kind: 'game-stats',
        url: 'https://oracleselixir.com/tools/downloads',
        description: 'Primary rich stats source for game-level and player-level model inputs from yearly CSV snapshots.',
        status: hasOracleSource ? 'active' : 'planned',
      },
      {
        name: 'Data Dragon static data',
        kind: 'static-metadata',
        url: 'https://ddragon.leagueoflegends.com/api/versions.json',
        description: 'Reference-only static Riot metadata and assets for champions, items, runes, spells, and patch-pinned images. Not an esports schedule/result source.',
        status: 'reference-only',
      },
      {
        name: 'CommunityDragon static data',
        kind: 'static-metadata',
        url: 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/',
        description: 'Reference-only supplemental static metadata/assets when Data Dragon does not expose the needed path. Not an esports schedule/result source.',
        status: 'reference-only',
      },
      {
        name: 'PandaScore LoL API experiment',
        kind: 'experimental-api',
        url: 'https://www.pandascore.co/pricing',
        description: 'Limited free-tier vendor experiment for fixture/context coverage comparison only. Not part of default model provenance or raw ranking inputs.',
        status: 'reference-only',
      },
      {
        name: 'Cito LoL API experiment',
        kind: 'experimental-api',
        url: 'https://citoapi.com/lol-esports-api/',
        description: 'Limited free-tier vendor experiment for endpoint ergonomics and low-volume coverage comparison only. Not part of default model provenance or raw ranking inputs.',
        status: 'reference-only',
      },
    ],
    model: transparentGprModelMetadata,
    coverage: coverageFor(matches),
    dataQuality: dataQualityFor(matches, teams),
    playerData: {
      status: hasObservedGameRosters || playerRatingProof ? 'sourced-player-stats' : matches.length === 0 || !hasRosters ? 'no-data' : 'seeded-demo-rosters',
      description: playerRatingProof
        ? "Oracle's Elixir player rows provide observed game rosters, value-weighted roster continuity for team ratings, Role Power player ratings, and gated prior-only player-rating prediction adjustments. Role Power includes team-result signal and is not independent best-in-role proof."
        : hasObservedGameRosters
          ? "Oracle's Elixir player rows provide observed game rosters and value-weighted roster continuity for team ratings; Role Power ratings require sourced player stat rows."
        : matches.length === 0 || !hasRosters
          ? 'No sourced player timeline or roster-continuity data is available for this snapshot.'
          : 'Player timelines use checked-in demo rosters and a transparent dynamic-share model, not official sourced player ratings.',
      metric: rolePowerPlayerMetric,
      awardSignals: {
        status: 'source-missing',
        description: 'Oracle CSVs and Leaguepedia ScoreboardGames do not provide dated human MVP/POG/All-Pro signal in this local pipeline, so AwardResidualZ remains unapplied instead of inferred from visible stats.',
        sourceProvidersChecked: ['oracles-elixir', 'leaguepedia-cargo'],
        awardResidualsApplied: false,
      },
      ratingProof: playerRatingProof,
    },
    walkForward: {
      metrics: summarizePredictions(globalRanking.predictions),
    },
    dataMode: resolvedDataMode,
    filterOptions: { seasons, events, regions, ...(Object.keys(checkpointOptions).length > 0 ? { checkpoints: checkpointOptions } : {}) },
    defaultFilter,
    defaultSnapshotKey: snapshotKey(defaultFilter),
    snapshots,
    tournamentMovements: createTournamentMovementShards({
      matches,
      teams,
      generatedAt,
      scheduleReferences: tournamentScheduleReferences,
    }),
    teams,
  }
}

const ROLE_ORDER: Role[] = ['Top', 'Jungle', 'Mid', 'Bot', 'Support']

/**
 * Flattens the full sourced-player list from the default snapshot into a compact,
 * browser-loadable directory. Region and league are joined from team standings so
 * the player view can group and filter without the 195MB full artifact.
 */
export function createPlayerDirectory(data: StaticRankingData): PlayerDirectory {
  const defaultSnapshot = data.snapshots[data.defaultSnapshotKey]
  const players = compactPlayersForSnapshot(defaultSnapshot, data.teams)
  const scopedPlayers: Record<string, CompactPlayer[]> = Object.fromEntries(
    Object.entries(data.snapshots)
      .filter(([key, snapshot]) => key !== data.defaultSnapshotKey && isSeasonPlayerScope(snapshot.filter))
      .map(([key, snapshot]) => [key, compactPlayersForSnapshot(snapshot, data.teams, { detail: 'scope' })])
      .filter(([, rows]) => rows.length > 0),
  )
  const scopedSameTeamTopFiveClustering: Record<string, SameTeamTopFiveClusteringDiagnostic> = Object.fromEntries(
    Object.entries(scopedPlayers).map(([key, rows]) => [key, sameTeamTopFiveClustering(rows, key)]),
  )

  return {
    artifactKind: 'player-directory',
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    artifactMeta: artifactMetaFor({
      generatedAt: data.generatedAt,
      modelVersion: data.model.version,
      modelConfigHash: data.model.configHash,
    }),
    generatedAt: data.generatedAt,
    modelVersion: data.model.version,
    modelConfigHash: data.model.configHash,
    sourceProvider: 'oracles-elixir',
    metric: rolePowerPlayerMetric,
    comparisonMetrics: [individualResidualComparisonMetric],
    diagnostics: {
      sameTeamTopFiveClustering: sameTeamTopFiveClustering(players, data.defaultSnapshotKey),
      ...(Object.keys(scopedSameTeamTopFiveClustering).length > 0 ? { scopedSameTeamTopFiveClustering } : {}),
    },
    ratedPlayerCount: players.length,
    ratedTeamCount: new Set(players.map((player) => player.team)).size,
    roles: ROLE_ORDER.filter((role) => players.some((player) => player.role === role)),
    players,
    ...(Object.keys(scopedPlayers).length > 0 ? { scopedPlayers } : {}),
  }
}

export function createTeamDirectory(data: StaticRankingData): TeamDirectory {
  const teams = Object.values(data.teams)
    .map((team) => ({
      teamId: teamIdFor({ team: team.name, region: team.region, code: team.code }),
      name: team.name,
      code: team.code,
      region: team.region,
      league: team.league,
      leagueId: leagueIdFor(team),
      providerAliases: {
        'oracles-elixir': uniqueValues([team.name, team.code].filter(Boolean)),
        'leaguepedia-cargo': uniqueValues([team.name, team.code].filter(Boolean)),
      },
    }))
    .sort((left, right) => left.name.localeCompare(right.name))

  return {
    artifactKind: 'team-directory',
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    artifactMeta: artifactMetaFor({
      generatedAt: data.generatedAt,
      modelVersion: data.model.version,
      modelConfigHash: data.model.configHash,
    }),
    generatedAt: data.generatedAt,
    modelVersion: data.model.version,
    modelConfigHash: data.model.configHash,
    teamCount: teams.length,
    teams,
  }
}

function compactPlayersForSnapshot(
  snapshot: Pick<ComputedRankingSnapshot, 'filter' | 'players' | 'standings'> | undefined,
  teams: Record<string, TeamProfile>,
  { detail = 'default' }: { detail?: 'default' | 'scope' } = {},
): CompactPlayer[] {
  const sourced = (snapshot?.players ?? [])
    .filter((player) =>
      player.ratingBasis === 'sourced-player-stats'
      && player.games >= playerModelParameters.minimumRankedSourcedPlayerGames,
    )
    .toSorted((left, right) => left.rank - right.rank)

  const teamMeta = new Map<string, { code?: string; region?: Region; league?: string; eligibility?: TeamEligibility }>()
  for (const standing of snapshot?.standings ?? []) {
    teamMeta.set(standing.team, { code: standing.code, region: standing.region, league: standing.league, eligibility: standing.eligibility })
  }
  for (const team of Object.values(teams)) {
    if (!teamMeta.has(team.name)) {
      teamMeta.set(team.name, { code: team.code, region: team.region, league: team.league })
    }
  }

  const players = sourced
    .filter((player) => {
      const creditedTeam = creditedTeamForPlayer(player, snapshot?.filter)
      const meta = teamMeta.get(creditedTeam.team)
      return !meta?.eligibility?.reasons.includes('unanchored-league')
        && creditedTeam.games >= playerModelParameters.minimumRankedSourcedPlayerGames
        && (player.appearance?.roleGames ?? player.games) >= playerModelParameters.minimumRankedSourcedPlayerGames
    })
  const compactPlayers = players
    .slice(0, detail === 'scope' ? scopedPlayerDirectoryLimit : Number.POSITIVE_INFINITY)
    .map((player, index) => {
      const creditedTeam = creditedTeamForPlayer(player, snapshot?.filter)
      const meta = teamMeta.get(creditedTeam.team)
      const teamId = teamIdFor({ team: creditedTeam.team, region: meta?.region, code: meta?.code })
      const compact: CompactPlayer = {
        id: player.id,
        playerId: player.id,
        name: player.name,
        team: creditedTeam.team,
        teamId,
        teamCode: meta?.code,
        teamGames: creditedTeam.games,
        teamShare: creditedTeam.share,
        region: meta?.region,
        league: meta?.league,
        role: player.role,
        rank: index + 1,
        rating: player.rating,
        games: player.games,
        delta: player.delta,
        form: player.form,
        ...(detail === 'default' ? { recentMatches: compactPlayerRecentMatches(player) } : {}),
        impactMultiplier: player.impactMultiplier,
        availability: player.availability,
        roleCertainty: player.roleCertainty,
        impactDrivers: player.impactDrivers,
        individualResidual: compactPlayerResidual(player.individualResidual),
        ratingBasis: player.ratingBasis,
        sourceProvider: player.source?.provider,
        latestObservedAt: player.source?.date,
        latestObservedEvent: player.source?.event,
        ...(detail === 'default' ? { appearance: compactPlayerAppearance(player.appearance) } : {}),
      }
      return compact
    })

  return assignCompactPlayerResidualRanks(compactPlayers)
}

function assignCompactPlayerResidualRanks(players: CompactPlayer[]): CompactPlayer[] {
  const residualRanks = new Map(
    players
      .filter((player) =>
        player.individualResidual
        && player.individualResidual.sampleGames >= playerModelParameters.minimumRankedSourcedPlayerGames,
      )
      .toSorted((left, right) =>
        (right.individualResidual?.score ?? -Infinity) - (left.individualResidual?.score ?? -Infinity)
        || right.games - left.games
        || left.name.localeCompare(right.name),
      )
      .map((player, index) => [player.id, index + 1]),
  )

  return players.map((player) => {
    if (!player.individualResidual) return player
    const residualRank = residualRanks.get(player.id)
    return {
      ...player,
      individualResidual: {
        ...player.individualResidual,
        rank: residualRank,
        rolePowerRank: player.rank,
        rankDelta: residualRank ? player.rank - residualRank : undefined,
      },
    }
  })
}

function compactPlayerResidual(residual: PlayerIndividualResidual | undefined): CompactPlayer['individualResidual'] {
  if (!residual) return undefined
  return {
    sourceProvider: residual.sourceProvider,
    metricVersion: residual.metricVersion,
    scope: residual.scope,
    score: residual.score,
    confidence: residual.confidence,
    sampleGames: residual.sampleGames,
  }
}

function compactPlayerAppearance(appearance: PlayerAppearanceSummary | undefined): CompactPlayer['appearance'] {
  if (!appearance) return undefined
  return {
    primaryTeam: appearance.primaryTeam,
    primaryTeamGames: appearance.primaryTeamGames,
    primaryTeamShare: appearance.primaryTeamShare,
    latestTeamGames: appearance.latestTeamGames,
    latestTeamShare: appearance.latestTeamShare,
    roleGames: appearance.roleGames,
    roleShare: appearance.roleShare,
    teamsPlayed: appearance.teamsPlayed,
    rolesPlayed: appearance.rolesPlayed,
    teamHistory: appearance.teamHistory.slice(0, 4),
    roleHistory: appearance.roleHistory,
    flags: appearance.flags,
  }
}

function sameTeamTopFiveClustering(players: CompactPlayer[], scope: string): SameTeamTopFiveClusteringDiagnostic {
  const topN = 5
  const teams = new Map<string, { team: string; teamCode?: string; roles: Role[]; players: string[] }>()
  for (const player of players.slice(0, topN)) {
    const current = teams.get(player.team) ?? { team: player.team, teamCode: player.teamCode, roles: [], players: [] }
    current.roles.push(player.role)
    current.players.push(player.name)
    teams.set(player.team, current)
  }

  return {
    status: 'diagnostic-not-failure',
    topN,
    scope,
    teams: Array.from(teams.values())
      .map((team) => ({
        ...team,
        count: team.players.length,
      }))
      .filter((team) => team.count > 1)
      .toSorted((left, right) => right.count - left.count || left.team.localeCompare(right.team)),
  }
}

type PlayerHistoryEntry = PlayerStanding['history'][number]

type PlayerMatchGroup = {
  key: string
  entries: PlayerHistoryEntry[]
}

export function compactPlayerRecentMatches(player: PlayerStanding): CompactPlayer['recentMatches'] {
  const recent = groupPlayerHistoryIntoMatches(player.history.filter((entry) => entry.result && entry.opponent))
    .filter(({ entries }) => {
      const canonicalState = entries.at(-1)?.source?.seriesState
      if (canonicalState !== undefined) return canonicalState === 'completed'
      return isResolvedTimelineResult(summarizeTimelineResults(entries, (entry) => entry.result))
    })
    .filter(({ entries }) => Boolean(playerMatchResult(entries)))
    .slice(-2)

  if (recent.length === 0) return undefined

  return recent.map(({ entries }) => {
    const latest = entries.at(-1)!
    const resultSummary = summarizeTimelineResults(entries, (entry) => entry.result)
    const result = playerMatchResult(entries)
    if (!result) return undefined
    const bestOf = inferBestOfForScore(resultSummary.wins, resultSummary.losses, latest.bestOf ?? latest.source?.bestOf)
    return {
      date: latest.date,
      event: latest.event,
      opponent: latest.opponent ?? 'Unknown opponent',
      opponentTeamCode: latest.opponentTeamCode,
      playerTeam: latest.playerTeam,
      playerTeamCode: latest.playerTeamCode,
      result,
      wins: resultSummary.wins,
      losses: resultSummary.losses,
      games: resultSummary.games,
      ...(typeof bestOf === 'number' ? { bestOf } : {}),
      ...(latest.source?.seriesId ? { seriesId: latest.source.seriesId } : {}),
      ...(latest.source?.formatBasis ? { formatBasis: latest.source.formatBasis } : {}),
      ...(latest.source?.formatConfidence ? { formatConfidence: latest.source.formatConfidence } : {}),
    }
  }).filter((match): match is NonNullable<typeof match> => Boolean(match))
}

function playerMatchResult(entries: PlayerHistoryEntry[]) {
  const latest = entries.at(-1)
  if (latest?.source?.seriesState === 'completed') {
    if (latest.source.seriesOutcome === 0.5) return 'T' as const
    if (latest.source.seriesOutcome === 1) return 'W' as const
    if (latest.source.seriesOutcome === 0) return 'L' as const
  }
  return summarizeTimelineResults(entries, (entry) => entry.result).result
}

function groupPlayerHistoryIntoMatches(history: PlayerHistoryEntry[]): PlayerMatchGroup[] {
  return groupAdjacentTimelineEntries(history, playerHistoryMatchKey)
}

function playerHistoryMatchKey(entry: PlayerHistoryEntry) {
  if (entry.source?.seriesId) return timelineGroupKey(['canonical-series', entry.source.seriesId])
  return timelineGroupKey([
    'series',
    entry.date,
    entry.event,
    entry.playerTeam ?? '',
    entry.opponent ?? '',
    entry.source?.provider ?? '',
    entry.source?.fileName ?? '',
    String(entry.bestOf ?? entry.source?.bestOf ?? ''),
  ])
}

function creditedTeamForPlayer(player: PlayerStanding, filter: SnapshotFilter | undefined) {
  const appearance = player.appearance
  const usePrimaryTeam = Boolean(filter && filter.season !== 'All')
  if (appearance && usePrimaryTeam) {
    return {
      team: appearance.primaryTeam,
      games: appearance.primaryTeamGames,
      share: appearance.primaryTeamShare,
    }
  }

  return {
    team: player.team,
    games: appearance?.latestTeamGames ?? player.games,
    share: appearance?.latestTeamShare ?? 1,
  }
}

function buildPlayerRatingProof(players: PlayerStanding[]): PlayerRatingProof | undefined {
  const sourcedPlayers = players
    .filter((player) => player.ratingBasis === 'sourced-player-stats' && player.games > 0)
    .toSorted((left, right) => left.rank - right.rank)

  if (sourcedPlayers.length === 0) return undefined

  return {
    sourceProvider: 'oracles-elixir',
    modelVersion: transparentGprModelMetadata.version,
    modelConfigHash: transparentGprModelMetadata.configHash,
    ratedPlayerCount: sourcedPlayers.length,
    ratedTeamCount: new Set(sourcedPlayers.map((player) => player.team)).size,
    sampleSize: sourcedPlayers.reduce((total, player) => total + player.games, 0),
    topPlayers: sourcedPlayers.slice(0, 10).map(compactPlayerRating),
  }
}

function compactPlayerRating(player: PlayerStanding): CompactPlayerRating {
  return {
    id: player.id,
    name: player.name,
    team: player.team,
    role: player.role,
    rank: player.rank,
    rating: player.rating,
    games: player.games,
    ratingBasis: player.ratingBasis,
    sourceProvider: player.source?.provider,
    sourceFileName: player.source?.fileName,
    sourceGameId: player.source?.gameId,
    sourceUrl: player.source?.url,
    latestObservedAt: player.source?.date,
    latestObservedEvent: player.source?.event,
    appearance: player.appearance,
  }
}

function dataQualityFor(matches: MatchRecord[], teams: Record<string, TeamProfile>): DataQualityAudit {
  const rosterSides = matches.flatMap((match) => [match.teamARoster, match.teamBRoster])
  const sourceProviderCounts = countBy(matches, (match) => match.sourceProvider ?? 'unknown')
  const dataCompletenessCounts = countBy(matches, (match) => match.dataCompleteness ?? 'unspecified')
  const unresolvedLeagueSummaries = unresolvedLeagueSummariesFor(matches, teams)
  const unknownLeagueTeamCount = Object.values(teams).filter((team) => team.league === 'Unknown').length
  const internationalRegionTeamCount = Object.values(teams).filter((team) => team.region === 'International').length
  const missingPatchCount = matches.filter((match) => !match.patch).length
  const missingSideCount = matches.filter((match) => !match.teamASide || !match.teamBSide).length
  const missingSourceProviderCount = matches.filter((match) => !match.sourceProvider).length
  const missingSourceGameIdCount = matches.filter((match) => !match.sourceGameId).length
  const missingRosterSides = rosterSides.filter((roster) => !roster).length

  return {
    matchCount: matches.length,
    sourceProviderCounts,
    dataCompletenessCounts,
    missing: {
      sourceProviderCount: missingSourceProviderCount,
      sourceGameIdCount: missingSourceGameIdCount,
      patchCount: missingPatchCount,
      sideCount: missingSideCount,
    },
    rosterCoverage: {
      rosterSides: rosterSides.length,
      completeRosterSides: rosterSides.filter((roster) => roster?.completeness === 'complete-five-role').length,
      partialRosterSides: rosterSides.filter((roster) => roster?.completeness === 'partial').length,
      missingRosterSides,
      playerStatRows: rosterSides.reduce((total, roster) => total + (roster?.players.filter((player) => player.stats).length ?? 0), 0),
    },
    identityCoverage: {
      teamProfileCount: Object.keys(teams).length,
      mappedTeamProfileCount: Object.values(teams).filter((team) => team.league !== 'Unknown' && team.region !== 'International').length,
      unknownLeagueTeamCount,
      internationalRegionTeamCount,
      unresolvedLeagueSummaries,
    },
    notes: dataQualityNotes({
      missingPatchCount,
      missingSideCount,
      missingSourceProviderCount,
      missingSourceGameIdCount,
      missingRosterSides,
      unknownLeagueTeamCount,
      internationalRegionTeamCount,
      unresolvedLeagueSummaries,
    }),
  }
}

function dataQualityNotes({
  missingPatchCount,
  missingSideCount,
  missingSourceProviderCount,
  missingSourceGameIdCount,
  missingRosterSides,
  unknownLeagueTeamCount,
  internationalRegionTeamCount,
  unresolvedLeagueSummaries,
}: {
  missingPatchCount: number
  missingSideCount: number
  missingSourceProviderCount: number
  missingSourceGameIdCount: number
  missingRosterSides: number
  unknownLeagueTeamCount: number
  internationalRegionTeamCount: number
  unresolvedLeagueSummaries: DataQualityLeagueSummary[]
}) {
  const notes: string[] = []
  if (missingSourceProviderCount > 0) notes.push(`${missingSourceProviderCount} matches are missing source provider metadata.`)
  if (missingSourceGameIdCount > 0) notes.push(`${missingSourceGameIdCount} matches are missing source game ids.`)
  if (missingPatchCount > 0) notes.push(`${missingPatchCount} matches are missing patch metadata.`)
  if (missingSideCount > 0) notes.push(`${missingSideCount} matches are missing side-selection metadata; these rows cannot train side priors.`)
  if (missingRosterSides > 0) notes.push(`${missingRosterSides} team-sides have no sourced roster snapshot; roster continuity falls back to assumed/unknown basis.`)
  if (unknownLeagueTeamCount > 0 || internationalRegionTeamCount > 0) {
    notes.push(`${unknownLeagueTeamCount} teams have unknown league profiles and ${internationalRegionTeamCount} teams still map to International region profiles.`)
  }
  if (unresolvedLeagueSummaries.length > 0) {
    notes.push('Unresolved league summaries list the largest remaining identity gaps by team count and match touches.')
  }
  return notes
}

function unresolvedLeagueSummariesFor(matches: MatchRecord[], teams: Record<string, TeamProfile>): DataQualityLeagueSummary[] {
  const matchTouches = new Map<string, number>()
  for (const match of matches) {
    for (const teamName of [match.teamA, match.teamB]) {
      matchTouches.set(teamName, (matchTouches.get(teamName) ?? 0) + 1)
    }
  }

  const byLeague = new Map<string, { league: string; region?: Region; tier?: LeagueTierName; teams: TeamProfile[]; matchTouches: number }>()
  for (const team of Object.values(teams)) {
    const tier = leagueTierFor(team.league).tier
    if (team.league !== 'Unknown' && team.region !== 'International' && tier !== 'unknown') continue
    const key = `${team.league}\u0000${team.region}`
    const summary = byLeague.get(key) ?? { league: team.league, region: team.region, tier, teams: [], matchTouches: 0 }
    summary.teams.push(team)
    summary.matchTouches += matchTouches.get(team.name) ?? 0
    byLeague.set(key, summary)
  }

  return Array.from(byLeague.values())
    .map((summary) => ({
      league: summary.league,
      region: summary.region,
      tier: summary.tier,
      teamCount: summary.teams.length,
      matchTouches: summary.matchTouches,
      sampleTeams: summary.teams
        .slice()
        .sort((left, right) => (matchTouches.get(right.name) ?? 0) - (matchTouches.get(left.name) ?? 0) || left.name.localeCompare(right.name))
        .slice(0, 5)
        .map((team) => team.name),
    }))
    .sort((left, right) => right.teamCount - left.teamCount || right.matchTouches - left.matchTouches || left.league.localeCompare(right.league))
    .slice(0, 12)
}

function countBy<T>(items: T[], keyFor: (item: T) => string) {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const key = keyFor(item)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

function coverageFor(matches: MatchRecord[]): DataCoverage {
  const dates = datesFor(matches)
  const sourceProviders = Array.from(new Set(matches.map((match) => match.sourceProvider ?? 'unknown'))).sort()
  return {
    matchCount: matches.length,
    coverageStart: dates[0],
    coverageEnd: dates.at(-1),
    latestMatchDate: dates.at(-1),
    sourceProviders,
    seededSample: sourceProviders.includes('seed'),
  }
}

function datesFor(matches: MatchRecord[]) {
  const dates: string[] = []
  for (const match of matches) {
    if (match.date) dates.push(match.date)
  }
  return dates.sort()
}

function sourceBreakdown(matches: MatchRecord[]): SnapshotSourceBreakdown[] {
  const byProvider = new Map<string, MatchRecord[]>()
  for (const match of matches) {
    const provider = match.sourceProvider ?? 'unknown'
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), match])
  }

  return Array.from(byProvider.entries())
    .map(([provider, providerMatches]) => ({
      provider,
      matchCount: providerMatches.length,
      completeness: Array.from(new Set(providerMatches.map((match) => match.dataCompleteness).filter((value): value is string => Boolean(value)))).sort(),
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

export function leagueHistoryForFilter(
  history: LeagueStrengthHistoryPoint[],
  matches: MatchRecord[],
  teams: Record<string, TeamProfile>,
  filter: SnapshotFilter,
) {
  if (isDefaultFilter(filter)) return history
  if (history.length === 0 || matches.length === 0) return []

  const scopedKeys = leagueHistoryKeysForMatches(matches, teams, filter)
  return history.filter((point) => scopedKeys.has(leagueHistoryPointKey(point)))
}

function leagueHistoryKeysForMatches(
  matches: MatchRecord[],
  teams: Record<string, TeamProfile>,
  filter: SnapshotFilter,
) {
  const keys = new Set<string>()
  const sortedMatches = matches.toSorted((left, right) => left.date.localeCompare(right.date))

  for (const dateGroup of groupEntriesByDate(sortedMatches, (match) => match.date)) {
    for (const seriesGroup of groupTimelineEntriesByKey(dateGroup.entries, rankingSeriesKeyForMatch)) {
      const finalMatch = seriesGroup.entries.at(-1)
      if (!finalMatch) continue
      addLeagueHistoryPointKey(keys, finalMatch, teams, filter, 'A')
      addLeagueHistoryPointKey(keys, finalMatch, teams, filter, 'B')
    }
  }

  return keys
}

function addLeagueHistoryPointKey(
  keys: Set<string>,
  match: MatchRecord,
  teams: Record<string, TeamProfile>,
  filter: SnapshotFilter,
  side: 'A' | 'B',
) {
  const opponentSide = side === 'A' ? 'B' : 'A'
  const league = homeLeagueForMatch(match, side, teams)
  const region = modelRegionForMatchSide(match, side, teams)
  if (filter.region !== 'All' && currentTopTierRegionForLeague(league, region) !== filter.region) return

  keys.add(leagueHistoryPointKey({
    date: match.date,
    event: match.event,
    tier: match.tier,
    league,
    region,
    opponentLeague: homeLeagueForMatch(match, opponentSide, teams),
    opponentRegion: modelRegionForMatchSide(match, opponentSide, teams),
  }))
}

function leagueHistoryPointKey(point: Pick<LeagueStrengthHistoryPoint, 'date' | 'event' | 'tier' | 'league' | 'region' | 'opponentLeague' | 'opponentRegion'>) {
  return timelineGroupKey([
    point.date,
    point.event,
    point.tier,
    point.league,
    point.region,
    point.opponentLeague,
    point.opponentRegion,
  ])
}

function rankingSeriesKeyForMatch(match: MatchRecord) {
  const provider = match.sourceProvider ?? 'unknown'
  if (match.sourceMatchId) return timelineGroupKey(['source-match', provider, sourceSeriesId(match.sourceMatchId)])
  const [left, right] = [match.teamA, match.teamB].sort((a, b) => a.localeCompare(b))
  return timelineGroupKey(['inferred-series', match.date, provider, match.event, left, right])
}

function sourceSeriesId(sourceMatchId: string) {
  return sourceMatchId.replace(/_[1-5]$/, '')
}

function modelRegionForMatchSide(match: MatchRecord, side: 'A' | 'B', teams: Record<string, TeamProfile>): Region {
  if (side === 'A') return match.teamARegion ?? teams[match.teamA]?.region ?? match.region
  return match.teamBRegion ?? teams[match.teamB]?.region ?? match.region
}

function filterMatches(
  matches: MatchRecord[],
  teams: Record<string, TeamProfile>,
  filter: SnapshotFilter,
  checkpoint?: SnapshotCheckpointOption,
) {
  return matches.filter((match) => {
    const seasonMatches = checkpoint
      ? matchBelongsToCheckpointScope(match, checkpoint)
      : filter.season === 'All' || matchBelongsToSeasonScope(match, filter.season)
    const eventMatches = filter.event === 'All' || match.event === filter.event
    const regionMatches = filter.region === 'All' || matchBelongsToRegion(match, teams, filter.region)
    return seasonMatches && eventMatches && regionMatches
  })
}

function matchBelongsToRegion(match: MatchRecord, teams: Record<string, TeamProfile>, region: Region) {
  return regionsForMatch(match, teams).includes(region)
}

function matchesThroughSeason(matches: MatchRecord[], season: string) {
  const seasonNumber = Number(season)
  if (!Number.isFinite(seasonNumber)) return matches
  return matches.filter((match) => {
    const year = Number(matchSeasonKey(match))
    return Number.isFinite(year) && year <= seasonNumber && isCalendarAlignedSeasonMatch(match)
  })
}

function matchesThroughDate(matches: MatchRecord[], endDate: string) {
  return matches.filter((match) => match.date <= endDate && isCalendarAlignedSeasonMatch(match))
}

function baselineRankingForCheckpoint(
  checkpoint: SnapshotCheckpointOption,
  matches: MatchRecord[],
  teams: Record<string, TeamProfile>,
) {
  const baselineMatches = checkpoint.previousEndDate
    ? matchesThroughDate(matches, checkpoint.previousEndDate)
    : matches.filter((match) => match.date < checkpoint.startDate && isCalendarAlignedSeasonMatch(match))
  const baselineTeams = teamProfilesForRankingScope(baselineMatches, teams)
  return buildRankingModel(baselineMatches, baselineTeams)
}

function withCheckpointMovement(standings: TeamStanding[], baselineStandings: TeamStanding[] | undefined) {
  if (!baselineStandings) return standings
  const currentTeamNames = new Set(standings.map((standing) => standing.team))
  const baseline = new Map(
    baselineStandings
      .filter((standing) => currentTeamNames.has(standing.team))
      .sort((left, right) => Number(right.eligibility.eligible) - Number(left.eligibility.eligible) || right.rating - left.rating)
      .map((standing, index) => [standing.team, { ...standing, rank: index + 1 }]),
  )

  return standings.map((standing) => {
    const previous = baseline.get(standing.team)
    if (!previous) return { ...standing, previousRank: standing.rank, previousRating: standing.rating, movement: 0, delta: 0 }
    return {
      ...standing,
      previousRank: previous.rank,
      previousRating: previous.rating,
      movement: previous.rank - standing.rank,
      delta: standing.rating - previous.rating,
    }
  })
}

function buildSnapshotFilters(
  matches: MatchRecord[],
  teams: Record<string, TeamProfile>,
  checkpoints: Record<string, SnapshotCheckpointOption[]>,
) {
  const filters = new Map<string, SnapshotFilter>()
  const addFilter = (filter: SnapshotFilter) => filters.set(snapshotKey(filter), filter)
  addFilter({ season: 'All', event: 'All', region: 'All' })

  for (const match of matches) {
    const season = matchSeasonKey(match)
    addFilter({ season, event: 'All', region: 'All' })
    addFilter({ season: 'All', event: match.event, region: 'All' })

    for (const region of regionsForMatch(match, teams)) {
      addFilter({ season: 'All', event: 'All', region })
    }
  }

  for (const checkpoint of Object.values(checkpoints).flat()) {
    addFilter({ season: checkpoint.season, event: 'All', region: 'All', checkpoint: checkpoint.id })
  }

  return Array.from(filters.values()).sort((left, right) => {
    if (snapshotKey(left) === snapshotKey({ season: 'All', event: 'All', region: 'All' })) return -1
    if (snapshotKey(right) === snapshotKey({ season: 'All', event: 'All', region: 'All' })) return 1
    return snapshotKey(left).localeCompare(snapshotKey(right))
  })
}

function matchSeasonKey(match: MatchRecord) {
  return Number.isFinite(match.season) ? String(match.season) : match.date?.slice(0, 4) || String(match.season)
}

function matchBelongsToSeasonScope(match: MatchRecord, season: string) {
  return matchSeasonKey(match) === season && isCalendarAlignedSeasonMatch(match)
}

function matchBelongsToCheckpointScope(match: MatchRecord, checkpoint: SnapshotCheckpointOption) {
  if (!matchBelongsToSeasonScope(match, checkpoint.season)) return false
  if (match.date > checkpoint.endDate) return false
  if (checkpoint.previousEndDate && match.date <= checkpoint.previousEndDate) return false
  return match.date >= checkpoint.startDate
}

const checkpointBoundaryDefinitions = [
  { id: 'split-1', label: 'Split 1', kind: 'first-stand' },
  { id: 'split-2', label: 'Split 2', kind: 'msi' },
  { id: 'split-3', label: 'Split 3', kind: 'worlds' },
] as const

type CheckpointBoundaryDefinition = typeof checkpointBoundaryDefinitions[number]
type CheckpointBoundaryKind = CheckpointBoundaryDefinition['kind']
type CheckpointBoundaryEvent = {
  definition: CheckpointBoundaryDefinition
  event: string
  firstMatchDate: string
  endDate: string
}

function buildSeasonCheckpointOptions(matches: MatchRecord[]) {
  const checkpointsBySeason = new Map<string, Map<CheckpointBoundaryKind, CheckpointBoundaryEvent>>()

  for (const match of matches) {
    const definition = checkpointBoundaryDefinitionForMatch(match)
    if (!definition) continue
    const season = matchSeasonKey(match)
    if (!matchBelongsToSeasonScope(match, season)) continue
    const byBoundary = checkpointsBySeason.get(season) ?? new Map<CheckpointBoundaryKind, CheckpointBoundaryEvent>()
    checkpointsBySeason.set(season, byBoundary)
    const current = byBoundary.get(definition.kind) ?? {
      definition,
      event: match.event,
      firstMatchDate: match.date,
      endDate: match.date,
    }
    byBoundary.set(definition.kind, {
      definition,
      event: match.date >= current.endDate ? match.event : current.event,
      firstMatchDate: match.date < current.firstMatchDate ? match.date : current.firstMatchDate,
      endDate: match.date > current.endDate ? match.date : current.endDate,
    })
  }

  return Object.fromEntries(
    Array.from(checkpointsBySeason.entries())
      .map(([season, boundaries]) => {
        let previousEndDate: string | undefined
        const seasonStart = `${season}-01-01`
        const checkpoints = checkpointBoundaryDefinitions
          .map((definition): SnapshotCheckpointOption | undefined => {
            const boundary = boundaries.get(definition.kind)
            if (!boundary) return undefined
            const checkpoint: SnapshotCheckpointOption = {
              id: definition.id,
              season,
              label: definition.label,
              startDate: previousEndDate ? nextCalendarDate(previousEndDate) : seasonStart,
              endDate: boundary.endDate,
              boundaryEvent: boundary.event,
              ...(previousEndDate ? { previousEndDate } : {}),
              description: `${season} ${definition.label} through ${boundary.event}`,
            }
            previousEndDate = boundary.endDate
            return checkpoint
          })
          .filter((checkpoint): checkpoint is SnapshotCheckpointOption => Boolean(checkpoint))
        return checkpoints.length > 0 ? [season, checkpoints] as const : undefined
      })
      .filter((entry): entry is readonly [string, SnapshotCheckpointOption[]] => Boolean(entry)),
  )
}

function checkpointBoundaryDefinitionForMatch(match: MatchRecord): CheckpointBoundaryDefinition | undefined {
  const text = `${match.league} ${match.event}`.toUpperCase()
  if (match.tier === 'qualifier') return undefined
  if (/\bQUALIFIERS?\b/.test(text)) return undefined
  if (!isCheckpointBoundaryCompetition(match)) return undefined
  if (/\bFST\b/.test(text) || text.includes('FIRST STAND')) return checkpointBoundaryDefinitions[0]
  if (/\bMSI\b/.test(text) || text.includes('MID-SEASON INVITATIONAL')) return checkpointBoundaryDefinitions[1]
  if (/\bWLDS?\b/.test(text) || /\bWORLDS\b/.test(text) || text.includes('WORLD CHAMPIONSHIP')) return checkpointBoundaryDefinitions[2]
  return undefined
}

function isCheckpointBoundaryCompetition(match: MatchRecord) {
  if (match.region === 'International') return true
  const league = match.league.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
  return ['FST', 'MSI', 'WLD', 'WLDS', 'WORLDS', 'WORLD CHAMPIONSHIP'].includes(league)
}

function nextCalendarDate(date: string) {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  parsed.setUTCDate(parsed.getUTCDate() + 1)
  return parsed.toISOString().slice(0, 10)
}

function checkpointForFilter(
  filter: SnapshotFilter,
  checkpoints: Map<string, SnapshotCheckpointOption>,
) {
  return filter.checkpoint ? checkpoints.get(checkpointFilterKey(filter.season, filter.checkpoint)) : undefined
}

function checkpointFilterKey(season: string, checkpoint: string) {
  return `${season}\u0000${checkpoint}`
}

function isCalendarAlignedSeasonMatch(match: MatchRecord) {
  const sourceSeason = Number(matchSeasonKey(match))
  const calendarYear = Number(match.date?.slice(0, 4))
  if (!Number.isFinite(sourceSeason) || !Number.isFinite(calendarYear)) return true
  return sourceSeason === calendarYear
}

function regionsForMatch(match: MatchRecord, teams: Record<string, TeamProfile>) {
  const regions = [
    currentTopTierRegionForLeague(match.league, match.region),
    sideCurrentTopTierRegionForMatch(match, 'A', teams),
    sideCurrentTopTierRegionForMatch(match, 'B', teams),
  ].filter((region): region is Region => Boolean(region) && isCurrentTopTierRegion(region))
  return Array.from(new Set(regions))
}

function filteredStandings(
  standings: TeamStanding[],
  matches: MatchRecord[],
  teamNames: Set<string>,
  filter: SnapshotFilter,
  teams: Record<string, TeamProfile>,
) {
  if (isDefaultFilter(filter)) {
    return standings.filter((standing) => teamNames.has(standing.team))
  }

  const historyKeys = historyKeysForMatches(matches)
  const seriesSiblingKeys = seriesSiblingKeysForMatches(matches)
  const scopedProfiles = scopedTeamProfilesForMatches(matches, teams)
  const lastDate = datesFor(matches).at(-1) ?? new Date().toISOString().slice(0, 10)
  const leagueInternationalMatches = leagueInternationalMatchesFor(matches, teams)
  const scopedStandings = standings
    .filter((standing) => teamNames.has(standing.team))
    .map((standing) => {
      const history = standing.history.filter((point) =>
        historyKeys.has(historyKey(standing.team, point.date, point.event, point.opponent))
        || seriesSiblingKeys.has(seriesSiblingKey(standing.team, point.date, point.opponent)),
      )
      const scopedWins = history.filter((point) => point.result === 'W').length
      const scopedLosses = history.filter((point) => point.result === 'L').length
      const eligibilityHistory = matchLevelEligibilityHistory(history)
      const scopedProfile = scopedProfiles.get(standing.team)
      const league = scopedProfile?.league ?? standing.league
      const region = scopedProfile?.region ?? standing.region
      const scopedEligibility = evaluateTeamEligibility({
        history: eligibilityHistory,
        lastDate,
        uncertainty: standing.uncertainty,
        league,
        leagueTier: leagueTierFor(league).tier,
        leagueInternationalMatches: leagueInternationalMatches.get(league) ?? 0,
        isDevelopmentalTeam: isDevelopmentalTeamName(standing.team),
      })
      return {
        ...standing,
        league,
        region,
        wins: scopedWins,
        losses: scopedLosses,
        form: history.slice(-5).map((point) => point.result),
        history,
        recentEvents: Array.from(new Set(history.slice(-4).map((point) => point.event))).reverse(),
        eligibility: filter.checkpoint ? standing.eligibility : scopedEligibility,
      }
    })

  return rankedScopedStandings(scopedStandings)
}

function rankedScopedStandings(standings: TeamStanding[]) {
  const previousRankMap = scopedStandingRankMap(standings, (standing) => standing.previousRating)
  return [...standings]
    .sort(compareScopedStandingsByRating((standing) => standing.rating))
    .map((standing, index) => {
      const rank = index + 1
      const previousRank = previousRankMap.get(standing.team) ?? rank
      return {
        ...standing,
        rank,
        previousRank,
        movement: previousRank - rank,
      }
    })
}

function scopedStandingRankMap(standings: TeamStanding[], ratingFor: (standing: TeamStanding) => number) {
  return new Map(
    [...standings]
      .sort(compareScopedStandingsByRating(ratingFor))
      .map((standing, index) => [standing.team, index + 1]),
  )
}

function compareScopedStandingsByRating(ratingFor: (standing: TeamStanding) => number) {
  return (left: TeamStanding, right: TeamStanding) =>
    Number(right.eligibility.eligible) - Number(left.eligibility.eligible)
    || ratingFor(right) - ratingFor(left)
}

function teamProfilesForRankingScope(matches: MatchRecord[], teams: Record<string, TeamProfile>) {
  const scopedProfiles = scopedTeamProfilesForMatches(matches, teams)
  const teamNames = new Set([
    ...Object.keys(teams),
    ...matches.flatMap((match) => [match.teamA, match.teamB]),
  ])
  const scopedTeams: Record<string, TeamProfile> = {}

  for (const teamName of teamNames) {
    const fallback = teams[teamName] ?? {
      name: teamName,
      code: teamName.slice(0, 3).toUpperCase(),
      region: 'International' as Region,
      league: 'Unknown',
    }
    const scopedProfile = scopedProfiles.get(teamName)
    scopedTeams[teamName] = scopedProfile
      ? { ...fallback, name: teamName, league: scopedProfile.league, region: scopedProfile.region }
      : { ...fallback, name: teamName }
  }

  return scopedTeams
}

type ScopedTeamProfileObservation = {
  league: string
  region: Region
  count: number
  lastObserved: string
}

function scopedTeamProfilesForMatches(matches: MatchRecord[], teams: Record<string, TeamProfile>) {
  const observations = new Map<string, Map<string, ScopedTeamProfileObservation>>()
  for (const match of matches) {
    observeScopedTeamProfile(match.teamA, match.teamAHomeLeague, match.teamARegion, match.date, observations, teams)
    observeScopedTeamProfile(match.teamB, match.teamBHomeLeague, match.teamBRegion, match.date, observations, teams)
  }

  return new Map(
    Array.from(observations.entries())
      .map(([team, teamObservations]) => {
        const profile = bestScopedTeamProfile(teamObservations)
        return profile ? [team, { league: profile.league, region: profile.region }] as const : undefined
      })
      .filter((entry): entry is readonly [string, Pick<TeamProfile, 'league' | 'region'>] => Boolean(entry)),
  )
}

function observeScopedTeamProfile(
  team: string,
  homeLeague: string | undefined,
  homeRegion: Region | undefined,
  observedAt: string,
  observations: Map<string, Map<string, ScopedTeamProfileObservation>>,
  teams: Record<string, TeamProfile>,
) {
  if (!homeLeague || isUnknownLeague(homeLeague) || isCompetitionOnlyLeague(homeLeague)) return
  const fallback = teams[team]
  const byLeague = observations.get(team) ?? new Map<string, ScopedTeamProfileObservation>()
  observations.set(team, byLeague)
  const current = byLeague.get(homeLeague) ?? {
    league: homeLeague,
    region: homeRegion ?? (fallback?.league === homeLeague ? fallback.region : regionForLeague(homeLeague)),
    count: 0,
    lastObserved: '',
  }
  byLeague.set(homeLeague, {
    ...current,
    region: homeRegion ?? current.region,
    count: current.count + 1,
    lastObserved: observedAt > current.lastObserved ? observedAt : current.lastObserved,
  })
}

function bestScopedTeamProfile(observations: Map<string, ScopedTeamProfileObservation>) {
  return Array.from(observations.values()).sort((left, right) =>
    right.lastObserved.localeCompare(left.lastObserved)
    || right.count - left.count
    || right.league.localeCompare(left.league),
  )[0]
}

function historyKeysForMatches(matches: MatchRecord[]) {
  const keys = new Set<string>()
  for (const match of matches) {
    keys.add(historyKey(match.teamA, match.date, match.event, match.teamB))
    keys.add(historyKey(match.teamB, match.date, match.event, match.teamA))
  }
  return keys
}

function seriesSiblingKeysForMatches(matches: MatchRecord[]) {
  const keys = new Set<string>()
  for (const match of matches) {
    if (match.bestOf <= 1) continue
    keys.add(seriesSiblingKey(match.teamA, match.date, match.teamB))
    keys.add(seriesSiblingKey(match.teamB, match.date, match.teamA))
  }
  return keys
}

function historyKey(team: string, date: string, event: string, opponent: string) {
  return `${team}\u0000${date}\u0000${event}\u0000${opponent}`
}

function seriesSiblingKey(team: string, date: string, opponent: string) {
  return `${team}\u0000${date}\u0000${opponent}`
}

function leagueInternationalMatchesFor(matches: MatchRecord[], teams: Record<string, TeamProfile>) {
  const counts = new Map<string, number>()
  for (const match of matches) {
    const leagueA = sideHomeLeagueForEligibility(match, 'A', teams)
    const leagueB = sideHomeLeagueForEligibility(match, 'B', teams)
    if (!leagueA || !leagueB || leagueA === leagueB) continue
    counts.set(leagueA, (counts.get(leagueA) ?? 0) + 1)
    counts.set(leagueB, (counts.get(leagueB) ?? 0) + 1)
  }
  return counts
}

function sideHomeLeagueForEligibility(match: MatchRecord, side: 'A' | 'B', teams: Record<string, TeamProfile>) {
  const homeLeague = side === 'A' ? match.teamAHomeLeague : match.teamBHomeLeague
  if (homeLeague && !isUnknownLeague(homeLeague) && !isCompetitionOnlyLeague(homeLeague)) return homeLeague
  const team = side === 'A' ? match.teamA : match.teamB
  const fallback = teams[team]?.league
  if (fallback && !isUnknownLeague(fallback) && !isCompetitionOnlyLeague(fallback)) return fallback
  return undefined
}

function isDefaultFilter(filter: SnapshotFilter) {
  return filter.season === 'All' && filter.event === 'All' && filter.region === 'All'
}

function teamNamesForFilter(matches: MatchRecord[], teams: Record<string, TeamProfile>, filter: SnapshotFilter) {
  if (filter.season === 'All' && filter.event === 'All' && filter.region === 'All') {
    return new Set(Object.keys(teams))
  }

  if (filter.region !== 'All') {
    return teamNamesForRegionFilter(matches, teams, filter.region)
  }

  const teamNames = new Set(matches.flatMap((match) => [match.teamA, match.teamB]))
  return teamNames
}

function teamNamesForRegionFilter(matches: MatchRecord[], teams: Record<string, TeamProfile>, region: Region) {
  const teamNames = new Set<string>()
  for (const match of matches) {
    if (sideBelongsToRegion(match, 'A', teams, region)) teamNames.add(match.teamA)
    if (sideBelongsToRegion(match, 'B', teams, region)) teamNames.add(match.teamB)
  }
  return teamNames
}

function sideBelongsToRegion(match: MatchRecord, side: 'A' | 'B', teams: Record<string, TeamProfile>, region: Region) {
  return sideCurrentTopTierRegionForMatch(match, side, teams) === region
}

function sideCurrentTopTierRegionForMatch(match: MatchRecord, side: 'A' | 'B', teams: Record<string, TeamProfile>) {
  const observedRegion = observedSideRegionForMatch(match, side)
  const homeLeague = side === 'A' ? match.teamAHomeLeague : match.teamBHomeLeague
  if (observedRegion || homeLeague) return currentTopTierRegionForLeague(homeLeague, observedRegion)
  const team = side === 'A' ? match.teamA : match.teamB
  return currentTopTierRegionForLeague(teams[team]?.league, teams[team]?.region)
}

function observedSideRegionForMatch(match: MatchRecord, side: 'A' | 'B'): Region | undefined {
  const sideRegion = side === 'A' ? match.teamARegion : match.teamBRegion
  if (sideRegion) return sideRegion
  const homeLeague = side === 'A' ? match.teamAHomeLeague : match.teamBHomeLeague
  if (homeLeague && !isUnknownLeague(homeLeague) && !isCompetitionOnlyLeague(homeLeague)) {
    return regionForLeague(homeLeague)
  }
  if (match.region !== 'International' && !isCompetitionOnlyLeague(match.league)) return match.region
  return undefined
}

function filterEventSummaries(events: EventSummary[], matches: MatchRecord[]) {
  const eventNames = new Set(matches.map((match) => match.event))
  return events.filter((event) => eventNames.has(event.event))
}

function filterSeasonSummaries(seasons: SeasonSummary[], matches: MatchRecord[]) {
  const seasonNumbers = new Set(matches.map((match) => match.season))
  return seasons.filter((season) => seasonNumbers.has(season.season))
}
