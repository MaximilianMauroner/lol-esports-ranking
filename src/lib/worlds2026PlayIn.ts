import { forecastTournamentSeries, type ForecastBasis, type ForecastReady } from './tournamentForecast'
import type { TournamentSeries } from './tournamentFeed'
import type { ObservationEvidence } from './worldsObservedRules'

/** Riot v1.0, §§4.1.1, 4.1.4.2, 4.2.1 and 4.3.1. This module has no feed or UI caller. */
export const WORLDS_2026_PLAY_IN_RULES = {
  id: 'worlds-2026-play-in-v1',
  source: 'https://cdn.sanity.io/files/dsfx7636/news_live/faa5ce974e58615911fbee931c6123e2785a8b46.pdf',
  sourceVersion: '1.0',
  qualificationSource: 'https://lolesports.com/en-US/news/msi-and-worlds-updates',
  checkedAt: '2026-10-02',
  entrantSeeds: ['CBLOL2', 'LCS3', 'LEC3', 'LCP3'],
  bestOf: 5,
  qualificationSlots: 1,
  /** Observed opening draw positions; no draw is sampled or inferred from ratings. */
  matches: [
    { id: 'r1-a', home: { seed: 0 }, away: { seed: 1 } },
    { id: 'r1-b', home: { seed: 2 }, away: { seed: 3 } },
    { id: 'r2-upper', home: { match: 'r1-a', outcome: 'winnerId' }, away: { match: 'r1-b', outcome: 'winnerId' } },
    { id: 'r2-lower', home: { match: 'r1-a', outcome: 'loserId' }, away: { match: 'r1-b', outcome: 'loserId' } },
    { id: 'r3', home: { match: 'r2-upper', outcome: 'loserId' }, away: { match: 'r2-lower', outcome: 'winnerId' } },
    { id: 'r4', home: { match: 'r2-upper', outcome: 'winnerId' }, away: { match: 'r3', outcome: 'winnerId' } },
  ],
} as const

type MatchDefinition = typeof WORLDS_2026_PLAY_IN_RULES.matches[number]
export type PlayInMatchSlot = MatchDefinition['id']
export type PlayInEntrant = { id: string; seed: typeof WORLDS_2026_PLAY_IN_RULES.entrantSeeds[number] }
export type ObservedPlayInResult = {
  slot: PlayInMatchSlot
  matchId: string
  teamIds: [string, string]
  gameWins: [number, number]
  observedAt: string
}
export type Worlds2026PlayInInput = {
  rulesId: string
  eventId: string
  stateVersion: string
  asOf: string
  entrants: PlayInEntrant[]
  /** Four distinct entrant IDs, paired 0–1 and 2–3 by a supplied draw observation. */
  slots: string[]
  evidence: { entrants: ObservationEvidence; draw: ObservationEvidence; results?: ObservationEvidence }
  results: ObservedPlayInResult[]
}

type ResolvedMatch = { teamIds: [string, string]; winnerId: string; loserId: string }
type Unsupported = { status: 'unsupported'; reason: 'rules-unavailable' | 'invalid-state' | 'evidence-missing' | 'model-unavailable'; detail: string }
export type PlayInTeamState = {
  id: string
  wins: number
  losses: number
  status: 'active' | 'qualified' | 'eliminated'
  /** Swiss qualification is not a Worlds championship or knockout qualification. */
  finish: 'swiss' | 17 | 18 | 19 | null
}
type PlayInReplay = {
  status: 'supported'
  rulesId: typeof WORLDS_2026_PLAY_IN_RULES.id
  source: typeof WORLDS_2026_PLAY_IN_RULES.source
  sourceVersion: typeof WORLDS_2026_PLAY_IN_RULES.sourceVersion
  qualificationSource: typeof WORLDS_2026_PLAY_IN_RULES.qualificationSource
  eventId: string
  stateVersion: string
  asOf: string
  evidence: Worlds2026PlayInInput['evidence']
  teams: PlayInTeamState[]
  readyMatches: Array<{ slot: PlayInMatchSlot; teamIds: [string, string] }>
  resolvedMatches: Partial<Record<PlayInMatchSlot, ResolvedMatch>>
}
export type PlayInReplayResult = PlayInReplay | Unsupported

/** Pure observed-state replay, including independent or partially completed rounds. */
export function replayWorlds2026PlayIn(input: Worlds2026PlayInInput): PlayInReplayResult {
  if (input.rulesId !== WORLDS_2026_PLAY_IN_RULES.id) return unsupported('rules-unavailable', 'Only the sourced 2026 v1.0 Play-In descriptor is supported.')
  if (!input.eventId.trim() || !input.stateVersion.trim() || !validTime(input.asOf)) return unsupported('invalid-state', 'Event, state revision and as-of timestamp are required.')
  if (!validEvidence(input.evidence?.entrants) || !validEvidence(input.evidence?.draw)
    || ((input.results.length > 0 || input.evidence.results !== undefined) && !validEvidence(input.evidence.results))) {
    return unsupported('evidence-missing', 'Entrants, opening draw and any completed results require separate tagged evidence.')
  }
  const seeds = new Set(input.entrants.map((team) => team.seed))
  const ids = new Set(input.entrants.map((team) => team.id))
  if (input.entrants.length !== 4 || ids.size !== 4 || seeds.size !== 4
    || input.entrants.some((team) => !team.id.trim() || !WORLDS_2026_PLAY_IN_RULES.entrantSeeds.includes(team.seed))
    || input.slots.length !== 4 || new Set(input.slots).size !== 4 || input.slots.some((id) => !ids.has(id))) {
    return unsupported('invalid-state', 'The complete CBLOL2/LCS3/LEC3/LCP3 field and a distinct four-slot draw are required.')
  }
  const matchIds = new Set(input.results.map((result) => result.matchId))
  const observed = new Map(input.results.map((result) => [result.slot, result]))
  if (observed.size !== input.results.length || matchIds.size !== input.results.length
    || input.results.some((result) => !result.matchId.trim() || !WORLDS_2026_PLAY_IN_RULES.matches.some((match) => match.id === result.slot))) {
    return unsupported('invalid-state', 'Each observed match ID and descriptor slot must be unique and valid.')
  }
  const resolved: Partial<Record<PlayInMatchSlot, ResolvedMatch>> = {}
  const readyMatches: PlayInReplay['readyMatches'] = []
  for (const definition of WORLDS_2026_PLAY_IN_RULES.matches) {
    const pair = participants(definition, input.slots, resolved)
    const result = observed.get(definition.id)
    if (!result) {
      if (pair) readyMatches.push({ slot: definition.id, teamIds: pair })
      continue
    }
    if (!pair || !validObservedResult(result, pair, input.asOf)) return unsupported('invalid-state', `Invalid or premature completed result for ${definition.id}.`)
    const winnerId = result.teamIds[result.gameWins[0] === 3 ? 0 : 1]
    resolved[definition.id] = { teamIds: pair, winnerId, loserId: pair.find((id) => id !== winnerId)! }
  }
  return {
    status: 'supported', rulesId: WORLDS_2026_PLAY_IN_RULES.id, source: WORLDS_2026_PLAY_IN_RULES.source,
    sourceVersion: WORLDS_2026_PLAY_IN_RULES.sourceVersion, qualificationSource: WORLDS_2026_PLAY_IN_RULES.qualificationSource, eventId: input.eventId,
    stateVersion: input.stateVersion, asOf: input.asOf, evidence: structuredClone(input.evidence),
    teams: teamStates(input.slots, resolved), readyMatches, resolvedMatches: resolved,
  }
}

export type PlayInTeamOdds = {
  id: string
  advanceToSwissProbability: number
  finish17Probability: number
  finish18Probability: number
  finish19Probability: number
  deterministicStatus: PlayInTeamState['status']
}
export type PlayInForecastResult = Unsupported | {
  status: 'supported'
  kind: 'offline-conditional-play-in-forecast'
  method: 'exact-enumeration'
  engineVersion: 'worlds-2026-play-in-exact-v1'
  state: PlayInReplay
  /** Exact under the existing frozen-strength, independent neutral-game model. */
  teams: PlayInTeamOdds[]
  terminalPaths: number
  totalProbability: number
  hypotheticalMatchups: ForecastReady[]
  assumptions: string[]
}

/**
 * Enumerates the at most 64 winner paths on a supplied draw. Observed winners stay fixed.
 * Hypothetical provider rows remain local; no receipts or source artifacts are created.
 */
export function forecastWorlds2026PlayIn(input: Worlds2026PlayInInput, basis: ForecastBasis): PlayInForecastResult {
  const state = replayWorlds2026PlayIn(input)
  if (state.status === 'unsupported') return state
  if (!state.resolvedMatches.r4 && (!validTime(basis.ratingDataAsOf) || !validTime(basis.ratingPublishedAt)
    || Date.parse(basis.ratingDataAsOf) > Date.parse(basis.ratingPublishedAt)
    || Date.parse(basis.ratingPublishedAt) > Date.parse(input.asOf))) {
    return unsupported('model-unavailable', 'The frozen snapshot must satisfy data cutoff ≤ publication ≤ event-state information cutoff.')
  }
  const odds = new Map(state.teams.map((team) => [team.id, {
    id: team.id, advanceToSwissProbability: 0, finish17Probability: 0,
    finish18Probability: 0, finish19Probability: 0, deterministicStatus: team.status,
  }]))
  const observedMatches = state.resolvedMatches
  const matchups = new Map<string, ForecastReady>()
  let terminalPaths = 0
  let totalProbability = 0
  function enumerate(index: number, resolved: PlayInReplay['resolvedMatches'], mass: number): Unsupported | null {
    const definition = WORLDS_2026_PLAY_IN_RULES.matches[index]
    if (!definition) {
      terminalPaths++
      totalProbability += mass
      for (const team of teamStates(input.slots, resolved)) {
        const row = odds.get(team.id)!
        if (team.finish === 'swiss') row.advanceToSwissProbability += mass
        if (team.finish === 17) row.finish17Probability += mass
        if (team.finish === 18) row.finish18Probability += mass
        if (team.finish === 19) row.finish19Probability += mass
      }
      return null
    }
    if (observedMatches[definition.id]) return enumerate(index + 1, resolved, mass)
    const pair = participants(definition, input.slots, resolved)
    if (!pair) return unsupported('invalid-state', `Missing upstream path for ${definition.id}.`)
    const key = JSON.stringify([definition.id, pair])
    let forecast = matchups.get(key)
    if (!forecast) {
      const result = forecastTournamentSeries(hypotheticalSeries(input, definition.id, pair), basis, {
        sideAssumption: 'neutral', sideBasis: 'Hypothetical neutral-side Bo5; RoFS/RoDS and pick choices are not modeled.',
      })
      if (result.status === 'unavailable') return unsupported('model-unavailable', `${pair.join(' vs ')}: ${result.reason}: ${result.detail}`)
      forecast = result
      matchups.set(key, forecast)
    }
    const probabilities = [forecast.homeSeriesWinProbability, forecast.awaySeriesWinProbability]
    for (const winnerIndex of [0, 1]) {
      const probability = probabilities[winnerIndex]
      if (probability === 0) continue
      const next = { ...resolved, [definition.id]: { teamIds: pair, winnerId: pair[winnerIndex], loserId: pair[1 - winnerIndex] } }
      const error = enumerate(index + 1, next, mass * probability)
      if (error) return error
    }
    return null
  }
  const error = enumerate(0, state.resolvedMatches, 1)
  if (error) return error
  return {
    status: 'supported', kind: 'offline-conditional-play-in-forecast', method: 'exact-enumeration', engineVersion: 'worlds-2026-play-in-exact-v1', state,
    teams: [...odds.values()], terminalPaths, totalProbability, hypotheticalMatchups: [...matchups.values()],
    assumptions: [
      'Conditional on the supplied opening draw and observed results; evidence tags are caller assertions, not authentication.',
      'Frozen Power, uncertainty, roster and model/config basis; independent games and neutral sides through the existing #46 provider.',
      'Game-one RoFS and the upper finalist’s RoDS, subsequent loser selection and draft choices are not modeled.',
      'No official event forecast, pre-match publication receipt, live partial-series conditioning or production activation is claimed.',
    ],
  }
}

function participants(definition: MatchDefinition, slots: string[], resolved: PlayInReplay['resolvedMatches']): [string, string] | null {
  function team(reference: MatchDefinition['home'] | MatchDefinition['away']): string | undefined {
    return 'seed' in reference ? slots[reference.seed] : resolved[reference.match]?.[reference.outcome]
  }
  const home = team(definition.home)
  const away = team(definition.away)
  return home && away && home !== away ? [home, away] : null
}

function teamStates(slots: string[], resolved: PlayInReplay['resolvedMatches']): PlayInTeamState[] {
  return slots.map((id) => {
    const finish = resolved.r4?.winnerId === id ? 'swiss'
      : resolved.r4?.loserId === id ? 17 : resolved.r3?.loserId === id ? 18
        : resolved['r2-lower']?.loserId === id ? 19 : null
    const matches = Object.values(resolved)
    return {
      id, wins: matches.filter((match) => match.winnerId === id).length,
      losses: matches.filter((match) => match.loserId === id).length,
      status: finish === 'swiss' ? 'qualified' : finish === null ? 'active' : 'eliminated', finish,
    }
  })
}

function validObservedResult(result: ObservedPlayInResult, pair: [string, string], asOf: string) {
  const [home, away] = result.gameWins
  return result.teamIds.length === 2 && new Set(result.teamIds).size === 2 && result.teamIds.every((id) => pair.includes(id))
    && result.gameWins.length === 2 && Number.isInteger(home) && Number.isInteger(away)
    && ((home === 3 && away >= 0 && away < 3) || (away === 3 && home >= 0 && home < 3))
    && validTime(result.observedAt) && Date.parse(result.observedAt) <= Date.parse(asOf)
}

function hypotheticalSeries(input: Worlds2026PlayInInput, slot: PlayInMatchSlot, pair: [string, string]): TournamentSeries {
  return {
    id: `hypothetical:${JSON.stringify([input.stateVersion, slot, pair])}`, eventId: input.eventId,
    startTime: null, stage: 'Play-In', status: 'upcoming', sourceState: 'unstarted', bestOf: 5,
    teams: pair.map((id) => ({ id, name: null, code: null, gameWins: null, outcome: null })), vodUrls: [],
  }
}
function validTime(value: string) { return Boolean(value?.trim()) && Number.isFinite(Date.parse(value)) }
function validEvidence(value: ObservationEvidence | undefined) {
  return Boolean(value && (value.kind === 'synthetic-fixture' || value.kind === 'source-observation') && value.reference?.trim())
}
function unsupported(reason: Unsupported['reason'], detail: string): Unsupported { return { status: 'unsupported', reason, detail } }
