import * as React from 'react'
import { cn } from '../../lib/utils'

function Select({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="select"
      className={cn(
        'h-9 min-w-[120px] max-w-[260px] appearance-none rounded-[var(--r)] border border-[var(--line-strong)] bg-[var(--surface-2)] px-3 py-1 pr-8 text-sm text-[var(--text)] outline-none transition-colors hover:border-[var(--accent-line)] focus-visible:border-[var(--accent-line)] disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  )
}

export { Select }
