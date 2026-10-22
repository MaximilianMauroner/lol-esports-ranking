import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { cn } from '../shared/utils'

/** A point the reader can make active, in viewBox units. */
export type ChartTarget = {
  key: string
  x: number
  y: number
  /** Targets with the same row are one line of the chart. Up and Down move between rows. */
  row: number
}

const TOOLTIP_GAP = 12

/**
 * The hover model of the line charts for a hand-drawn SVG chart of points.
 * Pointer and touch snap to the nearest point, a crosshair marks its value,
 * and the tooltip is a polite live region inside the chart box. The chart is
 * one tab stop: the arrow keys move between points, and Enter selects one.
 *
 * `targets` come in reading order. Keyboard focus starts on the first one.
 */
export function PointChart<T extends ChartTarget>({
  width,
  height,
  targets,
  crosshair,
  label,
  summary,
  tooltip,
  onSelect,
  className,
  children,
}: {
  width: number
  height: number
  targets: readonly T[]
  /** Vertical extent of the crosshair, in viewBox units. */
  crosshair: { top: number; bottom: number }
  label: string
  summary?: string
  tooltip: (target: T) => ReactNode
  onSelect?: (target: T) => void
  className?: string
  children: (active: T | undefined) => ReactNode
}) {
  const [activeKey, setActiveKey] = useState<string>()
  const active = targets.find((target) => target.key === activeKey)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const summaryId = useId()

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current
    const svg = svgRef.current
    const tip = tooltipRef.current
    if (!active || !wrapper || !svg || !tip) return
    const position = tooltipPosition({
      anchor: { x: active.x * svg.clientWidth / width, y: active.y * svg.clientWidth / width },
      tooltip: { width: tip.offsetWidth, height: tip.offsetHeight },
      bounds: { width: wrapper.clientWidth, height: wrapper.clientHeight },
    })
    tip.style.left = `${position.left}px`
    tip.style.top = `${position.top}px`
  })

  function targetAt(event: { clientX: number; clientY: number }) {
    const matrix = svgRef.current?.getScreenCTM()
    if (!matrix) return undefined
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
    return nearestTarget(targets, point.x, point.y)
  }

  function onPointer(event: PointerEvent<SVGSVGElement>) {
    const target = targetAt(event)
    if (target) setActiveKey(target.key)
  }

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    if ((event.key === 'Enter' || event.key === ' ') && active && onSelect) {
      event.preventDefault()
      onSelect(active)
      return
    }
    if (event.key === 'Escape') {
      setActiveKey(undefined)
      return
    }
    const next = keyboardTarget(targets, active, event.key)
    if (!next) return
    event.preventDefault()
    setActiveKey(next.key)
  }

  return (
    <div ref={wrapperRef} className="relative min-w-0">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className={cn('block h-auto w-full touch-pan-y', onSelect ? 'cursor-pointer' : undefined, className)}
        role="application"
        tabIndex={0}
        aria-label={label}
        aria-describedby={summary ? summaryId : undefined}
        onPointerDown={onPointer}
        onPointerMove={onPointer}
        // Touch leaves the tooltip up after the finger lifts. The emulated mouse leaves when the reader taps elsewhere.
        onMouseLeave={() => setActiveKey(undefined)}
        onFocus={(event) => {
          if (!activeKey && event.currentTarget.matches(':focus-visible')) setActiveKey(targets[0]?.key)
        }}
        onBlur={() => setActiveKey(undefined)}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          const target = onSelect ? targetAt(event) : undefined
          if (target) onSelect?.(target)
        }}
      >
        {summary ? <desc id={summaryId}>{summary}</desc> : null}
        {active ? (
          <line x1={active.x} x2={active.x} y1={crosshair.top} y2={crosshair.bottom} stroke="var(--line-strong)" strokeWidth={1} pointerEvents="none" />
        ) : null}
        {children(active)}
      </svg>
      {/* The live region stays mounted so screen readers hear each new point, as in the line charts. */}
      <div role="status" aria-live="polite">
        {active ? (
          <div
            ref={tooltipRef}
            className="pointer-events-none absolute top-0 left-0 z-10 grid w-max max-w-[min(17rem,100%)] gap-1.5 rounded-md border border-border/50 bg-background px-2.5 py-2 text-xs shadow-xl"
          >
            {tooltip(active)}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** The nearest row first, then the nearest point in that row. */
function nearestTarget<T extends ChartTarget>(targets: readonly T[], x: number, y: number) {
  let row: number | undefined
  let rowDistance = Infinity
  for (const target of targets) {
    const distance = Math.abs(target.y - y)
    if (distance < rowDistance) {
      rowDistance = distance
      row = target.row
    }
  }
  let best: T | undefined
  let bestDistance = Infinity
  for (const target of targets) {
    if (target.row !== row) continue
    const distance = Math.hypot(target.x - x, target.y - y)
    if (distance < bestDistance) {
      bestDistance = distance
      best = target
    }
  }
  return best
}

function keyboardTarget<T extends ChartTarget>(targets: readonly T[], active: T | undefined, key: string) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return undefined
  if (!active) return targets[0]
  const rowTargets = (row: number) => targets.filter((target) => target.row === row).toSorted((left, right) => left.x - right.x)
  const row = rowTargets(active.row)
  const index = row.indexOf(active)
  if (key === 'ArrowLeft') return row[index - 1] ?? active
  if (key === 'ArrowRight') return row[index + 1] ?? active
  if (key === 'Home') return row[0]
  if (key === 'End') return row.at(-1)
  const rows = [...new Set(targets.map((target) => target.row))].sort((left, right) => left - right)
  const nextRow = rows[rows.indexOf(active.row) + (key === 'ArrowDown' ? 1 : -1)]
  if (nextRow === undefined) return active
  return rowTargets(nextRow).reduce((best, target) => Math.abs(target.x - active.x) < Math.abs(best.x - active.x) ? target : best)
}

/**
 * Beside the point when there is room, else above or below it. Always inside
 * the chart box, as the line chart tooltip stays inside its chart.
 */
function tooltipPosition({ anchor, tooltip, bounds }: {
  anchor: { x: number; y: number }
  tooltip: { width: number; height: number }
  bounds: { width: number; height: number }
}) {
  const clamp = (value: number, max: number) => Math.min(Math.max(0, max), Math.max(0, value))
  const right = anchor.x + TOOLTIP_GAP
  const left = anchor.x - TOOLTIP_GAP - tooltip.width
  if (right + tooltip.width <= bounds.width || left >= 0) {
    return {
      left: right + tooltip.width <= bounds.width ? right : left,
      top: clamp(anchor.y - tooltip.height / 2, bounds.height - tooltip.height),
    }
  }
  const above = anchor.y - TOOLTIP_GAP - tooltip.height
  return {
    left: clamp(anchor.x - tooltip.width / 2, bounds.width - tooltip.width),
    top: above >= 0 ? above : clamp(anchor.y + TOOLTIP_GAP, bounds.height - tooltip.height),
  }
}
