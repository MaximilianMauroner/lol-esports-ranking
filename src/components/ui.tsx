import type { ReactNode } from 'react'
import { Button } from './ui/button'
import { cn } from '../lib/utils'
import { Badge } from './ui/badge'
import { heatBin } from '../lib/display'

export function HeatChip({ value, min, max, label }: { value: number; min: number; max: number; label: string }) {
  return (
    <span
      className="inline-flex items-baseline gap-1 rounded-full px-[9px] py-[3px] font-mono text-[0.84rem] font-semibold text-[var(--heat-ink)] tabular-nums"
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

export function RegionBadge({ region, size = 'md' }: { region: string; size?: 'sm' | 'md' }) {
  const code = region.toUpperCase()
  const key = REGION_BADGE_KEYS.has(code) ? code : 'DEFAULT'
  const displayCode = key === 'DEFAULT' ? code.slice(0, 3) : code
  const logoSrc = REGION_BADGE_LOGOS[key]

  return (
    <span
      className={`region-badge region-badge--${key.toLowerCase()} region-badge--${size}${logoSrc ? ' has-logo' : ''}`}
      data-code-length={displayCode.length}
      role="img"
      aria-label={`${code} region badge`}
    >
      {logoSrc ? (
        <img className="region-badge__logo" src={logoSrc} alt="" aria-hidden="true" width={44} height={36} />
      ) : (
        <>
          <svg viewBox="0 0 48 40" aria-hidden="true" focusable="false">
            <BadgeMotif region={key} />
          </svg>
          <span className="region-badge__code">{displayCode}</span>
        </>
      )}
    </span>
  )
}

function BadgeMotif({ region }: { region: string }) {
  switch (region) {
    case 'LCK':
      return (
        <>
          <path className="region-badge__mark" d="M13 29 L23 11 L24 29" />
          <path className="region-badge__mark is-soft" d="M24 23 L35 12" />
          <path className="region-badge__cut" d="M30 27 L38 20" />
        </>
      )
    case 'LPL':
      return (
        <>
          <path className="region-badge__mark" d="M12 28 L20 12 H29 L21 28 H34" />
          <path className="region-badge__cut" d="M32 12 L37 12" />
        </>
      )
    case 'LEC':
      return (
        <>
          <path className="region-badge__mark" d="M34 13 A14 14 0 1 0 34 27" />
          <path className="region-badge__cut" d="M18 20 H35" />
          <circle className="region-badge__dot" cx="36" cy="20" r="2.2" />
        </>
      )
    case 'LCS':
      return (
        <>
          <path className="region-badge__mark" d="M14 12 V28 H34" />
          <path className="region-badge__cut" d="M18 13 H34 M18 20 H31 M18 27 H34" />
        </>
      )
    case 'LCP':
      return (
        <>
          <path className="region-badge__mark" d="M14 29 V12 H25 C32 12 35 16 35 20 C35 24 32 28 25 28 H14" />
          <path className="region-badge__cut" d="M24 16 V32" />
        </>
      )
    case 'CBLOL':
      return (
        <>
          <path className="region-badge__mark" d="M33 13 C29 10 20 10 16 15 C11 21 15 30 24 30 C29 30 33 28 36 24" />
          <path className="region-badge__cut" d="M17 20 H35" />
          <circle className="region-badge__dot" cx="14" cy="25" r="2" />
        </>
      )
    case 'PCS':
      return (
        <>
          <path className="region-badge__mark" d="M14 28 V12 H27 C33 12 36 15 36 20 C36 25 33 28 27 28 H14" />
          <path className="region-badge__cut" d="M18 20 H38" />
        </>
      )
    case 'VCS':
      return (
        <>
          <path className="region-badge__mark" d="M12 12 L23 29 L36 12" />
          <path className="region-badge__cut" d="M18 12 L24 22 L31 12" />
          <circle className="region-badge__dot" cx="24" cy="30" r="2" />
        </>
      )
    default:
      return (
        <>
          <path className="region-badge__mark" d="M14 29 V11 H34 V29 Z" />
          <path className="region-badge__cut" d="M14 20 H34" />
        </>
      )
  }
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
              'grid size-[17px] place-items-center rounded-[5px] text-[0.64rem] font-bold not-italic',
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
      <span className="text-[0.74rem] text-[var(--muted)] tabular-nums">{typeof value === 'number' ? `${Math.round(pct)}%` : '—'}</span>
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
        'pick-button border-[var(--line)] bg-[color-mix(in_oklch,var(--surface-2)_74%,transparent)] text-[var(--muted)] hover:border-[var(--line-strong)] hover:bg-[var(--surface-3)] hover:text-[var(--text-strong)] group-hover/gpr:border-[var(--line-strong)]',
        picked && 'border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)] group-hover/gpr:border-[var(--accent)]',
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
      className={cn('inline-flex max-w-full flex-wrap gap-1 rounded-[var(--r)] border border-[var(--line)] bg-[var(--surface-2)] p-1 max-sm:w-full max-sm:border-0 max-sm:bg-transparent max-sm:p-0', className)}
    >
      {options.map((option) => (
        <Button
          type="button"
          key={option.value}
          variant="ghost"
          size="sm"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn('rounded-[7px] text-[var(--muted)] hover:text-[var(--text)]', value === option.value && 'bg-[var(--surface-3)] text-[var(--text-strong)]')}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}

export function DataState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="grid place-items-center gap-3 px-6 py-16 text-center text-[var(--muted)] [&>h3]:text-[1.05rem] [&>h3]:text-[var(--text-strong)] [&>p]:max-w-[46ch] [&>p]:text-[0.88rem] [&>svg]:text-[var(--faint)]">
      {icon}
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
    </div>
  )
}

export function CountBadge({ children, variant = 'secondary' }: { children: ReactNode; variant?: 'default' | 'secondary' | 'warning' }) {
  return (
    <Badge variant={variant} className="w-fit justify-self-start text-[0.76rem] text-[var(--muted)] tabular-nums">
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
