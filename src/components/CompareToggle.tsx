import { cn } from '../lib/utils'

/**
 * The one Compare control for team and region rows: a labelled checkbox that
 * takes the shared selected treatment when picked. Rankings and Regions used
 * to ship two different controls for the same action.
 */
export function CompareToggle({
  picked,
  onToggle,
  label,
  className,
}: {
  picked: boolean
  onToggle: () => void
  label: string
  className?: string
}) {
  return (
    <label
      className={cn(
        'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs font-semibold whitespace-nowrap select-none',
        picked
          ? 'border-[var(--selected-line)] bg-[var(--selected-bg)] text-[var(--text-strong)]'
          : 'border-[var(--line-strong)] text-muted-foreground hover:text-foreground',
        className,
      )}
      data-row-click-exclude
    >
      <input type="checkbox" className="size-3.5 accent-[var(--accent)]" checked={picked} onChange={onToggle} aria-label={`Compare ${label}`} />
      <span className="max-sm:sr-only">Compare</span>
    </label>
  )
}
