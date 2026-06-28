import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const badgeVariants = cva('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums transition-colors', {
  variants: {
    variant: {
      default: 'border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent-strong)]',
      secondary: 'border-[var(--line-strong)] bg-[var(--surface-2)] text-[var(--muted)]',
      warning: 'border-transparent bg-[var(--warn-soft)] text-[var(--warn)]',
    },
  },
  defaultVariants: { variant: 'secondary' },
})

function Badge({ className, variant, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant, className }))} {...props} />
}

export { Badge }
