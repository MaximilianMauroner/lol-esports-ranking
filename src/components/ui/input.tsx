import * as React from 'react'
import { cn } from '../../lib/utils'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-9 w-full min-w-0 rounded-[var(--r)] border border-[var(--line-strong)] bg-[var(--surface-2)] px-3 py-1 text-sm text-[var(--text)] outline-none transition-colors placeholder:text-[var(--faint)] focus-visible:border-[var(--accent-line)] disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
