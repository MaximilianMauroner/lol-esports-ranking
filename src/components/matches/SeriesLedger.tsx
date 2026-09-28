import { Fragment, type MouseEvent } from 'react'
import { ChevronDown, Info } from 'lucide-react'
import type { PublicMatchHistoryEntry, PublicMatchHistoryTeam } from '../../lib/publicArtifacts/schema'
import { formatDate, formatDecimal, formatRatio } from '../../lib/display'
import { impactReportUrl, matchEventLabel } from '../../lib/matchLedger'
import { cn } from '../../lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { TeamMark } from '../TeamMark'
import { deltaBarWidth, seriesRatingChange, seriesWinner, type SeriesRatingChange, type SeriesSide } from './seriesOutcome'

export type MatchSeries = {
  id: string
  games: PublicMatchHistoryEntry[]
  summary: PublicMatchHistoryEntry
}

type SeriesListProps = {
  series: MatchSeries[]
  expanded: ReadonlySet<string>
  onToggle: (id: string) => void
  publication: string
}

type TeamResult = 'won' | 'lost' | 'level'

const DELTA_BAR_WIDTH = 36
const MISSING_NOTE = 'The recorded Power changes do not reconcile for this series. Other results are unaffected.'

/** Series ledger for tablet and desktop widths. The Source column drops below 1100px. */
export function SeriesTable({ series, expanded, onToggle, publication }: SeriesListProps) {
  return (
    <Table className="table-fixed" containerClassName="hidden border-t border-[var(--line)] md:block">
      <TableHeader>
        <TableRow className="bg-[var(--surface-2)] text-xs hover:bg-[var(--surface-2)]">
          <TableHead className="w-40 pl-4 text-[var(--muted)] lg:w-52 xl:w-56">Date</TableHead>
          <TableHead className="text-center text-[var(--muted)]">Result</TableHead>
          <TableHead className="w-48 text-[var(--muted)] lg:w-64 xl:w-72">Rating change</TableHead>
          <TableHead className="hidden w-32 text-[var(--muted)] min-[1100px]:table-cell">Source</TableHead>
          <TableHead className="w-14"><span className="sr-only">Games</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {series.map((entry) => (
          <SeriesTableRows
            series={entry}
            expanded={expanded.has(entry.id)}
            onToggle={() => onToggle(entry.id)}
            publication={publication}
            key={entry.id}
          />
        ))}
      </TableBody>
    </Table>
  )
}

function SeriesTableRows({ series, expanded, onToggle, publication }: { series: MatchSeries; expanded: boolean; onToggle: () => void; publication: string }) {
  const match = series.summary
  const winner = seriesWinner(match)
  const change = seriesRatingChange(match)
  const expandable = series.games.length > 1
  return (
    <Fragment>
      <TableRow className={cn('border-[var(--line)] hover:bg-[var(--surface-2)]', expandable && 'cursor-pointer')} onClick={expandable ? onToggle : undefined}>
        <TableCell className="pl-4 whitespace-normal">
          <span className="block text-xs text-[var(--muted)]">{formatDate(match.datetimeUtc ?? match.date)}</span>
          <EventLine match={match} className="mt-1" />
        </TableCell>
        <TableCell>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
            <TeamName team={match.teamA} result={teamResult(winner, 'A')} align="end" mark />
            <Score a={match.seriesWinsA} b={match.seriesWinsB} />
            <TeamName team={match.teamB} result={teamResult(winner, 'B')} align="start" mark />
          </div>
          <div className="mt-1 flex items-center justify-center gap-2 text-2xs text-[var(--faint)]">
            <span>{seriesContext(series)}</span>
            {change.kind === 'applied' && change.upset ? <UpsetTag change={change} match={match} /> : null}
          </div>
        </TableCell>
        <TableCell className="whitespace-normal">
          {change.kind === 'applied' ? (
            <div className="grid gap-1">
              <div className="grid grid-cols-[3rem_auto] items-center justify-start gap-x-2 gap-y-0.5">
                <span className="truncate text-xs text-[var(--muted)]" title={match.teamA.name}>{match.teamA.code}</span>
                <RatingDelta delta={change.teamA} />
                <span className="truncate text-xs text-[var(--muted)]" title={match.teamB.name}>{match.teamB.code}</span>
                <RatingDelta delta={change.teamB} />
              </div>
              <ChanceLine change={change} match={match} />
            </div>
          ) : <RatingChangeNote change={change} match={match} publication={publication} />}
        </TableCell>
        <TableCell className="hidden min-[1100px]:table-cell">
          <Badge variant="secondary" className="max-w-full text-[var(--faint)]">{providerLabel(match.source.provider)}</Badge>
        </TableCell>
        <TableCell className="pr-3 text-right">
          {expandable ? <ExpandButton expanded={expanded} onToggle={onToggle} match={match} /> : null}
        </TableCell>
      </TableRow>
      {expanded ? series.games.map((game) => <GameTableRow game={game} key={game.id} />) : null}
    </Fragment>
  )
}

function GameTableRow({ game }: { game: PublicMatchHistoryEntry }) {
  const gameWinner: SeriesSide = game.winnerId === game.teamA.id ? 'A' : 'B'
  return (
    <TableRow className="border-dotted border-[var(--line)] bg-[color-mix(in_oklch,var(--surface-2)_62%,transparent)] hover:bg-[var(--surface-2)]">
      <TableCell className="pl-8 text-xs text-[var(--faint)]">
        Game {game.gameNumber}
        <span className="block text-2xs">{game.patch ? `Patch ${game.patch}` : 'Patch unknown'}</span>
      </TableCell>
      <TableCell>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 text-sm">
          <TeamName team={game.teamA} result={teamResult(gameWinner, 'A')} align="end" className="pr-9" />
          <span className="font-mono text-sm text-[var(--faint)] tabular-nums" title={`Series score after game ${game.gameNumber}`}>
            {game.seriesWinsA}–{game.seriesWinsB}
          </span>
          <TeamName team={game.teamB} result={teamResult(gameWinner, 'B')} align="start" className="pl-9" />
        </div>
      </TableCell>
      <TableCell className="text-xs text-[var(--faint)]">Counted in series total</TableCell>
      <TableCell className="hidden min-[1100px]:table-cell">
        <Badge variant="secondary" className="max-w-full text-[var(--faint)]">{providerLabel(game.source.provider)}</Badge>
      </TableCell>
      <TableCell />
    </TableRow>
  )
}

/** Stacked series cards for phones. One line per team keeps both names at full size. */
export function SeriesCards({ series, expanded, onToggle, publication }: SeriesListProps) {
  return (
    <div className="grid gap-px border-t border-[var(--line)] bg-[var(--line)] md:hidden">
      {series.map((entry) => (
        <SeriesCard
          series={entry}
          expanded={expanded.has(entry.id)}
          onToggle={() => onToggle(entry.id)}
          publication={publication}
          key={entry.id}
        />
      ))}
    </div>
  )
}

function SeriesCard({ series, expanded, onToggle, publication }: { series: MatchSeries; expanded: boolean; onToggle: () => void; publication: string }) {
  const match = series.summary
  const winner = seriesWinner(match)
  const change = seriesRatingChange(match)
  const expandable = series.games.length > 1
  const teams = [
    { side: 'A', team: match.teamA, wins: match.seriesWinsA, delta: change.kind === 'applied' ? change.teamA : undefined },
    { side: 'B', team: match.teamB, wins: match.seriesWinsB, delta: change.kind === 'applied' ? change.teamB : undefined },
  ] as const
  return (
    <div className="min-w-0 bg-[var(--surface)]">
      <div className="px-3.5 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="block text-xs text-[var(--muted)]">{formatDate(match.datetimeUtc ?? match.date)}</span>
            <EventLine match={match} className="mt-0.5" />
          </div>
          {expandable ? <ExpandButton expanded={expanded} onToggle={onToggle} match={match} /> : null}
        </div>
        <div className="mt-2.5 grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1.5">
          {teams.map(({ side, team, wins, delta }) => (
            <Fragment key={side}>
              <TeamName team={team} result={teamResult(winner, side)} align="start" mark />
              <b className={cn('font-mono text-md tabular-nums', winner === side ? 'text-[var(--text-strong)]' : 'font-normal text-[var(--muted)]')}>{wins}</b>
              {delta === undefined ? <span /> : <RatingDelta delta={delta} />}
            </Fragment>
          ))}
        </div>
        <div className="mt-2 grid gap-1 border-t border-dotted border-[var(--line)] pt-2">
          {change.kind === 'applied' ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <ChanceLine change={change} match={match} />
              {change.upset ? <UpsetTag change={change} match={match} /> : null}
            </div>
          ) : <RatingChangeNote change={change} match={match} publication={publication} />}
          <span className="text-2xs text-[var(--faint)]">{seriesContext(series)} · {providerLabel(match.source.provider)}</span>
        </div>
      </div>
      {expanded ? (
        <div className="border-t border-[var(--line)] bg-[color-mix(in_oklch,var(--surface-2)_62%,transparent)] px-3.5 py-1">
          {series.games.map((game) => {
            const gameWinner: SeriesSide = game.winnerId === game.teamA.id ? 'A' : 'B'
            return (
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-t border-dotted border-[var(--line)] py-2 text-sm first:border-0" key={game.id}>
                <span className="text-2xs text-[var(--faint)]">G{game.gameNumber}</span>
                <TeamName team={game.teamA} result={teamResult(gameWinner, 'A')} align="end" useCode />
                <span className="font-mono text-xs text-[var(--faint)] tabular-nums" title={`Series score after game ${game.gameNumber}`}>{game.seriesWinsA}–{game.seriesWinsB}</span>
                <TeamName team={game.teamB} result={teamResult(gameWinner, 'B')} align="start" useCode />
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function EventLine({ match, className }: { match: PublicMatchHistoryEntry; className?: string }) {
  const label = matchEventLabel(match.event)
  return (
    <span className={cn('flex min-w-0 items-start gap-1.5', className)}>
      <Badge variant="event" className="shrink-0">{match.league}</Badge>
      <span className="line-clamp-2 min-w-0 text-xs text-[var(--text)]" title={label}>{label}</span>
    </span>
  )
}

function TeamName({ team, result, align, mark = false, useCode = false, className }: {
  team: PublicMatchHistoryTeam
  result: TeamResult
  align: 'start' | 'end'
  mark?: boolean
  useCode?: boolean
  className?: string
}) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2', align === 'end' && 'flex-row-reverse text-right', className)}>
      {mark ? <TeamMark team={team.name} code={team.code} className="size-7" imageClassName="p-0.5" /> : null}
      <span
        className={cn(
          'truncate',
          result === 'won' && 'font-semibold text-[var(--text-strong)]',
          result === 'lost' && 'font-normal text-[var(--muted)]',
          result === 'level' && 'font-normal text-[var(--text)]',
        )}
        title={team.name}
      >
        {useCode ? team.code : team.name}
      </span>
    </span>
  )
}

function Score({ a, b }: { a: number; b: number }) {
  return <span className="font-mono text-base font-extrabold text-[var(--text-strong)] tabular-nums">{a}–{b}</span>
}

/** Signed rating change with a bar scaled to DELTA_BAR_CAP points. */
function RatingDelta({ delta }: { delta: number }) {
  const rounded = Math.round(delta)
  const tone = rounded > 0 ? 'var(--up)' : rounded < 0 ? 'var(--down)' : 'var(--faint)'
  const label = rounded > 0 ? `+${rounded}` : rounded < 0 ? `−${Math.abs(rounded)}` : '0'
  return (
    <span className="inline-flex items-center gap-1.5">
      <b className="w-8 text-right font-mono text-sm font-bold tabular-nums" style={{ color: tone }}>{label}</b>
      <span className="h-1.5 rounded-full" style={{ width: DELTA_BAR_WIDTH }} aria-hidden="true">
        <span className="block h-full rounded-full" style={{ width: deltaBarWidth(delta, DELTA_BAR_WIDTH), background: tone }} />
      </span>
    </span>
  )
}

function ChanceLine({ change, match }: { change: Extract<SeriesRatingChange, { kind: 'applied' }>; match: PublicMatchHistoryEntry }) {
  const team = change.chanceSide === 'A' ? match.teamA : match.teamB
  const parts = [
    change.chance !== undefined ? `${team.code} ${formatRatio(change.chance)} pre-match` : '',
    change.eventWeight !== undefined ? `${formatDecimal(change.eventWeight)}× event weight` : '',
  ].filter(Boolean)
  if (parts.length === 0) return null
  return (
    <span
      className="text-2xs text-[var(--faint)]"
      title={change.chance !== undefined ? `Model's pre-match chance for ${team.name}` : undefined}
    >
      {parts.join(' · ')}
    </span>
  )
}

function UpsetTag({ change, match }: { change: Extract<SeriesRatingChange, { kind: 'applied' }>; match: PublicMatchHistoryEntry }) {
  const team = change.chanceSide === 'A' ? match.teamA : match.teamB
  const chance = formatRatio(change.chance)
  return (
    <Badge variant="warning" className="shrink-0" title={`${team.name} won with a ${chance} pre-match chance`}>
      Upset · {chance}
    </Badge>
  )
}

function RatingChangeNote({ change, match, publication }: { change: Exclude<SeriesRatingChange, { kind: 'applied' }>; match: PublicMatchHistoryEntry; publication: string }) {
  if (change.kind === 'held') return <span className="text-xs text-[var(--faint)]">Held until the series ends</span>
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--muted)]">
      <span className="inline-flex items-center gap-1">
        No rating change recorded
        <Tooltip>
          <TooltipTrigger
            className="grid size-5 place-items-center rounded-[var(--r-1)] text-[var(--faint)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--focus)]"
            aria-label={`Why no rating change: ${MISSING_NOTE}`}
            onClick={stopRowToggle}
          >
            <Info className="size-3.5" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>{MISSING_NOTE}</TooltipContent>
        </Tooltip>
      </span>
      <a
        // Important modifiers: the unlayered global `a` color in base.css outranks utilities.
        className="text-2xs text-[var(--faint)]! underline underline-offset-2 hover:text-[var(--text)]!"
        href={impactReportUrl(match, publication)}
        onClick={stopRowToggle}
        aria-label="Report this series"
      >
        Report
      </a>
    </span>
  )
}

function ExpandButton({ expanded, onToggle, match }: { expanded: boolean; onToggle: () => void; match: PublicMatchHistoryEntry }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-7"
      aria-expanded={expanded}
      aria-label={`${expanded ? 'Hide' : 'Show'} games in ${match.teamA.name} versus ${match.teamB.name}`}
      onClick={(event) => { event.stopPropagation(); onToggle() }}
    >
      <ChevronDown className={cn('transition-transform', expanded && 'rotate-180')} />
    </Button>
  )
}

function stopRowToggle(event: MouseEvent) {
  event.stopPropagation()
}

function teamResult(winner: SeriesSide | undefined, side: SeriesSide): TeamResult {
  if (!winner) return 'level'
  return winner === side ? 'won' : 'lost'
}

function seriesContext(series: MatchSeries) {
  const match = series.summary
  const games = `${series.games.length} ${series.games.length === 1 ? 'game' : 'games'}`
  return [`Bo${match.bestOf}`, games, match.patch ? `Patch ${match.patch}` : 'Patch unknown'].join(' · ')
}

function providerLabel(provider: PublicMatchHistoryEntry['source']['provider']) {
  return provider === 'oracles-elixir' ? "Oracle's Elixir" : provider === 'leaguepedia-cargo' ? 'Leaguepedia' : 'Seed'
}
