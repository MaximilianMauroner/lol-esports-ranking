import { compareCodeUnits } from './codeUnitOrder.mjs'
import { WORLDS_2026_SWISS_RULES, applySwissWinner, swissBestOf, type SwissSeed } from './worlds2026Swiss'
import type { SwissTeamStanding } from './worldsObservedRules'
import type { TournamentEvent, TournamentSeries } from './tournamentFeed'

/**
 * Deterministic "what if" preview of the Worlds 2026 Swiss stage.
 *
 * The user picks match winners and chooses legal draws. Nothing here assigns a
 * probability: Riot's ruleset does not define the draw procedure precisely
 * enough to weight one legal draw over another (see `drawUnavailable` in
 * `worlds2026Swiss.ts`), so the preview only enforces what the rules do define.
 * A scenario is plain data owned by the browser. It never changes the source
 * schedule or results.
 */

/** Matches per round, Riot 2026 ruleset §4.1.2.1. */
export const SWISS_ROUND_SIZES = [8, 8, 8, 6, 3] as const
/** Regions whose teams start in the Play-In, §4.2.1. */
export const PLAY_IN_REGIONS = ['CBLOL', 'LCS', 'LEC', 'LCP'] as const
export type PlayInRegion = typeof PLAY_IN_REGIONS[number]

export type PreviewTeam = { id: string; label: string; seed: SwissSeed | null; region: string | null }
/** One drawn round. `winners[i]` belongs to `pairs[i]`; null means not decided. */
export type DrawnRound = { pairs: [string, string][]; winners: Array<string | null> }
export type SwissBaseline = {
  kind: 'live' | 'seeds'
  teams: PreviewTeam[]
  /** Draws and results from the source. Preview choices never replace them. */
  rounds: DrawnRound[]
}
export type LiveBaseline = { status: 'ready'; baseline: SwissBaseline; note: string | null } | { status: 'unavailable'; detail: string }

export type ResolvedMatch = {
  teamIds: [string, string]
  bestOf: 1 | 3
  /** Records of both teams before this match, as [wins, losses]. */
  records: [[number, number], [number, number]]
  winnerId: string | null
  result: 'live' | 'preview' | null
}
/** `context` describes the draw rules for this round, so a preview draw can be changed. */
export type ResolvedRound = { round: number; liveDraw: boolean; matches: ResolvedMatch[]; context: DrawContext }
export type DrawContext = {
  round: number
  teams: ReadonlyMap<string, PreviewTeam>
  standings: ReadonlyMap<string, SwissTeamStanding>
  /** Record buckets where every pairing repeats a match, so officials may waive §4.3.3.2. */
  rematchBuckets: ReadonlySet<string>
  buckets: Array<{ record: string; teamIds: string[] }>
}
export type ResolvedScenario = {
  rounds: ResolvedRound[]
  /** The choices that still apply, in storage form. Live results are not copied in. */
  choices: DrawnRound[]
  standings: SwissTeamStanding[]
  next: { kind: 'results'; round: number } | { kind: 'draw'; round: number; context: DrawContext } | { kind: 'complete' }
  /** Preview picks that a live result or a live draw replaced. */
  replacedPicks: number
  /** Preview rounds dropped because an earlier change made their draw invalid. */
  droppedRounds: number
}

export type TeamOutcome =
  | { state: 'advanced'; wins: number; losses: number }
  | { state: 'eliminated'; wins: number; losses: number; placement: string }
  | { state: 'active'; wins: number; losses: number; nextBestOf: 1 | 3 }

export function seedBaseline(playInRegion: PlayInRegion | null): SwissBaseline {
  const teams = WORLDS_2026_SWISS_RULES.pools.flat().map((seed): PreviewTeam => seed === 'PLAYIN'
    ? { id: seed, label: 'Play-In winner', seed, region: playInRegion }
    : { id: seed, label: seed.replace(/(\d+)$/, ' $1'), seed, region: seed.replace(/\d+$/, '') })
  return { kind: 'seeds', teams, rounds: [] }
}

/** The 2026 Main Event, which holds the Swiss rounds and the knockout bracket. */
export function findSwissEvent(events: readonly TournamentEvent[]) {
  return events.find((event) => event.competition === 'worlds' && event.season === '2026' && /\/Main Event$/.test(event.sourceTournamentId))
}

/**
 * Reads the published Swiss draws and results from the schedule. The baseline
 * is available only when the full Round 1 draw is published and every later
 * published draw follows the Swiss rules.
 */
export function liveSwissBaseline(event: TournamentEvent | undefined): LiveBaseline {
  if (!event) return { status: 'unavailable', detail: 'The Worlds 2026 Main Event is not in the schedule window.' }
  const byRound = new Map<number, TournamentSeries[]>()
  for (const series of event.series) {
    const round = Number(/^Round ([1-5])$/.exec(series.stage ?? '')?.[1])
    if (round) byRound.set(round, [...byRound.get(round) ?? [], series])
  }
  for (const list of byRound.values()) list.sort((a, b) => compareCodeUnits(a.startTime ?? '', b.startTime ?? '') || compareCodeUnits(a.id, b.id))
  const firstRound = byRound.get(1) ?? []
  if (firstRound.length !== SWISS_ROUND_SIZES[0] || !firstRound.every((series) => seriesPair(series))) {
    return { status: 'unavailable', detail: 'The Round 1 draw is not in the schedule yet.' }
  }
  const ids = firstRound.flatMap((series) => seriesPair(series)!)
  if (new Set(ids).size !== 16) return { status: 'unavailable', detail: 'Round 1 in the schedule does not list 16 different teams.' }
  const baseline: SwissBaseline = { kind: 'live', teams: ids.map((id) => ({ id, label: id, seed: null, region: null })), rounds: [] }
  let note: string | null = null
  for (const [index, size] of SWISS_ROUND_SIZES.entries()) {
    const list = byRound.get(index + 1) ?? []
    if (list.length > size) return { status: 'unavailable', detail: `Round ${index + 1} in the schedule has more than ${size} matches.` }
    const pairs = list.map(seriesPair)
    if (!list.length || pairs.some((pair) => !pair)) {
      if (pairs.some(Boolean)) note = `The Round ${index + 1} draw is only partly published, so the preview starts before it.`
      break
    }
    const resolved = resolveScenario(baseline, [])
    if (resolved.next.kind !== 'draw' || resolved.next.round !== index + 1) {
      note = `Round ${index + 1} is published before Round ${index} is complete, so the preview starts before it.`
      break
    }
    const problem = drawProblem(pairs as [string, string][], resolved.next.context)
    if (problem) return { status: 'unavailable', detail: `Round ${index + 1} in the schedule does not follow the Swiss draw rules: ${problem}.` }
    baseline.rounds.push({ pairs: pairs as [string, string][], winners: list.map((series) => seriesWinner(series)) })
  }
  return { status: 'ready', baseline, note }
}

function seriesPair(series: TournamentSeries): [string, string] | null {
  const names = series.teams.map((team) => (team.name ?? team.id)?.trim() ?? '')
  return series.teams.length === 2 && names.every((name) => name && !/^tbd$/i.test(name)) && names[0] !== names[1] ? [names[0], names[1]] : null
}

function seriesWinner(series: TournamentSeries): string | null {
  if (series.status !== 'completed') return null
  const pair = seriesPair(series)!
  const outcomes = series.teams.map((team) => team.outcome?.toLowerCase())
  if (outcomes[0] === 'win' && outcomes[1] !== 'win') return pair[0]
  if (outcomes[1] === 'win' && outcomes[0] !== 'win') return pair[1]
  const [first, second] = series.teams.map((team) => team.gameWins)
  if (typeof first === 'number' && typeof second === 'number' && first !== second) return first > second ? pair[0] : pair[1]
  return null
}

/**
 * Replays the baseline and the user's choices round by round. Live draws and
 * results always win. A preview draw that no longer fits the records, for
 * example after an earlier pick changed, is dropped with every later round.
 */
export function resolveScenario(baseline: SwissBaseline, choices: readonly DrawnRound[]): ResolvedScenario {
  const standings: SwissTeamStanding[] = baseline.teams.map(({ id }) => ({ id, wins: 0, losses: 0, status: 'active', opponents: [] }))
  const rounds: ResolvedRound[] = []
  const kept: DrawnRound[] = []
  let replacedPicks = 0
  let droppedRounds = 0
  for (let index = 0; index < SWISS_ROUND_SIZES.length; index++) {
    const live = baseline.rounds[index]
    const choice = choices[index]
    const context = drawContext(index + 1, baseline.teams, standings)
    if (!live && !choice) return finish(context)
    if (!live && drawProblem(choice!.pairs, context)) {
      droppedRounds = choices.length - index
      return finish(context)
    }
    const pairs = live?.pairs ?? choice!.pairs
    const matches = pairs.map((pair, slot): ResolvedMatch => {
      const byId = new Map(standings.map((row) => [row.id, row]))
      const [first, second] = pair.map((id) => byId.get(id)!)
      const liveWinner = live?.winners[slot] ?? null
      const picked = choice ? pickFor(choice, pair) : null
      return {
        teamIds: pair, bestOf: swissBestOf(first), records: [[first.wins, first.losses], [second.wins, second.losses]],
        winnerId: liveWinner ?? picked, result: liveWinner ? 'live' : picked ? 'preview' : null,
      }
    })
    for (const [slot, winner] of choice?.winners.entries() ?? []) {
      const match = winner ? matches.find((entry) => pairKey(entry.teamIds) === pairKey(choice!.pairs[slot])) : null
      if (winner && match?.winnerId !== winner) replacedPicks++
    }
    for (const match of matches) if (match.winnerId) applySwissWinner(standings, match.teamIds, match.winnerId)
    rounds.push({ round: index + 1, liveDraw: Boolean(live), matches, context })
    kept.push({ pairs, winners: matches.map((match) => match.result === 'preview' ? match.winnerId : null) })
    if (matches.some((match) => !match.winnerId)) {
      droppedRounds = Math.max(0, choices.length - index - 1)
      return { rounds, choices: trimChoices(baseline, kept), standings, next: { kind: 'results', round: index + 1 }, replacedPicks, droppedRounds }
    }
  }
  return finish(null)

  function finish(context: DrawContext | null): ResolvedScenario {
    const active = standings.some((row) => row.status === 'active')
    const next = active && context ? { kind: 'draw' as const, round: context.round, context } : { kind: 'complete' as const }
    return { rounds, choices: trimChoices(baseline, kept), standings, next, replacedPicks, droppedRounds }
  }
}

function pickFor(choice: DrawnRound, pair: [string, string]) {
  const slot = choice.pairs.findIndex((other) => pairKey(other) === pairKey(pair))
  const winner = slot < 0 ? null : choice.winners[slot]
  return winner && pair.includes(winner) ? winner : null
}

/** Removes trailing live rounds that carry no preview pick, so stored choices stay short. */
function trimChoices(baseline: SwissBaseline, choices: DrawnRound[]) {
  let end = choices.length
  while (end > 0 && end <= baseline.rounds.length && !choices[end - 1].winners.some(Boolean)) end--
  return choices.slice(0, end)
}

export function drawContext(round: number, teams: readonly PreviewTeam[], standings: readonly SwissTeamStanding[]): DrawContext {
  const buckets = new Map<string, string[]>()
  for (const row of standings) {
    if (row.status !== 'active') continue
    const record = `${row.wins}-${row.losses}`
    buckets.set(record, [...buckets.get(record) ?? [], row.id])
  }
  const context: DrawContext = {
    round,
    teams: new Map(teams.map((team) => [team.id, team])),
    standings: new Map(standings.map((row) => [row.id, { ...row, opponents: [...row.opponents] }])),
    rematchBuckets: new Set(),
    buckets: [...buckets].map(([record, teamIds]) => ({ record, teamIds }))
      .sort((a, b) => Number(b.record[0]) - Number(a.record[0]) || Number(a.record[2]) - Number(b.record[2])),
  }
  for (const bucket of context.buckets) {
    if (!findPairing(bucket.teamIds, (a, b) => !pairReason(a, b, context, false))) (context.rematchBuckets as Set<string>).add(bucket.record)
  }
  return context
}

/** Why two teams may not meet in this draw, or null when they may. */
export function pairReason(a: string, b: string, context: DrawContext, allowWaivedRematch = true): string | null {
  const [first, second] = [a, b].map((id) => context.standings.get(id))
  if (!first || !second || a === b || first.status !== 'active' || second.status !== 'active') return 'not available'
  if (first.wins !== second.wins || first.losses !== second.losses) return 'different record'
  if (context.round === 1) {
    const [home, away] = [a, b].map((id) => context.teams.get(id)!)
    if (home.seed && away.seed) {
      const pools = [home.seed, away.seed].map((seed) => WORLDS_2026_SWISS_RULES.pools.findIndex((pool) => (pool as readonly string[]).includes(seed)))
      if (pools[0] + pools[1] !== 3) return 'pool not matched'
    }
    if (home.region && home.region === away.region) return 'same region'
  }
  if (first.opponents.includes(b) && !(allowWaivedRematch && context.rematchBuckets.has(`${first.wins}-${first.losses}`))) return 'already played'
  return null
}

/** Why a full draw breaks the rules, or null when it is valid. */
export function drawProblem(pairs: readonly [string, string][], context: DrawContext): string | null {
  const active = context.buckets.flatMap((bucket) => bucket.teamIds)
  const drawn = pairs.flat()
  if (drawn.length !== active.length || new Set(drawn).size !== drawn.length || drawn.some((id) => !active.includes(id))) {
    return 'every team still playing must be drawn exactly once'
  }
  for (const [a, b] of pairs) {
    const reason = pairReason(a, b, context)
    if (reason) return `${context.teams.get(a)?.label ?? a} and ${context.teams.get(b)?.label ?? b}: ${reason}`
  }
  return null
}

/**
 * One valid draw: the first legal pairing in baseline team order. This is a
 * convenience for building scenarios, not a prediction of the official draw.
 * Where officials may waive the rematch rule, pairings without a rematch are
 * still tried first.
 */
export function fillDraw(context: DrawContext): [string, string][] | null {
  const pairs: [string, string][] = []
  for (const bucket of context.buckets) {
    const found = findPairing(bucket.teamIds, (a, b) => !pairReason(a, b, context, false))
      ?? findPairing(bucket.teamIds, (a, b) => !pairReason(a, b, context))
    if (!found) return null
    pairs.push(...found)
  }
  return pairs
}

function findPairing(teamIds: readonly string[], legal: (a: string, b: string) => boolean): [string, string][] | null {
  if (!teamIds.length) return []
  const [first, ...rest] = teamIds
  for (const [index, other] of rest.entries()) {
    if (!legal(first, other)) continue
    const remaining = findPairing(rest.filter((_, otherIndex) => otherIndex !== index), legal)
    if (remaining) return [[first, other], ...remaining]
  }
  return null
}

/**
 * Opponents `teamId` could face instead, by swapping partners with another
 * match in the same record bucket. Each option says why it is unavailable.
 */
export function opponentOptions(pairs: readonly [string, string][], teamId: string, context: DrawContext) {
  const bucket = context.buckets.find((entry) => entry.teamIds.includes(teamId))?.teamIds ?? []
  return bucket.filter((id) => id !== teamId).map((id) => ({ id, reason: swapReason(pairs, teamId, id, context) }))
}

export function swapOpponent(pairs: readonly [string, string][], teamId: string, opponentId: string, context: DrawContext): [string, string][] | null {
  if (swapReason(pairs, teamId, opponentId, context)) return null
  const current = pairs.find((pair) => pair.includes(teamId))!
  const partner = current.find((id) => id !== teamId)!
  if (partner === opponentId) return pairs.map((pair) => [...pair])
  return pairs.map((pair): [string, string] => {
    if (pair === current) return [teamId, opponentId]
    if (pair.includes(opponentId)) return [partner, pair.find((id) => id !== opponentId)!]
    return [...pair]
  })
}

function swapReason(pairs: readonly [string, string][], teamId: string, opponentId: string, context: DrawContext): string | null {
  const current = pairs.find((pair) => pair.includes(teamId))
  const other = pairs.find((pair) => pair.includes(opponentId))
  if (!current || !other) return 'not available'
  const partner = current.find((id) => id !== teamId)!
  if (partner === opponentId) return null
  const direct = pairReason(teamId, opponentId, context)
  if (direct) return direct
  const leftover = other.find((id) => id !== opponentId)!
  return pairReason(partner, leftover, context) ? `${context.teams.get(partner)?.label ?? partner} would have no valid opponent` : null
}

export function teamOutcome(row: Pick<SwissTeamStanding, 'wins' | 'losses' | 'status'>): TeamOutcome {
  if (row.status === 'advanced') return { state: 'advanced', wins: row.wins, losses: row.losses }
  if (row.status === 'eliminated') return { state: 'eliminated', wins: row.wins, losses: row.losses, placement: ['15th–16th', '12th–14th', '9th–11th'][row.wins] }
  return { state: 'active', wins: row.wins, losses: row.losses, nextBestOf: swissBestOf(row) }
}

/** Quarterfinal draw groups, §4.3.4: each 3–0 team meets a 3–2 team on opposite halves. */
export function knockoutEntry(standings: readonly SwissTeamStanding[]) {
  const advanced = standings.filter((row) => row.status === 'advanced')
  if (advanced.length !== 8) return null
  return {
    undefeated: advanced.filter((row) => row.losses === 0).map((row) => row.id),
    oneLoss: advanced.filter((row) => row.losses === 1).map((row) => row.id),
    twoLosses: advanced.filter((row) => row.losses === 2).map((row) => row.id),
  }
}

/**
 * Compact text form for the page address. Each match is three base-36
 * characters: both team indexes in baseline order, then 0 (no pick), 1 or 2
 * for the winner. Rounds are separated by dots.
 */
export function encodeChoices(baseline: SwissBaseline, choices: readonly DrawnRound[]) {
  const index = new Map(baseline.teams.map((team, position) => [team.id, position.toString(36)]))
  return choices.map((round) => round.pairs.map((pair, slot) => {
    const winner = round.winners[slot]
    return `${index.get(pair[0])}${index.get(pair[1])}${winner ? pair.indexOf(winner) + 1 : 0}`
  }).join('')).join('.')
}

export function decodeChoices(baseline: SwissBaseline, text: string | undefined): DrawnRound[] {
  if (!text || !/^([0-9a-z]{2}[012])+(\.([0-9a-z]{2}[012])+)*$/.test(text)) return []
  const rounds: DrawnRound[] = []
  for (const part of text.split('.')) {
    const round: DrawnRound = { pairs: [], winners: [] }
    for (let offset = 0; offset < part.length; offset += 3) {
      const pair = [part[offset], part[offset + 1]].map((char) => baseline.teams[parseInt(char, 36)]?.id)
      if (!pair[0] || !pair[1]) return rounds
      const winner = Number(part[offset + 2])
      round.pairs.push([pair[0], pair[1]])
      round.winners.push(winner ? pair[winner - 1]! : null)
    }
    rounds.push(round)
  }
  return rounds
}

function pairKey(pair: readonly string[]) {
  return JSON.stringify([...pair].sort(compareCodeUnits))
}
