import { useId, useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Button } from './ui/button'
import { ChartContainer, type ChartConfig } from './ui/chart'
import { formatChartTimestamp, formatChartTooltipTimestamp } from '../lib/chartTime'

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

type ChartDatum = { t: number } & Record<string, unknown>

/**
 * One drawn line. A series with a long gap in its data is split into several
 * segments that share its colour and label. A dashed connector marks the gap
 * without presenting the interval as a recorded trend.
 */
type SeriesMeta = {
  key: string
  series: ChartSeries
}

export type LineChartTooltipPayloadItem = {
  dataKey?: string | number
  name?: string | number
  value?: unknown
  color?: string
  payload?: ChartDatum
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
  tooltipContent?: ReactElement
  tooltipPortal?: HTMLElement | null
  tooltipWrapperStyle?: CSSProperties
  interactiveLegend?: boolean
  persistentTooltip?: boolean
}

const tickDate = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' })
/** Longer than a normal break between matches; shorter than an off-season. */
const SEGMENT_GAP_MS = 21 * 86_400_000
/** Direct labels help from two lines; past six the right edge gets crowded. */
const MAX_DIRECT_LABELS = 6
const DIRECT_LABEL_WIDTH = 52
const DIRECT_LABEL_MIN_GAP_PX = 13
const CHART_VERTICAL_CHROME_PX = 92
const fullDate = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' })

export function LineChart({
  series,
  height = 300,
  yLabel = 'Rating',
  yFormat = (value: number) => String(Math.round(value)),
  yTickFormat,
  yDomain,
  yTicks: providedYTicks,
  yReverse = false,
  curve = 'linear',
  tooltipContent,
  tooltipPortal,
  tooltipWrapperStyle,
  persistentTooltip = false,
  interactiveLegend = false,
}: LineChartProps) {
  const [focusedSeriesId, setFocusedSeriesId] = useState<string>()
  const focusedId = interactiveLegend && series.some((entry) => entry.id === focusedSeriesId) ? focusedSeriesId : undefined
  const chartId = useId().replace(/:/g, '')
  const summaryId = `${chartId}-summary`
  const domain = useMemo(() => computeDomain(series, yDomain), [series, yDomain])
  const { data, meta, gaps } = useMemo(() => buildChartData(series), [series])
  const config = useMemo<ChartConfig>(
    () =>
      Object.fromEntries(
        meta.map(({ key, series: entry }) => [
          key,
          {
            label: entry.label,
            color: entry.color,
          },
        ]),
      ),
    [meta],
  )

  if (series.length === 0 || domain === null || data.length === 0) {
    return <p className="text-muted-foreground p-5">No chart data available.</p>
  }

  const { minT, maxT, minY, maxY } = domain
  const directLabels = series.length >= 2 && series.length <= MAX_DIRECT_LABELS
    ? directLabelPositions(series, { minY, maxY, plotHeight: height - CHART_VERTICAL_CHROME_PX, reversed: yReverse })
    : undefined
  const lastSegmentKey = new Map(meta.map(({ key, series: entry }) => [entry.id, key]))
  const yTicks = providedYTicks ?? niceTicks(minY, maxY, 4)
  const formatYTick = yTickFormat ?? yFormat
  const xTicks = timeTicks(minT, maxT, 5)
  const lineType = curve === 'step' ? 'stepAfter' : 'linear'
  const summaries = series.flatMap((entry) => {
    const summary = summarizeSeries(entry)
    return summary ? [summary] : []
  })
  const summaryText = `${yLabel} chart data summary. ${summaries.map((entry) =>
    `${entry.label}: latest ${formatPointSummary(entry.latest, yFormat)}, minimum ${formatPointSummary(entry.min, yFormat)}, maximum ${formatPointSummary(entry.max, yFormat)}, ${entry.count} points.`,
  ).join(' ')}`

  return (
    <div className="chart-shell">
      {/* Names come before the lines they identify. */}
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 px-4 pt-3" role={interactiveLegend ? 'group' : undefined} aria-label={interactiveLegend ? 'Highlight a team' : undefined}>
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
      </div>
      <ChartContainer
        id={chartId}
        config={config}
        className="chart relative min-h-[220px] w-full min-w-0 aspect-auto overflow-hidden px-4 pt-4 pb-3 [&_svg]:block [&_svg]:size-full [&_svg]:touch-pan-y [&_svg]:overflow-hidden"
        style={{ height }}
        role="img"
        aria-label={`${yLabel} over time for ${series.map((entry) => entry.label).join(', ')}`}
        aria-describedby={summaryId}
      >
        <RechartsLineChart data={data} margin={{ top: 18, right: directLabels ? DIRECT_LABEL_WIDTH : 20, bottom: 16, left: 4 }}>
          <CartesianGrid vertical={false} strokeDasharray="0" />
          <XAxis
            dataKey="t"
            type="number"
            domain={[minT, maxT]}
            ticks={xTicks}
            tickLine={false}
            axisLine={false}
            minTickGap={28}
            tickFormatter={(value) => formatChartTimestamp(value, tickDate)}
          />
          <YAxis
            type="number"
            width={44}
            domain={[minY, maxY]}
            ticks={yTicks}
            reversed={yReverse}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) => formatYTick(Number(value))}
          />
          <RechartsTooltip
            cursor={{ stroke: 'var(--line-strong)' }}
            content={tooltipContent ?? <LineChartTooltip yFormat={yFormat} />}
            portal={tooltipPortal}
            wrapperStyle={tooltipWrapperStyle}
            trigger={persistentTooltip ? 'click' : 'hover'}
            defaultIndex={persistentTooltip ? data.length - 1 : undefined}
          />
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
                      <text x={props.x + 7} y={target.y(Number(props.y))} dy="0.32em" fill="var(--text)" fontSize={11} fontWeight={700} className="font-mono">
                        {entry.label}
                      </text>
                    )
                  }
                : undefined}
            />
          ))}
        </RechartsLineChart>
      </ChartContainer>
      {gaps.length > 0 ? <p className="px-4 pb-2 text-xs text-muted-foreground">Dashed lines join recorded points more than 21 days apart. No ratings are recorded between them.</p> : null}
      <div id={summaryId} className="sr-only">{summaryText}</div>

    </div>
  )
}

function chartDetailDataKey(key: string) {
  return `${key}Detail`
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

function formatPointSummary(point: ChartSeries['points'][number], formatValue: (value: number) => string) {
  return `${formatValue(point.y)} on ${formatChartTimestamp(point.t, fullDate)}`
}

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
      if (point.detail) datum[chartDetailDataKey(key)] = point.detail
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
  { minY, maxY, plotHeight, reversed }: { minY: number; maxY: number; plotHeight: number; reversed: boolean },
) {
  const times = [...new Set(series.flatMap((entry) => entry.points.filter(isValidPoint).map((point) => point.t)))].sort((left, right) => left - right)
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

function LineChartTooltip({
  active,
  payload,
  yFormat,
}: {
  active?: boolean
  payload?: LineChartTooltipPayloadItem[]
  yFormat: (value: number) => string
}) {
  if (!active || !payload?.length) return null

  const rows = payload
    .map((item) => {
      const value = Number(item.value)
      const key = String(item.dataKey ?? '')
      if (!Number.isFinite(value)) return null
      return {
        key,
        label: String(item.name ?? key),
        value,
        color: item.color ?? 'var(--muted)',
      }
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)

  if (rows.length === 0) return null

  return (
    <div className="pointer-events-none static z-2 grid gap-1 whitespace-nowrap rounded-md border border-[var(--line-strong)] bg-[color-mix(in_oklch,var(--surface)_96%,transparent)] px-3 py-2 text-sm shadow-[var(--shadow-2)]">
      <b className="mb-0.5 text-xs text-[var(--text-strong)]">{formatChartTooltipTimestamp(payload)}</b>
      <div className="grid gap-2">
        {rows.map((row) => (
          <div className="grid gap-1" key={row.key}>
            <div className="grid grid-cols-[12px_minmax(0,1fr)_minmax(70px,auto)] items-center gap-2 text-muted-foreground">
              <i className="inline-block h-[3px] w-[11px] shrink-0 rounded-full" style={{ background: row.color }} aria-hidden="true" />
              <em className="min-w-0 overflow-hidden text-ellipsis not-italic">{row.label}</em>
              <div className="grid justify-items-end gap-px">
                <strong className="text-foreground tabular-nums">{yFormat(row.value)}</strong>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
