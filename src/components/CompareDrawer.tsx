import type { ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { DataState } from './ui'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from './ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import type { PublicTeamStanding as RankingSummaryStanding } from '../lib/publicArtifacts/schema'
import type { RegionStrength } from '../lib/regionStrength'

export type CompareColumn = {
  id: string
  name: string
  sub?: string
  badge?: ReactNode
}

export type CompareRow<E> = {
  key: string
  label: string
  cell: (entity: E) => ReactNode
  score?: (entity: E) => number
  better?: 'high' | 'low'
}

export type CompareDrawerProps<E> = {
  open: boolean
  title: string
  entities: E[]
  columns: CompareColumn[]
  rows: CompareRow<E>[]
  after?: ReactNode
  onClose: () => void
  onRemove: (id: string) => void
}

export function CompareDrawer<E>({
  open,
  title,
  entities,
  columns,
  rows,
  after,
  onClose,
  onRemove,
}: CompareDrawerProps<E>) {
  return (
    <Sheet open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) onClose()
    }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="data-[side=right]:w-[min(980px,100vw)] data-[side=right]:max-w-none gap-0 border-l border-[var(--line-strong)] bg-[var(--surface)] p-0 text-[var(--text)] shadow-[var(--shadow-pop)] data-[side=right]:sm:w-[min(980px,94vw)] data-[side=right]:sm:max-w-none"
      >
        <SheetHeader className="flex-row items-center gap-3 border-b border-[var(--line)] p-[18px_22px] text-left">
          <SheetTitle className="mr-auto text-[var(--t-5)] font-semibold text-[var(--text-strong)]">{title}</SheetTitle>
          <SheetClose asChild>
            <Button type="button" variant="ghost">
              <X size={16} aria-hidden="true" />
              Close
            </Button>
          </SheetClose>
        </SheetHeader>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain p-0">
          {entities.length === 0 ? (
            <DataState icon={<Plus size={26} aria-hidden="true" />} title="Nothing selected yet">
              Add rows from the ranking view to compare them here.
            </DataState>
          ) : (
            <>
                <Table
                  containerClassName="max-w-full border-b border-[var(--line)] [contain:paint] [overscroll-behavior-x:contain] [scrollbar-gutter:stable]"
                  className="compare-table w-full border-collapse"
                  data-compare-count={columns.length}
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead aria-label="Metric" />
                      {columns.map((column) => (
                        <TableHead key={column.id}>
                          <div className="flex flex-col gap-px [&_b]:font-semibold [&_b]:text-[var(--text-strong)] [&_small]:text-[var(--t-2)] [&_small]:text-[var(--faint)]">
                            <span className="inline-flex min-w-0 items-center gap-[7px]">
                              {column.badge}
                              <b>{column.name}</b>
                            </span>
                            {column.sub ? <small>{column.sub}</small> : null}
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="mt-1 rounded-[var(--r-1)]"
                            onClick={() => onRemove(column.id)}
                            aria-label={`Remove ${column.name} from comparison`}
                            title={`Remove ${column.name}`}
                          >
                            <X size={14} aria-hidden="true" />
                          </Button>
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => {
                      const best = bestIds(entities, columns, row)
                      return (
                        <TableRow key={row.key}>
                          <TableHead scope="row">{row.label}</TableHead>
                          {entities.map((entity, index) => (
                            <TableCell key={columns[index].id} className={best.has(columns[index].id) ? 'best' : ''}>
                              {row.cell(entity)}
                              {best.has(columns[index].id) ? (
                                <Badge variant="default" className="ml-2 px-1.5 text-[var(--t-1)] leading-[1.2] tracking-[0.06em] uppercase" aria-label={`Best ${row.label.toLowerCase()} value`}>
                                  Best
                                </Badge>
                              ) : null}
                            </TableCell>
                          ))}
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              {after ? <div className="grid min-w-0 gap-4 px-[22px] pt-[18px] pb-6 max-sm:p-3.5">{after}</div> : null}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function RegionCompareDrawer(props: CompareDrawerProps<RegionStrength>) {
  return <CompareDrawer {...props} />
}

export function TeamCompareDrawer(props: CompareDrawerProps<RankingSummaryStanding>) {
  return <CompareDrawer {...props} />
}

function bestIds<E>(entities: E[], columns: CompareColumn[], row: CompareRow<E>) {
  const ids = new Set<string>()
  if (!row.score || entities.length < 2) return ids
  const scored = entities.map((entity, index) => ({ id: columns[index].id, value: row.score!(entity) }))
  const valid = scored.filter((entry) => Number.isFinite(entry.value))
  if (valid.length < 2) return ids
  const target =
    row.better === 'low'
      ? Math.min(...valid.map((entry) => entry.value))
      : Math.max(...valid.map((entry) => entry.value))
  const winners = valid.filter((entry) => entry.value === target)
  if (winners.length !== 1) return ids
  ids.add(winners[0].id)
  return ids
}
