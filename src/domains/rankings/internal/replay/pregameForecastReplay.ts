import { compareCodeUnits } from '../../../../shared/codeUnitOrder.mjs'
import type { MatchRecord } from '../../types.ts'
import { deriveTeamProfilesFromMatches } from '../evidence/teamProfiles.ts'
import { createRatingReplayContext, prepareRatingUtcDateBoundary, replayRatingDates } from './model.ts'
import { emitPregamePredictionsForDate } from '../../../../lib/ratingSeriesEngine.ts'
import type { PlacementTournamentLifecycle } from './placementResiduals.ts'
import type { ExactPregameProbabilityState } from '../projections/pregameForecastTypes.ts'

export type PregameSeriesRequest = {
  seriesId: string
  eventId: string
  homeTeamId: string
  awayTeamId: string
  homeSourceTeam: string
  awaySourceTeam: string
  bestOf: 1 | 3 | 5
  scheduleRevision: string
  scheduledStartAt: number
  scheduleObservedAt: number
  scheduleProvider: 'lolesports-schedule' | 'leaguepedia-cargo' | 'oracles-elixir'
  asOf: number
  validUntil: number
  event: string
  patch: string
  season: number
  league: string
  region: MatchRecord['region']
  tier: MatchRecord['tier']
}

export type AvailableRankingGame = { match: MatchRecord; observedAt: number; resultAvailableAt: number | null }

export type AvailableTournamentLifecycle = { tournamentId: string; lifecycle: PlacementTournamentLifecycle; observedAt: number }

function availableLifecycles(evidence: readonly AvailableTournamentLifecycle[], asOf: number) {
  const selected = new Map<string, AvailableTournamentLifecycle>()
  for (const row of evidence) {
    if (!Number.isSafeInteger(row.observedAt) || row.observedAt < 0) throw new Error('Invalid tournament observation')
    if (row.observedAt <= asOf && row.observedAt >= (selected.get(row.tournamentId)?.observedAt ?? -1)) selected.set(row.tournamentId, row)
  }
  return [...selected.values()].sort((a, b) => compareCodeUnits(a.tournamentId, b.tournamentId))
}

type Availability = 'verified' | 'historical-limited'

function validateRequest(request: PregameSeriesRequest, availability: Availability) {
  if (!['lolesports-schedule', 'leaguepedia-cargo', 'oracles-elixir'].includes(request.scheduleProvider)
    || ![1, 3, 5].includes(request.bestOf) || !request.seriesId || !request.eventId
    || !request.homeTeamId || !request.awayTeamId || request.homeTeamId === request.awayTeamId
    || !request.homeSourceTeam || !request.awaySourceTeam || request.homeSourceTeam === request.awaySourceTeam
    || !request.scheduleRevision || !request.event || !request.league || !request.region || !request.tier
    || !Number.isInteger(request.season) || typeof request.patch !== 'string'
    || ![request.asOf, request.scheduledStartAt, request.scheduleObservedAt, request.validUntil].every(Number.isSafeInteger)
    || request.asOf >= request.validUntil || request.validUntil > request.scheduledStartAt
    || request.scheduleObservedAt < 0 || request.asOf < 0) throw new Error('Invalid explicit source identity or schedule')
  if (availability === 'verified' && request.scheduleObservedAt > request.asOf) throw new Error('Schedule unavailable at cutoff')
  return new Date(request.asOf).toISOString().slice(0, 10)
}

function validateInputs(inputs: readonly AvailableRankingGame[]) {
  for (const { match, observedAt, resultAvailableAt } of inputs) {
    if (!['oracles-elixir', 'leaguepedia-cargo'].includes(match.sourceProvider ?? '') || !match.sourceGameId
      || !/^\d{4}-\d{2}-\d{2}$/.test(match.date) || !Number.isSafeInteger(observedAt)
      || !Number.isFinite(Date.parse(match.date)) || new Date(match.date).toISOString().slice(0, 10) !== match.date
      || observedAt < 0 || (resultAvailableAt !== null && (!Number.isSafeInteger(resultAvailableAt) || resultAvailableAt < Date.parse(match.datetimeUtc ?? match.date) || resultAvailableAt > observedAt))) {
      throw new Error('Unsupported, seeded or missing source provenance')
    }
  }
}

function availableInputs(inputs: readonly AvailableRankingGame[], request: PregameSeriesRequest, cutoffDate: string, availability: Availability) {
  return inputs.filter(({ match, observedAt, resultAvailableAt }) => match.date < cutoffDate && (availability === 'historical-limited'
    ? resultAvailableAt === null || resultAvailableAt <= request.asOf
    : resultAvailableAt !== null && resultAvailableAt <= request.asOf && observedAt <= request.asOf))
}

function replayHistory(usable: readonly AvailableRankingGame[], lifecycles: readonly AvailableTournamentLifecycle[]) {
  if (!usable.length) throw new Error('No available prior-date ranking input')
  const matches = usable.map(row => row.match)
  if (new Set(matches.map(match => match.id)).size !== matches.length) throw new Error('Duplicate ranking input')
  const teams = deriveTeamProfilesFromMatches(matches)
  const context = createRatingReplayContext(matches, teams, { tournamentLifecycles: new Map(lifecycles.map(row => [row.tournamentId, row.lifecycle])) })
  const state = replayRatingDates({ context, replayMatches: matches })
  return { teams, state, usable, usedGameIds: matches.map(match => match.id).sort(),
    observedAt: [...new Set([...usable, ...lifecycles].map(row => row.observedAt))] }
}

function forecastFromHistory(history: ReturnType<typeof replayHistory>, request: PregameSeriesRequest, cutoffDate: string) {
  const { teams } = history
  const state = structuredClone(history.state)
  for (const team of [request.homeSourceTeam, request.awaySourceTeam]) {
    if (!teams[team] || !history.usable.some(({ match }) => match.teamA === team || match.teamB === team)) throw new Error(`No causal state for ${team}`)
  }
  const target: MatchRecord = {
    id: request.seriesId, sourceMatchId: request.seriesId, officialMatchId: request.seriesId,
    sourceProvider: 'leaguepedia-cargo', date: cutoffDate, season: request.season, event: request.event,
    league: request.league, region: request.region, tier: request.tier, phase: '', patch: request.patch,
    bestOf: request.bestOf, bestOfBasis: 'official', teamA: request.homeSourceTeam, teamB: request.awaySourceTeam,
    winner: '', teamAKills: 0, teamBKills: 0, teamAGold: 0, teamBGold: 0,
  }
  prepareRatingUtcDateBoundary({ dateMatches: [target], teams, state })
  let exact: ExactPregameProbabilityState | undefined
  emitPregamePredictionsForDate({ matches: [target], teams, state, pregamePlayerRatingEdges: new Map(), sideAdjustments: new Map(),
    onExactState: value => { exact = value } })
  if (!exact) throw new Error('Replay did not produce exact state')
  return { state: exact, sourceObservedAt: [...new Set([request.scheduleObservedAt, ...history.observedAt])].sort((a, b) => a - b),
    usedGameIds: [...history.usedGameIds] }
}

export function replayPregameSeriesState(inputs: readonly AvailableRankingGame[], request: PregameSeriesRequest, availability: Availability, lifecycles: readonly AvailableTournamentLifecycle[] = []) {
  const cutoffDate = validateRequest(request, availability)
  validateInputs(inputs)
  const history = replayHistory(availableInputs(inputs, request, cutoffDate, availability), availableLifecycles(lifecycles, request.asOf))
  return forecastFromHistory(history, request, cutoffDate)
}

export function replayPregameSeriesBatch(inputs: readonly AvailableRankingGame[], requests: readonly PregameSeriesRequest[], availability: Availability, lifecycles: readonly AvailableTournamentLifecycle[] = []) {
  const ordered = requests.map((request, index) => ({ request, index, cutoffDate: validateRequest(request, availability) }))
    .sort((a, b) => a.request.asOf - b.request.asOf || a.index - b.index)
  validateInputs(inputs)
  const results: ReturnType<typeof replayPregameSeriesState>[] = new Array(requests.length)
  let cached: { cutoffDate: string; lifecycleKey: string; history: ReturnType<typeof replayHistory> } | undefined
  let replayCount = 0
  let replayedGames = 0
  for (const { request, index, cutoffDate } of ordered) {
    const usable = availableInputs(inputs, request, cutoffDate, availability)
    const available = availableLifecycles(lifecycles, request.asOf)
    const lifecycleKey = JSON.stringify(available)
    if (!cached || cached.lifecycleKey !== lifecycleKey || cached.cutoffDate !== cutoffDate || cached.history.usable.length !== usable.length
      || usable.some((row, i) => row !== cached!.history.usable[i])) {
      cached = undefined
      const history = replayHistory(usable, available)
      cached = { cutoffDate, lifecycleKey, history }
      replayCount++
      replayedGames += history.state.processedMatchCount
    }
    results[index] = forecastFromHistory(cached.history, request, cutoffDate)
  }
  return { results, replayCount, replayedGames }
}
