import type { RankingTierLabel } from '../../domains/rankings/read'
import type { RankingSummaryStanding } from '../../domains/rankings/types'
import { formatRating, formatRatio, teamKey } from '../../shared/display'
import { TeamMark } from '../../components/TeamMark'
import { FormDots } from '../../components/ui'
import { PointChart } from '../../components/PointChart'

const WIDTH = 320
const ROW_HEIGHT = 32
const TOP = 8
const BOTTOM = 26
const LEFT = 88
const RIGHT = 24
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
 * Selecting a row opens the team, and the ranked board below is the same
 * data as a table.
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

  const groupStarts = groups.map((_, index) => groups.slice(0, index).reduce((count, group) => count + group.length, 0))
  const targets = teams.map((team, index) => ({ key: teamKey(team), x: x(team.rating), y: TOP + index * ROW_HEIGHT + ROW_HEIGHT / 2, row: index, team }))
  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">100 pts ≈ {gapExample}% game win</p>
      <p className="mb-2 text-2xs text-muted-foreground">Dot: Power · line: uncertainty · bracket: near tie</p>
      <PointChart
        width={WIDTH}
        height={height}
        targets={targets}
        crosshair={{ top: TOP - 4, bottom: height - BOTTOM + 4 }}
        label={`Power ladder: ${teams.length} ranked teams on one Power axis. Brackets join near ties. Select a team to open it.`}
        className="min-w-[240px]"
        onSelect={({ team }) => onOpen(team)}
        tooltip={({ team }) => <LadderTooltip team={team} tier={tierFor(team)} neighbours={groups.find((group) => group.includes(team))?.filter((other) => other !== team) ?? []} />}
      >
        {(active) => (
          <>
            {ticks.map((tick, index) => (
              <g key={tick}>
                <line x1={x(tick)} x2={x(tick)} y1={TOP - 4} y2={height - BOTTOM + 4} className="stroke-border" />
                {index % labelEvery === 0 ? (
                  <text x={x(tick)} y={height - 8} textAnchor="middle" className="fill-[var(--faint)] text-2xs tabular-nums">{formatRating(tick)}</text>
                ) : null}
              </g>
            ))}
            {targets.map(({ key, y, team }) => {
              const tier = tierFor(team)
              const uncertainty = team.uncertainty ?? 0
              return (
                <g key={key} data-team={team.team}>
                  <rect x={0} y={y - ROW_HEIGHT / 2} width={WIDTH} height={ROW_HEIGHT} className={active?.team === team ? 'fill-[var(--surface-2)]' : 'fill-transparent'} />
                  <text x={4} y={y + 3.5} className="fill-muted-foreground font-mono text-2xs font-bold tabular-nums">{team.rank}</text>
                  {tier ? <text x={24} y={y + 3.5} className="font-mono text-2xs font-bold" fill={TIER_FILL[tier]}>{tier}</text> : null}
                  <text x={36} y={y + 3.5} className="fill-foreground font-mono text-2xs font-bold">{team.code ?? team.team.slice(0, 4)}</text>
                  <line x1={x(team.rating - uncertainty)} x2={x(team.rating + uncertainty)} y1={y} y2={y} className="stroke-[var(--line-strong)]" strokeWidth={2} strokeLinecap="round" />
                  <circle cx={x(team.rating)} cy={y} r={4.5} fill={tier ? TIER_FILL[tier] : 'var(--muted)'} className="stroke-card" strokeWidth={2} />
                </g>
              )
            })}
            {groups.map((group, groupIndex) => {
              if (group.length < 2) return null
              const first = groupStarts[groupIndex]
              const y1 = TOP + first * ROW_HEIGHT + ROW_HEIGHT / 2
              const y2 = y1 + (group.length - 1) * ROW_HEIGHT
              return (
                <path
                  key={teamKey(group[0])}
                  d={`M ${LEFT - 12} ${y1} h -5 V ${y2} h 5`}
                  className="fill-none stroke-muted-foreground pointer-events-none"
                >
                  <title>{`Near tie: ${group.map((team) => team.code ?? team.team).join(', ')}`}</title>
                </path>
              )
            })}
          </>
        )}
      </PointChart>
    </div>
  )
}

function LadderTooltip({ team, tier, neighbours }: { team: RankingSummaryStanding; tier: RankingTierLabel | undefined; neighbours: readonly RankingSummaryStanding[] }) {
  const total = team.wins + team.losses
  return (
    <>
      <div className="flex items-center gap-2.5">
        <TeamMark team={team.team} code={team.code} />
        <div className="min-w-0">
          <p className="font-semibold text-[var(--text-strong)]">{team.team}</p>
          <p className="text-muted-foreground">#{team.rank} · {team.league}{tier ? ` · Tier ${tier}` : ''}</p>
        </div>
      </div>
      <div className="flex items-baseline justify-between gap-3 border-y border-border/50 py-1.5">
        <span className="text-muted-foreground">Power</span>
        <strong className="font-mono text-sm tabular-nums">{formatRating(team.rating)} <span className="font-normal text-muted-foreground">±{formatRating(team.uncertainty ?? 0)}</span></strong>
      </div>
      <dl className="flex justify-between gap-3">
        <div><dt className="text-muted-foreground">Record</dt><dd className="font-mono font-semibold tabular-nums">{team.wins}–{team.losses}</dd></div>
        <div><dt className="text-muted-foreground">Win rate</dt><dd className="font-mono font-semibold tabular-nums">{formatRatio(total > 0 ? team.wins / total : undefined)}</dd></div>
        <div><dt className="mb-0.5 text-muted-foreground">Last five</dt><dd><FormDots form={team.form} /></dd></div>
      </dl>
      {neighbours.length > 0 ? <p className="text-muted-foreground">Near tie with <span className="text-foreground">{neighbours.length > 3 ? `${neighbours.length} other teams` : neighbours.map((other) => other.code ?? other.team).join(', ')}</span>.</p> : null}
    </>
  )
}
