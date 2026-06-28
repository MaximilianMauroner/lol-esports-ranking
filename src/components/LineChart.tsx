import { useId, useMemo } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { ChartContainer, ChartTooltipContent, type ChartConfig } from './ui/chart'

export type ChartSeries = {
  id: string
  label: string
  color: string
  points: { t: number; y: number }[]
}

type ChartDatum = {
  t: number
  [key: string]: number
}

type SeriesMeta = {
  key: string
  series: ChartSeries
}

const tickDate = new Intl.DateTimeFormat('en', { month: 'short', year: '2-digit' })
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
}: {
  series: ChartSeries[]
  height?: number
  yLabel?: string
  yFormat?: (value: number) => string
  yTickFormat?: (value: number) => string
  yDomain?: { min: number; max: number }
  yTicks?: number[]
  yReverse?: boolean
  curve?: 'linear' | 'step'
}) {
  const chartId = useId().replace(/:/g, '')
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
    return <p className="muted" style={{ padding: 20 }}>Select teams to plot their rating over time.</p>
  }

  const { minT, maxT, minY, maxY } = domain
  const yTicks = providedYTicks ?? niceTicks(minY, maxY, 4)
  const formatYTick = yTickFormat ?? yFormat
  const xTicks = timeTicks(minT, maxT, 5)
  const lineType = curve === 'step' ? 'stepAfter' : 'linear'

  return (
    <div className="chart-shell">
      <ChartContainer
        id={chartId}
        config={config}
        className="chart chart--recharts"
        style={{ height }}
        role="img"
        aria-label={`${yLabel} over time for ${series.map((entry) => entry.label).join(', ')}`}
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
            tickFormatter={(value) => tickDate.format(new Date(Number(value)))}
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
            content={
              <ChartTooltipContent
                labelFormatter={(label) => fullDate.format(new Date(Number(label)))}
                valueFormatter={(value) => yFormat(Number(value))}
              />
            }
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

function buildChartData(series: ChartSeries[]) {
  const dataByTime = new Map<number, ChartDatum>()
  const meta: SeriesMeta[] = series.map((entry, index) => ({
    key: `series${index}`,
    series: entry,
  }))

  for (const { key, series: entry } of meta) {
    for (const point of entry.points) {
      const datum = dataByTime.get(point.t) ?? { t: point.t }
      datum[key] = point.y
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
