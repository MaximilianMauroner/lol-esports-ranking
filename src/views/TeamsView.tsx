import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Minus, Search, Users, X } from 'lucide-react'
import type { CompactPlayer, DataSourceInfo, ModelInfo, RankingSummaryStanding, TeamHistorySeries } from '../lib/snapshot'
import type {
  PublicRecentMatch,
  PublicCurrentLineup,
  PublicTournamentMovementIndexEntry,
  PublicTournamentMovementShard,
  PublicTournamentMovementTeam,
} from '../lib/publicArtifacts/schema'
import { displayRegionPowerScore, type RegionStrength } from '../lib/regionStrength'
import type { EventTier } from '../types'
import { extent, formatDate, formatDateRange, formatDecimal, formatModelVersion, formatNumber, formatRating, formatRatio, formatRecord, formatSigned, teamKey } from '../lib/display'
import { deriveTrajectoryInsight, type TrajectoryInsight } from '../lib/trajectory'
import { formatCompetitionLeagueLabel, formatCompetitionRegionLabel } from '../data/regionTaxonomy'
import { eventTierConfig } from '../data/rankingConfig'
import { CountBadge, DataState, FormDots, HeatChip, PickButton, RegionBadge, Segmented, SortHeader } from '../components/ui'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Card } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Select } from '../components/ui/select'
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from '../components/ui/sheet'
import { RankingShowcase, type RankingShowcaseProps } from '../components/RankingShowcase'
import { type ChartSeries } from '../components/LineChart'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import {
  deriveRankingFlair,
  firstPageForTier,
  type RankingFlair,
  type RankingMovementPick,
  type RankingTierAssignment,
  type RankingTierLabel,
} from '../lib/rankingFlair'
import type { ChartPoint } from '../lib/chartPoints'
import { chartPointDetailFromHistoryPoint, dailyChartPointsFromHistoryPoints, deriveDailyRankSeries, withVisibleDeltas } from '../lib/teamHistoryChart'
import { cn } from '../lib/utils'
import type {
  TeamHistoryArtifactState,
  TournamentMovementIndexState,
  TournamentMovementState,
} from '../hooks/usePublicArtifacts'
import { useHistoryDetail } from '../hooks/useHistoryDetail'
import { publishedRatingScale, winProbabilityEloScale } from '../lib/modelConfig'
import { POWER_COMPONENT_LABELS } from '../lib/ratingComponentLabels'
import {
  teamMatchesTournamentFilter,
  projectTournamentStandings,
  tournamentBoundaryLabel,
  tournamentFilterOptionsForStandings,
  tournamentIdFromFilter,
  type TournamentInstanceId,
  type TournamentFilterValue,
} from '../lib/internationalTournaments'

export type PlayerLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'missing'; message: string }
  | { status: 'error'; message: string }

type SortKey = 'rank' | 'rating' | 'wins'
type SortDirection = 'ascending' | 'descending'
type TrajectoryMetric = 'rating' | 'rank'
type EligibilityFilter = 'ranked' | 'all'
type TeamDataSummary = {
  source?: string
  sources?: DataSourceInfo[]
  scopeLabel?: string
  matchCount?: number
  coverageStart?: string
  coverageEnd?: string
  latestMatchDate?: string
  movementBaseline?: string
  seeded?: boolean
  sourceBreakdown?: { provider: string; matchCount: number }[]
  notes?: string[]
  regionFilter?: string
  tournamentFilter?: string
  tableTeamCount?: number
  scopeTeamCount?: number
  hiddenFromRankedCount?: number
}

const TEAM_RANK_AXIS_LIMIT = 60
const TEAM_PAGE_SIZES = [15, 25, 50, 80] as const
const DEFAULT_TEAM_PAGE_SIZE = 25
const RECENT_MATCH_PAGE_SIZE = 5
const pagerClassName = 'flex items-center justify-end gap-[22px] px-0.5 pt-3.5 text-[0.78rem] text-[var(--muted)] [--pager-control-h:32px] max-[900px]:flex-wrap max-[900px]:justify-end max-[900px]:gap-x-[18px] max-[900px]:gap-y-3 max-[720px]:justify-start [&_.pager__buttons]:inline-flex [&_.pager__buttons]:items-center [&_.pager__buttons]:gap-2 [&_.pager__page]:inline-flex [&_.pager__page]:h-[var(--pager-control-h)] [&_.pager__page]:min-w-[92px] [&_.pager__page]:items-center [&_.pager__page]:justify-center [&_.pager__page]:whitespace-nowrap [&_.pager__page]:font-[560] [&_.pager__page]:text-[var(--text)] [&_.pager__page]:tabular-nums [&_[data-slot=button]]:size-[var(--pager-control-h)] [&_[data-slot=button]]:border-[var(--line)] [&_[data-slot=button]]:bg-transparent [&_[data-slot=button]]:text-[var(--muted)] [&_[data-slot=button]]:disabled:opacity-42 [&_[data-slot=button]]:hover:not-disabled:border-[var(--line-strong)] [&_[data-slot=button]]:hover:not-disabled:bg-[var(--surface-2)] [&_[data-slot=button]]:hover:not-disabled:text-[var(--text-strong)]'
const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)']
const ROLE_ORDER = new Map(['Top', 'Jungle', 'Mid', 'Bot', 'Support'].map((role, index) => [role, index]))
const LARGE_POWER_RESUME_RANK_GAP = 7
const LARGE_POWER_RESUME_SCORE_GAP = 100
const LazyTeamHistoryLineChart = lazy(() => import('../components/TeamHistoryLineChart').then((module) => ({ default: module.TeamHistoryLineChart })))
export function TeamsView({
  standings,
  regions,
  model,
  players,
  currentLineups,
  playerLoadState,
  playerScopeLabel,
  search,
  onSearchChange,
  pickedTeams,
  historyState,
  tournamentFilter,
  tournamentMovementEntries,
  tournamentMovementIndexState,
  tournamentMovementState,
  regionsHref,
  dataSummary,
  onToggle,
  onRequestPlayers,
  onRequestTeamHistory,
  onTournamentFilterChange,
  onPrefetchTournament,
  onRetryTournamentMovements,
}: {
  standings: RankingSummaryStanding[]
  regions: RegionStrength[]
  model?: Pick<ModelInfo, 'version' | 'configHash'>
  players?: CompactPlayer[]
  currentLineups?: Record<string, PublicCurrentLineup>
  playerLoadState: PlayerLoadState
  playerScopeLabel?: string
  search: string
  onSearchChange: (value: string) => void
  pickedTeams: RankingSummaryStanding[]
  historyState: TeamHistoryArtifactState
  tournamentFilter: TournamentFilterValue
  tournamentMovementEntries: readonly PublicTournamentMovementIndexEntry[]
  tournamentMovementIndexState: TournamentMovementIndexState
  tournamentMovementState: TournamentMovementState
  regionsHref?: string
  dataSummary?: TeamDataSummary
  onToggle: (team: RankingSummaryStanding) => void
  onRequestPlayers?: () => void
  onRequestTeamHistory?: () => void
  onTournamentFilterChange: (value: TournamentFilterValue) => void
  onPrefetchTournament?: (id: TournamentInstanceId) => void
  onRetryTournamentMovements?: () => void
}) {
  const [region, setRegion] = useState('All')
  const [eligibilityFilter, setEligibilityFilter] = useState<EligibilityFilter>('ranked')
  const [sortKey, setSortKey] = useState<SortKey>('rank')
  const [sortDirection, setSortDirection] = useState<SortDirection>('ascending')
  const [pageSize, setPageSize] = useState<number>(DEFAULT_TEAM_PAGE_SIZE)
  const [pageState, setPageState] = useState({ scopeKey: '', page: 1 })
  const { value: detailKey, open: openDetail, close: closeDetail } = useHistoryDetail('teamDetail')
  const [metric, setMetric] = useState<TrajectoryMetric>('rating')
  const [selectedTier, setSelectedTier] = useState<string | null>(null)
  const pendingTierScrollRef = useRef<string | null>(null)
  const tableWrapRef = useRef<HTMLDivElement | null>(null)
  const trajectoryPanelRef = useRef<HTMLDivElement | null>(null)
  const history = historyState.status === 'ready' ? historyState.data.series : undefined

  const pickedKeys = useMemo(() => new Set(pickedTeams.map(teamKey)), [pickedTeams])

  const regionOptions = useMemo(
    () => ['All', ...Array.from(new Set(standings.map((team) => team.region).filter(Boolean))).sort()],
    [standings],
  )
  const tournamentOptions = useMemo(
    () => tournamentFilterOptionsForStandings(standings, tournamentMovementEntries),
    [standings, tournamentMovementEntries],
  )
  const activeTournamentFilter = useMemo<TournamentFilterValue>(
    () => tournamentOptions.some((option) => option.value === tournamentFilter) ? tournamentFilter : 'All',
    [tournamentOptions, tournamentFilter],
  )
  const exactTournamentId = tournamentIdFromFilter(activeTournamentFilter)
  const activeTournament = tournamentMovementState.status === 'ready' && tournamentMovementState.data.id === exactTournamentId
    ? tournamentMovementState.data
    : undefined
  const displayStandings = useMemo(
    () => activeTournament ? projectTournamentStandings(standings, activeTournament) : standings,
    [activeTournament, standings],
  )
  const movementByTeamId = useMemo(
    () => new Map((activeTournament?.teams ?? []).map((team) => [team.teamId, team])),
    [activeTournament],
  )
  const exactParticipantTeamIds = useMemo(
    () => activeTournament ? new Set(activeTournament.teams.map((team) => team.teamId)) : undefined,
    [activeTournament],
  )
  const activeHistory = useMemo<Record<string, TeamHistorySeries> | undefined>(() => {
    if (!exactTournamentId) return history
    if (!activeTournament) return undefined
    return Object.fromEntries(activeTournament.teams.map((team) => {
      const endpoint = team.points.at(-1)
      const lastMatch = team.points.toReversed().find((point) => (point[3]?.kind ?? 'match') === 'match') ?? endpoint
      return [team.teamId, {
        team: team.team,
        code: team.code,
        points: team.points,
        currentStanding: {
          asOf: activeTournament.boundaryDate,
          rating: endpoint?.[1] ?? team.endRating,
          rank: endpoint?.[2] ?? team.endRank,
          lastMatchRating: lastMatch?.[1] ?? team.endRating,
          adjustment: Number(((endpoint?.[1] ?? team.endRating) - (lastMatch?.[1] ?? team.endRating)).toFixed(1)),
        },
      }]
    }))
  }, [activeTournament, exactTournamentId, history])

  const scopeFiltered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return displayStandings.filter((team) => {
      if (region !== 'All' && team.region !== region) return false
      if (!teamMatchesTournamentFilter(team, activeTournamentFilter, exactParticipantTeamIds)) return false
      if (!query) return true
      return [team.team, team.code, team.region, team.league].some((value) => value?.toLowerCase().includes(query))
    })
  }, [displayStandings, region, search, activeTournamentFilter, exactParticipantTeamIds])

  const filtered = useMemo(
    () => eligibilityFilter === 'ranked' ? scopeFiltered.filter((team) => team.eligibility?.eligible) : scopeFiltered,
    [scopeFiltered, eligibilityFilter],
  )
  const hiddenFromRankedCount = useMemo(
    () => scopeFiltered.filter((team) => !team.eligibility?.eligible).length,
    [scopeFiltered],
  )
  const movementBaseline = activeTournament ? `${activeTournament.label} start` : dataSummary?.movementBaseline ?? 'the previous rating update in this scope'
  const eligibilityNote = hiddenFromRankedCount > 0
    ? eligibilityFilter === 'ranked'
      ? `${formatNumber(hiddenFromRankedCount)} ineligible teams hidden`
      : `${formatNumber(hiddenFromRankedCount)} teams aren't eligible for ranking`
    : undefined
  const panelData = useMemo<TeamDataSummary | undefined>(() => dataSummary
    ? {
        ...dataSummary,
        regionFilter: region,
        tournamentFilter: activeTournamentFilter,
        tableTeamCount: filtered.length,
        scopeTeamCount: displayStandings.length,
        hiddenFromRankedCount,
      }
    : undefined,
  [dataSummary, filtered.length, hiddenFromRankedCount, region, displayStandings.length, activeTournamentFilter])

  const rankedTierUniverse = useMemo(
    () => displayStandings.filter((team) => team.eligibility?.eligible),
    [displayStandings],
  )
  const rankingFlair = useMemo<RankingFlair>(
    () => deriveRankingFlair(filtered, { tierUniverse: rankedTierUniverse }),
    [filtered, rankedTierUniverse],
  )
  const tierAssignments: RankingTierAssignment[] = rankingFlair.tiers
  const rankingSignals = useMemo(
    () => activeTournament
      ? tournamentRankingSignalsProps(rankingFlair, activeTournament)
      : rankingSignalsProps(rankingFlair, movementBaseline),
    [activeTournament, rankingFlair, movementBaseline],
  )
  const tierByTeam = useMemo(
    () => new Map(tierAssignments.map((tier) => [tier.team.toLocaleLowerCase('en'), tier.tier])),
    [tierAssignments],
  )
  const activeSelectedTier = selectedTier && tierAssignments.some((assignment) => assignment.tier === selectedTier)
    ? selectedTier
    : null
  const rawScoreRankByTeam = useMemo(() => rawScoreRanks(scopeFiltered), [scopeFiltered])
  const sorted = useMemo(() => sortStandings(filtered, sortKey, sortDirection), [filtered, sortDirection, sortKey])
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const pageScopeKey = `${region}\u0000${activeTournamentFilter}\u0000${eligibilityFilter}\u0000${search}\u0000${sortKey}\u0000${sortDirection}\u0000${pageSize}`
  const requestedPage = pageState.scopeKey === pageScopeKey ? pageState.page : 1
  const currentPage = Math.min(requestedPage, totalPages)
  const pageStart = (currentPage - 1) * pageSize
  const visible = sorted.slice(pageStart, pageStart + pageSize)
  const pageEnd = sorted.length === 0 ? 0 : pageStart + visible.length
  const resultSummary = `${formatNumber(sorted.length === 0 ? 0 : pageStart + 1)}-${formatNumber(pageEnd)} of ${formatNumber(filtered.length)}`
  const hasActiveFilters = search.trim() !== '' || region !== 'All' || activeTournamentFilter !== 'All' || eligibilityFilter !== 'ranked'
  const [ratingMin, ratingMax] = useMemo(
    () => extent(filtered.map((team) => teamScoreFor(team) ?? Number.NaN)),
    [filtered],
  )

  const detailTeam = useMemo(
    () => (detailKey ? displayStandings.find((team) => teamKey(team) === detailKey) : undefined),
    [detailKey, displayStandings],
  )
  const detailPlayers = useMemo(
    () => (detailTeam ? playersForTeam(players, detailTeam) : []),
    [detailTeam, players],
  )
  const detailLineup = detailTeam ? currentLineups?.[detailTeam.teamId] : undefined

  useEffect(() => {
    if (!activeSelectedTier || pendingTierScrollRef.current !== activeSelectedTier) return undefined
    const frame = window.requestAnimationFrame(() => {
      const row = tableWrapRef.current?.querySelector<HTMLElement>('tr.gpr-row.is-tier-highlight')
      if (row && !isVerticallyInViewport(row)) {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
      pendingTierScrollRef.current = null
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeSelectedTier, visible])

  useEffect(() => {
    if (!onRequestTeamHistory || exactTournamentId) return undefined
    const panel = trajectoryPanelRef.current
    if (!panel) return undefined

    const IntersectionObserverCtor = Reflect.get(window, 'IntersectionObserver') as typeof IntersectionObserver | undefined
    if (!IntersectionObserverCtor) {
      const handle = window.setTimeout(onRequestTeamHistory, 1200)
      return () => window.clearTimeout(handle)
    }

    const observer = new IntersectionObserverCtor((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      onRequestTeamHistory()
      observer.disconnect()
    }, { rootMargin: '420px 0px' })

    observer.observe(panel)
    return () => observer.disconnect()
  }, [exactTournamentId, onRequestTeamHistory])

  const pickedFocusTeams = useMemo(
    () => {
      const displayByKey = new Map(displayStandings.map((team) => [teamKey(team), team]))
      return pickedTeams.flatMap((team) => {
        const displayTeam = displayByKey.get(teamKey(team))
        return displayTeam && (!exactTournamentId || activeHistory?.[teamKey(displayTeam)]) ? [displayTeam] : []
      })
    },
    [activeHistory, displayStandings, exactTournamentId, pickedTeams],
  )
  const focusTeams = pickedFocusTeams.length > 0 ? pickedFocusTeams : sorted.slice(0, 5)
  const dailyRankSeries = useMemo(
    () => metric === 'rank' && activeHistory && !exactTournamentId ? deriveDailyRankSeries(activeHistory) : new Map<string, ChartPoint[]>(),
    [activeHistory, exactTournamentId, metric],
  )
  const chartSeries = useMemo<ChartSeries[]>(() => {
    if (!activeHistory) return []
    return focusTeams
      .map((team, index): ChartSeries | null => {
        const series = activeHistory[teamKey(team)]
        const key = teamKey(team)
        if (exactTournamentId) {
          if (!series || series.points.length < 2) return null
          return {
            id: key,
            label: team.code ?? team.team,
            color: SERIES_COLORS[index % SERIES_COLORS.length],
            points: tournamentChartPoints(series.points, metric),
          }
        }
        if (metric === 'rank') {
          const points = dailyRankSeries.get(key) ?? []
          if (points.length < 2) return null
          return {
            id: key,
            label: team.code ?? team.team,
            color: SERIES_COLORS[index % SERIES_COLORS.length],
            points,
          }
        }
        if (!series || series.points.length < 2) return null
        const daily = dailyChartPointsFromHistoryPoints(series.points)
        if (daily.length < 2) return null
        return {
          id: key,
          label: team.code ?? team.team,
          color: SERIES_COLORS[index % SERIES_COLORS.length],
          points: daily,
        }
      })
      .filter((series): series is ChartSeries => series !== null)
  }, [activeHistory, dailyRankSeries, exactTournamentId, focusTeams, metric])

  const rankAxis = useMemo(() => {
    if (metric !== 'rank') return undefined
    return rankAxisForSeries(chartSeries)
  }, [chartSeries, metric])

  const insights = useMemo(
    () =>
      focusTeams
        .map((team, index) => ({
          team,
          color: SERIES_COLORS[index % SERIES_COLORS.length],
          insight: tournamentTrajectoryInsight(team, activeHistory?.[teamKey(team)], Boolean(activeTournament)),
        }))
        .filter((entry): entry is { team: RankingSummaryStanding; color: string; insight: TrajectoryInsight } =>
          entry.insight !== null,
        ),
    [activeHistory, activeTournament, focusTeams],
  )

  function onSort(key: string) {
    const nextKey = key as SortKey
    if (nextKey === sortKey) {
      setSortDirection((direction) => direction === 'ascending' ? 'descending' : 'ascending')
      return
    }
    setSortKey(nextKey)
    setSortDirection(nextKey === 'rank' ? 'ascending' : 'descending')
  }

  function updatePage(nextPage: number) {
    setPageState({ scopeKey: pageScopeKey, page: Math.min(Math.max(1, nextPage), totalPages) })
  }

  function updatePageSize(value: number) {
    setPageSize(value)
  }

  function updateTournamentFilter(value: TournamentFilterValue) {
    const id = tournamentIdFromFilter(value)
    if (id) {
      setEligibilityFilter('all')
      onPrefetchTournament?.(id)
    }
    onTournamentFilterChange(value)
    setPageState({ scopeKey: pageScopeKey, page: 1 })
  }

  function resetFilters() {
    onSearchChange('')
    setRegion('All')
    onTournamentFilterChange('All')
    setEligibilityFilter('ranked')
    setPageState({ scopeKey: pageScopeKey, page: 1 })
  }

  return (
    <div className="flex min-w-0 flex-col gap-[22px] px-[var(--page-x)] pt-6">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_320px] items-start gap-[22px] max-[1180px]:grid-cols-1">
        <div className="min-w-0">
          <Card className="min-w-0 rounded-[var(--r-lg)] border border-[var(--line)] bg-[var(--surface)]">
            <div className="grid gap-2 border-b border-[var(--line)] px-3.5 py-3 [--gpr-control-h:36px] max-sm:grid-cols-1 max-sm:[--gpr-control-h:44px] [@media(pointer:coarse)]:[--gpr-control-h:44px]">
              <div className="grid min-w-0 gap-2 max-[900px]:w-full max-sm:grid-cols-1" role="group" aria-label="Team ranking filters">
                <div className="grid min-w-0 grid-cols-[minmax(220px,1fr)_auto_auto] items-center gap-2 max-[900px]:grid-cols-[minmax(180px,1fr)_auto_auto] max-sm:w-full max-sm:grid-cols-1">
                  <label className="inline-flex h-[var(--gpr-control-h)] w-full min-w-0 items-center gap-2 rounded-[var(--r-sm)] border border-[var(--line-strong)] bg-[color-mix(in_oklch,var(--surface-2)_72%,transparent)] px-2.5 text-[var(--muted)] transition-[border-color,box-shadow,background-color] duration-160 focus-within:border-[var(--accent-line)] focus-within:shadow-[0_0_0_1px_color-mix(in_oklch,var(--accent)_34%,transparent)] max-sm:max-w-full [&_[data-slot=input]]:h-[calc(var(--gpr-control-h)-2px)] [&_[data-slot=input]]:min-h-0 [&_[data-slot=input]]:border-0 [&_[data-slot=input]]:bg-transparent [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:text-[var(--text)] [&_[data-slot=input]]:shadow-none [&_[data-slot=input]]:focus-visible:border-0 [&_[data-slot=input]]:focus-visible:ring-0 [&_[data-slot=input]]:focus-visible:outline-none">
                    <Search size={16} aria-hidden="true" />
                    <span className="sr-only">Search teams</span>
                    <Input
                      type="search"
                      value={search}
                      placeholder="Filter teams..."
                      onChange={(event) => onSearchChange(event.target.value)}
                    />
                  </label>
                  <Segmented
                    value={eligibilityFilter}
                    options={[
                      { value: 'ranked', label: 'Eligible only' },
                      { value: 'all', label: 'All teams' },
                    ]}
                    onChange={setEligibilityFilter}
                    ariaLabel="Team eligibility filter"
                    className="min-h-[var(--gpr-control-h)] flex-nowrap rounded-[var(--r-sm)] border-[var(--line-strong)] bg-[color-mix(in_oklch,var(--surface-2)_72%,transparent)] max-sm:w-full max-sm:max-w-full [&_[data-slot=button]]:h-[calc(var(--gpr-control-h)-8px)] [&_[data-slot=button]]:rounded-[calc(var(--r-sm)-1px)] [&_[data-slot=button]]:px-2.5"
                  />
                  <span className="justify-self-end whitespace-nowrap text-[0.76rem] text-[var(--faint)] tabular-nums max-sm:justify-self-start">{resultSummary}</span>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 max-sm:grid max-sm:w-full max-sm:grid-cols-2">
                  <label className="inline-flex min-w-0 items-center gap-2 max-sm:grid max-sm:w-full max-sm:max-w-full max-sm:gap-1.5 [&_[data-slot=select]]:h-[var(--gpr-control-h)] [&_[data-slot=select]]:min-h-[var(--gpr-control-h)] [&_[data-slot=select]]:min-w-[116px] [&_[data-slot=select]]:rounded-[var(--r-sm)] [&_[data-slot=select]]:bg-[color-mix(in_oklch,var(--surface-2)_72%,transparent)] [&_[data-slot=select]]:text-[0.82rem] max-sm:[&_[data-slot=select]]:min-w-0 max-sm:[&_[data-slot=select]]:w-full max-sm:[&_select]:w-full">
                    <span className="whitespace-nowrap text-[0.78rem] font-[520] text-[var(--muted)]">Region</span>
                    <Select value={region} onChange={(event) => setRegion(event.target.value)}>
                      {regionOptions.map((option) => (
                        <option key={option} value={option}>
                          {formatCompetitionRegionLabel(option)}
                        </option>
                      ))}
                    </Select>
                  </label>
                  {tournamentOptions.length > 1 || tournamentMovementIndexState.status === 'loading' ? (
                    <label className="inline-flex min-w-0 items-center gap-2 max-sm:grid max-sm:w-full max-sm:max-w-full max-sm:gap-1.5 [&_[data-slot=select]]:h-[var(--gpr-control-h)] [&_[data-slot=select]]:min-h-[var(--gpr-control-h)] [&_[data-slot=select]]:w-[clamp(180px,24vw,260px)] [&_[data-slot=select]]:rounded-[var(--r-sm)] [&_[data-slot=select]]:bg-[color-mix(in_oklch,var(--surface-2)_72%,transparent)] [&_[data-slot=select]]:text-[0.82rem] max-sm:[&_[data-slot=select]]:min-w-0 max-sm:[&_[data-slot=select]]:w-full max-sm:[&_select]:w-full">
                      <span className="whitespace-nowrap text-[0.78rem] font-[520] text-[var(--muted)]">Tournament</span>
                      <Select value={activeTournamentFilter} onChange={(event) => updateTournamentFilter(event.target.value as TournamentFilterValue)}>
                        {tournamentOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.value === 'All' ? option.label : `${option.label} (${formatNumber(option.count)})`}
                          </option>
                        ))}
                        {tournamentMovementIndexState.status === 'loading' ? <option disabled>Loading exact tournaments…</option> : null}
                      </Select>
                    </label>
                  ) : null}
                  {hasActiveFilters ? (
                    <Button type="button" variant="ghost" size="sm" className="ml-auto h-[var(--gpr-control-h)] text-[var(--muted)] max-sm:col-span-full max-sm:ml-0 max-sm:justify-self-start" onClick={resetFilters}>
                      Reset
                      <X size={14} aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
              </div>
              {eligibilityNote ? <p className="text-[0.73rem] leading-[1.35] text-[var(--faint)]">{eligibilityNote}</p> : null}
            </div>

            {tournamentMovementIndexState.status === 'missing' || tournamentMovementIndexState.status === 'error' ? (
              <DataState icon={<Users size={26} aria-hidden="true" />} title="Exact tournament history unavailable">
                <p>{tournamentMovementIndexState.message}</p>
                <Button type="button" variant="outline" size="sm" onClick={onRetryTournamentMovements}>Retry tournament history</Button>
              </DataState>
            ) : null}

            {exactTournamentId && (tournamentMovementState.status === 'idle' || tournamentMovementState.status === 'loading') ? (
              <DataState icon={<Users size={26} aria-hidden="true" />} title="Loading tournament movement">
                Loading the shared start and endpoint ranks for this exact tournament.
              </DataState>
            ) : exactTournamentId && (tournamentMovementState.status === 'missing' || tournamentMovementState.status === 'error') ? (
              <DataState icon={<Users size={26} aria-hidden="true" />} title="Tournament movement unavailable">
                <p>{tournamentMovementState.message}</p>
                <Button type="button" variant="outline" size="sm" onClick={onRetryTournamentMovements}>Retry tournament movement</Button>
              </DataState>
            ) : visible.length === 0 ? (
              <DataState icon={<Users size={26} aria-hidden="true" />} title="No teams match">
                Adjust the search, region, tournament, or eligibility filter to see teams.
              </DataState>
            ) : (
                <Table containerRef={tableWrapRef} containerClassName="max-w-full [contain:paint] [overscroll-behavior-x:contain]" className="ranking-table gpr-grid w-full min-w-[660px] border-collapse text-[0.86rem] max-sm:min-w-full [&_thead_th]:whitespace-nowrap [&_thead_th]:border-b [&_thead_th]:border-[var(--line)] [&_thead_th]:bg-[var(--surface-2)] [&_thead_th]:px-3.5 [&_thead_th]:py-[11px] [&_thead_th]:text-left [&_thead_th]:text-[0.7rem] [&_thead_th]:font-semibold [&_thead_th]:tracking-[0.08em] [&_thead_th]:text-[var(--faint)] [&_thead_th]:uppercase [&_tbody_td]:border-b [&_tbody_td]:border-[var(--line)] [&_tbody_td]:px-3.5 [&_tbody_td]:py-[11px] [&_tbody_td]:align-middle [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-[var(--surface-2)] [&_tbody_tr.is-picked]:bg-[var(--accent-soft)] [&_tbody_tr:last-child_td]:border-b-0 [&_th.center]:text-center [&_td.center]:text-center [&_th.right]:text-right [&_td.right]:text-right">
                  <colgroup>
                    <col className="gpr-col-rank" />
                    <col className="gpr-col-team" />
                    <col className="gpr-col-score" />
                    <col className="gpr-col-trend" />
                    <col className="gpr-col-record" />
                    <col className="gpr-col-action" />
                  </colgroup>
                  <TableHeader>
                    <TableRow>
                      <SortHeader label="Rank" columnKey="rank" sortKey={sortKey} descending={sortDirection === 'descending'} onSort={onSort} />
                      <TableHead>Team</TableHead>
                      <SortHeader label="Power score" columnKey="rating" sortKey={sortKey} descending={sortDirection === 'descending'} onSort={onSort} align="right" />
                      <TableHead className="gpr-col-trend" title={`Movement = rank change vs ${movementBaseline}.`}>
                        {activeTournament ? 'Tournament move' : 'Movement'}
                      </TableHead>
                      <SortHeader label="Match W/L" columnKey="wins" sortKey={sortKey} descending={sortDirection === 'descending'} onSort={onSort} align="right" className="gpr-col-record" />
                      <TableHead className="center" aria-label="Add to comparison" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((team) => {
                      const key = teamKey(team)
                      const total = team.wins + team.losses
                      const rank = teamRankFor(team)
                      const historySeries = history?.[key]
                      const tier = tierByTeam.get(team.team.toLocaleLowerCase('en'))
                      const tierHighlighted = Boolean(activeSelectedTier && tier === activeSelectedTier)
                      const excludedFromRankedBoard = team.eligibility?.eligible === false
                      const rawScoreRank = rawScoreRankByTeam.get(key)
                      const openTeamDetail = () => {
                        onRequestPlayers?.()
                        onRequestTeamHistory?.()
                        openDetail(key)
                      }
                      return (
                        <TableRow
                          key={key}
                          className={cn(
                            'gpr-row group/gpr cursor-pointer outline-offset-[-2px] hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--focus)]',
                            pickedKeys.has(key) && 'is-picked',
                            tierHighlighted && 'is-tier-highlight bg-[color-mix(in_oklch,var(--accent)_12%,var(--surface))] shadow-[inset_3px_0_0_var(--accent)] hover:bg-[color-mix(in_oklch,var(--accent)_16%,var(--surface-2))]',
                            excludedFromRankedBoard && 'is-excluded bg-[color-mix(in_oklch,var(--surface-2)_58%,transparent)] text-[color-mix(in_oklch,var(--text)_76%,var(--muted))] hover:bg-[color-mix(in_oklch,var(--surface-3)_70%,transparent)]',
                          )}
                          title={excludedFromRankedBoard ? eligibilityReasonsTitle(team) : undefined}
                          onClick={(event) => {
                            if (shouldIgnoreTeamRowClick(event)) return
                            openTeamDetail()
                          }}
                        >
                          <TableCell className="gpr-col-trend">
                            <span className="gpr-rankcell flex items-center gap-[9px] whitespace-nowrap">
                              <TeamBoardRank team={team} rank={rank} rawScoreRank={rawScoreRank} />
                              {tier ? <TierBadge tier={tier} /> : null}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Button
                              type="button"
                              variant="ghost"
                              className="team-cell team-cell__button h-auto min-h-9 w-full cursor-pointer justify-start gap-[11px] whitespace-normal rounded-[var(--r-sm)] border-0 bg-transparent p-0 text-left font-[inherit] text-[inherit] hover:bg-transparent hover:text-[inherit] focus-visible:rounded-[var(--r-sm)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--focus)]"
                              onClick={openTeamDetail}
                              onFocus={onRequestPlayers}
                              title={`View ${team.team} details`}
                            >
                              <span className="team-mark sm inline-grid h-7 w-[42px] place-items-center rounded-[var(--r-sm)] border border-[oklch(0.79_0.155_205/0.32)] bg-[oklch(0.79_0.155_205/0.11)] font-mono text-[0.72rem] font-extrabold tracking-[0.02em] text-[var(--accent-strong)]">{team.code ?? team.team.slice(0, 3).toUpperCase()}</span>
                              <div className="ent flex min-w-0 flex-col gap-px overflow-hidden [&_b]:block [&_b]:overflow-hidden [&_b]:text-ellipsis [&_b]:whitespace-nowrap [&_b]:font-[620] [&_b]:text-[var(--text-strong)] [&_small]:block [&_small]:overflow-hidden [&_small]:text-ellipsis [&_small]:whitespace-nowrap [&_small]:text-[0.74rem] [&_small]:text-[var(--faint)]">
                                <b>{team.team}</b>
                                <small>{teamSubtitle(team)}</small>
                              </div>
                            </Button>
                          </TableCell>
                          <TableCell className="right">
                            <TeamScoreCell team={team} min={ratingMin} max={ratingMax} exactTournament={Boolean(activeTournament)} />
                          </TableCell>
                          <TableCell>
                            {activeTournament ? (
                              <TournamentRankTrendCell
                                movement={movementByTeamId.get(team.teamId)}
                                endpointLabel={tournamentBoundaryLabel(activeTournament.status)}
                              />
                            ) : (
                              <TeamRankTrendCell team={team} series={historySeries} movementBaseline={movementBaseline} />
                            )}
                          </TableCell>
                          <TableCell className="right num gpr-col-record">
                            <b className="font-[680] text-[var(--text-strong)]">{formatRecord(team.wins, team.losses)}</b>{' '}
                            <span className="text-[0.8rem] text-[var(--faint)]">{formatRatio(total > 0 ? team.wins / total : undefined)}</span>
                          </TableCell>
                          <TableCell className="center">
                            <PickButton picked={pickedKeys.has(key)} onToggle={() => onToggle(team)} label={team.team} />
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
            )}

            {sorted.length > 0 ? (
              <div className={pagerClassName} aria-label="Team table pagination">
                <div className="pager__size inline-flex items-center gap-2 [&_[data-slot=select]]:h-[var(--pager-control-h)] [&_[data-slot=select]]:min-h-[var(--pager-control-h)] [&_[data-slot=select]]:min-w-[70px] [&_[data-slot=select]]:max-w-[76px] [&_[data-slot=select]]:pl-2.5 [&_[data-slot=select]]:text-[0.78rem]">
                  <span className="whitespace-nowrap text-[0.78rem] font-[560] text-[var(--text)]">Rows per page</span>
                  <Select aria-label="Rows per page" value={String(pageSize)} onChange={(event) => updatePageSize(Number(event.target.value))}>
                    {TEAM_PAGE_SIZES.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="pager__page">
                  Page {currentPage} of {totalPages}
                </div>
                <div className="pager__buttons max-[900px]:justify-end">
                  <Button type="button" variant="outline" size="icon" className="pager__edge max-[720px]:hidden" onClick={() => updatePage(1)} disabled={currentPage === 1} aria-label="First page">
                    <ChevronsLeft size={16} aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="outline" size="icon" onClick={() => updatePage(currentPage - 1)} disabled={currentPage === 1} aria-label="Previous page">
                    <ChevronLeft size={16} aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="outline" size="icon" onClick={() => updatePage(currentPage + 1)} disabled={currentPage === totalPages} aria-label="Next page">
                    <ChevronRight size={16} aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="outline" size="icon" className="pager__edge max-[720px]:hidden" onClick={() => updatePage(totalPages)} disabled={currentPage === totalPages} aria-label="Last page">
                    <ChevronsRight size={16} aria-hidden="true" />
                  </Button>
                </div>
              </div>
            ) : null}
          </Card>
        </div>

        <aside className="gpr-sidebar sticky top-[76px] grid min-w-0 gap-3.5 max-[1180px]:static max-[1180px]:grid-cols-2 max-[900px]:grid-cols-1">
          <RegionalStrengthTeaser regions={regions} href={regionsHref} />
          <RankingShowcase
            {...rankingSignals}
            variant="rail"
            selectedTier={activeSelectedTier}
            onTierSelect={(tier) => {
              if (!isRankingTierLabel(tier)) return
              const nextTier = activeSelectedTier === tier ? null : tier
              if (nextTier) {
                const page = firstPageForTier(sorted, tierAssignments, nextTier, pageSize)
                if (page) setPageState({ scopeKey: pageScopeKey, page })
              }
              pendingTierScrollRef.current = nextTier
              setSelectedTier(nextTier)
            }}
          />
        </aside>
      </div>

      <Card
        className="min-w-0 rounded-[var(--r-lg)] border border-[var(--line-strong)] bg-[var(--surface)]"
        ref={trajectoryPanelRef}
        onFocusCapture={onRequestTeamHistory}
        onPointerEnter={onRequestTeamHistory}
      >
        <div className="flex flex-wrap items-start gap-3 border-b border-[var(--line)] px-[18px] py-4">
          <div className="grid min-w-[min(100%,260px)] gap-[3px]">
            <p className="text-[0.66rem] tracking-[0.14em] text-[var(--faint)] uppercase">{activeTournament ? 'Tournament window' : 'Over time'}</p>
            <h2 className="text-base font-[640] text-[var(--text-strong)]">{activeTournament ? `${activeTournament.label} movement` : 'Power & rank over time'}</h2>
            <p className="max-w-[64ch] text-[0.78rem] leading-[1.45] text-[var(--faint)]">
              {activeTournament
                ? `${tournamentBoundaryLabel(activeTournament.status)} boundary ${formatDate(activeTournament.boundaryDate)} · rated through ${formatDate(activeTournament.ratedThroughDate)}.`
                : metric === 'rank'
                ? 'Daily closing global rank within the current scope; #1 is pinned to the top.'
                : 'Daily closing power score for the selected comparison set.'}
            </p>
          </div>
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2.5 max-sm:ml-0 max-sm:justify-start">
            <Segmented
              value={metric}
              options={[
                { value: 'rating', label: 'Power score' },
                { value: 'rank', label: 'Rank' },
              ]}
              onChange={setMetric}
              ariaLabel="Team trajectory metric"
            />
            <CountBadge>
              {pickedFocusTeams.length > 0 ? `${chartSeries.length} selected` : 'Showing top 5 · pick teams above to focus'}
            </CountBadge>
          </div>
        </div>
        {exactTournamentId && (tournamentMovementState.status === 'idle' || tournamentMovementState.status === 'loading') ? (
          <p className="text-[var(--muted)] p-5">Loading tournament movement…</p>
        ) : exactTournamentId && (tournamentMovementState.status === 'missing' || tournamentMovementState.status === 'error') ? (
          <p className="text-[var(--muted)] p-5">{tournamentMovementState.message}</p>
        ) : !exactTournamentId && historyState.status === 'idle' ? (
          <p className="text-[var(--muted)] p-5">Rating history loads when this panel is viewed.</p>
        ) : !exactTournamentId && historyState.status === 'loading' ? (
          <p className="text-[var(--muted)] p-5">Loading rating history…</p>
        ) : !exactTournamentId && (historyState.status === 'missing' || historyState.status === 'error') ? (
          <p className="text-[var(--muted)] p-5">{historyState.message}</p>
        ) : (
          <Suspense fallback={<p className="text-[var(--muted)] p-5">Loading chart...</p>}>
            <LazyTeamHistoryLineChart
              series={chartSeries}
              height={300}
              yLabel={metric === 'rank' ? 'Rank' : 'Power score'}
              yFormat={metric === 'rank' ? (value) => `#${Math.round(value)}` : undefined}
              yTickFormat={metric === 'rank' ? (value) => Math.round(value) === 1 ? '#1 best' : `#${Math.round(value)}` : undefined}
              yDomain={rankAxis?.domain}
              yTicks={rankAxis?.ticks}
              yReverse={metric === 'rank'}
              curve={metric === 'rank' ? 'step' : 'linear'}
            />
          </Suspense>
        )}
        {insights.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-2.5 px-[18px] pt-1 pb-[18px]">
            {insights.map(({ team, color, insight }) => (
              <article className="grid gap-2 rounded-[var(--r)] border border-[var(--line)] bg-[var(--surface-2)] px-3.5 py-[13px]" key={teamKey(team)}>
                <div className="flex items-center gap-2">
                  <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: color }} aria-hidden="true" />
                  <b className="mr-auto text-[0.92rem] font-[660] text-[var(--text-strong)]">{team.code ?? team.team}</b>
                  <span className={cn('font-mono text-[0.76rem] tabular-nums', insight.netChange > 0 ? 'text-[var(--up)]' : insight.netChange < 0 ? 'text-[var(--down)]' : 'text-[var(--faint)]')}>
                    {formatSigned(insight.netChange)}
                  </span>
                </div>
                <p className="text-[0.8rem] leading-[1.5] text-[var(--muted)]">{insight.summary}</p>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[0.74rem] text-[var(--faint)] [&_b]:font-[640] [&_b]:text-[var(--text)] [&_b]:tabular-nums">
                  <span>
                    Peak <b>{formatRating(insight.peak.value)}</b>
                    {typeof insight.bestRank === 'number' ? ` · best #${insight.bestRank}` : ''}
                  </span>
                  {insight.driver ? <span className="text-[var(--accent-strong)]">Driven by {insight.driver.label}</span> : null}
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </Card>

      <DataSourcesDisclosure model={model} data={panelData} />

      {detailTeam ? (
        <TeamDetailDrawer
          team={detailTeam}
          standings={displayStandings}
          series={activeHistory?.[teamKey(detailTeam)]}
          historyState={historyState}
          tournament={activeTournament}
          tournamentMovement={movementByTeamId.get(detailTeam.teamId)}
          players={detailPlayers}
          currentLineup={detailLineup}
          playerLoadState={playerLoadState}
          playerScopeLabel={playerScopeLabel}
          seeded={Boolean(panelData?.seeded)}
          onClose={closeDetail}
        />
      ) : null}
    </div>
  )
}

const TEAM_ROW_CLICK_EXCLUDED_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[contenteditable="true"]',
  '[data-row-click-exclude]',
].join(',')

function shouldIgnoreTeamRowClick(event: MouseEvent<HTMLTableRowElement>) {
  if (event.defaultPrevented) return true
  const target = event.target
  return target instanceof Element && Boolean(target.closest(TEAM_ROW_CLICK_EXCLUDED_SELECTOR))
}

function TeamScoreCell({
  team,
  exactTournament = false,
}: {
  team: RankingSummaryStanding
  min: number
  max: number
  exactTournament?: boolean
}) {
  const score = teamScoreFor(team)
  return (
    <span className="team-score-stack grid w-full min-w-0 justify-items-end gap-[3px] overflow-hidden" title={exactTournament ? `Tournament endpoint Power score ${formatRating(score)}` : teamScoreTitle(team)}>
      {typeof score === 'number' ? (
        <span className="team-score-value inline-block min-w-[68px] max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-[0.94rem] font-[760] leading-[1.2] text-[var(--text-strong)] tabular-nums">{formatRating(score)}</span>
      ) : (
        <span className="score-unavailable inline-flex min-w-11 items-center justify-end font-mono text-[0.84rem] font-semibold text-[var(--faint)]">—</span>
      )}
      {exactTournament ? null : <TeamScoreMeta team={team} />}
    </span>
  )
}

function TeamBoardRank({
  team,
  rank,
  rawScoreRank,
}: {
  team: RankingSummaryStanding
  rank?: number
  rawScoreRank?: number
}) {
  if (team.eligibility?.eligible === false) {
    return (
      <span className="gpr-rank-stack inline-flex min-w-0 flex-col items-start gap-[3px]">
        <span className="gpr-rank gpr-rank--excluded min-w-0 text-[0.76rem] font-bold text-[var(--muted)] uppercase tabular-nums">Excluded</span>
        {typeof rawScoreRank === 'number' ? (
          <span className="rank-context-pill inline-flex min-w-0 max-w-[92px] items-center overflow-hidden text-ellipsis whitespace-nowrap rounded-[var(--r-sm)] border border-[var(--line)] bg-[color-mix(in_oklch,var(--surface-3)_72%,transparent)] px-1.5 py-0.5 text-[0.62rem] font-bold leading-none text-[var(--faint)]" title="Raw score order if eligibility gates were ignored.">
            Score #{formatNumber(rawScoreRank)}
          </span>
        ) : null}
      </span>
    )
  }

  return (
    <span className={cn('gpr-rank min-w-[1.4em] text-[1.05rem] font-bold text-[var(--text-strong)] tabular-nums', typeof rank === 'number' && rank <= 3 && 'podium text-[var(--accent-strong)]')}>
      {rank ?? '—'}
    </span>
  )
}

function TeamScoreMeta({ team }: { team: RankingSummaryStanding }) {
  const dss = team.deservedStanding
  const powerResumeGap = powerResumeGapSummary(team)
  const items = [
    ...(typeof team.uncertainty === 'number' && Number.isFinite(team.uncertainty)
      ? [{ key: 'uncertainty', label: formatUncertaintyBand(team.uncertainty), title: 'Estimated score uncertainty. Smaller bands mean firmer placement.' }]
      : []),
    ...(team.eligibility?.eligible === false
      ? [{ key: 'eligibility', label: eligibilitySummary(team), title: eligibilityReasonsTitle(team) }]
      : []),
    ...(dss && dss.eligibility !== 'Eligible'
      ? [{ key: 'dss', label: dss.eligibility, title: teamScoreTitle(team) }]
      : []),
    ...(powerResumeGap?.isLarge
      ? [{ key: 'power-resume-gap', label: powerResumeGap.shortLabel, title: powerResumeGap.title }]
      : []),
  ]
  if (items.length === 0) return null
  return (
    <span className="score-meta mt-[5px] flex w-full min-w-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 overflow-hidden text-[0.68rem] leading-[1.25] text-[var(--faint)] tabular-nums">
      {items.map((item) => <span className="min-w-0 max-w-full flex-[0_1_auto] overflow-hidden text-ellipsis whitespace-nowrap" key={item.key} title={item.title}>{item.label}</span>)}
    </span>
  )
}

function TierBadge({ tier }: { tier: RankingTierLabel }) {
  return (
    <span
      className={cn(
        'tier-badge inline-flex h-6 min-w-[26px] items-center justify-center rounded-[var(--r-sm)] border border-[var(--tier-border)] bg-[var(--tier-bg)] px-[7px] font-mono text-[0.82rem] font-[820] leading-none text-[var(--tier-color)] [--tier-bg:color-mix(in_oklch,var(--tier-color)_10%,transparent)] [--tier-border:color-mix(in_oklch,var(--tier-color)_34%,var(--line))] [--tier-color:var(--muted)]',
        tier === 'S' && '[--tier-bg:color-mix(in_oklch,var(--rank-gold)_13%,transparent)] [--tier-border:color-mix(in_oklch,var(--rank-gold)_48%,var(--line))] [--tier-color:var(--rank-gold)]',
        tier === 'A' && '[--tier-color:oklch(0.82_0.08_215)]',
        tier === 'B' && '[--tier-color:oklch(0.77_0.12_138)]',
        tier === 'C' && '[--tier-color:oklch(0.75_0.13_54)]',
      )}
      role="img"
      title={`${tier}-tier`}
      aria-label={`${tier}-tier`}
    >
      {tier}
    </span>
  )
}

const RANK_SPARKLINE_WIDTH = 128
const RANK_SPARKLINE_HEIGHT = 28

function TeamRankTrendCell({
  team,
  series,
  movementBaseline,
}: {
  team: RankingSummaryStanding
  series?: TeamHistorySeries
  movementBaseline: string
}) {
  const summary = summarizeRankTrend(team, series)
  const sparkline = rankSparklineShape(rankValuesForSparkline(summary, series), RANK_SPARKLINE_WIDTH, RANK_SPARKLINE_HEIGHT)

  if (!summary) {
    return (
      <span className="rank-trend-cell rank-trend-cell--empty grid min-w-0 grid-cols-1 items-center gap-2 text-[var(--rank-movement-color,var(--faint))]">
        <span className="rank-trend-cell__move flat inline-block min-w-[1.4em] overflow-hidden text-ellipsis whitespace-nowrap text-[0.82rem] font-[780] leading-[1.2] text-current tabular-nums">No history</span>
      </span>
    )
  }

  const tone = rankMovementTone(summary.recentMovement)
  const title = rankTrendTitle(team.team, summary, movementBaseline)
  return (
    <span className="rank-trend-cell grid min-w-0 grid-cols-[46px_minmax(0,1fr)] items-center gap-2 text-[var(--rank-movement-color,var(--faint))]" role="img" title={title} aria-label={title} style={rankMovementStyle(summary.recentMovement)}>
      <span
        className={`${tone} inline-flex min-w-0 items-center gap-[3px] text-current [&_svg]:shrink-0 [&_svg]:text-current`}
        aria-hidden="true"
      >
        <RankMovementIcon tone={tone} />
        <b className={`rank-trend-cell__move ${tone} inline-block min-w-[1.4em] overflow-hidden text-ellipsis whitespace-nowrap text-[0.82rem] font-[780] leading-[1.2] text-current tabular-nums`}>{formatRankMovementCompact(summary.recentMovement)}</b>
      </span>
      {sparkline ? (
        <svg
          className="rank-trend-cell__sparkline block h-6 w-full min-w-0 overflow-visible text-current [&_circle]:fill-current [&_circle]:opacity-90 [&_circle]:stroke-[var(--surface)] [&_circle]:[stroke-width:1.5] [&_polyline]:fill-none [&_polyline]:stroke-current [&_polyline]:opacity-75 [&_polyline]:[stroke-linecap:square] [&_polyline]:[stroke-linejoin:miter] [&_polyline]:[stroke-width:1.8]"
          viewBox={`0 0 ${RANK_SPARKLINE_WIDTH} ${RANK_SPARKLINE_HEIGHT}`}
          aria-hidden="true"
          focusable="false"
        >
          <polyline points={sparkline.points} />
          <circle cx={sparkline.last.x} cy={sparkline.last.y} r="2.5" />
        </svg>
      ) : null}
    </span>
  )
}

function TournamentRankTrendCell({
  movement,
  endpointLabel,
}: {
  movement?: PublicTournamentMovementTeam
  endpointLabel: string
}) {
  if (!movement) {
    return (
      <span className="rank-trend-cell rank-trend-cell--empty grid min-w-0 grid-cols-1 items-center gap-2 text-[var(--rank-movement-color,var(--faint))]">
        <span className="rank-trend-cell__move flat inline-block min-w-[1.4em] overflow-hidden text-ellipsis whitespace-nowrap text-[0.82rem] font-[780] leading-[1.2] text-current tabular-nums">Unavailable</span>
      </span>
    )
  }
  const tone = rankMovementTone(movement.rankMovement)
  const title = `${movement.team} · ${formatRankValue(movement.startRank)} to ${formatRankValue(movement.endRank)} at ${endpointLabel} · ${formatRankMovementLabel(movement.rankMovement)} · Power score ${formatRatingMovement(movement.ratingDelta)}`
  return (
    <span className="tournament-move-cell grid min-w-0 gap-[3px] tabular-nums" role="img" title={title} aria-label={title}>
      <span className="tournament-move-cell__ranks flex min-w-0 items-center gap-[5px]">
        <b className="overflow-hidden text-ellipsis whitespace-nowrap text-[0.78rem] text-[var(--text-strong)]">{formatRankValue(movement.startRank)} → {formatRankValue(movement.endRank)}</b>
        <small className="whitespace-nowrap text-[0.66rem] text-[var(--faint)]">{endpointLabel}</small>
      </span>
      <span className={cn('tournament-move-cell__delta flex min-w-0 items-center gap-[5px] text-[0.72rem] font-[750] [&_svg]:shrink-0', tone === 'up' ? 'up text-[var(--up)]' : tone === 'down' ? 'down text-[var(--down)]' : 'flat text-[var(--faint)]')}>
        <RankMovementIcon tone={tone} />
        {formatSigned(movement.rankMovement)} rank
      </span>
      <small className={cn('whitespace-nowrap text-[0.66rem] text-[var(--faint)]', movementTone(movement.ratingDelta) === 'up' ? 'up text-[var(--up)]' : movementTone(movement.ratingDelta) === 'down' ? 'down text-[var(--down)]' : 'flat')}>Score {formatRatingMovement(movement.ratingDelta)}</small>
    </span>
  )
}

function RankMovementIcon({ tone }: { tone: RankMovementTone }) {
  const iconProps = { size: 14, strokeWidth: 2.4, 'aria-hidden': true } as const
  if (tone === 'up') return <ArrowUp {...iconProps} />
  if (tone === 'down') return <ArrowDown {...iconProps} />
  return <Minus {...iconProps} />
}

function teamRankFor(team: RankingSummaryStanding) {
  return team.rank
}

function teamBoardRankLabel(team: RankingSummaryStanding, rank?: number) {
  if (team.eligibility?.eligible === false) return 'Excluded'
  return typeof rank === 'number' ? `#${formatNumber(rank)}` : '#—'
}

function isVerticallyInViewport(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight
  return rect.top >= 0 && rect.bottom <= viewportHeight
}

function teamScoreFor(team: RankingSummaryStanding) {
  return team.rating
}

function formatUncertaintyBand(value: number) {
  return `±${formatRating(value)}`
}

function teamScoreTitle(team: RankingSummaryStanding) {
  const dss = team.deservedStanding
  const base = [
    `Power score ${formatRating(team.rating)}`,
    scoreScaleNote(),
    team.scoreFamily ? `score family ${scoreFamilyLabel(team.scoreFamily)}` : undefined,
    team.recordBasis ? `record basis ${recordBasisLabel(team.recordBasis)}` : undefined,
    typeof team.uncertainty === 'number' ? `uncertainty ${formatUncertaintyBand(team.uncertainty)}` : undefined,
    team.eligibility?.eligible === false ? eligibilityReasonsTitle(team) : undefined,
  ].filter(Boolean)
  if (!dss) return base.join(' · ')
  return [
    ...base,
    `deserved check #${dss.rank} (${formatRating(dss.score)})`,
    `WAE ${formatSigned(dss.winsAboveExpectation)}`,
    `roster validity ${formatRatio(dss.rosterValidity)}`,
    dss.eligibility,
  ].join(' · ')
}

type PowerResumeGapSummary = {
  shortLabel: string
  label: string
  detail: string
  title: string
  tone: 'overpowered' | 'underpowered' | 'aligned'
  isLarge: boolean
}

function powerResumeGapSummary(team: RankingSummaryStanding): PowerResumeGapSummary | undefined {
  const dss = team.deservedStanding
  if (!dss) return undefined
  const rankGap = dss.rankDeltaFromPower
  const scoreGap = dss.scoreDeltaFromPower
  const absRankGap = Math.abs(rankGap)
  const absScoreGap = Math.abs(scoreGap)
  const isLarge = absRankGap >= LARGE_POWER_RESUME_RANK_GAP || absScoreGap >= LARGE_POWER_RESUME_SCORE_GAP
  const tone = rankGap > 0 ? 'underpowered' : rankGap < 0 ? 'overpowered' : 'aligned'
  const rankPhrase = rankGap > 0
    ? `resume is ${formatNumber(absRankGap)} ranks ahead`
    : rankGap < 0
      ? `Power is ${formatNumber(absRankGap)} ranks ahead`
      : 'Power and resume ranks align'
  const scorePhrase = scoreGap === 0 ? 'no score gap' : `${formatSigned(scoreGap)} resume score gap`
  return {
    shortLabel: tone === 'underpowered' ? `Resume #${formatNumber(dss.rank)}` : tone === 'overpowered' ? `Power +${formatNumber(absRankGap)}` : 'Aligned',
    label: tone === 'underpowered' ? 'Resume ahead' : tone === 'overpowered' ? 'Power ahead' : 'Aligned',
    detail: `${rankPhrase}; ${scorePhrase}`,
    title: `Power rank #${formatNumber(team.rank)} vs deserved rank #${formatNumber(dss.rank)}. ${rankPhrase}; ${scorePhrase}.`,
    tone,
    isLarge,
  }
}

function scoreFamilyLabel(scoreFamily: RankingSummaryStanding['scoreFamily']) {
  if (scoreFamily === 'deserved-standing') return 'Deserved Standing'
  return 'Power Index'
}

function recordBasisLabel(recordBasis: RankingSummaryStanding['recordBasis']) {
  if (recordBasis === 'grouped-match-record-from-scope-history') return 'grouped match record in this scope'
  if (recordBasis === 'standing-record-from-ranking-model') return 'ranking-model standing record'
  return 'record basis unavailable'
}

function formatRatingMovement(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unknown'
  const rounded = Math.round(value)
  if (rounded === 0) return '0'
  return rounded > 0 ? `+${formatNumber(Math.abs(rounded))}` : `-${formatNumber(Math.abs(rounded))}`
}

function movementTone(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.round(value) === 0) return 'flat'
  return value > 0 ? 'up' : 'down'
}

type RankTrendPoint = {
  date: string
  rank: number
}

type RankTrendSummary = {
  currentRank?: number
  previousRank?: number
  recentMovement?: number
  startDate?: string
  endDate?: string
  startRank?: number
  windowMovement?: number
  bestRank?: number
  worstRank?: number
  pointCount: number
}

type RankMovementTone = 'up' | 'down' | 'flat'

function summarizeRankTrend(team: RankingSummaryStanding, series?: TeamHistorySeries): RankTrendSummary | null {
  const currentRank = positiveRank(team.rank)
  const previousRank = positiveRank(team.previousRank)
  const recentMovement = finiteRounded(team.movement)
    ?? (typeof previousRank === 'number' && typeof currentRank === 'number' ? previousRank - currentRank : undefined)
  const rankPoints = rankTrendPoints(series)
  const first = rankPoints[0]
  const last = rankPoints.at(-1)
  const effectiveCurrentRank = currentRank ?? last?.rank
  const startRank = first?.rank ?? previousRank ?? effectiveCurrentRank
  const windowMovement = typeof startRank === 'number' && typeof effectiveCurrentRank === 'number'
    ? startRank - effectiveCurrentRank
    : recentMovement
  const rankValues = [
    ...rankPoints.map((point) => point.rank),
    currentRank,
    previousRank,
  ].filter((rank): rank is number => typeof rank === 'number' && Number.isFinite(rank))

  if (typeof effectiveCurrentRank !== 'number' && typeof recentMovement !== 'number' && rankValues.length === 0) {
    return null
  }

  return {
    currentRank: effectiveCurrentRank,
    previousRank,
    recentMovement,
    startDate: first?.date,
    endDate: last?.date,
    startRank,
    windowMovement,
    bestRank: rankValues.length > 0 ? Math.min(...rankValues) : undefined,
    worstRank: rankValues.length > 0 ? Math.max(...rankValues) : undefined,
    pointCount: rankPoints.length,
  }
}

function rankTrendPoints(series?: TeamHistorySeries): RankTrendPoint[] {
  if (!series) return []
  return series.points.flatMap((point) => {
    const rank = positiveRank(point[2])
    return typeof rank === 'number' ? [{ date: point[0], rank }] : []
  })
}

function rankValuesForSparkline(summary: RankTrendSummary | null, series?: TeamHistorySeries) {
  const fromHistory = rankTrendPoints(series).map((point) => point.rank).slice(-18)
  if (fromHistory.length >= 2) return fromHistory
  const fallback = [summary?.previousRank, summary?.currentRank]
    .filter((rank): rank is number => typeof rank === 'number' && Number.isFinite(rank))
  return fallback.length >= 2 ? fallback : []
}

function positiveRank(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return undefined
  return Math.round(value)
}

function finiteRounded(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.round(value)
}

function rankMovementTone(value?: number): RankMovementTone {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.round(value) === 0) return 'flat'
  return value > 0 ? 'up' : 'down'
}

function rankMovementStyle(value?: number): CSSProperties {
  return { '--rank-movement-color': rankMovementColor(value) } as CSSProperties
}

function rankMovementColor(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.round(value) === 0) return 'var(--faint)'
  const intensity = clampNumber(Math.abs(Math.round(value)) / 18, 0.28, 1)
  if (value > 0) {
    const lightness = interpolate(0.69, 0.76, intensity)
    const chroma = interpolate(0.07, 0.18, intensity)
    const hue = interpolate(165, 146, intensity)
    return `oklch(${formatColorNumber(lightness)} ${formatColorNumber(chroma)} ${formatColorNumber(hue)})`
  }
  const lightness = interpolate(0.72, 0.66, intensity)
  const chroma = interpolate(0.1, 0.21, intensity)
  const hue = interpolate(30, 18, intensity)
  return `oklch(${formatColorNumber(lightness)} ${formatColorNumber(chroma)} ${formatColorNumber(hue)})`
}

function interpolate(start: number, end: number, amount: number) {
  return start + (end - start) * amount
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function formatColorNumber(value: number) {
  return String(Math.round(value * 1000) / 1000)
}

function formatRankMovementCompact(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const places = Math.abs(Math.round(value))
  return places === 0 ? '0' : formatNumber(places)
}

function formatRankMovementLabel(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'No prior rank'
  const places = Math.abs(Math.round(value))
  if (places === 0) return 'No change'
  return `${value > 0 ? 'Up' : 'Down'} ${formatNumber(places)} ${places === 1 ? 'place' : 'places'}`
}

function formatRankValue(rank?: number) {
  return typeof rank === 'number' && Number.isFinite(rank) ? `#${formatNumber(Math.round(rank))}` : '—'
}

function formatRankTransition(previousRank?: number, currentRank?: number) {
  if (typeof previousRank === 'number' && typeof currentRank === 'number') {
    return `${formatRankValue(previousRank)} -> ${formatRankValue(currentRank)}`
  }
  if (typeof currentRank === 'number') return `Now ${formatRankValue(currentRank)}`
  return 'Rank unavailable'
}

function rankTrendTitle(teamName: string, summary: RankTrendSummary, movementBaseline: string) {
  const recent = formatRankMovementLabel(summary.recentMovement)
  const transition = formatRankTransition(summary.previousRank, summary.currentRank)
  const baseline = `Movement baseline: ${movementBaseline}`
  const window = typeof summary.windowMovement === 'number' && summary.startDate
    ? `${formatRankMovementLabel(summary.windowMovement)} since ${formatDate(summary.startDate)}`
    : undefined
  const range = typeof summary.bestRank === 'number' && typeof summary.worstRank === 'number'
    ? `Best ${formatRankValue(summary.bestRank)}, worst ${formatRankValue(summary.worstRank)}`
    : undefined
  return [teamName, recent, baseline, transition, window, range].filter(Boolean).join(' · ')
}

type RankSparklineShape = {
  points: string
  last: { x: number; y: number }
}

function rankSparklineShape(values: number[], width: number, height: number): RankSparklineShape | null {
  const ranks = values.filter((value) => Number.isFinite(value) && value >= 1).map(Math.round)
  if (ranks.length < 2) return null
  const best = Math.min(...ranks)
  const worst = Math.max(...ranks)
  const range = worst - best
  const inset = 3
  const drawableWidth = width - inset * 2
  const drawableHeight = height - inset * 2
  const coords = ranks.map((rank, index) => {
    const x = inset + (index / (ranks.length - 1)) * drawableWidth
    const y = range === 0
      ? height / 2
      : inset + ((rank - best) / range) * drawableHeight
    return { x: roundSparklineCoord(x), y: roundSparklineCoord(y) }
  })
  const stepped = coords.flatMap((point, index) => {
    if (index === 0) return [point]
    const previous = coords[index - 1]!
    return [{ x: point.x, y: previous.y }, point]
  })
  const last = coords.at(-1)!
  return {
    points: stepped.map((point) => `${point.x},${point.y}`).join(' '),
    last,
  }
}

function teamSubtitle(team: RankingSummaryStanding) {
  const reasons = team.eligibility?.eligible === false ? eligibilitySummary(team) : undefined
  return [formatCompetitionLeagueLabel(team.league ?? team.region), reasons].filter(Boolean).join(' · ')
}

function scoreScaleNote() {
  return `Scale: +50 score is about a ${formatRatio(neutralGameWinProbabilityForScoreGap(50))} neutral single-game edge before uncertainty.`
}

function neutralGameWinProbabilityForScoreGap(scoreGap: number) {
  const internalGap = scoreGap / publishedRatingScale.spreadMultiplier
  return 1 / (1 + 10 ** (-internalGap / winProbabilityEloScale))
}

function eligibilitySummary(team: RankingSummaryStanding) {
  const reasons = eligibilityReasonLabels(team)
  if (reasons.length === 0) return 'not ranked'
  return reasons.slice(0, 2).join('; ')
}

function eligibilityReasonsTitle(team: RankingSummaryStanding) {
  const reasons = eligibilityReasonLabels(team)
  if (reasons.length === 0) return 'Not ranked in the current board.'
  return `Not ranked: ${reasons.join('; ')}.`
}

function eligibilityReasonLabels(team: RankingSummaryStanding) {
  return (team.eligibility?.reasons ?? []).map((reason) => eligibilityReasonLabel(reason, team))
}

function eligibilityReasonLabel(reason: string, team: RankingSummaryStanding) {
  const eligibility = team.eligibility
  switch (reason) {
    case 'low-total-volume':
      return typeof eligibility?.totalGames === 'number' && typeof eligibility.minTotalGames === 'number'
        ? `too few scored matches (${formatNumber(eligibility.totalGames)}/${formatNumber(eligibility.minTotalGames)})`
        : 'too few scored matches'
    case 'low-current-volume':
      return typeof eligibility?.currentWindowGames === 'number' && typeof eligibility.minCurrentWindowGames === 'number'
        ? `too few recent matches (${formatNumber(eligibility.currentWindowGames)}/${formatNumber(eligibility.minCurrentWindowGames)})`
        : 'too few recent matches'
    case 'stale':
      return typeof eligibility?.daysSinceLastMatch === 'number'
        ? `stale schedule: last match ${formatNumber(eligibility.daysSinceLastMatch)}d ago`
        : 'stale schedule'
    case 'high-uncertainty':
      return 'rating uncertainty above the ranked-board cutoff'
    case 'unanchored-league':
      return 'league not yet connected to the global pool'
    default:
      return reason.replaceAll('-', ' ')
  }
}

function rankAxisForSeries(series: ChartSeries[]) {
  const ranks = series
    .flatMap((entry) => entry.points.map((point) => point.y))
    .filter((rank) => Number.isFinite(rank) && rank >= 1)
    .map((rank) => Math.round(rank))
  if (ranks.length === 0) return undefined
  const axisMax = Math.max(5, Math.max(...ranks))
  const clampedMax = Math.min(TEAM_RANK_AXIS_LIMIT, axisMax)
  const ticks = clampedMax <= 8
    ? Array.from({ length: clampedMax }, (_, index) => index + 1)
    : uniqueSorted([1, Math.round(clampedMax * 0.25), Math.round(clampedMax * 0.5), Math.round(clampedMax * 0.75), clampedMax])
  return {
    domain: { min: 1, max: clampedMax },
    ticks,
  }
}

function tournamentChartPoints(
  points: PublicTournamentMovementTeam['points'],
  metric: TrajectoryMetric,
): ChartPoint[] {
  const offsetsByDate = new Map<string, number>()
  return withVisibleDeltas(points.map((point) => {
    const offset = offsetsByDate.get(point[0]) ?? 0
    offsetsByDate.set(point[0], offset + 1)
    return {
      t: Date.parse(point[0]) + offset * 60_000,
      y: metric === 'rank' ? point[2] : point[1],
      detail: chartPointDetailFromHistoryPoint(point),
    }
  }))
}

function uniqueSorted(values: number[]) {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value >= 1).map(Math.round))].sort((a, b) => a - b)
}

function RegionalStrengthTeaser({ regions, href }: { regions: RegionStrength[]; href?: string }) {
  const ranked = useMemo(() => [...regions].sort((a, b) => displayRegionPowerScore(b) - displayRegionPowerScore(a)), [regions])
  if (ranked.length === 0) return null
  return (
    <section className="max-w-[520px] overflow-hidden rounded-[var(--r-lg)] border border-[var(--line-strong)] bg-[var(--surface)] p-3" aria-label="Region power scores">
      <div className="mb-2.5 flex items-start justify-between gap-3">
        <div>
          <p className="text-[0.66rem] text-[var(--faint)]">Regional strength</p>
          <h2 className="mt-0.5 text-[0.95rem] font-bold text-[var(--text-strong)]">All regions</h2>
        </div>
        {href ? <a className="shrink-0 text-[0.76rem] font-[680] text-[var(--accent-strong)] no-underline hover:underline hover:underline-offset-[3px]" href={href}>Details</a> : null}
      </div>
      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--line)]">
        {ranked.map((region) => (
          <div className="flex min-w-0 items-center gap-[9px] bg-[oklch(0.14_0.004_250)] px-2.5 py-[9px] [&_.region-badge]:h-5 [&_.region-badge]:w-[22px]" key={region.region}>
            <RegionBadge region={region.region} size="sm" />
            <span className="mr-auto min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.76rem] font-semibold text-[var(--text)]">{region.region}</span>
            <strong className="shrink-0 text-[0.84rem] font-[720] text-[var(--text-strong)] tabular-nums">{formatRating(displayRegionPowerScore(region))}</strong>
          </div>
        ))}
      </div>
      <p className="mt-2.5 text-[0.76rem] leading-[1.35] text-[var(--faint)]">Region power is the average of each region's top three eligible flagship teams.</p>
    </section>
  )
}

function DataSourcesDisclosure({ model, data }: { model?: Pick<ModelInfo, 'version' | 'configHash'>; data?: TeamDataSummary }) {
  const providers = [...(data?.sourceBreakdown ?? [])].sort((a, b) => b.matchCount - a.matchCount).slice(0, 3)
  const activeSources = (data?.sources ?? []).filter((source) => source.status === 'active')
  const sourceFreshness = activeSources.filter((source) => source.retrievedAt || source.coverageEnd || source.rowCount).slice(0, 4)
  const warnings = uniqueSourceWarnings(activeSources.flatMap((source) => source.warnings ?? [])).slice(0, 3)
  const notes = (data?.notes ?? []).filter(Boolean).slice(0, 2)

  return (
    <details className="group w-[min(100%,720px)] self-end overflow-hidden rounded-[var(--r-lg)] border border-[var(--line)] bg-[oklch(0.155_0.004_250)]">
      <summary className="grid cursor-pointer list-none gap-[3px] px-4 py-[13px] text-[var(--text-strong)] after:col-start-2 after:row-span-2 after:row-start-1 after:self-center after:justify-self-end after:text-base after:leading-none after:text-[var(--muted)] after:content-['+'] group-open:border-b group-open:border-[var(--line)] group-open:after:content-['-'] [&::-webkit-details-marker]:hidden">
        <span className="text-[0.92rem] font-bold">Data &amp; sources</span>
        <small className="text-[0.74rem] text-[var(--faint)]">Coverage, config, providers</small>
      </summary>
      <div className="mx-3 mt-3.5 grid grid-cols-2 gap-px bg-[var(--line)] [&>span]:grid [&>span]:min-w-0 [&>span]:gap-1 [&>span]:bg-[oklch(0.14_0.004_250)] [&>span]:px-[11px] [&>span]:py-2.5 [&_b]:overflow-hidden [&_b]:text-ellipsis [&_b]:whitespace-nowrap [&_b]:text-[0.78rem] [&_b]:text-[var(--text-strong)] [&_b]:tabular-nums [&_small]:text-[0.68rem] [&_small]:tracking-[0.04em] [&_small]:text-[var(--faint)] [&_small]:uppercase">
        <span>
          <small>Model</small>
          <b>{formatModelVersion(model?.version)}</b>
        </span>
        <span>
          <small>Matches</small>
          <b>{formatNumber(data?.matchCount)}</b>
        </span>
        <span>
          <small>Coverage</small>
          <b>{formatDateRange(data?.coverageStart, data?.coverageEnd)}</b>
        </span>
        <span>
          <small>Team rows</small>
          <b>{formatNumber(data?.tableTeamCount)} / {formatNumber(data?.scopeTeamCount)}</b>
        </span>
        <span>
          <small>Config</small>
          <b>{model?.configHash ?? 'unknown'}</b>
        </span>
        <span>
          <small>Hidden from ranked board</small>
          <b>{formatNumber(data?.hiddenFromRankedCount)}</b>
        </span>
      </div>
      {providers.length > 0 ? (
        <div className="mx-3 mt-3 grid gap-px bg-[var(--line)]">
          {providers.map((provider) => (
            <div className="flex min-w-0 items-center justify-between gap-2 bg-[oklch(0.13_0.004_250)] px-[11px] py-[9px] text-[0.76rem] text-[var(--muted)]" key={provider.provider}>
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{provider.provider}</span>
              <b className="shrink-0 text-[var(--text)] tabular-nums">{formatNumber(provider.matchCount)}</b>
            </div>
          ))}
        </div>
      ) : null}
      {sourceFreshness.length > 0 ? (
        <div className="mx-3 mt-3 grid gap-px bg-[var(--line)]" aria-label="Source freshness">
          {sourceFreshness.map((source) => (
            <div className="flex min-w-0 flex-col items-start justify-between gap-2 bg-[oklch(0.13_0.004_250)] px-[11px] py-[9px] text-[0.76rem] text-[var(--muted)]" key={source.name}>
              <span className="max-w-full min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" title={source.description}>{compactSourceName(source.name)}</span>
              <b className="shrink-0 whitespace-normal text-[var(--text)] tabular-nums">{sourceFreshnessLabel(source)}</b>
            </div>
          ))}
        </div>
      ) : null}
      {data?.seeded ? (
        <p className="mx-3 mt-3 text-[0.76rem] text-[var(--down)] last:mb-3 [overflow-wrap:anywhere]">Seeded sample data is active. Do not treat these rows as official rankings.</p>
      ) : warnings.length > 0 ? (
        <>
          {warnings.map((warning) => (
            <p className={cn('mx-3 mt-3 text-[0.76rem] text-[var(--faint)] last:mb-3 [overflow-wrap:anywhere]', (warning.severity === 'error' || warning.severity === 'warning') && 'text-[var(--down)]')} key={`${warning.kind}-${warning.severity}-${warning.message}`}>
              {warning.message}
            </p>
          ))}
        </>
      ) : notes.length > 0 ? (
        <>
          {notes.map((note) => <p className="mx-3 mt-3 text-[0.76rem] text-[var(--faint)] last:mb-3 [overflow-wrap:anywhere]" key={note}>{note}</p>)}
        </>
      ) : (
        <p className="mx-3 mt-3 text-[0.76rem] text-[var(--faint)] last:mb-3 [overflow-wrap:anywhere]">Latest match: {formatDate(data?.latestMatchDate)}</p>
      )}
    </details>
  )
}

function compactSourceName(name: string) {
  if (name.includes("Oracle's Elixir")) return name.replace("Oracle's Elixir CSV: ", 'Oracle ')
  if (name.includes('Leaguepedia Cargo')) return name.replace('Leaguepedia Cargo: ', 'Leaguepedia ')
  return name
}

function sourceFreshnessLabel(source: DataSourceInfo) {
  const parts = [
    source.retrievedAt ? `retrieved ${formatDate(source.retrievedAt)}` : undefined,
    source.coverageEnd ? `through ${formatDate(source.coverageEnd)}` : undefined,
    typeof source.rowCount === 'number' ? `${formatNumber(source.rowCount)} rows` : undefined,
  ]
  return parts.filter(Boolean).join(' · ') || 'source metadata'
}

function uniqueSourceWarnings(warnings: NonNullable<DataSourceInfo['warnings']>) {
  const seen = new Set<string>()
  return warnings.filter((warning) => {
    const key = `${warning.kind}\u0000${warning.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

type RankConfidenceSummary = {
  label: string
  detail: string
  title: string
}

function summarizeRankConfidence(team: RankingSummaryStanding, standings: RankingSummaryStanding[]): RankConfidenceSummary | null {
  const score = teamScoreFor(team)
  const uncertainty = team.ratingComponents?.uncertainty ?? team.uncertainty
  if (typeof score !== 'number' || typeof uncertainty !== 'number' || !Number.isFinite(score) || !Number.isFinite(uncertainty)) {
    return null
  }

  const teamKeyValue = teamKey(team)
  const rankedRows = standings.filter((standing) => {
    if (team.eligibility?.eligible !== false && standing.eligibility?.eligible === false) return false
    return typeof teamScoreFor(standing) === 'number' && Number.isFinite(teamScoreFor(standing))
  })
  const high = score + Math.max(0, uncertainty)
  const low = score - Math.max(0, uncertainty)
  const bestRank = 1 + rankedRows.filter((standing) => teamKey(standing) !== teamKeyValue && (teamScoreFor(standing) ?? -Infinity) > high).length
  const worstRank = Math.max(bestRank, 1 + rankedRows.filter((standing) => teamKey(standing) !== teamKeyValue && (teamScoreFor(standing) ?? -Infinity) > low).length)
  const label = bestRank === worstRank
    ? `Likely ${formatRankValue(bestRank)}`
    : `Likely ${formatRankValue(bestRank)}-${formatRankValue(worstRank)}`
  return {
    label,
    detail: `from ${formatUncertaintyBand(uncertainty)} band`,
    title: `Power score interval ${formatRating(low)}-${formatRating(high)} compared against current ranked teams.`,
  }
}

type MatchWeightSummary = {
  label: string
  detail: string
  title: string
}

function summarizeTeamMatchWeights(series?: TeamHistorySeries): MatchWeightSummary | null {
  const summaries = new Map<EventTier, { count: number; maximumWeight: number }>()
  for (const point of series?.points ?? []) {
    const tier = point[3]?.tier
    if (!isEventTier(tier)) continue
    const configuredWeight = eventTierConfig[tier].weight
    const appliedWeight = point[3]?.model?.w
    const current = summaries.get(tier) ?? { count: 0, maximumWeight: 0 }
    summaries.set(tier, {
      count: current.count + 1,
      maximumWeight: Math.max(current.maximumWeight, typeof appliedWeight === 'number' ? appliedWeight : configuredWeight),
    })
  }
  const entries = [...summaries.entries()]
  if (entries.length === 0) return null
  const [tier, summary] = entries.sort(([, left], [, right]) => right.maximumWeight - left.maximumWeight)[0]
  const config = eventTierConfig[tier]
  return {
    label: `Up to ${formatEventWeight(summary.maximumWeight)}`,
    detail: `${config.label} (${formatNumber(summary.count)} ${summary.count === 1 ? 'match' : 'matches'})`,
    title: config.description,
  }
}

const trendSummaryClassName = 'grid grid-cols-4 gap-px border-b border-[var(--line)] bg-[var(--line)] [&_b]:my-[3px] [&_b]:block [&_b]:text-[1.2rem] [&_b]:font-[760] [&_b]:text-[var(--text-strong)] [&_b]:tabular-nums [&_b.down]:text-[var(--down)] [&_b.flat]:text-[var(--faint)] [&_b.up]:text-[var(--up)] [&_em]:normal-case [&_em]:tracking-normal [&_em]:not-italic [&_small]:uppercase [&_small]:tracking-[0.08em] [&_small]:not-italic [&_small]:text-[var(--faint)] [&_small]:text-[0.7rem] [&_small]:block [&_small]:overflow-hidden [&_small]:text-ellipsis [&_small]:whitespace-nowrap [&>span]:min-w-0 [&>span]:bg-[var(--detail-surface,var(--surface))] [&>span]:px-[18px] [&>span]:py-3.5 max-[900px]:grid-cols-2 max-sm:grid-cols-1 max-sm:[&>span]:px-4 max-sm:[&>span]:py-3'
const tournamentDataNoteClassName = 'mx-5 mb-5 border-t border-[var(--line)] pt-3 text-[0.75rem] leading-[1.5] text-[var(--muted)]'

function TeamDetailDrawer({
  team,
  standings,
  series,
  historyState,
  tournament,
  tournamentMovement,
  players,
  currentLineup,
  playerLoadState,
  playerScopeLabel,
  seeded,
  onClose,
}: {
  team: RankingSummaryStanding
  standings: RankingSummaryStanding[]
  series?: TeamHistorySeries
  historyState: TeamHistoryArtifactState
  tournament?: PublicTournamentMovementShard
  tournamentMovement?: PublicTournamentMovementTeam
  players: CompactPlayer[]
  currentLineup?: PublicCurrentLineup
  playerLoadState: PlayerLoadState
  playerScopeLabel?: string
  seeded: boolean
  onClose: () => void
}) {
  const trendSeries = useMemo<ChartSeries[]>(() => {
    if (!series || series.points.length < 2) return []
    return [{
      id: teamKey(team),
      label: team.code ?? team.team,
      color: 'var(--accent)',
      points: tournament ? tournamentChartPoints(series.points, 'rating') : dailyChartPointsFromHistoryPoints(series.points),
    }]
  }, [series, team, tournament])

  const totalGames = team.wins + team.losses
  const opponentFactor = Math.round((team.factors?.opponent ?? 0) * 100)
  const trendSummary = useMemo(() => summarizeTeamTrend(series), [series])
  const rankTrend = useMemo(() => summarizeRankTrend(team, series), [team, series])
  const uncertainty = tournament ? undefined : team.ratingComponents?.uncertainty ?? team.uncertainty
  const score = teamScoreFor(team)
  const rank = teamRankFor(team)
  const rankConfidence = useMemo(() => summarizeRankConfidence(team, standings), [team, standings])
  const weightSummary = useMemo(() => summarizeTeamMatchWeights(series), [series])
  const powerResumeGap = powerResumeGapSummary(team)

  return (
    <Sheet open onOpenChange={(nextOpen) => {
      if (!nextOpen) onClose()
    }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        overlayClassName="bg-[oklch(0.04_0.003_250/0.72)] backdrop-blur-[3px]"
        aria-label={`${team.team} details`}
        className="team-detail-sheet h-dvh max-h-dvh gap-0 overflow-hidden border-l border-[var(--line-strong)] bg-[var(--detail-surface)] p-0 text-[var(--text)] shadow-[var(--shadow-pop)] [--detail-surface-2:oklch(0.192_0.011_70)] [--detail-surface-3:oklch(0.222_0.013_72)] [--detail-surface:oklch(0.168_0.01_68)] data-[side=right]:w-[min(820px,100vw)] data-[side=right]:max-w-none data-[side=right]:sm:w-[min(820px,94vw)] data-[side=right]:sm:max-w-none"
      >
        <SheetHeader className="flex-row items-center gap-3.5 border-b border-[var(--line)] bg-[var(--detail-surface)] px-5 py-4 text-left max-sm:flex-wrap max-sm:p-3.5">
          <div className="mr-auto flex min-w-0 items-center gap-3.5 [&_h2]:text-[1.15rem] [&_h2]:font-[680] [&_h2]:tracking-normal [&_h2]:text-[var(--text-strong)] [&_p]:mb-[3px] [&_p]:text-[0.72rem] [&_p]:tracking-[0.14em] [&_p]:text-[var(--faint)] [&_p]:uppercase max-[900px]:[&_h2]:text-[1.35rem]">
            <span className="inline-grid h-8 w-[54px] place-items-center rounded-[var(--r-sm)] border border-[oklch(0.79_0.155_205/0.32)] bg-[oklch(0.79_0.155_205/0.11)] font-mono text-[0.82rem] font-extrabold tracking-[0.02em] text-[var(--accent-strong)]">{team.code ?? team.team.slice(0, 3).toUpperCase()}</span>
            <div>
              <p>Team inspector</p>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                <SheetTitle>{team.team}</SheetTitle>
                {seeded ? <span className="inline-flex min-h-[22px] items-center whitespace-nowrap rounded-full border border-[color-mix(in_oklch,var(--down)_46%,var(--line))] bg-[color-mix(in_oklch,var(--down)_12%,transparent)] px-2 py-[3px] text-[0.64rem] font-[780] leading-none tracking-[0.08em] text-[color-mix(in_oklch,var(--down)_72%,var(--text-strong))] uppercase">Sample data</span> : null}
                <span className="inline-flex items-center gap-[9px] whitespace-nowrap text-[0.95rem] text-[var(--text-strong)] max-sm:order-3">
                  <LeagueSigil league={team.league} />
                  <b>{team.league}</b>
                </span>
              </div>
            </div>
          </div>
          <SheetClose asChild>
            <Button type="button" variant="ghost" aria-label="Close">
              <X size={16} aria-hidden="true" />
              Close
            </Button>
          </SheetClose>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain bg-[var(--detail-surface)] p-[18px] [&>*]:shrink-0 max-sm:gap-3 max-sm:p-3">
          <section className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3.5 rounded-[var(--r)] border border-[var(--line-strong)] bg-[var(--detail-surface-2,var(--surface))] p-4 max-[900px]:grid-cols-1 max-sm:p-3" aria-label={`${team.team} summary`}>
            <div className="flex min-w-0 items-baseline gap-3 [&_small]:mt-1 [&_small]:block [&_small]:text-[0.72rem] [&_small]:tracking-[0.08em] [&_small]:text-[var(--faint)] [&_small]:uppercase [&_strong]:block [&_strong]:text-[1.36rem] [&_strong]:font-bold [&_strong]:leading-none [&_strong]:text-[var(--text-strong)] [&_strong]:tabular-nums max-sm:justify-between max-sm:[&_strong]:text-[1.32rem]">
              <span className="text-[2.1rem] font-[620] leading-[0.95] tracking-normal text-[var(--text-strong)] tabular-nums max-sm:text-[2rem]">{teamBoardRankLabel(team, rank)}</span>
              <div>
                <strong>{formatRating(score)}</strong>
                <small>Power score{typeof uncertainty === 'number' ? ` ${formatUncertaintyBand(uncertainty)}` : ''}</small>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-px overflow-hidden rounded-[var(--r)] border border-[var(--line)] bg-[var(--line)] [&_b]:mt-1 [&_b]:block [&_b]:overflow-hidden [&_b]:text-ellipsis [&_b]:whitespace-nowrap [&_b]:text-[0.92rem] [&_b]:font-bold [&_b]:text-[var(--text-strong)] [&_b]:tabular-nums [&_b.down]:text-[var(--down)] [&_b.flat]:text-[var(--faint)] [&_b.up]:text-[var(--up)] [&_em]:mt-0.5 [&_em]:block [&_em]:overflow-hidden [&_em]:text-ellipsis [&_em]:whitespace-nowrap [&_em]:text-[0.68rem] [&_em]:not-italic [&_em]:text-[var(--faint)] [&_small]:block [&_small]:whitespace-nowrap [&_small]:text-[0.68rem] [&_small]:tracking-[0.08em] [&_small]:text-[var(--faint)] [&_small]:uppercase [&>span]:min-w-0 [&>span]:bg-[var(--detail-surface,var(--surface))] [&>span]:px-3 [&>span]:py-2.5 max-sm:grid-cols-1">
              {!tournament && series?.currentStanding ? (
                <span title="Current published state is separate from match history and may include league-anchor, roster, and form components.">
                  <small>Published state</small>
                  <b>{formatDate(series.currentStanding.asOf)} · {formatRatingMovement(series.currentStanding.adjustment)} from last match</b>
                </span>
              ) : null}
              {tournament && tournamentMovement ? (
                <>
                  <span>
                    <small>Opening</small>
                    <b>{formatRankValue(tournamentMovement.startRank)} · {formatRating(tournamentMovement.startRating)}</b>
                    <em>{formatDate(tournament.startDate)}</em>
                  </span>
                  <span>
                    <small>{tournamentBoundaryLabel(tournament.status)} endpoint</small>
                    <b>{formatRankValue(tournamentMovement.endRank)} · {formatRating(tournamentMovement.endRating)}</b>
                    <em>{formatDate(tournament.boundaryDate)}</em>
                  </span>
                  <span>
                    <small>Tournament record</small>
                    <b>{formatRecord(team.wins, team.losses)} ({formatRatio(totalGames > 0 ? team.wins / totalGames : undefined)})</b>
                    <em>scored series only</em>
                  </span>
                  <span>
                    <small>Net movement</small>
                    <b className={rankMovementTone(tournamentMovement.rankMovement)}>{formatRankMovementLabel(tournamentMovement.rankMovement)}</b>
                    <em>Score {formatRatingMovement(tournamentMovement.ratingDelta)}</em>
                  </span>
                  <span>
                    <small>Match weighting</small>
                    <b title={weightSummary?.title}>{weightSummary?.label ?? 'Tier pending'}</b>
                    <em>{weightSummary?.detail ?? 'history rows show weights'}</em>
                  </span>
                  <span>
                    <small>Endpoint eligibility</small>
                    <b>{tournamentMovement.eligible ? 'Eligible' : 'Excluded'}</b>
                    <em>{tournamentMovement.eligibilityReasons.join(', ') || 'ranking checks passed'}</em>
                  </span>
                </>
              ) : (
                <>
                  <span>
                    <small>Match record</small>
                    <b>{formatRecord(team.wins, team.losses)} ({formatRatio(totalGames > 0 ? team.wins / totalGames : undefined)})</b>
                    <em>{recordBasisLabel(team.recordBasis)}</em>
                  </span>
                  <span title={powerResumeGap?.title}>
                    <small>Power vs resume</small>
                    <b>{powerResumeGap?.label ?? 'No resume check'}</b>
                    <em>{powerResumeGap?.detail ?? 'deserved standing unavailable'}</em>
                  </span>
                  <span>
                    <small>Likely rank range</small>
                    <b title={rankConfidence?.title}>{rankConfidence?.label ?? 'Unavailable'}</b>
                    <em>{rankConfidence?.detail ?? 'uncertainty missing'}</em>
                  </span>
                  <span>
                    <small>Latest delta</small>
                    <b className={movementTone(team.delta)}>{formatRatingMovement(team.delta)}</b>
                    <TeamRatingSparkline series={series} summary={trendSummary} teamName={team.team} />
                  </span>
                  <span>
                    <small>Match weighting</small>
                    <b title={weightSummary?.title}>{weightSummary?.label ?? 'Tier pending'}</b>
                    <em>{weightSummary?.detail ?? 'history rows show weights'}</em>
                  </span>
                  <span title="Normalized opponent-strength signal from this team's scored schedule.">
                    <small>Schedule quality</small>
                    <b>{opponentFactor}%</b>
                    <em>opponent signal</em>
                  </span>
                  <span>
                    <small>Score evidence</small>
                    <b>{team.deservedStanding?.eligibility ?? (team.eligibility?.eligible === false ? 'Limited' : 'Eligible')}</b>
                    <em>
                      {team.deservedStanding
                        ? `Roster coverage ${formatRatio(team.deservedStanding.rosterValidity)}`
                        : 'match-based rating'}
                    </em>
                  </span>
                </>
              )}
            </div>
          </section>

          <div className="grid gap-4">
            <div className="overflow-hidden rounded-[var(--r)] border border-[var(--line-strong)] bg-[var(--detail-surface-2,var(--surface))] p-5 max-[900px]:p-[18px]">
              <div className="flex items-start justify-between gap-3.5 border-b border-[var(--line-strong)] pb-4 [&_h3]:text-[1.02rem] [&_h3]:font-bold [&_h3]:text-[var(--text-strong)] [&_p]:mt-1 [&_p]:max-w-[58ch] [&_p]:text-[0.78rem] [&_p]:leading-[1.4] [&_p]:text-[var(--faint)] max-sm:flex-col">
                <div>
                  <h3>Match Results</h3>
                  <p>{tournament ? `Scored matches in ${tournament.label}.` : 'Scored matches in this scope.'} Ratings show post-match power; tier pills show model weight.</p>
                </div>
                <FormDots form={team.form} />
              </div>

              <RecentMatches
                matches={team.recentMatches}
                series={series}
                standings={standings}
                historyState={historyState}
                seriesOnly={Boolean(tournament)}
              />
            </div>

            {tournament ? (
              <p className={tournamentDataNoteClassName}>Component and uncertainty breakdowns are hidden here because the tournament shard publishes exact endpoint rank, score, eligibility, and match evidence only.</p>
            ) : <ComponentBreakdown team={team} />}
            <PlayerRankingCard team={team} players={players} currentLineup={currentLineup} loadState={playerLoadState} playerScopeLabel={playerScopeLabel} />
          </div>

          <div className="flex flex-col overflow-hidden rounded-[var(--r)] border border-[var(--line-strong)] bg-[var(--detail-surface-2,var(--surface))] [&_h3]:text-[1.02rem] [&_h3]:font-bold [&_h3]:text-[var(--text-strong)] [&>.trend-chart-skeleton]:mx-5 [&>.trend-chart-skeleton]:mt-[18px] [&>.trend-chart-skeleton]:mb-5">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--line-strong)] px-6 pt-[22px] pb-[18px] [&_.eyebrow]:mb-1 [&>span]:rounded-full [&>span]:border [&>span]:border-[var(--line)] [&>span]:px-3 [&>span]:py-[7px] [&>span]:text-[0.78rem] [&>span]:font-[650] [&>span]:text-[var(--muted)] max-sm:items-start max-sm:px-[18px] max-sm:pt-[18px] max-sm:pb-3.5">
              <div>
                <p className="eyebrow">Power trajectory</p>
                <h3>{tournament ? `${tournament.label} movement` : 'Ranking Trends'}</h3>
              </div>
              <span>Power score</span>
            </div>
            {trendSummary ? (
              <div className={trendSummaryClassName} aria-label={`${team.team} trend summary`}>
                <TrendSummaryCell label="Opening" value={formatRating(trendSummary.opening)} detail={formatDate(trendSummary.startDate)} />
                <TrendSummaryCell label="Updates" value={formatNumber(trendSummary.pointCount)} detail={`Through ${formatDate(trendSummary.endDate)}`} />
                <TrendSummaryCell label="Net" value={formatRatingMovement(trendSummary.netChange)} detail="from opening" />
                <TrendSummaryCell
                  label="Peak"
                  value={formatRating(trendSummary.peak.value)}
                  detail={typeof trendSummary.bestRank === 'number' ? `Best #${trendSummary.bestRank}` : formatDate(trendSummary.peak.date)}
                />
              </div>
            ) : null}
            {rankTrend ? (
              <div className={cn(trendSummaryClassName, 'border-t')} aria-label={`${team.team} rank movement summary`}>
                <TrendSummaryCell label="Current rank" value={formatRankValue(rankTrend.currentRank)} detail={rankTrend.endDate ? formatDate(rankTrend.endDate) : 'Latest snapshot'} />
                <TrendSummaryCell
                  label="Last move"
                  value={formatRankMovementLabel(rankTrend.recentMovement)}
                  detail={formatRankTransition(rankTrend.previousRank, rankTrend.currentRank)}
                  valueClassName={rankMovementTone(rankTrend.recentMovement)}
                />
                <TrendSummaryCell
                  label="Window move"
                  value={formatRankMovementLabel(rankTrend.windowMovement)}
                  detail={rankTrend.startDate ? `Since ${formatDate(rankTrend.startDate)}` : `${formatNumber(rankTrend.pointCount)} rank points`}
                  valueClassName={rankMovementTone(rankTrend.windowMovement)}
                />
                <TrendSummaryCell label="Best rank" value={formatRankValue(rankTrend.bestRank)} detail={`Worst ${formatRankValue(rankTrend.worstRank)}`} />
              </div>
            ) : null}
            {trendSeries.length > 0 ? (
              <div className="px-5 pt-[18px] pb-5 [&_.chart]:rounded-[var(--r)] [&_.chart]:border [&_.chart]:border-[var(--line)] [&_.chart]:bg-[var(--detail-surface,var(--surface))] [&_.chart]:px-4 [&_.chart]:pt-[18px] [&_.chart]:pb-3 [&_.chart_svg]:min-h-[300px] max-[900px]:[&_.chart_svg]:min-h-[250px] max-sm:p-3.5 max-sm:[&_.chart]:px-2.5 max-sm:[&_.chart]:pt-3.5 max-sm:[&_.chart]:pb-2.5 max-sm:[&_.chart_svg]:min-h-[220px]">
                <Suspense fallback={<TrendChartSkeleton />}>
                  <LazyTeamHistoryLineChart series={trendSeries} height={340} yLabel="Power score" />
                </Suspense>
              </div>
            ) : historyState.status === 'idle' || historyState.status === 'loading' ? (
              <TrendChartSkeleton />
            ) : historyState.status === 'missing' || historyState.status === 'error' ? (
              <p className="text-[var(--muted)] pt-4">{historyState.message}</p>
            ) : (
              <p className="text-[var(--muted)] pt-4">Not enough history to chart this team yet.</p>
            )}
            {tournament ? (
              <p className={tournamentDataNoteClassName}>
                {tournamentBoundaryLabel(tournament.status)} {formatDate(tournament.boundaryDate)} · rated through {formatDate(tournament.ratedThroughDate)}
                {tournament.scheduledEndDate ? ` · scheduled end ${formatDate(tournament.scheduledEndDate)}` : ''}
                {tournament.dataLag ? ' · schedule results are ahead of rated evidence' : ''}
                {` · model ${formatModelVersion(tournament.modelVersion)}`}
              </p>
            ) : null}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

const SPARKLINE_WIDTH = 150
const SPARKLINE_HEIGHT = 42

function TeamRatingSparkline({
  series,
  summary,
  teamName,
}: {
  series?: TeamHistorySeries
  summary: TeamTrendSummary | null
  teamName: string
}) {
  const sparkline = useMemo(() => {
    if (!series || series.points.length < 2) return null
    const dailyValues = dailyChartPointsFromHistoryPoints(series.points)
      .slice(-24)
      .map((point) => point.y)
      .filter(Number.isFinite)
    return sparklineShape(dailyValues, SPARKLINE_WIDTH, SPARKLINE_HEIGHT)
  }, [series])

  if (!sparkline || !summary) {
    return null
  }

  const movement = formatRatingMovement(summary.netChange)
  return (
    <div
      className="team-sparkline"
      aria-label={`${teamName} rating trajectory net ${movement} from ${formatDate(summary.startDate)} to ${formatDate(summary.endDate)}`}
    >
      <svg viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`} aria-hidden="true" focusable="false">
        <polyline points={sparkline.points} />
        <circle cx={sparkline.last.x} cy={sparkline.last.y} r="2.8" />
      </svg>
    </div>
  )
}

type SparklineShape = {
  points: string
  last: { x: number; y: number }
}

function sparklineShape(values: number[], width: number, height: number): SparklineShape | null {
  const finiteValues = values.filter(Number.isFinite)
  if (finiteValues.length < 2) return null
  const [min, max] = extent(finiteValues)
  const range = max - min
  const inset = 4
  const drawableWidth = width - inset * 2
  const drawableHeight = height - inset * 2
  const coords = finiteValues.map((value, index) => {
    const x = inset + (index / (finiteValues.length - 1)) * drawableWidth
    const y = range === 0
      ? height / 2
      : inset + (1 - (value - min) / range) * drawableHeight
    return { x: roundSparklineCoord(x), y: roundSparklineCoord(y) }
  })
  const last = coords.at(-1)!
  return {
    points: coords.map((point) => `${point.x},${point.y}`).join(' '),
    last,
  }
}

function roundSparklineCoord(value: number) {
  return Math.round(value * 10) / 10
}

function TrendChartSkeleton() {
  return (
    <div className="trend-chart-skeleton" role="status" aria-live="polite" aria-label="Loading rating trajectory">
      <div className="trend-chart-skeleton__status">Loading rating trajectory...</div>
      <div className="trend-chart-skeleton__plot" aria-hidden="true">
        <span />
        <span />
        <span />
        <i />
      </div>
    </div>
  )
}

type RecentMatchSource = PublicRecentMatch & {
  tier?: EventTier
  expectedWinProbability?: number
  eventWeight?: number
}

type RecentMatchListItem = RecentMatchSource & {
  ratingMovement: number
  modelDelta?: number
}

type OpponentContext = {
  rank?: number
  rating?: number
  code?: string
  league?: string
}

function RecentMatches({
  matches,
  series,
  standings,
  historyState,
  seriesOnly = false,
}: {
  matches?: PublicRecentMatch[]
  series?: TeamHistorySeries
  standings: RankingSummaryStanding[]
  historyState: TeamHistoryArtifactState
  seriesOnly?: boolean
}) {
  const [pageState, setPageState] = useState({ scopeKey: '', page: 1 })
  const opponentLookup = useMemo(() => opponentContextLookup(standings), [standings])
  const historyPending = !series && (historyState.status === 'idle' || historyState.status === 'loading')
  const orderedMatches = useMemo(() => {
    if (historyPending) return matchesWithRatingMovement(matches ?? []).toReversed().slice(0, 1)
    const historyMatches = recentMatchesFromHistorySeries(series)
    const sourceMatches = seriesOnly || historyMatches.length > (matches?.length ?? 0) ? historyMatches : matches ?? []
    return matchesWithRatingMovement(sourceMatches).toReversed()
  }, [historyPending, matches, series, seriesOnly])
  const totalMatches = orderedMatches.length
  const totalPages = Math.max(1, Math.ceil(totalMatches / RECENT_MATCH_PAGE_SIZE))
  const newestMatch = orderedMatches[0]
  const oldestMatch = orderedMatches.at(-1)
  const matchScopeKey = [
    series?.team ?? '',
    series?.code ?? '',
    orderedMatches.length,
    newestMatch?.date ?? '',
    newestMatch?.opponent ?? '',
    oldestMatch?.date ?? '',
    oldestMatch?.opponent ?? '',
  ].join('\u0000')
  const requestedPage = pageState.scopeKey === matchScopeKey ? pageState.page : 1
  const currentPage = Math.min(requestedPage, totalPages)
  const pageStart = (currentPage - 1) * RECENT_MATCH_PAGE_SIZE
  const recentMatches = orderedMatches.slice(pageStart, pageStart + RECENT_MATCH_PAGE_SIZE)
  const pageEnd = totalMatches === 0 ? 0 : pageStart + recentMatches.length
  const resultSummary = `${formatNumber(totalMatches === 0 ? 0 : pageStart + 1)}-${formatNumber(pageEnd)} of ${formatNumber(totalMatches)}`

  const updatePage = (nextPage: number) => {
    setPageState({ scopeKey: matchScopeKey, page: Math.min(Math.max(1, nextPage), totalPages) })
  }

  return (
    <section className="mt-3.5 overflow-hidden rounded-[var(--r-sm)] border border-[var(--line-strong)] bg-[var(--detail-surface,var(--surface))]" aria-label="Recent form matches">
      <div className="grid grid-cols-[42px_minmax(0,1fr)_minmax(86px,auto)] items-center gap-2.5 border-b border-[var(--line)] px-3.5 py-2 text-[0.68rem] font-bold tracking-[0.08em] text-[var(--faint)] uppercase [&>span:last-child]:text-right" aria-hidden="true">
        <span>Result</span>
        <span>Opponent</span>
        <span>Rating after</span>
      </div>
      {recentMatches.length > 0 ? (
        <div>
          {recentMatches.map((match, index) => {
            const opponent = opponentLookup.get(normalizeOpponentLookupKey(match.opponent))
            const outcomeSignal = matchOutcomeSignal(match)
            const tierChip = matchTierChip(match)
            return (
              <div
                className={cn('grid min-h-16 grid-cols-[28px_minmax(0,1fr)_minmax(92px,auto)] items-start gap-2.5 border-t border-dotted border-[var(--line)] px-3.5 py-[11px] first:border-t-0 max-sm:grid-cols-[26px_minmax(0,1fr)]', outcomeSignal?.tone === 'upset' && 'shadow-[inset_3px_0_0_color-mix(in_oklch,var(--up)_72%,transparent)]', outcomeSignal?.tone === 'miss' && 'shadow-[inset_3px_0_0_color-mix(in_oklch,var(--down)_72%,transparent)]')}
                key={`${match.date}-${match.event}-${match.opponent}-${index}`}
              >
                <span className={cn('grid size-[22px] place-items-center rounded-full text-[0.68rem] font-extrabold', match.result === 'W' ? 'bg-[var(--win-soft)] text-[var(--win)]' : match.result === 'L' ? 'bg-[var(--loss-soft)] text-[var(--loss)]' : 'bg-[var(--surface-3)] text-[var(--muted)]')}>{match.result}</span>
                <div className="min-w-0">
                  <span className="flex min-w-0 items-baseline gap-2 max-sm:flex-col max-sm:items-start max-sm:gap-0.5">
                    <b className="inline-block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.84rem] font-bold text-[var(--text-strong)]">vs {match.opponent}</b>
                    {opponent ? <span className="shrink-0 whitespace-nowrap text-[0.7rem] font-[680] text-[var(--muted)] tabular-nums" title="Current opponent rank and power score in this scope">{formatOpponentContext(opponent)}</span> : null}
                  </span>
                  <small className="mt-0.5 block overflow-hidden text-ellipsis whitespace-nowrap text-[0.74rem] text-[var(--faint)]" title={formatTeamMatchDetail(match)}>{formatTeamMatchMeta(match)}</small>
                  <span className="mt-1.5 flex flex-wrap items-center gap-[5px] [&>span]:inline-flex [&>span]:min-h-[18px] [&>span]:max-w-full [&>span]:items-center [&>span]:whitespace-nowrap [&>span]:rounded-full [&>span]:border [&>span]:border-[var(--line)] [&>span]:bg-[color-mix(in_oklch,var(--detail-surface-2,var(--surface-2))_72%,transparent)] [&>span]:px-1.5 [&>span]:py-0.5 [&>span]:text-[0.64rem] [&>span]:font-bold [&>span]:leading-none [&>span]:text-[var(--muted)] [&>span.miss]:border-[color-mix(in_oklch,var(--down)_44%,var(--line))] [&>span.miss]:text-[var(--down)] [&>span.upset]:border-[color-mix(in_oklch,var(--up)_44%,var(--line))] [&>span.upset]:text-[var(--up)]" aria-label="Match context">
                    {tierChip ? <span title={tierChip.title}>{tierChip.label}</span> : null}
                    {typeof match.expectedWinProbability === 'number' ? (
                      <span title="Pregame expected series win probability for this team">
                        Expected {formatRatio(match.expectedWinProbability)}
                      </span>
                    ) : null}
                    {outcomeSignal ? <span className={outcomeSignal.tone} title={outcomeSignal.title}>{outcomeSignal.label}</span> : null}
                    {historyPending && !tierChip && typeof match.expectedWinProbability !== 'number' ? (
                      <span>Loading context</span>
                    ) : null}
                  </span>
                </div>
                <div className="pt-px text-right tabular-nums [&_small]:mt-0.5 [&_small]:block [&_small]:text-[0.74rem] [&_small]:font-bold [&_small]:text-[var(--muted)] [&_small.down]:text-[var(--down)] [&_small.flat]:text-[var(--faint)] [&_small.up]:text-[var(--up)] [&_strong]:block [&_strong]:text-[0.88rem] [&_strong]:font-[780] [&_strong]:text-[var(--text-strong)] max-sm:col-start-2 max-sm:flex max-sm:justify-self-start max-sm:gap-2 max-sm:text-left">
                  <strong>{formatRating(match.rating)}</strong>
                  <small className={movementTone(match.ratingMovement)} title={formatRatingMovementTitle(match)}>
                    {formatRatingMovement(match.ratingMovement)}
                  </small>
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
      {historyPending ? (
        <MatchHistorySkeleton rowCount={Math.max(0, RECENT_MATCH_PAGE_SIZE - recentMatches.length)} compact={recentMatches.length > 0} />
      ) : recentMatches.length === 0 ? (
        <p className="px-3.5 py-4 text-[0.76rem] text-[var(--muted)]">
          {historyState.status === 'missing' || historyState.status === 'error'
            ? historyState.message
            : 'No match-level recent form is available in this snapshot.'}
        </p>
      ) : null}
      {(historyState.status === 'missing' || historyState.status === 'error') && recentMatches.length > 0 ? (
        <p className="border-t border-[var(--line)] px-3.5 py-2.5 text-[0.72rem] leading-[1.4] text-[var(--faint)]">{historyState.message}</p>
      ) : null}
      {totalMatches > RECENT_MATCH_PAGE_SIZE ? (
        <div className={cn(pagerClassName, 'justify-between gap-2.5 border-t border-[var(--line)] bg-[color-mix(in_oklch,var(--detail-surface-2,var(--surface-2))_64%,transparent)] px-3.5 py-2.5 [--pager-control-h:28px] [&_.pager__page]:min-w-0 [&_.pager__page]:justify-start [&_.pager__page]:text-[var(--faint)]')} aria-label="Match results pagination">
          <div className="pager__page">
            {resultSummary}
          </div>
          <div className="pager__buttons max-[900px]:justify-end">
            <Button type="button" variant="outline" size="icon" className="pager__edge max-[720px]:hidden" onClick={() => updatePage(1)} disabled={currentPage === 1} aria-label="First match page">
              <ChevronsLeft size={16} aria-hidden="true" />
            </Button>
            <Button type="button" variant="outline" size="icon" onClick={() => updatePage(currentPage - 1)} disabled={currentPage === 1} aria-label="Previous match page">
              <ChevronLeft size={16} aria-hidden="true" />
            </Button>
            <Button type="button" variant="outline" size="icon" onClick={() => updatePage(currentPage + 1)} disabled={currentPage === totalPages} aria-label="Next match page">
              <ChevronRight size={16} aria-hidden="true" />
            </Button>
            <Button type="button" variant="outline" size="icon" className="pager__edge max-[720px]:hidden" onClick={() => updatePage(totalPages)} disabled={currentPage === totalPages} aria-label="Last match page">
              <ChevronsRight size={16} aria-hidden="true" />
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function MatchHistorySkeleton({
  rowCount = RECENT_MATCH_PAGE_SIZE,
  compact = false,
}: {
  rowCount?: number
  compact?: boolean
}) {
  if (rowCount <= 0 && compact) return null
  return (
    <div className="recent-match-skeleton" role="status" aria-live="polite" aria-label="Loading detailed match history">
      <p>{compact ? 'Loading remaining match context...' : 'Loading detailed match context...'}</p>
      {Array.from({ length: rowCount }, (_, index) => (
        <div className="recent-match-skeleton__row" key={index} aria-hidden="true">
          <span className="detail-skeleton detail-skeleton--result" />
          <span className="recent-match-skeleton__main">
            <span className="detail-skeleton detail-skeleton--line is-wide" />
            <span className="detail-skeleton detail-skeleton--line is-mid" />
            <span className="recent-match-skeleton__chips">
              <span className="detail-skeleton detail-skeleton--chip" />
              <span className="detail-skeleton detail-skeleton--chip is-short" />
            </span>
          </span>
          <span className="recent-match-skeleton__rating">
            <span className="detail-skeleton detail-skeleton--line is-score" />
            <span className="detail-skeleton detail-skeleton--line is-delta" />
          </span>
        </div>
      ))}
    </div>
  )
}

function matchesWithRatingMovement(matches: RecentMatchSource[]): RecentMatchListItem[] {
  let previousRating: number | undefined
  return matches.map((match) => {
    const ratingMovement = typeof previousRating === 'number' && Number.isFinite(match.rating)
      ? match.rating - previousRating
      : match.delta
    previousRating = Number.isFinite(match.rating) ? match.rating : previousRating
    const roundedMovement = Math.round(ratingMovement)
    const roundedModelDelta = Math.round(match.delta)
    return {
      ...match,
      ratingMovement,
      ...(roundedMovement !== roundedModelDelta ? { modelDelta: match.delta } : {}),
    }
  })
}

function recentMatchesFromHistorySeries(series?: TeamHistorySeries): RecentMatchSource[] {
  if (!series) return []
  return series.points
    .map(([date, rating, , context]): RecentMatchSource | null => {
      if (!context?.event || !context.opponent || !context.result) return null
      return {
        date,
        event: context.event,
        opponent: context.opponent,
        result: context.result,
        rating,
        delta: typeof context.delta === 'number' && Number.isFinite(context.delta) ? context.delta : 0,
        ...(typeof context.wins === 'number' ? { wins: context.wins } : {}),
        ...(typeof context.losses === 'number' ? { losses: context.losses } : {}),
        ...(typeof context.games === 'number' ? { games: context.games } : {}),
        ...(typeof context.bestOf === 'number' ? { bestOf: context.bestOf } : {}),
        ...(isEventTier(context.tier) ? { tier: context.tier } : {}),
        ...(typeof context.model?.e === 'number' && Number.isFinite(context.model.e) ? { expectedWinProbability: context.model.e } : {}),
        ...(typeof context.model?.w === 'number' && Number.isFinite(context.model.w) ? { eventWeight: context.model.w } : {}),
      }
    })
    .filter((match): match is RecentMatchSource => match !== null)
}

function formatTeamMatchMeta(match: PublicRecentMatch) {
  return [formatDate(match.date), match.event].filter(Boolean).join(' · ')
}

function formatTeamMatchDetail(match: PublicRecentMatch) {
  if (typeof match.wins !== 'number' || typeof match.losses !== 'number') return undefined
  const score = `${match.wins}-${match.losses}`
  const bestOf = typeof match.bestOf === 'number' && match.bestOf > 1 ? `Bo${match.bestOf}` : undefined
  return [formatTeamMatchMeta(match), score, bestOf].filter(Boolean).join(' · ')
}

function formatRatingMovementTitle(match: RecentMatchListItem) {
  const movement = `Rating movement ${formatRatingMovement(match.ratingMovement)}`
  return typeof match.modelDelta === 'number'
    ? `${movement} · model match impact ${formatRatingMovement(match.modelDelta)}`
    : movement
}

function opponentContextLookup(standings: RankingSummaryStanding[]) {
  const lookup = new Map<string, OpponentContext>()
  for (const standing of standings) {
    const context: OpponentContext = {
      rank: teamRankFor(standing),
      rating: teamScoreFor(standing),
      code: standing.code,
      league: standing.league,
    }
    lookup.set(normalizeOpponentLookupKey(standing.team), context)
    if (standing.code) lookup.set(normalizeOpponentLookupKey(standing.code), context)
  }
  return lookup
}

function normalizeOpponentLookupKey(value: string) {
  return value.trim().toLocaleLowerCase('en')
}

function formatOpponentContext(opponent: OpponentContext) {
  return [
    typeof opponent.rank === 'number' ? formatRankValue(opponent.rank) : undefined,
    typeof opponent.rating === 'number' ? formatRating(opponent.rating) : undefined,
    opponent.league,
  ].filter(Boolean).join(' · ')
}

function matchTierChip(match: RecentMatchSource) {
  if (!match.tier) return undefined
  const config = eventTierConfig[match.tier]
  const weight = typeof match.eventWeight === 'number' ? match.eventWeight : config.weight
  return {
    label: `${config.label} ${formatEventWeight(weight)}`,
    title: weight === config.weight
      ? config.description
      : `${config.description} Applied event weight ${formatEventWeight(weight)} after the preseason discount.`,
  }
}

function matchOutcomeSignal(match: RecentMatchSource) {
  const expected = match.expectedWinProbability
  if (typeof expected !== 'number' || !Number.isFinite(expected)) return null
  if (match.result === 'W' && expected < 0.4) {
    return {
      label: 'Upset',
      tone: 'upset',
      title: `Won with ${formatRatio(expected)} expected win probability.`,
    }
  }
  if (match.result === 'L' && expected > 0.6) {
    return {
      label: 'Miss',
      tone: 'miss',
      title: `Lost with ${formatRatio(expected)} expected win probability.`,
    }
  }
  return null
}

function isEventTier(value: string | undefined): value is EventTier {
  return typeof value === 'string' && value in eventTierConfig
}

function isRankingTierLabel(value: string): value is RankingTierLabel {
  return value === 'S' || value === 'A' || value === 'B' || value === 'C'
}

function formatEventWeight(weight: number) {
  return `${formatDecimal(weight)}x`
}

function LeagueSigil({
  league,
  fallbackLabel,
  small = false,
}: {
  league: string
  fallbackLabel?: string
  small?: boolean
}) {
  const code = league.trim().toUpperCase()
  const badgeRegion = code || (fallbackLabel ?? league)
  return (
    <span className={cn('inline-grid h-6 shrink-0 place-items-center [&_.region-badge]:size-full', small ? 'w-7' : 'w-[30px]')} aria-hidden="true">
      <RegionBadge region={badgeRegion} size="sm" />
    </span>
  )
}

type TeamTrendSummary = {
  opening: number
  current: number
  netChange: number
  startDate: string
  endDate: string
  pointCount: number
  peak: { value: number; date: string }
  bestRank?: number
}

function summarizeTeamTrend(series?: TeamHistorySeries): TeamTrendSummary | null {
  if (!series || series.points.length < 2) return null
  const points = series.points
  const first = points[0]
  const last = points.at(-1)!
  let peak = { value: first[1], date: first[0] }
  let bestRank: number | undefined
  for (const point of points) {
    if (point[1] > peak.value) peak = { value: point[1], date: point[0] }
    const rank = point[2]
    if (Number.isFinite(rank) && rank > 0) bestRank = typeof bestRank === 'number' ? Math.min(bestRank, rank) : rank
  }
  return {
    opening: first[1],
    current: last[1],
    netChange: last[1] - first[1],
    startDate: first[0],
    endDate: last[0],
    pointCount: points.length,
    peak,
    bestRank,
  }
}

function TrendSummaryCell({
  label,
  value,
  detail,
  valueClassName,
}: {
  label: string
  value: string
  detail: string
  valueClassName?: string
}) {
  return (
    <span>
      <small>{label}</small>
      <b className={valueClassName}>{value}</b>
      <em>{detail}</em>
    </span>
  )
}

const detailCardClassName = 'min-w-0 overflow-hidden rounded-[var(--r)] border border-[var(--line-strong)] bg-[var(--detail-surface-2,var(--surface))] p-6 max-[900px]:p-[18px] [&_h3]:text-[1.02rem] [&_h3]:font-bold [&_h3]:text-[var(--text-strong)]'
const emptyPlayerRankCardClassName = cn(detailCardClassName, 'grid gap-3 px-5 py-[18px] [&_h3]:text-[0.9rem] [&>div:first-child]:border-0 [&>div:first-child]:pb-0')
const playerRankCardHeadClassName = 'flex items-start justify-between gap-3.5 border-b border-[var(--line-strong)] pb-[18px] [&_h3]:flex [&_h3]:flex-wrap [&_h3]:items-center [&_h3]:gap-2 [&_p]:mt-1 [&_p]:text-[0.78rem] [&_p]:leading-[1.4] [&_p]:text-[var(--faint)] max-sm:flex-col'
const componentLedgerRowClassName = 'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-[7px] bg-[var(--detail-surface,var(--surface))] px-3 py-2.5 [&>b]:whitespace-nowrap [&>b]:text-[0.88rem] [&>b]:font-[760] [&>b]:text-[var(--text-strong)] [&>b]:tabular-nums [&>b.down]:text-[var(--down)] [&>b.up]:text-[var(--up)] [&>span:first-child]:text-[0.78rem] [&>span:first-child]:text-[var(--muted)]'

function PlayerRankingCard({
  team,
  players,
  currentLineup,
  loadState,
  playerScopeLabel = 'the current scope',
}: {
  team: RankingSummaryStanding
  players: CompactPlayer[]
  currentLineup?: PublicCurrentLineup
  loadState: PlayerLoadState
  playerScopeLabel?: string
}) {
  const [ratingMin, ratingMax] = useMemo(() => extent(players.map((player) => player.rating)), [players])
  const starterIds = new Set(currentLineup?.starters.map((player) => player.playerId) ?? [])
  const substituteIds = new Set(currentLineup?.substitutes.map((player) => player.playerId) ?? [])

  if (players.length === 0) {
    if (loadState.status === 'idle' || loadState.status === 'loading') {
      return (
        <aside className={emptyPlayerRankCardClassName} aria-label={`${team.team} player rankings`}>
          <div className={playerRankCardHeadClassName}>
            <div>
              <h3>
                Player Rankings
                <CountBadge>Loading</CountBadge>
              </h3>
              <p>Loading player-level sources for {team.code ?? team.team} in {playerScopeLabel}.</p>
            </div>
          </div>
          <PlayerRankingSkeleton />
        </aside>
      )
    }

    if (loadState.status === 'missing' || loadState.status === 'error') {
      return (
        <aside className={emptyPlayerRankCardClassName} aria-label={`${team.team} player rankings`}>
          <div className={playerRankCardHeadClassName}>
            <div>
              <h3>
                Player Rankings
                <CountBadge>Unavailable</CountBadge>
              </h3>
              <p>{loadState.message}</p>
            </div>
          </div>
          <p className="rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--detail-surface,var(--surface))] px-3 py-2.5 text-[0.76rem] leading-[1.45] text-[var(--muted)]">
            Team rating still uses scored matches, opponent context, and roster-continuity coverage; player rankings require sourced player rows.
          </p>
        </aside>
      )
    }

    return (
      <aside className={emptyPlayerRankCardClassName} aria-label={`${team.team} player rankings`}>
        <div className={playerRankCardHeadClassName}>
          <div>
            <h3>
              Player Rankings
              <CountBadge>Source gap</CountBadge>
            </h3>
            <p>No player-level sources for {team.code ?? team.team} in {playerScopeLabel}.</p>
          </div>
        </div>
        <p className="rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--detail-surface,var(--surface))] px-3 py-2.5 text-[0.76rem] leading-[1.45] text-[var(--muted)]">
          Team rating still uses scored matches, opponent context, and roster-continuity coverage; player rankings require sourced player rows.
        </p>
      </aside>
    )
  }

  return (
    <div className={detailCardClassName}>
      <div className={playerRankCardHeadClassName}>
        <div>
          <h3>Player Rankings</h3>
          <p>
            {currentLineup
              ? `Current sourced lineup observed ${formatDate(currentLineup.observedAt)}; older affiliations are labeled historical.`
              : `Career player rows for ${team.code ?? team.team} in ${playerScopeLabel}; no complete current-lineup projection is available.`}
          </p>
          {currentLineup?.missingRoles.length ? <small>Missing roles: {currentLineup.missingRoles.join(', ')}</small> : null}
        </div>
        <CountBadge>{players.length} players</CountBadge>
      </div>

        <Table containerClassName="player-rank-table mt-4 max-h-[360px] overflow-auto rounded-[var(--r)] border border-[var(--line)] max-sm:max-h-none max-sm:overflow-visible [&_.right]:text-right [&_.ent_b]:block [&_.ent_b]:overflow-hidden [&_.ent_b]:text-ellipsis [&_.ent_b]:whitespace-nowrap [&_.ent_small]:block [&_.ent_small]:overflow-hidden [&_.ent_small]:text-ellipsis [&_.ent_small]:whitespace-nowrap [&_table]:w-full [&_table]:table-fixed [&_table]:border-collapse [&_table]:max-sm:block [&_tbody]:max-sm:block [&_td]:border-b [&_td]:border-[var(--line)] [&_td]:px-2 [&_td]:py-2.5 [&_td]:text-left [&_td]:align-middle [&_td]:text-[0.82rem] [&_th]:sticky [&_th]:top-0 [&_th]:z-[1] [&_th]:border-b [&_th]:border-[var(--line)] [&_th]:bg-[var(--detail-surface-3,var(--surface-3))] [&_th]:px-2 [&_th]:py-2.5 [&_th]:text-left [&_th]:align-middle [&_th]:text-[0.68rem] [&_th]:font-bold [&_th]:tracking-[0.08em] [&_th]:text-[var(--faint)] [&_th]:uppercase [&_tr:last-child_td]:border-b-0">
          <TableHeader>
            <TableRow>
              <TableHead>Rank</TableHead>
              <TableHead>Player</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="text-right">Rating</TableHead>
              <TableHead className="text-right" title="Team games">Games</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {players.map((player) => (
              <TableRow key={player.id}>
                <TableCell className={cn('font-mono font-semibold text-[var(--muted)] tabular-nums', player.rank <= 3 && 'text-[var(--accent-strong)]')}>#{player.rank}</TableCell>
                <TableCell>
                  <div className="flex flex-col gap-px [&_b]:font-[620] [&_b]:text-[var(--text-strong)] [&_small]:text-[0.74rem] [&_small]:text-[var(--faint)]">
                    <b>{player.name}</b>
                    <small>
                      {starterIds.has(player.playerId ?? player.id)
                        ? 'Current starter'
                        : substituteIds.has(player.playerId ?? player.id)
                          ? 'Current substitute'
                          : 'Historical affiliation'} · impact ×{formatDecimal(player.impactMultiplier)}
                    </small>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="whitespace-nowrap text-[0.72rem]">{player.role}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  <HeatChip value={player.rating} min={ratingMin} max={ratingMax} label={formatRating(player.rating)} />
                </TableCell>
                <TableCell className="right num">{formatTeamGames(player)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
    </div>
  )
}

function PlayerRankingSkeleton() {
  return (
    <div className="player-rank-skeleton" role="status" aria-live="polite" aria-label="Loading player rankings">
      {Array.from({ length: 5 }, (_, index) => (
        <div className="player-rank-skeleton__row" key={index} aria-hidden="true">
          <span className="detail-skeleton detail-skeleton--rank" />
          <span className="player-rank-skeleton__main">
            <span className="detail-skeleton detail-skeleton--line is-wide" />
            <span className="detail-skeleton detail-skeleton--line is-short" />
          </span>
          <span className="detail-skeleton detail-skeleton--chip is-short" />
          <span className="player-rank-skeleton__score">
            <span className="detail-skeleton detail-skeleton--line is-score" />
          </span>
        </div>
      ))}
    </div>
  )
}

function ComponentBreakdown({ team }: { team: RankingSummaryStanding }) {
  const components = team.ratingComponents
  if (!components) return null
  const contributionRows = [
    { label: POWER_COMPONENT_LABELS.stable, value: components.teamStableOffset },
    { label: POWER_COMPONENT_LABELS.roster, value: components.rosterPriorOffset },
    { label: POWER_COMPONENT_LABELS.form, value: components.momentum },
    { label: POWER_COMPONENT_LABELS.context, value: components.contextAdjustment },
  ].filter((row) => Math.abs(row.value) >= 0.5)
  const maxComponentMagnitude = Math.max(
    Math.abs(components.leagueAnchor),
    ...contributionRows.map((row) => Math.abs(row.value)),
  )

  return (
    <div className={cn(detailCardClassName, 'px-5 py-[18px]')} aria-label={`${team.team} rating components`}>
      <div className="mb-3.5 flex items-start justify-between gap-3 [&_h3]:text-[1.02rem] [&_h3]:font-bold [&_h3]:text-[var(--text-strong)] [&_p]:mt-1 [&_p]:text-[0.78rem] [&_p]:leading-[1.4] [&_p]:text-[var(--faint)] [&>span]:shrink-0 [&>span]:text-[0.82rem] [&>span]:font-[760] [&>span]:text-[var(--muted)] [&>span]:tabular-nums">
        <div>
          <h3>Power Score Breakdown</h3>
          <p>How the model builds this team's Power score from the league anchor and team adjustments.</p>
        </div>
        <span>{formatRating(team.rating)} {formatUncertaintyBand(components.uncertainty)}</span>
      </div>
      <div className="grid gap-px overflow-hidden rounded-[var(--r)] border border-[var(--line)] bg-[var(--line)]">
        <div className={cn(componentLedgerRowClassName, 'bg-[var(--detail-surface-3,var(--surface-3))]')} title="League anchor baseline before team-specific adjustments.">
          <span>{POWER_COMPONENT_LABELS.league}</span>
          <b>{formatRating(components.leagueAnchor)}</b>
          <ComponentBar value={components.leagueAnchor} max={maxComponentMagnitude} />
        </div>
        {contributionRows.map((row) => (
          <div className={componentLedgerRowClassName} key={row.label}>
            <span>{row.label}</span>
            <b className={movementTone(row.value)}>{formatRatingMovement(row.value)}</b>
            <ComponentBar value={row.value} max={maxComponentMagnitude} />
          </div>
        ))}
        <div className={cn(componentLedgerRowClassName, 'border-t border-[var(--line-strong)] bg-[var(--detail-surface-3,var(--surface-3))]')}>
          <span>Power score</span>
          <b>{formatRating(team.rating)}</b>
        </div>
      </div>
    </div>
  )
}

function ComponentBar({ value, max }: { value: number; max: number }) {
  const width = max > 0 ? clampNumber((Math.abs(value) / max) * 100, 2, 100) : 0
  return (
    <span className="relative col-span-full block h-1 overflow-hidden rounded-full bg-[color-mix(in_oklch,var(--line)_68%,transparent)]" aria-hidden="true">
      <span className={cn('absolute inset-y-0 left-0 block min-w-0.5 rounded-[inherit]', value < 0 ? 'bg-[color-mix(in_oklch,var(--down)_82%,transparent)]' : 'bg-[color-mix(in_oklch,var(--up)_76%,var(--accent-strong))]')} style={{ width: `${width}%` }} />
    </span>
  )
}

function rankingSignalsProps(flair: RankingFlair, movementBaseline: string): RankingShowcaseProps {
  const spicy = flair.spicyTakeConfidence[0]
  return {
    eyebrow: 'Table readout',
    title: 'Filtered signals',
    subtitle: 'Movement, tier, upset, and evidence context from the current table rows.',
    tierCounts: tierCountsFor(flair.tiers),
    biggestRiser: movementSpotlight(flair.movement.biggestRiser, movementBaseline),
    biggestFaller: movementSpotlight(flair.movement.biggestFaller, movementBaseline),
    upset: flair.upsetHeadline ? {
      headline: flair.upsetHeadline.headline,
      winner: flair.upsetHeadline.winner,
      loser: flair.upsetHeadline.opponent,
      event: flair.upsetHeadline.event,
      score: `${formatSigned(flair.upsetHeadline.matchDelta)} rating`,
      date: flair.upsetHeadline.date,
      description: `Upset score ${formatNumber(flair.upsetHeadline.score)} from match delta, rating gap, and rank gap.`,
    } : undefined,
    confidenceBand: spicy ? {
      label: `${spicy.code}: evidence coverage`,
      value: spicy.score,
      tone: spicy.band === 'high' ? 'spicy' : spicy.band === 'medium' ? 'warm' : 'cool',
      description: `${formatNumber(spicy.recentMatchCount)} recent scored matches, rating uncertainty +/-${formatNumber(spicy.uncertainty)}.`,
    } : undefined,
  }
}

function tournamentRankingSignalsProps(
  flair: RankingFlair,
  tournament: PublicTournamentMovementShard,
): RankingShowcaseProps {
  const base = rankingSignalsProps(flair, `${tournament.label} start`)
  const biggestRiser = [...tournament.teams]
    .sort((left, right) => right.rankMovement - left.rankMovement || right.ratingDelta - left.ratingDelta || left.team.localeCompare(right.team))[0]
  const biggestFaller = [...tournament.teams]
    .sort((left, right) => left.rankMovement - right.rankMovement || left.ratingDelta - right.ratingDelta || left.team.localeCompare(right.team))[0]
  return {
    ...base,
    eyebrow: 'Tournament readout',
    title: tournament.label,
    subtitle: `Global Power Index movement from the shared tournament start to ${tournamentBoundaryLabel(tournament.status).toLowerCase()}.`,
    biggestRiser: tournamentMovementSpotlight(biggestRiser, tournament),
    biggestFaller: tournamentMovementSpotlight(biggestFaller, tournament),
    upset: undefined,
  }
}

function tournamentMovementSpotlight(
  team: PublicTournamentMovementTeam | undefined,
  tournament: PublicTournamentMovementShard,
) {
  if (!team) return undefined
  return {
    team: team.team,
    code: team.code,
    movement: team.rankMovement,
    fromRank: team.startRank,
    toRank: team.endRank,
    ratingDelta: team.ratingDelta,
    description: `${formatRatingMovement(team.ratingDelta)} Power score through ${tournamentBoundaryLabel(tournament.status).toLowerCase()}.`,
  }
}

function tierCountsFor(assignments: readonly RankingTierAssignment[]) {
  return (['S', 'A', 'B', 'C'] as const).map((tier) => {
    const teams = assignments.filter((entry) => entry.tier === tier)
    return {
      tier,
      label: `${tier}-tier`,
      count: teams.length,
      teams: teams.slice(0, 4).map((entry) => entry.code),
    }
  })
}

function movementSpotlight(pick: RankingMovementPick | null, movementBaseline: string) {
  if (!pick) return undefined
  return {
    team: pick.team,
    code: pick.code,
    movement: pick.movement,
    fromRank: pick.previousRank,
    toRank: pick.rank,
    ratingDelta: pick.ratingDelta,
    description: `${formatSigned(pick.ratingDelta)} rating vs ${movementBaseline}.`,
  }
}

function rawScoreRanks(rows: RankingSummaryStanding[]) {
  const ranks = new Map<string, number>()
  let currentRank = 0
  let previousScore: number | undefined
  const orderedRows = [...rows].sort((a, b) => compareTeamScore(b, a) || compareTeamRank(a, b) || a.team.localeCompare(b.team))
  orderedRows.forEach((team, index) => {
    const score = teamScoreFor(team)
    if (typeof score !== 'number' || !Number.isFinite(score)) return
    const roundedScore = Math.round(score)
    if (previousScore !== roundedScore) {
      currentRank = index + 1
      previousScore = roundedScore
    }
    ranks.set(teamKey(team), currentRank)
  })
  return ranks
}

function tournamentTrajectoryInsight(
  team: RankingSummaryStanding,
  series: TeamHistorySeries | undefined,
  exactTournament: boolean,
) {
  const insight = deriveTrajectoryInsight(team, series)
  return insight && exactTournament ? { ...insight, driver: undefined } : insight
}

function sortStandings(rows: RankingSummaryStanding[], key: SortKey, direction: SortDirection) {
  const copy = [...rows]
  const directionFactor = direction === 'ascending' ? 1 : -1
  switch (key) {
    case 'rating':
      return copy.sort((a, b) => compareRankedBoardEligibility(a, b) || directionFactor * compareTeamScore(a, b) || compareTeamRank(a, b))
    case 'wins':
      return copy.sort((a, b) => compareRankedBoardEligibility(a, b) || directionFactor * ((a.wins ?? 0) - (b.wins ?? 0)) || compareTeamRank(a, b))
    default:
      return copy.sort((a, b) => compareRankedBoardEligibility(a, b) || directionFactor * compareTeamRank(a, b))
  }
}

function compareRankedBoardEligibility(a: RankingSummaryStanding, b: RankingSummaryStanding) {
  return Number(b.eligibility?.eligible ?? true) - Number(a.eligibility?.eligible ?? true)
}

function compareTeamRank(a: RankingSummaryStanding, b: RankingSummaryStanding) {
  return (teamRankFor(a) ?? Number.MAX_SAFE_INTEGER) - (teamRankFor(b) ?? Number.MAX_SAFE_INTEGER)
    || (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)
}

function compareTeamScore(a: RankingSummaryStanding, b: RankingSummaryStanding) {
  return (teamScoreFor(a) ?? Number.NEGATIVE_INFINITY) - (teamScoreFor(b) ?? Number.NEGATIVE_INFINITY)
}

function playersForTeam(players: CompactPlayer[] | undefined, team: RankingSummaryStanding) {
  const teamName = team.team.toLowerCase()
  const teamRegion = team.region

  return [...(players ?? [])]
    .filter((player) => {
      if (player.region && teamRegion && player.region !== teamRegion) return false
      if (player.teamId) return player.teamId === team.teamId
      const playerTeam = player.team.toLowerCase()
      return playerTeam === teamName
    })
    .sort((a, b) => a.rank - b.rank || (ROLE_ORDER.get(a.role) ?? 99) - (ROLE_ORDER.get(b.role) ?? 99) || a.name.localeCompare(b.name))
}

function formatTeamGames(player: CompactPlayer) {
  const teamGames = player.teamGames ?? player.appearance?.latestTeamGames
  if (typeof teamGames !== 'number') return formatNumber(player.games)
  return `${formatNumber(teamGames)} / ${formatNumber(player.games)}`
}
