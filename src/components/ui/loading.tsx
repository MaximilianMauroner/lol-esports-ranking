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
  announce?: boolean
}

export function LoadingState({
  label,
  description,
  presentation = 'panel',
  className,
  rowCount = 3,
  announce = true,
}: LoadingStateProps) {
  if (presentation === 'inline') {
    return (
      <span className={cn('inline-flex items-center gap-2 text-[var(--muted)]', className)} role={announce ? 'status' : undefined} aria-live={announce ? 'polite' : undefined}>
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
      role={announce ? 'status' : undefined}
      aria-live={announce ? 'polite' : undefined}
      aria-busy="true"
    >
      <div className="flex items-center gap-3">
        <BarChart3 className="size-5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
        <div>
          <h2 className="text-sm font-bold text-[var(--text-strong)]">{label}</h2>
          {description ? <p className="mt-0.5 text-xs text-[var(--muted)]">{description}</p> : null}
        </div>
      </div>
      {presentation === 'rows' ? (
        <div className="mt-4 grid gap-px overflow-hidden rounded-md border border-[var(--line)] bg-[var(--line)]" aria-hidden="true">
          {Array.from({ length: rowCount }, (_, index) => (
            <div className="grid min-h-14 grid-cols-[32px_minmax(0,1fr)_64px] items-center gap-3 bg-[var(--surface-2)] px-3 py-2.5" key={index}>
              <Skeleton className="size-7 rounded-full" />
              <span className="grid gap-2"><Skeleton className="h-2.5 w-[min(260px,78%)] rounded-md" /><Skeleton className="h-2 w-[min(180px,54%)] rounded-md" /></span>
              <Skeleton className="h-3 w-full rounded-md" />
            </div>
          ))}
        </div>
      ) : presentation === 'chart' ? (
        <div className="relative mt-4 min-h-[210px] overflow-hidden rounded-md border border-[var(--line)] bg-[var(--surface-2)]" aria-hidden="true">
          <div className="absolute inset-0 grid grid-rows-4 [&>span]:border-b [&>span]:border-dashed [&>span]:border-[var(--line)]"><span /><span /><span /><span /></div>
          <svg className="absolute inset-[12%_5%] h-[76%] w-[90%] text-[var(--accent-line)]" viewBox="0 0 100 60" preserveAspectRatio="none">
            <polyline points="0,48 14,43 28,46 43,27 57,32 72,16 86,22 100,8" fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
          <Skeleton className="absolute bottom-3 left-3 h-2.5 w-24 rounded-md" />
        </div>
      ) : (
        <div className="mt-4 grid gap-2" aria-hidden="true">
          {Array.from({ length: rowCount }, (_, index) => <Skeleton className={cn('h-9 w-full rounded-md', index === rowCount - 1 && 'w-[72%]')} key={index} />)}
        </div>
      )}
    </Card>
  )

  return presentation === 'page'
    ? <section className="px-[var(--page-x)] pt-6">{content}</section>
    : content
}
