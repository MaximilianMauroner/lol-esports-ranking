import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--r)] text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)] shadow-[var(--shadow-1)] hover:bg-[var(--accent-strong)]',
        secondary: 'border border-[var(--line-strong)] bg-[var(--surface-2)] text-[var(--text)] hover:border-[var(--accent-line)] hover:text-[var(--accent-strong)]',
        ghost: 'border border-transparent bg-transparent text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]',
        outline: 'border border-[var(--line-strong)] bg-transparent text-[var(--text)] hover:border-[var(--accent-line)] hover:bg-[var(--accent-soft)]',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-[var(--r-sm)] px-3 text-xs',
        icon: 'size-9 rounded-[8px] p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({ className, variant, size, asChild = false, ...props }: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button'
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

export { Button, buttonVariants }
