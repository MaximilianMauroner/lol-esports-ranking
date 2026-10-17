import { useState } from 'react'
import { championIconUrl, championInitials } from '../../lib/championIcons'
import { cn } from '../../lib/utils'
import type { ChampionPicks as RolePicks } from '../../types'

/** One team's champions in role order. Each icon is a named image, not a control. */
export function ChampionPicks({ teamName, picks, patch, align, className }: {
  teamName: string
  picks: RolePicks
  patch: string
  align: 'start' | 'end'
  className?: string
}) {
  return (
    <span role="group" aria-label={`${teamName} champions`} className={cn('flex min-w-0 flex-wrap gap-0.5', align === 'end' && 'justify-end', className)}>
      {picks.map((champion, role) => <ChampionIcon champion={champion} patch={patch} key={`${role}:${champion}`} />)}
    </span>
  )
}

function ChampionIcon({ champion, patch }: { champion: string | null; patch: string }) {
  const label = champion ?? 'Unknown champion'
  const url = champion ? championIconUrl(champion, patch) : undefined
  const [failedUrl, setFailedUrl] = useState<string>()
  const [loadedUrl, setLoadedUrl] = useState<string>()
  const showImage = url !== undefined && failedUrl !== url
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="relative inline-flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border bg-[var(--surface-2)] font-mono text-[0.5625rem] leading-none font-bold text-muted-foreground lg:size-6"
    >
      <span className={showImage && loadedUrl === url ? 'invisible' : undefined}>{champion ? championInitials(champion) : '?'}</span>
      {showImage ? (
        <img
          className={cn('absolute inset-0 size-full', loadedUrl !== url && 'invisible')}
          src={url}
          alt=""
          width={24}
          height={24}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoadedUrl(url)}
          onError={() => setFailedUrl(url)}
        />
      ) : null}
    </span>
  )
}
