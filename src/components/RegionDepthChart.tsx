import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import { displayRegionPowerScore, type RegionStrength } from '../lib/regionStrength'
import { formatRating } from '../lib/display'
import { TeamMark } from './TeamMark'
import { HoverCard, HoverCardContent, HoverCardTrigger } from './ui/hover-card'

type RegionDepthInput = Pick<RegionStrength, 'region' | 'rank' | 'score' | 'topTeams' | 'internationalWins' | 'internationalLosses'>

/** Below this width the row labels move above the dots so the axis keeps the full width. */
const STACKED_BELOW = 520
const DEFAULT_WIDTH = 760
const LARGEST_TICK_STEP = 1000
const TICK_STEPS = [25, 50, 100, 200, 250, 500, LARGEST_TICK_STEP]
const MIN_TICK_SPACING = 70
const MAX_TICKS = 6
/** Share of the rating range added on each side of the axis. */
const DOMAIN_PADDING = 0.04
/** Teams at these positions in `topTeams` make up the region score. */
const SCORED_TEAM_COUNT = 3

/**
 * Every ranked team of each region on one shared Power axis. The three teams
 * that make up the region score are series-1 dots, and the region score itself
 * is a white tick. The standings list below the chart is its table view.
 */
export function RegionDepthChart({ regions }: { regions: RegionDepthInput[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const width = useElementWidth(containerRef) ?? DEFAULT_WIDTH
  const layout = useMemo(() => regionDepthLayout(regions, width), [regions, width])
  const titleId = useId()
  const descId = useId()

  return (
    <div ref={containerRef} className="min-w-0">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="block h-auto w-full overflow-visible font-[family-name:var(--sans)]"
        role="group"
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        <title id={titleId}>Region depth: every ranked team by region on one Power axis</title>
        <desc id={descId}>{layout.summary}</desc>

        {layout.ticks.map((tick) => (
          <g key={tick.value}>
            {layout.gridBands.map((band) => (
              <line key={band.y1} x1={tick.x} x2={tick.x} y1={band.y1} y2={band.y2} stroke="var(--line)" strokeWidth={1} />
            ))}
            <text x={tick.x} y={layout.axisLabelY} textAnchor="middle" fill="var(--faint)" className="text-2xs tabular-nums">
              {formatRating(tick.value)}
            </text>
          </g>
        ))}

        {layout.rows.map((row) => (
          <g key={row.region}>
            <text x={0} y={row.labelY} className="text-xs tabular-nums">
              <tspan fill="var(--text-strong)" className="font-bold">{row.rank}. {row.region}</tspan>
              {layout.stacked ? (
                <tspan fill="var(--faint)" className="text-2xs" dx={8}>{row.detail}</tspan>
              ) : null}
            </text>
            {layout.stacked ? null : (
              <text x={0} y={row.detailY} fill="var(--faint)" className="text-2xs tabular-nums">{row.detail}</text>
            )}

            {row.span ? (
              <line x1={row.span.x1} x2={row.span.x2} y1={row.dotY} y2={row.dotY} stroke="var(--line-strong)" strokeWidth={2} strokeLinecap="round" />
            ) : (
              <text x={layout.plotLeft} y={row.dotY + 4} fill="var(--faint)" className="text-2xs">No ranked teams</text>
            )}

            {row.dots.map((dot) => {
              const difference = dot.rating - row.score
              const contribution = dot.counts ? `Counts toward ${row.region} score` : `Outside ${row.region}'s top three`
              return (
                <HoverCard key={dot.team}>
                  <HoverCardTrigger delay={250} render={(
                    <g
                      role="img"
                      tabIndex={0}
                      aria-label={`${dot.team}, Power ${formatRating(dot.rating)}, number ${dot.regionalRank} in ${row.region}. ${contribution}.`}
                      className="group cursor-help outline-none"
                    >
                      <circle cx={dot.x} cy={row.dotY} r={9} fill="transparent" />
                      <circle
                        cx={dot.x}
                        cy={row.dotY}
                        r={dot.counts ? 5 : 3.5}
                        fill={dot.counts ? 'var(--series-1)' : 'var(--muted)'}
                        stroke="var(--surface)"
                        strokeWidth={1.5}
                      />
                      <circle cx={dot.x} cy={row.dotY} r={8} fill="none" stroke="var(--focus)" strokeWidth={1.5} className="opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
                    </g>
                  )} />
                  <HoverCardContent side="top">
                    <div className="flex items-center gap-3">
                      <TeamMark team={dot.team} code={dot.code} />
                      <div className="min-w-0">
                        <p className="font-semibold text-[var(--text-strong)]">{dot.team}</p>
                        <p className="text-xs text-muted-foreground">{dot.rank !== undefined ? `#${dot.rank} globally · ` : ''}{row.region}</p>
                      </div>
                    </div>
                    <div className="my-3 flex items-baseline justify-between gap-3 border-y border-border py-3">
                      <span className="text-muted-foreground">Power</span>
                      <strong className="font-mono text-lg tabular-nums">{formatRating(dot.rating)}</strong>
                    </div>
                    <dl className="grid grid-cols-2 gap-3 text-xs">
                      <div><dt className="text-muted-foreground">Rank in {row.region}</dt><dd className="mt-1 font-mono font-semibold tabular-nums">{dot.regionalRank} of {row.dots.length}</dd></div>
                      <div><dt className="text-muted-foreground">{row.region} region score</dt><dd className="mt-1 font-mono font-semibold tabular-nums">{formatRating(row.score)}</dd></div>
                    </dl>
                    <p className="mt-2 text-xs text-muted-foreground">{difference === 0 ? 'Level with the region score.' : `${formatRating(Math.abs(difference))} Power ${difference > 0 ? 'above' : 'below'} the region score.`}</p>
                    <div className="mt-3 border-t border-border pt-3 text-xs">
                      <p className={dot.counts ? 'font-semibold text-[var(--series-1)]' : 'font-semibold text-foreground'}>{contribution}</p>
                      <p className="mt-1 text-muted-foreground">{dot.counts ? `The region score averages the Power of its top ${Math.min(SCORED_TEAM_COUNT, row.dots.length)} ranked ${row.dots.length === 1 ? 'team' : 'teams'}.` : 'This dot shows regional depth. Only the three strongest ranked teams enter the region score.'}</p>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              )
            })}

            {row.dots.length > 0 ? (
              <line x1={row.scoreX} x2={row.scoreX} y1={row.dotY - 9} y2={row.dotY + 9} stroke="var(--text-strong)" strokeWidth={2}>
                <title>{`${row.region} region score ${formatRating(row.score)} · average of the top three teams`}</title>
              </line>
            ) : null}

            {row.lead ? (
              <text x={row.lead.x} y={row.lead.y} textAnchor="middle" fill="var(--muted)" className="font-mono text-2xs font-bold">
                {row.lead.code}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
    </div>
  )
}

function useElementWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState<number>()

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return width
}

type RegionDepthDot = {
  team: string
  code?: string
  rank?: number
  regionalRank: number
  rating: number
  x: number
  counts: boolean
}

type RegionDepthRow = {
  region: string
  rank: number
  score: number
  detail: string
  labelY: number
  detailY: number
  dotY: number
  scoreX: number
  span?: { x1: number; x2: number }
  dots: RegionDepthDot[]
  lead?: { code: string; x: number; y: number }
}

function regionDepthLayout(regions: RegionDepthInput[], availableWidth: number) {
  const width = Math.max(280, availableWidth)
  const stacked = width < STACKED_BELOW
  const plotLeft = stacked ? 18 : 150
  const plotRight = width - (stacked ? 18 : 24)
  const rowHeight = stacked ? 54 : 38
  const top = 4

  const ratings = regions.flatMap((region) => region.topTeams.map((team) => team.rating)).filter(Number.isFinite)
  const { min, max, ticks: tickValues } = axisDomain(ratings, plotRight - plotLeft)
  const x = (value: number) => plotLeft + ((value - min) / (max - min)) * (plotRight - plotLeft)

  const rows = regions.map((region, index): RegionDepthRow => {
    const rowTop = top + index * rowHeight
    const dotY = stacked ? rowTop + 38 : rowTop + rowHeight / 2
    const score = displayRegionPowerScore(region)
    const teams = region.topTeams.filter((team) => Number.isFinite(team.rating))
    const dots = teams.map((team, teamIndex) => ({
      team: team.team,
      code: team.code,
      rank: team.rank,
      regionalRank: teamIndex + 1,
      rating: team.rating,
      x: x(team.rating),
      counts: teamIndex < SCORED_TEAM_COUNT,
    }))
    // Draw the scoring teams last so other dots never cover them.
    dots.sort((left, right) => Number(left.counts) - Number(right.counts))
    const dotXs = dots.map((dot) => dot.x)
    const leadTeam = teams[0]

    return {
      region: region.region,
      rank: region.rank,
      score,
      detail: `${formatRating(score)} · ${Math.round(region.internationalWins)}–${Math.round(region.internationalLosses)} intl`,
      labelY: stacked ? rowTop + 13 : dotY - 2,
      detailY: dotY + 12,
      dotY,
      scoreX: x(score),
      span: dotXs.length > 0 ? { x1: Math.min(...dotXs), x2: Math.max(...dotXs) } : undefined,
      dots,
      lead: leadTeam ? leadLabel(leadTeam.code ?? leadTeam.team.slice(0, 3).toUpperCase(), x(leadTeam.rating), dotY, width) : undefined,
    }
  })

  const plotBottom = top + regions.length * rowHeight
  const gridBands = stacked
    ? rows.map((row) => ({ y1: row.dotY - 14, y2: row.dotY + 14 }))
    : [{ y1: top, y2: plotBottom }]
  const ticks = tickValues.map((value) => ({ value, x: x(value) }))

  const strongest = rows[0]
  const summary = strongest
    ? `${rows.length} regions. ${strongest.region} ranks first with a region score of ${formatRating(strongest.score)}. The region score is the average Power of its three strongest ranked teams. The regional standings list below has the same data.`
    : 'No regions in this scope.'

  return {
    width,
    height: plotBottom + 24,
    stacked,
    plotLeft,
    axisLabelY: plotBottom + 16,
    gridBands,
    ticks,
    rows,
    summary,
  }
}

/**
 * Pads the rating extent slightly so edge dots stay inside the plot, then picks
 * the smallest round tick step that fits the width.
 */
function axisDomain(ratings: number[], plotWidth: number) {
  const low = ratings.length > 0 ? Math.min(...ratings) : 1500
  const high = ratings.length > 0 ? Math.max(...ratings) : 2000
  const padding = Math.max(high - low, 100) * DOMAIN_PADDING
  const min = low - padding
  const max = high + padding
  const maxTicks = Math.min(MAX_TICKS, Math.max(2, Math.floor(plotWidth / MIN_TICK_SPACING)))
  const ticksFor = (step: number) => {
    const values: number[] = []
    for (let value = Math.ceil(min / step) * step; value <= max; value += step) values.push(value)
    return values
  }
  const ticks = TICK_STEPS.map(ticksFor).find((values) => values.length <= maxTicks) ?? ticksFor(LARGEST_TICK_STEP)
  return { min, max, ticks }
}

/** Centres the code over the dot and keeps an estimated 10px mono text width inside the chart. */
function leadLabel(code: string, dotX: number, dotY: number, width: number) {
  const halfWidth = code.length * 3.3 + 2
  return { code, x: clamp(dotX, halfWidth, width - halfWidth), y: dotY - 11 }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
