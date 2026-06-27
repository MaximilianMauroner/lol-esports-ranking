import { useMemo, type CSSProperties } from 'react'
import type {
  PublicTeamHistoryDirectory as TeamHistoryDirectory,
  PublicTeamStanding as RankingSummaryStanding,
} from '../lib/publicArtifacts/schema'
import { formatDate, formatRating, teamKey } from '../lib/display'
import type { RegionStrength } from '../lib/regionStrength'
import type { CompareColumn } from './CompareDrawer'
import {
  REGION_PROFILE_METRICS,
  TEAM_PROFILE_METRICS,
  type CompareProfileMetric,
  regionKey,
} from './compareAnalysisData'
import { LineChart, type ChartSeries } from './LineChart'

const REGION_TREND_TEAM_LIMIT = 5
const COMPARE_SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)']

export function RegionCompareAnalysis({
  regions,
  columns,
  standings,
  history,
}: {
  regions: RegionStrength[]
  columns: CompareColumn[]
  standings: RankingSummaryStanding[]
  history?: TeamHistoryDirectory
}) {
  return (
    <>
      <CompareProfileChart title="Region power profile" eyebrow="Current scope" entities={regions} columns={columns} metrics={REGION_PROFILE_METRICS} />
      <RegionTrendChart regions={regions} standings={standings} history={history} />
    </>
  )
}

export function TeamCompareAnalysis({
  teams,
  columns,
  history,
}: {
  teams: RankingSummaryStanding[]
  columns: CompareColumn[]
  history?: TeamHistoryDirectory
}) {
  return (
    <>
      <CompareProfileChart title="Team profile" eyebrow="Current scope" entities={teams} columns={columns} metrics={TEAM_PROFILE_METRICS} />
      <TeamCompareChart teams={teams} history={history} />
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
                        <i style={{ background: color }} />
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
  history,
}: {
  regions: RegionStrength[]
  standings: RankingSummaryStanding[]
  history?: TeamHistoryDirectory
}) {
  const series = useMemo<ChartSeries[]>(() => {
    if (!history) return []
    return regions
      .map((region, index): ChartSeries | null => {
        const teams = selectRegionTrendTeams(region, standings, history)
        const points = aggregateRegionTrend(teams, history)
        if (points.length < 2) return null
        return {
          id: regionKey(region),
          label: region.region,
          color: COMPARE_SERIES_COLORS[index % COMPARE_SERIES_COLORS.length],
          points,
        }
      })
      .filter((entry): entry is ChartSeries => entry !== null)
  }, [history, regions, standings])

  return (
    <section className="compare-chart" aria-label="Compared region strength trend">
      <div className="compare-chart__head">
        <div>
          <p className="eyebrow">Over time</p>
          <h3>Region strength trend</h3>
        </div>
        {history ? (
          <span className="compare-chart__meta">
            Top current teams · Model {history.modelVersion} · {formatDate(history.generatedAt)}
          </span>
        ) : null}
      </div>
      {!history ? (
        <p className="muted compare-chart__empty">Loading team history…</p>
      ) : series.length > 0 ? (
        <LineChart series={series} height={300} yLabel="Avg team power" yFormat={formatRating} />
      ) : (
        <p className="muted compare-chart__empty">Not enough tracked team history to plot the selected regions yet.</p>
      )}
    </section>
  )
}

function selectRegionTrendTeams(region: RegionStrength, standings: RankingSummaryStanding[], history: TeamHistoryDirectory) {
  const topTeamNames = new Set(region.topTeams.map((team) => team.team))
  const topTeamCodes = new Set(region.topTeams.map((team) => team.code).filter((code): code is string => Boolean(code)))
  const regionTeams = standings
    .filter((team) => team.region === region.region && Boolean(history.series[teamKey(team)]))
    .sort((left, right) => (right.rating ?? 0) - (left.rating ?? 0))
  const preferred = regionTeams.filter((team) => topTeamNames.has(team.team) || (team.code ? topTeamCodes.has(team.code) : false))
  const candidates = preferred.length > 0 ? preferred : regionTeams
  return candidates.slice(0, REGION_TREND_TEAM_LIMIT)
}

function aggregateRegionTrend(teams: RankingSummaryStanding[], history: TeamHistoryDirectory) {
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

function TeamCompareChart({
  teams,
  history,
}: {
  teams: RankingSummaryStanding[]
  history?: TeamHistoryDirectory
}) {
  const series = useMemo<ChartSeries[]>(() => {
    if (!history) return []
    return teams
      .map((team, index): ChartSeries | null => {
        const teamSeries = history.series[teamKey(team)]
        if (!teamSeries || teamSeries.points.length < 2) return null
        const byDay = new Map<string, (typeof teamSeries.points)[number]>()
        for (const point of teamSeries.points) byDay.set(point[0], point)
        return {
          id: teamKey(team),
          label: team.code ?? team.team,
          color: COMPARE_SERIES_COLORS[index % COMPARE_SERIES_COLORS.length],
          points: [...byDay.values()].map((point) => ({
            t: Date.parse(point[0]),
            y: point[1],
          })),
        }
      })
      .filter((entry): entry is ChartSeries => entry !== null)
  }, [history, teams])

  return (
    <section className="compare-chart" aria-label="Compared team power score trend">
      <div className="compare-chart__head">
        <div>
          <p className="eyebrow">Over time</p>
          <h3>Power Score trend</h3>
        </div>
        {history ? (
          <span className="compare-chart__meta">
            Model {history.modelVersion} · {formatDate(history.generatedAt)}
          </span>
        ) : null}
      </div>
      {!history ? (
        <p className="muted compare-chart__empty">Loading team history…</p>
      ) : series.length > 0 ? (
        <LineChart series={series} height={300} yLabel="Power Score" yFormat={formatRating} />
      ) : (
        <p className="muted compare-chart__empty">Not enough history to chart the selected teams yet.</p>
      )}
    </section>
  )
}
