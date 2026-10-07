import { teamBrandingFor } from '../data/teamBranding'
import { cn } from '../lib/utils'

export function TeamMark({
  team,
  code,
  className,
  imageClassName,
}: {
  team: string
  code?: string
  className?: string
  imageClassName?: string
}) {
  const branding = teamBrandingFor(team)
  const label = branding?.code ?? code ?? team.slice(0, 4).toUpperCase()

  return (
    <span
      className={cn(
        'inline-flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border bg-[var(--surface-2)] font-mono text-xs font-extrabold text-foreground',
        className,
      )}
      title={`${team} (${label})`}
      aria-hidden="true"
    >
      {branding?.logo ? (
        <img
          className={cn('size-full min-h-0 min-w-0 object-contain p-1', imageClassName)}
          src={branding.logo}
          alt=""
          width={40}
          height={40}
          loading="lazy"
        />
      ) : label}
    </span>
  )
}
