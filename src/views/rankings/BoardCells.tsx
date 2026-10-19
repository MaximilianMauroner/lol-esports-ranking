import { useMemo } from 'react'
import { RegionBadge } from '../../components/ui'
import { Button } from '../../components/ui/button'
import { Panel, PanelFooter, PanelHeader } from '../../components/ui/panel'
import type { RankingTierLabel } from '../../domains/rankings/read'
import { displayRegionPowerScore, NEAR_TIE_WIN_PROBABILITY, type NearTiePosition, type RegionStrength } from '../../domains/rankings/read'
import type { RankingSummaryStanding } from '../../domains/rankings/types'
import { formatNumber, formatRating } from '../../shared/display'
import { cn } from '../../shared/utils'
import { clampNumber, teamScoreFor, teamScoreTitle } from './boardFormat'

/** Chips for a small, fixed set of mutually exclusive filter values. */
export function ChipGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string; disabled?: boolean }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1" role="group" aria-label={label}>
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          variant="tab"
          size="sm"
          aria-pressed={value === option.value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className="h-8 px-3 disabled:opacity-50"
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}

/** Neutral bracket in the rank cell joining rows the model calls a near tie.
 *  Gold is reserved for rank quality, and a near tie is model uncertainty. */
export function NearTieMark({ position }: { position: NearTiePosition }) {
  return (
    <span
      className={cn(
        'absolute left-1 w-0.5 bg-muted-foreground',
        position === 'start' && 'top-1/2 bottom-0 rounded-t-full',
        position === 'middle' && 'inset-y-0',
        position === 'end' && 'top-0 bottom-1/2 rounded-b-full',
      )}
      title={`Near tie with the team next to it: under ${Math.round(NEAR_TIE_WIN_PROBABILITY * 100)}% per game`}
      aria-hidden="true"
    />
  )
}

export function TeamScoreCell({
  team,
  min,
  max,
  exactTournament = false,
}: {
  team: RankingSummaryStanding
  min: number
  max: number
  exactTournament?: boolean
}) {
  const score = teamScoreFor(team)
  if (typeof score !== 'number') {
    return <span className="score-unavailable font-mono text-sm font-semibold text-[var(--faint)]" aria-hidden="true">—</span>
  }
  const share = max > min ? clampNumber(((score - min) / (max - min)) * 100, 4, 100) : 100
  return (
    <span className="team-score-stack flex min-w-0 items-center gap-2.5" title={exactTournament ? `Tournament endpoint Power ${formatRating(score)}` : teamScoreTitle(team)}>
      <span className="team-score-value min-w-[3.4em] text-right font-mono text-base font-extrabold text-[var(--text-strong)] tabular-nums">{formatRating(score)}</span>
      <span className="score-track relative h-1.5 min-w-10 flex-1 overflow-hidden rounded-full bg-[var(--surface-3)]" aria-hidden="true">
        <span className="absolute inset-y-0 left-0 rounded-full bg-[var(--faint)]" style={{ width: `${share}%` }} />
      </span>
    </span>
  )
}

export function TeamBoardRank({
  team,
  rank,
  rawScoreRank,
}: {
  team: RankingSummaryStanding
  rank?: number
  rawScoreRank?: number
}) {
  if (team.eligibility?.eligible === false) {
    return (
      <span className="board-rank-stack inline-flex min-w-0 flex-col items-start gap-1">
        <span className="board-rank board-rank--excluded min-w-0 text-xs font-bold text-muted-foreground tabular-nums">Unranked</span>
        {typeof rawScoreRank === 'number' ? (
          <span className="text-2xs text-[var(--faint)]" title="Where the score would place if eligibility checks were ignored.">score #{formatNumber(rawScoreRank)}</span>
        ) : null}
      </span>
    )
  }

  return (
    <span className={cn('board-rank min-w-[1.4em] text-base font-bold text-[var(--text-strong)] tabular-nums', typeof rank === 'number' && rank <= 3 && 'podium text-[var(--rank-gold)]')}>
      {rank ?? '—'}
    </span>
  )
}

const TIER_BADGE_COLOR: Record<RankingTierLabel, string> = {
  S: '[--tier-color:var(--tier-s)]',
  A: '[--tier-color:var(--tier-a)]',
  B: '[--tier-color:var(--tier-b)]',
  C: '[--tier-color:var(--tier-c)]',
}

export function TierBadge({ tier }: { tier: RankingTierLabel }) {
  return (
    <span
      className={cn(
        'tier-badge inline-flex h-6 min-w-[26px] items-center justify-center rounded-sm border border-[color-mix(in_oklch,var(--tier-color)_40%,var(--line))] bg-[color-mix(in_oklch,var(--tier-color)_11%,transparent)] px-2 font-mono text-sm font-bold leading-none text-[var(--tier-color)]',
        TIER_BADGE_COLOR[tier],
      )}
      role="img"
      title={`${tier}-tier`}
      aria-label={`${tier}-tier`}
    >
      {tier}
    </span>
  )
}

export function RegionalStrengthTeaser({ regions, href }: { regions: RegionStrength[]; href?: string }) {
  const ranked = useMemo(() => [...regions].sort((a, b) => displayRegionPowerScore(b) - displayRegionPowerScore(a)), [regions])
  if (ranked.length === 0) return null
  return (
    <Panel aria-label="Region power scores">
      <PanelHeader
        title="Region power"
        actions={href ? <a className="inline-flex min-h-6 min-w-6 shrink-0 items-center text-xs font-semibold text-[var(--accent-strong)] no-underline hover:underline hover:underline-offset-[3px]" href={href}>Details</a> : undefined}
      />
      <div className="grid grid-cols-1 gap-px bg-border">
        {ranked.map((region) => (
          <div className="flex min-w-0 items-center gap-2.5 bg-card px-4 py-2 [&_.region-badge]:h-5 [&_.region-badge]:w-[22px]" key={region.region}>
            <RegionBadge region={region.region} size="sm" />
            <span className="mr-auto min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs font-semibold text-foreground">{region.region}</span>
            <strong className="shrink-0 text-sm font-bold text-[var(--text-strong)] tabular-nums">{formatRating(displayRegionPowerScore(region))}</strong>
          </div>
        ))}
      </div>
      <PanelFooter className="text-xs leading-[1.35] text-[var(--faint)]">
        Average of each region’s top three eligible flagship teams.
      </PanelFooter>
    </Panel>
  )
}

export function TournamentMoveChip({
  movement,
  endpointLabel,
}: {
  movement?: PublicTournamentMovementTeam
  endpointLabel: string
}) {
  if (!movement) return <MovementChip title="Tournament movement unavailable" />
  return (
    <MovementChip
      places={movement.rankMovement}
      title={`${movement.team}: ${formatRankValue(movement.startRank)} to ${formatRankValue(movement.endRank)} at ${endpointLabel.toLowerCase()}, ${formatRatingMovement(movement.ratingDelta)} Power.`}
    />
  )
}

import type { PublicTournamentMovementTeam } from '../../domains/rankings/types'
import { MovementChip } from './WhatChanged'
import { formatRankValue, formatRatingMovement } from './boardFormat'
