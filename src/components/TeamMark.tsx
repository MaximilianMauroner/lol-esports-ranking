import { useState } from 'react'
import { teamBrandingFor } from '../data/teamBranding'
import { cn } from '../shared/utils'

export function TeamMark({
  team,
  code,
  className,
  imageClassName,
  fallback = 'code',
}: {
  team: string
  code?: string
  className?: string
  imageClassName?: string
  /** Marks too small for a code show its first letter when no logo loads. */
  fallback?: 'code' | 'initial'
}) {
  const branding = teamBrandingFor(team)
  const label = branding?.code ?? code ?? team.replace(/\s+/g, '').slice(0, 4).toUpperCase()
  const text = fallback === 'initial' ? label.slice(0, 1) : label
  // Bypass full-resolution copies cached before the icon-sized assets shipped.
  const logo = branding?.logo ? `${branding.logo}?v=icon-128` : undefined
  const treatment = branding?.logoTreatment
  const [failedLogo, setFailedLogo] = useState<string>()
  const [loadedLogo, setLoadedLogo] = useState<string>()
  const showLogo = logo && treatment !== 'code' && failedLogo !== logo

  return (
    <span
      className={cn(
        'relative inline-flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border bg-[var(--surface-2)] font-mono text-xs leading-none font-extrabold whitespace-nowrap text-foreground [container-type:inline-size]',
        className,
      )}
      title={`${team} (${label})`}
      aria-hidden="true"
    >
      <span className={showLogo && loadedLogo === logo ? 'invisible' : undefined} style={{ fontSize: `min(1em, ${Math.floor(80 / (0.6 * text.length))}cqi)` }}>{text}</span>
      {showLogo ? (
        <img
          className={cn('absolute inset-0 size-full min-h-0 min-w-0 object-contain p-1', loadedLogo !== logo && 'invisible', treatment === 'invert' && 'invert', imageClassName)}
          src={logo}
          alt=""
          width={40}
          height={40}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoadedLogo(logo)}
          onError={() => setFailedLogo(logo)}
        />
      ) : null}
    </span>
  )
}
