import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'

function Select({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <span className="relative inline-flex min-w-0">
      <select
        data-slot="select"
        className={cn(
          'h-9 min-w-[120px] max-w-[260px] appearance-none rounded-[var(--r)] border border-[var(--line-strong)] bg-[var(--surface-2)] px-3 py-1 pr-8 text-sm text-[var(--text)] outline-none transition-colors hover:border-[var(--accent-line)] focus-visible:border-[var(--accent-line)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-45',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--faint)]" aria-hidden="true" />
    </span>
  )
}

export { Select }
