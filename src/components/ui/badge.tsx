import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

/**
 * Every small labelled chip in the product. If a chip needs styling that no
 * variant here provides, add the variant rather than overriding one at the call
 * site: four distinct chip treatments used to be built inline because this file
 * only offered three.
 */
const badgeVariants = cva(
  'inline-flex max-w-full items-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-2xs font-semibold whitespace-nowrap tabular-nums',
  {
    variants: {
      variant: {
        default: 'border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent-strong)]',
        secondary: 'border-[var(--line)] bg-[var(--surface-2)] text-[var(--muted)]',
        warning: 'border-transparent bg-[var(--warn-soft)] text-[var(--warn)]',
        /* Rank quality. --rank-gold carries this meaning and no other. */
        rank: 'border-[color-mix(in_oklch,var(--rank-gold),var(--line)_54%)] bg-[color-mix(in_oklch,var(--rank-gold)_12%,transparent)] font-bold text-[var(--rank-gold)]',
        /* Competition and event labels. */
        event: 'border-[var(--line)] bg-[color-mix(in_oklch,var(--surface-2)_72%,transparent)] text-[var(--faint)]',
        /* Match outcome. */
        win: 'border-[color-mix(in_oklch,var(--win)_44%,var(--line))] bg-[var(--win-soft)] text-[var(--win)]',
        loss: 'border-[color-mix(in_oklch,var(--loss)_44%,var(--line))] bg-[var(--loss-soft)] text-[var(--loss)]',
      },
      size: {
        default: '',
        /* Square-ish tier and result marks, sized to align with a table row. */
        mark: 'grid size-[var(--mark-size,22px)] place-items-center rounded-[var(--r-1)] px-0 py-0 text-center [--mark-size:22px]',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'default' },
  },
)

function Badge({ className, variant, size, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant, size, className }))} {...props} />
}

export { Badge, badgeVariants }
