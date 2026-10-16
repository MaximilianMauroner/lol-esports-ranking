import { BarChart3 } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Card } from './card'
import { Panel } from './panel'
import { Skeleton } from './skeleton'

/** The page each skeleton imitates. Each layout copies its view's grid, panels and row heights, so nothing moves when data arrives. */
export type PageLayout = 'board' | 'ledger' | 'regions' | 'schedule'

type LoadingStateProps = {
  label: string
  className?: string
  announce?: boolean
} & (
  | { presentation: 'page'; layout: PageLayout }
  | { presentation?: 'panel' | 'rows' | 'chart' | 'inline'; rowCount?: number }
)

/**
 * The one loading pattern. Every placeholder takes its space at once and
 * becomes visible after a short delay (`.loading-reveal`), so a fast load
 * never flashes a skeleton and a slow one never shifts the layout.
 */
export function LoadingState(props: LoadingStateProps) {
  const { label, className, announce = true } = props
  const status = announce ? { role: 'status', 'aria-live': 'polite' as const } : {}

  if (props.presentation === 'page') {
    return (
      <div className={cn('loading-reveal', className)} {...status} aria-busy="true">
        <span className="sr-only">{label}</span>
        <PageSkeleton layout={props.layout} />
      </div>
    )
  }

  const presentation = props.presentation ?? 'panel'
  const rowCount = props.rowCount ?? 3
  if (presentation === 'inline') {
    return (
      <span className={cn('loading-reveal inline-flex items-center gap-2 text-muted-foreground', className)} {...status}>
        <span className="loading-dot" aria-hidden="true" />
        {label}
      </span>
    )
  }

  return (
    <Card
      className={cn('loading-reveal rounded-md border border-border bg-card p-4', presentation === 'chart' && 'min-h-[260px] p-5', className)}
      {...status}
      aria-busy="true"
    >
      <div className="flex items-center gap-3">
        <BarChart3 className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-bold text-[var(--text-strong)]">{label}</p>
      </div>
      {presentation === 'rows' ? (
        <div className="mt-4 grid gap-px overflow-hidden rounded-md border border-border bg-border" aria-hidden="true">
          {Array.from({ length: rowCount }, (_, index) => (
            <div className="grid min-h-14 grid-cols-[32px_minmax(0,1fr)_64px] items-center gap-3 bg-[var(--surface-2)] px-3 py-2.5" key={index}>
              <Skeleton className="size-7 rounded-full" />
              <span className="grid gap-2"><Skeleton className="h-2.5 w-[min(260px,78%)] rounded-md" /><Skeleton className="h-2 w-[min(180px,54%)] rounded-md" /></span>
              <Skeleton className="h-3 w-full rounded-md" />
            </div>
          ))}
        </div>
      ) : presentation === 'chart' ? (
        <div className="relative mt-4 min-h-[210px] overflow-hidden rounded-md border border-border bg-[var(--surface-2)]" aria-hidden="true">
          <div className="absolute inset-0 grid grid-rows-4 [&>span]:border-b [&>span]:border-dashed [&>span]:border-border"><span /><span /><span /><span /></div>
          <svg className="absolute inset-[12%_5%] h-[76%] w-[90%] text-[var(--line-strong)]" viewBox="0 0 100 60" preserveAspectRatio="none">
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
}

/** A bar inside a box that has the line height of the text it stands for. */
function Line({ size, className }: { size: 'xs' | 'sm' | 'base' | 'lg'; className?: string }) {
  const box = { xs: 'h-4', sm: 'h-5', base: 'h-6', lg: 'h-7' }[size]
  const bar = { xs: 'h-2.5', sm: 'h-3', base: 'h-3.5', lg: 'h-4' }[size]
  return <span className={cn('flex items-center', box)}><Skeleton className={cn('rounded-md', bar, className)} /></span>
}

/** Same box as `StatRibbon` and `StatCell`. */
function RibbonSkeleton({ details }: { details: boolean[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-px overflow-hidden rounded-lg border border-border bg-border">
      {details.map((detail, index) => (
        <div className="grid min-w-0 gap-0.5 bg-card px-4 py-3" key={index}>
          <Line size="xs" className="w-24" />
          <Line size="lg" className="w-16" />
          {detail ? <Line size="xs" className="w-28" /> : null}
        </div>
      ))}
    </div>
  )
}

/** Same box as `Panel` with a `PanelHeader`. */
function PanelSkeleton({ titleWidth, children }: { titleWidth: string; children: ReactNode }) {
  return (
    <Panel>
      <div className="border-b border-border px-4 py-3"><Line size="base" className={titleWidth} /></div>
      {children}
    </Panel>
  )
}

function Rows({ count, height }: { count: number; height: string }) {
  return (
    <div className="flex flex-col">
      {Array.from({ length: count }, (_, index) => (
        <div className={cn('flex items-center gap-3 border-t border-border px-4 first:border-t-0', height)} key={index}>
          <Skeleton className="size-7 shrink-0 rounded-full" />
          <span className="grid min-w-0 flex-1 gap-2"><Skeleton className="h-3 w-[min(220px,70%)] rounded-md" /><Skeleton className="h-2.5 w-[min(140px,45%)] rounded-md" /></span>
          <Skeleton className="h-3 w-16 shrink-0 rounded-md" />
        </div>
      ))}
    </div>
  )
}

function Control({ className }: { className?: string }) {
  return <Skeleton className={cn('h-[var(--control-h)] rounded-md', className)} />
}

function PageSkeleton({ layout }: { layout: PageLayout }) {
  if (layout === 'schedule') {
    // TournamentsView: competition picker and view tabs, meta line, event title, bracket.
    return (
      <div className="grid min-w-0 gap-5 px-[var(--page-x)] py-5" aria-hidden="true">
        <div className="grid gap-y-3 border-b border-border pb-4">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            <div className="grid gap-1"><Line size="sm" className="w-24" /><Control className="w-[min(312px,80vw)]" /></div>
            <div className="flex gap-1.5"><Control className="w-20" /><Control className="w-24" /></div>
          </div>
          <div className="flex items-center gap-3"><Line size="xs" className="w-56" /><Skeleton className="h-8 w-20 rounded-md" /></div>
        </div>
        <Line size="lg" className="w-56" />
        <div className="grid min-h-[340px] grid-cols-[repeat(auto-fill,minmax(212px,1fr))] content-start gap-x-11 gap-y-3 rounded-lg border border-border bg-card p-4">
          {Array.from({ length: 6 }, (_, index) => <Skeleton className="h-[70px] rounded-md" key={index} />)}
        </div>
      </div>
    )
  }

  if (layout === 'ledger') {
    // MatchesView: summary ribbon, then the series ledger with filters and rows.
    return (
      <div className="flex min-w-0 flex-col gap-6 px-[var(--page-x)] pt-6" aria-hidden="true">
        <RibbonSkeleton details={[true, false, false]} />
        <PanelSkeleton titleWidth="w-32">
          <div className="grid items-end gap-2 px-4 py-3.5 sm:grid-cols-2 lg:grid-cols-[minmax(220px,1fr)_180px_220px_auto]">
            <Control /><Control /><Control /><Control className="max-lg:hidden" />
          </div>
          <div className="h-9 border-y border-border bg-[var(--surface-2)]" />
          <Rows count={8} height="h-[58px]" />
        </PanelSkeleton>
      </div>
    )
  }

  if (layout === 'regions') {
    // RegionsView: summary ribbon, depth chart, standings.
    return (
      <div className="flex min-w-0 flex-col gap-6 px-[var(--page-x)] pt-6" aria-hidden="true">
        <RibbonSkeleton details={[true, false, true]} />
        <PanelSkeleton titleWidth="w-28">
          <div className="grid gap-3 px-4 py-3.5"><Line size="xs" className="w-48" /><Skeleton className="h-[380px] rounded-md" /></div>
        </PanelSkeleton>
        <PanelSkeleton titleWidth="w-40"><Rows count={6} height="h-[88px]" /></PanelSkeleton>
      </div>
    )
  }

  // TeamsView: headline, ranking board with filters, and the side column on wide screens.
  return (
    <div className="flex min-w-0 flex-col gap-6 px-[var(--page-x)] pt-6" aria-hidden="true">
      <Line size="lg" className="w-[min(560px,80%)]" />
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_320px] items-start gap-6 max-[1280px]:grid-cols-1">
        <PanelSkeleton titleWidth="w-32">
          <div className="flex flex-wrap gap-2 border-b border-border px-4 py-3">
            {Array.from({ length: 6 }, (_, index) => <Control className="w-16" key={index} />)}
          </div>
          <Rows count={10} height="h-[53px]" />
        </PanelSkeleton>
        <div className="grid gap-6 max-[1280px]:hidden">
          <PanelSkeleton titleWidth="w-28"><Rows count={6} height="h-11" /></PanelSkeleton>
          <PanelSkeleton titleWidth="w-24"><Rows count={4} height="h-11" /></PanelSkeleton>
        </div>
      </div>
    </div>
  )
}
