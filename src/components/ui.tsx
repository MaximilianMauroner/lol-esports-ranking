import type { ReactNode } from 'react'
import { Button } from './ui/button'
import { cn } from '../lib/utils'
import { Badge } from './ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { fillClass, heatClass } from '../lib/display'

export function HeatChip({ value, min, max, label }: { value: number; min: number; max: number; label: string }) {
  return <span className={`heat ${heatClass(value, min, max)}`}>{label}</span>
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
  if (recent.length === 0) return <span className="muted">—</span>
  return (
    <span className="formdots" aria-label={`Recent form: ${recent.join(', ')}`}>
      {recent.map((result, index) => {
        const win = result.toLowerCase() === 'w'
        return (
          <i key={`${result}-${index}`} className={win ? 'w' : 'l'} aria-hidden="true">
            {win ? 'W' : 'L'}
          </i>
        )
      })}
    </span>
  )
}

export function ConfBar({ value }: { value?: number }) {
  const pct = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
  return (
    <span className="confbar">
      <span>{typeof value === 'number' ? `${Math.round(pct)}%` : '—'}</span>
      <span className="heatbar" aria-hidden="true">
        <span className={`heatbar__fill ${fillClass(pct, 0, 100)}`} style={{ width: `${pct}%` }} />
      </span>
    </span>
  )
}

export function PickButton({ picked, onToggle, label }: { picked: boolean; onToggle: () => void; label: string }) {
  const tooltip = picked ? `Remove ${label} from comparison` : `Add ${label} to comparison`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className={cn(
            'pick-button text-[var(--muted)]',
            picked && 'border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)]',
          )}
          onClick={onToggle}
          aria-label={tooltip}
          aria-pressed={picked}
          title={tooltip}
        >
          <span aria-hidden="true">{picked ? '✓' : '+'}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
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
    <div className="state grid place-items-center gap-3 px-6 py-16 text-center text-[var(--muted)]">
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
      className={`sortable${active ? ' is-sorted' : ''}${align ? ` ${align}` : ''}${className ? ` ${className}` : ''}`}
      aria-sort={active ? (descending ? 'descending' : 'ascending') : 'none'}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="sort-button"
        onClick={activateSort}
      >
        <span>{label}</span>
        {active ? <span aria-hidden="true">{descending ? '↓' : '↑'}</span> : null}
      </Button>
    </th>
  )
}
