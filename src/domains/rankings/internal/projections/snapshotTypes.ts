import type { EventSummary, LeagueStrength, LeagueStrengthHistoryPoint, LeagueTierName, MatchRecord, PlayerStanding, PublishedRatingScale, Region, SeasonSummary, TeamProfile } from '../../types'
import type { TournamentInstanceId } from '../evidence/internationalTournaments'
import type { PlayerMetricInfo, PlayerRatingProof, PUBLIC_ARTIFACT_SCHEMA_VERSION, PublicPlayerDirectory, PublicRankingManifest, PublicRankingShard, PublicRegionHistoryDirectory, PublicRollingWindow, PublicSnapshotIndexEntry, PublicTeamDirectory, PublicTeamHistoryDirectory, PublicTeamHistoryIndex, PublicTeamHistoryPoint, PublicTeamHistorySeries, PublicTeamHistoryShard, PublicTeamStanding, PublicTournamentMovementIndex, PublicTournamentMovementShard } from '../published/schema'
import type { ComputedTeamStanding } from './deservedStandingPublicComparison'
import type { WalkForwardMetrics } from './predictionModel'
import type { RegionStrength } from './regionStrength'

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
  ongoing?: boolean
  description: string
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
  refreshReceipt?: {
    requestedStart?: string
    requestedEnd?: string
    attemptedAt?: string
    status: string
    downloadedCount: number
    reusedCount: number
    failedCount: number
  }
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
  pipelineCounts: {
    importedMatchCount: number
    publishedMatchCount: number
    filteredMatchCount: number
  }
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
    unresolvedPlayerRows?: number
    postgameObservedRosterSides?: number
  }
  identityCoverage: {
    teamProfileCount: number
    mappedTeamProfileCount: number
    unknownLeagueTeamCount: number
    internationalRegionTeamCount: number
    unresolvedLeagueSummaries: DataQualityLeagueSummary[]
    duplicateTeamCodes: Array<{ code: string; teamNames: string[]; teamIds: string[] }>
    unresolvedLineages: Array<{ teamNames: string[]; note: string }>
  }
  notes: string[]
}

export type PlayerDirectory = PublicPlayerDirectory

export type PlayerLifecycleEvent = {
  name: 'player-build' | 'player-compaction'
  scope: 'global' | 'season' | 'directory'
  scopeKey: string
  durationMs: number
  playerCount: number
}

export type PlayerLifecycleReleaseEvent = Pick<PlayerLifecycleEvent, 'scope' | 'scopeKey'>

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
  rollingWindow?: PublicRollingWindow
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
  matches: MatchRecord[]
  /** Incremental builds may compact full player histories before public serialization. */
  precomputedPlayerDirectory?: PlayerDirectory
}

export type RankingSummaryStanding = PublicTeamStanding

export type RankingSummarySnapshot = PublicRankingShard

export type SnapshotIndexEntry = PublicSnapshotIndexEntry

export type StaticRankingSummaryData = PublicRankingManifest
