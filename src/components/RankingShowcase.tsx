import { ArrowDownRight, ArrowUpRight, Flame, Zap } from 'lucide-react'
import { Badge } from './ui/badge'
import { Panel, PanelBody, PanelFooter, PanelHeader } from './ui/panel'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { formatNumber, formatPercentValue, formatSigned } from '../lib/display'

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
  title?: string
  podium?: readonly RankingShowcaseTeam[]
  tierCounts?: readonly RankingTierCount[] | Record<string, number>
  tierStrips?: readonly RankingTierCount[]
  biggestRiser?: RankingMovementSpotlight
  biggestFaller?: RankingMovementSpotlight
  upset?: RankingUpsetHeadline
  confidenceBand?: RankingConfidenceBand
  selectedTier?: string | null
  onTierSelect?: (tier: string) => void
  className?: string
}

const DEFAULT_TIER_ORDER = ['S', 'A', 'B', 'C']
const VISIBLE_TIER_TEAMS = 3

/**
 * Tier legend and filter, in the right rail.
 *
 * Cells are an even 2x2 grid, not proportional to team count. Width-by-count
 * reads as a distribution bar, but the counts are wildly uneven (a C tier
 * holding 40 teams next to an S tier holding 3), so the small tiers collapse
 * and the strip stops working as a legend.
 */
export function TierPanel({
  tierCounts,
  tierStrips,
  selectedTier,
  onTierSelect,
  className,
}: Pick<RankingShowcaseProps, 'tierCounts' | 'tierStrips' | 'selectedTier' | 'onTierSelect' | 'className'>) {
  const tiers = normalizeTiers(tierStrips ?? tierCounts)
  if (tiers.length === 0) return null

  return (
    <Panel className={className}>
      <PanelHeader title="Tier density" />
      <div className="grid grid-cols-2 gap-px bg-[var(--line)]" role="group" aria-label="Tier density">
        {tiers.map((tier) => (
          <TierCard key={tier.tier} tier={tier} selected={selectedTier === tier.tier} onSelect={onTierSelect} />
        ))}
      </div>
    </Panel>
  )
}

/**
 * The movement panel: the two spotlights, with the upset headline and the
 * confidence readout folded into a footer.
 */
export function RankingSignals({
  biggestRiser,
  biggestFaller,
  upset,
  confidenceBand,
  className,
}: Pick<RankingShowcaseProps, 'biggestRiser' | 'biggestFaller' | 'upset' | 'confidenceBand' | 'className'>) {
  const confidence = confidencePercent(confidenceBand)

  return (
    <Panel className={className}>
      <PanelHeader title="Movement" />
      <PanelBody className="grid gap-3.5 py-3.5">
        <MovementSpotlight title="Biggest riser" tone="up" movement={biggestRiser} />
        <MovementSpotlight title="Biggest faller" tone="down" movement={biggestFaller} />
      </PanelBody>
      <PanelFooter className="grid gap-3 py-3">
        <div className="grid gap-1">
          <span className="flex items-center gap-2 text-xs font-medium text-[var(--muted)]">
            <Zap className="size-3.5 text-[var(--faint)]" aria-hidden="true" />
            Upset signal
          </span>
          <b className="text-sm font-semibold text-[var(--text-strong)]">{upsetHeadline(upset)}</b>
          {upset?.event || upset?.score ? (
            <span className="flex flex-wrap items-center gap-1.5 text-2xs text-[var(--faint)]">
              {upset?.event ? <Badge variant="event">{upset.event}</Badge> : null}
              {upset?.score ? <span className="tabular-nums">{upset.score}</span> : null}
            </span>
          ) : null}
        </div>
        <div className="grid gap-1.5">
          <span className="flex items-center justify-between gap-2 text-xs font-medium text-[var(--muted)]">
            <span className="flex min-w-0 items-center gap-2">
              <Flame className="size-3.5 shrink-0 text-[var(--faint)]" aria-hidden="true" />
              <span className="truncate">{confidenceBand?.label ?? 'Confidence'}</span>
            </span>
            <b className="shrink-0 text-sm font-bold text-[var(--text-strong)] tabular-nums">{formatPercentValue(confidence)}</b>
          </span>
          {/* --rank-gold reads as rank quality here, which is what a confidence
              band in a ranking product measures. It no longer also marks the
              active nav item. */}
          <span className="relative h-1.5 overflow-hidden rounded-full bg-[var(--surface-3)]" aria-hidden="true">
            <span className="absolute inset-y-0 left-0 rounded-[inherit] bg-[var(--rank-gold)]" style={{ width: `${confidence}%` }} />
          </span>
        </div>
      </PanelFooter>
    </Panel>
  )
}

function MovementSpotlight({
  title,
  tone,
  movement,
}: {
  title: string
  tone: 'up' | 'down'
  movement?: RankingMovementSpotlight
}) {
  const Icon = tone === 'up' ? ArrowUpRight : ArrowDownRight
  return (
    <section className="grid min-w-0 gap-0.5" aria-label={title}>
      <span className="flex items-center gap-2 text-xs font-medium text-[var(--muted)]">
        <Icon className={cn('size-3.5', tone === 'up' ? 'text-[var(--up)]' : 'text-[var(--down)]')} aria-hidden="true" />
        {title}
      </span>
      {movement ? (
        <>
          <span className="flex flex-wrap items-baseline gap-x-2">
            <b className="min-w-0 truncate text-md font-semibold text-[var(--text-strong)]">{movement.name ?? movement.team ?? 'Unknown team'}</b>
            <span className={cn('font-mono text-xs font-bold tabular-nums', tone === 'up' ? 'text-[var(--up)]' : 'text-[var(--down)]')}>{movementRange(movement)}</span>
          </span>
          {movement.description ?? movement.reason ? (
            <p className="text-xs leading-[1.42] text-[var(--faint)]">{movement.description ?? movement.reason}</p>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-[var(--faint)]">No movement signal in this scope.</p>
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
  selected,
  onSelect,
}: {
  tier: RankingTierCount
  selected: boolean
  onSelect?: (tier: string) => void
}) {
  const className = cn(
    'grid h-auto min-h-0 min-w-0 content-start items-stretch justify-stretch rounded-none border-0 bg-[var(--surface-2)] px-3 py-2 text-left font-[inherit] whitespace-normal text-inherit',
    '[&>b]:block [&>b]:text-lg [&>b]:font-bold [&>b]:text-[var(--text-strong)] [&>b]:tabular-nums',
    '[&>small]:block [&>small]:overflow-hidden [&>small]:text-ellipsis [&>small]:whitespace-nowrap [&>small]:text-2xs [&>small]:text-[var(--faint)]',
    '[&>span]:block [&>span]:text-xs [&>span]:font-medium [&>span]:text-[var(--muted)]',
    tier.tier.toLowerCase() === 's' && '[&>b]:text-[var(--rank-gold)]',
    tier.count === 0 && 'bg-[var(--surface)] [&>b]:text-[var(--faint)]',
    selected && 'bg-[var(--selected-bg)] shadow-[inset_0_0_0_1px_var(--selected-line)]',
    onSelect && tier.count > 0 && 'cursor-pointer hover:bg-[var(--surface-3)] focus-visible:relative focus-visible:z-1 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus)]',
  )
  const content = (
    <>
      <span>{tier.label ?? tier.tier}</span>
      <b className="num">{tier.count}</b>
      <TierTeamList tier={tier} />
    </>
  )

  if (!onSelect || tier.count === 0) {
    return <div className={className}>{content}</div>
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="default"
      className={className}
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
      {hiddenCount > 0 ? <em className="ml-1 inline font-semibold text-[var(--muted)] not-italic">+{formatNumber(hiddenCount)}</em> : null}
    </small>
  )
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
  if (!upset) return 'No upset in this scope'
  if (upset.headline ?? upset.title) return upset.headline ?? upset.title
  if (upset.winner && upset.loser) return `${upset.winner} over ${upset.loser}`
  return 'Upset signal pending'
}

function confidencePercent(band?: RankingConfidenceBand) {
  if (!band || typeof band.value !== 'number' || !Number.isFinite(band.value)) return 0
  if (typeof band.min === 'number' && typeof band.max === 'number' && band.max > band.min) {
    return Math.max(0, Math.min(100, Math.round(((band.value - band.min) / (band.max - band.min)) * 100)))
  }
  return Math.max(0, Math.min(100, Math.round(band.value <= 1 ? band.value * 100 : band.value)))
}
