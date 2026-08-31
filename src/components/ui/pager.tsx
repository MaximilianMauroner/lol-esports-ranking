import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { Button } from './button'
import { Select } from './select'
import { cn } from '@/lib/utils'

/**
 * The one pagination control.
 *
 * There used to be three shapes: the team board (rows-per-page select, four
 * edge buttons, "Page X of Y"), the match ledger (a range label, two buttons,
 * and its rows-per-page select stranded in the filter card above), and the
 * recent-matches list inside the team drawer (the board's markup with a pile of
 * size overrides). They now differ only in `density` and in which optional
 * slots are supplied.
 *
 * `rangeLabel` is shown alongside the page counter rather than instead of it.
 * Both answers matter: which page you are on, and which rows you are looking at.
 */
export function Pager({
  page,
  pageCount,
  onPage,
  pageSize,
  pageSizes,
  onPageSize,
  rangeLabel,
  label,
  density = 'default',
  className,
}: {
  page: number
  pageCount: number
  onPage: (page: number) => void
  pageSize?: number
  pageSizes?: readonly number[]
  onPageSize?: (size: number) => void
  rangeLabel?: string
  label: string
  density?: 'default' | 'compact'
  className?: string
}) {
  const showSize = Boolean(pageSizes && onPageSize && pageSize)
  const atStart = page <= 1
  const atEnd = page >= pageCount

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[var(--muted)]',
        '[--pager-h:32px]',
        density === 'compact' && '[--pager-h:28px] text-xs',
        className,
      )}
      aria-label={label}
    >
      {showSize ? (
        <label className="inline-flex items-center gap-2 [&_[data-slot=select]]:h-[var(--pager-h)] [&_[data-slot=select]]:min-w-[74px] [&_[data-slot=select]]:pl-2.5 [&_[data-slot=select]]:text-xs">
          <span className="whitespace-nowrap font-medium text-[var(--text)]">Rows</span>
          <Select value={String(pageSize)} onChange={(event) => onPageSize?.(Number(event.target.value))} aria-label="Rows per page">
            {pageSizes?.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </label>
      ) : null}

      {rangeLabel ? <span className="whitespace-nowrap tabular-nums">{rangeLabel}</span> : null}

      <div className="ml-auto flex items-center gap-2">
        <span className="inline-flex h-[var(--pager-h)] items-center justify-center whitespace-nowrap px-1 font-medium text-[var(--text)] tabular-nums">
          Page {page} of {pageCount}
        </span>
        <div className="inline-flex items-center gap-1.5 [&_[data-slot=button]]:size-[var(--pager-h)]">
          <Button type="button" variant="outline" size="icon" className="max-[720px]:hidden" onClick={() => onPage(1)} disabled={atStart} aria-label="First page">
            <ChevronsLeft aria-hidden="true" />
          </Button>
          <Button type="button" variant="outline" size="icon" onClick={() => onPage(page - 1)} disabled={atStart} aria-label="Previous page">
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button type="button" variant="outline" size="icon" onClick={() => onPage(page + 1)} disabled={atEnd} aria-label="Next page">
            <ChevronRight aria-hidden="true" />
          </Button>
          <Button type="button" variant="outline" size="icon" className="max-[720px]:hidden" onClick={() => onPage(pageCount)} disabled={atEnd} aria-label="Last page">
            <ChevronsRight aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  )
}
