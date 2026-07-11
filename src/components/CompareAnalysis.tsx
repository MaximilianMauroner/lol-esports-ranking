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
import { cn } from '../lib/utils'

const REGION_TREND_TEAM_LIMIT = 5
const REGION_TREND_EVENT_LIMIT = 8
const compareChartClassName = 'max-w-full min-w-0 min-h-[360px] overflow-hidden rounded-[var(--r)] border border-[var(--line)] bg-[oklch(0.145_0.004_250)] [&_.chart]:px-3.5 [&_.chart_svg]:h-[300px] max-sm:min-h-0 max-sm:[&_.chart_svg]:h-[230px]'
const compareChartHeadClassName = 'flex flex-wrap items-baseline justify-between gap-x-3.5 gap-y-2 px-[18px] pt-4 [&_.eyebrow]:text-[0.66rem] [&_.eyebrow]:tracking-[0.14em] [&_.eyebrow]:text-[var(--faint)] [&_.eyebrow]:uppercase [&_h3]:mt-0.5 [&_h3]:text-base [&_h3]:font-[660] [&_h3]:text-[var(--text-strong)]'
const compareChartMetaClassName = 'text-[0.76rem] text-[var(--faint)] tabular-nums'
const compareChartEmptyClassName = 'px-[18px] py-[22px] text-[var(--muted)]'
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
  result?: 'W' | 'L' | 'T'
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
      <section className={cn(compareChartClassName, 'min-h-0')} aria-label={title}>
        <p className={compareChartEmptyClassName}>Add at least two entries to compare their profile.</p>
      </section>
    )
  }

  return (
    <section className={cn(compareChartClassName, 'min-h-0')} aria-label={title}>
      <div className={compareChartHeadClassName}>
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h3>{title}</h3>
        </div>
        <span className={compareChartMetaClassName}>{entities.length} selected</span>
      </div>
      <div className="grid min-w-0 gap-[15px] px-[18px] pt-[15px] pb-[18px] max-sm:px-3.5 max-sm:py-3">
        {metrics.map((metric) => {
          const values = entities.map(metric.value)
          const best = bestProfileIds(values, columns, metric.better)
          return (
            <div className="grid grid-cols-[minmax(120px,150px)_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-1 max-[900px]:gap-2" key={metric.key}>
              <div className="min-w-0 pt-[3px]">
                <span className="block text-[0.72rem] font-[620] tracking-[0.08em] text-[var(--faint)] uppercase">{metric.label}</span>
              </div>
              <div className="grid min-w-0 gap-[7px]">
                {entities.map((entity, index) => {
                  const value = metric.value(entity)
                  const color = COMPARE_SERIES_COLORS[index % COMPARE_SERIES_COLORS.length]
                  const percent = profilePercent(value, values, metric.better)
                  const isBest = best.has(columns[index].id)
                  return (
                    <div className={`grid min-w-0 grid-cols-[minmax(84px,0.8fr)_minmax(100px,2fr)_minmax(54px,auto)] items-center gap-2.5 text-[var(--muted)] max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-2.5 max-sm:gap-y-1.5${isBest ? ' text-[var(--text-strong)]' : ''}`} key={columns[index].id}>
                      <span className="inline-flex min-w-0 items-center gap-[7px] overflow-hidden text-ellipsis whitespace-nowrap text-[0.78rem] text-[var(--text)]">
                        <i className="size-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />
                        {columns[index].name}
                      </span>
                      <span className="h-2 overflow-hidden rounded-full bg-[var(--surface-3)] shadow-[inset_0_0_0_1px_var(--line)] max-sm:col-span-full max-sm:col-start-1 max-sm:row-start-2" aria-hidden="true">
                        <span className="block h-full min-w-[3px] rounded-full" style={{ width: `${percent}%`, background: color } as CSSProperties} />
                      </span>
                      <strong className="justify-self-end text-[0.78rem] font-[620] tabular-nums max-sm:col-start-2 max-sm:row-start-1">{metric.format(value)}</strong>
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
    <section className={compareChartClassName} aria-label="Compared region strength trend">
      <div className={compareChartHeadClassName}>
        <div>
          <p className="eyebrow">Over time</p>
          <h3>Region power trend</h3>
        </div>
        {regionHistory ? (
          <span className={compareChartMetaClassName}>
            International league-strength history · {regionHistory.regionCount} regions
          </span>
        ) : history ? (
          <span className={compareChartMetaClassName}>
            Derived top-team average · Model {formatModelVersion(history.modelVersion)} · {formatDate(history.generatedAt)}
          </span>
        ) : null}
      </div>
      {fallbackNote ? <p className="px-[18px] pt-2.5 text-[0.76rem] text-[var(--muted)]">{fallbackNote}</p> : null}
      {!regionHistory && regionHistoryState.status === 'loading' ? (
        <p className={compareChartEmptyClassName}>Loading region history...</p>
      ) : !regionHistory && historyState.status === 'idle' ? (
        <p className={compareChartEmptyClassName}>History loads when comparison opens.</p>
      ) : !regionHistory && historyState.status === 'loading' ? (
        <p className={compareChartEmptyClassName}>Loading history…</p>
      ) : !regionHistory && (historyState.status === 'missing' || historyState.status === 'error') ? (
        <p className={compareChartEmptyClassName}>{historyState.message}</p>
      ) : series.length > 0 ? (
        <>
          <LineChart series={series} height={300} yLabel={regionHistory ? 'Region power score' : 'Avg team power score'} yFormat={formatRating} />
          <RegionTrendEvents events={events} />
        </>
      ) : (
        <p className={compareChartEmptyClassName}>Not enough tracked team history to plot the selected regions yet.</p>
      )}
    </section>
  )
}

function regionHistoryFallbackNote(state: RegionHistoryScopeState) {
  if (state.status === 'idle') return 'Region history has not been requested yet; this chart is temporarily derived from the current top-team average.'
  if (state.status === 'loading') return 'Region history is still loading; this chart is temporarily derived from the current top-team average.'
  if (state.status === 'missing' || state.status === 'error') return `${state.message} Showing a derived top-team average instead.`
  return undefined
}

function regionHistoryTrend(regions: RegionStrength[], history: PublicRegionHistoryScope) {
  return regions
    .map((region, index): { series: ChartSeries; events: RegionTrendEvent[] } | null => {
      const regionSeries = history.regionPowerSeries[region.region]
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
      <p className="m-0 border-t border-[var(--line)] px-[18px] pt-3.5 pb-[18px] text-[0.76rem] text-[var(--faint)]">
        Movement drivers are unavailable for this artifact. Regenerate team history to include event-level point metadata.
      </p>
    )
  }

  return (
    <div className="border-t border-[var(--line)] px-[18px] pt-3.5 pb-[18px] max-[900px]:px-3.5 max-[900px]:pt-3 max-[900px]:pb-3.5" aria-label="Largest derived region trend movement drivers">
      <div className="mb-2.5 flex items-baseline justify-between gap-2.5 max-[900px]:grid max-[900px]:gap-[3px]">
        <span className="text-[0.75rem] font-[680] tracking-[0.08em] text-[var(--text)] uppercase">Largest derived moves</span>
        <small className="text-[0.76rem] text-[var(--faint)]">Team-history points behind the regional average</small>
      </div>
      <div className="grid grid-cols-2 gap-[9px] max-[900px]:grid-cols-1">
        {events.map((event) => (
          <article className="grid min-w-0 gap-[7px] rounded-[var(--r)] border border-[var(--line)] bg-[var(--surface-2)] p-2.5" key={event.id}>
            <div className="flex min-w-0 items-center gap-[9px]">
              <span className="inline-flex min-w-0 items-center gap-1.5 text-[0.76rem] font-[680] text-[var(--text)]">
                <i className="size-2 shrink-0 rounded-full" style={{ background: event.regionColor }} aria-hidden="true" />
                {event.region}
              </span>
              <time className="text-[0.74rem] text-[var(--faint)] tabular-nums" dateTime={event.date}>{formatDate(event.date)}</time>
              <strong className={`ml-auto font-mono text-[0.78rem] tabular-nums ${deltaClass(event.delta)}`}>{formatSignedRating(event.delta)}</strong>
            </div>
            <div className="flex min-w-0 items-center gap-[7px] text-[var(--text)] [&_b]:overflow-hidden [&_b]:text-ellipsis [&_b]:whitespace-nowrap [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap">
              <b className="text-[0.86rem] font-[680] text-[var(--text-strong)]">{event.team}</b>
              {event.opponent ? <span className="text-[0.8rem] text-[var(--muted)]">vs {event.opponent}</span> : null}
              {formatRegionTrendMatchScore(event) ? <em className="inline-grid size-[19px] shrink-0 place-items-center rounded-[5px] bg-[var(--surface-3)] text-[0.68rem] font-[760] text-[var(--muted)] not-italic">{formatRegionTrendMatchScore(event)}</em> : null}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-[5px] [&>span]:max-w-full [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap [&>span]:rounded-[var(--r-sm)] [&>span]:border [&>span]:border-[var(--line)] [&>span]:bg-[var(--surface)] [&>span]:px-1.5 [&>span]:py-0.5 [&>span]:text-[0.7rem] [&>span]:text-[var(--faint)]">
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
    <section className={compareChartClassName} aria-label="Compared team power score trend">
      <div className={compareChartHeadClassName}>
        <div>
          <p className="eyebrow">Over time</p>
          <h3>Power score trend</h3>
        </div>
        {history ? (
          <span className={compareChartMetaClassName}>
            Model {formatModelVersion(history.modelVersion)} · {formatDate(history.generatedAt)}
          </span>
        ) : null}
      </div>
      {historyState.status === 'idle' ? (
        <p className={compareChartEmptyClassName}>History loads when comparison opens.</p>
      ) : historyState.status === 'loading' ? (
        <p className={compareChartEmptyClassName}>Loading team history…</p>
      ) : historyState.status === 'missing' || historyState.status === 'error' ? (
        <p className={compareChartEmptyClassName}>{historyState.message}</p>
      ) : series.length > 0 ? (
        <TeamHistoryLineChart series={series} height={300} yLabel="Power score" yFormat={formatRating} />
      ) : (
        <p className={compareChartEmptyClassName}>Not enough history to chart the selected teams yet.</p>
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
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) < 0.05) return 'text-[var(--faint)]'
  return value > 0 ? 'text-[var(--up)]' : 'text-[var(--down)]'
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
