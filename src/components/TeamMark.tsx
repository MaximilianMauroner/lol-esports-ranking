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
        'inline-grid size-9 shrink-0 place-items-center overflow-hidden rounded-[var(--r-1)] border border-[var(--line)] bg-[var(--surface-2)] font-mono text-[var(--t-2)] font-extrabold text-[var(--text)]',
        className,
      )}
      title={`${team} (${label})`}
      aria-hidden="true"
    >
      {branding?.logo ? (
        <img
          className={cn('size-full object-contain p-1', imageClassName)}
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
