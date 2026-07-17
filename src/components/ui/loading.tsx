import { BarChart3 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card } from './card'
import { Skeleton } from './skeleton'

type LoadingPresentation = 'page' | 'panel' | 'rows' | 'chart' | 'inline'

type LoadingStateProps = {
  label: string
  description?: string
  presentation?: LoadingPresentation
  className?: string
  rowCount?: number
}

export function LoadingState({
  label,
  description,
  presentation = 'panel',
  className,
  rowCount = 3,
}: LoadingStateProps) {
  if (presentation === 'inline') {
    return (
      <span className={cn('inline-flex items-center gap-2 text-[var(--muted)]', className)} role="status" aria-live="polite">
        <span className="loading-dot" aria-hidden="true" />
        {label}
      </span>
    )
  }

  const content = (
    <Card
      className={cn(
        'rounded-[var(--r)] border border-[var(--line)] bg-[var(--surface)] p-4',
        presentation === 'page' && 'mx-auto w-full max-w-[880px] p-6',
        presentation === 'chart' && 'min-h-[260px] p-5',
        className,
      )}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex items-center gap-3">
        <BarChart3 className="size-5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
        <div>
          <h2 className="text-sm font-bold text-[var(--text-strong)]">{label}</h2>
          {description ? <p className="mt-0.5 text-xs text-[var(--muted)]">{description}</p> : null}
        </div>
      </div>
      <div
        className={cn('mt-4 grid gap-2', presentation === 'chart' && 'content-end pt-12')}
        aria-hidden="true"
      >
        {Array.from({ length: rowCount }, (_, index) => (
          <Skeleton
            className={cn(
              'h-9 w-full rounded-md',
              presentation === 'chart' && 'h-3',
              index === rowCount - 1 && 'w-[72%]',
            )}
            key={index}
          />
        ))}
      </div>
    </Card>
  )

  return presentation === 'page'
    ? <section className="px-[var(--page-x)] pt-6">{content}</section>
    : content
}
