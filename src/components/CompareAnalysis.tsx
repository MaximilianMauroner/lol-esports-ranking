import { useMemo, type CSSProperties } from 'react'
import type {
  PublicRegionHistoryPoint,
  PublicRegionHistoryScope,
  PublicTeamHistoryDirectory as TeamHistoryDirectory,
  PublicTeamHistoryPoint,
  PublicTeamHistoryShard,
  PublicTeamStanding as RankingSummaryStanding,
} from '../lib/publicArtifacts/schema'
import { formatDate, formatModelVersion, formatRating, teamKey } from '../lib/display'
import { isRegionPowerTeam, type RegionStrength } from '../lib/regionStrength'
import type { CompareColumn } from './CompareDrawer'
import {
  REGION_PROFILE_METRICS,
  TEAM_PROFILE_METRICS,
  type CompareProfileMetric,
  regionKey,
} from './compareAnalysisData'
import { LineChart, type ChartSeries } from './LineChart'
import { TeamHistoryLineChart } from './TeamHistoryLineChart'
import { dailyChartPointsFromHistoryPoints } from '../lib/teamHistoryChart'
import type { RegionHistoryScopeState, TeamHistoryArtifactState } from '../hooks/usePublicArtifacts'

const REGION_TREND_TEAM_LIMIT = 5
const REGION_TREND_EVENT_LIMIT = 8
const COMPARE_SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)']
type TeamHistoryLike = TeamHistoryDirectory | PublicTeamHistoryShard

type RegionTrendEvent = {
  id: string
  region: string
  regionColor: string
  date: string
  team: string
  opponent?: string
  event?: string
  tier?: string
  result?: 'W' | 'L'
  wins?: number
  losses?: number
  games?: number
  bestOf?: number
  delta?: number
  rating: number
  source?: string
}

export function RegionCompareAnalysis({
  regions,
  columns,
  standings,
  historyState,
  regionHistoryState,
  regionHistory,
}: {
  regions: RegionStrength[]
  columns: CompareColumn[]
  standings: RankingSummaryStanding[]
  historyState: TeamHistoryArtifactState
  regionHistoryState: RegionHistoryScopeState
  regionHistory?: PublicRegionHistoryScope
}) {
  return (
    <>
      <CompareProfileChart title="Region power profile" eyebrow="Current scope" entities={regions} columns={columns} metrics={REGION_PROFILE_METRICS} />
      <RegionTrendChart regions={regions} standings={standings} historyState={historyState} regionHistoryState={regionHistoryState} regionHistory={regionHistory} />
    </>
  )
}

export function TeamCompareAnalysis({
  teams,
  columns,
  historyState,
}: {
  teams: RankingSummaryStanding[]
  columns: CompareColumn[]
  historyState: TeamHistoryArtifactState
}) {
  return (
    <>
      <CompareProfileChart title="Team profile" eyebrow="Current scope" entities={teams} columns={columns} metrics={TEAM_PROFILE_METRICS} />
      <TeamCompareChart teams={teams} historyState={historyState} />
    </>
  )
}

export function CompareProfileChart<E>({
  title,
  eyebrow,
  entities,
  columns,
  metrics,
}: {
  title: string
  eyebrow: string
  entities: E[]
  columns: CompareColumn[]
  metrics: CompareProfileMetric<E>[]
}) {
  if (entities.length < 2) {
    return (
      <section className="compare-chart compare-profile" aria-label={title}>
        <p className="muted compare-chart__empty">Add at least two entries to compare their profile.</p>
      </section>
    )
  }

  return (
    <section className="compare-chart compare-profile" aria-label={title}>
      <div className="compare-chart__head">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h3>{title}</h3>
        </div>
        <span className="compare-chart__meta">{entities.length} selected</span>
      </div>
      <div className="profile-chart">
        {metrics.map((metric) => {
          const values = entities.map(metric.value)
          const best = bestProfileIds(values, columns, metric.better)
          return (
            <div className="profile-row" key={metric.key}>
              <div className="profile-row__label">
                <span>{metric.label}</span>
              </div>
              <div className="profile-bars">
                {entities.map((entity, index) => {
                  const value = metric.value(entity)
                  const color = COMPARE_SERIES_COLORS[index % COMPARE_SERIES_COLORS.length]
                  const percent = profilePercent(value, values, metric.better)
                  const isBest = best.has(columns[index].id)
                  return (
                    <div className={`profile-bar${isBest ? ' is-best' : ''}`} key={columns[index].id}>
                      <span className="profile-bar__name">
                        <i style={{ background: color }} aria-hidden="true" />
                        {columns[index].name}
                      </span>
                      <span className="profile-bar__track" aria-hidden="true">
                        <span className="profile-bar__fill" style={{ width: `${percent}%`, background: color } as CSSProperties} />
                      </span>
                      <strong>{metric.format(value)}</strong>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function bestProfileIds(values: (number | undefined)[], columns: CompareColumn[], better: 'high' | 'low' = 'high') {
  const valid = values
    .map((value, index) => ({ id: columns[index].id, value }))
    .filter((entry): entry is { id: string; value: number } => typeof entry.value === 'number' && Number.isFinite(entry.value))
  const ids = new Set<string>()
  if (valid.length < 2) return ids
  const target = better === 'low' ? Math.min(...valid.map((entry) => entry.value)) : Math.max(...valid.map((entry) => entry.value))
  for (const entry of valid) {
    if (entry.value === target) ids.add(entry.id)
  }
  return ids
}

function profilePercent(value: number | undefined, values: (number | undefined)[], better: 'high' | 'low' = 'high') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const valid = values.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
  if (valid.length < 2) return 100
  const min = Math.min(...valid)
  const max = Math.max(...valid)
  if (max <= min) return 100
  const raw = better === 'low' ? (max - value) / (max - min) : (value - min) / (max - min)
  return Math.max(6, Math.min(100, Math.round(raw * 100)))
}

function RegionTrendChart({
  regions,
  standings,
  historyState,
  regionHistoryState,
  regionHistory,
}: {
  regions: RegionStrength[]
  standings: RankingSummaryStanding[]
  historyState: TeamHistoryArtifactState
  regionHistoryState: RegionHistoryScopeState
  regionHistory?: PublicRegionHistoryScope
}) {
  const history = historyState.status === 'ready' ? historyState.data : undefined
  const trend = useMemo(() => {
    if (regionHistory) return regionHistoryTrend(regions, regionHistory)
    if (!history) return []
    return regions
      .map((region, index): { series: ChartSeries; events: RegionTrendEvent[] } | null => {
        const color = COMPARE_SERIES_COLORS[index % COMPARE_SERIES_COLORS.length]
        const teams = selectRegionTrendTeams(region, standings, history)
        const points = aggregateRegionTrend(teams, history)
        if (points.length < 2) return null
        return {
          series: {
            id: regionKey(region),
            label: region.region,
            color,
            points,
          },
          events: collectRegionTrendEvents(region, teams, history, color),
        }
      })
      .filter((entry): entry is { series: ChartSeries; events: RegionTrendEvent[] } => entry !== null)
  }, [history, regionHistory, regions, standings])
  const series = useMemo(() => trend.map((entry) => entry.series), [trend])
  const fallbackNote = !regionHistory && history ? regionHistoryFallbackNote(regionHistoryState) : undefined
  const events = useMemo(
    () =>
      trend
        .flatMap((entry) => entry.events)
        .sort((left, right) => {
          const byMagnitude = Math.abs(right.delta ?? 0) - Math.abs(left.delta ?? 0)
          return byMagnitude !== 0 ? byMagnitude : right.date.localeCompare(left.date)
        })
        .slice(0, REGION_TREND_EVENT_LIMIT),
    [trend],
  )

  return (
    <section className="compare-chart" aria-label="Compared region strength trend">
      <div className="compare-chart__head">
        <div>
          <p className="eyebrow">Over time</p>
          <h3>Region power trend</h3>
        </div>
        {regionHistory ? (
          <span className="compare-chart__meta">
            International league-strength history · {regionHistory.regionCount} regions
          </span>
        ) : history ? (
          <span className="compare-chart__meta">
            Derived top-team average · Model {formatModelVersion(history.modelVersion)} · {formatDate(history.generatedAt)}
          </span>
        ) : null}
      </div>
      {fallbackNote ? <p className="compare-chart__note muted">{fallbackNote}</p> : null}
      {!regionHistory && historyState.status === 'loading' ? (
        <p className="muted compare-chart__empty">Loading history…</p>
      ) : !regionHistory && (historyState.status === 'missing' || historyState.status === 'error') ? (
        <p className="muted compare-chart__empty">{historyState.message}</p>
      ) : series.length > 0 ? (
        <>
          <LineChart series={series} height={300} yLabel={regionHistory ? 'Region power score' : 'Avg team power score'} yFormat={formatRating} />
          <RegionTrendEvents events={events} />
        </>
      ) : (
        <p className="muted compare-chart__empty">Not enough tracked team history to plot the selected regions yet.</p>
      )}
    </section>
  )
}

function regionHistoryFallbackNote(state: RegionHistoryScopeState) {
  if (state.status === 'loading') return 'Region history is still loading; this chart is temporarily derived from the current top-team average.'
  if (state.status === 'missing' || state.status === 'error') return `${state.message} Showing a derived top-team average instead.`
  return undefined
}

function regionHistoryTrend(regions: RegionStrength[], history: PublicRegionHistoryScope) {
  return regions
    .map((region, index): { series: ChartSeries; events: RegionTrendEvent[] } | null => {
      const regionSeries = history.series[region.region]
      if (!regionSeries || regionSeries.points.length < 2) return null
      const color = COMPARE_SERIES_COLORS[index % COMPARE_SERIES_COLORS.length]
      return {
        series: {
          id: regionKey(region),
          label: region.region,
          color,
          points: regionSeries.points
            .map((point) => ({ t: Date.parse(point[0]), y: point[1] }))
            .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.y)),
        },
        events: collectRegionHistoryEvents(region, regionSeries.points, color),
      }
    })
    .filter((entry): entry is { series: ChartSeries; events: RegionTrendEvent[] } => entry !== null)
}

function RegionTrendEvents({ events }: { events: RegionTrendEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="muted region-events__empty">
        Movement drivers are unavailable for this artifact. Regenerate team history to include event-level point metadata.
      </p>
    )
  }

  return (
    <div className="region-events" aria-label="Largest derived region trend movement drivers">
      <div className="region-events__head">
        <span>Largest derived moves</span>
        <small>Team-history points behind the regional average</small>
      </div>
      <div className="region-events__list">
        {events.map((event) => (
          <article className="region-event" key={event.id}>
            <div className="region-event__top">
              <span className="region-event__region">
                <i style={{ background: event.regionColor }} aria-hidden="true" />
                {event.region}
              </span>
              <time dateTime={event.date}>{formatDate(event.date)}</time>
              <strong className={`region-event__delta ${deltaClass(event.delta)}`}>{formatSignedRating(event.delta)}</strong>
            </div>
            <div className="region-event__main">
              <b>{event.team}</b>
              {event.opponent ? <span>vs {event.opponent}</span> : null}
              {formatRegionTrendMatchScore(event) ? <em>{formatRegionTrendMatchScore(event)}</em> : null}
            </div>
            <div className="region-event__meta">
              <span>{event.event ?? 'Unknown event'}</span>
              {event.tier ? <span>{formatTierLabel(event.tier)}</span> : null}
              <span>{formatRating(event.rating)}</span>
              {event.source ? <span>{event.source}</span> : null}
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}

function collectRegionHistoryEvents(
  region: RegionStrength,
  points: PublicRegionHistoryPoint[],
  regionColor: string,
) {
  const events: RegionTrendEvent[] = []
  let previous: PublicRegionHistoryPoint | undefined
  for (const point of points) {
    const context = point[3]
    const delta = previous ? Number((point[1] - previous[1]).toFixed(1)) : undefined
    previous = point
    if (typeof delta !== 'number' || !Number.isFinite(delta) || Math.abs(delta) < 0.5) continue
    events.push({
      id: `${region.region}-${point[0]}-${context?.event ?? 'region-history'}-${point[1]}`,
      region: region.region,
      regionColor,
      date: point[0],
      team: context?.leagues?.join(', ') ?? region.region,
      opponent: context?.opponentRegions?.join(', '),
      event: context?.event,
      tier: context?.tier,
      wins: context?.wins,
      losses: context?.losses,
      delta,
      rating: point[1],
      source: context?.source,
    })
  }
  return events
}

function selectRegionTrendTeams(region: RegionStrength, standings: RankingSummaryStanding[], history: TeamHistoryLike) {
  const topTeamNames = new Set(region.topTeams.map((team) => team.team))
  const topTeamCodes = new Set(region.topTeams.map((team) => team.code).filter((code): code is string => Boolean(code)))
  const regionTeams = standings
    .filter((team) => isRegionPowerTeam(region, team) && Boolean(history.series[teamKey(team)]))
    .sort((left, right) => (right.rating ?? 0) - (left.rating ?? 0))
  const preferred = regionTeams.filter((team) => topTeamNames.has(team.team) || (team.code ? topTeamCodes.has(team.code) : false))
  const candidates = preferred.length > 0 ? preferred : regionTeams
  return candidates.slice(0, REGION_TREND_TEAM_LIMIT)
}

function aggregateRegionTrend(teams: RankingSummaryStanding[], history: TeamHistoryLike) {
  const entries = teams
    .map((team) => {
      const series = history.series[teamKey(team)]
      if (!series) return null
      const byDay = new Map<string, number>()
      for (const point of series.points) {
        if (Number.isFinite(point[1])) byDay.set(point[0], point[1])
      }
      return { id: teamKey(team), byDay }
    })
    .filter((entry): entry is { id: string; byDay: Map<string, number> } => entry !== null && entry.byDay.size > 1)

  if (entries.length === 0) return []

  const dates = Array.from(new Set(entries.flatMap((entry) => Array.from(entry.byDay.keys())))).sort()
  const latest = new Map<string, number>()
  const minimumActiveTeams = Math.min(2, entries.length)
  const points: ChartSeries['points'] = []

  for (const date of dates) {
    for (const entry of entries) {
      const value = entry.byDay.get(date)
      if (typeof value === 'number' && Number.isFinite(value)) latest.set(entry.id, value)
    }
    if (latest.size < minimumActiveTeams) continue
    const timestamp = Date.parse(date)
    if (!Number.isFinite(timestamp)) continue
    const values = Array.from(latest.values())
    points.push({
      t: timestamp,
      y: values.reduce((total, value) => total + value, 0) / values.length,
    })
  }

  return points
}

function collectRegionTrendEvents(
  region: RegionStrength,
  teams: RankingSummaryStanding[],
  history: TeamHistoryLike,
  regionColor: string,
) {
  const events: RegionTrendEvent[] = []

  for (const team of teams) {
    const teamSeries = history.series[teamKey(team)]
    if (!teamSeries) continue
    const latestByDay = new Map<string, PublicTeamHistoryPoint>()
    for (const point of teamSeries.points) latestByDay.set(point[0], point)
    for (const point of latestByDay.values()) {
      const context = point[3]
      const delta = context?.delta
      if (typeof delta !== 'number' || !Number.isFinite(delta) || Math.abs(delta) < 0.5) continue
      events.push({
        id: `${region.region}-${teamKey(team)}-${point[0]}-${context?.event ?? 'event'}-${context?.opponent ?? 'opponent'}`,
        region: region.region,
        regionColor,
        date: point[0],
        team: team.code ?? team.team,
        opponent: context?.opponent,
        event: context?.event,
        tier: context?.tier,
        result: context?.result,
        wins: context?.wins,
        losses: context?.losses,
        games: context?.games,
        bestOf: context?.bestOf,
        delta,
        rating: point[1],
        source: formatSource(context),
      })
    }
  }

  return events
}

function TeamCompareChart({
  teams,
  historyState,
}: {
  teams: RankingSummaryStanding[]
  historyState: TeamHistoryArtifactState
}) {
  const history = historyState.status === 'ready' ? historyState.data : undefined
  const series = useMemo<ChartSeries[]>(() => {
    if (!history) return []
    return teams
      .map((team, index): ChartSeries | null => {
        const teamSeries = history.series[teamKey(team)]
        if (!teamSeries || teamSeries.points.length < 2) return null
        const points = dailyChartPointsFromHistoryPoints(teamSeries.points)
        if (points.length < 2) return null
        return {
          id: teamKey(team),
          label: team.code ?? team.team,
          color: COMPARE_SERIES_COLORS[index % COMPARE_SERIES_COLORS.length],
          points,
        }
      })
      .filter((entry): entry is ChartSeries => entry !== null)
  }, [history, teams])

  return (
    <section className="compare-chart" aria-label="Compared team power score trend">
      <div className="compare-chart__head">
        <div>
          <p className="eyebrow">Over time</p>
          <h3>Power score trend</h3>
        </div>
        {history ? (
          <span className="compare-chart__meta">
            Model {formatModelVersion(history.modelVersion)} · {formatDate(history.generatedAt)}
          </span>
        ) : null}
      </div>
      {historyState.status === 'loading' ? (
        <p className="muted compare-chart__empty">Loading team history…</p>
      ) : historyState.status !== 'ready' ? (
        <p className="muted compare-chart__empty">{historyState.message}</p>
      ) : series.length > 0 ? (
        <TeamHistoryLineChart series={series} height={300} yLabel="Power score" yFormat={formatRating} />
      ) : (
        <p className="muted compare-chart__empty">Not enough history to chart the selected teams yet.</p>
      )}
    </section>
  )
}

function formatSignedRating(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const formatted = formatRating(Math.abs(value))
  return value > 0 ? `+${formatted}` : value < 0 ? `-${formatted}` : '0'
}

function deltaClass(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) < 0.05) return 'flat'
  return value > 0 ? 'up' : 'down'
}

function formatTierLabel(value: string) {
  return value
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function formatSource(context?: PublicTeamHistoryPoint[3]) {
  if (!context?.sourceProvider) return undefined
  if (context.sourceMatchId) return `${context.sourceProvider} · ${context.sourceMatchId}`
  if (context.sourceGameIds && context.sourceGameIds.length > 1) return `${context.sourceProvider} · ${context.sourceGameIds.length} source rows`
  if (context.sourceGameId) return `${context.sourceProvider} · ${context.sourceGameId}`
  if (context.sourceFileName) return `${context.sourceProvider} · ${context.sourceFileName}`
  return context.sourceProvider
}

function formatRegionTrendMatchScore(event: RegionTrendEvent) {
  if (typeof event.wins !== 'number' || typeof event.losses !== 'number') return event.result
  const score = `${event.wins}-${event.losses}`
  const bestOf = typeof event.bestOf === 'number' && event.bestOf > 1 ? `Bo${event.bestOf}` : undefined
  return [event.result, score, bestOf].filter(Boolean).join(' · ')
}
