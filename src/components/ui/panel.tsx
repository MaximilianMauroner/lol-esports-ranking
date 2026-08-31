import type { ReactNode } from 'react'
import * as React from 'react'
import { Card } from './card'
import { cn } from '@/lib/utils'

/**
 * The one bordered container in the product.
 *
 * The three views previously hand-built four variants of this between them,
 * differing in element (`Card` vs raw `section`), radius (`--r-2` vs `--r-3`),
 * border colour (`--line` vs `--line-strong`) and header fill. Panel owns all
 * four decisions so a new panel cannot introduce a fifth.
 *
 * `Panel` strips Card's default padding: the slots below own their own spacing
 * so a header, a full-bleed table and a footer can sit flush against the edges.
 */
export function Panel({ className, ...props }: React.ComponentProps<'div'>) {
  return <Card className={cn('gap-0 py-0', className)} {...props} />
}

/**
 * Panel header. Title, an optional one-line description, and optional actions
 * on the trailing edge.
 *
 * There is deliberately no eyebrow slot. Every panel used to open with an
 * uppercase grey label above its title, which cost a line of vertical space per
 * panel and pushed the actual data further down on every screen. Where the
 * eyebrow carried real information it now belongs in the title or in a badge
 * passed to `actions`.
 *
 * The header carries no fill. A sticky table head directly below it already
 * uses `--surface-2`, so a filled header merges into it.
 */
export function PanelHeader({
  title,
  description,
  actions,
  titleId,
  className,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  titleId?: string
  className?: string
  children?: ReactNode
}) {
  return (
    <div
      data-slot="panel-header"
      className={cn('flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-[var(--line)] px-4 py-3', className)}
    >
      <div className="mr-auto grid min-w-0 flex-[1_1_260px] gap-0.5">
        <h2 id={titleId} className="text-base font-semibold text-[var(--text-strong)]">{title}</h2>
        {description ? (
          <p className="max-w-[74ch] text-sm leading-[1.45] text-[var(--muted)]">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      {children}
    </div>
  )
}

export function PanelBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="panel-body" className={cn('min-w-0 px-4 py-3.5', className)} {...props} />
}

export function PanelFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="panel-footer"
      className={cn('min-w-0 border-t border-[var(--line)] px-4 py-2.5', className)}
      {...props}
    />
  )
}
