import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
  useActiveTooltipLabel,
  type TooltipContentProps,
} from 'recharts'
import { Button } from './ui/button'
import { ChartContainer, ChartTooltipContent, type ChartConfig } from './ui/chart'
import { formatChartTimestamp, monthTicks } from '../shared/chartTime'
import { formatNumber } from '../shared/display'

export type ChartPoint = {
  t: number
  y: number
  detail?: unknown
}

export type ChartSeries = {
  id: string
  label: string
  color: string
  points: ChartPoint[]
}

export type ChartActiveRow = {
  t: number
  points: { series: ChartSeries; point: ChartPoint }[]
}

type ChartDatum = { t: number } & Record<string, unknown>

/**
 * One drawn line. A series with a long gap in its data is split into several
 * segments that share its colour and label, and a dashed connector marks the
 * gap without presenting the interval as a recorded trend.
 */
type SeriesMeta = {
  key: string
  series: ChartSeries
}

export type LineChartProps = {
  series: ChartSeries[]
  height?: number
  yLabel?: string
  yFormat?: (value: number) => string
  yTickFormat?: (value: number) => string
  yDomain?: { min: number; max: number }
  yTicks?: number[]
  yReverse?: boolean
  curve?: 'linear' | 'step'
  interactiveLegend?: boolean
  /** Shown below the chart for the hovered row, or the latest row. */
  details?: (active: ChartActiveRow) => ReactNode
}

/** Longer than a normal break between matches; shorter than an off-season. */
const SEGMENT_GAP_MS = 21 * 86_400_000
/** Direct labels help from two lines; past six the right edge gets crowded. */
const MAX_DIRECT_LABELS = 6
const DIRECT_LABEL_WIDTH = 52
const DIRECT_LABEL_MIN_GAP_PX = 24
const CHART_VERTICAL_CHROME_PX = 92
/** Lines take their colours from the series, and the tooltip takes names from its payload. */
const CHART_CONFIG: ChartConfig = {}
const AXIS_TICK_STYLE = { fill: 'var(--muted)', fontSize: 13, fontWeight: 550 }

export function LineChart({
  series,
  height = 300,
  yLabel = 'Rating',
  yFormat = (value: number) => formatNumber(Math.round(value)),
  yTickFormat,
  yDomain,
  yTicks: providedYTicks,
  yReverse = false,
  curve = 'linear',
  interactiveLegend = false,
  details,
}: LineChartProps) {
  const [focusedSeriesId, setFocusedSeriesId] = useState<string>()
  const [hoveredT, setHoveredT] = useState<number>()
  const focusedId = interactiveLegend && series.some((entry) => entry.id === focusedSeriesId) ? focusedSeriesId : undefined
  const chartId = useId().replace(/:/g, '')
  const summaryId = `${chartId}-summary`
  const domain = useMemo(() => computeDomain(series, yDomain), [series, yDomain])
  const { data, meta, gaps } = useMemo(() => buildChartData(series), [series])

  if (series.length === 0 || domain === null || data.length === 0) {
    return <p className="text-muted-foreground p-5">No chart data available.</p>
  }

  const { minT, maxT, minY, maxY } = domain
  const directLabels = series.length >= 2 && series.length <= MAX_DIRECT_LABELS
    ? directLabelPositions(series, data.map((row) => row.t), { minY, maxY, plotHeight: height - CHART_VERTICAL_CHROME_PX, reversed: yReverse })
    : undefined
  const lastSegmentKey = new Map(meta.map(({ key, series: entry }) => [entry.id, key]))
  const yTicks = providedYTicks ?? niceTicks(minY, maxY, 4)
  const formatYTick = yTickFormat ?? yFormat
  const xMonthTicks = monthTicks(minT, maxT)
  const xTicks = xMonthTicks ?? timeTicks(minT, maxT, 5)
  const lineType = curve === 'step' ? 'stepAfter' : 'linear'
  const detailT = hoveredT !== undefined && data.some((row) => row.t === hoveredT) ? hoveredT : data[data.length - 1].t
  const selectedRow = activeRow(series, detailT)
  const pointReadout = series.length === 1 && details !== undefined
  const summaries = series.flatMap((entry) => {
    const summary = summarizeSeries(entry)
    return summary ? [summary] : []
  })
  const formatPoint = (point: ChartPoint) => `${yFormat(point.y)} on ${formatChartTimestamp(point.t)}`
  const summaryText = `${yLabel} chart data summary. ${summaries.map((entry) =>
    `${entry.label}: latest ${formatPoint(entry.latest)}, minimum ${formatPoint(entry.min)}, maximum ${formatPoint(entry.max)}, ${entry.count} points.`,
  ).join(' ')}`

  function renderTooltip({ active, label }: TooltipContentProps) {
    const row = typeof label === 'number' ? activeRow(series, label) : undefined
    const payload = row ? row.points.map(({ series: entry, point }) => (
      { graphicalItemId: entry.id, dataKey: entry.id, name: entry.label, color: entry.color, value: yFormat(point.y) }
    )) : []
    // The live region stays mounted so screen readers hear each new row, as with the Recharts default tooltip.
    return (
      <div role="status" aria-live="polite" className={pointReadout ? 'sr-only' : undefined}>
        {row ? <ChartTooltipContent active={active} label={formatChartTimestamp(row.t)} payload={payload} /> : null}
      </div>
    )
  }

  return (
    <div className="chart-shell">
      <div className={`flex flex-wrap items-center gap-x-3.5 gap-y-1 px-4 pt-3${pointReadout ? ' min-h-[58px]' : ''}`} role={interactiveLegend ? 'group' : undefined} aria-label={interactiveLegend ? 'Highlight a team' : undefined}>
        {interactiveLegend ? <Button variant="ghost" size="tab" aria-pressed={!focusedId} onClick={() => setFocusedSeriesId(undefined)}>All teams</Button> : null}
        {series.map((entry) => interactiveLegend ? (
          <Button key={entry.id} variant="ghost" size="tab" aria-pressed={focusedId === entry.id} onClick={() => setFocusedSeriesId(entry.id)} className={focusedId && focusedId !== entry.id ? 'opacity-45' : undefined}>
            <i className="inline-block h-[3px] w-[11px] shrink-0 rounded-full" style={{ background: entry.color }} aria-hidden="true" />
            {entry.label}
          </Button>
        ) : (
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground" key={entry.id}>
            <i className="inline-block h-[3px] w-[11px] shrink-0 rounded-full" style={{ background: entry.color }} aria-hidden="true" />
            {entry.label}
          </span>
        ))}
        {pointReadout && selectedRow.points[0] ? (
          <div className="chart-point-readout ml-auto grid justify-items-end gap-1 text-xs tabular-nums">
            <time dateTime={new Date(selectedRow.t).toISOString()} className="text-muted-foreground">{formatChartTimestamp(selectedRow.t)}</time>
            <strong className="text-sm text-foreground">{yFormat(selectedRow.points[0].point.y)}</strong>
          </div>
        ) : null}
      </div>
      <ChartContainer
        id={chartId}
        config={CHART_CONFIG}
        className="chart relative min-h-[220px] w-full min-w-0 aspect-auto overflow-hidden px-4 pt-4 pb-3 [&_svg]:block [&_svg]:size-full [&_svg]:touch-pan-y [&_svg]:overflow-hidden"
        style={{ height }}
      >
        <RechartsLineChart
          data={data}
          margin={{ top: 18, right: directLabels ? DIRECT_LABEL_WIDTH : 20, bottom: 16, left: 4 }}
          aria-label={`${yLabel} over time for ${series.map((entry) => entry.label).join(', ')}`}
          aria-describedby={summaryId}
        >
          <CartesianGrid vertical={false} strokeDasharray="0" />
          <XAxis
            dataKey="t"
            type="number"
            domain={[minT, maxT]}
            ticks={xTicks}
            tickLine={false}
            axisLine={false}
            tick={{ style: AXIS_TICK_STYLE }}
            minTickGap={28}
            tickFormatter={(value: number, index: number) => !xMonthTicks
              ? formatChartTimestamp(value, 'month-day')
              : formatChartTimestamp(value, index === 0 || new Date(value).getUTCMonth() === 0 ? 'month-year' : 'month')}
          />
          <YAxis
            type="number"
            width={52}
            label={{ value: yLabel, position: 'top', offset: 6, style: AXIS_TICK_STYLE, textAnchor: 'start' }}
            domain={[minY, maxY]}
            ticks={yTicks}
            reversed={yReverse}
            tickLine={false}
            axisLine={false}
            tick={{ style: AXIS_TICK_STYLE }}
            tickFormatter={(value) => formatYTick(Number(value))}
          />
          <RechartsTooltip trigger="hover" cursor={{ stroke: 'var(--line-strong)' }} content={renderTooltip} />
          {details ? <ActiveRowListener onActive={setHoveredT} /> : null}
          {gaps.map(({ key, series: entry }) => (
            <Line key={key} dataKey={key} opacity={focusedId && focusedId !== entry.id ? 0.18 : 1} stroke={entry.color} strokeWidth={1.5} strokeDasharray="4 4" connectNulls dot={false} activeDot={false} tooltipType="none" isAnimationActive={false} />
          ))}
          {meta.map(({ key, series: entry }) => (
            <Line
              key={key}
              dataKey={key}
              name={entry.label}
              type={lineType}
              stroke={entry.color}
              opacity={focusedId && focusedId !== entry.id ? 0.18 : 1}
              strokeWidth={2}
              connectNulls
              dot={entry.points.length <= 36 && series.length <= 2 ? { r: 3.2, strokeWidth: 2 } : false}
              activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
              isAnimationActive={false}
              label={directLabels && lastSegmentKey.get(entry.id) === key
                ? (props: { x?: number | string; y?: number | string; index?: number }) => {
                    const target = directLabels.get(entry.id)
                    if (!target || props.index !== target.index || typeof props.x !== 'number') return <g />
                    return (
                      <text x={props.x + 7} y={target.y(Number(props.y))} dy="0.32em" fill="var(--text)" fontSize={12} fontWeight={680} className="font-mono">
                        {entry.label}
                      </text>
                    )
                  }
                : undefined}
            />
          ))}
        </RechartsLineChart>
      </ChartContainer>
      {gaps.length > 0 ? <p className="px-4 pb-2 text-xs text-muted-foreground">Dashed lines span gaps of more than 21 days.</p> : null}
      {details ? (
        <div className="min-w-0 px-4 pb-3" role="region" aria-label="Selected chart point details">
          {details(selectedRow)}
        </div>
      ) : null}
      <div id={summaryId} className="sr-only">{summaryText}</div>
    </div>
  )
}

/** Keeps the last row that hover, touch, or the arrow keys made active. */
function ActiveRowListener({ onActive }: { onActive: (t: number) => void }) {
  const label = useActiveTooltipLabel()
  useEffect(() => {
    if (typeof label === 'number') onActive(label)
  }, [label, onActive])
  return null
}

function activeRow(series: ChartSeries[], t: number): ChartActiveRow {
  return {
    t,
    points: series.flatMap((entry) => {
      const point = entry.points.findLast((candidate) => candidate.t === t && isValidPoint(candidate))
      return point ? [{ series: entry, point }] : []
    }),
  }
}

function summarizeSeries(series: ChartSeries) {
  const points = series.points.filter(isValidPoint)
  if (points.length === 0) return null
  const latest = points[points.length - 1]
  const min = points.reduce((best, point) => point.y < best.y ? point : best, points[0])
  const max = points.reduce((best, point) => point.y > best.y ? point : best, points[0])
  return {
    id: series.id,
    label: series.label,
    latest,
    min,
    max,
    count: points.length,
  }
}

/** A gap longer than SEGMENT_GAP_MS starts a new segment, and a dashed connector spans it. */
function buildChartData(series: ChartSeries[]) {
  const dataByTime = new Map<number, ChartDatum>()
  const meta: SeriesMeta[] = []
  const gaps: SeriesMeta[] = []

  series.forEach((entry, index) => {
    let segment = 0
    let previousPoint: ChartPoint | undefined
    for (const point of entry.points) {
      if (!isValidPoint(point)) continue
      if (previousPoint && point.t - previousPoint.t > SEGMENT_GAP_MS) {
        const gapKey = `gap${index}_${segment}`
        gaps.push({ key: gapKey, series: entry })
        const previousDatum = dataByTime.get(previousPoint.t) ?? { t: previousPoint.t }
        previousDatum[gapKey] = previousPoint.y
        const nextDatum: ChartDatum = dataByTime.get(point.t) ?? { t: point.t }
        nextDatum[gapKey] = point.y
        dataByTime.set(point.t, nextDatum)
        segment += 1
      }
      previousPoint = point
      const key = `series${index}_${segment}`
      if (meta.at(-1)?.key !== key) meta.push({ key, series: entry })
      const datum: ChartDatum = dataByTime.get(point.t) ?? { t: point.t }
      datum[key] = point.y
      dataByTime.set(point.t, datum)
    }
  })

  return {
    data: [...dataByTime.values()].sort((left, right) => left.t - right.t),
    meta,
    gaps,
  }
}

/**
 * Where each series' end label goes: the data index of its last point, and a
 * pixel nudge so labels whose lines end close together do not overlap. The
 * nudge is worked out in value space, because Recharts only reveals pixel
 * positions one label at a time.
 */
function directLabelPositions(
  series: ChartSeries[],
  times: number[],
  { minY, maxY, plotHeight, reversed }: { minY: number; maxY: number; plotHeight: number; reversed: boolean },
) {
  const pxPerUnit = plotHeight / Math.max(1, maxY - minY)
  const ends = series.flatMap((entry) => {
    const last = entry.points.filter(isValidPoint).at(-1)
    if (!last) return []
    const naturalPx = (reversed ? last.y - minY : maxY - last.y) * pxPerUnit
    return [{ id: entry.id, index: times.indexOf(last.t), naturalPx, labelPx: naturalPx }]
  }).sort((left, right) => left.naturalPx - right.naturalPx)

  ends.forEach((end, position) => {
    const previous = ends[position - 1]
    if (previous && end.labelPx - previous.labelPx < DIRECT_LABEL_MIN_GAP_PX) end.labelPx = previous.labelPx + DIRECT_LABEL_MIN_GAP_PX
  })

  return new Map(ends.map((end) => [end.id, {
    index: end.index,
    y: (lineEndY: number) => lineEndY + (end.labelPx - end.naturalPx),
  }]))
}

function computeDomain(series: ChartSeries[], yDomain?: { min: number; max: number }) {
  let minT = Infinity
  let maxT = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const entry of series) {
    for (const point of entry.points) {
      if (!isValidPoint(point)) continue
      if (point.t < minT) minT = point.t
      if (point.t > maxT) maxT = point.t
      if (point.y < minY) minY = point.y
      if (point.y > maxY) maxY = point.y
    }
  }
  if (!Number.isFinite(minT) || !Number.isFinite(minY)) return null
  if (yDomain && Number.isFinite(yDomain.min) && Number.isFinite(yDomain.max)) {
    return { minT, maxT, minY: yDomain.min, maxY: yDomain.max }
  }
  const padY = Math.max(8, (maxY - minY) * 0.08)
  return { minT, maxT, minY: minY - padY, maxY: maxY + padY }
}

function niceTicks(min: number, max: number, count: number) {
  if (max <= min) return [min]
  const span = max - min
  const step = niceStep(span / count)
  const start = Math.ceil(min / step) * step
  const ticks: number[] = []
  for (let value = start; value <= max; value += step) ticks.push(value)
  return ticks
}

function niceStep(rough: number) {
  const pow = Math.pow(10, Math.floor(Math.log10(rough)))
  const norm = rough / pow
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10
  return nice * pow
}

function timeTicks(min: number, max: number, count: number) {
  if (max <= min) return [min]
  const step = (max - min) / (count - 1)
  return Array.from({ length: count }, (_, index) => min + step * index)
}

function isValidPoint(point: ChartSeries['points'][number]) {
  return Number.isFinite(point.t) && Number.isFinite(point.y)
}
