import type { ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { DataState } from './ui'
import { Button } from './ui/button'
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from './ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'

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

export function CompareDrawer<E>({
  open,
  title,
  entities,
  columns,
  rows,
  after,
  onClose,
  onRemove,
}: {
  open: boolean
  title: string
  entities: E[]
  columns: CompareColumn[]
  rows: CompareRow<E>[]
  after?: ReactNode
  onClose: () => void
  onRemove: (id: string) => void
}) {
  return (
    <Sheet open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) onClose()
    }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full max-w-none gap-0 border-l border-[var(--line-strong)] bg-[var(--surface)] p-0 text-[var(--text)] shadow-[var(--shadow-pop)] sm:w-[min(980px,94vw)] sm:max-w-none"
      >
        <SheetHeader className="drawer__head flex-row items-center p-[18px_22px] text-left">
          <SheetTitle className="mr-auto text-[1.1rem] font-semibold text-[var(--text-strong)]">{title}</SheetTitle>
          <SheetClose asChild>
            <Button type="button" variant="ghost">
              <X size={16} aria-hidden="true" />
              Close
            </Button>
          </SheetClose>
        </SheetHeader>
        <div className="drawer__body min-h-0 flex-1 overflow-auto overscroll-contain">
          {entities.length === 0 ? (
            <DataState icon={<Plus size={26} aria-hidden="true" />} title="Nothing selected yet">
              Add rows from the ranking view to compare them here.
            </DataState>
          ) : (
            <>
              <div className="drawer__table tablewrap">
                <Table className="cmp" data-compare-count={columns.length}>
                  <TableHeader>
                    <TableRow>
                      <TableHead aria-label="Metric" />
                      {columns.map((column) => (
                        <TableHead key={column.id}>
                          <div className="ent">
                            <span className="ent__identity">
                              {column.badge}
                              <b>{column.name}</b>
                            </span>
                            {column.sub ? <small>{column.sub}</small> : null}
                          </div>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="mt-1 rounded-[var(--r-sm)]"
                                onClick={() => onRemove(column.id)}
                                aria-label={`Remove ${column.name} from comparison`}
                              >
                                <X size={14} aria-hidden="true" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Remove {column.name}</TooltipContent>
                          </Tooltip>
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => {
                      const best = bestIds(entities, columns, row)
                      return (
                        <TableRow key={row.key}>
                          <TableHead>{row.label}</TableHead>
                          {entities.map((entity, index) => (
                            <TableCell key={columns[index].id} className={best.has(columns[index].id) ? 'best' : ''}>
                              {row.cell(entity)}
                              {best.has(columns[index].id) ? (
                                <span className="cmp__best" aria-label={`Best ${row.label.toLowerCase()} value`}>
                                  Best
                                </span>
                              ) : null}
                            </TableCell>
                          ))}
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
              {after ? <div className="drawer__after">{after}</div> : null}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
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
