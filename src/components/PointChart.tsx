import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
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
/** Keeps the tooltip off the window edge. */
const VIEWPORT_MARGIN = 8

/**
 * The hover model of the line charts for a hand-drawn SVG chart of points.
 * Pointer and touch snap to the nearest point, a crosshair marks its value,
 * and the tooltip is a polite live region beside the point. The chart is one
 * tab stop: the arrow keys move between points, and Enter selects one.
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
  const svgRef = useRef<SVGSVGElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const summaryId = useId()
  // The point as a share of the chart's width and height.
  const anchorX = active ? active.x / width : undefined
  const anchorY = active ? active.y / height : undefined

  useLayoutEffect(() => placeTooltip(svgRef.current, tooltipRef.current, anchorX, anchorY))
  useEffect(() => {
    if (anchorX === undefined || anchorY === undefined) return
    // Scrolling, resizing and content loading above the chart all move the point, so the tooltip follows it each frame while it shows.
    let frame = requestAnimationFrame(function follow() {
      placeTooltip(svgRef.current, tooltipRef.current, anchorX, anchorY)
      frame = requestAnimationFrame(follow)
    })
    return () => cancelAnimationFrame(frame)
  }, [anchorX, anchorY])

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
    <div className="min-w-0">
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
      {/* The live region stays mounted so screen readers hear each new point, as in the line charts.
          It is a portal, so a short chart or an overflow-hidden panel cannot clip the tooltip. */}
      {typeof document === 'undefined' ? null : createPortal(
        <div role="status" aria-live="polite">
          {active ? (
            <div
              ref={tooltipRef}
              className="pointer-events-none fixed top-0 left-0 z-50 grid w-max max-w-[min(17rem,calc(100vw-1rem))] gap-1.5 rounded-md border border-border/50 bg-background px-2.5 py-2 text-xs shadow-xl"
            >
              {tooltip(active)}
            </div>
          ) : null}
        </div>,
        document.body,
      )}
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
  if (key === 'Home') return targets[0]
  if (key === 'End') return targets.at(-1)
  if (!active) return targets[0]
  const rowTargets = (row: number) => targets.filter((target) => target.row === row).toSorted((left, right) => left.x - right.x)
  const row = rowTargets(active.row)
  const index = row.indexOf(active)
  if (key === 'ArrowLeft') return row[index - 1] ?? active
  if (key === 'ArrowRight') return row[index + 1] ?? active
  const rows = [...new Set(targets.map((target) => target.row))].sort((left, right) => left - right)
  const nextRow = rows[rows.indexOf(active.row) + (key === 'ArrowDown' ? 1 : -1)]
  if (nextRow === undefined) return active
  return rowTargets(nextRow).reduce((best, target) => Math.abs(target.x - active.x) < Math.abs(best.x - active.x) ? target : best)
}

/**
 * Beside the point when there is room, else above or below it, always inside
 * the window. Hidden while the point is scrolled out of view.
 */
function placeTooltip(svg: SVGSVGElement | null, tip: HTMLDivElement | null, anchorX: number | undefined, anchorY: number | undefined) {
  if (!svg || !tip || anchorX === undefined || anchorY === undefined) return
  const chart = svg.getBoundingClientRect()
  const x = chart.left + anchorX * chart.width
  const y = chart.top + anchorY * chart.height
  const view = { width: document.documentElement.clientWidth, height: window.innerHeight }
  setStyle(tip, 'visibility', y < 0 || y > view.height ? 'hidden' : 'visible')
  const width = tip.offsetWidth
  const height = tip.offsetHeight
  const clamp = (value: number, size: number, max: number) => Math.min(Math.max(VIEWPORT_MARGIN, value), Math.max(VIEWPORT_MARGIN, max - size - VIEWPORT_MARGIN))
  const right = x + TOOLTIP_GAP
  const left = x - TOOLTIP_GAP - width
  let position: { left: number; top: number }
  if (right + width <= view.width - VIEWPORT_MARGIN) position = { left: right, top: clamp(y - height / 2, height, view.height) }
  else if (left >= VIEWPORT_MARGIN) position = { left, top: clamp(y - height / 2, height, view.height) }
  else {
    const above = y - TOOLTIP_GAP - height
    position = { left: clamp(x - width / 2, width, view.width), top: above >= VIEWPORT_MARGIN ? above : clamp(y + TOOLTIP_GAP, height, view.height) }
  }
  setStyle(tip, 'left', `${position.left}px`)
  setStyle(tip, 'top', `${position.top}px`)
}

/** Writes only a changed value, so following an unmoved point costs no style work. */
function setStyle(element: HTMLElement, property: 'left' | 'top' | 'visibility', value: string) {
  if (element.style[property] !== value) element.style[property] = value
}
