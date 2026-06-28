import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { Button } from './ui/button'

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
  const closeRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (activeElement && !activeElement.closest('.drawer')) previousFocusRef.current = activeElement
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const previousFocus = previousFocusRef.current
      window.setTimeout(() => {
        if (document.querySelector('.drawer.is-open')) return
        if (previousFocus?.isConnected) previousFocus.focus()
        previousFocusRef.current = null
      }, 0)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="drawer is-open" role="dialog" aria-modal="true" aria-label={title}>
      <div className="drawer__scrim" onClick={onClose} />
      <div className="drawer__panel">
        <div className="drawer__head">
          <h2>{title}</h2>
          <Button ref={closeRef} type="button" variant="ghost" className="border border-transparent bg-transparent text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]" onClick={onClose}>
            <X size={16} aria-hidden="true" />
            Close
          </Button>
        </div>
        <div className="drawer__body">
          {entities.length === 0 ? (
            <p className="footnote">Nothing selected yet. Use the + button on any row to add it here.</p>
          ) : (
            <>
              <div className="drawer__table tablewrap">
                <table className="cmp">
                  <thead>
                    <tr>
                      <th scope="col" />
                      {columns.map((column) => (
                        <th key={column.id} scope="col">
                          <div className="ent">
                            <span className="ent__identity">
                              {column.badge}
                              <b>{column.name}</b>
                            </span>
                            {column.sub ? <small>{column.sub}</small> : null}
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="border border-transparent bg-transparent text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
                            style={{ padding: '2px 6px', marginTop: 4 }}
                            onClick={() => onRemove(column.id)}
                          >
                            <X size={12} aria-hidden="true" /> Remove
                          </Button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const best = bestIds(entities, columns, row)
                      return (
                        <tr key={row.key}>
                          <th scope="row">{row.label}</th>
                          {entities.map((entity, index) => (
                            <td key={columns[index].id} className={best.has(columns[index].id) ? 'best' : ''}>
                              {row.cell(entity)}
                            </td>
                          ))}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {after ? <div className="drawer__after">{after}</div> : null}
            </>
          )}
        </div>
      </div>
    </div>
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
  for (const entry of valid) {
    if (entry.value === target) ids.add(entry.id)
  }
  return ids
}
