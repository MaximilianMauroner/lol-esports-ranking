import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-[var(--control-h)] w-full min-w-0 rounded-[var(--r-2)] border border-input bg-[var(--surface-2)] px-3 py-1 text-sm text-[var(--text)] transition-colors outline-none placeholder:text-muted-foreground hover:border-[var(--accent-line)] focus-visible:border-[var(--accent-line)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Input }
