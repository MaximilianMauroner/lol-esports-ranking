import { shouldIgnoreTeamRowClick } from './boardEvents'
import { ChevronRight, SlidersHorizontal, Users, X } from 'lucide-react'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { currentHashQuery, hashEnum, hashInt, hashParam, useHashSync } from '../../browser/navigation'
import type {
  TeamHistoryArtifactState,
  TournamentMovementIndexState,
  TournamentMovementState,
} from '../../browser/rankings/usePublicArtifacts'
import type { ChartSeries } from '../../components/LineChart'
import { TeamMark } from '../../components/TeamMark'
import { DataState, FormDots, Segmented, SortHeader } from '../../components/ui'
import { Alert } from '../../components/ui/alert'
import { Button } from '../../components/ui/button'
import { LoadingState } from '../../components/ui/loading'
import { PageShell } from '../../components/ui/page-shell'
import { Pager } from '../../components/ui/pager'
import { Panel, PanelBody, PanelFooter, PanelHeader } from '../../components/ui/panel'
import { Select } from '../../components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import {
  formatCompetitionRegionLabel, tournamentBoundaryLabel,
  tournamentIdFromFilter, type TournamentFilterValue, type TournamentInstanceId
} from '../../domains/rankings/evidence'
import {
  ELIGIBILITY_FILTERS, gameWinChanceForGap, NEAR_TIE_WIN_PROBABILITY, nearTieGroups, nearTiePositions, SORT_DIRECTIONS,
  SORT_KEYS,
  TIER_FILTERS, type EligibilityFilter, type NearTiePosition, type PublicMatchupModel, type RankingUniverse, type RegionStrength, type SortDirection,
  type SortKey,
  type TierFilter
} from '../../domains/rankings/read'
import type { CompactPlayer, PublicCurrentLineup, RankingSummaryStanding, TeamHistorySeries } from '../../domains/rankings/types'
import { useTeamDetailAddress } from '../../hooks/useTeamDetailAddress'
import type { ChartPoint } from '../../shared/chartPoints'
import { assignColorSlots, sameColorSlots } from '../../shared/colorSlots'
import { extent, formatDate, formatDateRange, formatModelVersion, formatNumber, formatRating, formatRatio, formatRecord, formatSigned, teamKey } from '../../shared/display'
import { cn } from '../../shared/utils'
import { ChipGroup, NearTieMark, RegionalStrengthTeaser, TeamBoardRank, TeamScoreCell, TierBadge, TournamentMoveChip } from './BoardCells'
import { activeMovement, eligibilityReasonsTitle, eligibilitySummary, rankAxisForSeries, rollingMovementTitle, teamRankFor, teamScoreFor } from './boardFormat'
import { boardHeadline } from './boardHeadline'
import { boardChanges, tournamentTrajectoryInsight } from './boardHistory'
import { CompareToggle } from './CompareToggle'
import { DataSourcesDisclosure } from './DataSourcesDisclosure'
import { LazyTeamHistoryLineChart, loadTeamHistoryLineChart } from './historyChart'
import { playersForTeam } from './playerData'
import { PowerLadder } from './PowerLadder'
import { TeamDetailDrawer } from './TeamDetailDrawer'
import { dailyChartPointsFromHistoryPoints, deriveDailyRankSeries, tournamentChartPoints } from './teamHistoryChart'
import { type TrajectoryInsight } from './trajectory'
import { type PlayerLoadState, type TeamDataSummary, type TrajectoryMetric } from './types'
import { MovementChip, WhatChanged } from './WhatChanged'

const TEAM_PAGE_SIZES = [15, 25, 50, 80] as const

const DEFAULT_TEAM_PAGE_SIZE = 25

/** The ladder stays readable in a 320px rail up to about this many rows. */
const LADDER_TEAM_LIMIT = 16

const DEFAULT_FOCUS_TEAMS = 5

const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)']

/**
 * The board filters this view keeps in the hash, read on mount and on every
 * hash change. Search and tournament are App state, and App reads them from
 * the same query.
 */
function readBoardAddress(query: URLSearchParams) {
  const sortKey = hashEnum('sort', SORT_KEYS, 'rank', query)
  const pageSize = hashInt('size', DEFAULT_TEAM_PAGE_SIZE, query)
  return {
    region: hashParam('region', query) ?? 'All',
    tierFilter: hashEnum('tier', TIER_FILTERS, 'All', query),
    eligibilityFilter: hashEnum('eligibility', ELIGIBILITY_FILTERS, 'ranked', query),
    sortKey,
    // The address omits the direction when it is the sort's default.
    sortDirection: hashEnum('dir', SORT_DIRECTIONS, defaultSortDirection(sortKey), query),
    pageSize: TEAM_PAGE_SIZES.includes(pageSize as typeof TEAM_PAGE_SIZES[number]) ? pageSize : DEFAULT_TEAM_PAGE_SIZE,
    page: hashInt('page', 1, query),
  }
}

/** Rank reads best first; Power and wins read highest first. */
function defaultSortDirection(key: SortKey): SortDirection {
  return key === 'rank' ? 'ascending' : 'descending'
}

export function TeamsView({
  universe,
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
  requestedTournamentFilter,
  tournamentMovementIndexState,
  tournamentMovementState,
  regionsHref,
  dataSummary,
  hashQuery,
  requestedScope,
  effectiveScope,
  onToggle,
  onRequestPlayers,
  onRequestTeamHistory,
  onTournamentFilterChange,
  onPrefetchTournament,
  onRetryTournamentMovements,
}: {
  universe: RankingUniverse
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
  requestedTournamentFilter: TournamentFilterValue
  tournamentMovementIndexState: TournamentMovementIndexState
  tournamentMovementState: TournamentMovementState
  regionsHref?: string
  dataSummary?: TeamDataSummary
  /** The hash query App read on the last hash change. A new object means a new address. */
  hashQuery: URLSearchParams
  requestedScope: string
  effectiveScope: string
  onToggle: (team: RankingSummaryStanding) => void
  onRequestPlayers?: () => void
  onRequestTeamHistory?: (teams?: readonly string[]) => void
  onTournamentFilterChange: (value: TournamentFilterValue) => void
  onPrefetchTournament?: (id: TournamentInstanceId) => void
  onRetryTournamentMovements?: () => void
}) {
  // Seeded from the hash so a shared or reloaded board comes back as it was.
  const [address] = useState(() => readBoardAddress(currentHashQuery()))
  const [region, setRegion] = useState(address.region)
  const [tierFilter, setTierFilter] = useState<TierFilter>(address.tierFilter)
  const [eligibilityFilter, setEligibilityFilter] = useState<EligibilityFilter>(address.eligibilityFilter)
  const [sortKey, setSortKey] = useState<SortKey>(address.sortKey)
  const [sortDirection, setSortDirection] = useState<SortDirection>(address.sortDirection)
  const [pageSize, setPageSize] = useState<number>(address.pageSize)
  // A page read from the address has no filter key yet. It belongs to the
  // filters read with it, so the first render binds it to their key.
  const [pageState, setPageState] = useState<{ scopeKey?: string; page: number }>({ page: address.page })
  // A typed or linked address, Back or Forward changes the hash without a
  // reload. App then passes a new query, and the board shows what a reload
  // of that address would show.
  const [appliedQuery, setAppliedQuery] = useState(hashQuery)
  if (hashQuery !== appliedQuery) {
    const next = readBoardAddress(hashQuery)
    setAppliedQuery(hashQuery)
    setRegion(next.region)
    setTierFilter(next.tierFilter)
    setEligibilityFilter(next.eligibilityFilter)
    setSortKey(next.sortKey)
    setSortDirection(next.sortDirection)
    setPageSize(next.pageSize)
    setPageState({ page: next.page })
  }
  const scopeTeams = useMemo(() => new Map(universe.scopeStandings.map((team) => [teamKey(team), team])), [universe.scopeStandings])
  const detail = useTeamDetailAddress(hashQuery, scopeTeams, requestedScope, effectiveScope)
  const [metric, setMetric] = useState<TrajectoryMetric>('rating')
  // Phones fold the filters behind one button so the first screen shows teams.
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [colorSlots, setColorSlots] = useState<ReadonlyMap<string, number>>(() => new Map())
  const trajectoryPanelRef = useRef<HTMLDivElement | null>(null)
  const [trajectoryRequested, setTrajectoryRequested] = useState(false)
  const history = historyState.status === 'ready' ? historyState.data.series : undefined

  const pickedKeys = useMemo(() => new Set(pickedTeams.map(teamKey)), [pickedTeams])

  const { standings, tournament: activeTournament, tournamentFilter: activeTournamentFilter, exactTournamentId, tierFor, movementByTeamId } = universe
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

  const pageScopeKey = `${region}\u0000${tierFilter}\u0000${requestedTournamentFilter}\u0000${eligibilityFilter}\u0000${search}\u0000${sortKey}\u0000${sortDirection}\u0000${pageSize}`
  if (pageState.scopeKey === undefined) setPageState({ scopeKey: pageScopeKey, page: pageState.page })
  const requestedPage = pageState.scopeKey === undefined || pageState.scopeKey === pageScopeKey ? pageState.page : 1
  const board = useMemo(
    () => universe.select({ region, tier: tierFilter, eligibility: eligibilityFilter, search, sortKey, sortDirection, pageSize, requestedPage }),
    [eligibilityFilter, pageSize, region, requestedPage, search, sortDirection, sortKey, tierFilter, universe],
  )
  const { rows, visibleRows, page, tierCounts, unrankedOnTournamentBoard, activeFilterCount } = board
  const { hiddenFromRankedCount } = board.disclosure
  const resultSummary = `${formatNumber(rows.length === 0 ? 0 : page.start + 1)}-${formatNumber(page.end)} of ${formatNumber(rows.length)}`
  const hasActiveFilters = activeFilterCount > 0

  const movementPeriod = activeTournament
    ? `since ${activeTournament.label} start`
    : dataSummary?.rollingWindow
      ? formatDateRange(dataSummary.rollingWindow.startDate, dataSummary.rollingWindow.endDate)
      : 'since the previous update'
  const panelData = useMemo<TeamDataSummary | undefined>(
    () => dataSummary ? { ...dataSummary, ...board.disclosure } : undefined,
    [board.disclosure, dataSummary],
  )
  const changes = useMemo(() => boardChanges(board.movement), [board.movement])
  const [ratingMin, ratingMax] = useMemo(
    () => extent(rows.map((team) => teamScoreFor(team) ?? Number.NaN)),
    [rows],
  )

  // Near ties only mean something when neighbours on screen are neighbours in
  // the ranking, so they follow the ranked order and not a Power or record sort.
  const rankedOrder = sortKey === 'rank' && sortDirection === 'ascending'
  const ladderGroups = useMemo(
    () => nearTieGroups(board.rankedRows.slice(0, LADDER_TEAM_LIMIT), model),
    [board.rankedRows, model],
  )
  const tiePositions = useMemo(
    () => rankedOrder ? nearTiePositions(nearTieGroups(visibleRows.filter((team) => team.eligibility?.eligible), model), teamKey) : new Map<string, NearTiePosition>(),
    [model, rankedOrder, visibleRows],
  )
  const headline = useMemo(
    () => activeTournament ? undefined : boardHeadline(universe.rankedStandings, model),
    [activeTournament, model, universe.rankedStandings],
  )
  const gapExample = useMemo(() => gameWinChanceForGap(model), [model])

  const detailTeam = useMemo(
    () => {
      const scopeTeam = detail.item
      return scopeTeam ? standings.find((team) => teamKey(team) === teamKey(scopeTeam)) : undefined
    },
    [detail.item, standings],
  )
  const detailPlayers = useMemo(
    () => (detailTeam ? playersForTeam(players, detailTeam) : []),
    [detailTeam, players],
  )
  const detailLineup = detailTeam ? currentLineups?.[detailTeam.teamId] : undefined

  useEffect(() => {
    if (!onRequestTeamHistory || exactTournamentId || detailTeam) return undefined
    const panel = trajectoryPanelRef.current
    if (!panel) return undefined

    const IntersectionObserverCtor = Reflect.get(window, 'IntersectionObserver') as typeof IntersectionObserver | undefined
    if (!IntersectionObserverCtor) {
      const handle = window.setTimeout(() => setTrajectoryRequested(true), 1200)
      return () => window.clearTimeout(handle)
    }

    const observer = new IntersectionObserverCtor((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setTrajectoryRequested(true)
      observer.disconnect()
    }, { rootMargin: '420px 0px' })

    observer.observe(panel)
    return () => observer.disconnect()
  }, [detailTeam, exactTournamentId, onRequestTeamHistory])

  const pickedFocusTeams = useMemo(
    () => exactTournamentId ? pickedTeams.filter((team) => activeHistory?.[teamKey(team)]) : pickedTeams,
    [activeHistory, exactTournamentId, pickedTeams],
  )
  const focusTeams = useMemo(
    () => pickedFocusTeams.length > 0 ? pickedFocusTeams : rows.slice(0, DEFAULT_FOCUS_TEAMS),
    [pickedFocusTeams, rows],
  )
  // Colours follow teams, not positions. Derived during render and stored only
  // when the assignment changes, so an unchanged assignment keeps its identity.
  const requestedHistoryTeams = (detailTeam ? [teamKey(detailTeam)] : focusTeams.map(teamKey)).sort().join('\u0000')
  useEffect(() => {
    if ((detailTeam || trajectoryRequested) && !exactTournamentId) onRequestTeamHistory?.(requestedHistoryTeams.split('\u0000').filter(Boolean))
  }, [detailTeam, trajectoryRequested, exactTournamentId, onRequestTeamHistory, requestedHistoryTeams])

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
    setSortDirection(defaultSortDirection(nextKey))
  }

  function updatePage(nextPage: number) {
    setPageState({ scopeKey: pageScopeKey, page: Math.min(Math.max(1, nextPage), page.count) })
  }

  function updateTournamentFilter(value: TournamentFilterValue) {
    const id = tournamentIdFromFilter(value)
    if (id) onPrefetchTournament?.(id)
    onTournamentFilterChange(value)
    setPageState({ scopeKey: pageScopeKey, page: 1 })
  }

  function openTeam(team: RankingSummaryStanding) {
    detail.open(teamKey(team))
  }

  function prepareTeamDetails() {
    void loadTeamHistoryLineChart().catch(() => { /* Opening a detail can retry. */ })
  }

  // Same param names and same "omit the default" rule as the other views.
  useHashSync('rankings', {
    team: search.trim(),
    region: region === 'All' ? '' : region,
    tier: tierFilter === 'All' ? '' : tierFilter,
    tournament: activeTournamentFilter === 'All' ? '' : activeTournamentFilter,
    eligibility: eligibilityFilter === 'ranked' ? '' : eligibilityFilter,
    sort: sortKey === 'rank' ? '' : sortKey,
    dir: sortDirection === defaultSortDirection(sortKey) ? '' : sortDirection,
    size: pageSize === DEFAULT_TEAM_PAGE_SIZE ? '' : String(pageSize),
    page: page.current > 1 ? String(page.current) : '',
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
      {detail.missing ? (
        <Alert variant="warning" role="status">
          This team is not available in {dataSummary?.scopeLabel ?? 'the selected scope'}. Showing the ranking board.
          <Button variant="ghost" onClick={detail.dismissMissing}>Dismiss</Button>
        </Alert>
      ) : null}
      {headline ? <p className="max-w-[72ch] text-lg leading-[1.3] font-semibold text-[var(--text-strong)]">{headline}</p> : null}
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_320px] items-start gap-6 max-[1280px]:grid-cols-1">
        <div className="min-w-0">
          <Panel>
            <PanelHeader
              title={activeTournament ? `${activeTournament.label} standings` : 'Power ranking'}
              description={activeTournament ? `Ranks and scores at the event endpoint, ${formatDate(activeTournament.boundaryDate)}.${board.showsWholeTournamentField ? ' Includes every participant.' : ''}` : undefined}
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
                  options={universe.regionOptions.map((option) => ({ value: option, label: option === 'All' ? 'All regions' : formatCompetitionRegionLabel(option) }))}
                  onChange={setRegion}
                />
                <ChipGroup
                  label="Tier"
                  value={tierFilter}
                  options={[{ value: 'All', label: 'All tiers' }, ...tierCounts.map(({ tier, count }) => ({ value: tier, label: `${tier} · ${count}`, disabled: count === 0 }))]}
                  onChange={setTierFilter}
                />
                {universe.tournamentOptions.length > 1 || tournamentMovementIndexState.status === 'loading' ? (
                  <label className="inline-flex min-w-0 max-w-full items-center [&_[data-slot=select]]:max-w-full max-sm:w-full max-sm:[&>span]:w-full max-sm:[&_[data-slot=select]]:w-full">
                    <span className="sr-only">Tournament</span>
                    <Select value={activeTournamentFilter} onChange={(event) => updateTournamentFilter(event.target.value as TournamentFilterValue)}>
                      {universe.tournamentOptions.map((option) => (
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
                {unrankedOnTournamentBoard > 0 ? (
                  <span className="inline-flex h-[var(--control-h)] items-center text-sm text-muted-foreground" title="A tournament board lists every participant. Unranked teams miss an eligibility check at the event endpoint.">
                    Includes {formatNumber(unrankedOnTournamentBoard)} unranked
                  </span>
                ) : null}
                {hiddenFromRankedCount > 0 && !exactTournamentId ? (
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
                <span><b className="font-semibold text-muted-foreground">Form</b> oldest → latest · latest underlined</span>
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
              <LoadingState className="m-4" label="Loading tournament movement" />
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
            ) : visibleRows.length === 0 ? (
              <DataState
                icon={<Users size={26} aria-hidden="true" />}
                title="No teams match these filters"
                action={hasActiveFilters ? <Button type="button" variant="outline" onClick={resetFilters}>Clear filters</Button> : undefined}
              />
            ) : (
                <Table containerClassName="@container/board max-w-full [contain:paint] [overscroll-behavior-x:contain]" className="ranking-table board-grid w-full min-w-[640px] border-collapse text-sm max-sm:min-w-full">
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
                      <TableHead className="board-col-form" title="Last five results, oldest to latest. Latest result is underlined.">Form</TableHead>
                      <SortHeader label="Record" columnKey="wins" sortKey={sortKey} descending={sortDirection === 'descending'} onSort={onSort} align="right" className="board-col-record" />
                      <TableHead className="board-col-action"><span className="sr-only">Compare and open</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleRows.map((team) => {
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
                          onPointerEnter={prepareTeamDetails}
                          onTouchStart={prepareTeamDetails}
                          onClick={(event) => {
                            if (shouldIgnoreTeamRowClick(event)) return
                            openTeam(team)
                          }}
                        >
                          <TableCell className="board-col-rank relative" aria-label={excludedFromRankedBoard ? 'Unranked' : `Rank ${rank}`}>
                            {tie ? <NearTieMark position={tie} /> : null}
                            <span className="board-rankcell flex items-center gap-2 whitespace-nowrap">
                              <TeamBoardRank team={team} rank={rank} rawScoreRank={board.scopeScoreRanks.get(key)} />
                              {tier ? <TierBadge tier={tier} /> : null}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Button
                              type="button"
                              variant="ghost"
                              className="team-cell team-cell__button h-auto min-h-9 w-full cursor-pointer justify-start gap-3 whitespace-normal rounded-sm border-0 bg-transparent p-0 text-left font-[inherit] text-[inherit] hover:bg-transparent hover:text-[inherit] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--focus)]"
                              onClick={() => openTeam(team)}
                              onFocus={prepareTeamDetails}
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
                              <ChevronRight className="board-open-hint size-4 shrink-0 text-[var(--faint)] group-hover/board:text-foreground" aria-hidden="true" />
                            </span>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
            )}

            {rows.length > 0 ? (
              <PanelFooter>
                <Pager
                  label="Team table pagination"
                  page={page.current}
                  pageCount={page.count}
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
              <PanelHeader title="Power ladder" actions={<span className="text-xs text-[var(--faint)]">{ladderGroups.flat().length < rows.length ? `top ${ladderGroups.flat().length}` : 'all ranked'}</span>} />
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
        onFocusCapture={() => setTrajectoryRequested(true)}
        onPointerEnter={() => setTrajectoryRequested(true)}
      >
        <PanelHeader
          title={activeTournament ? `${activeTournament.label} movement` : metric === 'rank' ? 'Rank over time' : 'Power over time'}
          description={
            activeTournament
              ? `${tournamentBoundaryLabel(activeTournament.status)} boundary ${formatDate(activeTournament.boundaryDate)}, rated through ${formatDate(activeTournament.ratedThroughDate)}.`
              : pickedFocusTeams.length > 0 ? 'Compared teams' : `Top ${DEFAULT_FOCUS_TEAMS} teams`
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
        {detailTeam ? <div className="min-h-[300px]" aria-hidden="true" /> : exactTournamentId && tournamentMovementState.status === 'loading' ? (
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
              interactiveLegend={metric === 'rank'}
              yReverse={metric === 'rank'}
              curve={metric === 'rank' ? 'step' : 'linear'}
            />
          </Suspense>
        )}
        {metric === 'rank' && chartSeries.length > 0 ? (
          <PanelBody className="pt-1 pb-4">
            <Table className="text-xs" aria-label="Rank changes over the shown period">
              <TableHeader><TableRow><TableHead>Team</TableHead><TableHead>Start</TableHead><TableHead>Best</TableHead><TableHead>Latest</TableHead><TableHead>Change</TableHead></TableRow></TableHeader>
              <TableBody>
                {chartSeries.map((entry) => {
                  const start = entry.points[0].y
                  const latest = entry.points.at(-1)!.y
                  const best = Math.min(...entry.points.map((point) => point.y))
                  const movement = start - latest
                  return (
                    <TableRow key={entry.id}>
                      <TableCell className="font-semibold">{entry.label}</TableCell>
                      <TableCell className="tabular-nums">#{start}</TableCell>
                      <TableCell className="tabular-nums">#{best}</TableCell>
                      <TableCell className="font-semibold tabular-nums">#{latest}</TableCell>
                      <TableCell className={cn('tabular-nums', movement > 0 && 'text-[var(--up)]', movement < 0 && 'text-[var(--down)]')}>{movement === 0 ? 'Same' : `${movement > 0 ? 'Up' : 'Down'} ${Math.abs(movement)}`}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </PanelBody>
        ) : metric !== 'rank' && insights.length > 0 ? (
          <PanelBody className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-2.5 pt-1 pb-4">
            {insights.map(({ team, color, insight }) => (
              <article className="grid gap-2 rounded-md border border-border bg-[var(--surface-2)] px-3.5 py-3" key={teamKey(team)}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="size-2.5 shrink-0 rounded-sm" style={{ background: color }} aria-hidden="true" />
                  <b className="mr-auto text-md font-semibold text-[var(--text-strong)]">{team.code ?? team.team}</b>
                  <span className={cn('font-mono text-xs tabular-nums', insight.netChange > 0 ? 'text-[var(--up)]' : insight.netChange < 0 ? 'text-[var(--down)]' : 'text-[var(--faint)]')}>
                    Net change {formatSigned(insight.netChange)}
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
          standings={standings}
          rankedStandings={universe.rankedStandings}
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
          onRequestPlayers={onRequestPlayers}
          seeded={Boolean(panelData?.seeded)}
          onClose={detail.close}
        />
      ) : null}
    </PageShell>
  )
}
