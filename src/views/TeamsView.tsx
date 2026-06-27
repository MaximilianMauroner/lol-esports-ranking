import { useEffect, useMemo, useState } from 'react'
import { Activity, BarChart3, Crosshair, Swords, Trophy, Users, X } from 'lucide-react'
import type { ModelInfo, RankingSummaryStanding, TeamHistorySeries } from '../lib/snapshot'
import type { RegionStrength } from '../lib/regionStrength'
import { estimatePublicMatchup } from '../lib/publicMatchup'
import { rankingTargetExplanations } from '../lib/rankingExplanations'
import { extent, formatDate, formatDateRange, formatNumber, formatRating, formatRatio, formatRecord, formatSigned, teamKey } from '../lib/display'
import { deriveTrajectoryInsight, type TrajectoryInsight } from '../lib/trajectory'
import { DataState, FormDots, HeatChip, PickButton, Segmented, SortHeader } from '../components/ui'
import { LineChart, type ChartSeries } from '../components/LineChart'

type SortKey = 'rank' | 'rating' | 'wins'
type TrajectoryMetric = 'rating' | 'rank'
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

export function TeamsView({
  standings,
  regions,
  model,
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
  search: string
  pickedTeams: RankingSummaryStanding[]
  history?: Record<string, TeamHistorySeries>
  updatedAt?: string
  dataSummary?: TeamDataSummary
  onToggle: (team: RankingSummaryStanding) => void
}) {
  const [region, setRegion] = useState('All')
  const [sortKey, setSortKey] = useState<SortKey>('rank')
  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [metric, setMetric] = useState<TrajectoryMetric>('rating')

  const pickedKeys = useMemo(() => new Set(pickedTeams.map(teamKey)), [pickedTeams])

  const regionOptions = useMemo(
    () => ['All', ...Array.from(new Set(standings.map((team) => team.region).filter(Boolean))).sort()],
    [standings],
  )

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return standings.filter((team) => {
      if (region !== 'All' && team.region !== region) return false
      if (!query) return true
      return [team.team, team.code, team.region, team.league].some((value) => value?.toLowerCase().includes(query))
    })
  }, [standings, region, search])

  const sorted = useMemo(() => sortStandings(filtered, sortKey), [filtered, sortKey])
  const visible = sorted.slice(0, TEAM_ROW_LIMIT)
  const [ratingMin, ratingMax] = useMemo(() => extent(filtered.map((team) => team.rating)), [filtered])

  const detailTeam = useMemo(
    () => (detailKey ? standings.find((team) => teamKey(team) === detailKey) : undefined),
    [detailKey, standings],
  )

  const focusTeams = pickedTeams.length > 0 ? pickedTeams : sorted.slice(0, 5)
  const chartSeries = useMemo<ChartSeries[]>(() => {
    if (!history) return []
    return focusTeams
      .map((team, index): ChartSeries | null => {
        const series = history[teamKey(team)]
        if (!series || series.points.length < 2) return null
        // Collapse to one point per day (the day's closing value) so the lines
        // read as a trend instead of intraday churn — important for the rank view.
        const byDay = new Map<string, (typeof series.points)[number]>()
        for (const point of series.points) byDay.set(point[0], point)
        const daily = [...byDay.values()].filter((point) => metric === 'rating' || (Number.isFinite(point[2]) && point[2] > 0))
        return {
          id: teamKey(team),
          label: team.code ?? team.team,
          color: SERIES_COLORS[index % SERIES_COLORS.length],
          // Rank is plotted as -rank so a better (lower) rank sits higher on the axis.
          points: daily.map((point) => ({
            t: Date.parse(point[0]),
            y: metric === 'rank' ? -point[2] : point[1],
          })),
        }
      })
      .filter((series): series is ChartSeries => series !== null)
  }, [focusTeams, history, metric])

  const rankDomain = useMemo(() => {
    if (metric !== 'rank') return undefined
    const ranks = chartSeries.flatMap((series) => series.points.map((point) => Math.abs(point.y))).filter((rank) => rank >= 1)
    if (ranks.length === 0) return undefined
    return { min: -Math.max(...ranks), max: -Math.min(...ranks) }
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
                <label className="field" style={{ gridAutoFlow: 'column', alignItems: 'center', gap: 8 }}>
                  <span>Region</span>
                  <select value={region} onChange={(event) => setRegion(event.target.value)}>
                    {regionOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="count">
                  {visible.length} of {filtered.length}
                </span>
              </div>
            </div>

            {visible.length === 0 ? (
              <DataState icon={<Users size={26} aria-hidden="true" />} title="No teams match">
                Adjust the search or region filter to see ranked teams.
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
                                <small>{team.league ?? team.region}</small>
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
          <MethodologyPanel />
          <DataModelPanel model={model} data={dataSummary} />
          <RegionalStrengthPanel regions={regions} />
        </aside>
      </div>

      <section className="panel compact-panel">
        <div className="panel__head">
          <div>
            <p className="eyebrow">Over time</p>
            <h2>How the race changed</h2>
          </div>
          <Segmented
            value={metric}
            options={[
              { value: 'rating', label: 'Power Score' },
              { value: 'rank', label: 'Rank' },
            ]}
            onChange={setMetric}
          />
          <span className="count spacer" style={{ marginLeft: 'auto' }}>
            {pickedTeams.length > 0 ? `${chartSeries.length} selected` : 'Top 5 — add teams to focus'}
          </span>
        </div>
        {!history ? (
          <p className="muted" style={{ padding: 20 }}>Loading rating history…</p>
        ) : (
          <LineChart
            series={chartSeries}
            height={300}
            yLabel={metric === 'rank' ? 'Rank' : 'Power Score'}
            yFormat={metric === 'rank' ? (value) => `#${Math.abs(Math.round(value))}` : undefined}
            yDomain={rankDomain}
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

      <Matchup standings={sorted} model={model} />

      {detailTeam ? (
        <TeamDetailModal
          team={detailTeam}
          series={history?.[teamKey(detailTeam)]}
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
              <span className="league-sigil small">{String(region.region).slice(0, 1)}</span>
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
    <section className="method-panel" aria-label="Data and model provenance">
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
  onClose,
}: {
  team: RankingSummaryStanding
  series?: TeamHistorySeries
  onClose: () => void
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`${team.team} details`}>
      <div className="modal__scrim" onClick={onClose} />
      <div className="modal__panel">
        <div className="modal__head">
          <div className="team-dossier__identity">
            <span className="team-mark">{team.code ?? team.team.slice(0, 3).toUpperCase()}</span>
            <h2>{team.team}</h2>
          </div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="modal__body">
          <div className="team-dossier__rank">
            <strong>#{team.rank}</strong>
            <span>{formatRating(team.rating)} points</span>
            <span className="team-dossier__league">
              <span className="league-sigil">{team.league.slice(0, 1)}</span>
              <b>{team.league}</b>
            </span>
          </div>

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
              <div className="stat-row">
                <span><BarChart3 size={25} /></span>
                <div>
                  <b>Recent Form</b>
                  <small>Last 5 series</small>
                </div>
                <FormDots form={team.form} />
              </div>
            </div>

            <div className="event-list">
              <h4>International &amp; Regional Events</h4>
              {eventRows.length > 0 ? eventRows.map((event) => (
                <div className="event-row" key={event}>
                  <span className="league-sigil small">{event.slice(0, 1)}</span>
                  <b>{event}</b>
                  <em>Recent</em>
                </div>
              )) : (
                <p className="muted">No recent event labels in this snapshot.</p>
              )}
            </div>

            <ComponentBreakdown team={team} />
          </div>

          <div className="gpr-card trend-card">
            <div className="trend-card__head">
              <h3>Ranking Trends</h3>
              <span>Power Score</span>
            </div>
            {trendSeries.length > 0 ? (
              <LineChart series={trendSeries} height={260} yLabel="Power Score" />
            ) : (
              <p className="muted" style={{ paddingTop: 16 }}>Not enough history to chart this team yet.</p>
            )}
          </div>
        </div>
      </div>
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
      return copy.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    case 'wins':
      return copy.sort((a, b) => (b.wins ?? 0) - (a.wins ?? 0))
    default:
      return copy.sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
  }
}

function Matchup({
  standings,
  model,
}: {
  standings: RankingSummaryStanding[]
  model?: Pick<ModelInfo, 'version' | 'configHash'>
}) {
  const options = useMemo(() => standings.slice(0, 200), [standings])
  const [aKey, setAKey] = useState('')
  const [bKey, setBKey] = useState('')

  const a = options.find((team) => teamKey(team) === aKey) ?? options[0]
  const b = options.find((team) => teamKey(team) === bKey) ?? options[1]
  const matchup = a && b && a !== b ? estimatePublicMatchup(a, b, model) : undefined

  if (options.length < 2) return null

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <p className="eyebrow">Estimator</p>
          <h2>Head-to-head matchup</h2>
        </div>
        <Swords size={18} aria-hidden="true" />
      </div>
      <div className="matchup">
        <div className="matchup__picks">
          <label className="field">
            <span>Team A</span>
            <select value={teamKey(a)} onChange={(event) => setAKey(event.target.value)}>
              {options.map((team) => (
                <option key={teamKey(team)} value={teamKey(team)}>
                  {team.rank ? `#${team.rank} ` : ''}
                  {team.team}
                </option>
              ))}
            </select>
          </label>
          <span className="vs">vs</span>
          <label className="field">
            <span>Team B</span>
            <select value={teamKey(b)} onChange={(event) => setBKey(event.target.value)}>
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
            <div className="matchup__odds">
              <div className="side">
                <span>{matchup.home.team}</span>
                <strong>{Math.round(matchup.homeWinProbability * 100)}%</strong>
              </div>
              <div className="pct-edge">Rating edge {formatSigned(matchup.ratingEdge)}</div>
              <div className="side b">
                <span>{matchup.away.team}</span>
                <strong>{Math.round((1 - matchup.homeWinProbability) * 100)}%</strong>
              </div>
            </div>
            <div className="oddsbar" aria-hidden="true">
              <i style={{ width: `${Math.round(matchup.homeWinProbability * 100)}%` }} />
            </div>
            <p className="matchup__note">
              Neutral-court single-game probability from the published rating gap and each team's uncertainty. Model{' '}
              {matchup.modelVersion}.
            </p>
          </>
        ) : (
          <p className="muted">Pick two different teams to estimate the matchup.</p>
        )}
      </div>
    </section>
  )
}
