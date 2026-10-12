import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Alert } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Panel, PanelBody, PanelFooter, PanelHeader } from './ui/panel'
import { Select } from './ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import { cn } from '../lib/utils'
import { hashEnum, hashParam, useHashSync } from '../lib/urlState'
import { formatTournamentTime, type TournamentEvent } from '../lib/tournamentFeed'
import {
  PLAY_IN_REGIONS, SWISS_ROUND_SIZES, decodeChoices, encodeChoices, fillDraw, findSwissEvent, knockoutEntry, liveSwissBaseline, opponentOptions,
  resolveScenario, seedBaseline, swapOpponent, teamOutcome, type DrawContext, type DrawnRound, type ResolvedMatch,
  type ResolvedRound, type ResolvedScenario, type SwissBaseline,
} from '../lib/swissScenario'
import { WORLDS_2026_SWISS_RULES } from '../lib/worlds2026Swiss'
import type { SwissTeamStanding } from '../lib/worldsObservedRules'

type Slot = 'a' | 'b'
const SLOTS = ['a', 'b'] as const
const STARTS = ['live', 'seeds'] as const
const UNDO_LIMIT = 50

/**
 * Worlds 2026 Swiss "what if" preview. The user picks winners and draws on top
 * of a starting point; every choice lives in component state and the page
 * address only. Live draws and results are shown as given and cannot be edited.
 */
export function SwissPreview({ events, checkedAt, timezone }: { events: readonly TournamentEvent[]; checkedAt: string; timezone: string }) {
  const live = useMemo(() => liveSwissBaseline(findSwissEvent(events)), [events])
  const liveReady = live.status === 'ready'
  const [address] = useState(() => readAddress(liveReady))
  const [start, setStart] = useState(address.start)
  const [playIn, setPlayIn] = useState(address.playIn)
  const [slot, setSlot] = useState(address.slot)
  const [texts, setTexts] = useState(address.texts)
  const [notice, setNotice] = useState<string | null>(null)
  /** Where keyboard focus goes once: the panel of a round that was filled, cleared or opened. */
  const [focusRound, setFocusRound] = useState<number | null>(null)
  const focusDone = useCallback(() => setFocusRound(null), [])
  /** The round the board shows. Null follows the first round that still needs a winner or a draw. */
  const [chosenRound, setChosenRound] = useState<number | null>(null)
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
      setChosenRound(null)
      setHistory([])
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [liveReady])
  // Saved picks name teams by their index in one starting point. They are never read against another one, so
  // while live draws are missing the live scenarios stay in the address as written and no scenario is shown.
  const liveMissing = start === 'live' && live.status === 'unavailable'
  const baseline: SwissBaseline = useMemo(() => start === 'live' && live.status === 'ready' ? live.baseline : seedBaseline(playIn), [start, live, playIn])
  const scenarios = useMemo(() => ({
    a: resolveScenario(baseline, decodeChoices(baseline, liveMissing ? '' : texts.a)),
    b: resolveScenario(baseline, decodeChoices(baseline, liveMissing ? '' : texts.b)),
  }), [baseline, texts, liveMissing])
  const current = scenarios[slot]
  const otherSlot: Slot = slot === 'a' ? 'b' : 'a'
  const labels = useMemo(() => new Map(baseline.teams.map((team) => [team.id, team.label])), [baseline])
  const label = (id: string) => labels.get(id) ?? id

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
  /** Applies an edit made in one round; the board stays on that round, and fill or clear moves focus to its new panel. */
  function update(round: number, edit: (choices: DrawnRound[]) => DrawnRound[], moveFocus = false) {
    const next = resolveScenario(baseline, edit(fullChoices(current)))
    setChosenRound(round)
    setFocusRound(moveFocus ? round : null)
    setNotice(next.droppedRounds === 1 ? 'The next round was cleared, because it was drawn from records that changed.'
      : next.droppedRounds ? `${next.droppedRounds} later rounds were cleared, because they were drawn from records that changed.` : null)
    replace(slot, encodeChoices(baseline, next.choices))
  }
  function undo() {
    const last = history.at(-1)
    if (!last) return
    setHistory((previous) => previous.slice(0, -1))
    setTexts((previous) => ({ ...previous, [last.slot]: last.text }))
    setSlot(last.slot)
    setNotice(`The last change to scenario ${last.slot.toUpperCase()} was undone.`)
  }
  function openRound(round: number) {
    setChosenRound(round)
    setFocusRound(round)
  }
  function changeStart(value: string) {
    const nextStart = STARTS.find((entry) => entry === value) ?? 'live'
    setStart(nextStart)
    setTexts({ a: '', b: '' })
    setHistory([])
    setChosenRound(null)
    setNotice('Both scenarios were reset for the new starting point.')
  }

  const liveNotice = current.replacedPicks || current.droppedRounds
    ? [current.replacedPicks ? `Live results replaced ${current.replacedPicks === 1 ? 'one of your picks' : `${current.replacedPicks} of your picks`}.` : '',
      current.droppedRounds ? `${current.droppedRounds === 1 ? 'One preview round no longer fits' : `${current.droppedRounds} preview rounds no longer fit`} and ${current.droppedRounds === 1 ? 'was' : 'were'} removed.` : ''].join(' ').trim()
    : null

  const steps = roundSteps(current)
  const activeRound = steps.find((step) => step.state === 'open' || step.state === 'draw')?.round ?? SWISS_ROUND_SIZES.length
  const shownRound = chosenRound ?? activeRound
  const shownIndex = shownRound - 1
  const shown = current.rounds.at(shownIndex)
  let board: ReactNode
  if (shown) {
    board = <RoundPanel key={`round-${shown.round}`} round={shown} label={label} focus={focusRound === shown.round} onFocused={focusDone}
      footer={roundFooter(current, shown.round)} onOpen={openRound}
      onPick={(matchIndex, winner) => update(shown.round, (choices) => choices.map((entry, roundIndex) => roundIndex === shownIndex
        ? { pairs: entry.pairs, winners: entry.winners.map((value, slotIndex) => slotIndex === matchIndex ? winner : value) }
        : entry))}
      onSwap={(teamId, opponentId) => update(shown.round, (choices) => {
        const pairs = swapOpponent(choices[shownIndex].pairs, teamId, opponentId, shown.context)
        if (!pairs) return choices
        const kept = new Map(choices[shownIndex].pairs.map((pair, slotIndex) => [pair.join('\n'), choices[shownIndex].winners[slotIndex]]))
        return [...choices.slice(0, shownIndex), { pairs, winners: pairs.map((pair) => kept.get(pair.join('\n')) ?? null) }, ...choices.slice(shownIndex + 1)]
      })}
      onClear={() => update(shown.round, (choices) => choices.slice(0, shownIndex), true)} />
  } else if (current.next.kind === 'draw' && current.next.round === shownRound) {
    const pools = shownRound === 1 && baseline.kind === 'seeds'
      ? WORLDS_2026_SWISS_RULES.pools.map((pool) => pool.map((id) => ({ id, note: id === 'PLAYIN' ? playIn ?? 'Region not chosen' : null })))
      : null
    board = <DrawPanel key={`draw-${shownRound}`} round={shownRound} context={current.next.context} pools={pools} label={label} focus={focusRound === shownRound} onFocused={focusDone}
      onFill={(pairs) => update(shownRound, (choices) => [...choices, { pairs, winners: pairs.map(() => null) }], true)} />
  } else {
    board = <UpcomingPanel key={`upcoming-${shownRound}`} round={shownRound} openRound={activeRound} openNeedsDraw={steps[activeRound - 1].state === 'draw'} onOpen={() => openRound(activeRound)} />
  }

  const startControl = (
    <div className="grid gap-1">
      <label htmlFor="swiss-start" className="text-sm font-semibold">Start from</label>
      <Select id="swiss-start" className="w-full" value={start} onChange={(event) => changeStart(event.target.value)}>
        <option value="live" disabled={live.status !== 'ready'}>Live draws and results</option>
        <option value="seeds">Seed slots before the draw</option>
      </Select>
    </div>
  )
  if (liveMissing) {
    return (
      <div className="grid min-w-0 justify-items-start gap-4">
        {startControl}
        <Alert variant="warning" role="status">
          Live draws are not available: {live.detail} Your live scenarios stay in the page address and come back when live draws return. Choosing seed slots replaces them with two new scenarios.
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
            <label htmlFor="swiss-playin" className="text-sm font-semibold">Play-In winner region</label>
            <Select id="swiss-playin" className="w-full" value={playIn ?? ''} onChange={(event) => { setPlayIn(PLAY_IN_REGIONS.find((region) => region === event.target.value) ?? null); setNotice(null) }}>
              <option value="">Not chosen</option>
              {PLAY_IN_REGIONS.map((region) => <option key={region} value={region}>{region}</option>)}
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
          <Button variant="outline" size="tab" onClick={() => { replace(slot, ''); setChosenRound(null); setNotice(`Scenario ${slot.toUpperCase()} is back at the starting point.`) }}>
            Reset {slot.toUpperCase()}
          </Button>
          {/* Stays focusable, so keyboard focus is not lost after the last undo. */}
          <Button variant="outline" size="tab" disabled={!history.length} focusableWhenDisabled className="data-disabled:opacity-50" onClick={undo}>
            Undo
          </Button>
        </div>
      </div>

      <div className="grid gap-1.5 rounded-md border border-dashed border-[var(--preview-line)] bg-[var(--preview-soft)] px-3 py-2.5 text-sm leading-[1.5]">
        <p><strong className="font-semibold text-[var(--preview)]">Preview.</strong> Draws and winners with a dashed outline are your choices. They stay on this page and in its address, and they never change the schedule or results. The preview shows no odds.</p>
        <p className="text-muted-foreground">
          {baseline.kind === 'live'
            ? <>Starts from the draws and results on Leaguepedia, checked {formatTournamentTime(checkedAt, timezone)}. {live.status === 'ready' && live.note ? live.note : ''}</>
            : <>Starts from the sixteen Swiss seed slots before the Round 1 draw. Slots stand for the qualified teams, for example LCK 1 is the first LCK seed. {live.status === 'unavailable' ? `Live draws are not available: ${live.detail}` : ''}</>}
        </p>
      </div>
      <div role="status" className="empty:hidden grid gap-1 text-sm">
        {notice ? <p>{notice}</p> : null}
        {liveNotice ? <p className="text-[var(--warn)]">{liveNotice}</p> : null}
      </div>

      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(300px,1fr)]">
        <div className="grid min-w-0 gap-3">
          <RoundStrip steps={steps} shown={shownRound} onSelect={setChosenRound} />
          {board}
        </div>
        <StandingsPanel scenarios={scenarios} slot={slot} label={label} />
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

type RoundStep = { round: number; state: 'done' | 'open' | 'draw' | 'upcoming'; status: string }

/** One entry per Swiss round for the round strip: played or picked, needs winners, can be drawn, or waits for an earlier round. */
function roundSteps(scenario: ResolvedScenario): RoundStep[] {
  return SWISS_ROUND_SIZES.map((_, index): RoundStep => {
    const round = index + 1
    const resolved = scenario.rounds.at(index)
    if (resolved) {
      const missing = resolved.matches.filter((match) => !match.winnerId).length
      if (missing) return { round, state: 'open', status: `${missing} to pick` }
      return { round, state: 'done', status: resolved.matches.every((match) => match.result === 'live') ? 'Played' : 'Picked' }
    }
    if (scenario.next.kind === 'draw' && scenario.next.round === round) return { round, state: 'draw', status: 'Draw next' }
    return { round, state: 'upcoming', status: 'Upcoming' }
  })
}

const STEP_TONE: Record<RoundStep['state'], string> = {
  done: 'text-muted-foreground',
  open: 'text-[var(--preview)]',
  draw: 'text-[var(--accent)]',
  upcoming: 'text-[var(--faint)]',
}

function RoundStrip({ steps, shown, onSelect }: { steps: RoundStep[]; shown: number; onSelect: (round: number) => void }) {
  return (
    <div role="group" aria-label="Swiss rounds" className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
      {steps.map((step) => (
        <Button key={step.round} variant="tab" aria-pressed={step.round === shown} onClick={() => onSelect(step.round)}
          className="h-auto min-w-0 flex-col items-start justify-center gap-0 px-2.5 py-1.5 text-left whitespace-normal">
          <span className="text-sm font-semibold">Round {step.round}</span>
          <span className={cn('text-2xs', STEP_TONE[step.state])}>{step.status}</span>
        </Button>
      ))}
    </div>
  )
}

/** What the last open round still needs, and what comes next. Earlier rounds explain how a changed winner affects later draws. */
function roundFooter(scenario: ResolvedScenario, round: number): { text: string; open: number | null } {
  const next = scenario.next
  if (round < scenario.rounds.length) {
    const played = scenario.rounds[round - 1].matches.every((match) => match.result === 'live')
    return { text: played
      ? `These are live results. Round ${round + 1} was drawn from them.`
      : `Round ${round + 1} was drawn from these results. If you change a winner here, later rounds stay only while their pairs still have the same records.`, open: null }
  }
  if (next.kind === 'draw') return { text: `Every match has a winner. Round ${next.round} can be drawn now.`, open: next.round }
  if (next.kind === 'complete') return { text: 'Every Swiss match has a winner. The standings show who advances.', open: null }
  const missing = scenario.rounds[round - 1].matches.filter((match) => !match.winnerId).length
  const needs = missing === 1 ? 'One match needs' : `${missing} matches need`
  return { text: round === SWISS_ROUND_SIZES.length ? `${needs} a winner to finish the Swiss stage.` : `${needs} a winner before Round ${round + 1} can be drawn.`, open: null }
}

function RoundPanel({ round, label, focus, onFocused, footer, onOpen, onPick, onSwap, onClear }: {
  round: ResolvedRound
  focus: boolean
  onFocused: () => void
  label: (id: string) => string
  footer: { text: string; open: number | null }
  onOpen: (round: number) => void
  onPick: (matchIndex: number, winner: string | null) => void
  onSwap: (teamId: string, opponentId: string) => void
  onClear: () => void
}) {
  const titleId = useId()
  const heading = useFocusWhen(focus, onFocused)
  const [editing, setEditing] = useState(false)
  const nextRound = footer.open
  const pairs = round.matches.map((match) => match.teamIds)
  const buckets = [...new Set(round.matches.map((match) => match.records[0].join('-')))]
  const bestOf = round.matches.map((match) => match.bestOf)
  const bo3 = bestOf.filter((value) => value === 3).length
  const format = bo3 === 0 ? `${bestOf.length} matches, best of one` : bo3 === bestOf.length ? `${bestOf.length} matches, best of three` : `${bo3} best of three, ${bestOf.length - bo3} best of one`
  return (
    <Panel ref={heading} tabIndex={-1} role="region" aria-labelledby={titleId} className="focus-visible:outline-2 focus-visible:outline-[var(--focus)]">
      <PanelHeader titleId={titleId} title={`Round ${round.round}`} description={round.liveDraw ? format : `${format}. Choose a winner for each match.`}>
        {/* Passed as a child, not as actions: these controls wrap on narrow screens instead of overflowing. */}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {round.liveDraw ? <Badge>Live draw</Badge> : <Badge variant="preview">Your draw</Badge>}
          {round.liveDraw ? null : <>
            <Button variant="tab" size="sm" aria-pressed={editing} onClick={() => setEditing((value) => !value)}>Change pairings</Button>
            <Button variant="ghost" size="sm" onClick={onClear}>Clear draw</Button>
          </>}
        </div>
      </PanelHeader>
      <PanelBody className="grid gap-4">
        {buckets.map((record) => {
          const [wins, losses] = record.split('-').map(Number)
          return (
            <div key={record} className="grid gap-1.5">
              <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                <span className="font-mono text-sm font-semibold text-[var(--text-strong)] tabular-nums">{wins}–{losses}</span>
                <span>{bucketNote(wins, losses)}</span>
              </p>
              <ul className={cn('grid gap-1.5', editing && !round.liveDraw ? 'grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))]')}>
                {/* Keyed by the first team: a swap keeps that team first in its card, so its opponent select keeps focus. */}
                {round.matches.map((match, matchIndex) => match.records[0].join('-') !== record ? null : (
                  <MatchCard key={match.teamIds[0]} round={round.round} match={match} label={label}
                    swap={editing && !round.liveDraw ? { pairs, context: round.context, onSwap } : null}
                    onPick={(winner) => onPick(matchIndex, winner)} />
                ))}
              </ul>
            </div>
          )
        })}
      </PanelBody>
      <PanelFooter className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-sm">
        <p className="text-muted-foreground">{footer.text}</p>
        {nextRound ? <Button size="sm" onClick={() => onOpen(nextRound)}>Open Round {nextRound}</Button> : null}
      </PanelFooter>
    </Panel>
  )
}

/** The match format for a record group and where its winners and losers go. */
function bucketNote(wins: number, losses: number) {
  const record = (w: number, l: number) => `${w}–${l}`
  if (wins === 2 && losses === 2) return 'Best of three. The winner advances and the loser is out.'
  if (wins === 2) return `Best of three. Winners advance, losers go to ${record(wins, losses + 1)}.`
  if (losses === 2) return `Best of three. Winners go to ${record(wins + 1, losses)}, losers are out.`
  return `Best of one. Winners go to ${record(wins + 1, losses)}, losers to ${record(wins, losses + 1)}.`
}

function MatchCard({ round, match, label, swap, onPick }: {
  round: number
  match: ResolvedMatch
  label: (id: string) => string
  swap: { pairs: [string, string][]; context: DrawContext; onSwap: (teamId: string, opponentId: string) => void } | null
  onPick: (winner: string | null) => void
}) {
  const [first, second] = match.teamIds
  const locked = match.result === 'live'
  const name = `Round ${round}: ${label(first)} against ${label(second)}`
  return (
    <li className="grid content-start gap-1 rounded-md border border-border bg-[var(--surface-2)] p-1.5">
      <p className="px-1 text-2xs text-muted-foreground">Bo{match.bestOf}{locked ? ', live result' : ''}</p>
      <div role="group" aria-label={name} className="grid gap-1">
        <TeamChoice id={first} label={label(first)} match={match} locked={locked} onPick={onPick} />
        <TeamChoice id={second} label={label(second)} match={match} locked={locked} onPick={onPick} />
      </div>
      {swap ? <SwapControl team={first} label={label} swap={swap} /> : null}
    </li>
  )
}

function TeamChoice({ id, label, match, locked, onPick }: { id: string; label: string; match: ResolvedMatch; locked: boolean; onPick: (winner: string | null) => void }) {
  const won = match.winnerId === id
  const lost = Boolean(match.winnerId) && !won
  const mark = locked ? (won ? 'Won' : lost ? 'Lost' : null) : won ? 'Your pick' : null
  const content = <>
    <span className="min-w-0 break-words">{label}</span>
    {mark ? <span className={cn('shrink-0 text-2xs font-semibold', locked ? (won ? 'text-[var(--win)]' : 'text-[var(--loss)]') : 'text-[var(--preview)]')}>{mark}</span> : null}
  </>
  const shape = 'flex h-auto min-h-8 w-full min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 rounded-md border px-2 py-1 text-left text-sm font-medium whitespace-normal'
  if (locked) {
    return <span className={cn(shape, won ? 'border-[color-mix(in_oklch,var(--win)_44%,var(--line))] bg-[var(--win-soft)] text-[var(--text-strong)]' : 'border-border text-muted-foreground')}>{content}</span>
  }
  return (
    <Button variant="outline" aria-pressed={won} onClick={() => onPick(won ? null : id)}
      className={cn(shape, won && 'border-dashed border-[var(--preview-line)] bg-[var(--preview-soft)] text-[var(--text-strong)] hover:bg-[var(--preview-soft)]', lost && 'text-muted-foreground')}>
      {content}
    </Button>
  )
}

function SwapControl({ team, label, swap }: { team: string; label: (id: string) => string; swap: { pairs: [string, string][]; context: DrawContext; onSwap: (teamId: string, opponentId: string) => void } }) {
  const id = useId()
  const current = swap.pairs.find((pair) => pair.includes(team))!.find((other) => other !== team)!
  return (
    <div className="grid min-w-0 gap-1 px-1 pt-1 text-xs">
      <label htmlFor={id} className="text-muted-foreground">Opponent for {label(team)}</label>
      <Select id={id} className="h-8 w-full text-xs" value={current} onChange={(event) => swap.onSwap(team, event.target.value)}>
        {opponentOptions(swap.pairs, team, swap.context).map((option) => (
          <option key={option.id} value={option.id} disabled={Boolean(option.reason)}>
            {label(option.id)}{option.reason ? ` (${option.reason})` : ''}
          </option>
        ))}
      </Select>
    </div>
  )
}

function DrawPanel({ round, context, pools, label, focus, onFocused, onFill }: {
  round: number
  context: DrawContext
  /** The four Round 1 pools, shown before a draw from seed slots. */
  pools: Array<Array<{ id: string; note: string | null }>> | null
  label: (id: string) => string
  focus: boolean
  onFocused: () => void
  onFill: (pairs: [string, string][]) => void
}) {
  const titleId = useId()
  const panel = useFocusWhen(focus, onFocused)
  const pairs = useMemo(() => fillDraw(context), [context])
  const waived = context.buckets.filter((bucket) => context.rematchBuckets.has(bucket.record))
  return (
    <Panel ref={panel} tabIndex={-1} role="region" aria-labelledby={titleId} className="focus-visible:outline-2 focus-visible:outline-[var(--focus)]">
      <PanelHeader titleId={titleId} title={`Round ${round}`} description="Not drawn yet. You can draw it now."
        actions={<Button size="tab" disabled={!pairs} onClick={() => pairs && onFill(pairs)}>Fill a valid draw</Button>} />
      <PanelBody className="grid gap-3 text-sm">
        <p className="text-muted-foreground">
          {round === 1
            ? 'Pool 1 meets Pool 4 and Pool 2 meets Pool 3. Two teams from the same region cannot meet.'
            : 'Each team meets a team with the same record that it has not played yet.'}
          {' '}The fill takes the first valid pairing in team order. It is not the official draw and not a prediction. After the fill, use “Change pairings” to pick other valid opponents.
        </p>
        {pools ? (
          <ul aria-label="Round 1 pools" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {pools.map((pool, index) => (
              <li key={index} className="grid content-start gap-1 rounded-md border border-border bg-[var(--surface-2)] p-2">
                <p className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold text-[var(--text-strong)]">Pool {index + 1}</span>
                  <span className="text-2xs text-muted-foreground">meets Pool {pools.length - index}</span>
                </p>
                <ul className="grid gap-0.5">
                  {pool.map((team) => (
                    <li key={team.id} className="flex flex-wrap items-baseline justify-between gap-x-2">
                      <span>{label(team.id)}</span>
                      {team.note ? <span className="text-2xs text-muted-foreground">{team.note}</span> : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <dl className="grid gap-1.5">
            {context.buckets.map((bucket) => (
              <div key={bucket.record} className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2">
                <dt className="font-mono font-semibold text-[var(--text-strong)] tabular-nums">{bucket.record.replace('-', '–')}</dt>
                <dd className="text-muted-foreground">{bucket.teamIds.map(label).join(', ')}</dd>
              </div>
            ))}
          </dl>
        )}
        {waived.length ? <p className="text-[var(--warn)]">No draw for {waived.map((bucket) => bucket.record.replace('-', '–')).join(' or ')} avoids a rematch. Officials may then allow one (rule 4.3.3.2), so rematches are allowed there.</p> : null}
        {!pairs ? <p className="text-[var(--warn)]">No valid draw exists for these records.</p> : null}
      </PanelBody>
    </Panel>
  )
}

/** A round that cannot be drawn yet, because an earlier round still needs winners. */
function UpcomingPanel({ round, openRound, openNeedsDraw, onOpen }: { round: number; openRound: number; openNeedsDraw: boolean; onOpen: () => void }) {
  const titleId = useId()
  return (
    <Panel role="region" aria-labelledby={titleId}>
      <PanelHeader titleId={titleId} title={`Round ${round}`} description="Upcoming." />
      <PanelBody className="grid justify-items-start gap-3 text-sm">
        <p className="text-muted-foreground">
          Round {round} is drawn from the records after Round {round - 1}.{' '}
          {openNeedsDraw ? `Round ${openRound} is not drawn yet.` : `Choose a winner for every match up to Round ${round - 1} first.`}
        </p>
        <Button size="sm" onClick={onOpen}>Open Round {openRound}</Button>
      </PanelBody>
    </Panel>
  )
}

function StandingsPanel({ scenarios, slot, label }: { scenarios: Record<Slot, ResolvedScenario>; slot: Slot; label: (id: string) => string }) {
  const titleId = useId()
  const byId = (slotKey: Slot) => new Map(scenarios[slotKey].standings.map((row) => [row.id, row]))
  const rows = { a: byId('a'), b: byId('b') }
  const ordered = [...scenarios[slot].standings].sort((left, right) => standingOrder(left) - standingOrder(right) || label(left.id).localeCompare(label(right.id)))
  const differs = (id: string) => outcomeText(rows.a.get(id)!) !== outcomeText(rows.b.get(id)!)
  const differences = ordered.filter((row) => differs(row.id)).length
  const knockout = knockoutEntry(scenarios[slot].standings)
  const count = (state: SwissTeamStanding['status']) => scenarios[slot].standings.filter((row) => row.status === state).length
  return (
    <Panel role="region" aria-labelledby={titleId} className="lg:sticky lg:top-[calc(var(--app-nav-h)+12px)]">
      <PanelHeader titleId={titleId} title="Standings" description={`Records in scenario ${slot.toUpperCase()}. Scenario ${slot === 'a' ? 'B' : 'A'} shows only where it differs.`} />
      <p className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border px-4 py-2 text-sm">
        <span>Advanced <strong className="font-mono font-semibold text-[var(--win)] tabular-nums">{count('advanced')}</strong> of 8</span>
        <span>Out <strong className="font-mono font-semibold text-[var(--loss)] tabular-nums">{count('eliminated')}</strong> of 8</span>
        <span>Playing <strong className="font-mono font-semibold text-[var(--text-strong)] tabular-nums">{count('active')}</strong></span>
      </p>
      <Table containerClassName="max-h-none">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Team</TableHead>
            {SLOTS.map((entry) => <TableHead key={entry} scope="col" className={cn(entry === slot && 'text-[var(--text-strong)]')}>{entry.toUpperCase()}{entry === slot ? <span className="sr-only"> (editing)</span> : null}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {ordered.map((row) => (
            <TableRow key={row.id}>
              <th scope="row" className="max-w-[11rem] p-2 text-left align-middle text-sm font-medium text-[var(--text-strong)]">
                <span className="block min-w-0 truncate" title={label(row.id)}>{label(row.id)}</span>
              </th>
              {SLOTS.map((entry) => <StandingCell key={entry} row={rows[entry].get(row.id)!} active={entry === slot} same={entry !== slot && !differs(row.id)} />)}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <PanelFooter className="grid gap-1.5 text-xs text-muted-foreground">
        <p>{differences ? `Scenarios A and B differ for ${differences === 1 ? 'one team' : `${differences} teams`}.` : 'Scenarios A and B have the same records.'}</p>
        {knockout ? (
          <p>
            Quarterfinal draw for scenario {slot.toUpperCase()}: {knockout.undefeated.map(label).join(' and ')} each meet one of {knockout.twoLosses.map(label).join(', ')}, on opposite halves of the bracket.
            {' '}The other four teams are then paired by draw (rule 4.3.4).
          </p>
        ) : null}
      </PanelFooter>
    </Panel>
  )
}

function StandingCell({ row, active, same }: { row: SwissTeamStanding; active: boolean; same: boolean }) {
  const outcome = teamOutcome(row)
  if (same) return <TableCell className="text-[var(--faint)]">Same</TableCell>
  return (
    <TableCell className={cn('whitespace-normal', !active && 'border-l border-dashed border-[var(--preview-line)] text-[var(--text-strong)]')}>
      <span className="font-mono tabular-nums">{outcome.wins}–{outcome.losses}</span>{' '}
      <span className={cn(outcome.state === 'advanced' && active && 'text-[var(--win)]', outcome.state === 'eliminated' && active && 'text-[var(--loss)]')}>{outcomeLabel(row)}</span>
    </TableCell>
  )
}

function outcomeLabel(row: SwissTeamStanding) {
  const outcome = teamOutcome(row)
  if (outcome.state === 'advanced') return 'Advanced'
  if (outcome.state === 'eliminated') return `Out, ${outcome.placement}`
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
 * Focuses the returned element when `when` is true, for example after its trigger was removed.
 * `onFocused` ends the request, so a panel that mounts later, for example after a scenario switch, does not take focus.
 */
function useFocusWhen(when: boolean, onFocused: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!when) return
    ref.current?.focus()
    onFocused()
  }, [when, onFocused])
  return ref
}
