import { useMemo } from 'react'
import type { RegionHistoryScopeState } from '../../browser/rankings/usePublicArtifacts'
import { LineChart, type ChartActiveRow, type ChartSeries } from '../../components/LineChart'
import { LoadingState } from '../../components/ui/loading'
import { regionRatingHistory } from '../../domains/rankings/read'
import type { PublicTeamStanding } from '../../domains/rankings/types'
import { formatChartTimestamp } from '../../shared/chartTime'
import { formatRating } from '../../shared/display'

type RegionPowerHistoryLine = { region: string; color: string }

/** One line per region: the mean Power of its three highest-rated eligible flagship teams, day by day. */
export function RegionPowerHistory({
  state,
  lines,
  standings,
}: {
  state: RegionHistoryScopeState
  lines: RegionPowerHistoryLine[]
  standings: Pick<PublicTeamStanding, 'team' | 'code'>[]
}) {
  const history = state.status === 'ready' ? state.data : undefined
  const series = useMemo<ChartSeries[]>(() => {
    if (!history) return []
    return regionRatingHistory(history, lines.map((line) => line.region)).flatMap(({ region, points }, index) => points.length > 0 ? [{
      id: region,
      label: region,
      color: lines[index].color,
      points: points.map((point) => ({ t: Date.parse(point.date), y: point.meanTop3, detail: point.teams })),
    }] : [])
  }, [history, lines])
  const codes = useMemo(() => new Map(standings.flatMap((team) => team.code ? [[team.team, team.code] as const] : [])), [standings])

  if (state.status === 'missing' || state.status === 'error') return <p className="px-4 py-3 text-sm text-muted-foreground">{state.message}</p>
  if (!history) return <LoadingState presentation="chart" className="m-4" label="Loading region power history" />

  const shown = new Set(series.map((entry) => entry.id))
  const withoutHistory = lines.filter((line) => !shown.has(line.region)).map((line) => line.region)

  return (
    <div className="grid min-w-0 gap-1">
      {series.length > 0 ? (
        <LineChart
          series={series}
          height={320}
          yLabel="Region power"
          yFormat={formatRating}
          details={(active) => <RegionPowerDetails active={active} codes={codes} />}
        />
      ) : null}
      <p className="px-4 pb-1 text-xs text-muted-foreground">
        Region power in the table also includes the current context adjustment of each team, so the end of a line can differ from it.
        {withoutHistory.length > 0 ? ` No rated history in this scope for ${withoutHistory.join(', ')}.` : null}
      </p>
    </div>
  )
}

function RegionPowerDetails({ active, codes }: { active: ChartActiveRow; codes: Map<string, string> }) {
  if (active.points.length === 0) return null
  return (
    <div className="grid min-w-0 gap-2 border-t border-border pt-3 text-sm">
      <b className="text-xs text-[var(--text-strong)]">{formatChartTimestamp(active.t)}</b>
      <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,250px),1fr))] gap-x-5 gap-y-1.5">
        {active.points.map(({ series, point }) => {
          const teams = Array.isArray(point.detail) ? point.detail.map(String) : []
          return (
            <li className="grid min-w-0 grid-cols-[12px_3.25rem_3rem_minmax(0,1fr)] items-baseline gap-2" key={series.id}>
              <i className="inline-block h-[3px] w-[11px] shrink-0 self-center rounded-full" style={{ background: series.color }} aria-hidden="true" />
              <b className="font-semibold text-[var(--text-strong)]">{series.label}</b>
              <strong className="text-right text-foreground tabular-nums">{formatRating(point.y)}</strong>
              <span className="truncate text-xs text-muted-foreground" title={teams.join(', ')}>
                {teams.map((team) => codes.get(team) ?? team).join(' · ')}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
