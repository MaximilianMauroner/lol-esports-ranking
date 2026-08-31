import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("loading-skeleton rounded-[var(--r-1)] bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
