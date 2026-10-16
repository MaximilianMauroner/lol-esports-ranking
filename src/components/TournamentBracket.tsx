import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { TeamMark } from './TeamMark'
import { cn } from '../lib/utils'
import { hasUnresolvedResult, type TournamentSeries } from '../lib/tournamentFeed'
import {
  seriesWinner, teamKey, tournamentSections,
  type BracketMatch, type EliminationSection, type GroupSection, type Standing, type SwissSection, type TournamentSection,
} from '../lib/tournamentBracket'

/** Bracket geometry in rem, so cards and connectors scale with the root font size together. */
const CARD_W = 13.25
/** Meta row (1.25) + two team rows (1.5 each) + bottom padding (0.25). */
const CARD_H = 4.5
const COL_GAP = 2.75
const ROW_GAP = 0.75
const HEADER_H = 2
const LANE_LABEL_H = 1.875
const COLUMN_W = CARD_W + COL_GAP
const rem = (value: number) => `${value}rem`

type Trace = { active: string | null; pinned: string | null; hover: (team: string | null) => void; toggle: (team: string) => void }

/** Brackets, Swiss pools and group tables inferred from the event's schedule. Key it by event so a trace does not carry over. */
export function TournamentBracket({ series, timezone }: { series: TournamentSeries[]; timezone: string }) {
  const sections = useMemo(() => tournamentSections(series), [series])
  const [pinned, setPinned] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  useEffect(() => {
    if (!pinned) return
    // Also drop the focus trace, or a still-focused team keeps the bracket dimmed.
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPinned(null); setHovered(null) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pinned])
  const trace: Trace = {
    active: hovered ?? pinned, pinned,
    hover: setHovered,
    toggle: (team) => setPinned((current) => current === team ? null : team),
  }
  const names = useMemo(() => new Map(series.flatMap((entry) => entry.teams.map((team) => [teamKey(team), team.name] as const))), [series])

  return <div className="grid min-w-0 gap-6">
    <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-live="polite">
      {pinned
        ? <><span>Tracing <strong className="text-[var(--text-strong)]">{displayName(names.get(pinned) ?? pinned)}</strong></span>
          <Button variant="outline" size="xs" onClick={() => setPinned(null)}>Clear</Button></>
        : <span>Bracket inferred from schedule results.</span>}
    </div>
    {sections.map((section, index) => <section key={index} className="grid min-w-0 gap-2.5" aria-label={sectionTitle(section, sections)}>
      {sections.length > 1 ? <h3 className="text-base font-semibold text-[var(--text-strong)]">{sectionTitle(section, sections)}</h3> : null}
      {section.kind === 'elimination' ? <EliminationView section={section} trace={trace} timezone={timezone} />
        : section.kind === 'swiss' ? <SwissView section={section} trace={trace} timezone={timezone} />
          : <GroupsView section={section} trace={trace} names={names} />}
    </section>)}
  </div>
}

function sectionTitle(section: TournamentSection, all: TournamentSection[]) {
  if (section.kind === 'swiss') return 'Swiss stage'
  if (section.kind === 'groups') return 'Group stage'
  return section.hasLower ? 'Double-elimination bracket' : all.length > 1 ? 'Knockout bracket' : 'Bracket'
}

type Placed = { match: BracketMatch; x: number; y: number }

/** Each series sits level with the series that feed it, so connectors stay short and straight. */
function layoutElimination(section: EliminationSection) {
  const placed = new Map<string, Placed>()
  const place = (side: 'upper' | 'lower', top: number) => {
    let bottom = top
    section.columns.forEach((_, column) => {
      let cursor = top
      for (const match of section.matches.filter((entry) => entry.side === side && entry.column === column)) {
        const centers = match.feeders.map((id) => placed.get(id)).filter((entry): entry is Placed => Boolean(entry)).map((entry) => entry.y + CARD_H / 2)
        const wanted = centers.length ? centers.reduce((sum, value) => sum + value, 0) / centers.length - CARD_H / 2 : cursor
        const y = Math.max(cursor, wanted)
        placed.set(match.series.id, { match, x: column * COLUMN_W, y })
        cursor = y + CARD_H + ROW_GAP
        bottom = Math.max(bottom, y + CARD_H)
      }
    })
    return bottom
  }
  const upperBottom = place('upper', HEADER_H)
  const lowerTop = upperBottom + LANE_LABEL_H + ROW_GAP
  const lowerBottom = section.hasLower ? place('lower', lowerTop) : upperBottom
  for (const match of section.matches.filter((entry) => entry.side === 'final')) {
    const centers = match.feeders.map((id) => placed.get(id)).filter((entry): entry is Placed => Boolean(entry)).map((entry) => entry.y + CARD_H / 2)
    const y = centers.length ? centers.reduce((sum, value) => sum + value, 0) / centers.length - CARD_H / 2 : HEADER_H
    placed.set(match.series.id, { match, x: match.column * COLUMN_W, y })
  }
  // Third place sits under everything else in its column.
  const third = section.matches.filter((entry) => entry.side === 'third')
  const thirdTop = Math.max(lowerBottom, ...[...placed.values()].map((entry) => entry.y + CARD_H)) + LANE_LABEL_H + ROW_GAP
  third.forEach((match, index) => placed.set(match.series.id, { match, x: match.column * COLUMN_W, y: thirdTop + index * (CARD_H + ROW_GAP) }))
  // Only a real final crowns a winner; a lone series in a partial bracket may be a quarterfinal.
  const lastColumn = section.matches.filter((entry) => entry.column === section.columns.length - 1 && entry.side !== 'third')
  const isFinal = section.hasLower ? lastColumn[0]?.side === 'final' : /\bfinals?\b/i.test(section.columns.at(-1) ?? '')
  const decider = lastColumn.length === 1 && isFinal ? placed.get(lastColumn[0]!.series.id) ?? null : null
  const winner = decider ? seriesWinner(decider.match.series) : null
  return {
    placed: [...placed.values()],
    lowerTop: section.hasLower ? lowerTop : null,
    thirdLabel: third[0] ? { x: third[0].column * COLUMN_W, top: thirdTop } : null,
    champion: decider && winner !== null ? { from: decider, team: decider.match.series.teams[winner]! } : null,
    width: (section.columns.length + (decider && winner !== null ? 1 : 0)) * COLUMN_W - COL_GAP,
    height: Math.max(lowerBottom, ...[...placed.values()].map((entry) => entry.y + CARD_H)) + 0.25,
  }
}

function EliminationView({ section, trace, timezone }: { section: EliminationSection; trace: Trace; timezone: string }) {
  const layout = useMemo(() => layoutElimination(section), [section])
  const byId = new Map(layout.placed.map((entry) => [entry.match.series.id, entry]))
  const focusColumn = currentColumn(section.columns.map((_, column) => section.matches.filter((match) => match.column === column).map((match) => match.series)))
  return <BracketScroller focusX={focusColumn * COLUMN_W}>
    <div className="relative" style={{ width: rem(layout.width), height: rem(layout.height) }}>
      {section.columns.map((title, column) => <ColumnHeader key={title} x={column * COLUMN_W} title={title}
        series={section.matches.filter((match) => match.column === column).map((match) => match.series)} timezone={timezone} />)}
      {layout.champion ? <ColumnHeader x={section.columns.length * COLUMN_W} title="Winner" series={[]} timezone={timezone} /> : null}
      {layout.lowerTop !== null ? <p className="absolute left-0 text-xs font-semibold text-muted-foreground" style={{ top: rem(layout.lowerTop - LANE_LABEL_H + 0.375) }}>Lower bracket</p> : null}
      {layout.thirdLabel ? <p className="absolute text-xs font-semibold text-muted-foreground" style={{ left: rem(layout.thirdLabel.x), top: rem(layout.thirdLabel.top - LANE_LABEL_H + 0.375) }}>Third place</p> : null}
      <svg className="pointer-events-none absolute inset-0 overflow-visible" style={{ width: rem(layout.width), height: rem(layout.height) }}
        viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
        {layout.placed.flatMap((target) => target.match.feeders.map((id) => {
          const from = byId.get(id)
          if (!from) return null
          const lit = trace.active !== null && winnerKey(from.match.series) === trace.active && target.match.series.teams.some((team) => teamKey(team) === trace.active)
          return <Connector key={`${id}>${target.match.series.id}`} from={from} toX={target.x} toY={target.y + CARD_H / 2} lit={lit} />
        }))}
        {layout.champion ? <Connector from={layout.champion.from} toX={section.columns.length * COLUMN_W} toY={layout.champion.from.y + CARD_H / 2}
          lit={trace.active !== null && teamKey(layout.champion.team) === trace.active} /> : null}
      </svg>
      {layout.placed.map(({ match, x, y }) => <div key={match.series.id} className="absolute" style={{ left: rem(x), top: rem(y), width: rem(CARD_W) }}>
        <SeriesCard series={match.series} trace={trace} timezone={timezone} />
      </div>)}
      {layout.champion ? <ChampionCard team={layout.champion.team} trace={trace}
        x={section.columns.length * COLUMN_W} y={layout.champion.from.y + CARD_H / 2} /> : null}
    </div>
  </BracketScroller>
}

function Connector({ from, toX, toY, lit }: { from: Placed; toX: number; toY: number; lit: boolean }) {
  const x1 = from.x + CARD_W
  const y1 = from.y + CARD_H / 2
  const xm = toX - COL_GAP / 2
  return <path d={`M ${x1} ${y1} H ${xm} V ${toY} H ${toX}`} fill="none" strokeWidth={lit ? 2 : 1} vectorEffect="non-scaling-stroke"
    className={cn('motion-safe:transition-[stroke]', lit ? 'stroke-[var(--accent)]' : 'stroke-[var(--line-strong)]')} />
}

function ChampionCard({ team, trace, x, y }: { team: TournamentSeries['teams'][number]; trace: Trace; x: number; y: number }) {
  const key = teamKey(team)
  const dimmed = trace.active !== null && key !== trace.active
  return <div className={cn('absolute flex items-center gap-2.5 rounded-lg border border-[color-mix(in_oklch,var(--rank-gold),var(--line)_50%)] bg-[color-mix(in_oklch,var(--rank-gold)_9%,var(--surface))] px-3 py-2.5 motion-safe:transition-opacity', dimmed && 'opacity-40')}
    style={{ left: rem(x), top: rem(y - 1.5), width: rem(CARD_W) }}>
    {team.name ? <TeamMark team={team.name} className="size-7" /> : null}
    <div className="grid min-w-0">
      <span className="text-2xs font-semibold text-[var(--rank-gold)]">Event winner</span>
      <span className="truncate text-sm font-semibold text-[var(--text-strong)]" title={team.name ?? undefined}>{displayName(team.name)}</span>
    </div>
  </div>
}

function ColumnHeader({ x, title, series, timezone }: { x: number; title: string; series: TournamentSeries[]; timezone: string }) {
  return <div className="absolute top-0 flex items-baseline justify-between gap-2 border-b border-border pb-1.5" style={{ left: rem(x), width: rem(CARD_W) }}>
    <span className="truncate text-xs font-semibold text-[var(--text-strong)]">{title}</span>
    <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">{dateRange(series, timezone)}</span>
  </div>
}

/** Scrolls sideways inside its own frame. Opens with the current round and the one after it in view, and as much history as fits. */
function BracketScroller({ focusX, children }: { focusX: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || element.scrollWidth <= element.clientWidth) return
    const px = parseFloat(getComputedStyle(document.documentElement).fontSize)
    element.scrollLeft = Math.max(0, Math.min(focusX * px, (focusX + 2 * COLUMN_W) * px - element.clientWidth))
  }, [focusX])
  return <div ref={ref} tabIndex={0} role="region" aria-label="Bracket, scrolls sideways"
    className="min-w-0 overflow-x-auto overscroll-x-contain rounded-lg border border-border bg-[color-mix(in_oklch,var(--surface)_45%,var(--bg))] p-4 outline-none focus-visible:ring-1 focus-visible:ring-ring">
    {children}
  </div>
}

function SeriesCard({ series, trace, timezone, compact = false }: { series: TournamentSeries; trace: Trace; timezone: string; compact?: boolean }) {
  const winner = seriesWinner(series)
  const live = series.status === 'live'
  const traced = trace.active !== null && series.teams.some((team) => teamKey(team) === trace.active)
  const dimmed = trace.active !== null && !traced
  const teams = series.teams.length ? series.teams : [undefined, undefined]
  const unresolved = hasUnresolvedResult(series)
  const status = <span className={cn('flex min-w-0 items-center gap-1.5 truncate', unresolved && 'text-[var(--warn)]')}>{live ? <Badge variant="live" className="px-1.5 py-0">Live</Badge> : null}{statusText(series, timezone)}</span>
  // Compact Swiss cards skip dates to stay dense, but still say when a series is live, postponed, cancelled or missing its result.
  const flagged = live || unresolved || series.status === 'postponed' || series.status === 'cancelled'
  return <article aria-label={seriesLabel(series)}
    className={cn('grid rounded-lg border bg-card shadow-[var(--shadow-1)] motion-safe:transition-[opacity,border-color]',
      live ? 'border-[color-mix(in_oklch,var(--live)_55%,var(--line))]' : 'border-border',
      traced && 'border-[var(--accent-line)]', dimmed && 'opacity-40', compact ? 'py-1' : 'pb-1')}
    style={compact ? undefined : { height: rem(CARD_H) }}>
    {!compact ? <div className="flex h-5 items-center justify-between gap-2 px-2.5 pt-0.5 text-2xs text-muted-foreground tabular-nums">
      {status}
      {series.bestOf ? <span className="shrink-0">Bo{series.bestOf}</span> : null}
    </div> : flagged ? <div className="flex h-5 items-center px-2.5 text-2xs text-muted-foreground">{status}</div> : null}
    {teams.slice(0, 2).map((team, index) => <TeamLine key={index} team={team} won={winner === null ? null : winner === index} trace={trace} />)}
  </article>
}

function TeamLine({ team, won, trace }: { team: TournamentSeries['teams'][number] | undefined; won: boolean | null; trace: Trace }) {
  const key = teamKey(team)
  const score = team?.gameWins
  const body = <>
    {team?.name ? <TeamMark team={team.name} className="size-5 rounded-[3px] text-2xs" imageClassName="p-0.5" fallback="initial" />
      : <span className="size-5 shrink-0 rounded-[3px] border border-dashed border-border" aria-hidden="true" />}
    <span className={cn('min-w-0 flex-1 truncate text-left', !team?.name && 'text-[var(--faint)]', won === true && 'font-semibold text-[var(--text-strong)]', won === false && 'text-muted-foreground')}>
      {displayName(team?.name ?? null)}
    </span>
    <span className={cn('w-4 shrink-0 text-right font-mono text-xs tabular-nums', won === true ? 'font-bold text-[var(--win)]' : 'text-muted-foreground')}>{score ?? ''}</span>
  </>
  const row = 'flex h-6 min-w-0 items-center gap-2 px-2.5 text-sm'
  if (!key) return <div className={row}>{body}</div>
  return <button type="button" data-slot="bracket-team" className={cn(row, 'w-full rounded-sm outline-none hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:ring-1 focus-visible:ring-ring',
    trace.pinned === key && 'bg-[var(--selected-bg)]')}
    aria-pressed={trace.pinned === key} title={`Trace ${team?.name ?? key}`}
    onMouseEnter={() => trace.hover(key)} onMouseLeave={() => trace.hover(null)}
    onFocus={() => trace.hover(key)} onBlur={() => trace.hover(null)}
    onClick={() => trace.toggle(key)}>{body}</button>
}

function SwissView({ section, trace, timezone }: { section: SwissSection; trace: Trace; timezone: string }) {
  const advanced = section.standings.filter((standing) => standing.status === 'advanced')
  const eliminated = section.standings.filter((standing) => standing.status === 'eliminated')
  const focusColumn = currentColumn(section.rounds.map((round) => round.series))
  return <BracketScroller focusX={focusColumn * (CARD_W + 1)}>
    <div className="flex items-start gap-4">
      {section.rounds.map((round, index) => <div key={round.title} className="grid shrink-0 content-start gap-2.5" style={{ width: rem(CARD_W) }}>
          <div className="flex items-baseline justify-between gap-2 border-b border-border pb-1.5">
            <span className="truncate text-xs font-semibold text-[var(--text-strong)]">{round.title}</span>
            <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">{dateRange(round.series, timezone)}</span>
          </div>
          {round.pools.some((pool) => pool.pending) ? <p className="px-1 text-2xs text-muted-foreground">{index === 0 ? 'Waiting for the opening draw' : `Drawn after ${section.rounds[index - 1]!.title}`}</p> : null}
          {round.pools.map((pool) => <div key={pool.label} className="grid gap-1.5 rounded-lg border border-border bg-[color-mix(in_oklch,var(--surface-2)_40%,transparent)] p-1.5">
            <p className="flex items-baseline justify-between px-1 text-xs"><span className="font-mono font-semibold tabular-nums text-[var(--text-strong)]">{pool.label}</span>
              <span className="text-2xs text-muted-foreground">{poolNote(pool.label, section.winsToAdvance)}</span></p>
            {pool.series.map((entry) => <SeriesCard key={entry.id} series={entry} trace={trace} timezone={timezone} compact />)}
            {Array.from({ length: pool.pending }, (_, slot) => <div key={slot} className="grid h-7 place-items-center rounded-md border border-dashed border-border text-2xs text-[var(--faint)]">TBD vs TBD</div>)}
          </div>)}
          {round.unpaired.length ? <div className="grid gap-1.5">
            <p className="px-1 text-2xs text-muted-foreground">Pairings not published</p>
            {round.unpaired.map((entry) => <SeriesCard key={entry.id} series={entry} trace={trace} timezone={timezone} />)}
          </div> : null}
        </div>)}
      {advanced.length || eliminated.length ? <div className="grid shrink-0 content-start gap-2.5" style={{ width: rem(CARD_W) }}>
        <div className="border-b border-border pb-1.5 text-xs font-semibold text-[var(--text-strong)]">Outcome</div>
        <StandingList title="Advanced" standings={advanced} trace={trace} />
        <StandingList title="Eliminated" standings={eliminated} trace={trace} />
      </div> : null}
    </div>
    {!section.standings.length ? <p className="mt-3 text-xs text-muted-foreground">Awaiting the opening draw.</p> : null}
  </BracketScroller>
}

function poolNote(label: string, winsToAdvance: number | null) {
  if (winsToAdvance === null) return ''
  const [wins, losses] = label.split('–').map(Number)
  if (wins === winsToAdvance - 1 && losses === winsToAdvance - 1) return 'Decider'
  if (wins === winsToAdvance - 1) return 'Win to advance'
  if (losses === winsToAdvance - 1) return 'Lose and out'
  return ''
}

function StandingList({ title, standings, trace }: { title: string; standings: Standing[]; trace: Trace }) {
  if (!standings.length) return null
  return <div className="grid gap-0.5 rounded-lg border border-border bg-card py-1">
    <p className="px-2.5 pb-0.5 text-2xs font-semibold text-muted-foreground">{title}</p>
    {standings.map((standing) => <StandingRow key={standing.team} standing={standing} trace={trace} />)}
  </div>
}

function StandingRow({ standing, trace, name }: { standing: Standing; trace: Trace; name?: string | null }) {
  const label = name ?? standing.team
  const dimmed = trace.active !== null && trace.active !== standing.team
  return <button type="button" data-slot="bracket-team" aria-pressed={trace.pinned === standing.team} title={`Trace ${label}`}
    className={cn('flex h-6 w-full min-w-0 items-center gap-2 px-2.5 text-sm outline-none hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:ring-1 focus-visible:ring-ring motion-safe:transition-opacity',
      trace.pinned === standing.team && 'bg-[var(--selected-bg)]', dimmed && 'opacity-40')}
    onMouseEnter={() => trace.hover(standing.team)} onMouseLeave={() => trace.hover(null)}
    onFocus={() => trace.hover(standing.team)} onBlur={() => trace.hover(null)}
    onClick={() => trace.toggle(standing.team)}>
    <TeamMark team={label} className="size-5 rounded-[3px] text-2xs" imageClassName="p-0.5" fallback="initial" />
    <span className="min-w-0 flex-1 truncate text-left">{displayName(label)}</span>
    <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{standing.wins}–{standing.losses}</span>
  </button>
}

function GroupsView({ section, trace, names }: { section: GroupSection; trace: Trace; names: Map<string | null, string | null> }) {
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    {section.groups.map((group, index) => <div key={index} className="grid content-start gap-0.5 rounded-lg border border-border bg-card py-1.5">
      <p className="flex items-baseline justify-between px-2.5 pb-1 text-xs"><span className="font-semibold text-[var(--text-strong)]">{group.label ?? (section.groups.length > 1 ? `Group ${index + 1}` : 'Standings')}</span>
        <span className="text-2xs text-muted-foreground">{group.series.length} series</span></p>
      {group.standings.length ? group.standings.map((standing) => <StandingRow key={standing.team} standing={standing} trace={trace} name={names.get(standing.team)} />)
        : <p className="px-2.5 text-xs text-muted-foreground">Teams to be decided.</p>}
    </div>)}
  </div>
}

/** The first round still in play, or the last round once everything is decided. */
function currentColumn(columns: TournamentSeries[][]) {
  const open = columns.findIndex((entries) => entries.some((entry) => entry.status === 'live' || entry.status === 'upcoming' || entry.status === 'postponed'))
  return open === -1 ? Math.max(0, columns.length - 1) : open
}

function statusText(series: TournamentSeries, timezone: string) {
  if (series.status === 'live') return ''
  if (series.status === 'cancelled') return 'Cancelled'
  if (series.status === 'postponed') return 'Postponed'
  const unresolved = hasUnresolvedResult(series)
  if (!series.startTime) return unresolved ? 'Result missing' : 'Time not supplied'
  const options: Intl.DateTimeFormatOptions = series.status === 'completed' || unresolved
    ? { month: 'short', day: 'numeric', timeZone: timezone }
    : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone }
  const date = new Intl.DateTimeFormat('en-US', options).format(new Date(series.startTime))
  return unresolved ? `${date}, result missing` : date
}

function dateRange(series: TournamentSeries[], timezone: string) {
  const times = series.map((entry) => entry.startTime).filter((value): value is string => Boolean(value)).sort()
  if (!times.length) return ''
  const format = (value: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: timezone }).format(new Date(value))
  const [first, last] = [format(times[0]!), format(times.at(-1)!)]
  return first === last ? first : `${first} to ${last}`
}

function seriesLabel(series: TournamentSeries) {
  const [first, second] = series.teams
  const side = (team: typeof first) => `${team?.name ?? 'TBD'}${team?.gameWins != null ? ` ${team.gameWins}` : ''}`
  const state = series.status === 'completed' ? 'final' : hasUnresolvedResult(series) ? 'result missing' : series.status
  return `${series.stage ?? 'Series'}: ${side(first)}, ${side(second)}, ${state}`
}

function winnerKey(series: TournamentSeries) {
  const winner = seriesWinner(series)
  return winner === null ? null : teamKey(series.teams[winner])
}

/** Leaguepedia disambiguates reused names in brackets, as in "LYON (2024 American Team)". */
function displayName(name: string | null) {
  return name ? name.replace(/\s+\([^)]*\)$/, '') : 'TBD'
}
