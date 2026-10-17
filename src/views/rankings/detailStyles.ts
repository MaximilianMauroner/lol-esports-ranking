import { cn } from '../../shared/utils'

export const detailCardClassName = 'min-w-0 overflow-hidden rounded-md border border-[var(--line-strong)] bg-[var(--detail-surface-2,var(--surface))] p-6 max-[900px]:p-4 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-[var(--text-strong)]'

export const emptyPlayerRankCardClassName = cn(detailCardClassName, 'grid gap-3 px-5 py-4 [&_h3]:text-md [&>div:first-child]:border-0 [&>div:first-child]:pb-0')

export const playerRankCardHeadClassName = 'flex items-start justify-between gap-3.5 border-b border-[var(--line-strong)] pb-4 [&_h3]:flex [&_h3]:flex-wrap [&_h3]:items-center [&_h3]:gap-2 [&_p]:mt-1 [&_p]:text-sm [&_p]:leading-[1.4] [&_p]:text-[var(--faint)] max-sm:flex-col'

export const componentLedgerRowClassName = 'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-2 bg-[var(--detail-surface,var(--surface))] px-3 py-2.5 [&>b]:whitespace-nowrap [&>b]:text-md [&>b]:font-bold [&>b]:text-[var(--text-strong)] [&>b]:tabular-nums [&>b.down]:text-[var(--down)] [&>b.up]:text-[var(--up)] [&>span:first-child]:text-sm [&>span:first-child]:text-muted-foreground'
