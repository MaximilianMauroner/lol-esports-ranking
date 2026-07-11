import { useId, useMemo, type ReactElement } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'
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
}

const tickDate = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' })
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
}: LineChartProps) {
  const chartId = useId().replace(/:/g, '')
  const summaryId = `${chartId}-summary`
  const domain = useMemo(() => computeDomain(series, yDomain), [series, yDomain])
  const { data, meta } = useMemo(() => buildChartData(series), [series])
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
    return <p className="muted p-5">No chart data available.</p>
  }

  const { minT, maxT, minY, maxY } = domain
  const yTicks = providedYTicks ?? niceTicks(minY, maxY, 4)
  const formatYTick = yTickFormat ?? yFormat
  const xTicks = timeTicks(minT, maxT, 5)
  const lineType = curve === 'step' ? 'stepAfter' : 'linear'
  const summaries = meta.flatMap(({ series: entry }) => {
    const summary = summarizeSeries(entry)
    return summary ? [summary] : []
  })
  const summaryText = `${yLabel} chart data summary. ${summaries.map((entry) =>
    `${entry.label}: latest ${formatPointSummary(entry.latest, yFormat)}, minimum ${formatPointSummary(entry.min, yFormat)}, maximum ${formatPointSummary(entry.max, yFormat)}, ${entry.count} points.`,
  ).join(' ')}`

  return (
    <div className="chart-shell">
      <ChartContainer
        id={chartId}
        config={config}
        className="chart chart--recharts"
        style={{ height }}
        role="img"
        aria-label={`${yLabel} over time for ${series.map((entry) => entry.label).join(', ')}`}
        aria-describedby={summaryId}
      >
        <RechartsLineChart data={data} margin={{ top: 18, right: 20, bottom: 16, left: 4 }}>
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
            cursor={{ stroke: 'var(--line-strong)', strokeDasharray: '3 3' }}
            content={tooltipContent ?? <LineChartTooltip yFormat={yFormat} />}
          />
          {meta.map(({ key, series: entry }) => (
            <Line
              key={entry.id}
              dataKey={key}
              name={entry.label}
              type={lineType}
              stroke={`var(--color-${key})`}
              strokeWidth={2.4}
              connectNulls
              dot={entry.points.length <= 36 && series.length <= 2 ? { r: 3.2, strokeWidth: 2 } : false}
              activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          ))}
        </RechartsLineChart>
      </ChartContainer>
      <div id={summaryId} className="sr-only">{summaryText}</div>

      <div className="chart__legend">
        {meta.map(({ key, series: entry }) => (
          <span className="chart__key" key={entry.id}>
            <i style={{ background: `var(--color-${key})` }} aria-hidden="true" />
            {entry.label}
          </span>
        ))}
      </div>
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
  const meta: SeriesMeta[] = series.map((entry, index) => ({
    key: `series${index}`,
    series: entry,
  }))

  for (const { key, series: entry } of meta) {
    for (const point of entry.points) {
      if (!isValidPoint(point)) continue
      const datum: ChartDatum = dataByTime.get(point.t) ?? { t: point.t }
      datum[key] = point.y
      if (point.detail) datum[chartDetailDataKey(key)] = point.detail
      dataByTime.set(point.t, datum)
    }
  }

  return {
    data: [...dataByTime.values()].sort((left, right) => left.t - right.t),
    meta,
  }
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
    <div className="chart__tooltip">
      <b>{formatChartTooltipTimestamp(payload)}</b>
      <div className="chart__tooltip-list">
        {rows.map((row) => (
          <div className="chart__tooltip-row" key={row.key}>
            <div className="chart__tooltip-main">
              <i style={{ background: row.color }} aria-hidden="true" />
              <em>{row.label}</em>
              <div className="chart__tooltip-value">
                <strong>{yFormat(row.value)}</strong>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
