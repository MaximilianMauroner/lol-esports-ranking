import { useMemo, useState } from 'react'
import { Activity, BarChart3, Trophy, Users } from 'lucide-react'
import type { ModelInfo, RankingSummaryStanding, TeamHistorySeries } from '../lib/snapshot'
import type { TeamHistoryArtifactState } from '../hooks/usePublicArtifacts'
import type { ChartSeries } from '../components/LineChart'
import type { ChartPoint } from '../lib/chartPoints'
import { TeamHistoryLineChart } from '../components/TeamHistoryLineChart'
import { dailyChartPointsFromHistoryPoints, deriveDailyRankSeries } from '../lib/teamHistoryChart'
import { CountBadge, DataState, Field, HeatChip, RegionBadge, Segmented } from '../components/ui'
import { Card, CardHeader } from '../components/ui/card'
import { Skeleton } from '../components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { extent, formatDate, formatNumber, formatRating, formatSigned, teamKey } from '../lib/display'

type SplitRaceViewProps = {
  standings: RankingSummaryStanding[]
  historyState: TeamHistoryArtifactState
  pickedTeams: RankingSummaryStanding[]
  model?: Pick<ModelInfo, 'version' | 'configHash'>
}

type RaceMetric = 'rank' | 'rating'
type RaceSize = '6' | '8' | '12'

type RaceTrend = {
  openingRating: number
  currentRating: number
  ratingDelta: number
  openingRank?: number
  currentRank?: number
  rankDelta?: number
  startDate: string
  endDate: string
  pointCount: number
}

type ContenderRow = {
  team: RankingSummaryStanding
  status: 'leader' | 'contender' | 'chasing' | 'outside'
  statusLabel: string
  ratingGap: number
  trend?: RaceTrend
}

const RACE_SIZE_OPTIONS: RaceSize[] = ['6', '8', '12']
const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)']
const RANK_AXIS_LIMIT = 60

export function SplitRaceView({ standings, historyState, pickedTeams, model }: SplitRaceViewProps) {
  const [metric, setMetric] = useState<RaceMetric>('rank')
  const [raceSize, setRaceSize] = useState<RaceSize>('8')

  const history = historyState.status === 'ready' ? historyState.data.series : undefined
  const focusTeams = useMemo(
    () => selectRaceTeams(standings, pickedTeams, Number(raceSize)),
    [pickedTeams, raceSize, standings],
  )
  const raceRows = useMemo(
    () => buildRaceRows(focusTeams, history),
    [focusTeams, history],
  )
  const rankSeries = useMemo(
    () => history && metric === 'rank' ? deriveDailyRankSeries(history) : new Map<string, ChartPoint[]>(),
    [history, metric],
  )
  const chartSeries = useMemo<ChartSeries[]>(() => {
    if (!history) return []
    return focusTeams
      .map((team, index): ChartSeries | null => {
        const key = teamKey(team)
        const points = metric === 'rank'
          ? rankSeries.get(key) ?? []
          : dailyChartPointsFromHistoryPoints(history[key]?.points ?? [])
        if (points.length < 2) return null
        return {
          id: key,
          label: team.code ?? team.team,
          color: SERIES_COLORS[index % SERIES_COLORS.length],
          points,
        }
      })
      .filter((series): series is ChartSeries => series !== null)
  }, [focusTeams, history, metric, rankSeries])
  const rankAxis = useMemo(() => metric === 'rank' ? rankAxisForSeries(chartSeries) : undefined, [chartSeries, metric])
  const [ratingMin, ratingMax] = useMemo(() => extent(focusTeams.map((team) => team.rating)), [focusTeams])
  const leader = raceRows.find((row) => row.status === 'leader') ?? raceRows[0]
  const rising = useMemo(
    () => raceRows
      .filter((row) => typeof row.trend?.ratingDelta === 'number')
      .toSorted((left, right) => (right.trend?.ratingDelta ?? 0) - (left.trend?.ratingDelta ?? 0))[0],
    [raceRows],
  )
  const scopeLabel = pickedTeams.length > 0 ? 'Picks plus league rivals' : 'Top ranked race'

  return (
    <div className="view lab-view split-race">
      <Card className="panel lab-panel lab-hero">
        <CardHeader className="panel__head lab-hero__head">
          <div className="panel__title">
            <p className="eyebrow">Scenario lab</p>
            <h2>Split Race</h2>
            <p className="panel__hint">
              Rank race and contender labels from current standings plus generated team-history points. No schedule or tiebreaker assumptions are added.
            </p>
          </div>
          <div className="lab-toolbar">
            <Segmented
              value={metric}
              options={[
                { value: 'rank', label: 'Rank race' },
                { value: 'rating', label: 'Power score' },
              ]}
              onChange={setMetric}
              ariaLabel="Split race chart metric"
            />
            <Field
              label="Teams"
              value={raceSize}
              options={RACE_SIZE_OPTIONS.map((option) => ({ value: option, label: option }))}
              onChange={(value) => setRaceSize(value as RaceSize)}
            />
          </div>
        </CardHeader>

        <div className="lab-hero__grid">
          <SummaryTile
            icon={<Trophy size={18} aria-hidden="true" />}
            label="Race leader"
            value={leader ? leader.team.code ?? leader.team.team : 'None'}
            detail={leader ? `${formatRating(leader.team.rating)} power` : 'No standings'}
          />
          <SummaryTile
            icon={<Activity size={18} aria-hidden="true" />}
            label="Biggest gain"
            value={rising ? rising.team.code ?? rising.team.team : 'None'}
            detail={rising?.trend ? `${formatSigned(rising.trend.ratingDelta)} since ${formatDate(rising.trend.startDate)}` : 'History pending'}
          />
          <SummaryTile
            icon={<Users size={18} aria-hidden="true" />}
            label="Scope"
            value={scopeLabel}
            detail={`${formatNumber(focusTeams.length)} teams`}
          />
          <SummaryTile
            icon={<BarChart3 size={18} aria-hidden="true" />}
            label="Model"
            value={model?.version ?? 'current snapshot'}
            detail={model?.configHash ?? historyModelLabel(historyState)}
          />
        </div>
      </Card>

      <Card className="panel lab-panel">
        <CardHeader className="panel__head">
          <div className="panel__title">
            <p className="eyebrow">Over time</p>
            <h2>{metric === 'rank' ? 'Rank race' : 'Power score race'}</h2>
          </div>
          <CountBadge>{chartSeries.length} charted</CountBadge>
        </CardHeader>
        {historyState.status === 'loading' ? (
          <RaceSkeleton />
        ) : historyState.status !== 'ready' ? (
          <DataState icon={<BarChart3 size={26} aria-hidden="true" />} title="History unavailable">
            {historyState.message}
          </DataState>
        ) : chartSeries.length === 0 ? (
          <DataState icon={<BarChart3 size={26} aria-hidden="true" />} title="No race history">
            The selected teams do not have at least two generated history points in this scope.
          </DataState>
        ) : (
          <TeamHistoryLineChart
            series={chartSeries}
            height={330}
            yLabel={metric === 'rank' ? 'Rank' : 'Power score'}
            yFormat={metric === 'rank' ? (value) => `#${Math.round(value)}` : undefined}
            yTickFormat={metric === 'rank' ? (value) => Math.round(value) === 1 ? '#1 best' : `#${Math.round(value)}` : undefined}
            yDomain={rankAxis?.domain}
            yTicks={rankAxis?.ticks}
            yReverse={metric === 'rank'}
            curve={metric === 'rank' ? 'step' : 'linear'}
          />
        )}
      </Card>

      <Card className="panel lab-panel lab-table-panel">
        <CardHeader className="panel__head">
          <div className="panel__title">
            <p className="eyebrow">Contender board</p>
            <h2>Movement and status</h2>
          </div>
          <CountBadge>{historyState.status}</CountBadge>
        </CardHeader>
        <div className="tablewrap">
          <Table className="ranking-table lab-race-table">
            <TableHeader>
              <TableRow>
                <TableHead>Rank</TableHead>
                <TableHead>Team</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="right">Power</TableHead>
                <TableHead className="right">Gap</TableHead>
                <TableHead className="right">Current move</TableHead>
                <TableHead className="right">Race delta</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {raceRows.map((row) => (
                <TableRow key={teamKey(row.team)}>
                  <TableCell className="rank-cell">#{row.team.rank}</TableCell>
                  <TableCell>
                    <TeamIdentity team={row.team} detail={row.team.league} />
                  </TableCell>
                  <TableCell>
                    <span className={`lab-status lab-status--${row.status}`}>{row.statusLabel}</span>
                  </TableCell>
                  <TableCell className="right">
                    <HeatChip value={row.team.rating} min={ratingMin} max={ratingMax} label={formatRating(row.team.rating)} />
                  </TableCell>
                  <TableCell className="right num">{row.ratingGap === 0 ? 'Leader' : formatSigned(-row.ratingGap)}</TableCell>
                  <TableCell className="right">
                    <Movement value={row.team.movement} />
                  </TableCell>
                  <TableCell className="right">
                    {row.trend ? (
                      <span className={`delta ${row.trend.ratingDelta > 0 ? 'up' : row.trend.ratingDelta < 0 ? 'down' : 'flat'}`}>
                        {formatSigned(row.trend.ratingDelta)}
                      </span>
                    ) : (
                      <span className="muted">No history</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  )
}

function SummaryTile({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode
  label: string
  value: string
  detail: string
}) {
  return (
    <article className="lab-summary">
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <b>{value}</b>
        <em>{detail}</em>
      </div>
    </article>
  )
}

function TeamIdentity({ team, detail }: { team: RankingSummaryStanding; detail: string }) {
  return (
    <div className="lab-team">
      <RegionBadge region={team.league || team.region} size="sm" />
      <div className="ent">
        <b>{team.team}</b>
        <small>{team.code ? `${team.code} / ${detail}` : detail}</small>
      </div>
    </div>
  )
}

function RaceSkeleton() {
  return (
    <div className="lab-skeleton" aria-label="Loading race history">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-[260px] w-full" />
      <div className="lab-skeleton__legend">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-20" />
      </div>
    </div>
  )
}

function Movement({ value }: { value?: number }) {
  if (!value || !Number.isFinite(value)) return <span className="delta flat">0</span>
  return <span className={`delta ${value > 0 ? 'up' : 'down'}`}>{value > 0 ? `+${value}` : String(value)}</span>
}

function selectRaceTeams(
  standings: RankingSummaryStanding[],
  pickedTeams: RankingSummaryStanding[],
  limit: number,
) {
  const standingByKey = new Map(standings.map((team) => [teamKey(team), team]))
  const sorted = standings
    .filter((team) => team.eligibility?.eligible ?? true)
    .toSorted((left, right) => left.rank - right.rank || right.rating - left.rating || left.team.localeCompare(right.team))
  const picks = pickedTeams
    .map((team) => standingByKey.get(teamKey(team)))
    .filter((team): team is RankingSummaryStanding => Boolean(team))

  if (picks.length === 0) return sorted.slice(0, limit)

  const pickLeagues = new Set(picks.map((team) => team.league).filter(Boolean))
  const rivals = sorted.filter((team) => pickLeagues.size === 0 || pickLeagues.has(team.league))
  const seen = new Set<string>()
  const selected: RankingSummaryStanding[] = []
  for (const team of [...picks, ...rivals]) {
    const key = teamKey(team)
    if (seen.has(key)) continue
    seen.add(key)
    selected.push(team)
    if (selected.length >= limit) break
  }
  return selected
}

function buildRaceRows(
  teams: RankingSummaryStanding[],
  history?: Record<string, TeamHistorySeries>,
): ContenderRow[] {
  const leaderRating = teams.reduce((best, team) => Math.max(best, team.rating), -Infinity)
  return teams.map((team) => {
    const trend = summarizeTrend(history?.[teamKey(team)])
    const ratingGap = Number.isFinite(leaderRating) ? Math.max(0, leaderRating - team.rating) : 0
    const status = statusFor(team, ratingGap, trend)
    return {
      team,
      status,
      statusLabel: statusLabel(status),
      ratingGap,
      trend,
    }
  })
}

function summarizeTrend(series?: TeamHistorySeries): RaceTrend | undefined {
  if (!series || series.points.length < 2) return undefined
  const first = series.points[0]
  const last = series.points.at(-1)!
  const openingRank = finiteRank(first[2])
  const currentRank = finiteRank(last[2])
  return {
    openingRating: first[1],
    currentRating: last[1],
    ratingDelta: last[1] - first[1],
    openingRank,
    currentRank,
    rankDelta: typeof openingRank === 'number' && typeof currentRank === 'number' ? openingRank - currentRank : undefined,
    startDate: first[0],
    endDate: last[0],
    pointCount: series.points.length,
  }
}

function finiteRank(value: number) {
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function statusFor(team: RankingSummaryStanding, ratingGap: number, trend?: RaceTrend): ContenderRow['status'] {
  if (ratingGap <= 0 || team.rank === 1) return 'leader'
  if (ratingGap <= 35 || team.rank <= 3) return 'contender'
  if (ratingGap <= 90 || (trend?.ratingDelta ?? 0) >= 35 || team.rank <= 8) return 'chasing'
  return 'outside'
}

function statusLabel(status: ContenderRow['status']) {
  switch (status) {
    case 'leader':
      return 'Leader'
    case 'contender':
      return 'Contender'
    case 'chasing':
      return 'Chasing'
    default:
      return 'Needs surge'
  }
}

function rankAxisForSeries(series: ChartSeries[]) {
  const ranks = series
    .flatMap((entry) => entry.points.map((point) => point.y))
    .filter((rank) => Number.isFinite(rank) && rank >= 1)
    .map((rank) => Math.round(rank))
  if (ranks.length === 0) return undefined
  const axisMax = Math.min(RANK_AXIS_LIMIT, Math.max(5, Math.max(...ranks)))
  const ticks = axisMax <= 8
    ? Array.from({ length: axisMax }, (_, index) => index + 1)
    : uniqueSorted([1, Math.round(axisMax * 0.25), Math.round(axisMax * 0.5), Math.round(axisMax * 0.75), axisMax])
  return {
    domain: { min: 1, max: axisMax },
    ticks,
  }
}

function uniqueSorted(values: number[]) {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value >= 1).map(Math.round))].sort((left, right) => left - right)
}

function historyModelLabel(historyState: TeamHistoryArtifactState) {
  if (historyState.status === 'ready') return historyState.data.modelVersion
  if (historyState.status === 'loading') return 'history loading'
  return historyState.message
}
