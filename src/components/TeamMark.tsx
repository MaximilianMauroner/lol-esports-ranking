import { useReducer } from 'react'
import { teamBrandingFor } from '../data/teamBranding'
import { logoTreatment, type LogoTreatment } from '../lib/teamLogo'
import { cn } from '../lib/utils'

/** One measurement per logo file. Marks mount often and share files. */
const treatmentByLogo = new Map<string, LogoTreatment>()

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
  const logo = branding?.logo
  const treatment = logo ? treatmentByLogo.get(logo) : undefined
  const [, refresh] = useReducer((count: number) => count + 1, 0)

  const remember = (src: string, value: LogoTreatment) => {
    treatmentByLogo.set(src, value)
    refresh()
  }

  return (
    <span
      className={cn(
        'inline-flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border bg-[var(--surface-2)] font-mono text-xs font-extrabold text-foreground',
        className,
      )}
      title={`${team} (${label})`}
      aria-hidden="true"
    >
      {logo && treatment !== 'code' ? (
        <img
          className={cn('size-full min-h-0 min-w-0 object-contain p-1', treatment === 'invert' && 'invert', imageClassName)}
          src={logo}
          alt=""
          width={40}
          height={40}
          loading="lazy"
          onLoad={treatment ? undefined : (event) => remember(logo, measureLogo(event.currentTarget))}
          onError={() => remember(logo, 'code')}
        />
      ) : label}
    </span>
  )
}

function measureLogo(image: HTMLImageElement) {
  const size = 24
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return 'logo'
  context.drawImage(image, 0, 0, size, size)
  return logoTreatment(image.naturalWidth, image.naturalHeight, context.getImageData(0, 0, size, size).data)
}
