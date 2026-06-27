import { useId, useMemo, useRef, useState } from 'react'

export type ChartSeries = {
  id: string
  label: string
  color: string
  points: { t: number; y: number }[]
}

type Hover = { x: number; t: number }

const W = 920
const PAD = { top: 18, right: 20, bottom: 30, left: 46 }

const tickDate = new Intl.DateTimeFormat('en', { month: 'short', year: '2-digit' })
const fullDate = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' })

/** Hand-rolled responsive multi-line chart with a shared hover readout. */
export function LineChart({
  series,
  height = 300,
  yLabel = 'Rating',
  yFormat = (value: number) => String(Math.round(value)),
  yDomain,
}: {
  series: ChartSeries[]
  height?: number
  yLabel?: string
  yFormat?: (value: number) => string
  yDomain?: { min: number; max: number }
}) {
  const gradientId = useId()
  const svgRef = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<Hover | null>(null)

  const domain = useMemo(() => computeDomain(series, yDomain), [series, yDomain])

  if (series.length === 0 || domain === null) {
    return <p className="muted" style={{ padding: 20 }}>Select teams to plot their rating over time.</p>
  }

  const { minT, maxT, minY, maxY } = domain
  const plotW = W - PAD.left - PAD.right
  const plotH = height - PAD.top - PAD.bottom
  const xOf = (t: number) => PAD.left + ((t - minT) / (maxT - minT || 1)) * plotW
  const yOf = (y: number) => PAD.top + (1 - (y - minY) / (maxY - minY || 1)) * plotH

  const yTicks = niceTicks(minY, maxY, 4)
  const xTicks = timeTicks(minT, maxT, 5)

  function onMove(event: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const px = ((event.clientX - rect.left) / rect.width) * W
    if (px < PAD.left || px > W - PAD.right) {
      setHover(null)
      return
    }
    const t = minT + ((px - PAD.left) / plotW) * (maxT - minT)
    setHover({ x: px, t })
  }

  const readout = hover
    ? series
        .map((s) => ({ series: s, point: nearestPoint(s.points, hover.t) }))
        .filter((entry): entry is { series: ChartSeries; point: { t: number; y: number } } => entry.point !== null)
    : []

  return (
    <div className="chart">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${yLabel} over time for ${series.map((s) => s.label).join(', ')}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {yTicks.map((tick) => (
          <g key={`y-${tick}`}>
            <line className="chart__grid" x1={PAD.left} x2={W - PAD.right} y1={yOf(tick)} y2={yOf(tick)} />
            <text className="chart__axis" x={PAD.left - 8} y={yOf(tick)} textAnchor="end" dominantBaseline="middle">
              {yFormat(tick)}
            </text>
          </g>
        ))}

        {xTicks.map((tick) => (
          <text key={`x-${tick}`} className="chart__axis" x={xOf(tick)} y={height - 10} textAnchor="middle">
            {tickDate.format(new Date(tick))}
          </text>
        ))}

        {series.length === 1 ? (
          <path
            d={`${linePath(series[0].points, xOf, yOf)} L ${xOf(series[0].points.at(-1)!.t)} ${yOf(minY)} L ${xOf(series[0].points[0].t)} ${yOf(minY)} Z`}
            fill={`url(#${gradientId})`}
            stroke="none"
          />
        ) : null}

        {series.map((s) => (
          <path key={s.id} className="chart__line" d={linePath(s.points, xOf, yOf)} stroke={s.color} fill="none" />
        ))}

        {series.length <= 2 ? series.flatMap((s) => (
          s.points.length <= 36
            ? s.points.map((point, index) => (
                <circle
                  key={`${s.id}-${index}-${point.t}-${point.y}`}
                  className="chart__point"
                  cx={xOf(point.t)}
                  cy={yOf(point.y)}
                  r={3.4}
                  fill={s.color}
                />
              ))
            : []
        )) : null}

        {hover ? (
          <line className="chart__cursor" x1={hover.x} x2={hover.x} y1={PAD.top} y2={height - PAD.bottom} />
        ) : null}

        {readout.map((entry) => (
          <circle
            key={entry.series.id}
            cx={xOf(entry.point.t)}
            cy={yOf(entry.point.y)}
            r={3.5}
            fill="var(--surface)"
            stroke={entry.series.color}
            strokeWidth={2}
          />
        ))}
      </svg>

      <div className="chart__legend">
        {series.map((s) => (
          <span className="chart__key" key={s.id}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>

      {hover && readout.length > 0 ? (
        <div className="chart__readout" style={{ left: `${(hover.x / W) * 100}%` }}>
          <b>{fullDate.format(new Date(hover.t))}</b>
          {readout
            .slice()
            .sort((a, b) => b.point.y - a.point.y)
            .map((entry) => (
              <span key={entry.series.id}>
                <i style={{ background: entry.series.color }} />
                {entry.series.label}
                <strong>{yFormat(entry.point.y)}</strong>
              </span>
            ))}
        </div>
      ) : null}
    </div>
  )
}

function computeDomain(series: ChartSeries[], yDomain?: { min: number; max: number }) {
  let minT = Infinity
  let maxT = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const s of series) {
    for (const point of s.points) {
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

function linePath(points: { t: number; y: number }[], xOf: (t: number) => number, yOf: (y: number) => number) {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xOf(point.t).toFixed(1)} ${yOf(point.y).toFixed(1)}`).join(' ')
}

function nearestPoint(points: { t: number; y: number }[], t: number) {
  if (points.length === 0) return null
  let best = points[0]
  let bestDist = Math.abs(points[0].t - t)
  for (const point of points) {
    const dist = Math.abs(point.t - t)
    if (dist < bestDist) {
      best = point
      bestDist = dist
    }
  }
  return best
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
