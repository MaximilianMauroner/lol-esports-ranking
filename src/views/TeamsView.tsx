import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Search, Users, X } from 'lucide-react'
import type { CompactPlayer, DataSourceInfo, ModelInfo, RankingSummaryStanding, TeamHistorySeries } from '../lib/snapshot'
import type { PublicRecentMatch } from '../lib/publicArtifacts/schema'
import type { RegionStrength } from '../lib/regionStrength'
import { extent, formatDate, formatDateRange, formatDecimal, formatNumber, formatRating, formatRatio, formatRecord, formatSigned, teamKey } from '../lib/display'
import { deriveTrajectoryInsight, type TrajectoryInsight } from '../lib/trajectory'
import { formatCompetitionLeagueLabel, formatCompetitionRegionLabel } from '../data/regionTaxonomy'
import { CountBadge, DataState, FormDots, HeatChip, PickButton, RegionBadge, Segmented, SortHeader } from '../components/ui'
import { Button } from '../components/ui/button'
import { Card } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Select } from '../components/ui/select'
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from '../components/ui/sheet'
import { RankingShowcase, type RankingShowcaseProps } from '../components/RankingShowcase'
import { type ChartSeries } from '../components/LineChart'
import { TeamHistoryLineChart } from '../components/TeamHistoryLineChart'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import type { ChartPoint } from '../lib/chartPoints'
import { dailyChartPointsFromHistoryPoints, deriveDailyRankSeries } from '../lib/teamHistoryChart'
import type { TeamHistoryArtifactState } from '../hooks/usePublicArtifacts'

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
  seeded?: boolean
  sourceBreakdown?: { provider: string; matchCount: number }[]
  notes?: string[]
  regionFilter?: string
  tableTeamCount?: number
  scopeTeamCount?: number
  hiddenFromRankedCount?: number
}

const TEAM_RANK_AXIS_LIMIT = 60
const TEAM_PAGE_SIZES = [15, 25, 50, 80] as const
const DEFAULT_TEAM_PAGE_SIZE = 25
const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)']
const ROLE_ORDER = new Map(['Top', 'Jungle', 'Mid', 'Bot', 'Support'].map((role, index) => [role, index]))
export function TeamsView({
  standings,
  regions,
  model,
  players,
  search,
  onSearchChange,
  pickedTeams,
  historyState,
  signals,
  regionsHref,
  dataSummary,
  onToggle,
}: {
  standings: RankingSummaryStanding[]
  regions: RegionStrength[]
  model?: Pick<ModelInfo, 'version' | 'configHash'>
  players?: CompactPlayer[]
  search: string
  onSearchChange: (value: string) => void
  pickedTeams: RankingSummaryStanding[]
  historyState: TeamHistoryArtifactState
  signals?: RankingShowcaseProps
  regionsHref?: string
  dataSummary?: TeamDataSummary
  onToggle: (team: RankingSummaryStanding) => void
}) {
  const [region, setRegion] = useState('All')
  const [eligibilityFilter, setEligibilityFilter] = useState<EligibilityFilter>('ranked')
  const [sortKey, setSortKey] = useState<SortKey>('rank')
  const [pageSize, setPageSize] = useState<number>(DEFAULT_TEAM_PAGE_SIZE)
  const [pageState, setPageState] = useState({ scopeKey: '', page: 1 })
  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [metric, setMetric] = useState<TrajectoryMetric>('rating')
  const history = historyState.status === 'ready' ? historyState.data.series : undefined

  const pickedKeys = useMemo(() => new Set(pickedTeams.map(teamKey)), [pickedTeams])

  const regionOptions = useMemo(
    () => ['All', ...Array.from(new Set(standings.map((team) => team.region).filter(Boolean))).sort()],
    [standings],
  )

  const scopeFiltered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return standings.filter((team) => {
      if (region !== 'All' && team.region !== region) return false
      if (!query) return true
      return [team.team, team.code, team.region, team.league].some((value) => value?.toLowerCase().includes(query))
    })
  }, [standings, region, search])

  const filtered = useMemo(
    () => eligibilityFilter === 'ranked' ? scopeFiltered.filter((team) => team.eligibility?.eligible) : scopeFiltered,
    [scopeFiltered, eligibilityFilter],
  )
  const hiddenFromRankedCount = useMemo(
    () => scopeFiltered.filter((team) => !team.eligibility?.eligible).length,
    [scopeFiltered],
  )
  const eligibilityNote = eligibilityFilter === 'ranked'
    ? hiddenFromRankedCount > 0
      ? `${formatNumber(filtered.length)} eligible teams pass ranking checks. ${formatNumber(hiddenFromRankedCount)} review rows are hidden because they need more current, anchored evidence.`
      : 'Every team in this scope currently passes ranking eligibility.'
    : hiddenFromRankedCount > 0
      ? `${formatNumber(filtered.length)} teams total, including ${formatNumber(hiddenFromRankedCount)} review rows kept out of the ranked board.`
      : 'Every team in this scope currently passes ranking eligibility.'
  const panelData = useMemo<TeamDataSummary | undefined>(() => dataSummary
    ? {
        ...dataSummary,
        regionFilter: region,
        tableTeamCount: filtered.length,
        scopeTeamCount: standings.length,
        hiddenFromRankedCount,
      }
    : undefined,
  [dataSummary, filtered.length, hiddenFromRankedCount, region, standings.length])

  const sorted = useMemo(() => sortStandings(filtered, sortKey), [filtered, sortKey])
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const pageScopeKey = `${region}\u0000${eligibilityFilter}\u0000${search}\u0000${sortKey}\u0000${pageSize}`
  const requestedPage = pageState.scopeKey === pageScopeKey ? pageState.page : 1
  const currentPage = Math.min(requestedPage, totalPages)
  const pageStart = (currentPage - 1) * pageSize
  const visible = sorted.slice(pageStart, pageStart + pageSize)
  const pageEnd = sorted.length === 0 ? 0 : pageStart + visible.length
  const resultSummary = `${formatNumber(sorted.length === 0 ? 0 : pageStart + 1)}-${formatNumber(pageEnd)} of ${formatNumber(filtered.length)}`
  const hasActiveFilters = search.trim() !== '' || region !== 'All' || eligibilityFilter !== 'ranked'
  const [ratingMin, ratingMax] = useMemo(
    () => extent(filtered.map((team) => teamScoreFor(team) ?? Number.NaN)),
    [filtered],
  )

  const detailTeam = useMemo(
    () => (detailKey ? standings.find((team) => teamKey(team) === detailKey) : undefined),
    [detailKey, standings],
  )
  const detailPlayers = useMemo(
    () => (detailTeam ? playersForTeam(players, detailTeam) : []),
    [detailTeam, players],
  )

  const focusTeams = pickedTeams.length > 0 ? pickedTeams : sorted.slice(0, 5)
  const dailyRankSeries = useMemo(
    () => metric === 'rank' && history ? deriveDailyRankSeries(history) : new Map<string, ChartPoint[]>(),
    [history, metric],
  )
  const chartSeries = useMemo<ChartSeries[]>(() => {
    if (!history) return []
    return focusTeams
      .map((team, index): ChartSeries | null => {
        const series = history[teamKey(team)]
        const key = teamKey(team)
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
  }, [dailyRankSeries, focusTeams, history, metric])

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
          insight: deriveTrajectoryInsight(team, history?.[teamKey(team)]),
        }))
        .filter((entry): entry is { team: RankingSummaryStanding; color: string; insight: TrajectoryInsight } =>
          entry.insight !== null,
        ),
    [focusTeams, history],
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

  function resetFilters() {
    onSearchChange('')
    setRegion('All')
    setEligibilityFilter('ranked')
    setPageState({ scopeKey: pageScopeKey, page: 1 })
  }

  return (
    <div className="view">
      <div className="gpr-layout">
        <div className="gpr-main">
          <Card className="panel">
            <div className="gpr-toolbar">
              <div className="gpr-filterbar" aria-label="Team ranking filters">
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
                {hasActiveFilters ? (
                  <Button type="button" variant="ghost" size="sm" className="gpr-filterbar__reset" onClick={resetFilters}>
                    Reset
                    <X size={14} aria-hidden="true" />
                  </Button>
                ) : null}
                <span className="gpr-filterbar__count">{resultSummary}</span>
              </div>
              <p className="eligibility-note">{eligibilityNote}</p>
            </div>

            {visible.length === 0 ? (
              <DataState icon={<Users size={26} aria-hidden="true" />} title="No teams match">
                Adjust the search, region, or eligibility filter to see teams.
              </DataState>
            ) : (
              <div className="tablewrap">
                <Table className="ranking-table gpr-grid">
                  <colgroup>
                    <col className="gpr-col-rank" />
                    <col className="gpr-col-team" />
                    <col className="gpr-col-score" />
                    <col className="gpr-col-record" />
                    <col className="gpr-col-action" />
                  </colgroup>
                  <TableHeader>
                    <TableRow>
                      <SortHeader label="Rank" columnKey="rank" sortKey={sortKey} descending={false} onSort={onSort} />
                      <TableHead>Team</TableHead>
                      <SortHeader label="Team score" columnKey="rating" sortKey={sortKey} descending onSort={onSort} align="right" />
                      <SortHeader label="Match W/L" columnKey="wins" sortKey={sortKey} descending onSort={onSort} align="right" className="gpr-col-record" />
                      <TableHead className="center" aria-label="Add to comparison" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((team) => {
                      const key = teamKey(team)
                      const total = team.wins + team.losses
                      const rank = teamRankFor(team)
                      return (
                        <TableRow
                          key={key}
                          className={`gpr-row${pickedKeys.has(key) ? ' is-picked' : ''}`}
                        >
                          <TableCell>
                            <span className="gpr-rankcell">
                              <span className={`gpr-rank${typeof rank === 'number' && rank <= 3 ? ' podium' : ''}`}>
                                {rank ?? '—'}
                              </span>
                            </span>
                          </TableCell>
                          <TableCell>
                            <Button
                              type="button"
                              variant="ghost"
                              className="team-cell team-cell__button"
                              onClick={() => setDetailKey(key)}
                              aria-label={`View ${team.team} details`}
                            >
                              <span className="team-mark sm">{team.code ?? team.team.slice(0, 3).toUpperCase()}</span>
                              <div className="ent">
                                <b>{team.team}</b>
                                <small>{teamSubtitle(team)}</small>
                              </div>
                            </Button>
                          </TableCell>
                          <TableCell className="right">
                            <TeamScoreCell team={team} min={ratingMin} max={ratingMax} />
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
                  <Select value={String(pageSize)} onChange={(event) => updatePageSize(Number(event.target.value))}>
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
          {signals ? <RankingShowcase {...signals} variant="rail" /> : null}
          <DataSourcesDisclosure model={model} data={panelData} />
        </aside>
      </div>

      <Card className="panel compact-panel trajectory-panel">
        <div className="panel__head trajectory-panel__head">
          <div className="panel__title">
            <p className="eyebrow">Over time</p>
            <h2>Power &amp; rank over time</h2>
            <p className="panel__hint">
              {metric === 'rank'
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
              {pickedTeams.length > 0 ? `${chartSeries.length} selected` : 'Showing top 5 · pick teams above to focus'}
            </CountBadge>
          </div>
        </div>
        {historyState.status === 'loading' ? (
          <p className="muted" style={{ padding: 20 }}>Loading rating history…</p>
        ) : historyState.status !== 'ready' ? (
          <p className="muted" style={{ padding: 20 }}>{historyState.message}</p>
        ) : (
          <TeamHistoryLineChart
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
          series={history?.[teamKey(detailTeam)]}
          players={detailPlayers}
          onClose={() => setDetailKey(null)}
        />
      ) : null}
    </div>
  )
}

function TeamScoreCell({
  team,
  min,
  max,
}: {
  team: RankingSummaryStanding
  min: number
  max: number
}) {
  const score = teamScoreFor(team)
  return (
    <>
      {typeof score === 'number' ? (
        <HeatChip value={score} min={min} max={max} label={formatRating(score)} />
      ) : (
        <span className="score-unavailable">—</span>
      )}
      <TeamScoreMeta team={team} />
    </>
  )
}

function TeamScoreMeta({ team }: { team: RankingSummaryStanding }) {
  const dss = team.deservedStanding
  if (!dss) return null
  if (dss.eligibility === 'Eligible') return null
  return <span className="score-meta" title={teamScoreTitle(team)}>{dss.eligibility}</span>
}

function teamRankFor(team: RankingSummaryStanding) {
  return team.rank
}

function teamScoreFor(team: RankingSummaryStanding) {
  return team.rating
}

function teamScoreTitle(team: RankingSummaryStanding) {
  const dss = team.deservedStanding
  if (!dss) return `Team score ${formatRating(team.rating)}`
  return [
    `Team score ${formatRating(team.rating)}`,
    `deserved check #${dss.rank} (${formatRating(dss.score)})`,
    `WAE ${formatSigned(dss.winsAboveExpectation)}`,
    `roster validity ${formatRatio(dss.rosterValidity)}`,
    dss.eligibility,
  ].join(' · ')
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

function teamSubtitle(team: RankingSummaryStanding) {
  const reasons = team.eligibility?.eligible === false
    ? team.eligibility.reasons.join(', ')
    : undefined
  return [formatCompetitionLeagueLabel(team.league ?? team.region), reasons].filter(Boolean).join(' · ')
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
  const ranked = useMemo(() => [...regions].sort((a, b) => b.score - a.score), [regions])
  if (ranked.length === 0) return null
  return (
    <section className="method-panel region-teaser" aria-label="Region power scores">
      <div className="rail-card-head">
        <div>
          <p className="eyebrow">Regional strength</p>
          <h3>All regions</h3>
        </div>
        {href ? <a href={href}>Details</a> : null}
      </div>
      <div className="region-strength-grid">
        {ranked.map((region) => (
          <div className="region-strength-cell" key={region.region}>
            <RegionBadge region={region.region} size="sm" />
            <span className="region-strength-name">{region.region}</span>
            <strong>{formatRating(region.score)}</strong>
          </div>
        ))}
      </div>
      <p className="method-foot">Regional score is the average of each region's top three eligible flagship teams.</p>
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
          <b>{model?.version ?? 'unknown'}</b>
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
          <small>Hidden review rows</small>
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

function TeamDetailDrawer({
  team,
  series,
  players,
  onClose,
}: {
  team: RankingSummaryStanding
  series?: TeamHistorySeries
  players: CompactPlayer[]
  onClose: () => void
}) {
  const trendSeries = useMemo<ChartSeries[]>(() => {
    if (!series || series.points.length < 2) return []
    return [{
      id: teamKey(team),
      label: team.code ?? team.team,
      color: 'var(--accent)',
      points: dailyChartPointsFromHistoryPoints(series.points),
    }]
  }, [series, team])

  const totalGames = team.wins + team.losses
  const opponentFactor = Math.round((team.factors?.opponent ?? 0) * 100)
  const trendSummary = useMemo(() => summarizeTeamTrend(series), [series])
  const uncertainty = team.ratingComponents?.uncertainty
  const score = teamScoreFor(team)
  const rank = teamRankFor(team)

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
              <span className="team-detail-hero__rank">#{rank ?? '—'}</span>
              <div>
                <strong>{formatRating(score)}</strong>
                <small>Team score</small>
              </div>
            </div>
            <div className="team-detail-hero__facts">
              <span>
                <small>Match record</small>
                <b>{formatRecord(team.wins, team.losses)} ({formatRatio(totalGames > 0 ? team.wins / totalGames : undefined)})</b>
              </span>
              <span>
                <small>Latest delta</small>
                <b className={movementTone(team.delta)}>{formatRatingMovement(team.delta)}</b>
                <TeamRatingSparkline series={series} summary={trendSummary} teamName={team.team} />
              </span>
              <span>
                <small>Power rating</small>
                <b>{formatRating(team.rating)}{typeof uncertainty === 'number' ? ` ±${formatRating(uncertainty)}` : ''}</b>
              </span>
              <span>
                <small>Opponent factor</small>
                <b>{opponentFactor}%</b>
                <em>Schedule signal</em>
              </span>
              {team.deservedStanding ? (
                <span>
                  <small>Score evidence</small>
                  <b>{team.deservedStanding.eligibility}</b>
                  <em>Roster {formatRatio(team.deservedStanding.rosterValidity)}</em>
                </span>
              ) : null}
            </div>
          </section>

          <div className="team-detail-stack">
            <div className="gpr-card match-evidence-card">
              <div className="match-evidence-card__head">
                <div>
                  <h3>Match Results</h3>
                  <p>Last five scored matches. Ratings show post-match team power.</p>
                </div>
                <FormDots form={team.form} />
              </div>

              <RecentMatches matches={team.recentMatches} />
            </div>

            <ComponentBreakdown team={team} />
            <PlayerRankingCard team={team} players={players} />
          </div>

          <div className="gpr-card trend-card">
            <div className="trend-card__head">
              <div>
                <p className="eyebrow">Power trajectory</p>
                <h3>Ranking Trends</h3>
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
            {trendSeries.length > 0 ? (
              <div className="trend-card__plot">
                <TeamHistoryLineChart series={trendSeries} height={340} yLabel="Power score" />
              </div>
            ) : (
              <p className="muted" style={{ paddingTop: 16 }}>Not enough history to chart this team yet.</p>
            )}
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

function RecentMatches({ matches }: { matches?: PublicRecentMatch[] }) {
  const recentMatches = (matches ?? []).slice(-5).toReversed()

  return (
    <section className="recent-matches" aria-label="Recent form matches">
      <div className="recent-match-list__head" aria-hidden="true">
        <span>Result</span>
        <span>Opponent</span>
        <span>Rating after</span>
      </div>
      {recentMatches.length > 0 ? (
        <div className="recent-match-list">
          {recentMatches.map((match, index) => (
            <div className="recent-match-row" key={`${match.date}-${match.event}-${match.opponent}-${index}`}>
              <span className={`result-chip ${match.result === 'W' ? 'w' : 'l'}`}>{match.result}</span>
              <div className="recent-match-row__main">
                <b>vs {match.opponent}</b>
                <small title={formatTeamMatchDetail(match)}>{formatTeamMatchMeta(match)}</small>
              </div>
              <div className="recent-match-row__rating">
                <strong>{formatRating(match.rating)}</strong>
                <small className={movementTone(match.delta)}>{formatRatingMovement(match.delta)}</small>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted recent-matches__empty">No match-level recent form is available in this snapshot.</p>
      )}
    </section>
  )
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

function TrendSummaryCell({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <span>
      <small>{label}</small>
      <b>{value}</b>
      <em>{detail}</em>
    </span>
  )
}

function PlayerRankingCard({ team, players }: { team: RankingSummaryStanding; players: CompactPlayer[] }) {
  const [ratingMin, ratingMax] = useMemo(() => extent(players.map((player) => player.rating)), [players])

  if (players.length === 0) {
    return (
      <aside className="gpr-card player-rank-card player-rank-card--empty" aria-label={`${team.team} player rankings`}>
        <div className="player-rank-card__head">
          <div>
            <h3>
              Player Rankings
              <CountBadge>Source gap</CountBadge>
            </h3>
            <p>No player-level sources for {team.code ?? team.team} in this scope.</p>
          </div>
        </div>
        <p className="muted player-rank-card__empty">
          Team rating is backed by scored matches, opponent context, and model history.
        </p>
      </aside>
    )
  }

  return (
    <div className="gpr-card player-rank-card">
      <div className="player-rank-card__head">
        <div>
          <h3>Player Rankings</h3>
          <p>Individual rows for {team.code ?? team.team} in the current scope.</p>
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

function ComponentBreakdown({ team }: { team: RankingSummaryStanding }) {
  const components = team.ratingComponents
  if (!components) return null
  const contributionRows = [
    { label: 'Stable offset', value: components.teamStableOffset },
    { label: 'Roster prior', value: components.rosterPriorOffset },
    { label: 'Momentum', value: components.momentum },
    { label: 'Context', value: components.contextAdjustment },
  ]

  return (
    <div className="gpr-card component-breakdown" aria-label={`${team.team} rating components`}>
      <div className="component-breakdown__head">
        <div>
          <h3>Power Components</h3>
          <p>Score ledger from league anchor to current rating.</p>
        </div>
        <span>{formatRating(team.rating)} ±{formatRating(components.uncertainty)}</span>
      </div>
      <div className="component-ledger">
        <div className="component-ledger__row is-anchor">
          <span>League anchor</span>
          <b>{formatRating(components.leagueAnchor)}</b>
        </div>
        {contributionRows.map((row) => (
          <div className="component-ledger__row" key={row.label}>
            <span>{row.label}</span>
            <b className={movementTone(row.value)}>{formatRatingMovement(row.value)}</b>
          </div>
        ))}
        <div className="component-ledger__row is-total">
          <span>Total power score</span>
          <b>{formatRating(team.rating)}</b>
        </div>
      </div>
    </div>
  )
}

function sortStandings(rows: RankingSummaryStanding[], key: SortKey) {
  const copy = [...rows]
  switch (key) {
    case 'rating':
      return copy.sort((a, b) => compareRankedBoardEligibility(a, b) || compareTeamScore(b, a) || compareTeamRank(a, b))
    case 'wins':
      return copy.sort((a, b) => compareRankedBoardEligibility(a, b) || (b.wins ?? 0) - (a.wins ?? 0) || compareTeamRank(a, b))
    default:
      return copy.sort((a, b) => compareTeamRank(a, b))
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
