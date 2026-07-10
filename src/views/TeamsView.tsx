import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Minus, Search, Users, X } from 'lucide-react'
import type { CompactPlayer, DataSourceInfo, ModelInfo, RankingSummaryStanding, TeamHistorySeries } from '../lib/snapshot'
import type {
  PublicRecentMatch,
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
import type {
  TeamHistoryArtifactState,
  TournamentMovementIndexState,
  TournamentMovementState,
} from '../hooks/usePublicArtifacts'
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
  const [pageSize, setPageSize] = useState<number>(DEFAULT_TEAM_PAGE_SIZE)
  const [pageState, setPageState] = useState({ scopeKey: '', page: 1 })
  const [detailKey, setDetailKey] = useState<string | null>(null)
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
    return Object.fromEntries(activeTournament.teams.map((team) => [team.teamId, {
      team: team.team,
      code: team.code,
      points: team.points,
    }]))
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
  const eligibilityNote = eligibilityFilter === 'ranked'
    ? hiddenFromRankedCount > 0
      ? `${formatNumber(filtered.length)} eligible teams pass ranking checks. ${formatNumber(hiddenFromRankedCount)} teams are hidden because they lack enough recent matches, have stale schedules, or play in leagues not yet connected to the global pool.`
      : 'Every team in this scope currently passes ranking eligibility.'
    : hiddenFromRankedCount > 0
      ? `${formatNumber(filtered.length)} teams total, including ${formatNumber(hiddenFromRankedCount)} teams kept out of the ranked board for recency, sample-size, uncertainty, or league-connectivity reasons.`
      : 'Every team in this scope currently passes ranking eligibility.'
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
  const sorted = useMemo(() => sortStandings(filtered, sortKey), [filtered, sortKey])
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const pageScopeKey = `${region}\u0000${activeTournamentFilter}\u0000${eligibilityFilter}\u0000${search}\u0000${sortKey}\u0000${pageSize}`
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
    setSortKey(key as SortKey)
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
    <div className="view">
      <div className="gpr-layout">
        <div className="gpr-main">
          <Card className="panel">
            <div className="gpr-toolbar">
              <div className="gpr-filterbar" role="group" aria-label="Team ranking filters">
                <div className="gpr-filterbar__primary">
                  <label className="gpr-filterbar__search">
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
                    className="gpr-filterbar__segmented"
                  />
                  <span className="gpr-filterbar__count">{resultSummary}</span>
                </div>
                <div className="gpr-filterbar__scope">
                  <label className="gpr-filterbar__select">
                    <span>Region</span>
                    <Select value={region} onChange={(event) => setRegion(event.target.value)}>
                      {regionOptions.map((option) => (
                        <option key={option} value={option}>
                          {formatCompetitionRegionLabel(option)}
                        </option>
                      ))}
                    </Select>
                  </label>
                  {tournamentOptions.length > 1 || tournamentMovementIndexState.status === 'loading' ? (
                    <label className="gpr-filterbar__select gpr-filterbar__select--tournament">
                      <span>Tournament</span>
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
                    <Button type="button" variant="ghost" size="sm" className="gpr-filterbar__reset" onClick={resetFilters}>
                      Reset
                      <X size={14} aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
              </div>
              <p className="eligibility-note">{eligibilityNote}</p>
              <p className="score-scale-note">{scoreScaleNote()}</p>
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
              <div className="tablewrap" ref={tableWrapRef}>
                <Table className="ranking-table gpr-grid">
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
                      <SortHeader label="Rank" columnKey="rank" sortKey={sortKey} descending={false} onSort={onSort} />
                      <TableHead>Team</TableHead>
                      <SortHeader label="Power score" columnKey="rating" sortKey={sortKey} descending onSort={onSort} align="right" />
                      <TableHead title={`Movement = rank change vs ${movementBaseline}.`}>
                        {activeTournament ? 'Tournament move' : 'Movement'}
                      </TableHead>
                      <SortHeader label="Match W/L" columnKey="wins" sortKey={sortKey} descending onSort={onSort} align="right" className="gpr-col-record" />
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
                        setDetailKey(key)
                      }
                      return (
                        <TableRow
                          key={key}
                          className={`gpr-row${pickedKeys.has(key) ? ' is-picked' : ''}${tierHighlighted ? ' is-tier-highlight' : ''}${excludedFromRankedBoard ? ' is-excluded' : ''}`}
                          title={excludedFromRankedBoard ? eligibilityReasonsTitle(team) : undefined}
                          onClick={(event) => {
                            if (shouldIgnoreTeamRowClick(event)) return
                            openTeamDetail()
                          }}
                        >
                          <TableCell>
                            <span className="gpr-rankcell">
                              <TeamBoardRank team={team} rank={rank} rawScoreRank={rawScoreRank} />
                              {tier ? <TierBadge tier={tier} /> : null}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Button
                              type="button"
                              variant="ghost"
                              className="team-cell team-cell__button"
                              onClick={openTeamDetail}
                              onFocus={onRequestPlayers}
                              title={`View ${team.team} details`}
                            >
                              <span className="team-mark sm">{team.code ?? team.team.slice(0, 3).toUpperCase()}</span>
                              <div className="ent">
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
                            <b className="record-main">{formatRecord(team.wins, team.losses)}</b>{' '}
                            <span className="record-ratio">{formatRatio(total > 0 ? team.wins / total : undefined)}</span>
                          </TableCell>
                          <TableCell className="center">
                            <PickButton picked={pickedKeys.has(key)} onToggle={() => onToggle(team)} label={team.team} />
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}

            {sorted.length > 0 ? (
              <div className="pager" aria-label="Team table pagination">
                <div className="pager__size">
                  <span>Rows per page</span>
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
                <div className="pager__buttons">
                  <Button type="button" variant="outline" size="icon" className="pager__edge" onClick={() => updatePage(1)} disabled={currentPage === 1} aria-label="First page">
                    <ChevronsLeft size={16} aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="outline" size="icon" onClick={() => updatePage(currentPage - 1)} disabled={currentPage === 1} aria-label="Previous page">
                    <ChevronLeft size={16} aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="outline" size="icon" onClick={() => updatePage(currentPage + 1)} disabled={currentPage === totalPages} aria-label="Next page">
                    <ChevronRight size={16} aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="outline" size="icon" className="pager__edge" onClick={() => updatePage(totalPages)} disabled={currentPage === totalPages} aria-label="Last page">
                    <ChevronsRight size={16} aria-hidden="true" />
                  </Button>
                </div>
              </div>
            ) : null}
          </Card>
        </div>

        <aside className="gpr-sidebar">
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
          <DataSourcesDisclosure model={model} data={panelData} />
        </aside>
      </div>

      <Card
        className="panel compact-panel trajectory-panel"
        ref={trajectoryPanelRef}
        onFocusCapture={onRequestTeamHistory}
        onPointerEnter={onRequestTeamHistory}
      >
        <div className="panel__head trajectory-panel__head">
          <div className="panel__title">
            <p className="eyebrow">{activeTournament ? 'Tournament window' : 'Over time'}</p>
            <h2>{activeTournament ? `${activeTournament.label} movement` : 'Power & rank over time'}</h2>
            <p className="panel__hint">
              {activeTournament
                ? `${tournamentBoundaryLabel(activeTournament.status)} boundary ${formatDate(activeTournament.boundaryDate)} · rated through ${formatDate(activeTournament.ratedThroughDate)}.`
                : metric === 'rank'
                ? 'Daily closing global rank within the current scope; #1 is pinned to the top.'
                : 'Daily closing power score for the selected comparison set.'}
            </p>
          </div>
          <div className="trajectory-panel__controls">
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
          <p className="muted" style={{ padding: 20 }}>Loading tournament movement…</p>
        ) : exactTournamentId && (tournamentMovementState.status === 'missing' || tournamentMovementState.status === 'error') ? (
          <p className="muted" style={{ padding: 20 }}>{tournamentMovementState.message}</p>
        ) : !exactTournamentId && historyState.status === 'idle' ? (
          <p className="muted" style={{ padding: 20 }}>Rating history loads when this panel is viewed.</p>
        ) : !exactTournamentId && historyState.status === 'loading' ? (
          <p className="muted" style={{ padding: 20 }}>Loading rating history…</p>
        ) : !exactTournamentId && (historyState.status === 'missing' || historyState.status === 'error') ? (
          <p className="muted" style={{ padding: 20 }}>{historyState.message}</p>
        ) : (
          <Suspense fallback={<p className="muted" style={{ padding: 20 }}>Loading chart...</p>}>
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
          <div className="trajectory-cards">
            {insights.map(({ team, color, insight }) => (
              <article className="traj-card" key={teamKey(team)}>
                <div className="traj-card__head">
                  <span className="traj-card__swatch" style={{ background: color }} aria-hidden="true" />
                  <b>{team.code ?? team.team}</b>
                  <span className={`delta ${insight.netChange > 0 ? 'up' : insight.netChange < 0 ? 'down' : 'flat'}`}>
                    {formatSigned(insight.netChange)}
                  </span>
                </div>
                <p className="traj-card__summary">{insight.summary}</p>
                <div className="traj-card__stats">
                  <span>
                    Peak <b>{formatRating(insight.peak.value)}</b>
                    {typeof insight.bestRank === 'number' ? ` · best #${insight.bestRank}` : ''}
                  </span>
                  {insight.driver ? <span className="traj-card__driver">Driven by {insight.driver.label}</span> : null}
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </Card>

      {detailTeam ? (
        <TeamDetailDrawer
          team={detailTeam}
          standings={displayStandings}
          series={activeHistory?.[teamKey(detailTeam)]}
          historyState={historyState}
          tournament={activeTournament}
          tournamentMovement={movementByTeamId.get(detailTeam.teamId)}
          players={detailPlayers}
          playerLoadState={playerLoadState}
          playerScopeLabel={playerScopeLabel}
          seeded={Boolean(panelData?.seeded)}
          onClose={() => setDetailKey(null)}
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
    <span className="team-score-stack" title={exactTournament ? `Tournament endpoint Power score ${formatRating(score)}` : teamScoreTitle(team)}>
      {typeof score === 'number' ? (
        <span className="team-score-value">{formatRating(score)}</span>
      ) : (
        <span className="score-unavailable">—</span>
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
      <span className="gpr-rank-stack">
        <span className="gpr-rank gpr-rank--excluded">Excluded</span>
        {typeof rawScoreRank === 'number' ? (
          <span className="rank-context-pill" title="Raw score order if eligibility gates were ignored.">
            Score #{formatNumber(rawScoreRank)}
          </span>
        ) : null}
      </span>
    )
  }

  return (
    <span className={`gpr-rank${typeof rank === 'number' && rank <= 3 ? ' podium' : ''}`}>
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
    <span className="score-meta">
      {items.map((item) => <span key={item.key} title={item.title}>{item.label}</span>)}
    </span>
  )
}

function TierBadge({ tier }: { tier: RankingTierLabel }) {
  return (
    <span className={`tier-badge is-${tier.toLowerCase()}`} role="img" title={`${tier}-tier`} aria-label={`${tier}-tier`}>
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
      <span className="rank-trend-cell rank-trend-cell--empty">
        <span className="rank-trend-cell__move flat">No history</span>
      </span>
    )
  }

  const tone = rankMovementTone(summary.recentMovement)
  const title = rankTrendTitle(team.team, summary, movementBaseline)
  return (
    <span className="rank-trend-cell" role="img" title={title} aria-label={title} style={rankMovementStyle(summary.recentMovement)}>
      <span
        className={`rank-trend-cell__main ${tone}`}
        aria-hidden="true"
      >
        <RankMovementIcon tone={tone} />
        <b className={`rank-trend-cell__move ${tone}`}>{formatRankMovementCompact(summary.recentMovement)}</b>
      </span>
      {sparkline ? (
        <svg
          className="rank-trend-cell__sparkline"
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
      <span className="rank-trend-cell rank-trend-cell--empty">
        <span className="rank-trend-cell__move flat">Unavailable</span>
      </span>
    )
  }
  const tone = rankMovementTone(movement.rankMovement)
  const title = `${movement.team} · ${formatRankValue(movement.startRank)} to ${formatRankValue(movement.endRank)} at ${endpointLabel} · ${formatRankMovementLabel(movement.rankMovement)} · Power score ${formatRatingMovement(movement.ratingDelta)}`
  return (
    <span className="tournament-move-cell" role="img" title={title} aria-label={title}>
      <span className="tournament-move-cell__ranks">
        <b>{formatRankValue(movement.startRank)} → {formatRankValue(movement.endRank)}</b>
        <small>{endpointLabel}</small>
      </span>
      <span className={`tournament-move-cell__delta ${tone}`}>
        <RankMovementIcon tone={tone} />
        {formatSigned(movement.rankMovement)} rank
      </span>
      <small className={movementTone(movement.ratingDelta)}>Score {formatRatingMovement(movement.ratingDelta)}</small>
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
    <section className="method-panel region-teaser" aria-label="Region power scores">
      <div className="rail-card-head">
        <div>
          <p className="eyebrow">Regional strength</p>
          <h2>All regions</h2>
        </div>
        {href ? <a href={href}>Details</a> : null}
      </div>
      <div className="region-strength-grid">
        {ranked.map((region) => (
          <div className="region-strength-cell" key={region.region}>
            <RegionBadge region={region.region} size="sm" />
            <span className="region-strength-name">{region.region}</span>
            <strong>{formatRating(displayRegionPowerScore(region))}</strong>
          </div>
        ))}
      </div>
      <p className="method-foot">Region power is the average of each region's top three eligible flagship teams.</p>
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
    <details className="rail-disclosure">
      <summary>
        <span>Data &amp; sources</span>
        <small>Coverage, config, providers</small>
      </summary>
      <div className="data-model-grid">
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
        <div className="provider-list">
          {providers.map((provider) => (
            <div className="provider-row" key={provider.provider}>
              <span>{provider.provider}</span>
              <b>{formatNumber(provider.matchCount)}</b>
            </div>
          ))}
        </div>
      ) : null}
      {sourceFreshness.length > 0 ? (
        <div className="provider-list" aria-label="Source freshness">
          {sourceFreshness.map((source) => (
            <div className="provider-row" key={source.name}>
              <span title={source.description}>{compactSourceName(source.name)}</span>
              <b>{sourceFreshnessLabel(source)}</b>
            </div>
          ))}
        </div>
      ) : null}
      {data?.seeded ? (
        <p className="method-foot danger">Seeded sample data is active. Do not treat these rows as official rankings.</p>
      ) : warnings.length > 0 ? (
        <>
          {warnings.map((warning, index) => (
            <p className={`method-foot${warning.severity === 'error' || warning.severity === 'warning' ? ' danger' : ''}`} key={`${warning.kind}-${index}`}>
              {warning.message}
            </p>
          ))}
        </>
      ) : notes.length > 0 ? (
        <>
          {notes.map((note) => <p className="method-foot" key={note}>{note}</p>)}
        </>
      ) : (
        <p className="method-foot">Latest match: {formatDate(data?.latestMatchDate)}</p>
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

function TeamDetailDrawer({
  team,
  standings,
  series,
  historyState,
  tournament,
  tournamentMovement,
  players,
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
        overlayClassName="team-detail-sheet__overlay"
        aria-label={`${team.team} details`}
        className="team-detail-sheet w-full max-w-none gap-0 border-l border-[var(--line-strong)] bg-[var(--surface)] p-0 text-[var(--text)] shadow-[var(--shadow-pop)] sm:w-[min(820px,94vw)] sm:max-w-none"
        style={{ width: 'min(820px, 100vw)', maxWidth: 'none' }}
      >
        <SheetHeader className="team-detail-sheet__head flex-row items-center text-left">
          <div className="team-dossier__identity">
            <span className="team-mark">{team.code ?? team.team.slice(0, 3).toUpperCase()}</span>
            <div>
              <p>Team inspector</p>
              <div className="team-detail-title-row">
                <SheetTitle>{team.team}</SheetTitle>
                {seeded ? <span className="team-detail-title-badge">Sample data</span> : null}
                <span className="team-dossier__league">
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

        <div className="team-detail-sheet__body min-h-0 flex-1">
          <section className="team-detail-hero" aria-label={`${team.team} summary`}>
            <div className="team-detail-hero__score">
              <span className="team-detail-hero__rank">{teamBoardRankLabel(team, rank)}</span>
              <div>
                <strong>{formatRating(score)}</strong>
                <small>Power score{typeof uncertainty === 'number' ? ` ${formatUncertaintyBand(uncertainty)}` : ''}</small>
              </div>
            </div>
            <div className="team-detail-hero__facts">
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

          <div className="team-detail-stack">
            <div className="gpr-card match-evidence-card">
              <div className="match-evidence-card__head">
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
              <p className="tournament-data-note">Component and uncertainty breakdowns are hidden here because the tournament shard publishes exact endpoint rank, score, eligibility, and match evidence only.</p>
            ) : <ComponentBreakdown team={team} />}
            <PlayerRankingCard team={team} players={players} loadState={playerLoadState} playerScopeLabel={playerScopeLabel} />
          </div>

          <div className="gpr-card trend-card">
            <div className="trend-card__head">
              <div>
                <p className="eyebrow">Power trajectory</p>
                <h3>{tournament ? `${tournament.label} movement` : 'Ranking Trends'}</h3>
              </div>
              <span>Power score</span>
            </div>
            {trendSummary ? (
              <div className="trend-summary" aria-label={`${team.team} trend summary`}>
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
              <div className="trend-summary rank-trend-summary" aria-label={`${team.team} rank movement summary`}>
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
              <div className="trend-card__plot">
                <Suspense fallback={<TrendChartSkeleton />}>
                  <LazyTeamHistoryLineChart series={trendSeries} height={340} yLabel="Power score" />
                </Suspense>
              </div>
            ) : historyState.status === 'idle' || historyState.status === 'loading' ? (
              <TrendChartSkeleton />
            ) : historyState.status === 'missing' || historyState.status === 'error' ? (
              <p className="muted" style={{ paddingTop: 16 }}>{historyState.message}</p>
            ) : (
              <p className="muted" style={{ paddingTop: 16 }}>Not enough history to chart this team yet.</p>
            )}
            {tournament ? (
              <p className="tournament-data-note">
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
    <section className="recent-matches" aria-label="Recent form matches">
      <div className="recent-match-list__head" aria-hidden="true">
        <span>Result</span>
        <span>Opponent</span>
        <span>Rating after</span>
      </div>
      {recentMatches.length > 0 ? (
        <div className="recent-match-list">
          {recentMatches.map((match, index) => {
            const opponent = opponentLookup.get(normalizeOpponentLookupKey(match.opponent))
            const outcomeSignal = matchOutcomeSignal(match)
            const tierChip = matchTierChip(match)
            return (
              <div
                className={`recent-match-row${outcomeSignal ? ` is-${outcomeSignal.tone}` : ''}`}
                key={`${match.date}-${match.event}-${match.opponent}-${index}`}
              >
                <span className={`result-chip ${match.result === 'W' ? 'w' : 'l'}`}>{match.result}</span>
                <div className="recent-match-row__main">
                  <span className="recent-match-row__opponent">
                    <b>vs {match.opponent}</b>
                    {opponent ? <span title="Current opponent rank and power score in this scope">{formatOpponentContext(opponent)}</span> : null}
                  </span>
                  <small title={formatTeamMatchDetail(match)}>{formatTeamMatchMeta(match)}</small>
                  <span className="recent-match-row__chips" aria-label="Match context">
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
                <div className="recent-match-row__rating">
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
        <p className="muted recent-matches__empty">
          {historyState.status === 'missing' || historyState.status === 'error'
            ? historyState.message
            : 'No match-level recent form is available in this snapshot.'}
        </p>
      ) : null}
      {(historyState.status === 'missing' || historyState.status === 'error') && recentMatches.length > 0 ? (
        <p className="recent-matches__notice">{historyState.message}</p>
      ) : null}
      {totalMatches > RECENT_MATCH_PAGE_SIZE ? (
        <div className="recent-matches__pager pager" aria-label="Match results pagination">
          <div className="pager__page">
            {resultSummary}
          </div>
          <div className="pager__buttons">
            <Button type="button" variant="outline" size="icon" className="pager__edge" onClick={() => updatePage(1)} disabled={currentPage === 1} aria-label="First match page">
              <ChevronsLeft size={16} aria-hidden="true" />
            </Button>
            <Button type="button" variant="outline" size="icon" onClick={() => updatePage(currentPage - 1)} disabled={currentPage === 1} aria-label="Previous match page">
              <ChevronLeft size={16} aria-hidden="true" />
            </Button>
            <Button type="button" variant="outline" size="icon" onClick={() => updatePage(currentPage + 1)} disabled={currentPage === totalPages} aria-label="Next match page">
              <ChevronRight size={16} aria-hidden="true" />
            </Button>
            <Button type="button" variant="outline" size="icon" className="pager__edge" onClick={() => updatePage(totalPages)} disabled={currentPage === totalPages} aria-label="Last match page">
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
    <span className={`league-sigil${small ? ' small' : ''}`} aria-hidden="true">
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

function PlayerRankingCard({
  team,
  players,
  loadState,
  playerScopeLabel = 'the current scope',
}: {
  team: RankingSummaryStanding
  players: CompactPlayer[]
  loadState: PlayerLoadState
  playerScopeLabel?: string
}) {
  const [ratingMin, ratingMax] = useMemo(() => extent(players.map((player) => player.rating)), [players])

  if (players.length === 0) {
    if (loadState.status === 'idle' || loadState.status === 'loading') {
      return (
        <aside className="gpr-card player-rank-card player-rank-card--empty" aria-label={`${team.team} player rankings`}>
          <div className="player-rank-card__head">
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
        <aside className="gpr-card player-rank-card player-rank-card--empty" aria-label={`${team.team} player rankings`}>
          <div className="player-rank-card__head">
            <div>
              <h3>
                Player Rankings
                <CountBadge>Unavailable</CountBadge>
              </h3>
              <p>{loadState.message}</p>
            </div>
          </div>
          <p className="muted player-rank-card__empty">
            Team rating still uses scored matches, opponent context, and roster-continuity coverage; player rankings require sourced player rows.
          </p>
        </aside>
      )
    }

    return (
      <aside className="gpr-card player-rank-card player-rank-card--empty" aria-label={`${team.team} player rankings`}>
        <div className="player-rank-card__head">
          <div>
            <h3>
              Player Rankings
              <CountBadge>Source gap</CountBadge>
            </h3>
            <p>No player-level sources for {team.code ?? team.team} in {playerScopeLabel}.</p>
          </div>
        </div>
        <p className="muted player-rank-card__empty">
          Team rating still uses scored matches, opponent context, and roster-continuity coverage; player rankings require sourced player rows.
        </p>
      </aside>
    )
  }

  return (
    <div className="gpr-card player-rank-card">
      <div className="player-rank-card__head">
        <div>
          <h3>Player Rankings</h3>
          <p>Individual rows for {team.code ?? team.team} in {playerScopeLabel}.</p>
        </div>
        <CountBadge>{players.length} players</CountBadge>
      </div>

      <div className="player-rank-table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rank</TableHead>
              <TableHead>Player</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="right">Rating</TableHead>
              <TableHead className="right" title="Team games">Games</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {players.map((player) => (
              <TableRow key={player.id}>
                <TableCell className={`rank-cell${player.rank <= 3 ? ' podium' : ''}`}>#{player.rank}</TableCell>
                <TableCell>
                  <div className="ent">
                    <b>{player.name}</b>
                    <small>impact ×{formatDecimal(player.impactMultiplier)}</small>
                  </div>
                </TableCell>
                <TableCell>
                  <span className="role-pill">{player.role}</span>
                </TableCell>
                <TableCell className="right">
                  <HeatChip value={player.rating} min={ratingMin} max={ratingMax} label={formatRating(player.rating)} />
                </TableCell>
                <TableCell className="right num">{formatTeamGames(player)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
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
    <div className="gpr-card component-breakdown" aria-label={`${team.team} rating components`}>
      <div className="component-breakdown__head">
        <div>
          <h3>Power Score Breakdown</h3>
          <p>How the model builds this team's Power score from the league anchor and team adjustments.</p>
        </div>
        <span>{formatRating(team.rating)} {formatUncertaintyBand(components.uncertainty)}</span>
      </div>
      <div className="component-ledger">
        <div className="component-ledger__row is-anchor" title="League anchor baseline before team-specific adjustments.">
          <span className="component-ledger__label">{POWER_COMPONENT_LABELS.league}</span>
          <b>{formatRating(components.leagueAnchor)}</b>
          <ComponentBar value={components.leagueAnchor} max={maxComponentMagnitude} />
        </div>
        {contributionRows.map((row) => (
          <div className="component-ledger__row" key={row.label}>
            <span className="component-ledger__label">{row.label}</span>
            <b className={movementTone(row.value)}>{formatRatingMovement(row.value)}</b>
            <ComponentBar value={row.value} max={maxComponentMagnitude} />
          </div>
        ))}
        <div className="component-ledger__row is-total">
          <span className="component-ledger__label">Power score</span>
          <b>{formatRating(team.rating)}</b>
        </div>
      </div>
    </div>
  )
}

function ComponentBar({ value, max }: { value: number; max: number }) {
  const width = max > 0 ? clampNumber((Math.abs(value) / max) * 100, 2, 100) : 0
  return (
    <span className={`component-ledger__bar ${value < 0 ? 'is-negative' : 'is-positive'}`} aria-hidden="true">
      <span style={{ width: `${width}%` }} />
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

function sortStandings(rows: RankingSummaryStanding[], key: SortKey) {
  const copy = [...rows]
  switch (key) {
    case 'rating':
      return copy.sort((a, b) => compareRankedBoardEligibility(a, b) || compareTeamScore(b, a) || compareTeamRank(a, b))
    case 'wins':
      return copy.sort((a, b) => compareRankedBoardEligibility(a, b) || (b.wins ?? 0) - (a.wins ?? 0) || compareTeamRank(a, b))
    default:
      return copy.sort((a, b) => compareRankedBoardEligibility(a, b) || compareTeamRank(a, b))
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
  const teamCode = team.code?.toLowerCase()
  const teamRegion = team.region

  return [...(players ?? [])]
    .filter((player) => {
      if (player.region && teamRegion && player.region !== teamRegion) return false
      const playerTeam = player.team.toLowerCase()
      const playerCode = player.teamCode?.toLowerCase()
      return playerTeam === teamName || (Boolean(teamCode) && playerCode === teamCode)
    })
    .sort((a, b) => a.rank - b.rank || (ROLE_ORDER.get(a.role) ?? 99) - (ROLE_ORDER.get(b.role) ?? 99) || a.name.localeCompare(b.name))
}

function formatTeamGames(player: CompactPlayer) {
  const teamGames = player.teamGames ?? player.appearance?.latestTeamGames
  if (typeof teamGames !== 'number') return formatNumber(player.games)
  return `${formatNumber(teamGames)} / ${formatNumber(player.games)}`
}
