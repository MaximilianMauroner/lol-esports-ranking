import type { ReactNode } from 'react'
import { Button } from './ui/button'
import { cn } from '../lib/utils'
import { Badge } from './ui/badge'
import { tableHeadClassName } from './ui/table'
import { heatBin } from '../lib/display'

export function HeatChip({ value, min, max, label }: { value: number; min: number; max: number; label: string }) {
  return (
    <span
      className="inline-flex items-baseline gap-1 rounded-full px-2 py-1 font-mono text-sm font-semibold text-[var(--heat-ink)] tabular-nums"
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
  if (recent.length === 0) return <span className="text-muted-foreground">—</span>
  return (
    <span className="inline-flex gap-1" aria-label={`Recent form: ${recent.join(', ')}`}>
      {recent.map((result, index) => {
        const normalized = result.toLowerCase()
        const tone = normalized === 'w' ? 'w' : normalized === 't' ? 't' : 'l'
        const label = tone.toUpperCase()
        return (
          <i
            key={`${result}-${index}`}
            className={cn(
              'grid size-[17px] place-items-center rounded-sm text-2xs font-bold not-italic',
              tone === 'w' && 'bg-[var(--win-soft)] text-[var(--win)]',
              tone === 'l' && 'bg-[var(--loss-soft)] text-[var(--loss)]',
              tone === 't' && 'bg-[var(--surface-3)] text-muted-foreground',
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

export type SegmentedOption<T extends string> = {
  value: T
  label: string
  title?: string
  disabled?: boolean
  /** Small trailing mark, such as the live dot on an ongoing split. */
  marker?: ReactNode
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  onIntent,
  ariaLabel = 'Filter options',
  className,
}: {
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  /** Hover or focus on an option, for prefetching what it would show. */
  onIntent?: (value: T) => void
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
        'inline-flex h-[var(--control-h)] max-w-full items-stretch overflow-hidden rounded-md border border-[var(--line-strong)] bg-[var(--surface-2)] max-sm:w-full',
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
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
          onPointerEnter={onIntent ? () => onIntent(option.value) : undefined}
          onFocus={onIntent ? () => onIntent(option.value) : undefined}
          className={cn(
            // Fill and text carry the selection, with no ring. An inset ring on
            // a square-cornered child inside a clipped rounded parent gets its
            // corners sliced off by the clip rather than following the curve,
            // which reads as a square ring inside a rounded box.
            'h-auto min-h-0 flex-1 gap-1.5 rounded-none border-y-0 border-r-0 border-l border-l-border px-3 whitespace-nowrap max-sm:min-w-0 max-sm:px-2',
            'disabled:opacity-60',
            index === 0 && 'border-l-0',
          )}
        >
          {option.label}
          {option.marker}
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
    <div className="grid place-items-center gap-3 px-6 py-16 text-center text-muted-foreground [&>h3]:text-base [&>h3]:font-semibold [&>h3]:text-[var(--text-strong)] [&>p]:max-w-[46ch] [&>p]:text-sm [&>svg]:text-[var(--faint)]">
      {icon}
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action ? <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  )
}

export function CountBadge({ children, variant = 'secondary' }: { children: ReactNode; variant?: 'secondary' | 'warning' }) {
  return (
    <Badge variant={variant} className="w-fit justify-self-start text-xs text-muted-foreground tabular-nums">
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
        tableHeadClassName,
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
          'min-h-10 w-full cursor-pointer justify-start gap-1 border-0 bg-transparent px-3.5 py-3 font-[inherit] text-2xs font-semibold tracking-label text-[inherit] uppercase hover:bg-transparent hover:text-foreground focus-visible:rounded-none focus-visible:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-3 focus-visible:outline-[var(--focus)] max-sm:px-1 max-sm:leading-[1.15] max-sm:whitespace-normal',
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
