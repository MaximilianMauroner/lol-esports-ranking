import type { KeyboardEvent } from 'react'
import type { RankingTierLabel } from '../lib/rankingFlair'
import type { RankingSummaryStanding } from '../lib/snapshot'
import { formatRating, formatRatio, teamKey } from '../lib/display'
import { TeamMark } from './TeamMark'
import { FormDots } from './ui'
import { HoverCard, HoverCardContent, HoverCardTrigger } from './ui/hover-card'

const WIDTH = 320
const ROW_HEIGHT = 20
const TOP = 22
const BOTTOM = 26
const LEFT = 76
const RIGHT = 12
const TICK_STEP = 100

const TIER_FILL: Record<RankingTierLabel, string> = {
  S: 'var(--tier-s)',
  A: 'var(--tier-a)',
  B: 'var(--tier-b)',
  C: 'var(--tier-c)',
}

/**
 * The ranked teams on one Power axis, so the gaps between them are visible.
 * Each dot is a team's score and its whisker is the published uncertainty.
 * A bracket joins neighbours that are near ties by the matchup model, which
 * shows at a glance where the board's order is firm and where it is not.
 *
 * Each row is a button that opens the team, and the ranked board below is
 * the same data as a table.
 */
export function PowerLadder({
  groups,
  tierFor,
  gapExample,
  onOpen,
}: {
  /** Ranked teams, best first, split into near-tie runs. */
  groups: readonly (readonly RankingSummaryStanding[])[]
  tierFor: (team: RankingSummaryStanding) => RankingTierLabel | undefined
  /** Game win chance for a 100-point gap, from the model. */
  gapExample: number
  onOpen: (team: RankingSummaryStanding) => void
}) {
  const teams = groups.flat()
  if (teams.length < 2) return null

  const low = Math.min(...teams.map((team) => team.rating - (team.uncertainty ?? 0)))
  const high = Math.max(...teams.map((team) => team.rating + (team.uncertainty ?? 0)))
  const min = Math.floor(low / TICK_STEP) * TICK_STEP
  const max = Math.ceil(high / TICK_STEP) * TICK_STEP
  const x = (value: number) => LEFT + ((value - min) / (max - min)) * (WIDTH - LEFT - RIGHT)
  const height = TOP + teams.length * ROW_HEIGHT + BOTTOM
  const ticks = Array.from({ length: Math.round((max - min) / TICK_STEP) + 1 }, (_, index) => min + index * TICK_STEP)
  const labelEvery = ticks.length > 5 ? 2 : 1

  function onKeyDown(event: KeyboardEvent<SVGGElement>, team: RankingSummaryStanding) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onOpen(team)
  }

  const groupStarts = groups.map((_, index) => groups.slice(0, index).reduce((count, group) => count + group.length, 0))
  return (
    <svg
      className="block h-auto w-full"
      viewBox={`0 0 ${WIDTH} ${height}`}
      role="group"
      aria-label={`Power ladder: ${teams.length} ranked teams on one Power axis. Brackets join near ties. Select a team to open it.`}
    >
      <text x={LEFT} y={12} className="fill-[var(--faint)] text-2xs">Power · 100 pts ≈ {gapExample}% game win</text>
      {ticks.map((tick, index) => (
        <g key={tick}>
          <line x1={x(tick)} x2={x(tick)} y1={TOP - 4} y2={height - BOTTOM + 4} className="stroke-border" />
          {index % labelEvery === 0 ? (
            <text x={x(tick)} y={height - 8} textAnchor="middle" className="fill-[var(--faint)] text-2xs tabular-nums">{formatRating(tick)}</text>
          ) : null}
        </g>
      ))}
      {groups.map((group, groupIndex) => {
        if (group.length < 2) return null
        const first = groupStarts[groupIndex]
        const ratings = group.map((team) => team.rating)
        const x1 = x(Math.min(...ratings)) - 8
        const x2 = x(Math.max(...ratings)) + 8
        return (
          <rect
            key={teamKey(group[0])}
            x={x1}
            y={TOP + first * ROW_HEIGHT + 3}
            width={x2 - x1}
            height={group.length * ROW_HEIGHT - 6}
            rx={6}
            className="fill-[color-mix(in_oklch,var(--muted)_6%,transparent)] stroke-muted-foreground"
          >
            <title>{`Near tie: ${group.map((team) => team.code ?? team.team).join(', ')}`}</title>
          </rect>
        )
      })}
      {teams.map((team, index) => {
        const y = TOP + index * ROW_HEIGHT + ROW_HEIGHT / 2
        const tier = tierFor(team)
        const uncertainty = team.uncertainty ?? 0
        const neighbours = groups.find((group) => group.includes(team))?.filter((other) => other !== team) ?? []
        const total = team.wins + team.losses
        return (
          <HoverCard key={teamKey(team)}>
            <HoverCardTrigger delay={250} render={(
              <g
                role="button"
                tabIndex={0}
                aria-label={`Rank ${team.rank}, ${team.team}, Power ${formatRating(team.rating)}. Open team.`}
                className="group cursor-pointer outline-none"
                onClick={() => onOpen(team)}
                onKeyDown={(event) => onKeyDown(event, team)}
              >
                <rect x={0} y={y - ROW_HEIGHT / 2} width={WIDTH} height={ROW_HEIGHT} className="fill-transparent group-hover:fill-[var(--surface-2)] group-focus-visible:fill-[var(--surface-3)]" />
                <text x={4} y={y + 3.5} className="fill-muted-foreground font-mono text-2xs font-bold tabular-nums">{team.rank}</text>
                {tier ? <text x={24} y={y + 3.5} className="font-mono text-2xs font-bold" fill={TIER_FILL[tier]}>{tier}</text> : null}
                <text x={36} y={y + 3.5} className="fill-foreground font-mono text-2xs font-bold">{team.code ?? team.team.slice(0, 4)}</text>
                <line x1={x(team.rating - uncertainty)} x2={x(team.rating + uncertainty)} y1={y} y2={y} className="stroke-[var(--line-strong)]" strokeWidth={2} strokeLinecap="round" />
                <circle cx={x(team.rating)} cy={y} r={4.5} fill={tier ? TIER_FILL[tier] : 'var(--muted)'} className="stroke-card" strokeWidth={2} />
              </g>
            )} />
            <HoverCardContent side="left" align="start">
              <div className="flex items-center gap-3">
                <TeamMark team={team.team} code={team.code} />
                <div className="min-w-0">
                  <p className="font-semibold text-[var(--text-strong)]">{team.team}</p>
                  <p className="text-xs text-muted-foreground">#{team.rank} · {team.league}{tier ? ` · Tier ${tier}` : ''}</p>
                </div>
              </div>
              <div className="my-3 border-y border-border py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-muted-foreground">Power</span>
                  <strong className="font-mono text-lg tabular-nums">{formatRating(team.rating)} <span className="text-xs font-normal text-muted-foreground">±{formatRating(uncertainty)}</span></strong>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{formatRating(team.rating - uncertainty)}–{formatRating(team.rating + uncertainty)} · model uncertainty range</p>
              </div>
              <dl className="flex justify-between gap-4 text-xs">
                <div><dt className="text-muted-foreground">Record</dt><dd className="mt-1 font-mono font-semibold tabular-nums">{team.wins}–{team.losses}</dd></div>
                <div><dt className="text-muted-foreground">Win rate</dt><dd className="mt-1 font-mono font-semibold tabular-nums">{formatRatio(total > 0 ? team.wins / total : undefined)}</dd></div>
                <div><dt className="mb-1 text-muted-foreground">Last five</dt><dd><FormDots form={team.form} /></dd></div>
              </dl>
              {neighbours.length > 0 ? <p className="mt-3 text-xs text-muted-foreground">Near tie with <span className="text-foreground">{neighbours.map((other) => other.code ?? other.team).join(', ')}</span>.</p> : null}
              <p className="mt-3 text-xs text-[var(--faint)]">Select the row for team details.</p>
            </HoverCardContent>
          </HoverCard>
        )
      })}
    </svg>
  )
}
