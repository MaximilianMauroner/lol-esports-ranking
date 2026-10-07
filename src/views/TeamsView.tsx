import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { ChevronRight, SlidersHorizontal, Users, X } from 'lucide-react'
import type { CompactPlayer, DataSourceInfo, ModelInfo, RankingSummaryStanding, TeamHistorySeries } from '../lib/snapshot'
import type {
  PublicRecentMatch,
  PublicRollingWindow,
  PublicCurrentLineup,
  PublicTournamentMovementIndexEntry,
  PublicTournamentMovementShard,
  PublicTournamentMovementTeam,
} from '../lib/publicArtifacts/schema'
import { displayRegionPowerScore, type RegionStrength } from '../lib/regionStrength'
import type { EventTier } from '../types'
import { extent, formatDate, formatDateRange, formatDecimal, formatModelVersion, formatNumber, formatRating, formatRatio, formatRecord, formatSigned, teamKey } from '../lib/display'
import { deriveTrajectoryInsight, type TrajectoryInsight } from '../lib/trajectory'
import { formatCompetitionRegionLabel } from '../data/regionTaxonomy'
import { eventTierConfig } from '../data/rankingConfig'
import { CountBadge, DataState, FormDots, HeatChip, RegionBadge, Segmented, SortHeader } from '../components/ui'
import { CompareToggle } from '../components/CompareToggle'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { PlayerPerformancePanel } from '../components/PlayerPerformancePanel'
import { Select } from '../components/ui/select'
import { LoadingState } from '../components/ui/loading'
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from '../components/ui/sheet'
import { PageShell } from '../components/ui/page-shell'
import { Pager } from '../components/ui/pager'
import { Panel, PanelBody, PanelFooter, PanelHeader } from '../components/ui/panel'
import { MovementChip, WhatChanged, type MovementSpotlight, type UpsetSpotlight } from '../components/WhatChanged'
import { PowerLadder } from '../components/PowerLadder'
import { TeamMark } from '../components/TeamMark'
import { type ChartSeries } from '../components/LineChart'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import {
  deriveRankingFlair,
  deriveTierLabels,
  type RankingFlair,
  type RankingMovementPick,
  type RankingTierLabel,
} from '../lib/rankingFlair'
import type { ChartPoint } from '../lib/chartPoints'
import { dailyChartPointsFromHistoryPoints, deriveDailyRankSeries, tournamentChartPoints } from '../lib/teamHistoryChart'
import { cn } from '../lib/utils'
import type {
  TeamHistoryArtifactState,
  TournamentMovementIndexState,
  TournamentMovementState,
} from '../hooks/usePublicArtifacts'
import { useHistoryDetail } from '../hooks/useHistoryDetail'
import { hashEnum, hashInt, hashParam, useHashSync } from '../lib/urlState'
import { estimatePublicMatchup, gameWinChanceForGap, type PublicMatchupModel } from '../lib/publicMatchup'
import { NEAR_TIE_WIN_PROBABILITY, nearTieGroups, nearTiePositions, type NearTiePosition } from '../lib/nearTies'
import { boardHeadline } from '../lib/boardHeadline'
import { assignColorSlots, sameColorSlots } from '../lib/colorSlots'
import { UPSET_CHANCE } from '../lib/upset'
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

const SORT_KEYS = ['rank', 'rating', 'wins'] as const
const SORT_DIRECTIONS = ['ascending', 'descending'] as const
const ELIGIBILITY_FILTERS = ['ranked', 'all'] as const
const TIER_FILTERS = ['All', 'S', 'A', 'B', 'C'] as const

type SortKey = typeof SORT_KEYS[number]
type SortDirection = typeof SORT_DIRECTIONS[number]
type TrajectoryMetric = 'rating' | 'rank'
type EligibilityFilter = typeof ELIGIBILITY_FILTERS[number]
type TeamDataSummary = {
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
/** The ladder stays readable in a 320px rail up to about this many rows. */
const LADDER_TEAM_LIMIT = 16
const DEFAULT_FOCUS_TEAMS = 5
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
  model?: PublicMatchupModel
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
  onRequestTeamHistory?: (teams?: readonly string[]) => void
  onTournamentFilterChange: (value: TournamentFilterValue) => void
  onPrefetchTournament?: (id: TournamentInstanceId) => void
  onRetryTournamentMovements?: () => void
}) {
  // Seeded from the hash so a shared or reloaded board comes back as it was.
  const [region, setRegion] = useState(() => hashParam('region') ?? 'All')
  const [tierFilter, setTierFilter] = useState<RankingTierLabel | 'All'>(() => hashEnum('tier', TIER_FILTERS, 'All'))
  const [eligibilityFilter, setEligibilityFilter] = useState<EligibilityFilter>(() => hashEnum('eligibility', ELIGIBILITY_FILTERS, 'ranked'))
  const [sortKey, setSortKey] = useState<SortKey>(() => hashEnum('sort', SORT_KEYS, 'rank'))
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => hashEnum('dir', SORT_DIRECTIONS, 'ascending'))
  const [pageSize, setPageSize] = useState<number>(() => {
    const size = hashInt('size', DEFAULT_TEAM_PAGE_SIZE)
    return TEAM_PAGE_SIZES.includes(size as typeof TEAM_PAGE_SIZES[number]) ? size : DEFAULT_TEAM_PAGE_SIZE
  })
  const [pageState, setPageState] = useState(() => ({ scopeKey: '', page: hashInt('page', 1) }))
  const { value: detailKey, open: openDetail, close: closeDetail } = useHistoryDetail('teamDetail')
  const [metric, setMetric] = useState<TrajectoryMetric>('rating')
  // Phones fold the filters behind one button so the first screen shows teams.
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [colorSlots, setColorSlots] = useState<ReadonlyMap<string, number>>(() => new Map())
  const trajectoryPanelRef = useRef<HTMLDivElement | null>(null)
  const history = historyState.status === 'ready' ? historyState.data.series : undefined

  const pickedKeys = useMemo(() => new Set(pickedTeams.map(teamKey)), [pickedTeams])

  // Strongest region first, the order the Regions view uses.
  const regionOptions = useMemo(() => {
    const powerByRegion = new Map(regions.map((entry) => [entry.region, displayRegionPowerScore(entry)]))
    const present = Array.from(new Set(standings.map((team) => team.region).filter(Boolean)))
    return ['All', ...present.sort((left, right) => (powerByRegion.get(right) ?? -Infinity) - (powerByRegion.get(left) ?? -Infinity) || left.localeCompare(right))]
  }, [regions, standings])
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

  // Tiers are canonical for the scope: filtering to one region must not
  // promote its best team to S-tier.
  const rankedTierUniverse = useMemo(
    () => displayStandings.filter((team) => team.eligibility?.eligible),
    [displayStandings],
  )
  const tierByTeam = useMemo(
    () => new Map(deriveTierLabels(rankedTierUniverse).map((assignment) => [assignment.team.toLocaleLowerCase('en'), assignment.tier])),
    [rankedTierUniverse],
  )
  const tierFor = useCallback((team: RankingSummaryStanding) => tierByTeam.get(team.team.toLocaleLowerCase('en')), [tierByTeam])

  const scopeFiltered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return displayStandings.filter((team) => {
      if (region !== 'All' && team.region !== region) return false
      if (!teamMatchesTournamentFilter(team, activeTournamentFilter, exactParticipantTeamIds)) return false
      if (!query) return true
      return [team.team, team.code, team.region, team.league].some((value) => value?.toLowerCase().includes(query))
    })
  }, [displayStandings, region, search, activeTournamentFilter, exactParticipantTeamIds])

  const eligibleInScope = useMemo(() => scopeFiltered.filter((team) => team.eligibility?.eligible), [scopeFiltered])
  const hiddenFromRankedCount = scopeFiltered.length - eligibleInScope.length
  const filtered = useMemo(() => {
    const byEligibility = eligibilityFilter === 'ranked' ? eligibleInScope : scopeFiltered
    return tierFilter === 'All' ? byEligibility : byEligibility.filter((team) => tierFor(team) === tierFilter)
  }, [eligibilityFilter, eligibleInScope, scopeFiltered, tierFilter, tierFor])
  const tierCounts = useMemo(
    () => (['S', 'A', 'B', 'C'] as const).map((tier) => ({ tier, count: eligibleInScope.filter((team) => tierFor(team) === tier).length })),
    [eligibleInScope, tierFor],
  )

  const movementPeriod = activeTournament
    ? `since ${activeTournament.label} start`
    : dataSummary?.rollingWindow
      ? formatDateRange(dataSummary.rollingWindow.startDate, dataSummary.rollingWindow.endDate)
      : 'since the previous update'
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

  const rankingFlair = useMemo<RankingFlair>(
    () => deriveRankingFlair(filtered, { tierUniverse: rankedTierUniverse, rollingWindow: activeTournament ? undefined : dataSummary?.rollingWindow }),
    [activeTournament, dataSummary?.rollingWindow, filtered, rankedTierUniverse],
  )
  const changes = useMemo(
    () => activeTournament
      ? tournamentChanges({ ...activeTournament, teams: activeTournament.teams.filter((entry) => filtered.some((team) => team.teamId === entry.teamId)) })
      : scopeChanges(rankingFlair),
    [activeTournament, rankingFlair, filtered],
  )

  const rawScoreRankByTeam = useMemo(() => rawScoreRanks(scopeFiltered), [scopeFiltered])
  const sorted = useMemo(() => sortStandings(filtered, sortKey, sortDirection), [filtered, sortDirection, sortKey])
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const pageScopeKey = `${region}\u0000${tierFilter}\u0000${activeTournamentFilter}\u0000${eligibilityFilter}\u0000${search}\u0000${sortKey}\u0000${sortDirection}\u0000${pageSize}`
  const requestedPage = pageState.scopeKey === pageScopeKey ? pageState.page : 1
  const currentPage = Math.min(requestedPage, totalPages)
  const pageStart = (currentPage - 1) * pageSize
  const visible = sorted.slice(pageStart, pageStart + pageSize)
  const pageEnd = sorted.length === 0 ? 0 : pageStart + visible.length
  const resultSummary = `${formatNumber(sorted.length === 0 ? 0 : pageStart + 1)}-${formatNumber(pageEnd)} of ${formatNumber(filtered.length)}`
  const activeFilterCount = [search.trim() !== '', region !== 'All', tierFilter !== 'All', activeTournamentFilter !== 'All', eligibilityFilter !== 'ranked'].filter(Boolean).length
  const hasActiveFilters = activeFilterCount > 0
  const [ratingMin, ratingMax] = useMemo(
    () => extent(filtered.map((team) => teamScoreFor(team) ?? Number.NaN)),
    [filtered],
  )

  // Near ties only mean something when neighbours on screen are neighbours in
  // the ranking, so they follow the ranked order and not a Power or record sort.
  const rankedOrder = sortKey === 'rank' && sortDirection === 'ascending'
  const ladderGroups = useMemo(
    () => nearTieGroups(filtered.filter((team) => team.eligibility?.eligible).toSorted(compareTeamRank).slice(0, LADDER_TEAM_LIMIT), model),
    [filtered, model],
  )
  const tiePositions = useMemo(
    () => rankedOrder ? nearTiePositions(nearTieGroups(visible.filter((team) => team.eligibility?.eligible), model), teamKey) : new Map<string, NearTiePosition>(),
    [model, rankedOrder, visible],
  )
  const headline = useMemo(
    () => activeTournament ? undefined : boardHeadline(rankedTierUniverse.toSorted(compareTeamRank), model),
    [activeTournament, model, rankedTierUniverse],
  )
  const gapExample = useMemo(() => gameWinChanceForGap(model), [model])

  const detailTeam = useMemo(
    () => (detailKey ? displayStandings.find((team) => teamKey(team) === detailKey) : undefined),
    [detailKey, displayStandings],
  )
  const detailPlayers = useMemo(
    () => (detailTeam ? playersForTeam(players, detailTeam) : []),
    [detailTeam, players],
  )
  const detailLineup = detailTeam ? currentLineups?.[detailTeam.teamId] : undefined

  // A team opened from a shared link needs its players and history too.
  useEffect(() => {
    if (!detailKey) return
    onRequestPlayers?.()
    onRequestTeamHistory?.()
  }, [detailKey, onRequestPlayers, onRequestTeamHistory])

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
  const focusTeams = useMemo(
    () => pickedFocusTeams.length > 0 ? pickedFocusTeams : sorted.slice(0, DEFAULT_FOCUS_TEAMS),
    [pickedFocusTeams, sorted],
  )
  // Colours follow teams, not positions. Derived during render and stored only
  // when the assignment changes, so an unchanged assignment keeps its identity.
  const requestedHistoryTeams = [...new Set([...focusTeams.map(teamKey), ...(detailTeam ? [teamKey(detailTeam)] : [])])].sort().join('\u0000')
  useEffect(() => {
    if (historyState.status !== 'idle' && !exactTournamentId) onRequestTeamHistory?.(requestedHistoryTeams.split('\u0000').filter(Boolean))
  }, [historyState.status, exactTournamentId, onRequestTeamHistory, requestedHistoryTeams])

  const assignedSlots = assignColorSlots(colorSlots, focusTeams.map(teamKey), SERIES_COLORS.length)
  const slots = sameColorSlots(assignedSlots, colorSlots) ? colorSlots : assignedSlots
  if (slots !== colorSlots) setColorSlots(slots)
  const colorFor = useCallback((team: RankingSummaryStanding) => SERIES_COLORS[slots.get(teamKey(team)) ?? 0], [slots])
  const dailyRankSeries = useMemo(
    () => metric === 'rank' && activeHistory && !exactTournamentId ? deriveDailyRankSeries(activeHistory) : new Map<string, ChartPoint[]>(),
    [activeHistory, exactTournamentId, metric],
  )
  const chartSeries = useMemo<ChartSeries[]>(() => {
    if (!activeHistory) return []
    return focusTeams
      .map((team): ChartSeries | null => {
        const series = activeHistory[teamKey(team)]
        const key = teamKey(team)
        const base = { id: key, label: team.code ?? team.team, color: colorFor(team) }
        if (exactTournamentId) {
          if (!series || series.points.length < 2) return null
          return { ...base, points: tournamentChartPoints(series.points, metric) }
        }
        if (metric === 'rank') {
          const points = dailyRankSeries.get(key) ?? []
          return points.length < 2 ? null : { ...base, points }
        }
        if (!series || series.points.length < 2) return null
        const daily = dailyChartPointsFromHistoryPoints(series.points)
        return daily.length < 2 ? null : { ...base, points: daily }
      })
      .filter((series): series is ChartSeries => series !== null)
  }, [activeHistory, colorFor, dailyRankSeries, exactTournamentId, focusTeams, metric])

  const rankAxis = useMemo(() => metric === 'rank' ? rankAxisForSeries(chartSeries) : undefined, [chartSeries, metric])

  const insights = useMemo(
    () => focusTeams
      .map((team) => ({
        team,
        color: colorFor(team),
        insight: tournamentTrajectoryInsight(team, activeHistory?.[teamKey(team)], Boolean(activeTournament)),
      }))
      .filter((entry): entry is { team: RankingSummaryStanding; color: string; insight: TrajectoryInsight } => entry.insight !== null),
    [activeHistory, activeTournament, colorFor, focusTeams],
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

  function updateTournamentFilter(value: TournamentFilterValue) {
    const id = tournamentIdFromFilter(value)
    if (id) {
      setEligibilityFilter('all')
      onPrefetchTournament?.(id)
    }
    onTournamentFilterChange(value)
    setPageState({ scopeKey: pageScopeKey, page: 1 })
  }

  function openTeam(team: RankingSummaryStanding) {
    onRequestPlayers?.()
    onRequestTeamHistory?.([teamKey(team)])
    openDetail(teamKey(team))
  }

  // Same param names and same "omit the default" rule as the other views.
  useHashSync('rankings', {
    team: search.trim(),
    region: region === 'All' ? '' : region,
    tier: tierFilter === 'All' ? '' : tierFilter,
    tournament: activeTournamentFilter === 'All' ? '' : activeTournamentFilter,
    eligibility: eligibilityFilter === 'ranked' ? '' : eligibilityFilter,
    sort: sortKey === 'rank' ? '' : sortKey,
    dir: sortDirection === (sortKey === 'rank' ? 'ascending' : 'descending') ? '' : sortDirection,
    size: pageSize === DEFAULT_TEAM_PAGE_SIZE ? '' : String(pageSize),
    page: currentPage > 1 ? String(currentPage) : '',
  })

  function resetFilters() {
    onSearchChange('')
    setRegion('All')
    setTierFilter('All')
    onTournamentFilterChange('All')
    setEligibilityFilter('ranked')
    setPageState({ scopeKey: pageScopeKey, page: 1 })
  }

  return (
    <PageShell>
      {headline ? (
        <section className="grid gap-1" aria-label="Summary">
          <p className="max-w-[72ch] text-lg leading-[1.3] font-semibold text-[var(--text-strong)]">{headline.headline}</p>
          {headline.details.length > 0 ? <p className="max-w-[90ch] text-sm text-muted-foreground">{headline.details.join(' ')}</p> : null}
        </section>
      ) : null}
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_320px] items-start gap-6 max-[1280px]:grid-cols-1">
        <div className="min-w-0">
          <Panel>
            <PanelHeader
              title={activeTournament ? `${activeTournament.label} standings` : 'Power ranking'}
              description={activeTournament ? `Ranks and scores at the event endpoint, ${formatDate(activeTournament.boundaryDate)}. Includes every participant.` : undefined}
              actions={<span className="whitespace-nowrap text-xs text-[var(--faint)] tabular-nums">{resultSummary}</span>}
            />
            {/* One row of filters above the table they scope. The controls
                carry no per-control height, radius or background overrides:
                chips, selects and the switch share --control-h and --r-2. */}
            <PanelBody className="grid gap-2.5 border-b border-border py-3">
              <div className="flex items-center gap-2 sm:hidden">
                <Button type="button" variant="secondary" size="tab" aria-expanded={filtersOpen} aria-controls="board-filters" onClick={() => setFiltersOpen((open) => !open)}>
                  <SlidersHorizontal size={15} aria-hidden="true" />
                  Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
                </Button>
                {hasActiveFilters ? (
                  <Button type="button" variant="ghost" size="tab" onClick={resetFilters}>
                    Reset
                    <X size={14} aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
              <div id="board-filters" className={cn('grid gap-2.5', !filtersOpen && 'max-sm:hidden')}>
              <div className="flex min-w-0 flex-wrap items-center gap-2" role="group" aria-label="Board filters">
                <ChipGroup
                  label="Region"
                  value={region}
                  options={regionOptions.map((option) => ({ value: option, label: option === 'All' ? 'All regions' : formatCompetitionRegionLabel(option) }))}
                  onChange={setRegion}
                />
                <ChipGroup
                  label="Tier"
                  value={tierFilter}
                  options={[{ value: 'All', label: 'All tiers' }, ...tierCounts.map(({ tier, count }) => ({ value: tier, label: `${tier} · ${count}`, disabled: count === 0 }))]}
                  onChange={setTierFilter}
                />
                {tournamentOptions.length > 1 || tournamentMovementIndexState.status === 'loading' ? (
                  <label className="inline-flex min-w-0 items-center [&_[data-slot=select]]:w-[clamp(170px,22vw,240px)] max-sm:w-full max-sm:[&_[data-slot=select]]:w-full">
                    <span className="sr-only">Tournament</span>
                    <Select value={activeTournamentFilter} onChange={(event) => updateTournamentFilter(event.target.value as TournamentFilterValue)}>
                      {tournamentOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.value === 'All' ? 'Any tournament' : `${option.label} (${formatNumber(option.count)})`}
                        </option>
                      ))}
                    </Select>
                  </label>
                ) : null}
                {tournamentMovementIndexState.status === 'loading' ? (
                  <LoadingState presentation="inline" label="Loading tournaments" className="text-xs" />
                ) : null}
                {hiddenFromRankedCount > 0 ? (
                  <label className="inline-flex h-[var(--control-h)] cursor-pointer items-center gap-2 text-sm text-muted-foreground" title="Unranked teams miss an eligibility check, such as too few recent matches or an incomplete roster.">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--accent)]"
                      checked={eligibilityFilter === 'all'}
                      onChange={(event) => setEligibilityFilter(event.target.checked ? 'all' : 'ranked')}
                    />
                    Include unranked ({formatNumber(hiddenFromRankedCount)})
                  </label>
                ) : null}
                {search.trim() ? (
                  <Button type="button" variant="secondary" size="tab" className="gap-1.5" onClick={() => onSearchChange('')} aria-label={`Clear search for ${search.trim()}`}>
                    Search: {search.trim()}
                    <X size={14} aria-hidden="true" />
                  </Button>
                ) : null}
                {hasActiveFilters ? (
                  <Button type="button" variant="ghost" size="tab" className="ml-auto max-sm:hidden" onClick={resetFilters}>
                    Reset
                    <X size={14} aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
              <label className="board-sort flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                Sort by
                <Select value={`${sortKey}:${sortDirection}`} onChange={(event) => {
                  const [key, direction] = event.target.value.split(':') as [SortKey, SortDirection]
                  setSortKey(key)
                  setSortDirection(direction)
                }}>
                  <option value="rank:ascending">Rank · best first</option>
                  <option value="rank:descending">Rank · last first</option>
                  <option value="rating:descending">Power · highest first</option>
                  <option value="rating:ascending">Power · lowest first</option>
                  <option value="wins:descending">Match wins · most first</option>
                  <option value="wins:ascending">Match wins · fewest first</option>
                </Select>
              </label>
              </div>
              {/* The legend replaces two disclosures and three helper lines. */}
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--faint)]" title={`Model ${formatModelVersion(model?.version)}${model?.configHash ? ` · config ${model.configHash}` : ''}`}>
                <span><b className="font-semibold text-muted-foreground">100 points</b> ≈ {gapExample}% game win</span>
                {rankedOrder ? <span><b className="font-semibold text-muted-foreground">Bracket</b> near tie: under {Math.round(NEAR_TIE_WIN_PROBABILITY * 100)}% per game</span> : null}
                <span className="max-sm:hidden"><b className="font-semibold text-muted-foreground">{activeTournament ? 'Event move' : '30 days'}</b> rank change {movementPeriod}</span>
                <span className="max-sm:hidden"><b className="font-semibold text-muted-foreground">Form</b> last five, oldest first</span>
              </p>
            </PanelBody>

            {tournamentMovementIndexState.status === 'missing' || tournamentMovementIndexState.status === 'error' ? (
              <DataState
                icon={<Users size={26} aria-hidden="true" />}
                title="Exact tournament history unavailable"
                action={<Button type="button" variant="outline" onClick={onRetryTournamentMovements}>Retry tournament history</Button>}
              >
                {tournamentMovementIndexState.message}
              </DataState>
            ) : null}

            {exactTournamentId && tournamentMovementState.status === 'loading' ? (
              <LoadingState className="m-4" label="Loading tournament movement" description="Loading the shared start and endpoint ranks for this exact tournament." />
            ) : exactTournamentId && tournamentMovementState.status === 'idle' ? (
              <DataState icon={<Users size={26} aria-hidden="true" />} title="Tournament movement not requested">
                Choose an exact tournament to load its shared start and endpoint ranks.
              </DataState>
            ) : exactTournamentId && (tournamentMovementState.status === 'missing' || tournamentMovementState.status === 'error') ? (
              <DataState
                icon={<Users size={26} aria-hidden="true" />}
                title="Tournament movement unavailable"
                action={<Button type="button" variant="outline" onClick={onRetryTournamentMovements}>Retry tournament movement</Button>}
              >
                {tournamentMovementState.message}
              </DataState>
            ) : visible.length === 0 ? (
              <DataState
                icon={<Users size={26} aria-hidden="true" />}
                title="No teams match these filters"
                action={hasActiveFilters ? <Button type="button" variant="outline" onClick={resetFilters}>Clear filters</Button> : undefined}
              />
            ) : (
                <Table containerClassName="max-w-full [contain:paint] [overscroll-behavior-x:contain]" className="ranking-table board-grid w-full min-w-[640px] border-collapse text-sm max-sm:min-w-full">
                  <colgroup>
                    <col className="board-col-rank" />
                    <col className="board-col-team" />
                    <col className="board-col-score" />
                    <col className="board-col-move" />
                    <col className="board-col-form" />
                    <col className="board-col-record" />
                    <col className="board-col-action" />
                  </colgroup>
                  <TableHeader>
                    <TableRow>
                      <SortHeader label="Rank" columnKey="rank" sortKey={sortKey} descending={sortDirection === 'descending'} onSort={onSort} />
                      <TableHead>Team</TableHead>
                      <SortHeader label="Power" columnKey="rating" sortKey={sortKey} descending={sortDirection === 'descending'} onSort={onSort} className="board-col-score" />
                      <TableHead className="board-col-move" title={activeTournament ? 'Rank change from the tournament start to its endpoint.' : `Rank change on match history, ${movementPeriod}.`}>{activeTournament ? 'Event' : '30 days'}</TableHead>
                      <TableHead className="board-col-form" title="Last five results, oldest first.">Form</TableHead>
                      <SortHeader label="Record" columnKey="wins" sortKey={sortKey} descending={sortDirection === 'descending'} onSort={onSort} align="right" className="board-col-record" />
                      <TableHead className="board-col-action"><span className="sr-only">Compare and open</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((team) => {
                      const key = teamKey(team)
                      const total = team.wins + team.losses
                      const rank = teamRankFor(team)
                      const tier = tierFor(team)
                      const excludedFromRankedBoard = team.eligibility?.eligible === false
                      const tie = tiePositions.get(key)
                      return (
                        <TableRow
                          key={key}
                          className={cn(
                            'board-row group/board cursor-pointer outline-offset-[-2px] hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--focus)]',
                            pickedKeys.has(key) && 'is-picked',
                            excludedFromRankedBoard && 'is-excluded bg-[color-mix(in_oklch,var(--surface-2)_58%,transparent)] text-[color-mix(in_oklch,var(--text)_76%,var(--muted))] hover:bg-[color-mix(in_oklch,var(--surface-3)_70%,transparent)]',
                          )}
                          title={excludedFromRankedBoard ? eligibilityReasonsTitle(team) : undefined}
                          onClick={(event) => {
                            if (shouldIgnoreTeamRowClick(event)) return
                            openTeam(team)
                          }}
                        >
                          <TableCell className="board-col-rank relative" aria-label={excludedFromRankedBoard ? 'Unranked' : `Rank ${rank}`}>
                            {tie ? <NearTieMark position={tie} /> : null}
                            <span className="board-rankcell flex items-center gap-2 whitespace-nowrap">
                              <TeamBoardRank team={team} rank={rank} rawScoreRank={rawScoreRankByTeam.get(key)} />
                              {tier ? <TierBadge tier={tier} /> : null}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Button
                              type="button"
                              variant="ghost"
                              className="team-cell team-cell__button h-auto min-h-9 w-full cursor-pointer justify-start gap-3 whitespace-normal rounded-sm border-0 bg-transparent p-0 text-left font-[inherit] text-[inherit] hover:bg-transparent hover:text-[inherit] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--focus)]"
                              onClick={() => openTeam(team)}
                              onFocus={onRequestPlayers}
                              title={`Open ${team.team}`}
                            >
                              <TeamMark team={team.team} code={team.code} className="team-mark sm h-8 w-10" />
                              <div className="ent flex min-w-0 flex-col gap-px overflow-hidden [&_b]:block [&_b]:overflow-hidden [&_b]:text-ellipsis [&_b]:whitespace-nowrap [&_b]:font-semibold [&_b]:text-[var(--text-strong)] [&_small]:block [&_small]:overflow-hidden [&_small]:text-ellipsis [&_small]:whitespace-nowrap [&_small]:text-xs [&_small]:text-[var(--faint)]">
                                <b>{team.team}</b>
                                <small>{excludedFromRankedBoard ? `${team.league} · ${eligibilitySummary(team)}` : team.league}</small>
                              </div>
                            </Button>
                          </TableCell>
                          <TableCell className="board-col-score" aria-label={`Power ${formatRating(teamScoreFor(team))}`}>
                            <TeamScoreCell team={team} min={ratingMin} max={ratingMax} exactTournament={Boolean(activeTournament)} />
                          </TableCell>
                          <TableCell className="board-col-move">
                            {activeTournament ? (
                              <TournamentMoveChip movement={movementByTeamId.get(team.teamId)} endpointLabel={tournamentBoundaryLabel(activeTournament.status)} />
                            ) : (
                              <MovementChip places={activeMovement(team)?.rankMovement ?? undefined} title={rollingMovementTitle(team, movementPeriod)} />
                            )}
                          </TableCell>
                          <TableCell className="board-col-form">
                            <FormDots form={team.form} />
                          </TableCell>
                          <TableCell className="right num board-col-record" aria-label={`Match wins ${formatNumber(team.wins)}, losses ${formatNumber(team.losses)}; win rate ${formatRatio(total > 0 ? team.wins / total : undefined)}`}>
                            <b className="font-semibold text-[var(--text-strong)]">{formatRecord(team.wins, team.losses)}</b>{' '}
                            <span className="text-sm text-[var(--faint)]">{formatRatio(total > 0 ? team.wins / total : undefined)}</span>
                          </TableCell>
                          <TableCell className="board-col-action">
                            <span className="flex items-center justify-end gap-2">
                              <CompareToggle picked={pickedKeys.has(key)} onToggle={() => onToggle(team)} label={team.team} />
                              <ChevronRight className="size-4 shrink-0 text-[var(--faint)] group-hover/board:text-foreground max-sm:hidden" aria-hidden="true" />
                            </span>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
            )}

            {sorted.length > 0 ? (
              <PanelFooter>
                <Pager
                  label="Team table pagination"
                  page={currentPage}
                  pageCount={totalPages}
                  onPage={updatePage}
                  pageSize={pageSize}
                  pageSizes={TEAM_PAGE_SIZES}
                  onPageSize={setPageSize}
                  rangeLabel={resultSummary}
                  className="w-full"
                />
              </PanelFooter>
            ) : null}
          </Panel>
        </div>

        {/* Beside the board on wide screens, below it on narrow ones, so a
            phone reaches the teams first. */}
        <aside className="board-sidebar grid min-w-0 content-start gap-4 max-[1280px]:grid-cols-2 max-[900px]:grid-cols-1" aria-label="Ranking overview">
          {ladderGroups.flat().length >= 2 ? (
            <Panel aria-label="Power ladder">
              <PanelHeader title="Power ladder" actions={<span className="text-xs text-[var(--faint)]">{ladderGroups.flat().length < filtered.length ? `top ${ladderGroups.flat().length}` : 'all ranked'}</span>} />
              <PanelBody className="px-2 py-2">
                <PowerLadder groups={ladderGroups} tierFor={tierFor} gapExample={gapExample} onOpen={openTeam} />
              </PanelBody>
            </Panel>
          ) : null}
          <WhatChanged period={activeTournament ? activeTournament.label : '30 days'} riser={changes.riser} faller={changes.faller} upset={changes.upset} />
          <RegionalStrengthTeaser regions={regions} href={regionsHref} />
        </aside>
      </div>

      <Panel
        ref={trajectoryPanelRef}
        onFocusCapture={() => onRequestTeamHistory?.(focusTeams.map(teamKey))}
        onPointerEnter={() => onRequestTeamHistory?.(focusTeams.map(teamKey))}
      >
        <PanelHeader
          title={activeTournament ? `${activeTournament.label} movement` : metric === 'rank' ? 'Rank over time' : 'Power over time'}
          description={
            activeTournament
              ? `${tournamentBoundaryLabel(activeTournament.status)} boundary ${formatDate(activeTournament.boundaryDate)}, rated through ${formatDate(activeTournament.ratedThroughDate)}.`
              : `${pickedFocusTeams.length > 0 ? 'Your compared teams' : `Top ${DEFAULT_FOCUS_TEAMS} on the board. Tick Compare to choose teams`}. Daily close from match history; gaps mark weeks without matches.`
          }
          actions={
            <Segmented
              value={metric}
              options={[
                { value: 'rating', label: 'Power' },
                { value: 'rank', label: 'Rank' },
              ]}
              onChange={setMetric}
              ariaLabel="Chart metric"
            />
          }
        />
        {exactTournamentId && tournamentMovementState.status === 'loading' ? (
          <LoadingState presentation="chart" className="m-5" label="Loading tournament movement" />
        ) : exactTournamentId && tournamentMovementState.status === 'idle' ? (
          <p className="text-muted-foreground p-5">Tournament movement has not been requested.</p>
        ) : exactTournamentId && (tournamentMovementState.status === 'missing' || tournamentMovementState.status === 'error') ? (
          <p className="text-muted-foreground p-5">{tournamentMovementState.message}</p>
        ) : !exactTournamentId && historyState.status === 'idle' ? (
          <p className="text-muted-foreground p-5">Rating history loads when this panel is viewed.</p>
        ) : !exactTournamentId && historyState.status === 'loading' ? (
          <LoadingState presentation="chart" className="m-5" label="Loading rating history" />
        ) : !exactTournamentId && (historyState.status === 'missing' || historyState.status === 'error') ? (
          <p className="text-muted-foreground p-5">{historyState.message}</p>
        ) : (
          <Suspense fallback={<LoadingState presentation="chart" className="m-5" label="Loading trajectory chart" />}>
            <LazyTeamHistoryLineChart
              series={chartSeries}
              height={300}
              yLabel={metric === 'rank' ? 'Rank' : 'Power'}
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
          <PanelBody className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-2.5 pt-1 pb-4">
            {insights.map(({ team, color, insight }) => (
              <article className="grid gap-2 rounded-md border border-border bg-[var(--surface-2)] px-3.5 py-3" key={teamKey(team)}>
                <div className="flex items-center gap-2">
                  <span className="size-2.5 shrink-0 rounded-sm" style={{ background: color }} aria-hidden="true" />
                  <b className="mr-auto text-md font-semibold text-[var(--text-strong)]">{team.code ?? team.team}</b>
                  <span className={cn('font-mono text-xs tabular-nums', insight.netChange > 0 ? 'text-[var(--up)]' : insight.netChange < 0 ? 'text-[var(--down)]' : 'text-[var(--faint)]')}>
                    {formatSigned(insight.netChange)}
                  </span>
                </div>
                <p className="text-sm leading-[1.5] text-muted-foreground">{insight.summary}</p>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--faint)] [&_b]:font-semibold [&_b]:text-foreground [&_b]:tabular-nums">
                  <span>
                    Peak <b>{formatRating(insight.peak.value)}</b>
                    {typeof insight.bestRank === 'number' ? ` · best #${insight.bestRank}` : ''}
                  </span>
                  {insight.driver ? <span>Driven by <b>{insight.driver.label}</b></span> : null}
                </div>
              </article>
            ))}
          </PanelBody>
        ) : null}
      </Panel>

      <DataSourcesDisclosure model={model} data={panelData} />

      {detailTeam ? (
        <TeamDetailDrawer
          team={detailTeam}
          standings={displayStandings}
          model={model}
          tier={tierFor(detailTeam)}
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
    </PageShell>
  )
}

/** Chips for a small, fixed set of mutually exclusive filter values. */
function ChipGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string; disabled?: boolean }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1" role="group" aria-label={label}>
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          variant="tab"
          size="sm"
          aria-pressed={value === option.value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className="h-8 px-3 disabled:opacity-50"
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}

/** Neutral bracket in the rank cell joining rows the model calls a near tie.
 *  Gold is reserved for rank quality, and a near tie is model uncertainty. */
function NearTieMark({ position }: { position: NearTiePosition }) {
  return (
    <span
      className={cn(
        'absolute left-1 w-0.5 bg-muted-foreground',
        position === 'start' && 'top-1/2 bottom-0 rounded-t-full',
        position === 'middle' && 'inset-y-0',
        position === 'end' && 'top-0 bottom-1/2 rounded-b-full',
      )}
      title={`Near tie with the team next to it: under ${Math.round(NEAR_TIE_WIN_PROBABILITY * 100)}% per game`}
      aria-hidden="true"
    />
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

/**
 * The score and its position on the visible Power range. One number per row:
 * the uncertainty is the same for every team, so the legend and the near-tie
 * brackets carry it instead of a "±65" on each line.
 */
function TeamScoreCell({
  team,
  min,
  max,
  exactTournament = false,
}: {
  team: RankingSummaryStanding
  min: number
  max: number
  exactTournament?: boolean
}) {
  const score = teamScoreFor(team)
  if (typeof score !== 'number') {
    return <span className="score-unavailable font-mono text-sm font-semibold text-[var(--faint)]" aria-hidden="true">—</span>
  }
  const share = max > min ? clampNumber(((score - min) / (max - min)) * 100, 4, 100) : 100
  return (
    <span className="team-score-stack flex min-w-0 items-center gap-2.5" title={exactTournament ? `Tournament endpoint Power ${formatRating(score)}` : teamScoreTitle(team)}>
      <span className="team-score-value min-w-[3.4em] text-right font-mono text-base font-extrabold text-[var(--text-strong)] tabular-nums">{formatRating(score)}</span>
      <span className="score-track relative h-1.5 min-w-10 flex-1 overflow-hidden rounded-full bg-[var(--surface-3)]" aria-hidden="true">
        <span className="absolute inset-y-0 left-0 rounded-full bg-[var(--faint)]" style={{ width: `${share}%` }} />
      </span>
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
      <span className="board-rank-stack inline-flex min-w-0 flex-col items-start gap-1">
        <span className="board-rank board-rank--excluded min-w-0 text-xs font-bold text-muted-foreground tabular-nums">Unranked</span>
        {typeof rawScoreRank === 'number' ? (
          <span className="text-2xs text-[var(--faint)]" title="Where the score would place if eligibility checks were ignored.">score #{formatNumber(rawScoreRank)}</span>
        ) : null}
      </span>
    )
  }

  return (
    <span className={cn('board-rank min-w-[1.4em] text-base font-bold text-[var(--text-strong)] tabular-nums', typeof rank === 'number' && rank <= 3 && 'podium text-[var(--rank-gold)]')}>
      {rank ?? '—'}
    </span>
  )
}

const TIER_BADGE_COLOR: Record<RankingTierLabel, string> = {
  S: '[--tier-color:var(--tier-s)]',
  A: '[--tier-color:var(--tier-a)]',
  B: '[--tier-color:var(--tier-b)]',
  C: '[--tier-color:var(--tier-c)]',
}

function TierBadge({ tier }: { tier: RankingTierLabel }) {
  return (
    <span
      className={cn(
        'tier-badge inline-flex h-6 min-w-[26px] items-center justify-center rounded-sm border border-[color-mix(in_oklch,var(--tier-color)_40%,var(--line))] bg-[color-mix(in_oklch,var(--tier-color)_11%,transparent)] px-2 font-mono text-sm font-bold leading-none text-[var(--tier-color)]',
        TIER_BADGE_COLOR[tier],
      )}
      role="img"
      title={`${tier}-tier`}
      aria-label={`${tier}-tier`}
    >
      {tier}
    </span>
  )
}

function activeMovement(team: RankingSummaryStanding) {
  return team.rollingMovement?.status === 'active' ? team.rollingMovement : undefined
}

/**
 * The 30-day chip shows places moved. The exact ranks go in the tooltip with
 * their basis: the history baseline and the published board endpoint.
 */
function rollingMovementTitle(team: RankingSummaryStanding, period: string) {
  const movement = activeMovement(team)
  if (!movement) return `${team.team}: no scored series ${period}.`
  return `${team.team}, ${period}: baseline rank #${movement.baselineRank} to published rank #${movement.currentRank}, ${formatRatingMovement(movement.ratingDelta ?? 0)} Power over ${formatNumber(movement.scoredSeries)} series.`
}

function TournamentMoveChip({
  movement,
  endpointLabel,
}: {
  movement?: PublicTournamentMovementTeam
  endpointLabel: string
}) {
  if (!movement) return <MovementChip title="Tournament movement unavailable" />
  return (
    <MovementChip
      places={movement.rankMovement}
      title={`${movement.team}: ${formatRankValue(movement.startRank)} to ${formatRankValue(movement.endRank)} at ${endpointLabel.toLowerCase()}, ${formatRatingMovement(movement.ratingDelta)} Power.`}
    />
  )
}

function teamRankFor(team: RankingSummaryStanding) {
  return team.rank
}

function teamBoardRankLabel(team: RankingSummaryStanding, rank?: number) {
  if (team.eligibility?.eligible === false) return 'Excluded'
  return typeof rank === 'number' ? `#${formatNumber(rank)}` : '#—'
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
    'Published Power score; trend movement uses match history.',
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

type RankMovementTone = 'up' | 'down' | 'flat'

function rankMovementTone(value?: number): RankMovementTone {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.round(value) === 0) return 'flat'
  return value > 0 ? 'up' : 'down'
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
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

function uniqueSorted(values: number[]) {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value >= 1).map(Math.round))].sort((a, b) => a - b)
}

function RegionalStrengthTeaser({ regions, href }: { regions: RegionStrength[]; href?: string }) {
  const ranked = useMemo(() => [...regions].sort((a, b) => displayRegionPowerScore(b) - displayRegionPowerScore(a)), [regions])
  if (ranked.length === 0) return null
  return (
    <Panel aria-label="Region power scores">
      <PanelHeader
        title="Region power"
        actions={href ? <a className="shrink-0 text-xs font-semibold text-[var(--accent-strong)] no-underline hover:underline hover:underline-offset-[3px]" href={href}>Details</a> : undefined}
      />
      <div className="grid grid-cols-1 gap-px bg-border">
        {ranked.map((region) => (
          <div className="flex min-w-0 items-center gap-2.5 bg-card px-4 py-2 [&_.region-badge]:h-5 [&_.region-badge]:w-[22px]" key={region.region}>
            <RegionBadge region={region.region} size="sm" />
            <span className="mr-auto min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs font-semibold text-foreground">{region.region}</span>
            <strong className="shrink-0 text-sm font-bold text-[var(--text-strong)] tabular-nums">{formatRating(displayRegionPowerScore(region))}</strong>
          </div>
        ))}
      </div>
      <PanelFooter className="text-xs leading-[1.35] text-[var(--faint)]">
        Average of each region’s top three eligible flagship teams.
      </PanelFooter>
    </Panel>
  )
}

function DataSourcesDisclosure({ model, data }: { model?: Pick<ModelInfo, 'version' | 'configHash'>; data?: TeamDataSummary }) {
  const providers = [...(data?.sourceBreakdown ?? [])].sort((a, b) => b.matchCount - a.matchCount).slice(0, 3)
  const activeSources = (data?.sources ?? []).filter((source) => source.status === 'active')
  const sourceFreshness = activeSources.filter((source) => source.retrievedAt || source.coverageEnd || source.rowCount).slice(0, 4)
  const warnings = uniqueSourceWarnings(activeSources.flatMap((source) => source.warnings ?? [])).slice(0, 3)
  const notes = (data?.notes ?? []).filter(Boolean).slice(0, 2)

  return (
    <details className="group w-full overflow-hidden rounded-lg border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-[var(--text-strong)] after:ml-auto after:text-base after:leading-none after:text-muted-foreground after:content-['+'] group-open:border-b group-open:border-border group-open:after:content-['-'] [&::-webkit-details-marker]:hidden">
        <span className="text-base font-semibold">Data and sources</span>
        <small className="text-xs text-[var(--faint)]">Coverage, config, providers</small>
      </summary>
      <div className="mx-3 mt-3.5 grid grid-cols-2 gap-px bg-border [&>span]:grid [&>span]:min-w-0 [&>span]:gap-1 [&>span]:bg-[var(--rail)] [&>span]:px-3 [&>span]:py-2.5 [&_b]:overflow-hidden [&_b]:text-ellipsis [&_b]:whitespace-nowrap [&_b]:text-sm [&_b]:text-[var(--text-strong)] [&_b]:tabular-nums [&_small]:text-2xs [&_small]:tracking-label [&_small]:text-[var(--faint)] [&_small]:uppercase">
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
        <span>
          <small>Complete lineup sides</small>
          <b>{formatNumber(data?.rosterCoverage?.completeRosterSides)} / {formatNumber(data?.rosterCoverage?.rosterSides)}</b>
        </span>
        <span>
          <small>Missing or partial lineup sides</small>
          <b>{formatNumber((data?.rosterCoverage?.missingRosterSides ?? 0) + (data?.rosterCoverage?.partialRosterSides ?? 0))}</b>
        </span>
      </div>
      {providers.length > 0 ? (
        <div className="mx-3 mt-3 grid gap-px bg-border">
          {providers.map((provider) => (
            <div className="flex min-w-0 items-center justify-between gap-2 bg-background px-3 py-2 text-xs text-muted-foreground" key={provider.provider}>
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{provider.provider}</span>
              <b className="shrink-0 text-foreground tabular-nums">{formatNumber(provider.matchCount)}</b>
            </div>
          ))}
        </div>
      ) : null}
      {sourceFreshness.length > 0 ? (
        <div className="mx-3 mt-3 grid gap-px bg-border" aria-label="Source freshness">
          {sourceFreshness.map((source) => (
            <div className="flex min-w-0 flex-col items-start justify-between gap-2 bg-background px-3 py-2 text-xs text-muted-foreground" key={source.name}>
              <span className="max-w-full min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" title={source.description}>{compactSourceName(source.name)}</span>
              <b className="shrink-0 whitespace-normal text-foreground tabular-nums">{sourceFreshnessLabel(source)}</b>
            </div>
          ))}
        </div>
      ) : null}
      {data?.seeded ? (
        <p className="mx-3 mt-3 text-xs text-[var(--down)] last:mb-3 [overflow-wrap:anywhere]">Seeded sample data is active. Do not treat these rows as official rankings.</p>
      ) : warnings.length > 0 ? (
        <>
          {warnings.map((warning) => (
            <p className={cn('mx-3 mt-3 text-xs text-[var(--faint)] last:mb-3 [overflow-wrap:anywhere]', (warning.severity === 'error' || warning.severity === 'warning') && 'text-[var(--down)]')} key={`${warning.kind}-${warning.severity}-${warning.message}`}>
              {warning.message}
            </p>
          ))}
        </>
      ) : notes.length > 0 ? (
        <>
          {notes.map((note) => <p className="mx-3 mt-3 text-xs text-[var(--faint)] last:mb-3 [overflow-wrap:anywhere]" key={note}>{note}</p>)}
        </>
      ) : (
        <p className="mx-3 mt-3 text-xs text-[var(--faint)] last:mb-3 [overflow-wrap:anywhere]">Latest match: {formatDate(data?.latestMatchDate)}</p>
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

type RankEvidenceSummary = {
  label: string
  detail: string
  title: string
}

function summarizeRankEvidence(team: RankingSummaryStanding, standings: RankingSummaryStanding[]): RankEvidenceSummary | null {
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
    ? formatRankValue(bestRank)
    : `${formatRankValue(bestRank)}-${formatRankValue(worstRank)}`
  return {
    label,
    detail: `from the ${formatUncertaintyBand(uncertainty)} model evidence band`,
    title: `Model evidence band ${formatRating(low)}-${formatRating(high)} compared against current ranked teams.`,
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
  const events = [...new Set((series?.points ?? []).filter((point) => point[3]?.tier === tier).map((point) => point[3]?.event).filter(Boolean))]
  return {
    label: `Up to ${formatEventWeight(summary.maximumWeight)}`,
    detail: `${events.join(', ')} · ${formatNumber(summary.count)} series`,
    title: `${config.label} weighting tier (shared across events). ${config.description}`,
  }
}

const tournamentDataNoteClassName = 'mx-5 mb-5 border-t border-border pt-3 text-xs leading-[1.5] text-muted-foreground'

function TeamDetailDrawer({
  team,
  standings,
  model,
  tier,
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
  model?: PublicMatchupModel
  tier?: RankingTierLabel
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
      color: 'var(--series-1)',
      points: tournament ? tournamentChartPoints(series.points, 'rating') : dailyChartPointsFromHistoryPoints(series.points),
    }]
  }, [series, team, tournament])

  const totalGames = team.wins + team.losses
  const opponentFactor = Math.round((team.factors?.opponent ?? 0) * 100)
  const trendSummary = useMemo(() => summarizeTeamTrend(series), [series])
  const score = teamScoreFor(team)
  const rank = teamRankFor(team)
  const rankEvidence = useMemo(() => summarizeRankEvidence(team, standings), [team, standings])
  const weightSummary = useMemo(() => summarizeTeamMatchWeights(series), [series])
  const powerResumeGap = powerResumeGapSummary(team)
  const movement = activeMovement(team)
  const opponents = useMemo(() => wouldBeatOdds(team, standings, model), [team, standings, model])
  const drawerLoading = [
    historyState.status === 'loading' ? 'rating and match history' : '',
    playerLoadState.status === 'loading' ? 'player rankings' : '',
  ].filter(Boolean).join(' and ')

  return (
    <Sheet open onOpenChange={(nextOpen) => {
      if (!nextOpen) onClose()
    }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-label={`${team.team} details`}
        className="team-detail-sheet h-dvh max-h-dvh gap-0 overflow-hidden border-l border-[var(--line-strong)] bg-[var(--detail-surface)] p-0 text-foreground shadow-[var(--shadow-pop)] [--detail-surface-2:var(--surface-2)] [--detail-surface-3:var(--surface-3)] [--detail-surface:var(--surface)] data-[side=right]:w-[min(820px,100vw)] data-[side=right]:max-w-none data-[side=right]:sm:w-[min(820px,94vw)] data-[side=right]:sm:max-w-none"
      >
        {drawerLoading ? <p className="sr-only" role="status" aria-live="polite">Loading {drawerLoading} for {team.team}.</p> : null}
        {/* The title is the team. Rank and Power sit beside it at the size the
            product exists to show. */}
        <SheetHeader className="flex-row items-center gap-3.5 border-b border-border bg-[var(--detail-surface)] px-5 py-4 text-left max-sm:p-3.5">
          <TeamMark team={team.team} code={team.code} className="size-11" />
          <div className="mr-auto grid min-w-0 gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <SheetTitle className="text-lg font-semibold text-[var(--text-strong)]">{team.team}</SheetTitle>
              {seeded ? <Badge variant="warning">Sample data</Badge> : null}
            </div>
            <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <LeagueSigil league={team.league} />
              {team.league}
              {tier ? <TierBadge tier={tier} /> : null}
            </span>
          </div>
          <div className="grid shrink-0 justify-items-end leading-none">
            <span className="text-2xl font-semibold text-[var(--text-strong)] tabular-nums">{teamBoardRankLabel(team, rank)}</span>
            <span className="mt-1 text-sm text-muted-foreground tabular-nums">{formatRating(score)} Power</span>
          </div>
          <SheetClose asChild>
            <Button type="button" variant="ghost" size="icon" aria-label="Close">
              <X size={18} aria-hidden="true" />
            </Button>
          </SheetClose>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain bg-[var(--detail-surface)] p-4 [&>*]:shrink-0 max-sm:gap-3 max-sm:p-3">
          <section className="grid grid-cols-4 gap-px overflow-hidden rounded-md border border-border bg-border max-[700px]:grid-cols-2 [&>div]:grid [&>div]:content-start [&>div]:gap-0.5 [&>div]:bg-[var(--detail-surface-2)] [&>div]:px-3.5 [&>div]:py-3 [&_b]:text-base [&_b]:font-bold [&_b]:text-[var(--text-strong)] [&_b]:tabular-nums [&_small]:text-xs [&_small]:text-[var(--faint)]" aria-label={`${team.team} key facts`}>
            {tournament && tournamentMovement ? (
              <>
                <div><small>Opening</small><b>{formatRankValue(tournamentMovement.startRank)} · {formatRating(tournamentMovement.startRating)}</b><small>{formatDate(tournament.startDate)}</small></div>
                <div><small>{tournamentBoundaryLabel(tournament.status)}</small><b>{formatRankValue(tournamentMovement.endRank)} · {formatRating(tournamentMovement.endRating)}</b><small>{formatDate(tournament.boundaryDate)}</small></div>
                <div><small>Record in event</small><b>{formatRecord(team.wins, team.losses)}</b><small>{formatRatio(totalGames > 0 ? team.wins / totalGames : undefined)} of scored series</small></div>
                <div><small>Net movement</small><b className={cn(rankMovementTone(tournamentMovement.rankMovement) === 'up' && 'text-[var(--up)]!', rankMovementTone(tournamentMovement.rankMovement) === 'down' && 'text-[var(--down)]!')}>{formatRankMovementLabel(tournamentMovement.rankMovement)}</b><small>{formatRatingMovement(tournamentMovement.ratingDelta)} Power</small></div>
              </>
            ) : (
              <>
                <div title={rankEvidence?.title}><small>Rank from evidence band</small><b>{rankEvidence?.label ?? 'Unavailable'}</b><small>model evidence band</small></div>
                <div title={rollingMovementTitle(team, 'last 30 days')}><small>Last 30 days</small><b className={cn(movement && (movement.rankMovement ?? 0) > 0 && 'text-[var(--up)]!', movement && (movement.rankMovement ?? 0) < 0 && 'text-[var(--down)]!')}>{movement ? formatRankMovementLabel(movement.rankMovement) : 'No series'}</b><small>{movement ? `${formatRatingMovement(movement.ratingDelta ?? 0)} Power` : 'no scored matches'}</small></div>
                <div><small>Record</small><b>{formatRecord(team.wins, team.losses)}</b><small>{formatRatio(totalGames > 0 ? team.wins / totalGames : undefined)} · {recordBasisLabel(team.recordBasis)}</small></div>
                <div title={powerResumeGap?.title}><small>Rank on results alone</small><b>{team.deservedStanding?.rank ? `#${team.deservedStanding.rank}` : 'Unavailable'}</b><small>{powerResumeGap?.isLarge ? 'far from its Power rank' : 'close to its Power rank'}</small></div>
              </>
            )}
          </section>

          <section className="overflow-hidden rounded-md border border-[var(--line-strong)] bg-[var(--detail-surface-2,var(--surface))]" aria-label="Power over time">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-5 pt-4 pb-3">
              <h3 className="text-base font-bold text-[var(--text-strong)]">{tournament ? `${tournament.label} movement` : 'Power this season'}</h3>
              {trendSummary ? (
                <p className="text-xs text-muted-foreground tabular-nums">
                  From {formatRating(trendSummary.opening)} on {formatDate(trendSummary.startDate)} · net <b className={cn('font-semibold', trendSummary.netChange >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]')}>{formatRatingMovement(trendSummary.netChange)}</b> · peak {formatRating(trendSummary.peak.value)}{typeof trendSummary.bestRank === 'number' ? ` · best #${trendSummary.bestRank}` : ''}
                </p>
              ) : null}
            </div>
            {trendSeries.length > 0 ? (
              <div className="px-2 pb-2 [&_.chart_svg]:min-h-[240px]">
                <Suspense fallback={<TrendChartSkeleton />}>
                  <LazyTeamHistoryLineChart series={trendSeries} height={280} yLabel="Power" />
                </Suspense>
              </div>
            ) : historyState.status === 'loading' ? (
              <TrendChartSkeleton />
            ) : historyState.status === 'missing' || historyState.status === 'error' ? (
              <p className="p-5 text-muted-foreground">{historyState.message}</p>
            ) : (
              <p className="p-5 text-muted-foreground">{historyState.status === 'idle' ? 'Rating history loads when this panel opens.' : 'Not enough history to chart this team yet.'}</p>
            )}
            {tournament ? (
              <p className={tournamentDataNoteClassName}>
                {tournamentBoundaryLabel(tournament.status)} {formatDate(tournament.boundaryDate)} · rated through {formatDate(tournament.ratedThroughDate)}
                {tournament.scheduledEndDate ? ` · scheduled end ${formatDate(tournament.scheduledEndDate)}` : ''}
                {tournament.dataLag ? ' · schedule results are ahead of rated evidence' : ''}
                {` · model ${formatModelVersion(tournament.modelVersion)}`}
              </p>
            ) : null}
          </section>

          {opponents.length > 0 ? (
            <section className="rounded-md border border-[var(--line-strong)] bg-[var(--detail-surface-2,var(--surface))] px-5 py-4" aria-label={`${team.code ?? team.team} against the top teams`}>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-base font-bold text-[var(--text-strong)]">Chance to beat the top teams</h3>
                <span className="text-xs text-[var(--faint)]">best of three, neutral side · model {formatModelVersion(model?.version)}</span>
              </div>
              <ul className="grid gap-2">
                {opponents.map(({ opponent, chance }) => (
                  <li className="grid grid-cols-[56px_minmax(0,1fr)_44px] items-center gap-3 text-sm" key={teamKey(opponent)} title={`${team.team} vs ${opponent.team}: ${chance}% to win a best of three`}>
                    <b className="truncate font-mono font-bold text-[var(--text-strong)]">{opponent.code ?? opponent.team}</b>
                    <span className="relative h-2.5 overflow-hidden rounded-full bg-[var(--surface-3)]" aria-hidden="true">
                      <span className="absolute inset-y-0 left-0 rounded-full bg-[var(--series-1)]" style={{ width: `${chance}%` }} />
                      <span className="absolute inset-y-[-2px] left-1/2 w-px bg-muted-foreground" />
                    </span>
                    <b className="text-right font-semibold text-[var(--text-strong)] tabular-nums">{chance}%</b>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-[var(--faint)]">The line marks 50%. Tick Compare on two teams for any matchup.</p>
            </section>
          ) : null}

          <section className="overflow-hidden rounded-md border border-[var(--line-strong)] bg-[var(--detail-surface-2,var(--surface))] p-5 max-[900px]:p-4" aria-label="Match results">
            <div className="flex items-start justify-between gap-3.5 border-b border-[var(--line-strong)] pb-4 max-sm:flex-col">
              <div>
                <h3 className="text-base font-bold text-[var(--text-strong)]">Match results</h3>
                <p className="mt-1 max-w-[58ch] text-sm leading-[1.4] text-[var(--faint)]">{tournament ? `Scored matches in ${tournament.label}.` : 'Scored matches in this period.'} Each row shows the rating after the match and how much the event counted.</p>
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
          </section>

          <details className="rounded-md border border-border bg-[var(--detail-surface-2)] p-3">
            <summary className="cursor-pointer text-sm font-semibold">How the score is built</summary>
            <p className="mt-3 text-sm text-muted-foreground">Power starts from the league's strength and adds this team's own results, its roster and its recent form. The model evidence band is {formatUncertaintyBand(team.ratingComponents?.uncertainty ?? team.uncertainty)}. Close ranks can swap as new evidence arrives. "Rank on results alone" ranks teams only by the results they earned, without the league starting point.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 [&_small]:block [&_small]:text-xs [&_small]:text-muted-foreground [&_b]:block [&_em]:block [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
              {!tournament ? (
                <span title={powerResumeGap?.title}>
                  <small>Power rank vs results rank</small>
                  <b>{powerResumeGap?.label ?? 'No results check'}</b>
                  <em>{powerResumeGap?.detail ?? 'results rank unavailable'}</em>
                </span>
              ) : null}
              <span>
                <small>Most important events</small>
                <b title={weightSummary?.title}>{weightSummary?.label ?? 'Pending'}</b>
                <em>{weightSummary?.detail ?? 'match rows show each event weight'}</em>
              </span>
              {!tournament ? (
                <span title="Normalized opponent strength across this team's scored schedule.">
                  <small>Schedule strength</small>
                  <b>{opponentFactor}%</b>
                  <em>of the strongest possible schedule</em>
                </span>
              ) : null}
              {!tournament ? (
                <span>
                  <small>Roster coverage</small>
                  <b>{team.deservedStanding ? formatRatio(team.deservedStanding.rosterValidity) : 'Match-based'}</b>
                  <em>{team.deservedStanding?.eligibility ?? (team.eligibility?.eligible === false ? 'Limited evidence' : 'Enough evidence to rank')}</em>
                </span>
              ) : null}
              {tournamentMovement ? (
                <span>
                  <small>Endpoint eligibility</small>
                  <b>{tournamentMovement.eligible ? 'Ranked' : 'Unranked'}</b>
                  <em>{tournamentMovement.eligibilityReasons.join(', ') || 'ranking checks passed'}</em>
                </span>
              ) : null}
            </div>
            {tournament ? (
              <p className={tournamentDataNoteClassName}>Component breakdowns are hidden here because the tournament data publishes endpoint rank, score, eligibility and match evidence only.</p>
            ) : <div className="mt-3"><ComponentBreakdown team={team} /></div>}
          </details>
          <details className="rounded-md border border-border p-3">
            <summary className="cursor-pointer text-sm font-semibold">Players</summary>
            <PlayerRankingCard team={team} players={players} currentLineup={currentLineup} loadState={playerLoadState} playerScopeLabel={playerScopeLabel} />
          </details>
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** Best-of-three chances against the top five ranked teams other than this one. */
function wouldBeatOdds(team: RankingSummaryStanding, standings: RankingSummaryStanding[], model?: PublicMatchupModel) {
  if (team.eligibility?.eligible === false) return []
  return standings
    .filter((other) => other.eligibility?.eligible && teamKey(other) !== teamKey(team))
    .toSorted(compareTeamRank)
    .slice(0, 5)
    .map((opponent) => ({
      opponent,
      chance: Math.round(estimatePublicMatchup(team, opponent, model, { bestOf: 3 }).homeSeriesWinProbability * 100),
    }))
}

function TrendChartSkeleton() {
  return <LoadingState presentation="chart" className="trend-chart-skeleton" label="Loading rating trajectory" announce={false} />
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
  const historyPending = !series && historyState.status === 'loading'
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
    <section className="mt-3.5 overflow-hidden rounded-sm border border-[var(--line-strong)] bg-[var(--detail-surface,var(--surface))]" aria-label="Recent form matches">
      <div className="grid grid-cols-[42px_minmax(0,1fr)_minmax(86px,auto)] items-center gap-2.5 border-b border-border px-3.5 py-2 text-2xs font-bold tracking-label text-[var(--faint)] uppercase [&>span:last-child]:text-right max-sm:hidden" aria-hidden="true">
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
                className={cn('grid min-h-16 grid-cols-[28px_minmax(0,1fr)_minmax(92px,auto)] items-start gap-2.5 border-t border-dotted border-border px-3.5 py-3 first:border-t-0 max-sm:grid-cols-[26px_minmax(0,1fr)]', outcomeSignal?.tone === 'upset' && 'shadow-[inset_3px_0_0_color-mix(in_oklch,var(--warn)_72%,transparent)]', outcomeSignal?.tone === 'miss' && 'shadow-[inset_3px_0_0_color-mix(in_oklch,var(--down)_72%,transparent)]')}
                key={`${match.date}-${match.event}-${match.opponent}-${index}`}
              >
                <span className={cn('grid size-[22px] place-items-center rounded-full text-2xs font-extrabold', match.result === 'W' ? 'bg-[var(--win-soft)] text-[var(--win)]' : match.result === 'L' ? 'bg-[var(--loss-soft)] text-[var(--loss)]' : 'bg-[var(--surface-3)] text-muted-foreground')}>{match.result}</span>
                <div className="min-w-0">
                  <span className="flex min-w-0 items-baseline gap-2 max-sm:flex-col max-sm:items-start max-sm:gap-0.5">
                    <b className="inline-block min-w-0 whitespace-normal [overflow-wrap:anywhere] text-sm font-bold text-[var(--text-strong)]">vs {match.opponent}</b>
                    {opponent ? <span className="shrink-0 whitespace-nowrap text-2xs font-semibold text-muted-foreground tabular-nums" title="Current opponent rank and power score in this scope">{formatOpponentContext(opponent)}</span> : null}
                  </span>
                  <small className="mt-0.5 block whitespace-normal [overflow-wrap:anywhere] text-xs text-[var(--faint)]" title={formatTeamMatchDetail(match)}>{formatTeamMatchMeta(match)}</small>
                  <span className="mt-1.5 flex flex-wrap items-center gap-1 [&>span]:inline-flex [&>span]:min-h-[18px] [&>span]:max-w-full [&>span]:items-center [&>span]:whitespace-nowrap [&>span]:rounded-full [&>span]:border [&>span]:border-border [&>span]:bg-[color-mix(in_oklch,var(--detail-surface-2,var(--surface-2))_72%,transparent)] [&>span]:px-1.5 [&>span]:py-0.5 [&>span]:text-2xs [&>span]:font-bold [&>span]:leading-none [&>span]:text-muted-foreground [&>span.miss]:border-[color-mix(in_oklch,var(--down)_44%,var(--line))] [&>span.miss]:text-[var(--down)] [&>span.upset]:border-transparent [&>span.upset]:bg-[var(--warn-soft)] [&>span.upset]:text-[var(--warn)]" aria-label="Match context">
                    {tierChip ? <span title={tierChip.title}>{tierChip.label}</span> : null}
                    {typeof match.expectedWinProbability === 'number' ? (
                      <span title="Pregame expected series win probability for this team">
                        Expected {formatRatio(match.expectedWinProbability)}
                      </span>
                    ) : null}
                    {outcomeSignal ? <span className={outcomeSignal.tone} title={outcomeSignal.title}>{outcomeSignal.label}</span> : null}
                    {historyPending && !tierChip && typeof match.expectedWinProbability !== 'number' ? (
                      <LoadingState presentation="inline" announce={false} label="Loading context" />
                    ) : null}
                  </span>
                </div>
                <div className="pt-px text-right tabular-nums [&_small]:mt-0.5 [&_small]:block [&_small]:text-xs [&_small]:font-bold [&_small]:text-muted-foreground [&_small.down]:text-[var(--down)] [&_small.flat]:text-[var(--faint)] [&_small.up]:text-[var(--up)] [&_strong]:block [&_strong]:text-md [&_strong]:font-bold [&_strong]:text-[var(--text-strong)] max-sm:col-start-2 max-sm:flex max-sm:flex-wrap max-sm:items-baseline max-sm:justify-self-start max-sm:gap-2 max-sm:text-left">
                  <span className="hidden text-xs text-muted-foreground max-sm:block">Post-match Power</span>
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
        <p className="px-3.5 py-4 text-xs text-muted-foreground">
          {historyState.status === 'missing' || historyState.status === 'error'
            ? historyState.message
            : 'No match-level recent form is available in this snapshot.'}
        </p>
      ) : null}
      {(historyState.status === 'missing' || historyState.status === 'error') && recentMatches.length > 0 ? (
        <p className="border-t border-border px-3.5 py-2.5 text-xs leading-[1.4] text-[var(--faint)]">{historyState.message}</p>
      ) : null}
      {totalMatches > RECENT_MATCH_PAGE_SIZE ? (
        <Pager
          label="Match results pagination"
          density="compact"
          page={currentPage}
          pageCount={totalPages}
          onPage={updatePage}
          rangeLabel={resultSummary}
          className="border-t border-border bg-[color-mix(in_oklch,var(--detail-surface-2,var(--surface-2))_64%,transparent)] px-3.5 py-2.5"
        />
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
    <div className="recent-match-skeleton" aria-hidden="true">
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
    title: `${config.description} Applied event weight ${formatEventWeight(weight)}.`,
  }
}

function matchOutcomeSignal(match: RecentMatchSource) {
  const expected = match.expectedWinProbability
  if (typeof expected !== 'number' || !Number.isFinite(expected)) return null
  if (match.result === 'W' && expected < UPSET_CHANCE) {
    return {
      label: 'Upset',
      tone: 'upset',
      title: `Won with ${formatRatio(expected)} expected win probability.`,
    }
  }
  if (match.result === 'L' && expected > 1 - UPSET_CHANCE) {
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

const detailCardClassName = 'min-w-0 overflow-hidden rounded-md border border-[var(--line-strong)] bg-[var(--detail-surface-2,var(--surface))] p-6 max-[900px]:p-4 [&_h3]:text-base [&_h3]:font-bold [&_h3]:text-[var(--text-strong)]'
const emptyPlayerRankCardClassName = cn(detailCardClassName, 'grid gap-3 px-5 py-4 [&_h3]:text-md [&>div:first-child]:border-0 [&>div:first-child]:pb-0')
const playerRankCardHeadClassName = 'flex items-start justify-between gap-3.5 border-b border-[var(--line-strong)] pb-4 [&_h3]:flex [&_h3]:flex-wrap [&_h3]:items-center [&_h3]:gap-2 [&_p]:mt-1 [&_p]:text-sm [&_p]:leading-[1.4] [&_p]:text-[var(--faint)] max-sm:flex-col'
const componentLedgerRowClassName = 'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-2 bg-[var(--detail-surface,var(--surface))] px-3 py-2.5 [&>b]:whitespace-nowrap [&>b]:text-md [&>b]:font-bold [&>b]:text-[var(--text-strong)] [&>b]:tabular-nums [&>b.down]:text-[var(--down)] [&>b.up]:text-[var(--up)] [&>span:first-child]:text-sm [&>span:first-child]:text-muted-foreground'

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
  const observedLineupIds = new Set(currentLineup?.starters.map((player) => player.playerId) ?? [])

  if (players.length === 0) {
    if (loadState.status === 'loading') {
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

    if (loadState.status === 'idle') {
      return (
        <aside className={emptyPlayerRankCardClassName} aria-label={`${team.team} player rankings`}>
          <div className={playerRankCardHeadClassName}>
            <div><h3>Player Rankings</h3><p>Player sources load when this team detail is opened.</p></div>
          </div>
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
          <p className="rounded-sm border border-border bg-[var(--detail-surface,var(--surface))] px-3 py-2.5 text-xs leading-[1.45] text-muted-foreground">
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
        <p className="rounded-sm border border-border bg-[var(--detail-surface,var(--surface))] px-3 py-2.5 text-xs leading-[1.45] text-muted-foreground">
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
              ? `Last observed sourced lineup from ${formatDate(currentLineup.observedAt)}${currentLineup.observedEvent ? ` at ${currentLineup.observedEvent}` : ''}${currentLineup.freshnessDays !== undefined ? `, ${formatNumber(currentLineup.freshnessDays)} days before this build` : ''}. This does not confirm the next starting lineup.`
              : `Career player rows for ${team.code ?? team.team} in ${playerScopeLabel}; no complete current-lineup projection is available.`}
          </p>
          {currentLineup?.missingRoles.length ? <small>Missing roles: {currentLineup.missingRoles.join(', ')}</small> : null}
        </div>
        <CountBadge>{players.length} players</CountBadge>
      </div>

        <Table containerClassName="player-rank-table mt-4 max-h-[360px] overflow-auto rounded-md border border-border max-sm:max-h-none max-sm:overflow-visible [&_.right]:text-right [&_.ent_b]:block [&_.ent_b]:overflow-hidden [&_.ent_b]:text-ellipsis [&_.ent_b]:whitespace-nowrap [&_.ent_small]:block [&_.ent_small]:overflow-hidden [&_.ent_small]:text-ellipsis [&_.ent_small]:whitespace-nowrap [&_table]:w-full [&_table]:table-fixed [&_table]:border-collapse [&_table]:max-sm:block [&_tbody]:max-sm:block [&_td]:border-b [&_td]:border-border [&_td]:px-2 [&_td]:py-2.5 [&_td]:text-left [&_td]:align-middle [&_td]:text-sm [&_th]:sticky [&_th]:top-0 [&_th]:z-[1] [&_th]:border-b [&_th]:border-border [&_th]:bg-[var(--detail-surface-3,var(--surface-3))] [&_th]:py-2.5 [&_tr:last-child_td]:border-b-0">
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
                <TableCell className={cn('font-mono font-semibold text-muted-foreground tabular-nums', player.rank <= 3 && 'text-[var(--rank-gold)]')}>#{player.rank}</TableCell>
                <TableCell>
                  <div className="flex flex-col gap-px [&_b]:font-semibold [&_b]:text-[var(--text-strong)] [&_small]:text-xs [&_small]:text-[var(--faint)]">
                    <b>{player.name}</b>
                    <small>
                      {observedLineupIds.has(player.playerId ?? player.id)
                        ? 'Last observed starter'
                        : 'Historical affiliation'} · impact ×{formatDecimal(player.impactMultiplier)}
                    </small>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="whitespace-nowrap text-xs">{player.role}</Badge>
                </TableCell>
                <TableCell className="right">
                  <HeatChip value={player.rating} min={ratingMin} max={ratingMax} label={formatRating(player.rating)} />
                </TableCell>
                <TableCell className="right num">{formatTeamGames(player)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <PlayerPerformancePanel players={players} scopeLabel={playerScopeLabel} />
    </div>
  )
}

function PlayerRankingSkeleton() {
  return (
    <div className="player-rank-skeleton" aria-hidden="true">
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
    <div className={cn(detailCardClassName, 'px-5 py-4')} aria-label={`${team.team} rating components`}>
      <div className="mb-3.5 flex items-start justify-between gap-3 [&_h3]:text-base [&_h3]:font-bold [&_h3]:text-[var(--text-strong)] [&_p]:mt-1 [&_p]:text-sm [&_p]:leading-[1.4] [&_p]:text-[var(--faint)] [&>span]:shrink-0 [&>span]:text-sm [&>span]:font-bold [&>span]:text-muted-foreground [&>span]:tabular-nums">
        <div>
          <h3>Power Score Breakdown</h3>
          <p>How the model builds this team's Power score from the league anchor and team adjustments.</p>
        </div>
        <span>{formatRating(team.rating)} {formatUncertaintyBand(components.uncertainty)}</span>
      </div>
      <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border">
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

type BoardChanges = { riser?: MovementSpotlight; faller?: MovementSpotlight; upset?: UpsetSpotlight }

function scopeChanges(flair: RankingFlair): BoardChanges {
  const upset = flair.upsetHeadline
  return {
    riser: movementSpotlight(flair.movement.biggestRiser),
    faller: movementSpotlight(flair.movement.biggestFaller),
    upset: upset ? { winner: upset.winnerCode || upset.winner, loser: upset.opponentCode ?? upset.opponent, event: upset.event, chance: upset.expectedWinProbability } : undefined,
  }
}

function movementSpotlight(pick: RankingMovementPick | null): MovementSpotlight | undefined {
  if (!pick) return undefined
  return {
    team: pick.team,
    code: pick.code,
    places: pick.movement,
    ratingDelta: pick.ratingDelta,
    detail: `${pick.team}: match-history rank #${pick.previousRank} to #${pick.rank}, ${formatRatingMovement(pick.ratingDelta)} Power.`,
  }
}

function tournamentChanges(tournament: PublicTournamentMovementShard): BoardChanges {
  const byRise = [...tournament.teams].sort((left, right) => right.rankMovement - left.rankMovement || right.ratingDelta - left.ratingDelta || left.team.localeCompare(right.team))
  const spotlight = (team?: PublicTournamentMovementTeam): MovementSpotlight | undefined => team ? {
    team: team.team,
    code: team.code,
    places: team.rankMovement,
    ratingDelta: team.ratingDelta,
    detail: `${team.team}: ${formatRankValue(team.startRank)} to ${formatRankValue(team.endRank)} through ${tournamentBoundaryLabel(tournament.status).toLowerCase()}, ${formatRatingMovement(team.ratingDelta)} Power.`,
  } : undefined
  return { riser: spotlight(byRise[0]), faller: spotlight(byRise.at(-1)) }
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
