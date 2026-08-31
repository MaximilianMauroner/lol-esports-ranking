import type { ReactNode } from 'react'
import { Button } from './ui/button'
import { cn } from '../lib/utils'
import { Badge } from './ui/badge'
import { heatBin } from '../lib/display'

export function HeatChip({ value, min, max, label }: { value: number; min: number; max: number; label: string }) {
  return (
    <span
      className="inline-flex items-baseline gap-1 rounded-full px-[9px] py-[3px] font-mono text-[var(--t-3)] font-semibold text-[var(--heat-ink)] tabular-nums"
      style={{ background: `var(--heat-${heatBin(value, min, max)})` }}
    >
      {label}
    </span>
  )
}

const REGION_BADGE_KEYS = new Set(['LCK', 'LPL', 'LEC', 'LCS', 'LCP', 'CBLOL', 'PCS', 'VCS'])
const REGION_BADGE_LOGOS: Partial<Record<string, string>> = {
  LCK: '/league-icons/lck.png',
  LPL: '/league-icons/lpl.png',
  LEC: '/league-icons/lec.png',
  LCS: '/league-icons/lcs.png',
  LCP: '/league-icons/lcp.png',
  CBLOL: '/league-icons/cblol.png',
}

/**
 * Every region renders in the same frame: same box, border, fill and inner
 * padding, tinted by the region hue. Only the contents differ, a league logo
 * where one exists and the region code where one does not. The badge used to
 * mix photographic logos with hand-drawn line-art motifs, which read as two
 * different products inside one column.
 */
export function RegionBadge({ region, size = 'md' }: { region: string; size?: 'sm' | 'md' }) {
  const code = region.toUpperCase()
  const key = REGION_BADGE_KEYS.has(code) ? code : 'DEFAULT'
  const displayCode = key === 'DEFAULT' ? code.slice(0, 3) : code
  const logoSrc = REGION_BADGE_LOGOS[key]

  return (
    <span
      className={`region-badge region-badge--${key.toLowerCase()} region-badge--${size}`}
      data-code-length={displayCode.length}
      role="img"
      aria-label={`${code} region badge`}
    >
      {logoSrc ? (
        <img className="region-badge__logo" src={logoSrc} alt="" aria-hidden="true" width={44} height={36} loading="lazy" />
      ) : (
        <span className="region-badge__code">{displayCode}</span>
      )}
    </span>
  )
}

export function FormDots({ form }: { form?: string[] }) {
  const recent = (form ?? []).slice(-5)
  if (recent.length === 0) return <span className="text-[var(--muted)]">—</span>
  return (
    <span className="inline-flex gap-[3px]" aria-label={`Recent form: ${recent.join(', ')}`}>
      {recent.map((result, index) => {
        const normalized = result.toLowerCase()
        const tone = normalized === 'w' ? 'w' : normalized === 't' ? 't' : 'l'
        const label = tone.toUpperCase()
        return (
          <i
            key={`${result}-${index}`}
            className={cn(
              'grid size-[17px] place-items-center rounded-[var(--r-1)] text-[var(--t-1)] font-bold not-italic',
              tone === 'w' && 'bg-[var(--win-soft)] text-[var(--win)]',
              tone === 'l' && 'bg-[var(--loss-soft)] text-[var(--loss)]',
              tone === 't' && 'bg-[var(--surface-3)] text-[var(--muted)]',
            )}
            aria-hidden="true"
          >
            {label}
          </i>
        )
      })}
    </span>
  )
}

export function ConfBar({ value }: { value?: number }) {
  const pct = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
  return (
    <span className="inline-grid min-w-[68px] gap-1">
      <span className="text-[var(--t-2)] text-[var(--muted)] tabular-nums">{typeof value === 'number' ? `${Math.round(pct)}%` : '—'}</span>
      <span className="relative h-[7px] overflow-hidden rounded-full bg-[var(--surface-3)]" aria-hidden="true">
        <span
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-400 ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={{ width: `${pct}%`, background: `var(--heat-${heatBin(pct, 0, 100)})` }}
        />
      </span>
    </span>
  )
}

export function PickButton({ picked, onToggle, label }: { picked: boolean; onToggle: () => void; label: string }) {
  const tooltip = picked ? `Remove ${label} from comparison` : `Add ${label} to comparison`
  return (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      className={cn(
        'pick-button',
        picked && 'border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent)]',
      )}
      onClick={onToggle}
      aria-label={tooltip}
      aria-pressed={picked}
      title={tooltip}
    >
      <span aria-hidden="true">{picked ? '✓' : '+'}</span>
    </Button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel = 'Filter options',
  className,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  ariaLabel?: string
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        // The segments are clipped by the container's radius instead of
        // carrying their own. A rounded child inset inside a rounded parent
        // only looks right when its radius is exactly outer minus the inset,
        // which here is 8px - (1px border + 4px padding) = 3px, off the scale.
        // Removing the inset removes the problem: there is one radius, and the
        // active segment inherits its corners from the container.
        'inline-flex h-[var(--control-h)] max-w-full items-stretch overflow-hidden rounded-[var(--r-2)] border border-[var(--line-strong)] bg-[var(--surface-2)] max-sm:w-full',
        className,
      )}
    >
      {options.map((option, index) => (
        <Button
          type="button"
          key={option.value}
          variant="tab"
          size="sm"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            // Fill and text carry the selection, with no ring. An inset ring on
            // a square-cornered child inside a clipped rounded parent gets its
            // corners sliced off by the clip rather than following the curve,
            // which reads as a square ring inside a rounded box.
            'h-auto min-h-0 flex-1 rounded-none border-y-0 border-r-0 border-l border-l-[var(--line)] px-3 max-sm:min-w-0',
            'aria-pressed:bg-[color-mix(in_oklch,var(--accent)_22%,var(--surface))] aria-pressed:font-semibold aria-pressed:text-[var(--text-strong)]',
            index === 0 && 'border-l-0',
          )}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}

/**
 * Every empty, missing and error state in the product. The `action` slot exists
 * so that a retry button no longer forces a caller to hand-build its own empty
 * state: Match history and the snapshot error screen each had their own.
 */
export function DataState({
  icon,
  title,
  action,
  children,
}: {
  icon: ReactNode
  title: string
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="grid place-items-center gap-3 px-6 py-16 text-center text-[var(--muted)] [&>h3]:text-[var(--t-5)] [&>h3]:font-semibold [&>h3]:text-[var(--text-strong)] [&>p]:max-w-[46ch] [&>p]:text-[var(--t-3)] [&>svg]:text-[var(--faint)]">
      {icon}
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action ? <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  )
}

export function CountBadge({ children, variant = 'secondary' }: { children: ReactNode; variant?: 'default' | 'secondary' | 'warning' }) {
  return (
    <Badge variant={variant} className="w-fit justify-self-start text-[var(--t-2)] text-[var(--muted)] tabular-nums">
      {children}
    </Badge>
  )
}

export function SortHeader({
  label,
  columnKey,
  sortKey,
  descending,
  onSort,
  align,
  className,
}: {
  label: string
  columnKey: string
  sortKey: string
  descending: boolean
  onSort: (key: string) => void
  align?: 'right' | 'center'
  className?: string
}) {
  const active = sortKey === columnKey
  function activateSort() {
    onSort(columnKey)
  }

  return (
    <th
      scope="col"
      className={cn(
        'select-none p-0!',
        active && 'text-[var(--accent-strong)]',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
      aria-sort={active ? (descending ? 'descending' : 'ascending') : 'none'}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          'min-h-10 w-full cursor-pointer justify-start gap-1 border-0 bg-transparent px-3.5 py-[11px] font-[inherit] tracking-[inherit] text-[inherit] uppercase hover:bg-transparent hover:text-[var(--text)] focus-visible:rounded-none focus-visible:text-[var(--text)] focus-visible:outline-2 focus-visible:-outline-offset-3 focus-visible:outline-[var(--focus)] max-sm:px-[3px] max-sm:leading-[1.15] max-sm:whitespace-normal',
          align === 'right' && 'justify-end',
          align === 'center' && 'justify-center',
        )}
        onClick={activateSort}
      >
        <span>{label}</span>
        {active ? <span aria-hidden="true">{descending ? '↓' : '↑'}</span> : null}
      </Button>
    </th>
  )
}
