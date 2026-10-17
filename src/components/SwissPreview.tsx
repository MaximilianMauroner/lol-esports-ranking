import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { Alert } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Panel, PanelFooter, PanelHeader } from './ui/panel'
import { Select } from './ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import { SwissRegionOdds } from './SwissRegionOdds'
import { TeamMark } from './TeamMark'
import { teamBrandingFor } from '../data/teamBranding'
import { canonicalTeamNameFor, teamCodeFor, teamIdentityFor } from '../data/teamIdentity'
import { cn } from '../lib/utils'
import { hashEnum, hashParam, useHashSync } from '../lib/urlState'
import { formatTournamentTime, type TournamentEvent } from '../lib/tournamentFeed'
import {
  PLAY_IN_REGIONS, SWISS_BRACKET, SWISS_ROUND_SIZES, SWISS_TEAM_SOURCES, decodeChoices, drawExists, encodeChoices, fillDraw, knockoutEntry,
  liveSwissBaseline, opponentOptions, resolveScenario, seedBaseline, swapOpponent, teamOutcome, type BracketBox, type DrawContext,
  type DrawnRound, type PreviewTeam, type ResolvedMatch, type ResolvedScenario, type SwissBaseline,
} from '../lib/swissScenario'
import { WORLDS_2026_SWISS_RULES } from '../lib/worlds2026Swiss'
import type { SwissTeamStanding } from '../lib/worldsObservedRules'

type Slot = 'a' | 'b'
const SLOTS = ['a', 'b'] as const
const STARTS = ['live', 'seeds'] as const
const UNDO_LIMIT = 50

/** How the bracket shows a team: full name, short code, seed slot, and the name its logo is filed under. */
type TeamInfo = { name: string; code: string; slot: string | null; mark: string | null }
type TeamLookup = (id: string) => TeamInfo
type BracketEdits = {
  pick: (round: number, matchIndex: number, winner: string | null) => void
  swap: (round: number, teamId: string, opponentId: string, context: DrawContext) => void
  clear: (round: number) => void
  draw: (round: number, context: DrawContext) => void
  redraw: (round: number, context: DrawContext) => void
}

/**
 * Worlds 2026 Swiss "what if" preview, shown as the whole Swiss bracket. The user picks winners and draws on top
 * of a starting point; every choice lives in component state and the page address only. Live draws and results
 * are shown as given and cannot be edited.
 */
export function SwissPreview({ event, playInEvent, checkedAt, timezone }: { event: TournamentEvent; playInEvent: TournamentEvent | undefined; checkedAt: string; timezone: string }) {
  const live = useMemo(() => liveSwissBaseline(event), [event])
  const playInTeams = useMemo(() => {
    const regions = new Map<string, Set<string>>()
    for (const entry of playInEvent?.series.flatMap((series) => series.teams) ?? []) {
      if (!entry.name) continue
      const name = canonicalTeamNameFor(entry.name)
      const region = teamIdentityFor(name)?.region
      if (!region) continue
      const names = regions.get(region) ?? new Set<string>()
      names.add(name)
      regions.set(region, names)
    }
    return new Map([...regions].filter(([, names]) => names.size === 1).map(([region, names]) => [region, [...names][0]]))
  }, [playInEvent])
  const liveReady = live.status === 'ready'
  const [address] = useState(() => readAddress(liveReady))
  const [start, setStart] = useState(address.start)
  const [playIn, setPlayIn] = useState(address.playIn)
  const [slot, setSlot] = useState(address.slot)
  const [texts, setTexts] = useState(address.texts)
  const [notice, setNotice] = useState<string | null>(null)
  /** Where keyboard focus goes once: the column of a round that was filled or cleared. */
  const [focusRound, setFocusRound] = useState<number | null>(null)
  const focusDone = useCallback(() => setFocusRound(null), [])
  /** Earlier versions of changed scenarios, newest last, for Undo. */
  const [history, setHistory] = useState<Array<{ slot: Slot; text: string }>>([])
  // Back, Forward and edited links change the address without a reload. useHashSync writes with
  // replaceState, which fires no hashchange, so the preview's own writes do not come back here.
  useEffect(() => {
    const onHashChange = () => {
      const next = readAddress(liveReady)
      setStart(next.start)
      setPlayIn(next.playIn)
      setSlot(next.slot)
      setTexts(next.texts)
      setNotice(null)
      setFocusRound(null)
      setHistory([])
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [liveReady])
  // Saved picks name teams by their index in one starting point. They are never read against another one, so
  // while live draws are missing the live scenarios stay in the address as written and no scenario is shown.
  const liveMissing = start === 'live' && live.status === 'unavailable'
  const baseline: SwissBaseline = useMemo(() => start === 'live' && live.status === 'ready' ? live.baseline
    : seedBaseline(playIn, playIn ? playInTeams.get(playIn) : undefined), [start, live, playIn, playInTeams])
  const scenarios = useMemo(() => ({
    a: resolveScenario(baseline, decodeChoices(baseline, liveMissing ? '' : texts.a)),
    b: resolveScenario(baseline, decodeChoices(baseline, liveMissing ? '' : texts.b)),
  }), [baseline, texts, liveMissing])
  const current = scenarios[slot]
  const otherSlot: Slot = slot === 'a' ? 'b' : 'a'
  const team: TeamLookup = useMemo(() => {
    const byId = new Map(baseline.teams.map((entry) => [entry.id, teamInfo(entry)]))
    return (id) => byId.get(id) ?? { name: id, code: id, slot: null, mark: null }
  }, [baseline])
  const canDraw = useMemo(() => current.next.kind === 'draw' && drawExists(current.next.context), [current])

  useHashSync('tournaments', {
    start,
    playin: start === 'seeds' ? playIn ?? undefined : undefined,
    scenario: slot === 'b' ? slot : undefined,
    a: (liveMissing ? texts.a : encodeChoices(baseline, scenarios.a.choices)) || undefined,
    b: (liveMissing ? texts.b : encodeChoices(baseline, scenarios.b.choices)) || undefined,
  })

  /**
   * Replaces one scenario and keeps its previous version for Undo. The stored text is always replaced, even when the
   * shown scenario does not change: it can hold choices that no longer fit, for example after a Play-In region change.
   */
  function replace(target: Slot, text: string) {
    const before = encodeChoices(baseline, scenarios[target].choices)
    if (before !== text) setHistory((previous) => [...previous.slice(1 - UNDO_LIMIT), { slot: target, text: before }])
    setTexts((previous) => ({ ...previous, [target]: text }))
  }
  /** Applies an edit made in one round; fill and clear move focus to that round's column. */
  function update(round: number, edit: (choices: DrawnRound[]) => DrawnRound[], moveFocus = false) {
    const next = resolveScenario(baseline, edit(fullChoices(current)))
    setFocusRound(moveFocus ? round : null)
    setNotice(next.droppedRounds === 1 ? 'The next round was cleared, because it was drawn from records that changed.'
      : next.droppedRounds ? `${next.droppedRounds} later rounds were cleared, because they were drawn from records that changed.` : null)
    replace(slot, encodeChoices(baseline, next.choices))
  }
  const edits: BracketEdits = {
    pick: (round, matchIndex, winner) => update(round, (choices) => choices.map((entry, index) => index === round - 1
      ? { pairs: entry.pairs, winners: entry.winners.map((value, slotIndex) => slotIndex === matchIndex ? winner : value) }
      : entry)),
    swap: (round, teamId, opponentId, context) => update(round, (choices) => {
      const index = round - 1
      const pairs = swapOpponent(choices[index].pairs, teamId, opponentId, context)
      if (!pairs) return choices
      const kept = new Map(choices[index].pairs.map((pair, slotIndex) => [pair.join('\n'), choices[index].winners[slotIndex]]))
      return [...choices.slice(0, index), { pairs, winners: pairs.map((pair) => kept.get(pair.join('\n')) ?? null) }, ...choices.slice(index + 1)]
    }),
    clear: (round) => update(round, (choices) => choices.slice(0, round - 1), true),
    draw: (round, context) => drawRound(round, context, true),
    redraw: (round, context) => drawRound(round, context, false),
  }
  function drawRound(round: number, context: DrawContext, moveFocus: boolean) {
    const pairs = fillDraw(context)
    if (pairs) update(round, (choices) => [...choices.slice(0, round - 1), { pairs, winners: pairs.map(() => null) }], moveFocus)
  }
  function undo() {
    const last = history.at(-1)
    if (!last) return
    setHistory((previous) => previous.slice(0, -1))
    setTexts((previous) => ({ ...previous, [last.slot]: last.text }))
    setSlot(last.slot)
    setNotice(`The last change to scenario ${last.slot.toUpperCase()} was undone.`)
  }
  function changeStart(value: string) {
    const nextStart = STARTS.find((entry) => entry === value) ?? 'live'
    setStart(nextStart)
    setTexts({ a: '', b: '' })
    setHistory([])
    setNotice('Both scenarios were reset for the new starting point.')
  }

  const liveNotice = current.replacedPicks || current.droppedRounds
    ? [current.replacedPicks ? `Live results replaced ${current.replacedPicks === 1 ? 'one of your picks' : `${current.replacedPicks} of your picks`}.` : '',
      current.droppedRounds ? `${current.droppedRounds === 1 ? 'One preview round no longer fits' : `${current.droppedRounds} preview rounds no longer fit`} and ${current.droppedRounds === 1 ? 'was' : 'were'} removed.` : ''].join(' ').trim()
    : null

  const startControl = (
    <div className="grid gap-1">
      <label htmlFor="swiss-start" className="text-sm font-semibold">Start from</label>
      <Select id="swiss-start" className="w-full" value={start} onChange={(event) => changeStart(event.target.value)}>
        <option value="live" disabled={live.status !== 'ready'}>Live draws and results</option>
        <option value="seeds">Qualified teams before the draw</option>
      </Select>
    </div>
  )
  if (liveMissing) {
    return (
      <div className="grid min-w-0 justify-items-start gap-4">
        {startControl}
        <Alert variant="warning" role="status">
          Live draws are not available: {live.detail} Your live picks stay in the page address until live draws return.
        </Alert>
      </div>
    )
  }

  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex min-w-0 flex-wrap items-end gap-x-4 gap-y-3">
        {startControl}
        {baseline.kind === 'seeds' ? (
          <div className="grid gap-1">
            <label htmlFor="swiss-playin" className="text-sm font-semibold">Play-In winner</label>
            <Select id="swiss-playin" className="w-full" value={playIn ?? ''} onChange={(event) => { setPlayIn(PLAY_IN_REGIONS.find((region) => region === event.target.value) ?? null); setNotice(null) }}>
              <option value="">Not chosen</option>
              {PLAY_IN_REGIONS.map((region) => <option key={region} value={region}>{playInTeams.has(region) ? `${playInTeams.get(region)} (${region})` : region}</option>)}
            </Select>
          </div>
        ) : null}
        <div className="grid gap-1">
          <span id="swiss-scenario-label" className="text-sm font-semibold">Scenario</span>
          <div role="group" aria-labelledby="swiss-scenario-label" className="flex gap-1.5">
            {SLOTS.map((entry) => (
              <Button key={entry} variant="tab" size="tab" aria-pressed={slot === entry} onClick={() => { setSlot(entry); setNotice(null) }}>
                {entry.toUpperCase()}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="tab" onClick={() => { replace(slot, encodeChoices(baseline, scenarios[otherSlot].choices)); setNotice(`Scenario ${slot.toUpperCase()} now matches scenario ${otherSlot.toUpperCase()}.`) }}>
            Copy {otherSlot.toUpperCase()} into {slot.toUpperCase()}
          </Button>
          <Button variant="outline" size="tab" onClick={() => { replace(slot, ''); setNotice(`Scenario ${slot.toUpperCase()} is back at the starting point.`) }}>
            Reset {slot.toUpperCase()}
          </Button>
          {/* Stays focusable, so keyboard focus is not lost after the last undo. */}
          <Button variant="outline" size="tab" disabled={!history.length} focusableWhenDisabled className="data-disabled:opacity-50" onClick={undo}>
            Undo
          </Button>
        </div>
      </div>

      <p className="text-sm leading-[1.5] text-muted-foreground">
        Dashed outlines and “Your draw” mark your picks. They stay in the page address and never change real results.{' '}
        {baseline.kind === 'live'
          ? <>Draws and results from Leaguepedia, checked {formatTournamentTime(checkedAt, timezone)}. {live.status === 'ready' && live.note ? live.note : ''}</>
          : <>
            Teams from <a className="underline" href={SWISS_TEAM_SOURCES.primer} target="_blank" rel="noreferrer">Riot’s Worlds 2026 primer</a> and
            the <a className="underline" href={SWISS_TEAM_SOURCES.cblolFinal} target="_blank" rel="noreferrer">CBLOL final</a>, checked {SWISS_TEAM_SOURCES.checkedAt}.
            {live.status === 'unavailable' ? ` Live draws are not available: ${live.detail}` : ''}
          </>}
      </p>
      <div role="status" className="empty:hidden grid gap-1 text-sm">
        {notice ? <p>{notice}</p> : null}
        {liveNotice ? <p className="text-[var(--warn)]">{liveNotice}</p> : null}
      </div>

      <SwissRegionOdds teams={baseline.teams} scenario={current} label={slot.toUpperCase()} />

      <div className="grid min-w-0 items-start gap-4 min-[1700px]:grid-cols-[minmax(0,1fr)_28rem]">
        <div className="grid min-w-0 gap-2">
          <NextStep scenario={current} canDraw={canDraw} team={team} playInOpen={baseline.kind === 'seeds' && !playIn} />
          <SwissBracket scenario={current} team={team} pools={baseline.kind === 'seeds' ? WORLDS_2026_SWISS_RULES.pools : null}
            canDraw={canDraw} focusRound={focusRound} onFocused={focusDone} edits={edits} />
        </div>
        <StandingsPanel scenarios={scenarios} slot={slot} team={team} />
      </div>
    </div>
  )
}

/** The preview's own values in the page address. */
function readAddress(liveReady: boolean) {
  return {
    start: hashEnum('start', STARTS, liveReady ? 'live' : 'seeds'),
    playIn: PLAY_IN_REGIONS.find((region) => region === hashParam('playin')) ?? null,
    slot: hashEnum('scenario', SLOTS, 'a'),
    texts: { a: hashParam('a') ?? '', b: hashParam('b') ?? '' },
  }
}

function fullChoices(resolved: ResolvedScenario): DrawnRound[] {
  return resolved.rounds.map((round, index) => resolved.choices[index]
    ?? { pairs: round.matches.map((match) => match.teamIds), winners: round.matches.map(() => null) })
}

function teamInfo(team: PreviewTeam): TeamInfo {
  if (team.seed === 'PLAYIN' && team.label === 'Play-In winner') return { name: team.label, code: 'Play-In', slot: team.region, mark: null }
  const canonical = canonicalTeamNameFor(team.label)
  const branding = teamBrandingFor(canonical)
  return {
    name: team.label,
    code: teamCodeFor(team.label),
    slot: team.seed === 'PLAYIN' ? team.region : team.seed?.replace(/(\d+)$/, ' $1') ?? null,
    mark: branding?.logo && branding.logoTreatment !== 'code' ? canonical : null,
  }
}

/** What the scenario needs next. When a round can be drawn, also its draw rules. */
function NextStep({ scenario, canDraw, team, playInOpen }: { scenario: ResolvedScenario; canDraw: boolean; team: TeamLookup; playInOpen: boolean }) {
  const next = scenario.next
  if (next.kind === 'complete') return <p className="text-sm text-muted-foreground">Swiss stage complete. The eight Advanced teams go to the quarterfinals.</p>
  if (next.kind === 'results') {
    const missing = scenario.rounds[next.round - 1].matches.filter((match) => !match.winnerId).length
    return (
      <p className="text-sm text-muted-foreground">
        Round {next.round}: pick {missing === 1 ? 'one winner' : `${missing} winners`} {next.round === SWISS_ROUND_SIZES.length ? 'to finish the Swiss stage' : `before Round ${next.round + 1} is drawn`}.
      </p>
    )
  }
  const waived = next.context.buckets.filter((bucket) => next.context.rematchBuckets.has(bucket.record))
  return (
    <div className="grid gap-1 text-sm">
      <p className="text-muted-foreground">
        Round {next.round} is not drawn yet.{' '}
        {next.round === 1
          ? 'Pool 1 meets Pool 4, Pool 2 meets Pool 3, and teams from one region cannot meet.'
          : 'Teams meet a new opponent with the same record.'}
        {' '}“Fill a valid draw” is not the official draw.
      </p>
      {playInOpen && next.round === 1 ? <p className="text-muted-foreground">The Play-In winner’s region is not chosen, so it meets only {team('LCK1').name} or {team('LPL1').name}.</p> : null}
      {waived.length ? <p className="text-[var(--warn)]">No draw for {waived.map((bucket) => bucket.record.replace('-', '–')).join(' or ')} avoids a rematch, so rematches are allowed there (rule 4.3.3.2).</p> : null}
      {!canDraw ? <p className="text-[var(--warn)]">No valid draw exists for these records.</p> : null}
    </div>
  )
}

/**
 * The whole Swiss stage as a bracket: one column per round with its record groups, then the records after Round 5.
 * Advanced groups sit at the top of a column and eliminated groups at the bottom. Narrow screens scroll it sideways.
 */
function SwissBracket({ scenario, team, pools, canDraw, focusRound, onFocused, edits }: {
  scenario: ResolvedScenario
  team: TeamLookup
  /** The four Round 1 pools, shown in Round 1 before a draw from qualified teams. */
  pools: ReadonlyArray<readonly string[]> | null
  canDraw: boolean
  focusRound: number | null
  onFocused: () => void
  edits: BracketEdits
}) {
  return (
    <div role="region" aria-label="Swiss bracket" tabIndex={0} className="relative min-w-0 overflow-x-auto rounded-md pb-2 focus-visible:outline-2 focus-visible:outline-[var(--focus)]">
      <div className="grid min-w-[66rem] grid-cols-6 grid-rows-[auto_1fr] gap-x-3 gap-y-2">
        {SWISS_BRACKET.map((boxes, index) => index < SWISS_ROUND_SIZES.length
          // A round that gets a new draw mounts again, so it starts with "Change pairings" off.
          ? <RoundColumn key={`${index}:${scenario.rounds[index] ? 'drawn' : 'open'}`} round={index + 1} boxes={boxes} scenario={scenario} team={team} pools={index === 0 ? pools : null}
            canDraw={canDraw} focus={focusRound === index + 1} onFocused={onFocused} edits={edits} />
          : (
            <div key="final" className="row-span-2 grid min-w-0 grid-rows-subgrid">
              <ColumnHeader title="After Round 5" />
              <div className="flex min-w-0 flex-col justify-between gap-3">
                {boxes.map((box) => <RecordBox key={box.record.join('-')} box={box}><TeamSlots ids={withRecord(scenario.standings, box)} size={box.size} team={team} /></RecordBox>)}
              </div>
            </div>
          ))}
      </div>
    </div>
  )
}

function RoundColumn({ round, boxes, scenario, team, pools, canDraw, focus, onFocused, edits }: {
  round: number
  boxes: BracketBox[]
  scenario: ResolvedScenario
  team: TeamLookup
  pools: ReadonlyArray<readonly string[]> | null
  canDraw: boolean
  focus: boolean
  onFocused: () => void
  edits: BracketEdits
}) {
  const titleId = useId()
  const { target: column, header } = useFocusWhen(focus, onFocused)
  const [editing, setEditing] = useState(false)
  const resolved = scenario.rounds.at(round - 1)
  const nextDraw = scenario.next.kind === 'draw' ? scenario.next : null
  const missing = resolved?.matches.filter((match) => !match.winnerId).length ?? 0
  const pairs = resolved?.matches.map((match) => match.teamIds) ?? []

  function content(box: BracketBox) {
    if (box.kind !== 'play' || !resolved) {
      return pools && box.kind === 'play' ? <PoolList pools={pools} team={team} /> : <TeamSlots ids={withRecord(scenario.standings, box)} size={box.size} team={team} />
    }
    const [wins, losses] = box.record
    return (
      <ul className="grid gap-1.5">
        {/* Keyed by the first team: a swap keeps that team first in its card, so its opponent select keeps focus. */}
        {resolved.matches.map((match, matchIndex) => match.records[0][0] !== wins || match.records[0][1] !== losses ? null : (
          <MatchCard key={match.teamIds[0]} round={round} match={match} team={team}
            swap={editing && !resolved.liveDraw ? { pairs, context: resolved.context, onSwap: (teamId, opponentId) => edits.swap(round, teamId, opponentId, resolved.context) } : null}
            onPick={(winner) => edits.pick(round, matchIndex, winner)} />
        ))}
      </ul>
    )
  }

  return (
    <div ref={column} tabIndex={-1} role="region" aria-labelledby={titleId}
      className="row-span-2 grid min-w-0 grid-rows-subgrid rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--focus)]">
      <ColumnHeader ref={header} title={`Round ${round}`} titleId={titleId}
        badge={resolved ? resolved.liveDraw ? <Badge>Live draw</Badge> : <Badge variant="preview">Your draw</Badge> : null}>
        {resolved ? resolved.liveDraw ? null : <>
          <Button variant={editing ? 'default' : 'outline'} size="sm" aria-pressed={editing} onClick={() => setEditing((value) => !value)}>Change pairings</Button>
          {scenario.rounds.length === round && !resolved.matches.some((match) => match.winnerId)
            ? <Button variant="outline" size="sm" onClick={() => { setEditing(false); edits.redraw(round, resolved.context) }}>Draw again</Button> : null}
          <Button variant="outline" size="sm" onClick={() => edits.clear(round)}>Clear draw</Button>
        </> : nextDraw?.round === round
          ? <Button size="sm" disabled={!canDraw} onClick={() => edits.draw(round, nextDraw.context)}>Fill a valid draw</Button>
          : <span className="text-2xs text-[var(--faint)]">Drawn after Round {round - 1}</span>}
        {missing ? <span className="text-2xs font-medium text-[var(--preview)]">{missing} to pick</span> : null}
      </ColumnHeader>
      <div className="flex min-w-0 flex-col gap-3">
        <div className={cn('flex min-w-0 flex-1 flex-col gap-3', boxes.length > 1 && 'justify-between')}>
          {boxes.map((box) => <RecordBox key={box.record.join('-')} box={box}>{content(box)}</RecordBox>)}
        </div>
        {/* Next to the last pick, because on narrow screens the next column is out of view. */}
        {nextDraw?.round === round + 1 ? (
          <Button size="sm" className="h-auto min-h-7 py-1 text-center whitespace-normal" disabled={!canDraw} onClick={() => edits.draw(round + 1, nextDraw.context)}>
            Fill a valid draw for Round {round + 1}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function ColumnHeader({ ref, title, titleId, badge = null, children }: { ref?: Ref<HTMLDivElement>; title: string; titleId?: string; badge?: ReactNode; children?: ReactNode }) {
  // The scroll margin keeps a header that is scrolled into view below the sticky app header.
  return (
    <div ref={ref} className="grid scroll-mt-[calc(var(--app-nav-h)+0.75rem)] content-start gap-1.5 border-b border-border pb-2">
      <div className="flex min-h-5 items-center justify-between gap-2">
        <h3 id={titleId} className="text-sm font-semibold text-[var(--text-strong)]">{title}</h3>
        {badge}
      </div>
      <div className="flex min-h-7 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  )
}

/** One record group: its record, its match format or outcome, and its matches or teams. */
function RecordBox({ box, children }: { box: BracketBox; children: ReactNode }) {
  const [wins, losses] = box.record
  const outcome = teamOutcome({ wins, losses, status: box.kind === 'play' ? 'active' : box.kind })
  return (
    <div className={cn('grid min-w-0 gap-1.5 rounded-md border p-1.5',
      box.kind === 'advanced' ? 'border-[color-mix(in_oklch,var(--win)_45%,var(--line))] bg-[color-mix(in_oklch,var(--win)_6%,var(--surface))]'
        : box.kind === 'eliminated' ? 'border-[color-mix(in_oklch,var(--loss)_45%,var(--line))] bg-[color-mix(in_oklch,var(--loss)_6%,var(--surface))]'
          : 'border-border bg-card')}>
      <p className="flex items-baseline justify-between gap-2 px-0.5">
        <span className="font-mono text-sm font-semibold text-[var(--text-strong)] tabular-nums">{wins}–{losses}</span>
        <span className={cn('text-2xs', outcome.state === 'advanced' ? 'text-[var(--win)]' : outcome.state === 'eliminated' ? 'text-[var(--loss)]' : 'text-muted-foreground')}>
          {outcome.state === 'advanced' ? 'Advanced' : outcome.state === 'eliminated' ? `Out, ${outcome.placement}` : `Bo${outcome.nextBestOf}`}
        </span>
      </p>
      {children}
    </div>
  )
}

const ROW = 'flex h-7 w-full min-w-0 items-center gap-1.5 px-1.5 text-xs font-semibold'

/** Teams known to hold a record, then quiet open places for teams that have not reached it yet. */
function TeamSlots({ ids, size, team }: { ids: readonly string[]; size: number; team: TeamLookup }) {
  const open = Math.max(0, size - ids.length)
  return (
    <ul className="grid gap-1">
      {ids.map((id) => <li key={id} title={team(id).name} className={cn(ROW, 'rounded-sm bg-[var(--surface-2)] text-foreground')}><TeamLine info={team(id)} /></li>)}
      {Array.from({ length: open }, (_, index) => (
        <li key={`open-${index}`} aria-hidden="true" className="h-7 rounded-sm border border-[color-mix(in_oklch,var(--line)_55%,transparent)]" />
      ))}
      {open ? <li className="sr-only">{open === 1 ? 'One place' : `${open} places`} not decided yet</li> : null}
    </ul>
  )
}

function PoolList({ pools, team }: { pools: ReadonlyArray<readonly string[]>; team: TeamLookup }) {
  return (
    <ul aria-label="Round 1 pools" className="grid gap-2.5">
      {pools.map((pool, index) => (
        <li key={index} className="grid gap-1">
          <p className="flex items-baseline justify-between gap-2 px-0.5 text-2xs text-muted-foreground">
            <span className="font-semibold text-foreground">Pool {index + 1}</span>
            <span>meets Pool {pools.length - index}</span>
          </p>
          <TeamSlots ids={pool} size={pool.length} team={team} />
        </li>
      ))}
    </ul>
  )
}

function MatchCard({ round, match, team, swap, onPick }: {
  round: number
  match: ResolvedMatch
  team: TeamLookup
  swap: { pairs: [string, string][]; context: DrawContext; onSwap: (teamId: string, opponentId: string) => void } | null
  onPick: (winner: string | null) => void
}) {
  const [first, second] = match.teamIds
  const locked = match.result === 'live'
  return (
    <li className="grid min-w-0 gap-1">
      {/* The gap shows the container colour as a hairline between the two teams. */}
      <div role="group" aria-label={`Round ${round}: ${team(first).name} against ${team(second).name}`}
        className="grid gap-px overflow-hidden rounded-sm border border-border bg-border">
        <TeamRow id={first} info={team(first)} match={match} locked={locked} onPick={onPick} />
        <TeamRow id={second} info={team(second)} match={match} locked={locked} onPick={onPick} />
      </div>
      {swap ? <SwapControl teamId={first} team={team} swap={swap} /> : null}
    </li>
  )
}

function TeamRow({ id, info, match, locked, onPick }: { id: string; info: TeamInfo; match: ResolvedMatch; locked: boolean; onPick: (winner: string | null) => void }) {
  const won = match.winnerId === id
  const lost = Boolean(match.winnerId) && !won
  if (locked) {
    return (
      <span title={info.name} className={cn(ROW, won
        ? 'bg-[color-mix(in_oklch,var(--win)_16%,var(--surface-2))] text-[var(--text-strong)] shadow-[inset_2px_0_0_var(--win)]'
        : 'bg-[var(--surface-2)] text-muted-foreground')}>
        <TeamLine info={info} faded={lost} />
        <span className="sr-only">{won ? ', won' : lost ? ', lost' : ''}</span>
      </span>
    )
  }
  return (
    <Button variant="ghost" aria-pressed={won} title={info.name} onClick={() => onPick(won ? null : id)}
      className={cn(ROW, 'justify-start rounded-none border-0 bg-[var(--surface-2)] text-foreground hover:bg-[var(--surface-3)] hover:text-[var(--text-strong)]',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus)]',
        won && 'bg-[color-mix(in_oklch,var(--preview)_16%,var(--surface-2))] text-[var(--text-strong)] outline-1 -outline-offset-1 outline-dashed outline-[var(--preview-line)] hover:bg-[color-mix(in_oklch,var(--preview)_22%,var(--surface-2))]',
        lost && 'text-muted-foreground')}>
      <TeamLine info={info} faded={lost} />
    </Button>
  )
}

/**
 * Logo, short code and seed slot. Screen readers then hear the full name, so a pick button's name starts with its
 * visible text. The row title also shows the full name.
 */
function TeamLine({ info, faded = false }: { info: TeamInfo; faded?: boolean }) {
  return (
    <>
      {info.mark
        ? <TeamMark team={info.mark} className={cn('size-4 border-0 bg-transparent', faded && 'opacity-40')} imageClassName="p-0" />
        : <span aria-hidden="true" className="size-4 shrink-0 rounded-sm border border-[var(--line-strong)]" />}
      <span className="min-w-0 truncate">{info.code}</span>
      {info.slot ? <span className="ml-auto shrink-0 text-2xs font-normal text-[var(--faint)]">{info.slot}</span> : null}
      {info.name !== info.code ? <span className="sr-only">, {info.name}</span> : null}
    </>
  )
}

function SwapControl({ teamId, team, swap }: { teamId: string; team: TeamLookup; swap: { pairs: [string, string][]; context: DrawContext; onSwap: (teamId: string, opponentId: string) => void } }) {
  const id = useId()
  const current = swap.pairs.find((pair) => pair.includes(teamId))!.find((other) => other !== teamId)!
  return (
    <div className="grid min-w-0 gap-0.5 text-2xs">
      <label htmlFor={id} className="text-muted-foreground">Opponent for {team(teamId).code}</label>
      <Select id={id} className="h-7 w-full text-xs" value={current} onChange={(event) => swap.onSwap(teamId, event.target.value)}>
        {opponentOptions(swap.pairs, teamId, swap.context).map((option) => (
          <option key={option.id} value={option.id} disabled={Boolean(option.reason)}>
            {team(option.id).name}{option.reason ? ` (${option.reason})` : ''}
          </option>
        ))}
      </Select>
    </div>
  )
}

function withRecord(standings: readonly SwissTeamStanding[], box: BracketBox) {
  return standings.filter((row) => row.wins === box.record[0] && row.losses === box.record[1]).map((row) => row.id)
}

/** Counts for the shown scenario, and the teams whose record differs in the other one. */
function StandingsPanel({ scenarios, slot, team }: { scenarios: Record<Slot, ResolvedScenario>; slot: Slot; team: TeamLookup }) {
  const titleId = useId()
  const other: Slot = slot === 'a' ? 'b' : 'a'
  const byId = (key: Slot) => new Map(scenarios[key].standings.map((row) => [row.id, row]))
  const rows = { a: byId('a'), b: byId('b') }
  const changed = scenarios[slot].standings.filter((row) => outcomeText(row) !== outcomeText(rows[other].get(row.id)!))
    .sort((left, right) => standingOrder(left) - standingOrder(right) || team(left.id).name.localeCompare(team(right.id).name))
  const knockout = knockoutEntry(scenarios[slot].standings)
  const count = (state: SwissTeamStanding['status']) => scenarios[slot].standings.filter((row) => row.status === state).length
  const names = (ids: string[]) => ids.map((id) => team(id).name)
  return (
    <Panel role="region" aria-labelledby={titleId} className="min-w-0 max-w-4xl min-[1700px]:max-w-none">
      <PanelHeader titleId={titleId} title="Standings" description={`Teams whose record differs in scenario ${other.toUpperCase()}.`} />
      <p className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border px-4 py-2 text-sm">
        <span>Advanced <strong className="font-mono font-semibold text-[var(--win)] tabular-nums">{count('advanced')}</strong> of 8</span>
        <span>Out <strong className="font-mono font-semibold text-[var(--loss)] tabular-nums">{count('eliminated')}</strong> of 8</span>
        <span>Playing <strong className="font-mono font-semibold text-[var(--text-strong)] tabular-nums">{count('active')}</strong></span>
      </p>
      {changed.length ? (
        <Table containerClassName="max-h-none">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Team</TableHead>
              {SLOTS.map((entry) => <TableHead key={entry} scope="col" className={cn(entry === slot && 'text-[var(--text-strong)]')}>{entry.toUpperCase()}{entry === slot ? <span className="sr-only"> (on the bracket)</span> : null}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {changed.map((row) => {
              const info = team(row.id)
              return (
                <TableRow key={row.id}>
                  <th scope="row" className="p-2 text-left align-middle text-sm font-medium text-[var(--text-strong)]">
                    {/* The name wraps, and the slot wraps under it, so the table fits a phone-width panel. */}
                    <span className="flex min-w-0 items-center gap-2">
                      {info.mark ? <TeamMark team={info.mark} className="size-5 border-0 bg-transparent" imageClassName="p-0" /> : null}
                      <span className="min-w-0">
                        {info.name}
                        {info.slot ? <> <span className="text-2xs font-normal whitespace-nowrap text-[var(--faint)]">{info.slot}</span></> : null}
                      </span>
                    </span>
                  </th>
                  {SLOTS.map((entry) => <StandingCell key={entry} row={rows[entry].get(row.id)!} active={entry === slot} />)}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      ) : null}
      <PanelFooter className="grid gap-1.5 text-xs text-muted-foreground">
        <p>{changed.length ? `Scenarios A and B differ for ${changed.length === 1 ? 'one team' : `${changed.length} teams`}.` : 'Scenarios A and B have the same records.'}</p>
        {knockout ? (
          <p>
            Quarterfinals: {names(knockout.undefeated).join(' and ')} each meet one of {names(knockout.twoLosses).join(', ')}, on opposite halves. The rest are drawn (rule 4.3.4).
          </p>
        ) : null}
      </PanelFooter>
    </Panel>
  )
}

function StandingCell({ row, active }: { row: SwissTeamStanding; active: boolean }) {
  const outcome = teamOutcome(row)
  // Wraps only at spaces, so a narrow table never splits a record or a placing at its dash.
  return (
    <TableCell className={cn('whitespace-normal', !active && 'border-l border-dashed border-[var(--preview-line)] text-muted-foreground')}>
      <span className="font-mono whitespace-nowrap tabular-nums">{outcome.wins}–{outcome.losses}</span>{' '}
      <span className={cn(outcome.state === 'advanced' && active && 'text-[var(--win)]', outcome.state === 'eliminated' && active && 'text-[var(--loss)]')}>{outcomeLabel(row)}</span>
    </TableCell>
  )
}

function outcomeLabel(row: SwissTeamStanding) {
  const outcome = teamOutcome(row)
  if (outcome.state === 'advanced') return 'Advanced'
  if (outcome.state === 'eliminated') return <>Out, <span className="whitespace-nowrap">{outcome.placement}</span></>
  return `Plays Bo${outcome.nextBestOf}`
}
function outcomeText(row: SwissTeamStanding) {
  return `${row.wins}-${row.losses}-${row.status}`
}
function standingOrder(row: SwissTeamStanding) {
  const group = row.status === 'advanced' ? 0 : row.status === 'active' ? 1 : 2
  return group * 100 + (3 - row.wins) * 10 + row.losses
}

/**
 * Focuses `target` when `when` is true, for example after its trigger was removed, and scrolls `header` into view.
 * Scrolling to the header, not to the whole column, keeps the page still while the header is in view, and on a phone
 * shows the top of a column that is taller than the screen. It also brings the full column width into the bracket.
 * `onFocused` ends the request, so a column that mounts later, for example after a scenario switch, does not take focus.
 */
function useFocusWhen(when: boolean, onFocused: () => void) {
  const target = useRef<HTMLDivElement>(null)
  const header = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!when) return
    target.current?.focus({ preventScroll: true })
    header.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    onFocused()
  }, [when, onFocused])
  return { target, header }
}
