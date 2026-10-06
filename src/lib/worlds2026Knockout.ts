import { forecastTournamentSeries, type ForecastBasis, type ForecastReady } from './tournamentForecast'
import type { ObservationEvidence } from './worldsObservedRules'

/** Conditional on a supplied draw, not a simulation of the draw procedure. */
export const WORLDS_2026_KNOCKOUT_RULES = {
  id: 'worlds-2026-knockout-v1',
  source: 'https://cdn.sanity.io/files/dsfx7636/news_live/faa5ce974e58615911fbee931c6123e2785a8b46.pdf',
  sourceVersion: '1.0',
  checkedAt: '2026-10-02',
  clauses: ['4.1.3', '4.3.4'],
  bestOf: 5,
  // Quarterfinals 0–3; semifinals 4–5; final 6. Slot order fixes bracket halves.
  matches: [
    { stage: 'quarterfinal', upstream: [0, 1] },
    { stage: 'quarterfinal', upstream: [2, 3] },
    { stage: 'quarterfinal', upstream: [4, 5] },
    { stage: 'quarterfinal', upstream: [6, 7] },
    { stage: 'semifinal', upstream: [0, 1] },
    { stage: 'semifinal', upstream: [2, 3] },
    { stage: 'final', upstream: [4, 5] },
  ],
} as const

type MatchStage = typeof WORLDS_2026_KNOCKOUT_RULES.matches[number]['stage']
export type ObservedKnockoutResult = {
  slot: number
  matchId: string
  teamIds: [string, string]
  gameWins: [number, number]
  observedAt: string
}
export type Worlds2026KnockoutInput = {
  rulesId: string
  eventId: string
  stateVersion: string
  asOf: string
  /** Observed Swiss qualifiers only. This API does not certify a full Swiss replay. */
  qualifiers: Array<{ id: string; swissWins: 3; swissLosses: 0 | 1 | 2 }>
  /** Adjacent entries play quarterfinals; entries 0–3 and 4–7 form opposite halves. */
  slots: string[]
  evidence: { qualifiers: ObservationEvidence; draw: ObservationEvidence; results?: ObservationEvidence }
  results: ObservedKnockoutResult[]
}
export type KnockoutTeamState = {
  id: string
  reached: MatchStage | 'champion'
  eliminatedAt: MatchStage | null
}
type Resolved = { teamIds: [string, string]; winnerId: string; loserId: string; observedAt?: string }
type ResolvedMatches = Partial<Record<number, Resolved>>
type Unsupported = { status: 'unsupported'; reason: 'rules-unavailable' | 'evidence-missing' | 'invalid-state' | 'model-unavailable'; detail: string }
type Replay = {
  status: 'supported'
  rulesId: typeof WORLDS_2026_KNOCKOUT_RULES.id
  source: typeof WORLDS_2026_KNOCKOUT_RULES.source
  sourceVersion: typeof WORLDS_2026_KNOCKOUT_RULES.sourceVersion
  eventId: string
  stateVersion: string
  asOf: string
  evidence: Worlds2026KnockoutInput['evidence']
  slots: string[]
  teams: KnockoutTeamState[]
  readyMatches: Array<{ slot: number; teamIds: [string, string] }>
  resolvedMatches: ResolvedMatches
}
export type KnockoutReplayResult = Replay | Unsupported

export function replayWorlds2026Knockout(input: Worlds2026KnockoutInput): KnockoutReplayResult {
  if (input.rulesId !== WORLDS_2026_KNOCKOUT_RULES.id) return unsupported('rules-unavailable', 'Only the sourced 2026 v1.0 knockout descriptor is supported.')
  if (!input.eventId.trim() || !input.stateVersion.trim() || !validTime(input.asOf)) return unsupported('invalid-state', 'Event, state revision and as-of timestamp are required.')
  if (!validEvidence(input.evidence?.qualifiers) || !validEvidence(input.evidence?.draw)
    || ((input.results.length > 0 || input.evidence.results !== undefined) && !validEvidence(input.evidence.results))) {
    return unsupported('evidence-missing', 'Qualifiers, draw and any completed results require separate tagged evidence.')
  }
  const drawError = validateDraw(input)
  if (drawError) return unsupported('invalid-state', drawError)
  const observations = new Map(input.results.map((result) => [result.slot, result]))
  if (observations.size !== input.results.length || new Set(input.results.map((result) => result.matchId)).size !== input.results.length
    || input.results.some((result) => !result.matchId.trim() || !Number.isInteger(result.slot) || result.slot < 0 || result.slot > 6)) {
    return unsupported('invalid-state', 'Observed match IDs and slots must be unique and valid.')
  }
  const resolved: ResolvedMatches = {}
  const readyMatches: Replay['readyMatches'] = []
  for (const [slot, definition] of WORLDS_2026_KNOCKOUT_RULES.matches.entries()) {
    const pair = participants(slot, input.slots, resolved)
    const result = observations.get(slot)
    if (!result) {
      if (pair) readyMatches.push({ slot, teamIds: pair })
      continue
    }
    if (!pair || !validResult(result, pair, input.asOf)
      || (definition.stage !== 'quarterfinal' && definition.upstream.some((prior) => Date.parse(resolved[prior]!.observedAt!) > Date.parse(result.observedAt)))) {
      return unsupported('invalid-state', `Invalid or premature completed result for slot ${slot}.`)
    }
    const winnerId = result.teamIds[result.gameWins[0] === 3 ? 0 : 1]
    resolved[slot] = { teamIds: pair, winnerId, loserId: pair.find((id) => id !== winnerId)!, observedAt: result.observedAt }
  }
  return {
    status: 'supported', rulesId: WORLDS_2026_KNOCKOUT_RULES.id, source: WORLDS_2026_KNOCKOUT_RULES.source,
    sourceVersion: WORLDS_2026_KNOCKOUT_RULES.sourceVersion, eventId: input.eventId,
    stateVersion: input.stateVersion, asOf: input.asOf, evidence: structuredClone(input.evidence), slots: [...input.slots],
    teams: teamStates(input.slots, resolved), readyMatches, resolvedMatches: resolved,
  }
}

export type KnockoutTeamOdds = {
  id: string
  reachSemifinalProbability: number
  reachFinalProbability: number
  championProbability: number
  finish5To8Probability: number
  finish3To4Probability: number
  runnerUpProbability: number
  deterministicState: KnockoutTeamState
}
export type KnockoutForecastResult = Unsupported | {
  status: 'supported'
  kind: 'offline-conditional-knockout-forecast'
  method: 'exact-enumeration'
  engineVersion: 'worlds-2026-knockout-exact-v1'
  state: Replay
  teams: KnockoutTeamOdds[]
  terminalPaths: number
  totalProbability: number
  hypotheticalMatchups: ForecastReady[]
  assumptions: string[]
}

/** Enumerates at most 128 winner paths. Observed winners and bracket links stay fixed. */
export function forecastWorlds2026Knockout(input: Worlds2026KnockoutInput, basis: ForecastBasis): KnockoutForecastResult {
  const state = replayWorlds2026Knockout(input)
  if (state.status === 'unsupported') return state
  if (!state.resolvedMatches[6] && (!validTime(basis.ratingDataAsOf) || !validTime(basis.ratingPublishedAt)
    || Date.parse(basis.ratingDataAsOf) > Date.parse(basis.ratingPublishedAt)
    || Date.parse(basis.ratingPublishedAt) > Date.parse(input.asOf))) {
    return unsupported('model-unavailable', 'The frozen snapshot must satisfy data cutoff ≤ publication ≤ event-state cutoff.')
  }
  const odds = new Map(state.teams.map((team) => [team.id, {
    id: team.id, reachSemifinalProbability: 0, reachFinalProbability: 0, championProbability: 0,
    finish5To8Probability: 0, finish3To4Probability: 0, runnerUpProbability: 0, deterministicState: team,
  }]))
  const observedMatches = state.resolvedMatches
  const matchups = new Map<string, ForecastReady>()
  let terminalPaths = 0
  let totalProbability = 0
  function enumerate(slot: number, resolved: ResolvedMatches, mass: number): Unsupported | null {
    const definition = WORLDS_2026_KNOCKOUT_RULES.matches[slot]
    if (!definition) {
      terminalPaths++
      totalProbability += mass
      for (const team of teamStates(input.slots, resolved)) {
        const row = odds.get(team.id)!
        if (team.reached !== 'quarterfinal') row.reachSemifinalProbability += mass
        if (team.reached === 'final' || team.reached === 'champion') row.reachFinalProbability += mass
        if (team.reached === 'champion') row.championProbability += mass
        if (team.eliminatedAt === 'quarterfinal') row.finish5To8Probability += mass
        if (team.eliminatedAt === 'semifinal') row.finish3To4Probability += mass
        if (team.eliminatedAt === 'final') row.runnerUpProbability += mass
      }
      return null
    }
    if (observedMatches[slot]) return enumerate(slot + 1, resolved, mass)
    const pair = participants(slot, input.slots, resolved)
    if (!pair) return unsupported('invalid-state', `Missing upstream path for slot ${slot}.`)
    const key = JSON.stringify([slot, pair])
    let forecast = matchups.get(key)
    if (!forecast) {
      const result = forecastTournamentSeries({
        id: `hypothetical:${JSON.stringify([input.stateVersion, slot, pair])}`, eventId: input.eventId,
        startTime: null, stage: definition.stage, status: 'upcoming', sourceState: 'unstarted', bestOf: 5, vodUrls: [],
        teams: pair.map((id) => ({ id, name: null, code: null, gameWins: null, outcome: null })),
      }, basis, { sideAssumption: 'neutral', sideBasis: 'Hypothetical neutral-side Bo5; selection rights and draft choices are not modeled.' })
      if (result.status === 'unavailable') return unsupported('model-unavailable', `${pair.join(' vs ')}: ${result.reason}: ${result.detail}`)
      const probabilities = [result.homeGameWinProbability, result.awayGameWinProbability,
        result.homeSeriesWinProbability, result.awaySeriesWinProbability]
      if (probabilities.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
        || Math.abs(result.homeGameWinProbability + result.awayGameWinProbability - 1) > 0.0002
        || Math.abs(result.homeSeriesWinProbability + result.awaySeriesWinProbability - 1) > 0.0002) {
        return unsupported('model-unavailable', `${pair.join(' vs ')}: The model must return finite, complementary game and series probabilities.`)
      }
      forecast = result
      matchups.set(key, forecast)
    }
    const probabilities = [forecast.homeSeriesWinProbability, forecast.awaySeriesWinProbability]
    for (const winnerIndex of [0, 1]) {
      if (probabilities[winnerIndex] === 0) continue
      const next = { ...resolved, [slot]: { teamIds: pair, winnerId: pair[winnerIndex], loserId: pair[1 - winnerIndex] } }
      const error = enumerate(slot + 1, next, mass * probabilities[winnerIndex])
      if (error) return error
    }
    return null
  }
  const error = enumerate(0, state.resolvedMatches, 1)
  if (error) return error
  return {
    status: 'supported', kind: 'offline-conditional-knockout-forecast', method: 'exact-enumeration',
    engineVersion: 'worlds-2026-knockout-exact-v1', state, teams: [...odds.values()], terminalPaths, totalProbability,
    hypotheticalMatchups: [...matchups.values()], assumptions: [
      'Conditional on supplied Swiss qualifiers, observed draw and complete series results; evidence tags are caller assertions, not authentication.',
      'Frozen Power, uncertainty, roster and model/config basis; independent neutral games through the existing #46 provider.',
      'No draw is sampled, no live partial-series score is conditioned on, and selection rights/draft choices are not modeled.',
      'Exact means enumerated under this model, not calibrated or official; no receipt publication or production activation is claimed.',
    ],
  }
}

function validateDraw(input: Worlds2026KnockoutInput): string | null {
  const ids = new Set(input.qualifiers.map((team) => team.id))
  if (input.qualifiers.length !== 8 || ids.size !== 8 || input.qualifiers.some((team) => !team.id.trim() || team.swissWins !== 3
    || ![0, 1, 2].includes(team.swissLosses)) || [0, 1, 2].some((losses, i) => input.qualifiers.filter((team) => team.swissLosses === losses).length !== [2, 3, 3][i])) {
    return 'Eight distinct observed qualifiers with Swiss record counts 2/3/3 are required.'
  }
  if (input.slots.length !== 8 || new Set(input.slots).size !== 8 || input.slots.some((id) => !ids.has(id))) return 'Draw slots must contain each qualifier exactly once.'
  const byId = new Map(input.qualifiers.map((team) => [team.id, team]))
  const undefeatedMatches: number[] = []
  for (let slot = 0; slot < 4; slot++) {
    const losses = [byId.get(input.slots[slot * 2])!.swissLosses, byId.get(input.slots[slot * 2 + 1])!.swissLosses]
    if (!losses.includes(0)) continue
    if (!losses.includes(2)) return 'A 3–0 qualifier must face a 3–2 qualifier.'
    undefeatedMatches.push(slot)
  }
  if (undefeatedMatches.length !== 2 || Math.floor(undefeatedMatches[0] / 2) === Math.floor(undefeatedMatches[1] / 2)) return 'The two 3–0 quarterfinals must lie on opposite bracket halves.'
  return null
}
function participants(slot: number, slots: string[], resolved: ResolvedMatches): [string, string] | null {
  const definition = WORLDS_2026_KNOCKOUT_RULES.matches[slot]
  const [a, b] = definition.upstream.map((prior) => definition.stage === 'quarterfinal' ? slots[prior] : resolved[prior]?.winnerId)
  return a && b && a !== b ? [a, b] : null
}
function teamStates(slots: string[], resolved: ResolvedMatches): KnockoutTeamState[] {
  const teams = new Map<string, KnockoutTeamState>(slots.map((id) => [id, { id, reached: 'quarterfinal', eliminatedAt: null }]))
  for (const [slot, definition] of WORLDS_2026_KNOCKOUT_RULES.matches.entries()) {
    const result = resolved[slot]
    if (!result) continue
    teams.get(result.loserId)!.eliminatedAt = definition.stage
    teams.get(result.winnerId)!.reached = definition.stage === 'quarterfinal' ? 'semifinal' : definition.stage === 'semifinal' ? 'final' : 'champion'
  }
  return [...teams.values()]
}
function validResult(result: ObservedKnockoutResult, pair: [string, string], asOf: string) {
  const [a, b] = result.gameWins
  return result.teamIds.length === 2 && new Set(result.teamIds).size === 2 && result.teamIds.every((id) => pair.includes(id))
    && result.gameWins.length === 2 && Number.isInteger(a) && Number.isInteger(b)
    && ((a === 3 && b >= 0 && b < 3) || (b === 3 && a >= 0 && a < 3))
    && validTime(result.observedAt) && Date.parse(result.observedAt) <= Date.parse(asOf)
}
function validTime(value: string) { return Boolean(value?.trim()) && Number.isFinite(Date.parse(value)) }
function validEvidence(value: ObservationEvidence | undefined) {
  return Boolean(value && (value.kind === 'synthetic-fixture' || value.kind === 'source-observation') && value.reference?.trim())
}
function unsupported(reason: Unsupported['reason'], detail: string): Unsupported { return { status: 'unsupported', reason, detail } }
