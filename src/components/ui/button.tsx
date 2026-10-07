import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[background-color,border-color,color,box-shadow] outline-none select-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-[var(--line-strong)] bg-[var(--surface-2)] text-foreground hover:border-[var(--line-strong)] hover:bg-[var(--surface-3)] hover:text-[var(--text-strong)] aria-expanded:bg-[var(--surface-3)]",
        secondary:
          "border-border bg-[var(--surface-2)] text-foreground hover:bg-[var(--surface-3)] hover:text-[var(--text-strong)] aria-expanded:bg-[var(--surface-3)]",
        ghost:
          "text-muted-foreground hover:bg-[var(--surface-2)] hover:text-foreground aria-expanded:bg-[var(--surface-2)] aria-expanded:text-foreground",
        // The one selected treatment, shared by mode nav, season row,
        // checkpoint row and tier strip. See --selected-* in base.css.
        tab: "border-border bg-[color-mix(in_oklch,var(--surface-2)_58%,transparent)] text-muted-foreground hover:border-[var(--line-strong)] hover:text-foreground aria-pressed:border-[var(--selected-line)] aria-pressed:bg-[var(--selected-bg)] aria-pressed:text-[var(--text-strong)] aria-[current=page]:border-[var(--selected-line)] aria-[current=page]:bg-[var(--selected-bg)] aria-[current=page]:text-[var(--text-strong)]",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-sm px-2 text-2xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-2.5 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        // The shared height for every control that sits in a filter or scope
        // bar, so tabs, selects and inputs line up on one baseline.
        tab: "h-[var(--control-h)] gap-1.5 px-3 text-sm",
        icon: "size-8",
        "icon-xs": "size-6 rounded-sm [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
