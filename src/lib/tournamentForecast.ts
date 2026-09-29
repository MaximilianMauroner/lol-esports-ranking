import type { ModelInfo } from './snapshot'
import type { PublicRankingShard, PublicTeamStanding } from './publicArtifacts/schema'
import { ratingScaleFromUnknown } from './ratingCalculations'
import { estimatePublicMatchup, type PublicMatchupSideAssumption } from './publicMatchup'
import { DEFAULT_BLUE_SIDE_RATING_EDGE, seriesSwingStateProbability } from './matchupMath'
import { normalizeStatus, type TournamentSeries } from './tournamentFeed'

/** An explicit, reviewed crosswalk. Source names and display codes are never join keys. */
export type TournamentTeamIdentityMap = {
  version: 1
  source: 'lolesports-persisted-site-api'
  revision: string
  mappings: Array<{ sourceTeamId: string; teamId: string }>
}

export type ForecastBasis = {
  snapshotId: string
  ratingDataAsOf: string
  ratingPublishedAt: string
  dataMode: 'scheduled-public-data' | 'seeded-sample' | 'no-data'
  model: ModelInfo
  snapshot: PublicRankingShard
  identityMap: TournamentTeamIdentityMap
}

export type ForecastUnavailableReason =
  | 'unsupported-format' | 'missing-team-id' | 'unmapped-team' | 'ambiguous-identity'
  | 'missing-rating' | 'missing-model' | 'missing-rating-scale' | 'stale-model-basis'
  | 'not-upcoming' | 'already-started' | 'invalid-time' | 'invalid-score' | 'no-prestart-receipt'

export type ForecastUnavailable = { status: 'unavailable'; reason: ForecastUnavailableReason; detail: string }
export type ForecastReady = {
  status: 'ready'
  matchId: string
  eventId: string
  bestOf: 1 | 3 | 5
  sideAssumption: PublicMatchupSideAssumption
  sideBasis: string
  blueSideRatingEdge: number
  teams: [ForecastTeamInput, ForecastTeamInput]
  homeGameWinProbability: number
  awayGameWinProbability: number
  homeSeriesWinProbability: number
  awaySeriesWinProbability: number
  modelVersion: string
  modelConfigHash: string
  snapshotId: string
  ratingDataAsOf: string
  ratingPublishedAt: string
  identityRevision: string
  dataMode: ForecastBasis['dataMode']
  warnings: string[]
}
export type ForecastTeamInput = {
  sourceTeamId: string
  teamId: string
  name: string
  rating: number
  uncertainty: number
  rosterBasis: PublicTeamStanding['rosterBasis']
}
export type TournamentForecast = ForecastReady | ForecastUnavailable

export function isTournamentTeamIdentityMap(value: unknown): value is TournamentTeamIdentityMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const map = value as Partial<TournamentTeamIdentityMap>
  return map.version === 1 && map.source === 'lolesports-persisted-site-api'
    && typeof map.revision === 'string' && map.revision.length > 0
    && Array.isArray(map.mappings) && map.mappings.every((entry) =>
      Boolean(entry && typeof entry.sourceTeamId === 'string' && entry.sourceTeamId.length
        && typeof entry.teamId === 'string' && entry.teamId.length))
    && new Set(map.mappings.map((entry) => entry.sourceTeamId)).size === map.mappings.length
}

export function forecastTournamentSeries(
  series: TournamentSeries,
  basis: ForecastBasis,
  options: { sideAssumption?: PublicMatchupSideAssumption; sideBasis?: string; blueSideRatingEdge?: number } = {},
): TournamentForecast {
  if (series.status !== 'upcoming' || normalizeStatus(series.sourceState) !== 'upcoming') return unavailable('not-upcoming', 'Only a source-upcoming series can receive a new pre-match forecast.')
  if (!noCompletedGameEvidence(series)) return unavailable('already-started', 'The upcoming source row already contains played-game or result evidence.')
  if (series.bestOf !== 1 && series.bestOf !== 3 && series.bestOf !== 5) return unavailable('unsupported-format', 'Only decisive Bo1, Bo3 and Bo5 are supported; tie-capable or unknown formats need reviewed rules.')
  if (series.teams.length !== 2 || series.teams.some((team) => !team.id)) return unavailable('missing-team-id', 'Both source team IDs must be known.')
  if (!isTournamentTeamIdentityMap(basis.identityMap)) return unavailable('ambiguous-identity', 'A valid, explicit source-to-ranking team ID crosswalk is required.')
  if (!basis.model?.version || !basis.model.configHash || basis.model.version.startsWith('unknown') || basis.model.configHash.startsWith('unknown')) return unavailable('missing-model', 'The published model version and configuration hash are required.')
  const parameters = basis.model.parameters as Record<string, unknown> | null
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)
    || !positive(parameters.winProbabilityEloScale) || !positive(parameters.winProbabilityUncertaintyScale)
    || typeof parameters.winProbabilityUncertaintyFloor !== 'number' || !Number.isFinite(parameters.winProbabilityUncertaintyFloor)
    || parameters.winProbabilityUncertaintyFloor < 0 || parameters.winProbabilityUncertaintyFloor > 1) {
    return unavailable('missing-model', 'The published probability calibration parameters are required.')
  }
  if (!ratingScaleFromUnknown(basis.model.ratingScale) || !ratingScaleFromUnknown(basis.snapshot.ratingScale)) return unavailable('missing-rating-scale', 'The published rating scale is required.')
  if (basis.snapshot.modelVersion !== basis.model.version || basis.snapshot.modelConfigHash !== basis.model.configHash
    || JSON.stringify(basis.snapshot.ratingScale) !== JSON.stringify(basis.model.ratingScale)) {
    return unavailable('stale-model-basis', 'The chosen snapshot and model metadata disagree.')
  }
  if (!basis.snapshotId || !validTime(basis.ratingDataAsOf) || !validTime(basis.ratingPublishedAt)) return unavailable('stale-model-basis', 'A dated, identified current rating snapshot is required.')
  const sideAssumption = options.sideAssumption ?? 'neutral'
  if (sideAssumption !== 'neutral' && (series.bestOf !== 1 || !options.sideBasis)) return unavailable('unsupported-format', 'Sourced side selection is supported for Bo1 only; series side rotation is unknown.')
  const blueSideRatingEdge = options.blueSideRatingEdge ?? DEFAULT_BLUE_SIDE_RATING_EDGE
  if (!Number.isFinite(blueSideRatingEdge) || blueSideRatingEdge < 0) return unavailable('missing-model', 'A valid side rating edge is required.')
  const mapped = series.teams.map((team) => basis.identityMap.mappings.find((entry) => entry.sourceTeamId === team.id)?.teamId)
  if (mapped.some((id) => !id)) return unavailable('unmapped-team', 'A source team ID has no verified ranking identity mapping.')
  if (mapped[0] === mapped[1]) return unavailable('ambiguous-identity', 'Both source slots map to the same ranking team.')
  const standings = mapped.map((id) => basis.snapshot.standings.filter((entry) => entry.teamId === id))
  if (standings.some((matches) => matches.length !== 1)) return unavailable('ambiguous-identity', 'Each mapped team must have exactly one row in the chosen current snapshot.')
  const [home, away] = standings.map((matches) => matches[0]!) as [PublicTeamStanding, PublicTeamStanding]
  if ([home, away].some((standing) => !Number.isFinite(standing.rating) || !Number.isFinite(standing.uncertainty)
    || standing.uncertainty < 0 || !standing.rosterBasis)) return unavailable('missing-rating', 'Published ratings, uncertainty and roster basis are required for both teams.')
  const estimate = estimatePublicMatchup(home, away, basis.model, { bestOf: series.bestOf, sideAssumption, blueSideRatingEdge })
  const warnings: string[] = []
  if (basis.dataMode !== 'scheduled-public-data') warnings.push('Ratings are seeded or unavailable sample data, not official LoL Esports rankings.')
  for (const standing of [home, away]) {
    if (!standing.eligibility?.eligible || standing.wins + standing.losses < 10) warnings.push(`${standing.team} has sparse or provisional model evidence.`)
  }
  return {
    status: 'ready', matchId: series.id, eventId: series.eventId, bestOf: series.bestOf,
    sideAssumption, sideBasis: options.sideBasis ?? 'Neutral side; no sourced side-selection policy.', blueSideRatingEdge,
    teams: [home, away].map((standing, index) => ({
      sourceTeamId: series.teams[index]!.id!, teamId: standing.teamId, name: standing.team,
      rating: standing.rating, uncertainty: standing.uncertainty, rosterBasis: standing.rosterBasis,
    })) as ForecastReady['teams'],
    homeGameWinProbability: estimate.homeGameWinProbability, awayGameWinProbability: estimate.awayGameWinProbability,
    homeSeriesWinProbability: estimate.homeSeriesWinProbability, awaySeriesWinProbability: estimate.awaySeriesWinProbability,
    modelVersion: basis.model.version, modelConfigHash: basis.model.configHash,
    snapshotId: basis.snapshotId, ratingDataAsOf: basis.ratingDataAsOf, ratingPublishedAt: basis.ratingPublishedAt,
    identityRevision: basis.identityMap.revision, dataMode: basis.dataMode, warnings,
  }
}

export type ForecastReceipt = Readonly<ForecastReady & {
  receiptKey: string
  eventStateVersion: string
  forecastRevision: string
  generatedAt: string
  publishedAt: string
  sourceObservedAt: string
  scheduledStartAt: string
  evaluationEligible: false
}>
export type ForecastLedger = Readonly<{
  version: 1
  receipts: Readonly<Record<string, ForecastReceipt>>
  pinned: Readonly<Record<string, string>>
}>
export const emptyForecastLedger: ForecastLedger = { version: 1, receipts: {}, pinned: {} }

export function isForecastLedger(value: unknown): value is ForecastLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ledger = value as Partial<ForecastLedger>
  if (ledger.version !== 1 || !ledger.receipts || !ledger.pinned
    || typeof ledger.receipts !== 'object' || Array.isArray(ledger.receipts)
    || typeof ledger.pinned !== 'object' || Array.isArray(ledger.pinned)) return false
  for (const [key, candidate] of Object.entries(ledger.receipts)) {
    const receipt = candidate as ForecastReceipt
    if (!receipt || receipt.status !== 'ready' || receipt.receiptKey !== key
      || !nonemptyString(receipt.matchId) || !nonemptyString(receipt.eventId)
      || !nonemptyString(receipt.eventStateVersion) || !nonemptyString(receipt.forecastRevision)
      || !validTime(receipt.generatedAt) || !validTime(receipt.publishedAt) || !validTime(receipt.sourceObservedAt)
      || !validTime(receipt.scheduledStartAt)
      || Date.parse(receipt.publishedAt) >= Date.parse(receipt.scheduledStartAt)
      || Date.parse(receipt.generatedAt) > Date.parse(receipt.publishedAt)
      || Date.parse(receipt.sourceObservedAt) > Date.parse(receipt.publishedAt)
      || !Array.isArray(receipt.teams) || receipt.teams.length !== 2
      || !receipt.teams.every((team) => team && typeof team.sourceTeamId === 'string' && team.sourceTeamId
        && typeof team.teamId === 'string' && team.teamId && typeof team.name === 'string'
        && Number.isFinite(team.rating) && Number.isFinite(team.uncertainty) && team.uncertainty >= 0
        && typeof team.rosterBasis === 'string')
      || ![1, 3, 5].includes(receipt.bestOf) || !nonemptyString(receipt.modelVersion)
      || !nonemptyString(receipt.modelConfigHash) || !nonemptyString(receipt.snapshotId)
      || !validTime(receipt.ratingDataAsOf) || !validTime(receipt.ratingPublishedAt)
      || typeof receipt.sideBasis !== 'string' || !['neutral', 'home-blue', 'home-red'].includes(receipt.sideAssumption)
      || !Number.isFinite(receipt.blueSideRatingEdge) || receipt.blueSideRatingEdge < 0
      || (receipt.sideAssumption !== 'neutral' && receipt.bestOf !== 1)
      || !nonemptyString(receipt.identityRevision) || !['scheduled-public-data', 'seeded-sample', 'no-data'].includes(receipt.dataMode)
      || !Array.isArray(receipt.warnings) || !receipt.warnings.every((warning) => typeof warning === 'string')
      || Date.parse(receipt.ratingDataAsOf) > Date.parse(receipt.publishedAt)
      || Date.parse(receipt.ratingPublishedAt) > Date.parse(receipt.publishedAt)
      || Date.parse(receipt.ratingPublishedAt) > Date.parse(receipt.generatedAt)
      || Date.parse(receipt.ratingDataAsOf) > Date.parse(receipt.generatedAt)
      || Date.parse(receipt.sourceObservedAt) > Date.parse(receipt.generatedAt)
      || !probability(receipt.homeGameWinProbability) || !probability(receipt.awayGameWinProbability)
      || !probability(receipt.homeSeriesWinProbability) || !probability(receipt.awaySeriesWinProbability)
      || Math.abs(receipt.homeGameWinProbability + receipt.awayGameWinProbability - 1) > 0.0002
      || Math.abs(receipt.homeSeriesWinProbability + receipt.awaySeriesWinProbability - 1) > 0.0002
      || receipt.evaluationEligible !== false || !receiptSourceStateMatches(receipt)) return false
  }
  return Object.entries(ledger.pinned).every(([matchId, key]) =>
    typeof key === 'string' && ledger.receipts?.[key]?.matchId === matchId)
}

/** The full source state is the version key; no lossy or collision-prone display-name hash. */
export function tournamentEventStateVersion(series: TournamentSeries): string {
  return JSON.stringify([series.id, series.eventId, series.startTime, series.status, series.sourceState,
    series.bestOf, series.teams.map((team) => [team.id, team.gameWins, team.outcome])])
}

export function createPreMatchReceipt(input: {
  series: TournamentSeries; basis: ForecastBasis; options?: Parameters<typeof forecastTournamentSeries>[2]; forecastRevision: string
  generatedAt: string; publishedAt: string; observedAt: string
}): ForecastReceipt | ForecastUnavailable {
  const { series, basis, options, forecastRevision, generatedAt, publishedAt, observedAt } = input
  const forecast = forecastTournamentSeries(series, basis, options)
  if (forecast.status !== 'ready') return forecast
  if (!forecastRevision) return unavailable('stale-model-basis', 'A forecast revision is required.')
  if (!validTime(series.startTime) || !validTime(generatedAt) || !validTime(publishedAt) || !validTime(observedAt)) return unavailable('invalid-time', 'A valid scheduled start, observation, generation and publication time are required.')
  if (series.status !== 'upcoming' || normalizeStatus(series.sourceState) !== 'upcoming' || !noCompletedGameEvidence(series)
    || Date.parse(publishedAt) >= Date.parse(series.startTime!) || Date.parse(observedAt) > Date.parse(publishedAt)
    || Date.parse(generatedAt) > Date.parse(publishedAt) || Date.parse(forecast.ratingPublishedAt) > Date.parse(publishedAt)
    || Date.parse(forecast.ratingDataAsOf) > Date.parse(publishedAt)
    || Date.parse(observedAt) > Date.parse(generatedAt)
    || Date.parse(forecast.ratingPublishedAt) > Date.parse(generatedAt)
    || Date.parse(forecast.ratingDataAsOf) > Date.parse(generatedAt)) {
    return unavailable('already-started', 'Only a genuinely published, source-upcoming forecast before the scheduled start is eligible as pre-match.')
  }
  const eventStateVersion = tournamentEventStateVersion(series)
  const receiptKey = JSON.stringify([series.id, eventStateVersion, forecastRevision])
  return structuredClone({ ...forecast, receiptKey, eventStateVersion, forecastRevision, generatedAt, publishedAt, sourceObservedAt: observedAt,
    scheduledStartAt: series.startTime!,
    evaluationEligible: false as const })
}

export function appendForecastReceipt(ledger: ForecastLedger, receipt: ForecastReceipt): ForecastLedger {
  const prior = ledger.receipts[receipt.receiptKey]
  if (prior) {
    if (JSON.stringify(prior) !== JSON.stringify(receipt)) throw new Error('Forecast receipt key already exists with different content')
    return ledger
  }
  return { ...ledger, receipts: { ...ledger.receipts, [receipt.receiptKey]: structuredClone(receipt) } }
}

/** Pin once when a source series leaves upcoming; later rating or source corrections cannot rewrite history. */
export function pinPreMatchReceipt(ledger: ForecastLedger, series: TournamentSeries, firstStartedObservedAt: string): ForecastLedger {
  const sourceStatus = normalizeStatus(series.sourceState)
  if (ledger.pinned[series.id] || (series.status !== 'live' && series.status !== 'completed')
    || (sourceStatus !== 'live' && sourceStatus !== 'completed') || !validTime(firstStartedObservedAt)) return ledger
  const eligible = Object.values(ledger.receipts).filter((receipt) => receipt.matchId === series.id
    && sameSeriesBasis(receipt, series)
    && Date.parse(receipt.publishedAt) < Math.min(Date.parse(receipt.scheduledStartAt), Date.parse(firstStartedObservedAt)))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
      || b.forecastRevision.localeCompare(a.forecastRevision) || b.receiptKey.localeCompare(a.receiptKey))
  return eligible[0] ? { ...ledger, pinned: { ...ledger.pinned, [series.id]: eligible[0].receiptKey } } : ledger
}

export function pinnedForecast(ledger: ForecastLedger, series: TournamentSeries): ForecastReceipt | ForecastUnavailable {
  const key = ledger.pinned[series.id]
  const receipt = key && ledger.receipts[key]
  if (!receipt) return unavailable('no-prestart-receipt', 'No published pre-start forecast receipt exists for this series.')
  return sameSeriesBasis(receipt, series) ? receipt
    : unavailable('stale-model-basis', 'The source participants, event or format changed after the pre-match receipt was pinned.')
}

export function scoreConditionedSeriesOdds(receipt: ForecastReceipt, series: TournamentSeries):
  | { status: 'ready'; homeSeriesWinProbability: number; awaySeriesWinProbability: number; label: 'score-conditioned' }
  | ForecastUnavailable {
  if (!sameSeriesBasis(receipt, series)) {
    return unavailable('stale-model-basis', 'The live series identity or format differs from the pinned pre-series basis.')
  }
  if (series.status !== 'live' && series.status !== 'completed') return unavailable('not-upcoming', 'Score-conditioned odds require live or completed source state.')
  const [homeWins, awayWins] = series.teams.map((team) => team.gameWins)
  if (homeWins === null || awayWins === null || homeWins === undefined || awayWins === undefined) return unavailable('invalid-score', 'A validated completed-game score is required.')
  const outcomes = series.teams.map((team) => team.outcome?.trim().toLowerCase() ?? '')
  if (outcomes.some(Boolean)) {
    const winsNeeded = Math.floor(receipt.bestOf / 2) + 1
    const winner = homeWins >= winsNeeded ? 0 : awayWins >= winsNeeded ? 1 : null
    if (winner === null || outcomes[winner] !== 'win' || outcomes[1 - winner] !== 'loss') {
      return unavailable('invalid-score', 'Source outcome and completed-game score disagree.')
    }
  }
  try {
    if (receipt.bestOf === 1) {
      if (!Number.isInteger(homeWins) || !Number.isInteger(awayWins)
        || !((homeWins === 1 && awayWins === 0) || (homeWins === 0 && awayWins === 1))) throw new Error('Invalid Bo1 score')
      return { status: 'ready', homeSeriesWinProbability: homeWins, awaySeriesWinProbability: awayWins, label: 'score-conditioned' }
    }
    const odds = seriesSwingStateProbability({ bestOf: receipt.bestOf, teamAWins: homeWins, teamBWins: awayWins,
      teamAGameWinProbability: receipt.homeGameWinProbability })
    if (series.status === 'completed' && !odds.terminal) throw new Error('Incomplete completed series')
    return { status: 'ready', homeSeriesWinProbability: odds.teamASeriesWinProbability,
      awaySeriesWinProbability: odds.teamBSeriesWinProbability, label: 'score-conditioned' }
  } catch {
    return unavailable('invalid-score', 'The source score is impossible for the frozen decisive series format.')
  }
}

function validTime(value: string | null | undefined): value is string { return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value)) }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0 }
function probability(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 }
function nonemptyString(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function sameSeriesBasis(receipt: ForecastReceipt, series: TournamentSeries) {
  return receipt.matchId === series.id && receipt.eventId === series.eventId && receipt.bestOf === series.bestOf
    && series.teams.length === 2 && series.teams[0]?.id === receipt.teams[0].sourceTeamId
    && series.teams[1]?.id === receipt.teams[1].sourceTeamId
    && validTime(series.startTime) && Date.parse(receipt.publishedAt) < Date.parse(series.startTime)
}
function noCompletedGameEvidence(series: TournamentSeries) {
  return series.teams.every((team) => (team.gameWins === null || team.gameWins === 0)
    && (team.outcome === null || team.outcome.trim() === ''))
}
function receiptSourceStateMatches(receipt: ForecastReceipt) {
  try {
    const key: unknown = JSON.parse(receipt.receiptKey)
    const state: unknown = JSON.parse(receipt.eventStateVersion)
    if (!Array.isArray(key) || key.length !== 3 || key[0] !== receipt.matchId
      || key[1] !== receipt.eventStateVersion || key[2] !== receipt.forecastRevision
      || !Array.isArray(state) || state.length !== 7 || state[0] !== receipt.matchId
      || state[1] !== receipt.eventId || state[2] !== receipt.scheduledStartAt
      || state[3] !== 'upcoming' || typeof state[4] !== 'string' || normalizeStatus(state[4]) !== 'upcoming'
      || state[5] !== receipt.bestOf || !Array.isArray(state[6]) || state[6].length !== 2) return false
    return state[6].every((team: unknown, index: number) => Array.isArray(team) && team[0] === receipt.teams[index]?.sourceTeamId
      && (team[1] === null || team[1] === 0) && (team[2] === null || team[2] === ''))
  } catch { return false }
}
function unavailable(reason: ForecastUnavailableReason, detail: string): ForecastUnavailable { return { status: 'unavailable', reason, detail } }
