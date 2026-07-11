import { ArrowDownRight, ArrowUpRight, Flame, Gauge, Trophy } from 'lucide-react'
import type { CSSProperties } from 'react'
import { Badge } from './ui/badge'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { formatNumber, formatPercentValue, formatRating, formatSigned } from '../lib/display'

export type RankingShowcaseTeam = {
  id?: string
  team?: string
  name?: string
  code?: string
  region?: string
  league?: string
  rank?: number
  rating?: number
  score?: number
  movement?: number
  confidence?: number
  note?: string
}

export type RankingTierCount = {
  tier: string
  label?: string
  count: number
  teams?: readonly string[]
  description?: string
}

export type RankingMovementSpotlight = {
  team?: string
  name?: string
  code?: string
  region?: string
  movement?: number
  ranks?: number
  fromRank?: number
  toRank?: number
  ratingDelta?: number
  description?: string
  reason?: string
}

export type RankingUpsetHeadline = {
  headline?: string
  title?: string
  winner?: string
  loser?: string
  event?: string
  score?: string
  date?: string
  probability?: number
  delta?: number
  description?: string
}

export type RankingConfidenceBand = {
  label?: string
  value?: number
  min?: number
  max?: number
  tone?: 'cool' | 'warm' | 'hot' | 'spicy'
  description?: string
}

export type RankingShowcaseProps = {
  eyebrow?: string
  title?: string
  subtitle?: string
  podium?: readonly RankingShowcaseTeam[]
  tierCounts?: readonly RankingTierCount[] | Record<string, number>
  tierStrips?: readonly RankingTierCount[]
  biggestRiser?: RankingMovementSpotlight
  biggestFaller?: RankingMovementSpotlight
  upset?: RankingUpsetHeadline
  confidenceBand?: RankingConfidenceBand
  variant?: 'panel' | 'rail'
  selectedTier?: string | null
  onTierSelect?: (tier: string) => void
  className?: string
}

const DEFAULT_TIER_ORDER = ['S', 'A', 'B', 'C']
const VISIBLE_TIER_TEAMS = 3
const sectionHeadClass = 'flex items-center gap-[9px] text-[var(--text-strong)] [&>h3]:text-[0.85rem] [&>h3]:font-[690] [&>svg]:text-[var(--accent-strong)]'
const showcaseCardClass = 'min-w-0 bg-[var(--surface)] px-[18px] py-4'

export function RankingShowcase({
  eyebrow = 'Snapshot readout',
  title = 'Power ranking readout',
  subtitle = 'Top table movement, tier density, and confidence context.',
  podium = [],
  tierCounts,
  tierStrips,
  biggestRiser,
  biggestFaller,
  upset,
  confidenceBand,
  variant = 'panel',
  selectedTier,
  onTierSelect,
  className,
}: RankingShowcaseProps) {
  const podiumTeams = podium.slice(0, 3)
  const tiers = normalizeTiers(tierStrips ?? tierCounts)

  return (
    <section className={cn('overflow-hidden rounded-[var(--r-lg)] border border-[var(--line)] bg-[var(--surface)]', className)} aria-label={title}>
      <div className={cn('flex items-start justify-between gap-4 border-b border-[var(--line)] px-[18px] py-4', variant === 'rail' && 'grid gap-1 px-4 py-3.5')}>
        <div>
          <p className="font-mono text-[0.67rem] font-[650] tracking-[0.14em] text-[var(--faint)] uppercase">{eyebrow}</p>
          <h2 className={cn('mt-[3px] text-base font-[690] text-[var(--text-strong)]', variant === 'rail' && 'text-[0.95rem]')}>{title}</h2>
          <p className={cn('mt-1 max-w-[70ch] text-[0.82rem] leading-[1.42] text-[var(--muted)]', variant === 'rail' && 'text-[0.76rem]')}>{subtitle}</p>
        </div>
        {podiumTeams.length > 0 ? <Badge variant="secondary">{podiumTeams.length} podium</Badge> : null}
      </div>

      <div className={cn('grid grid-cols-[minmax(320px,1.25fr)_minmax(280px,1fr)] gap-px bg-[var(--line)]', variant === 'rail' && 'grid-cols-1')}>
        {podiumTeams.length > 0 ? (
          <section className={showcaseCardClass} aria-label="Top three podium">
            <div className={sectionHeadClass}>
              <Trophy size={16} aria-hidden="true" />
              <h3>Top three</h3>
            </div>
            <ol className="mt-3.5 grid list-none grid-cols-3 gap-2 p-0">
              {podiumTeams.map((team, index) => (
                <li className={cn('grid min-w-0 gap-2 rounded-[var(--r-sm)] border border-[var(--line)] bg-[color-mix(in_oklch,var(--surface-2)_50%,transparent)] p-3 [&_b]:block [&_b]:overflow-hidden [&_b]:text-ellipsis [&_b]:whitespace-nowrap [&_b]:text-[0.88rem] [&_b]:text-[var(--text-strong)] [&_small]:mt-0.5 [&_small]:block [&_small]:overflow-hidden [&_small]:text-ellipsis [&_small]:whitespace-nowrap [&_small]:text-[0.72rem] [&_small]:text-[var(--muted)] [&_strong]:text-[1.05rem] [&_strong]:text-[var(--rank-gold)] [&_strong]:tabular-nums', index === 0 && 'border-[color-mix(in_oklch,var(--rank-gold),var(--line)_28%)]')} key={team.id ?? `${teamName(team)}-${index}`}>
                  <span className="w-max rounded-full border border-[var(--line)] px-[7px] py-[3px] font-mono text-[0.72rem] font-[760] text-[var(--rank-gold)]">#{team.rank ?? index + 1}</span>
                  <div>
                    <b>{teamName(team)}</b>
                    <small>{teamSubtitle(team)}</small>
                  </div>
                  <strong className="num">{formatRating(team.rating ?? team.score)}</strong>
                  <span className={cn('font-mono text-[0.74rem] font-[720] text-[var(--faint)]', movementClass(team.movement))}>
                    {formatMovement(team.movement)}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <section className={cn(showcaseCardClass, variant === 'rail' && 'px-4 py-3.5')} aria-label="Ranking tier counts">
          <div className={sectionHeadClass}>
            <Gauge size={16} aria-hidden="true" />
            <h3>Tier density</h3>
          </div>
          {tiers.length > 0 ? (
            <div className={cn('mt-3.5 flex items-stretch overflow-hidden rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-2)]', variant === 'rail' && 'grid grid-cols-2')}>
              {tiers.map((tier, index) => (
                <TierCard
                  key={tier.tier}
                  tier={tier}
                  index={index}
                  rail={variant === 'rail'}
                  selected={selectedTier === tier.tier}
                  onSelect={onTierSelect}
                />
              ))}
            </div>
          ) : (
            <p className="text-[0.82rem] text-[var(--muted)]">No S/A/B/C tier data supplied.</p>
          )}
        </section>

        <div className={cn('grid grid-cols-2 gap-px bg-[var(--line)]', variant === 'rail' && 'grid-cols-1')}>
          <MovementSpotlight title="Biggest riser" tone="up" movement={biggestRiser} rail={variant === 'rail'} />
          <MovementSpotlight title="Biggest faller" tone="down" movement={biggestFaller} rail={variant === 'rail'} />
        </div>

        <section className={cn(showcaseCardClass, variant === 'rail' && 'px-4 py-3.5')} aria-label="Upset headline">
          <p className="font-mono text-[0.67rem] font-[650] tracking-[0.14em] text-[var(--faint)] uppercase">Upset signal</p>
          <h3 className="mt-3.5 text-[0.96rem] font-[690] text-[var(--text-strong)]">{upsetHeadline(upset)}</h3>
          <div className="mt-2.5 flex flex-wrap items-center gap-[7px] text-[0.76rem] text-[var(--muted)]">
            {upset?.event ? <Badge>{upset.event}</Badge> : null}
            {upset?.score ? <span>{upset.score}</span> : null}
            {typeof upset?.probability === 'number' ? <span>{formatProbability(upset.probability)} pre-match</span> : null}
          </div>
          {upset?.description ? <p className="mt-2 text-[0.78rem] leading-[1.42] text-[var(--muted)]">{upset.description}</p> : null}
        </section>

        <section className={cn(showcaseCardClass, variant === 'rail' && 'px-4 py-3.5', confidenceTone(confidenceBand))} aria-label="Confidence band">
          <div className={sectionHeadClass}>
            <Flame size={16} aria-hidden="true" />
            <h3>{confidenceBand?.label ?? 'Spicy confidence band'}</h3>
          </div>
          <div className="relative mt-3.5 h-[7px] overflow-hidden rounded-full bg-[var(--surface-3)]">
            <span className="absolute inset-y-0 left-0 rounded-[inherit] bg-[var(--rank-gold)]" style={{ width: `${confidencePercent(confidenceBand)}%` }} />
          </div>
          <div className="mt-3 grid gap-1">
            <b className="text-[1.15rem] text-[var(--text-strong)] tabular-nums">{formatPercentValue(confidencePercent(confidenceBand))}</b>
            <small className="mt-2 text-[0.78rem] leading-[1.42] text-[var(--muted)]">{confidenceBand?.description ?? 'Higher means the current ranking story is stronger, not certain.'}</small>
          </div>
        </section>
      </div>
    </section>
  )
}

function MovementSpotlight({
  title,
  tone,
  movement,
  rail,
}: {
  title: string
  tone: 'up' | 'down'
  movement?: RankingMovementSpotlight
  rail: boolean
}) {
  const Icon = tone === 'up' ? ArrowUpRight : ArrowDownRight
  return (
    <section className={cn(showcaseCardClass, rail && 'px-4 py-3.5')} aria-label={title}>
      <div className={sectionHeadClass}>
        <Icon size={16} aria-hidden="true" />
        <h3>{title}</h3>
      </div>
      {movement ? (
        <>
          <b className="mt-4 block text-[0.9rem] text-[var(--text-strong)]">{movement.name ?? movement.team ?? 'Unknown team'}</b>
          <span className={cn('font-mono text-[0.74rem] font-[720]', tone === 'up' ? 'text-[var(--up)]' : 'text-[var(--down)]')}>{movementRange(movement)}</span>
          {movement.description ?? movement.reason ? <p className="mt-2 text-[0.78rem] leading-[1.42] text-[var(--muted)]">{movement.description ?? movement.reason}</p> : null}
        </>
      ) : (
        <p className="text-[0.82rem] text-[var(--muted)]">No movement signal supplied.</p>
      )}
    </section>
  )
}

function normalizeTiers(tiers?: readonly RankingTierCount[] | Record<string, number>) {
  if (!tiers) return DEFAULT_TIER_ORDER.map((tier) => ({ tier, label: `${tier}-tier`, count: 0 }))
  if (Array.isArray(tiers)) {
    const byTier = new Map(tiers.map((tier) => [tier.tier, tier]))
    return DEFAULT_TIER_ORDER.map((tier) => byTier.get(tier) ?? { tier, label: `${tier}-tier`, count: 0 })
  }
  const entries = Object.entries(tiers).map(([tier, count]) => ({ tier, count }))
  return entries.sort((left, right) => {
    const leftIndex = DEFAULT_TIER_ORDER.indexOf(left.tier)
    const rightIndex = DEFAULT_TIER_ORDER.indexOf(right.tier)
    if (leftIndex === -1 && rightIndex === -1) return left.tier.localeCompare(right.tier)
    if (leftIndex === -1) return 1
    if (rightIndex === -1) return -1
    return leftIndex - rightIndex
  })
}

function TierCard({
  tier,
  index,
  rail,
  selected,
  onSelect,
}: {
  tier: RankingTierCount
  index: number
  rail: boolean
  selected: boolean
  onSelect?: (tier: string) => void
}) {
  const className = cn(
    'grid h-auto min-w-[54px] shrink flex-[max(var(--tier-size),1)_1_48px] items-stretch justify-stretch border-0 border-l border-[var(--line)] bg-[var(--surface-2)] px-3 py-2.5 text-left font-[inherit] text-inherit first:border-l-0 [&>b]:mt-1 [&>b]:block [&>b]:text-[1.15rem] [&>b]:text-[var(--text-strong)] [&>b]:tabular-nums [&>small]:mt-[3px] [&>small]:block [&>small]:overflow-hidden [&>small]:text-ellipsis [&>small]:whitespace-nowrap [&>small]:text-[0.68rem] [&>small]:text-[var(--muted)] [&>span]:block [&>span]:text-[0.72rem] [&>span]:font-[690] [&>span]:text-[var(--muted)]',
    rail && 'border-t border-l-0 first:border-t-0',
    rail && index === 1 && 'border-t-0 border-l',
    rail && index > 1 && index % 2 === 1 && 'border-l',
    tier.tier.toLowerCase() === 's' && 'bg-[color-mix(in_oklch,var(--rank-gold)_16%,var(--surface))]',
    tier.count === 0 && 'bg-[var(--surface)] [&>b]:text-[var(--muted)]',
    selected && 'bg-[color-mix(in_oklch,var(--accent)_16%,var(--surface-2))] shadow-[inset_0_0_0_1px_var(--accent-line)]',
    selected && tier.tier.toLowerCase() === 's' && 'bg-[color-mix(in_oklch,var(--accent)_18%,color-mix(in_oklch,var(--rank-gold)_16%,var(--surface)))]',
    onSelect && tier.count > 0 && 'cursor-pointer hover:bg-[var(--surface-3)] focus-visible:relative focus-visible:z-1 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus)]',
  )
  const style = { '--tier-size': tier.count } as CSSProperties
  const content = (
    <>
      <span>{tier.label ?? tier.tier}</span>
      <b className="num">{tier.count}</b>
      <TierTeamList tier={tier} />
    </>
  )

  if (!onSelect || tier.count === 0) {
    return (
      <div className={className} style={style}>
        {content}
      </div>
    )
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="default"
      className={className}
      style={style}
      aria-pressed={selected}
      title={`${selected ? 'Clear' : 'Highlight'} ${tier.label ?? tier.tier} teams in the ranking list`}
      onClick={() => onSelect(tier.tier)}
    >
      {content}
    </Button>
  )
}

function TierTeamList({ tier }: { tier: RankingTierCount }) {
  const teams = (tier.teams ?? []).filter(Boolean)
  const visibleTeams = teams.slice(0, VISIBLE_TIER_TEAMS)
  if (visibleTeams.length === 0) return <small>No teams</small>

  const availableCount = Math.max(tier.count, teams.length)
  const hiddenCount = Math.max(availableCount - visibleTeams.length, 0)
  const title = hiddenCount > 0
    ? `${visibleTeams.join(', ')}; ${formatNumber(hiddenCount)} more ${hiddenCount === 1 ? 'team' : 'teams'} in ${tier.label ?? tier.tier}.`
    : visibleTeams.join(', ')

  return (
    <small title={title}>
      {visibleTeams.join(', ')}
      {hiddenCount > 0 ? <em className="ml-1.5 inline font-[650] text-[var(--muted)] not-italic">+{formatNumber(hiddenCount)} more</em> : null}
    </small>
  )
}

function teamName(team: RankingShowcaseTeam) {
  return team.team ?? team.name ?? 'Unknown team'
}

function teamSubtitle(team: RankingShowcaseTeam) {
  const parts = [team.code, team.league, team.region].filter(Boolean)
  return parts.length > 0 ? parts.join(' / ') : team.note ?? 'No region label'
}

function movementClass(value?: number) {
  if (!value) return undefined
  return value > 0 ? 'text-[var(--up)]' : 'text-[var(--down)]'
}

function formatMovement(value?: number) {
  if (!value) return '–'
  return value > 0 ? `▲ ${Math.round(value)}` : `▼ ${Math.abs(Math.round(value))}`
}

function movementRange(movement: RankingMovementSpotlight) {
  if (typeof movement.fromRank === 'number' && typeof movement.toRank === 'number') {
    return `#${movement.fromRank} → #${movement.toRank}`
  }
  if (typeof movement.ranks === 'number') return `${formatSigned(movement.ranks)} ranks`
  if (typeof movement.movement === 'number') return `${formatSigned(movement.movement)} ranks`
  if (typeof movement.ratingDelta === 'number') return `${formatSigned(movement.ratingDelta)} rating`
  return 'Movement pending'
}

function upsetHeadline(upset?: RankingUpsetHeadline) {
  if (!upset) return 'No upset headline supplied'
  if (upset.headline ?? upset.title) return upset.headline ?? upset.title
  if (upset.winner && upset.loser) return `${upset.winner} over ${upset.loser}`
  return 'Upset signal pending'
}

function formatProbability(value: number) {
  return value <= 1 ? formatPercentValue(value * 100) : formatPercentValue(value)
}

function confidencePercent(band?: RankingConfidenceBand) {
  if (!band || typeof band.value !== 'number' || !Number.isFinite(band.value)) return 0
  if (typeof band.min === 'number' && typeof band.max === 'number' && band.max > band.min) {
    return Math.max(0, Math.min(100, Math.round(((band.value - band.min) / (band.max - band.min)) * 100)))
  }
  return Math.max(0, Math.min(100, Math.round(band.value <= 1 ? band.value * 100 : band.value)))
}

function confidenceTone(band?: RankingConfidenceBand) {
  if (band?.tone) return `is-${band.tone}`
  const value = confidencePercent(band)
  if (value >= 82) return 'is-spicy'
  if (value >= 64) return 'is-hot'
  if (value >= 42) return 'is-warm'
  return 'is-cool'
}
