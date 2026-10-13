import { cn } from '../lib/utils'

/**
 * The one Compare control for team and region rows: a labelled checkbox that
 * takes the shared selected treatment when picked. Rankings and Regions used
 * to ship two different controls for the same action. On phones the label
 * sits under the checkbox, like the tab bar captions, so the control stays
 * narrow without becoming an unlabelled square.
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
        'inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2 text-xs font-semibold whitespace-nowrap select-none max-sm:h-auto max-sm:flex-col max-sm:gap-0.5 max-sm:px-1 max-sm:py-1 max-sm:text-2xs',
        picked
          ? 'border-[var(--selected-line)] bg-[var(--selected-bg)] text-[var(--text-strong)]'
          : 'border-[var(--line-strong)] text-muted-foreground hover:text-foreground',
        className,
      )}
      data-slot="compare-toggle"
      data-row-click-exclude
    >
      <input type="checkbox" className="size-3.5 accent-[var(--accent)]" checked={picked} onChange={onToggle} aria-label={`Compare ${label}`} />
      <span>Compare</span>
    </label>
  )
}
