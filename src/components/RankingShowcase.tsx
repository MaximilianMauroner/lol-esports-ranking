import { ArrowDownRight, ArrowUpRight, Flame, Gauge, Trophy } from 'lucide-react'
import type { CSSProperties } from 'react'
import { Badge } from './ui/badge'
import { cn } from '../lib/utils'
import { formatPercentValue, formatRating, formatSigned } from '../lib/display'

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
  subtitle?: string
  podium?: readonly RankingShowcaseTeam[]
  tierCounts?: readonly RankingTierCount[] | Record<string, number>
  tierStrips?: readonly RankingTierCount[]
  biggestRiser?: RankingMovementSpotlight
  biggestFaller?: RankingMovementSpotlight
  upset?: RankingUpsetHeadline
  confidenceBand?: RankingConfidenceBand
  variant?: 'panel' | 'rail'
  className?: string
}

const DEFAULT_TIER_ORDER = ['S', 'A', 'B', 'C']

export function RankingShowcase({
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
  className,
}: RankingShowcaseProps) {
  const podiumTeams = podium.slice(0, 3)
  const tiers = normalizeTiers(tierStrips ?? tierCounts)

  return (
    <section className={cn('ranking-showcase', variant === 'rail' && 'ranking-showcase--rail', className)} aria-label={title}>
      <div className="ranking-showcase__header">
        <div>
          <p className="receipt-eyebrow">Snapshot readout</p>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        {podiumTeams.length > 0 ? <Badge variant="secondary">{podiumTeams.length} podium</Badge> : null}
      </div>

      <div className="ranking-showcase__grid">
        {podiumTeams.length > 0 ? (
          <section className="ranking-showcase__podium-wrap" aria-label="Top three podium">
            <div className="receipt-section-head">
              <Trophy size={16} aria-hidden="true" />
              <h3>Top three</h3>
            </div>
            <ol className="ranking-showcase__podium">
              {podiumTeams.map((team, index) => (
                <li className={cn('ranking-showcase__podium-team', podiumClass(index))} key={team.id ?? `${teamName(team)}-${index}`}>
                  <span className="ranking-showcase__rank">#{team.rank ?? index + 1}</span>
                  <div>
                    <b>{teamName(team)}</b>
                    <small>{teamSubtitle(team)}</small>
                  </div>
                  <strong className="num">{formatRating(team.rating ?? team.score)}</strong>
                  <span className={cn('ranking-showcase__movement', movementClass(team.movement))}>
                    {formatMovement(team.movement)}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <section className="ranking-showcase__tiers" aria-label="Ranking tier counts">
          <div className="receipt-section-head">
            <Gauge size={16} aria-hidden="true" />
            <h3>Tier density</h3>
          </div>
          {tiers.length > 0 ? (
            <div className="ranking-showcase__tier-strip">
              {tiers.map((tier) => (
                <div
                  className={`ranking-showcase__tier is-${tier.tier.toLowerCase()}`}
                  key={tier.tier}
                  style={{ '--tier-size': tier.count } as CSSProperties}
                >
                  <span>{tier.label ?? tier.tier}</span>
                  <b className="num">{tier.count}</b>
                  {tier.teams?.length ? <small>{tier.teams.slice(0, 3).join(', ')}</small> : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="receipt-muted">No S/A/B/C tier data supplied.</p>
          )}
        </section>

        <div className="ranking-showcase__movement-grid">
          <MovementSpotlight title="Biggest riser" tone="up" movement={biggestRiser} />
          <MovementSpotlight title="Biggest faller" tone="down" movement={biggestFaller} />
        </div>

        <section className="ranking-showcase__headline" aria-label="Upset headline">
          <p className="receipt-eyebrow">Upset signal</p>
          <h3>{upsetHeadline(upset)}</h3>
          <div className="ranking-showcase__headline-meta">
            {upset?.event ? <Badge>{upset.event}</Badge> : null}
            {upset?.score ? <span>{upset.score}</span> : null}
            {typeof upset?.probability === 'number' ? <span>{formatProbability(upset.probability)} pre-match</span> : null}
          </div>
          {upset?.description ? <p>{upset.description}</p> : null}
        </section>

        <section className={cn('ranking-showcase__confidence', confidenceTone(confidenceBand))} aria-label="Confidence band">
          <div className="receipt-section-head">
            <Flame size={16} aria-hidden="true" />
            <h3>{confidenceBand?.label ?? 'Spicy confidence band'}</h3>
          </div>
          <div className="receipt-band">
            <span style={{ width: `${confidencePercent(confidenceBand)}%` }} />
          </div>
          <div className="ranking-showcase__confidence-meta">
            <b className="num">{formatPercentValue(confidencePercent(confidenceBand))}</b>
            <small>{confidenceBand?.description ?? 'Higher means the current ranking story is stronger, not certain.'}</small>
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
}: {
  title: string
  tone: 'up' | 'down'
  movement?: RankingMovementSpotlight
}) {
  const Icon = tone === 'up' ? ArrowUpRight : ArrowDownRight
  return (
    <section className={cn('ranking-showcase__movement-card', `is-${tone}`)} aria-label={title}>
      <div className="receipt-section-head">
        <Icon size={16} aria-hidden="true" />
        <h3>{title}</h3>
      </div>
      {movement ? (
        <>
          <b>{movement.name ?? movement.team ?? 'Unknown team'}</b>
          <span className="ranking-showcase__movement-value">{movementRange(movement)}</span>
          {movement.description ?? movement.reason ? <p>{movement.description ?? movement.reason}</p> : null}
        </>
      ) : (
        <p className="receipt-muted">No movement signal supplied.</p>
      )}
    </section>
  )
}

function normalizeTiers(tiers?: readonly RankingTierCount[] | Record<string, number>) {
  if (!tiers) return []
  if (Array.isArray(tiers)) return tiers.filter((tier) => tier.count > 0)
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

function podiumClass(index: number) {
  if (index === 0) return 'is-first'
  if (index === 1) return 'is-second'
  return 'is-third'
}

function teamName(team: RankingShowcaseTeam) {
  return team.team ?? team.name ?? 'Unknown team'
}

function teamSubtitle(team: RankingShowcaseTeam) {
  const parts = [team.code, team.league, team.region].filter(Boolean)
  return parts.length > 0 ? parts.join(' / ') : team.note ?? 'No region label'
}

function movementClass(value?: number) {
  if (!value) return 'is-flat'
  return value > 0 ? 'is-up' : 'is-down'
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
