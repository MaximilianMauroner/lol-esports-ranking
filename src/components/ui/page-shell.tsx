import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Body scaffolding, shared by every view.
 *
 * Rankings, Regions and Match history each rolled their own wrapper and
 * disagreed on the element (`div` vs `section`) and the gap (22px vs 16px).
 * The explanatory line that used to appear in Regions only now lives in
 * `ModeHeader`, so every view gets one.
 */
export function PageShell({
  ribbon,
  children,
  className,
  ...props
}: {
  ribbon?: ReactNode
  children: ReactNode
  className?: string
} & Omit<React.ComponentProps<'div'>, 'children'>) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-6 px-[var(--page-x)] pt-6', className)} {...props}>
      {ribbon}
      {children}
    </div>
  )
}

/**
 * The summary strip above a board. Cells are separated by the panel border
 * itself (a 1px grid gap over a `--line` background) rather than by their own
 * borders, so the strip reads as one object.
 */
export function StatRibbon({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div
      className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-px overflow-hidden rounded-[var(--r-3)] border border-[var(--line)] bg-[var(--line)]"
      aria-label={label}
    >
      {children}
    </div>
  )
}

export function StatCell({
  icon,
  label,
  value,
  detail,
}: {
  icon?: ReactNode
  label: string
  value: ReactNode
  detail?: ReactNode
}) {
  return (
    <div className="grid min-w-0 gap-0.5 bg-[var(--surface)] px-4 py-3">
      <span className="flex items-center gap-2 text-xs font-medium text-[var(--muted)] [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-[var(--faint)]">
        {icon}
        {label}
      </span>
      <b className="truncate text-lg font-bold text-[var(--text-strong)] tabular-nums">{value}</b>
      {detail ? <small className="truncate text-xs text-[var(--faint)] tabular-nums">{detail}</small> : null}
    </div>
  )
}
