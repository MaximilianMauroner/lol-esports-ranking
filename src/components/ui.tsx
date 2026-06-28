import type { ChangeEvent, ReactNode } from 'react'
import { Search } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Select } from './ui/select'
import { cn } from '../lib/utils'
import { Badge } from './ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { fillClass, formatSigned, heatClass, movementClass, pctWithin } from '../lib/display'

export function HeatChip({ value, min, max, label }: { value: number; min: number; max: number; label: string }) {
  return <span className={`heat ${heatClass(value, min, max)}`}>{label}</span>
}

export function HeatBar({ value, min, max }: { value: number; min: number; max: number }) {
  return (
    <div className="heatbar" aria-hidden="true">
      <span className={`heatbar__fill ${fillClass(value, min, max)}`} style={{ width: `${pctWithin(value, min, max)}%` }} />
    </div>
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
        <img className="region-badge__logo" src={logoSrc} alt="" aria-hidden="true" />
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
          <i key={`${result}-${index}`} className={win ? 'w' : 'l'}>
            {win ? 'W' : 'L'}
          </i>
        )
      })}
    </span>
  )
}

const FACTOR_KEYS = ['context', 'recency', 'execution', 'opponent', 'league'] as const

export function FactorBars({ factors }: { factors?: Record<string, number> }) {
  if (!factors) return <span className="muted">—</span>
  return (
    <span
      className="factorbars"
      aria-label={FACTOR_KEYS.map((key) => `${key} ${Math.round((factors[key] ?? 0) * 100)}%`).join(', ')}
    >
      {FACTOR_KEYS.map((key) => (
        <i key={key} style={{ height: `${Math.max(10, Math.round((factors[key] ?? 0) * 100))}%` }} />
      ))}
    </span>
  )
}

export function Sparkline({ values }: { values?: number[] }) {
  if (!values || values.length < 2) return <span className="muted">—</span>
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const w = 92
  const h = 26
  const step = w / (values.length - 1)
  const d = values
    .map((value, index) => `${index === 0 ? 'M' : 'L'} ${(index * step).toFixed(1)} ${(h - 2 - ((value - min) / span) * (h - 4)).toFixed(1)}`)
    .join(' ')
  const trend = values[values.length - 1] - values[0]
  const stroke = trend > 0 ? 'var(--up)' : trend < 0 ? 'var(--down)' : 'var(--faint)'
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} style={{ stroke }} />
    </svg>
  )
}

export function Delta({ value }: { value?: number }) {
  if (!value) return <span className="delta flat">±0</span>
  return <span className={`delta ${movementClass(value)}`}>{formatSigned(value)}</span>
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
            'pickbtn grid size-[26px] place-items-center rounded-[8px] border border-[var(--line-strong)] bg-[var(--surface-2)] text-[var(--muted)] transition-colors hover:border-[var(--accent-line)] hover:text-[var(--accent-strong)]',
            picked && 'is-picked border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)]',
          )}
          onClick={onToggle}
          aria-pressed={picked}
          title={tooltip}
        >
          {picked ? '✓' : '+'}
          <span className="sr-only">{picked ? `Remove ${label}` : `Add ${label}`}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

type FieldOption = string | { value: string; label: string }

export function Field({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string
  value: string
  options: FieldOption[]
  onChange: (value: string) => void
  className?: string
}) {
  return (
    <label className={cn('field grid min-w-0 gap-1.5', className)}>
      <span className="pl-0.5 text-[0.68rem] uppercase tracking-[0.1em] text-[var(--faint)]">{label}</span>
      <Select value={value} onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}>
        {options.map((option) => {
          const value = typeof option === 'string' ? option : option.value
          const label = typeof option === 'string' ? option : option.label
          return (
            <option key={value} value={value}>
              {label}
            </option>
          )
        })}
      </Select>
    </label>
  )
}

export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <label className="search flex min-w-[min(220px,100%)] items-center gap-2 rounded-[var(--r)] border border-[var(--line-strong)] bg-[var(--surface-2)] px-3 py-2 text-[var(--muted)] transition-colors focus-within:border-[var(--accent-line)]">
      <Search size={17} aria-hidden="true" />
      <span className="sr-only">{placeholder}</span>
      <Input className="border-0 bg-transparent p-0 shadow-none focus-visible:ring-0" type="search" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue) onChange(nextValue as T)
      }}
      className="seg inline-flex max-w-full gap-1 overflow-x-auto rounded-[var(--r)] border border-[var(--line)] bg-[var(--surface-2)] p-1"
      role="tablist"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          role="tab"
          aria-selected={value === option.value}
          className={cn('rounded-[7px] text-[var(--muted)] hover:text-[var(--text)]', value === option.value && 'is-active bg-[var(--surface-3)] text-[var(--text-strong)]')}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
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
    <Badge variant={variant} className="count tabular-nums">
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
}: {
  label: string
  columnKey: string
  sortKey: string
  descending: boolean
  onSort: (key: string) => void
  align?: 'right' | 'center'
}) {
  const active = sortKey === columnKey
  function activateSort() {
    onSort(columnKey)
  }

  return (
    <th
      scope="col"
      className={`sortable${active ? ' is-sorted' : ''}${align ? ` ${align}` : ''}`}
      aria-sort={active ? (descending ? 'descending' : 'ascending') : 'none'}
      tabIndex={0}
      onClick={activateSort}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          activateSort()
        }
      }}
    >
      {label}
      {active ? (descending ? ' ↓' : ' ↑') : ''}
    </th>
  )
}
