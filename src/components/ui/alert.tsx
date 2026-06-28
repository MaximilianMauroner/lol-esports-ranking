import * as React from 'react'
import { cn } from '../../lib/utils'

function Alert({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert"
      className={cn('flex items-start gap-2 rounded-[var(--r)] border border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2 text-sm text-[var(--text)]', className)}
      {...props}
    />
  )
}

export { Alert }
