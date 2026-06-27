import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ArrowLeftRight, BarChart3, Crosshair, Swords, Trophy, Users, X } from 'lucide-react'
import type { CompactPlayer, ModelInfo, RankingSummaryStanding, TeamHistorySeries } from '../lib/snapshot'
import type { PublicRecentMatch } from '../lib/publicArtifacts/schema'
import type { RegionStrength } from '../lib/regionStrength'
import { estimatePublicMatchup } from '../lib/publicMatchup'
import { rankingTargetExplanations } from '../lib/rankingExplanations'
import { extent, formatDate, formatDateRange, formatDecimal, formatNumber, formatRating, formatRatio, formatRecord, formatSigned, teamKey } from '../lib/display'
import { deriveTrajectoryInsight, type TrajectoryInsight } from '../lib/trajectory'
import { formatCompetitionLeagueLabel, formatCompetitionRegionLabel } from '../data/regionTaxonomy'
import { DataState, FormDots, HeatChip, PickButton, RegionBadge, Segmented, SortHeader } from '../components/ui'
import { LineChart, type ChartSeries } from '../components/LineChart'

type SortKey = 'rank' | 'rating' | 'wins'
type TrajectoryMetric = 'rating' | 'rank'
type EligibilityFilter = 'ranked' | 'all'
type TeamDataSummary = {
  source?: string
  matchCount?: number
  coverageStart?: string
  coverageEnd?: string
  latestMatchDate?: string
  seeded?: boolean
  sourceBreakdown?: { provider: string; matchCount: number }[]
  notes?: string[]
}

const TEAM_ROW_LIMIT = 60
const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)']
const ROLE_ORDER = new Map(['Top', 'Jungle', 'Mid', 'Bot', 'Support'].map((role, index) => [role, index]))
const LEAGUE_LOGOS: Record<string, string> = {
  LPL: '/league-icons/lpl.png',
}

export function TeamsView({
  standings,
  regions,
  model,
  players,
  search,
  pickedTeams,
  history,
  updatedAt,
  dataSummary,
  onToggle,
}: {
  standings: RankingSummaryStanding[]
  regions: RegionStrength[]
  model?: Pick<ModelInfo, 'version' | 'configHash'>
  players?: CompactPlayer[]
  search: string
  pickedTeams: RankingSummaryStanding[]
  history?: Record<string, TeamHistorySeries>
  updatedAt?: string
  dataSummary?: TeamDataSummary
  onToggle: (team: RankingSummaryStanding) => void
}) {
  const [region, setRegion] = useState('All')
  const [eligibilityFilter, setEligibilityFilter] = useState<EligibilityFilter>('ranked')
  const [sortKey, setSortKey] = useState<SortKey>('rank')
  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [metric, setMetric] = useState<TrajectoryMetric>('rating')

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

  const sorted = useMemo(() => sortStandings(filtered, sortKey), [filtered, sortKey])
  const visible = sorted.slice(0, TEAM_ROW_LIMIT)
  const [ratingMin, ratingMax] = useMemo(() => extent(filtered.map((team) => team.rating)), [filtered])

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
    () => metric === 'rank' && history ? deriveDailyRankSeries(history) : new Map<string, { t: number; y: number }[]>(),
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
        // Collapse to one point per day (the day's closing value) so the lines
        // read as a trend instead of intraday churn.
        const byDay = new Map<string, (typeof series.points)[number]>()
        for (const point of series.points) byDay.set(point[0], point)
        const daily = [...byDay.values()]
        return {
          id: key,
          label: team.code ?? team.team,
          color: SERIES_COLORS[index % SERIES_COLORS.length],
          points: daily.map((point) => ({ t: Date.parse(point[0]), y: point[1] })),
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

  return (
    <div className="view">
      <div className="gpr-layout">
        <div className="gpr-main">
          <section className="panel">
            <div className="gpr-toolbar">
              <div className="gpr-toolbar__title">
                <h2>Current</h2>
                {updatedAt ? <p className="gpr-updated">Updated {updatedAt}</p> : null}
              </div>
              <div className="toolbar">
                <Segmented
                  value={eligibilityFilter}
                  options={[
                    { value: 'ranked', label: 'Eligible only' },
                    { value: 'all', label: 'All teams' },
                  ]}
                  onChange={setEligibilityFilter}
                />
                <label className="field" style={{ gridAutoFlow: 'column', alignItems: 'center', gap: 8 }}>
                  <span>Region</span>
                  <select value={region} onChange={(event) => setRegion(event.target.value)}>
                    {regionOptions.map((option) => (
                      <option key={option} value={option}>
                        {formatCompetitionRegionLabel(option)}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="count">
                  {visible.length} of {filtered.length}
                </span>
              </div>
              <p className="eligibility-note">{eligibilityNote}</p>
            </div>

            {visible.length === 0 ? (
              <DataState icon={<Users size={26} aria-hidden="true" />} title="No teams match">
                Adjust the search, region, or eligibility filter to see teams.
              </DataState>
            ) : (
              <div className="tablewrap">
                <table className="grid gpr-grid">
                  <colgroup>
                    <col style={{ width: '88px' }} />
                    <col />
                    <col style={{ width: '128px' }} />
                    <col style={{ width: '128px' }} />
                    <col style={{ width: '56px' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <SortHeader label="Rank" columnKey="rank" sortKey={sortKey} descending={false} onSort={onSort} />
                      <th scope="col">Team</th>
                      <SortHeader label="Power Score" columnKey="rating" sortKey={sortKey} descending onSort={onSort} align="right" />
                      <SortHeader label="Win / Loss" columnKey="wins" sortKey={sortKey} descending onSort={onSort} align="right" />
                      <th scope="col" className="center" aria-label="Add to comparison" />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((team) => {
                      const key = teamKey(team)
                      const total = team.wins + team.losses
                      return (
                        <tr
                          key={key}
                          className={`gpr-row${pickedKeys.has(key) ? ' is-picked' : ''}`}
                          onClick={() => setDetailKey(key)}
                          tabIndex={0}
                          role="button"
                          aria-label={`View ${team.team} details`}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              setDetailKey(key)
                            }
                          }}
                        >
                          <td className="gpr-rankcell">
                            <span className={`gpr-rank${typeof team.rank === 'number' && team.rank <= 3 ? ' podium' : ''}`}>
                              {team.rank ?? '—'}
                            </span>
                            <Movement value={team.movement} />
                          </td>
                          <td>
                            <div className="team-cell">
                              <span className="team-mark sm">{team.code ?? team.team.slice(0, 3).toUpperCase()}</span>
                              <div className="ent">
                                <b>{team.team}</b>
                                <small>{teamSubtitle(team)}</small>
                              </div>
                            </div>
                          </td>
                          <td className="right">
                            <HeatChip value={team.rating} min={ratingMin} max={ratingMax} label={formatRating(team.rating)} />
                          </td>
                          <td className="right num">
                            <b className="record-main">{formatRecord(team.wins, team.losses)}</b>{' '}
                            <span className="record-ratio">{formatRatio(total > 0 ? team.wins / total : undefined)}</span>
                          </td>
                          <td className="center" onClick={(event) => event.stopPropagation()}>
                            <PickButton picked={pickedKeys.has(key)} onToggle={() => onToggle(team)} label={team.team} />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <aside className="gpr-sidebar">
          <RegionalStrengthPanel regions={regions} />
          <MethodologyPanel />
          <DataModelPanel model={model} data={dataSummary} />
        </aside>
      </div>

      <section className="panel compact-panel trajectory-panel">
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
                { value: 'rating', label: 'Power Score' },
                { value: 'rank', label: 'Rank' },
              ]}
              onChange={setMetric}
            />
            <span className="count">
              {pickedTeams.length > 0 ? `${chartSeries.length} selected` : 'Showing top 5 · pick teams above to focus'}
            </span>
          </div>
        </div>
        {!history ? (
          <p className="muted" style={{ padding: 20 }}>Loading rating history…</p>
        ) : (
          <LineChart
            series={chartSeries}
            height={300}
            yLabel={metric === 'rank' ? 'Rank' : 'Power Score'}
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
      </section>

      <Matchup standings={sorted} pickedTeams={pickedTeams} model={model} />

      {detailTeam ? (
        <TeamDetailModal
          team={detailTeam}
          series={history?.[teamKey(detailTeam)]}
          players={detailPlayers}
          onClose={() => setDetailKey(null)}
        />
      ) : null}
    </div>
  )
}

function Movement({ value }: { value?: number }) {
  if (!value || !Number.isFinite(value)) return <span className="gpr-move flat" aria-label="No change">–</span>
  if (value > 0) return <span className="gpr-move up" aria-label={`Up ${value}`}>▲{value}</span>
  return <span className="gpr-move down" aria-label={`Down ${Math.abs(value)}`}>▼{Math.abs(value)}</span>
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
  const clampedMax = Math.min(TEAM_ROW_LIMIT, axisMax)
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

function deriveDailyRankSeries(history: Record<string, TeamHistorySeries>) {
  const updatesByDay = new Map<string, { key: string; rating: number }[]>()
  for (const [key, series] of Object.entries(history)) {
    const dayCloseRatings = new Map<string, number>()
    for (const point of series.points) {
      const [date, rating] = point
      if (date && Number.isFinite(rating)) dayCloseRatings.set(date, rating)
    }
    for (const [date, rating] of dayCloseRatings) {
      const updates = updatesByDay.get(date) ?? []
      updates.push({ key, rating })
      updatesByDay.set(date, updates)
    }
  }

  const ratings = new Map<string, number>()
  const rankedSeries = new Map<string, { t: number; y: number }[]>()
  const days = [...updatesByDay.keys()].sort()
  for (const day of days) {
    for (const update of updatesByDay.get(day) ?? []) ratings.set(update.key, update.rating)
    const rankedKeys = [...ratings.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([key]) => key)
    const t = Date.parse(day)
    for (let index = 0; index < rankedKeys.length; index += 1) {
      const key = rankedKeys[index]
      const points = rankedSeries.get(key) ?? []
      points.push({ t, y: index + 1 })
      rankedSeries.set(key, points)
    }
  }
  return rankedSeries
}

function RegionalStrengthPanel({ regions }: { regions: RegionStrength[] }) {
  const ranked = useMemo(() => [...regions].sort((a, b) => b.score - a.score).slice(0, 8), [regions])
  if (ranked.length === 0) return null
  return (
    <section className="method-panel" aria-label="Regional strength score">
      <div className="method-list">
        <h3>Regional Strength Score</h3>
        <div className="region-strength-grid">
          {ranked.map((region) => (
            <div className="region-strength-cell" key={region.region}>
              <RegionBadge region={region.region} size="sm" />
              <span className="region-strength-name">{region.region}</span>
              <strong>{formatRating(region.score)}</strong>
            </div>
          ))}
        </div>
      </div>
      <p className="method-foot">Driven by match volume and international results.</p>
    </section>
  )
}

function DataModelPanel({ model, data }: { model?: Pick<ModelInfo, 'version' | 'configHash'>; data?: TeamDataSummary }) {
  const providers = [...(data?.sourceBreakdown ?? [])].sort((a, b) => b.matchCount - a.matchCount).slice(0, 3)
  const notes = (data?.notes ?? []).filter(Boolean).slice(0, 1)

  return (
    <section className="method-panel data-model-panel" aria-label="Data and model provenance">
      <h2>Data &amp; model</h2>
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
          <small>Config</small>
          <b>{model?.configHash ?? 'unknown'}</b>
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
      {data?.seeded ? (
        <p className="method-foot danger">Seeded sample data is active. Do not treat these rows as official rankings.</p>
      ) : notes.length > 0 ? (
        <p className="method-foot">{notes[0]}</p>
      ) : (
        <p className="method-foot">Latest match: {formatDate(data?.latestMatchDate)}</p>
      )}
    </section>
  )
}

function TeamDetailModal({
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
  const closeRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (activeElement && !activeElement.closest('.modal')) previousFocusRef.current = activeElement
    closeRef.current?.focus()
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const previousFocus = previousFocusRef.current
      window.setTimeout(() => {
        if (document.querySelector('.modal')) return
        if (previousFocus?.isConnected) previousFocus.focus()
        previousFocusRef.current = null
      }, 0)
    }
  }, [onClose])

  const trendSeries = useMemo<ChartSeries[]>(() => {
    if (!series || series.points.length < 2) return []
    return [{
      id: teamKey(team),
      label: team.code ?? team.team,
      color: 'var(--accent)',
      points: series.points.map((point) => ({ t: Date.parse(point[0]), y: point[1] })),
    }]
  }, [series, team])

  const totalGames = team.wins + team.losses
  const opponentFactor = Math.round((team.factors?.opponent ?? 0) * 100)
  const eventRows = (team.recentEvents ?? []).slice(0, 3)
  const trendSummary = useMemo(() => summarizeTeamTrend(series), [series])

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`${team.team} details`}>
      <div className="modal__scrim" onClick={onClose} />
      <div className="modal__panel">
        <div className="modal__head">
          <div className="team-dossier__identity">
            <span className="team-mark">{team.code ?? team.team.slice(0, 3).toUpperCase()}</span>
            <h2>{team.team}</h2>
          </div>
          <button ref={closeRef} type="button" className="modal__close" onClick={onClose} aria-label="Close">
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="modal__body">
          <section className="team-detail-hero" aria-label={`${team.team} summary`}>
            <div className="team-detail-hero__score">
              <span className="team-detail-hero__rank">#{team.rank}</span>
              <div>
                <strong>{formatRating(team.rating)}</strong>
                <small>Power score</small>
              </div>
            </div>
            <div className="team-detail-hero__facts">
              <span>
                <small>Record</small>
                <b>{formatRecord(team.wins, team.losses)} ({formatRatio(totalGames > 0 ? team.wins / totalGames : undefined)})</b>
              </span>
              <span>
                <small>Latest delta</small>
                <b>{formatSigned(team.delta)}</b>
              </span>
              <span>
                <small>Opponent factor</small>
                <b>{opponentFactor}%</b>
              </span>
            </div>
            <span className="team-dossier__league">
              <LeagueSigil league={team.league} />
              <b>{team.league}</b>
            </span>
          </section>

          <div className="team-detail-grid">
            <div className="gpr-card">
              <h3>Match Results</h3>
              <div className="stat-list">
                <StatRow
                  icon={<Swords size={25} />}
                  label="Win / Loss Record"
                  value={`${formatRecord(team.wins, team.losses)} (${formatRatio(totalGames > 0 ? team.wins / totalGames : undefined)})`}
                />
                <StatRow
                  icon={<Activity size={25} />}
                  label="Rating Movement"
                  detail="Latest model delta"
                  value={formatSigned(team.delta)}
                />
                <StatRow
                  icon={<Crosshair size={25} />}
                  label="Opponent Factor"
                  detail="Normalized model signal"
                  value={`${opponentFactor}%`}
                />
              </div>

              <RecentMatches matches={team.recentMatches} form={team.form} />

              <div className="event-list">
                <h4>International &amp; Regional Events</h4>
                {eventRows.length > 0 ? eventRows.map((event) => (
                  <div className="event-row" key={event}>
                    <LeagueSigil league={leagueCodeFromEventLabel(event)} fallbackLabel={event.slice(0, 1)} small />
                    <b>{event}</b>
                    <em>Recent</em>
                  </div>
                )) : (
                  <p className="muted">No recent event labels in this snapshot.</p>
                )}
              </div>

              <ComponentBreakdown team={team} />
            </div>

            <PlayerRankingCard team={team} players={players} />
          </div>

          <div className="gpr-card trend-card">
            <div className="trend-card__head">
              <div>
                <p className="eyebrow">Power trajectory</p>
                <h3>Ranking Trends</h3>
              </div>
              <span>Power Score</span>
            </div>
            {trendSummary ? (
              <div className="trend-summary" aria-label={`${team.team} trend summary`}>
                <TrendSummaryCell label="Opening" value={formatRating(trendSummary.opening)} detail={formatDate(trendSummary.startDate)} />
                <TrendSummaryCell label="Current" value={formatRating(trendSummary.current)} detail={formatDate(trendSummary.endDate)} />
                <TrendSummaryCell label="Net" value={formatSigned(trendSummary.netChange)} detail={`${trendSummary.pointCount} points`} />
                <TrendSummaryCell
                  label="Peak"
                  value={formatRating(trendSummary.peak.value)}
                  detail={typeof trendSummary.bestRank === 'number' ? `Best #${trendSummary.bestRank}` : formatDate(trendSummary.peak.date)}
                />
              </div>
            ) : null}
            {trendSeries.length > 0 ? (
              <div className="trend-card__plot">
                <LineChart series={trendSeries} height={340} yLabel="Power Score" />
              </div>
            ) : (
              <p className="muted" style={{ paddingTop: 16 }}>Not enough history to chart this team yet.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function RecentMatches({ matches, form }: { matches?: PublicRecentMatch[]; form?: string[] }) {
  const recentMatches = (matches ?? []).slice(-5).toReversed()

  return (
    <section className="recent-matches" aria-label="Recent form matches">
      <div className="recent-matches__head">
        <span><BarChart3 size={25} /></span>
        <div>
          <b>Recent Form</b>
          <small>Last 5 scored matches in this scope</small>
        </div>
        <FormDots form={form} />
      </div>

      {recentMatches.length > 0 ? (
        <div className="recent-match-list">
          {recentMatches.map((match, index) => (
            <div className="recent-match-row" key={`${match.date}-${match.event}-${match.opponent}-${index}`}>
              <span className={`result-chip ${match.result === 'W' ? 'w' : 'l'}`}>{match.result}</span>
              <div className="recent-match-row__main">
                <b>vs {match.opponent}</b>
                <small>{formatDate(match.date)} · {match.event}</small>
              </div>
              <div className="recent-match-row__rating">
                <strong>{formatRating(match.rating)}</strong>
                <small>{formatSigned(match.delta)}</small>
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
  const logo = LEAGUE_LOGOS[code]
  const className = `league-sigil${small ? ' small' : ''}${logo ? ' has-logo' : ''}`
  if (logo) {
    return (
      <span className={className}>
        <img src={logo} alt="" aria-hidden="true" />
      </span>
    )
  }
  return <span className={className}>{fallbackLabel ?? league.slice(0, 1)}</span>
}

function leagueCodeFromEventLabel(label: string) {
  return label.trim().split(/\s+/)[0] ?? ''
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

  return (
    <div className="gpr-card player-rank-card">
      <div className="player-rank-card__head">
        <div>
          <h3>Player Rankings</h3>
          <p>Individual rows for {team.code ?? team.team} in the current scope.</p>
        </div>
        {players.length > 0 ? <span className="count">{players.length} players</span> : null}
      </div>

      {players.length > 0 ? (
        <div className="player-rank-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Player</th>
                <th scope="col">Role</th>
                <th scope="col" className="right">Rating</th>
                <th scope="col" className="right">Team Games</th>
                <th scope="col">Form</th>
              </tr>
            </thead>
            <tbody>
              {players.map((player) => (
                <tr key={player.id}>
                  <td className={`rank-cell${player.rank <= 3 ? ' podium' : ''}`}>#{player.rank}</td>
                  <td>
                    <div className="ent">
                      <b>{player.name}</b>
                      <small>impact ×{formatDecimal(player.impactMultiplier)}</small>
                    </div>
                  </td>
                  <td>
                    <span className="role-pill">{player.role}</span>
                  </td>
                  <td className="right">
                    <HeatChip value={player.rating} min={ratingMin} max={ratingMax} label={formatRating(player.rating)} />
                  </td>
                  <td className="right num">{formatTeamGames(player)}</td>
                  <td>
                    <FormDots form={player.form} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted player-rank-card__empty">No sourced player rankings for this team in the current scope.</p>
      )}
    </div>
  )
}

function ComponentBreakdown({ team }: { team: RankingSummaryStanding }) {
  const components = team.ratingComponents
  if (!components) return null
  const componentRows = [
    { label: 'League Anchor', value: formatRating(components.leagueAnchor) },
    { label: 'Stable Offset', value: formatSigned(components.teamStableOffset) },
    { label: 'Roster Prior', value: formatSigned(components.rosterPriorOffset) },
    { label: 'Momentum', value: formatSigned(components.momentum) },
    { label: 'Context', value: formatSigned(components.contextAdjustment) },
    { label: 'Uncertainty', value: `±${formatRating(components.uncertainty)}` },
  ]
  const update = team.ratingUpdate
  const updateRows = update ? [
    { label: 'Stable', value: formatSigned(update.teamStableDelta) },
    { label: 'League Game', value: formatSigned(update.leagueGameDelta) },
    { label: 'Placement', value: formatSigned(update.leaguePlacementDelta) },
    { label: 'Momentum', value: formatSigned(update.momentumDelta) },
  ] : []

  return (
    <div className="component-breakdown" aria-label={`${team.team} rating components`}>
      <div className="component-breakdown__head">
        <h4>Power Components</h4>
        <span>{formatRating(team.rating)}</span>
      </div>
      <div className="component-grid">
        {componentRows.map((row) => (
          <span key={row.label}>
            <small>{row.label}</small>
            <b>{row.value}</b>
          </span>
        ))}
      </div>
      {updateRows.length > 0 ? (
        <div className="update-ledger">
          {updateRows.map((row) => (
            <span key={row.label}>
              <small>{row.label}</small>
              <b>{row.value}</b>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function StatRow({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail?: string }) {
  return (
    <div className="stat-row">
      <span>{icon}</span>
      <div>
        <b>{label}</b>
        {detail ? <small>{detail}</small> : null}
      </div>
      <strong>{value}</strong>
    </div>
  )
}

function MethodologyPanel() {
  const rows = rankingTargetExplanations.slice(0, 4)
  return (
    <section className="method-panel" aria-label="Global power ranking methodology">
      <h2>What are Global Power Rankings?</h2>
      <p>GPR is a model view of team strength. It combines transparent result, opponent, roster, and validation signals.</p>
      <div className="method-list">
        <h3>Team Performance</h3>
        {rows.map((row, index) => (
          <div className="method-row" key={row.target}>
            <span>{methodIcon(index)}</span>
            <div>
              <b>{row.label}</b>
              <small>{row.description}</small>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function methodIcon(index: number) {
  const icons = [<Trophy size={22} />, <BarChart3 size={22} />, <Activity size={22} />, <Crosshair size={22} />]
  return icons[index] ?? <Activity size={22} />
}

function sortStandings(rows: RankingSummaryStanding[], key: SortKey) {
  const copy = [...rows]
  switch (key) {
    case 'rating':
      return copy.sort((a, b) => compareRankedBoardEligibility(a, b) || (b.rating ?? 0) - (a.rating ?? 0) || compareRank(a, b))
    case 'wins':
      return copy.sort((a, b) => compareRankedBoardEligibility(a, b) || (b.wins ?? 0) - (a.wins ?? 0) || compareRank(a, b))
    default:
      return copy.sort(compareRank)
  }
}

function compareRankedBoardEligibility(a: RankingSummaryStanding, b: RankingSummaryStanding) {
  return Number(b.eligibility?.eligible ?? true) - Number(a.eligibility?.eligible ?? true)
}

function compareRank(a: RankingSummaryStanding, b: RankingSummaryStanding) {
  return (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)
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

function Matchup({
  standings,
  pickedTeams,
  model,
}: {
  standings: RankingSummaryStanding[]
  pickedTeams: RankingSummaryStanding[]
  model?: Pick<ModelInfo, 'version' | 'configHash'>
}) {
  const options = useMemo(() => standings.slice(0, 200), [standings])
  const optionKeys = useMemo(() => new Set(options.map(teamKey)), [options])
  const seedKeys = useMemo(() => {
    const picked = pickedTeams.map(teamKey).filter((key) => optionKeys.has(key))
    const first = picked[0] ?? (options[0] ? teamKey(options[0]) : '')
    const second = picked.find((key) => key !== first) ?? options.map(teamKey).find((key) => key !== first) ?? ''
    return { a: first, b: second }
  }, [optionKeys, options, pickedTeams])
  const [aKey, setAKey] = useState('')
  const [bKey, setBKey] = useState('')

  const selectedAKey = optionKeys.has(aKey) ? aKey : seedKeys.a
  const selectedBKey = optionKeys.has(bKey) && bKey !== selectedAKey
    ? bKey
    : seedKeys.b !== selectedAKey
      ? seedKeys.b
      : options.map(teamKey).find((key) => key !== selectedAKey) ?? ''
  const a = options.find((team) => teamKey(team) === selectedAKey) ?? options[0]
  const b = options.find((team) => teamKey(team) === selectedBKey) ?? options.find((team) => team !== a)
  const matchup = a && b && a !== b ? estimatePublicMatchup(a, b, model) : undefined

  if (options.length < 2) return null

  const homePct = matchup ? Math.round(matchup.homeWinProbability * 100) : 0
  const awayPct = matchup ? 100 - homePct : 0
  const favorite = matchup ? (homePct >= awayPct ? matchup.home : matchup.away) : undefined
  const seedNote = aKey || bKey
    ? 'Custom matchup'
    : pickedTeams.length >= 2
      ? 'Seeded from selected teams'
      : 'Defaulting to current top two'

  function replacementKey(exclude: string) {
    return options.map(teamKey).find((key) => key !== exclude) ?? ''
  }

  function onSelectA(nextKey: string) {
    setAKey(nextKey)
    if (nextKey === selectedBKey) setBKey(replacementKey(nextKey))
  }

  function onSelectB(nextKey: string) {
    setBKey(nextKey)
    if (nextKey === selectedAKey) setAKey(replacementKey(nextKey))
  }

  function onSwap() {
    setAKey(selectedBKey)
    setBKey(selectedAKey)
  }

  return (
    <section className="panel matchup-panel">
      <div className="panel__head matchup-panel__head">
        <div className="panel__title">
          <p className="eyebrow">Estimator</p>
          <h2>Head-to-head matchup</h2>
          <p className="panel__hint">Neutral single-game forecast from published team score and uncertainty.</p>
        </div>
        <span className="count">{seedNote}</span>
      </div>
      <div className="matchup">
        <div className="matchup__picks">
          <label className="field">
            <span>Team A</span>
            <select value={selectedAKey} onChange={(event) => onSelectA(event.target.value)}>
              {options.map((team) => (
                <option key={teamKey(team)} value={teamKey(team)}>
                  {team.rank ? `#${team.rank} ` : ''}
                  {team.team}
                </option>
              ))}
            </select>
          </label>
          <button className="matchup__swap" type="button" onClick={onSwap} aria-label="Swap matchup teams">
            <ArrowLeftRight size={16} aria-hidden="true" />
          </button>
          <label className="field">
            <span>Team B</span>
            <select value={selectedBKey} onChange={(event) => onSelectB(event.target.value)}>
              {options.map((team) => (
                <option key={teamKey(team)} value={teamKey(team)}>
                  {team.rank ? `#${team.rank} ` : ''}
                  {team.team}
                </option>
              ))}
            </select>
          </label>
        </div>

        {matchup ? (
          <>
            <div className="matchup__stage">
              <MatchupTeamCard team={matchup.home} probability={homePct} label="Team A" />
              <div className="matchup__versus" aria-hidden="true">
                <Swords size={18} />
                <span>vs</span>
              </div>
              <MatchupTeamCard team={matchup.away} probability={awayPct} label="Team B" align="right" />
            </div>
            <div className="matchup__probability">
              <span>{homePct}%</span>
              <div className="oddsbar" aria-label={`${matchup.home.team} ${homePct} percent, ${matchup.away.team} ${awayPct} percent`}>
                <i style={{ width: `${homePct}%` }} />
                <span className="oddsbar__midline" />
              </div>
              <span>{awayPct}%</span>
            </div>
            <div className="matchup__facts">
              <span>
                <small>Favorite</small>
                <b>{favorite?.team}</b>
              </span>
              <span>
                <small>Rating edge</small>
                <b>{formatSigned(matchup.ratingEdge)}</b>
              </span>
              <span>
                <small>Model</small>
                <b>{matchup.modelVersion}</b>
              </span>
            </div>
            <p className="matchup__note">
              Probability is model-derived and assumes neutral court, current roster state, and the same score source as the table above.
            </p>
          </>
        ) : (
          <p className="muted">Pick two different teams to estimate the matchup.</p>
        )}
      </div>
    </section>
  )
}

function MatchupTeamCard({
  team,
  probability,
  label,
  align = 'left',
}: {
  team: RankingSummaryStanding
  probability: number
  label: string
  align?: 'left' | 'right'
}) {
  const total = team.wins + team.losses
  return (
    <article className={`matchup-team${align === 'right' ? ' is-away' : ''}`}>
      <div className="matchup-team__identity">
        <span className="team-mark">{team.code ?? team.team.slice(0, 3).toUpperCase()}</span>
        <div>
          <small>{label}</small>
          <b>{team.team}</b>
          <em>{team.league ?? team.region}</em>
        </div>
      </div>
      <strong className="matchup-team__probability">{probability}%</strong>
      <div className="matchup-team__metrics">
        <span>
          <small>Rank</small>
          <b>{team.rank ? `#${team.rank}` : '—'}</b>
        </span>
        <span>
          <small>Power</small>
          <b>{formatRating(team.rating)}</b>
        </span>
        <span>
          <small>Record</small>
          <b>{formatRecord(team.wins, team.losses)} {formatRatio(total > 0 ? team.wins / total : undefined)}</b>
        </span>
        <span>
          <small>Uncertainty</small>
          <b>±{formatRating(team.uncertainty)}</b>
        </span>
      </div>
    </article>
  )
}
