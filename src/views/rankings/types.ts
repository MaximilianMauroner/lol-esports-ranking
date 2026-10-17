import type { DataSourceInfo, PublicRollingWindow } from '../../domains/rankings/types'

export type PlayerLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'missing'; message: string }
  | { status: 'error'; message: string }

export type TrajectoryMetric = 'rating' | 'rank'

export type TeamDataSummary = {
  source?: string
  sources?: DataSourceInfo[]
  scopeLabel?: string
  matchCount?: number
  coverageStart?: string
  coverageEnd?: string
  latestMatchDate?: string
  movementBaseline?: string
  rollingWindow?: PublicRollingWindow
  seeded?: boolean
  sourceBreakdown?: { provider: string; matchCount: number }[]
  rosterCoverage?: {
    rosterSides: number
    completeRosterSides: number
    partialRosterSides: number
    missingRosterSides: number
    unresolvedPlayerRows?: number
    postgameObservedRosterSides?: number
  }
  regionFilter?: string
  tournamentFilter?: string
  tableTeamCount?: number
  scopeTeamCount?: number
  hiddenFromRankedCount?: number
}
