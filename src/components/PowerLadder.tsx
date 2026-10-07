import type { KeyboardEvent } from 'react'
import type { RankingTierLabel } from '../lib/rankingFlair'
import type { RankingSummaryStanding } from '../lib/snapshot'
import { formatRating, teamKey } from '../lib/display'

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
        return (
          <g
            key={teamKey(team)}
            role="button"
            tabIndex={0}
            aria-label={`Rank ${team.rank}, ${team.team}, Power ${formatRating(team.rating)}. Open team.`}
            className="group cursor-pointer outline-none"
            onClick={() => onOpen(team)}
            onKeyDown={(event) => onKeyDown(event, team)}
          >
            <title>{`#${team.rank} ${team.team} · ${formatRating(team.rating)} Power · ±${formatRating(uncertainty)}`}</title>
            <rect x={0} y={y - ROW_HEIGHT / 2} width={WIDTH} height={ROW_HEIGHT} className="fill-transparent group-hover:fill-[var(--surface-2)] group-focus-visible:fill-[var(--surface-3)]" />
            <text x={4} y={y + 3.5} className="fill-muted-foreground font-mono text-2xs font-bold tabular-nums">{team.rank}</text>
            {tier ? <text x={24} y={y + 3.5} className="font-mono text-2xs font-bold" fill={TIER_FILL[tier]}>{tier}</text> : null}
            <text x={36} y={y + 3.5} className="fill-foreground font-mono text-2xs font-bold">{team.code ?? team.team.slice(0, 4)}</text>
            <line x1={x(team.rating - uncertainty)} x2={x(team.rating + uncertainty)} y1={y} y2={y} className="stroke-[var(--line-strong)]" strokeWidth={2} strokeLinecap="round" />
            <circle cx={x(team.rating)} cy={y} r={4.5} fill={tier ? TIER_FILL[tier] : 'var(--muted)'} className="stroke-card" strokeWidth={2} />
          </g>
        )
      })}
    </svg>
  )
}
