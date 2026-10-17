import { compareCodeUnits } from '../../../shared/codeUnitOrder.mjs'
import { WORLDS_2026_SWISS_RULES, applySwissWinner, swissBestOf, type SwissSeed } from './worlds2026Swiss.ts'
import type { SwissTeamStanding } from './worldsObservedRules.ts'
import { shuffled } from './worldsSimulation.ts'
import type { TournamentEvent, TournamentSeries } from './tournamentFeed.ts'

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

/** Where the confirmed 2026 field comes from. It is event data, not a Power ranking. */
export const SWISS_TEAM_SOURCES = {
  checkedAt: '2026-10-13',
  primer: 'https://lolesports.com/en-SG/news/worlds-2026-primer',
  cblolFinal: 'https://www.techtudo.com.br/noticias/2026/10/final-do-cblol-2026-los-bate-furia-em-revanche-do-primeiro-split-e-e-campea-edjogos.ghtml',
} as const

/**
 * The team in each direct Swiss seed slot. Riot's primer names the Round 1 draw tiers, which are the seed pools in
 * `WORLDS_2026_SWISS_RULES`. LØS took CBLOL 1 in the October 10 final. The Play-In winner is decided October 15 to 18.
 * Names match the team branding data (`teamBranding.generated.ts`), so the usual codes and logos apply.
 */
const QUALIFIED_TEAMS: Record<Exclude<SwissSeed, 'PLAYIN'>, string> = {
  LCK1: 'Gen.G', LPL1: "Anyone's Legend", LCS1: 'Team Liquid', LEC1: 'G2 Esports',
  LCP1: 'Team Secret Whales', CBLOL1: 'LØS', LCK2: 'Hanwha Life Esports', LPL2: 'Bilibili Gaming',
  LCS2: 'LYON', LEC2: 'Movistar KOI', LCK3: 'T1', LPL3: 'Top Esports',
  LCP2: 'CTBC Flying Oyster', LPL4: 'Invictus Gaming', LCK4: 'Dplus KIA',
}

/** A record group in one bracket column: teams that play with this record, or that finished with it. */
export type BracketBox = { record: [number, number]; kind: 'play' | 'advanced' | 'eliminated'; size: number }

/**
 * The Swiss bracket as columns: Rounds 1 to 5, then the records after Round 5. In a 16-team stage the size of every
 * record group is fixed, whatever the results, so the whole bracket can be drawn before any match is played.
 */
export const SWISS_BRACKET: BracketBox[][] = (() => {
  const columns: BracketBox[][] = []
  let playing: BracketBox[] = [{ record: [0, 0], kind: 'play', size: 16 }]
  let finished: BracketBox[] = []
  for (let round = 0; round <= SWISS_ROUND_SIZES.length; round++) {
    columns.push([...finished.filter((box) => box.kind === 'advanced'), ...playing, ...finished.filter((box) => box.kind === 'eliminated')])
    const next = new Map<string, BracketBox>()
    for (const { record: [wins, losses], size } of playing) {
      // Half of each group wins its match and half loses it.
      for (const [nextWins, nextLosses] of [[wins + 1, losses], [wins, losses + 1]]) {
        const key = `${nextWins}-${nextLosses}`
        const box: BracketBox = next.get(key)
          ?? { record: [nextWins, nextLosses], kind: nextWins === 3 ? 'advanced' : nextLosses === 3 ? 'eliminated' : 'play', size: 0 }
        box.size += size / 2
        next.set(key, box)
      }
    }
    playing = [...next.values()].filter((box) => box.kind === 'play')
    finished = [...next.values()].filter((box) => box.kind !== 'play')
  }
  return columns
})()

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

export function seedBaseline(playInRegion: PlayInRegion | null, playInTeam?: string): SwissBaseline {
  const teams = WORLDS_2026_SWISS_RULES.pools.flat().map((seed): PreviewTeam => seed === 'PLAYIN'
    ? { id: seed, label: playInRegion && playInTeam ? playInTeam : 'Play-In winner', seed, region: playInRegion }
    : { id: seed, label: QUALIFIED_TEAMS[seed], seed, region: seed.replace(/\d+$/, '') })
  return { kind: 'seeds', teams, rounds: [] }
}

/** The 2026 Main Event, which holds the Swiss rounds and the knockout bracket. */
export function findSwissEvent(events: readonly TournamentEvent[]) {
  return events.find((event) => event.competition === 'worlds' && event.season === '2026' && /\/Main Event$/.test(event.sourceTournamentId))
}

/**
 * Reads the published Swiss draws and results from the schedule. The baseline
 * is available only when the full Round 1 draw is published and every later
 * full draw follows the Swiss rules. A partly published round and the rounds
 * after it are left out.
 */
export function liveSwissBaseline(event: TournamentEvent): LiveBaseline {
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
  // Teams are ordered by name, not by match time: saved scenarios store team indexes, so a schedule change must not move them.
  const ids = firstRound.flatMap((series) => seriesPair(series)!).sort(compareCodeUnits)
  if (new Set(ids).size !== 16) return { status: 'unavailable', detail: 'Round 1 in the schedule does not list 16 different teams.' }
  const baseline: SwissBaseline = { kind: 'live', teams: ids.map((id) => ({ id, label: id, seed: null, region: null })), rounds: [] }
  let note: string | null = null
  for (const [index, size] of SWISS_ROUND_SIZES.entries()) {
    const list = byRound.get(index + 1) ?? []
    if (list.length > size) return { status: 'unavailable', detail: `Round ${index + 1} in the schedule has more than ${size} matches.` }
    const pairs = list.map(seriesPair)
    if (list.length < size || pairs.some((pair) => !pair)) {
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
    if (!canFinish([], bucket.teamIds, (a, b) => !pairReason(a, b, context, false))) (context.rematchBuckets as Set<string>).add(bucket.record)
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
    if (mayShareRegion(home, away) || mayShareRegion(away, home)) return 'Play-In region not chosen'
  }
  if (first.opponents.includes(b) && !(allowWaivedRematch && context.rematchBuckets.has(`${first.wins}-${first.losses}`))) return 'already played'
  return null
}

/** A Play-In winner whose region is not chosen yet could come from the other team's region. */
function mayShareRegion(team: PreviewTeam, other: PreviewTeam) {
  return team.seed === 'PLAYIN' && !team.region && PLAY_IN_REGIONS.some((region) => region === other.region)
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
 * One random draw by Riot's procedure, `drawByRulebook`, with every pot order equally likely. In Round 1 the pot is
 * Pool 1 then Pool 4, and Pool 2 then Pool 3 (rule 4.3.2.2). Later rounds draw each record group on its own
 * (rule 4.3.3.1). This is a convenience for building scenarios, not a prediction of the official draw.
 */
export function fillDraw(
  context: DrawContext,
  random: () => number = Math.random,
  legal: (a: string, b: string) => boolean = (a, b) => !pairReason(a, b, context),
): [string, string][] | null {
  const pairs: [string, string][] = []
  for (const pot of drawPots(context)) {
    const drawn = drawByRulebook(pot.flatMap((teamIds) => shuffled(teamIds, random)), legal)
    if (!drawn) return null
    pairs.push(...drawn)
  }
  return pairs
}

/** Whether `fillDraw` can make a draw. This does not depend on chance, so render can ask it. */
export function drawExists(context: DrawContext): boolean {
  return drawPots(context).every((pot) => canFinish([], pot.flat(), (a, b) => !pairReason(a, b, context)))
}

/** The pots of one draw. Each pot is a list of groups whose teams come out in a random order, group after group. */
export function drawPots(context: DrawContext): string[][][] {
  const teams = [...context.teams.values()]
  if (context.round !== 1 || teams.some((team) => !team.seed)) return context.buckets.map((bucket) => [bucket.teamIds])
  const pool = (index: number) => teams.filter((team) => (WORLDS_2026_SWISS_RULES.pools[index] as readonly string[]).includes(team.seed!)).map((team) => team.id)
  return [[pool(0), pool(3)], [pool(1), pool(2)]]
}

/**
 * Riot's draw procedure, rules 4.3.2.2 to 4.3.3.2. Teams come out of the pot in `order`. Each team takes the first
 * open slot, with matches filled in order. If that slot breaks a draw restriction, or leaves no legal way to finish
 * the draw, the team moves to the next open slot. Returns null when no legal draw exists.
 */
export function drawByRulebook(order: readonly string[], legal: (a: string, b: string) => boolean): [string, string][] | null {
  const matches: string[][] = Array.from({ length: order.length / 2 }, () => [])
  for (const [index, team] of order.entries()) {
    const rest = order.slice(index + 1)
    const slot = matches.find((match) => match.length < 2 && (!match.length || legal(match[0], team)) && canFinish(
      matches.flatMap((other) => other === match ? (match.length ? [] : [team]) : other.length === 1 ? [other[0]] : []), rest, legal))
    if (!slot) return null
    slot.push(team)
  }
  return matches as [string, string][]
}

/** Whether the teams left in the pot can fill every open slot: first the matches with one team, then empty ones. */
function canFinish(waiting: readonly string[], pot: readonly string[], legal: (a: string, b: string) => boolean): boolean {
  const used = pot.map(() => false)
  const fill = (next: number): boolean => {
    if (next < waiting.length) {
      for (let index = 0; index < pot.length; index++) {
        if (used[index] || !legal(waiting[next], pot[index])) continue
        used[index] = true
        if (fill(next + 1)) return true
        used[index] = false
      }
      return false
    }
    const first = used.indexOf(false)
    if (first < 0) return true
    used[first] = true
    for (let index = first + 1; index < pot.length; index++) {
      if (used[index] || !legal(pot[first], pot[index])) continue
      used[index] = true
      if (fill(next)) return true
      used[index] = false
    }
    used[first] = false
    return false
  }
  return fill(0)
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
