import { compareCodeUnits } from '../../../../shared/codeUnitOrder.mjs'
import type { MatchRecord } from '../../types.ts'
import { canonicalSeriesForMatches } from '../evidence/seriesResolver.ts'
import { eventTierConfig } from '../policy/rankingConfig.ts'
import { predictPregameSeries } from '../projections/pregameForecast.ts'
import type { PregameForecastMetadata } from '../projections/pregameForecastTypes.ts'
import type { AvailableRankingGame, PregameSeriesRequest } from './pregameForecastReplay.ts'

export const simpleEloPolicy = {
  modelKind: 'simple-elo', candidateId: 'simple-elo-v1', initialRating: 1500, eloScale: 400,
  period: 'prior-date', completedSeriesOnly: true,
  tournamentK: Object.fromEntries(Object.entries(eventTierConfig).map(([tier, config]) => [tier, config.kFactor])),
  calibratorVersion: 'simple-elo-identity-v1', seriesConversionVersion: 'simple-elo-independent-series-v1',
} as const

type EloTeam = { team: string; rating: number; games: number }
export type SimpleEloState = { policy: 'prior-date'; throughDate: string; home: EloTeam; away: EloTeam; usedGameIds: string[] }

export function replaySimpleElo(matches: readonly MatchRecord[]) {
  const series = canonicalSeriesForMatches(matches)
  const teams = new Map<string, EloTeam>()
  const probabilities = new Map<string, number>()
  const usedGameIds: string[] = []
  let throughDate = ''
  const sorted = [...matches].sort((a, b) => compareCodeUnits(a.date, b.date) || compareCodeUnits(a.id, b.id))
  for (let start = 0; start < sorted.length;) {
    let end = start + 1
    while (end < sorted.length && sorted[end].date === sorted[start].date) end++
    const deltas = new Map<string, { rating: number; games: number }>()
    for (const match of sorted.slice(start, end)) {
      const a = teams.get(match.teamA)?.rating ?? simpleEloPolicy.initialRating
      const b = teams.get(match.teamB)?.rating ?? simpleEloPolicy.initialRating
      const p = 1 / (1 + 10 ** ((b - a) / simpleEloPolicy.eloScale))
      probabilities.set(match.id, p)
      if (series.get(match.id)?.state !== 'completed') continue
      const delta = eventTierConfig[match.tier].kFactor * (Number(match.winner === match.teamA) - p)
      for (const [team, change] of [[match.teamA, delta], [match.teamB, -delta]] as const) {
        const previous = deltas.get(team) ?? { rating: 0, games: 0 }
        deltas.set(team, { rating: previous.rating + change, games: previous.games + 1 })
      }
      usedGameIds.push(match.id)
      throughDate = match.date
    }
    for (const [team, delta] of deltas) {
      const previous = teams.get(team) ?? { team, rating: simpleEloPolicy.initialRating, games: 0 }
      teams.set(team, { team, rating: previous.rating + delta.rating, games: previous.games + delta.games })
    }
    start = end
  }
  return { teams, probabilities, throughDate, usedGameIds: usedGameIds.sort(compareCodeUnits) }
}

type Availability = 'verified' | 'historical-limited'

function validateRequest(request: PregameSeriesRequest, availability: Availability) {
  if (!['lolesports-schedule', 'leaguepedia-cargo', 'oracles-elixir'].includes(request.scheduleProvider)
    || ![1, 3, 5].includes(request.bestOf) || !request.seriesId || !request.eventId
    || !request.homeTeamId || !request.awayTeamId || request.homeTeamId === request.awayTeamId
    || !request.homeSourceTeam || !request.awaySourceTeam || request.homeSourceTeam === request.awaySourceTeam
    || !request.scheduleRevision || ![request.asOf, request.scheduleObservedAt, request.scheduledStartAt, request.validUntil]
      .every(t => Number.isSafeInteger(t) && t >= 0)
    || request.asOf >= request.validUntil || request.validUntil > request.scheduledStartAt
    || (availability === 'verified' && request.scheduleObservedAt > request.asOf)) throw new Error('Invalid explicit Elo source identity or schedule')
  return new Date(request.asOf).toISOString().slice(0, 10)
}

function validateInputs(inputs: readonly AvailableRankingGame[]) {
  if (new Set(inputs.map(row => row.match.id)).size !== inputs.length) throw new Error('Duplicate Elo input')
  for (const { match, observedAt, resultAvailableAt } of inputs) {
    if (!['oracles-elixir', 'leaguepedia-cargo'].includes(match.sourceProvider ?? '') || !match.sourceGameId
      || !/^\d{4}-\d{2}-\d{2}$/.test(match.date) || !Number.isFinite(Date.parse(match.date))
      || new Date(match.date).toISOString().slice(0, 10) !== match.date
      || !Number.isSafeInteger(observedAt) || observedAt < 0
      || (resultAvailableAt !== null && (!Number.isSafeInteger(resultAvailableAt)
        || resultAvailableAt < Date.parse(match.datetimeUtc ?? match.date) || resultAvailableAt > observedAt))) {
      throw new Error('Missing or invalid Elo source provenance')
    }
  }
}

function forecastFromHistory(replay: ReturnType<typeof replaySimpleElo>, usable: readonly AvailableRankingGame[], request: PregameSeriesRequest) {
  const home = replay.teams.get(request.homeSourceTeam)
  const away = replay.teams.get(request.awaySourceTeam)
  if (!home || !away) throw new Error('No completed causal Elo history for requested teams')
  const state: SimpleEloState = { policy: 'prior-date', throughDate: replay.throughDate, home: { ...home }, away: { ...away }, usedGameIds: [...replay.usedGameIds] }
  const used = new Set(state.usedGameIds)
  return { state, usedGameIds: state.usedGameIds, sourceObservedAt: [...new Set([request.scheduleObservedAt,
    ...usable.filter(row => used.has(row.match.id)).map(row => row.observedAt)])].sort((a, b) => a - b) }
}

export function replaySimpleEloSeries(inputs: readonly AvailableRankingGame[], request: PregameSeriesRequest, availability: Availability) {
  return replaySimpleEloSeriesBatch(inputs, [request], availability).results[0]
}

export function replaySimpleEloSeriesBatch(inputs: readonly AvailableRankingGame[], requests: readonly PregameSeriesRequest[], availability: Availability) {
  const ordered = requests.map((request, index) => ({ request, index, cutoffDate: validateRequest(request, availability) }))
    .sort((a, b) => a.request.asOf - b.request.asOf || a.index - b.index)
  validateInputs(inputs)
  const results: ReturnType<typeof forecastFromHistory>[] = new Array(requests.length)
  let cached: { cutoffDate: string; usable: AvailableRankingGame[]; replay: ReturnType<typeof replaySimpleElo> } | undefined
  let replayCount = 0
  let replayedGames = 0
  for (const { request, index, cutoffDate } of ordered) {
    const usable = inputs.filter(({ match, observedAt, resultAvailableAt }) => match.date < cutoffDate
      && (availability === 'verified' ? resultAvailableAt !== null && resultAvailableAt <= request.asOf && observedAt <= request.asOf
        : resultAvailableAt === null || resultAvailableAt <= request.asOf))
    if (!cached || cached.cutoffDate !== cutoffDate || cached.usable.length !== usable.length
      || usable.some((row, i) => row !== cached!.usable[i])) {
      cached = { cutoffDate, usable, replay: replaySimpleElo(usable.map(row => row.match)) }
      replayCount++
      replayedGames += usable.length
    }
    results[index] = forecastFromHistory(cached.replay, usable, request)
  }
  return { results, replayCount, replayedGames }
}

export function predictSimpleEloSeries(state: SimpleEloState, metadata: PregameForecastMetadata) {
  if (metadata.candidateId !== simpleEloPolicy.candidateId || metadata.parentCandidateId !== null || metadata.calibrationFit !== null) throw new Error('Invalid simple Elo control identity')
  const receipt = predictPregameSeries({
    state: { ...state, precision: 'full', home: { ...state.home, uncertainty: 0 }, away: { ...state.away, uncertainty: 0 } },
    metadata, transform: { temperature: 1, dependence: 0, calibrationOrder: 'game-before-series' },
    probabilityCalibration: { eloScale: simpleEloPolicy.eloScale, uncertaintyScale: 1, uncertaintyFloor: 1 },
  })
  return { ...receipt, modelKind: 'simple-elo' as const, calibratorVersion: simpleEloPolicy.calibratorVersion, seriesConversionVersion: simpleEloPolicy.seriesConversionVersion }
}
