import { normalizeStatus, type TournamentEvent } from './tournamentFeed'
import type { Worlds2026EventInput } from './worldsSimulation'
import type { Worlds2026PlayInInput, PlayInEntrant } from './worlds2026PlayIn'
import type { Worlds2026KnockoutInput } from './worlds2026Knockout'
import type { Worlds2026SwissInput, Worlds2026SwissEntrant } from './worlds2026Swiss'
import { WORLDS_2026_SWISS_RULES, validWorldsTime } from './worlds2026Swiss'
import type { ObservationEvidence } from './worldsObservedRules'
import type { replayWorlds2022Group } from './worlds2022ObservedGroups'

export type HistoricalWorldsInput = {
  format: 'worlds-2022-group'; eventId: string; stateVersion: string; asOf: string
  group: Parameters<typeof replayWorlds2022Group>[0]
}
export type WorldsJourneyInput = Worlds2026EventInput | HistoricalWorldsInput
export type WorldsArtifact = {
  version: 1; eventId: string; feedEventKey: string
  dataMode: 'synthetic-fixture' | 'source-observation'
  state: WorldsJourneyInput
}

/** A result correction invalidates the companion, even when its claimed revision is unchanged. */
export function worldsFeedEventKey(event: TournamentEvent) {
  return JSON.stringify([event.id, event.sourceTournamentId, event.season,
    [...event.series].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .map((series) => [series.id, series.stage, series.status, series.sourceState, series.bestOf,
        series.startTime, series.teams.map((team) => [team.id, team.gameWins, team.outcome])])])
}

export async function loadWorldsArtifact(event: TournamentEvent, fixtureFeed: boolean, signal: AbortSignal): Promise<WorldsArtifact> {
  const response = await fetch(`/tournament-data/worlds/${encodeURIComponent(event.id)}.json`, { cache: 'no-store', signal })
  if (!response.ok) throw new Error(response.status === 404 ? 'No reviewed Worlds state companion is available. The schedule remains available.' : `Worlds state returned HTTP ${response.status}.`)
  const text = await response.text()
  if (text.length > 512_000) throw new Error('Worlds state exceeds the bounded companion size.')
  const body: unknown = JSON.parse(text)
  if (!isWorldsArtifact(body)) throw new Error('Worlds state schema is unsupported or incomplete.')
  if (body.eventId !== event.id || body.feedEventKey !== worldsFeedEventKey(event)) throw new Error('Worlds state does not match this schedule revision. Waiting for a coherent state companion.')
  if (body.dataMode === 'synthetic-fixture' && !fixtureFeed) throw new Error('A synthetic Worlds companion cannot be attached to a source schedule.')
  if (body.dataMode === 'source-observation' && stateEvidence(body.state).some((entry) => entry.kind === 'synthetic-fixture')) throw new Error('Synthetic evidence cannot be labeled as source observations.')
  const context = body.state.format === 'worlds-2026' ? body.state.playIn : body.state
  if (context.eventId !== event.id || !validWorldsTime(context.asOf) || !context.stateVersion.trim()) throw new Error('Worlds event, state revision and information cutoff are required.')
  const season = body.state.format === 'worlds-2026' ? '2026' : '2022'
  if (event.season !== season || !context.asOf.startsWith(season)) throw new Error('Worlds rules, event season and as-of year disagree.')
  if (body.state.format === 'worlds-2026') validateScheduleResults(event, body.state)
  return body
}

/** A content key alone cannot establish that the companion retained the schedule's results. */
function validateScheduleResults(event: TournamentEvent, state: Worlds2026EventInput) {
  const results = [...state.playIn.results, ...(state.swiss?.rounds.flatMap((round) => round.results) ?? []), ...(state.knockout?.results ?? [])]
  for (const series of event.series) {
    if (series.status === 'cancelled' || normalizeStatus(series.sourceState) === 'cancelled') {
      throw new Error('Worlds advancement is unavailable because cancelled-series replacement, withdrawal and forfeit semantics are unsupported. The schedule remains available.')
    }
    if (series.status === 'unknown' && /^(?:complete|completed)$/i.test(series.sourceState)) {
      throw new Error('Worlds advancement is unavailable while a terminal source series lacks a confirmed result. The schedule remains available.')
    }
    if (series.status === 'live' || (series.status !== 'completed' && series.teams.some((team) => (team.gameWins ?? 0) > 0 || team.outcome))) {
      throw new Error('Worlds advancement is unavailable while a series has live or unresolved played-game evidence. Live game conditioning is not supported; the schedule remains available.')
    }
    const observed = results.find((result) => result.matchId === series.id)
    if (observed && series.status !== 'completed') {
      throw new Error(`Worlds state reports result ${series.id} before the schedule confirms its completion. The schedule remains available.`)
    }
    if (series.status !== 'completed') continue
    if (!observed || series.teams.length !== 2 || new Set(series.teams.map((team) => team.id)).size !== 2
      || series.teams.some((team) => !team.id || !observed.teamIds.includes(team.id))) {
      throw new Error(`Worlds state must retain confirmed schedule result ${series.id} with the same match and team IDs.`)
    }
    for (const team of series.teams) {
      const slot = observed.teamIds.indexOf(team.id!)
      const wins = observed.gameWins[slot]
      const won = wins > observed.gameWins[1 - slot]
      const outcome = team.outcome?.toLowerCase()
      if ((team.gameWins !== null && team.gameWins !== wins) || (outcome === 'win' && !won) || (outcome === 'loss' && won)
        || (series.bestOf !== null && series.bestOf !== 2 * Math.max(...observed.gameWins) - 1)) {
        throw new Error(`Worlds state contradicts the confirmed schedule score, winner or format for ${series.id}.`)
      }
    }
  }
}

/** Structural parsing precedes the format validators. It does not authenticate source evidence. */
export function isWorldsArtifact(value: unknown): value is WorldsArtifact {
  return record(value) && value.version === 1 && string(value.eventId) && string(value.feedEventKey)
    && ['synthetic-fixture', 'source-observation'].includes(String(value.dataMode))
    && (isWorlds2026Input(value.state) || isHistoricalInput(value.state))
}
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function string(value: unknown): value is string { return typeof value === 'string' }
function number(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }
function pair(value: unknown): value is [string, string] { return Array.isArray(value) && value.length === 2 && value.every(string) }
function score(value: unknown): value is [number, number] { return Array.isArray(value) && value.length === 2 && value.every(number) }
function evidence(value: unknown): value is ObservationEvidence {
  return record(value) && ['synthetic-fixture', 'source-observation'].includes(String(value.kind)) && string(value.reference)
}
function context(value: Record<string, unknown>) { return string(value.rulesId) && string(value.eventId) && string(value.stateVersion) && string(value.asOf) }
function result(value: unknown) {
  return record(value) && string(value.matchId) && pair(value.teamIds) && score(value.gameWins) && string(value.observedAt)
}
function swissEntrant(value: unknown): value is Worlds2026SwissEntrant {
  const seeds: readonly string[] = WORLDS_2026_SWISS_RULES.pools.flat()
  return record(value) && string(value.id) && string(value.region) && string(value.seed) && seeds.includes(value.seed)
}
function playInEntrant(value: unknown): value is PlayInEntrant {
  return record(value) && string(value.id) && ['CBLOL2', 'LCS3', 'LEC3', 'LCP3'].includes(String(value.seed))
}
function isPlayIn(value: unknown): value is Worlds2026PlayInInput {
  return record(value) && context(value) && Array.isArray(value.entrants) && value.entrants.every(playInEntrant)
    && Array.isArray(value.slots) && value.slots.every(string) && record(value.evidence)
    && evidence(value.evidence.entrants) && evidence(value.evidence.draw) && (value.evidence.results === undefined || evidence(value.evidence.results))
    && Array.isArray(value.results) && value.results.every((row) => record(row) && result(row)
      && ['r1-a', 'r1-b', 'r2-upper', 'r2-lower', 'r3', 'r4'].includes(String(row.slot)))
}
function isSwiss(value: unknown): value is Worlds2026SwissInput {
  return record(value) && context(value) && Array.isArray(value.entrants) && value.entrants.every(swissEntrant)
    && record(value.evidence) && evidence(value.evidence.entrants) && (value.evidence.results === undefined || evidence(value.evidence.results))
    && Array.isArray(value.rounds) && value.rounds.every((round) => record(round) && number(round.round)
      && Array.isArray(round.pairs) && round.pairs.every(pair) && string(round.drawnAt) && evidence(round.drawEvidence)
      && Array.isArray(round.rematchWaivers) && round.rematchWaivers.every((waiver) => record(waiver) && pair(waiver.teamIds) && evidence(waiver.evidence))
      && Array.isArray(round.results) && round.results.every((row) => record(row) && result(row) && number(row.slot)))
}
function isKnockout(value: unknown): value is Worlds2026KnockoutInput {
  return record(value) && context(value) && Array.isArray(value.qualifiers) && value.qualifiers.every((team) => record(team)
    && string(team.id) && team.swissWins === 3 && [0, 1, 2].includes(Number(team.swissLosses)) && number(team.swissLosses))
    && Array.isArray(value.slots) && value.slots.every(string) && record(value.evidence) && evidence(value.evidence.qualifiers)
    && evidence(value.evidence.draw) && (value.evidence.results === undefined || evidence(value.evidence.results))
    && Array.isArray(value.results) && value.results.every((row) => record(row) && result(row) && number(row.slot))
}
function isWorlds2026Input(value: unknown): value is Worlds2026EventInput {
  return record(value) && value.format === 'worlds-2026' && Array.isArray(value.directEntrants) && value.directEntrants.every(swissEntrant)
    && evidence(value.directEntrantEvidence) && Boolean(value.directEntrantEvidence.reference.trim())
    && isPlayIn(value.playIn) && (value.swiss === null || isSwiss(value.swiss)) && (value.knockout === null || isKnockout(value.knockout))
}
function isHistoricalInput(value: unknown): value is HistoricalWorldsInput {
  if (!record(value) || value.format !== 'worlds-2022-group' || !string(value.eventId) || !string(value.stateVersion) || !string(value.asOf) || !record(value.group)) return false
  const group = value.group
  return group.season === 2022 && string(group.groupId) && evidence(group.entrantEvidence) && evidence(group.gameEvidence)
    && Array.isArray(group.entrants) && group.entrants.every((team) => record(team) && string(team.id) && string(team.region)
      && ['A', 'B', 'C', 'play-in'].includes(String(team.pool)))
    && Array.isArray(group.games) && group.games.every((game) => record(game) && string(game.id) && string(game.teamAId) && string(game.teamBId) && string(game.winnerId))
}

function stateEvidence(state: WorldsJourneyInput): ObservationEvidence[] {
  if (state.format === 'worlds-2022-group') return [state.group.entrantEvidence!, state.group.gameEvidence!]
  const observations = [state.directEntrantEvidence, state.playIn.evidence.entrants, state.playIn.evidence.draw, state.playIn.evidence.results,
    state.swiss?.evidence.entrants, state.swiss?.evidence.results, state.knockout?.evidence.qualifiers, state.knockout?.evidence.draw, state.knockout?.evidence.results]
  for (const round of state.swiss?.rounds ?? []) observations.push(round.drawEvidence, ...round.rematchWaivers.map((waiver) => waiver.evidence))
  return observations.filter((entry): entry is ObservationEvidence => entry !== undefined)
}
