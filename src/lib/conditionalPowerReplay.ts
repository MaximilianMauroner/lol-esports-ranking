import type { EventTier, MatchRecord, MatchRosterSnapshot, PublishedRatingScale, Region } from '../types'
import { eventTierConfig } from '../data/rankingConfig'
import { digestCausalValue } from './causalRecompute'
import { conditionalOutcomeProblem, unavailablePowerPreview, type ConditionalSeriesOutcome, type PowerPreviewUnavailable } from './conditionalPowerPreview'
import { eventKFactorForMatch, eventWeightContextForMatches, eventWeightForMatch } from './eventWeighting'
import { homeLeagueForMatch } from './matchContext'
import { materializeRankingModel, replayRatingDates, type RatingReplayContext } from './model'
import { transparentGprModelMetadata } from './modelConfig'
import { playerModelParameters, type PregamePlayerRatingEdge } from './playerModel'
import { publishedRating } from './publishedRatingArtifacts'
import { ratingScaleFromUnknown } from './ratingCalculations'
import { decodeRatingCheckpointValue, encodeRatingCheckpointEnvelope } from './ratingCheckpoint'
import { buildRatingCheckpointEventContract, ratingCheckpointInventory, validateRatingCheckpointEventContract } from './ratingCheckpointInventory'
import type { RatingRunState } from './ratingRunState'
import { rosterBasisByTeam, rosterFingerprint } from './rosters'
import { canonicalSeriesOutcomeForTeam, resolveCanonicalSeries } from './seriesResolver'
import type { TournamentSeries } from './tournamentFeed'

/** Internal, offline inputs. This is not a new public artifact or a publication API. */
export type ConditionalPowerReplayBasis = {
  modelVersion: string
  modelConfigHash: string
  /** JSON corpus identity, production state payload digest and complete replay-context digest. */
  preStateId: string
  ratingScale: PublishedRatingScale
  context: RatingReplayContext
  state: RatingRunState
  sourceTeamIds: [string, string]
  teamNames: [string, string]
  event: { id: string; name: string; league: string; phase: string; tier: EventTier; region: Region }
}

type ReplayInput = {
  series: TournamentSeries
  outcome: ConditionalSeriesOutcome
  now: number
  basis: ConditionalPowerReplayBasis | null
  games: readonly MatchRecord[] | null
  playerEdges: ReadonlyMap<string, PregamePlayerRatingEdge> | null
}

export type ConditionalPowerReplay = PowerPreviewUnavailable | {
  status: 'ready'
  hypothetical: true
  teams: Array<{ team: string; before: number; after: number; delta: number }>
  provenance: {
    modelVersion: string; modelConfigHash: string; preStateId: string
    ratingScale: PublishedRatingScale; matchId: string; eventId: string; canonicalSeriesId: string
    bestOf: number; outcome: ConditionalSeriesOutcome; ratingDataAsOf: string
    eventK: number; eventWeight: number
  }
  assumptions: string[]
  pinnedInputs: ReplayInput
}

/** Runs only on clones. The caller supplies every hypothetical game input; no statistics are synthesized. */
export function evaluateConditionalPowerReplay(input: ReplayInput): ConditionalPowerReplay {
  if (!nonemptyString(input.series.id) || !nonemptyString(input.series.eventId)
    || input.series.teams.some((team) => !nonemptyString(team.id))) {
    return unavailablePowerPreview('missing-series-identity', 'Nonempty source series, event and participant identities are required for a conditional replay.')
  }
  const problem = conditionalOutcomeProblem(input.series, input.outcome, input.now)
  if (problem) return problem
  if (!input.basis) return unavailablePowerPreview('missing-pre-state', 'A pinned internal pre-series state is required; public Power and forecast receipts are insufficient.')
  try {
    const basis = structuredClone(input.basis)
    const basisProblem = conditionalPowerBasisProblem(basis)
    if (basisProblem) return basisProblem
    if (basis.event.id !== input.series.eventId || basis.sourceTeamIds.some((id, index) => id !== input.series.teams[index]?.id)) {
      return unavailablePowerPreview('identity-mismatch', 'The pinned event and source participants must match the upcoming series.')
    }
    if (!input.games?.length || !input.playerEdges) return unavailablePowerPreview('missing-future-inputs', 'Complete hypothetical game inputs and explicit player prior edges are required.')
    const games = structuredClone([...input.games])
    const playerEdges = new Map(structuredClone([...input.playerEdges]))
    const invalid = scenarioProblem(input, basis, games, playerEdges)
    if (invalid) return invalid
    // Production sorts timestamp strings. Normalize detached rows so their order follows the validated instants.
    for (const game of games) game.datetimeUtc = new Date(Date.parse(game.datetimeUtc!)).toISOString()
    const identityProblem = reusedReplayIdentityProblem(input.series.id, basis.context.authoritativeMatches, games)
    if (identityProblem) return identityProblem
    const before = materializeRankingModel({ context: basis.context, state: structuredClone(basis.state) })
    const context: RatingReplayContext = {
      ...basis.context,
      authoritativeMatches: [...basis.context.authoritativeMatches, ...games],
      lastDate: games[0]!.date,
      pregamePlayerRatingEdges: new Map([...basis.context.pregamePlayerRatingEdges, ...playerEdges]),
      teamRosterBasis: rosterBasisByTeam([...basis.context.authoritativeMatches, ...games]),
    }
    const state = replayRatingDates({ context, state: structuredClone(basis.state), replayMatches: games })
    const after = materializeRankingModel({ context, state })
    const teams = basis.teamNames.map((team) => {
      const previous = before.standings.find((row) => row.team === team)
      const next = after.standings.find((row) => row.team === team)
      if (!previous || !next || !Number.isFinite(previous.rating) || !Number.isFinite(next.rating)) throw new Error('Participant projection is unavailable')
      const beforePower = publishedRating(previous.rating, basis.ratingScale)
      const afterPower = publishedRating(next.rating, basis.ratingScale)
      return { team, before: beforePower, after: afterPower, delta: afterPower - beforePower }
    })
    return {
      status: 'ready', hypothetical: true, teams,
      provenance: {
        modelVersion: basis.modelVersion, modelConfigHash: basis.modelConfigHash, preStateId: basis.preStateId,
        ratingScale: basis.ratingScale, matchId: input.series.id, eventId: input.series.eventId,
        canonicalSeriesId: resolveCanonicalSeries(games)[0]!.id, bestOf: input.series.bestOf!, outcome: structuredClone(input.outcome),
        ratingDataAsOf: basis.context.lastDate,
        eventK: eventKFactorForMatch(games.at(-1)!, basis.state.eventWeightContext),
        eventWeight: eventWeightForMatch(games.at(-1)!, basis.state.eventWeightContext),
      },
      assumptions: [
        'Hypothetical calculation, not a published forecast or an actual rating impact.',
        'Supplied lineups, patch, sides, game order, time, statistics and player prior edges are held fixed.',
        'The pinned event context and lifecycle are held fixed; this series is the only new evidence on its UTC date.',
        'Uses one production series result update and the full standing projection in public Power points.',
        'Other future series, changed model inputs and future tournament placements are not predicted. Tournament simulations retain frozen strength.',
      ],
      pinnedInputs: structuredClone(input),
    }
  } catch (error) {
    return unavailablePowerPreview('replay-rejected', error instanceof Error ? error.message : 'The isolated production replay rejected the inputs.')
  }
}

/** Checks a supplied complete pre-state against its authoritative prefix without replaying or changing it. */
export function conditionalPowerBasisProblem(basis: ConditionalPowerReplayBasis): PowerPreviewUnavailable | null {
  try {
    if (basis.modelVersion !== transparentGprModelMetadata.version || basis.modelConfigHash !== transparentGprModelMetadata.configHash) {
      return unavailablePowerPreview('model-mismatch', 'The pinned model/config must match the production evaluator in this revision.')
    }
    if (!ratingScaleFromUnknown(basis.ratingScale)) return unavailablePowerPreview('missing-scale', 'A valid public rating scale is required.')
    if (![basis.event.id, basis.event.name, basis.event.league, basis.event.phase].every(nonemptyString)
      || !Object.hasOwn(eventTierConfig, basis.event.tier) || !supportedRegions.has(basis.event.region)) {
      return unavailablePowerPreview('missing-event-context', 'A nonempty pinned event identity, name, league, phase and supported explicit tier and region are required.')
    }
    const { context, state } = basis
    const boundary = state.processedThroughUtcDate
    if (!nonemptyString(basis.preStateId) || !realUtcDate(boundary) || context.lastDate !== boundary || !completeStateContainers(state)
      || !(context.pregamePlayerRatingEdges instanceof Map) || !(context.teamRosterBasis instanceof Map)
      || !(context.tournamentLifecycles instanceof Map) || !(context.eventWeightContext.worldsEndDateByCalendarYear instanceof Map)) {
      return unavailablePowerPreview('missing-pre-state', 'A dated, identified complete UTC-boundary state and all replay containers are required.')
    }
    if ([...context.tournamentLifecycles.values()].some((lifecycle) => lifecycle.status === 'completed'
      && (!realUtcDate(lifecycle.boundaryDate) || lifecycle.boundaryDate > boundary))) {
      return unavailablePowerPreview('unsupported-future-placement', 'Completed tournament placement boundaries after the pinned pre-state are unsupported. Future placements cannot be silently omitted from a conditional replay.')
    }
    const matches = context.authoritativeMatches
    if (!Array.isArray(matches) || !matches.length || matches.some((match) => !nonemptyString(match.id) || !nonemptyString(matchIdentity(match)) || !realUtcDate(match.date) || match.date > boundary)
      || state.processedMatchCount !== matches.length) {
      return unavailablePowerPreview('missing-pre-state', 'The complete authoritative prefix must match the processed game count and UTC boundary.')
    }
    if (!hasUniqueConditionalPowerGameAliases(matches)) {
      return unavailablePowerPreview('duplicate-game-alias', 'Every historical raw, official and source game alias must belong to one game row. Duplicate evidence cannot establish a replay basis.')
    }
    const historicalClockProblem = historicalTimestampProblem(matches)
    if (historicalClockProblem) return historicalClockProblem
    if (!hasUniqueConditionalPowerSeriesAliases(matches)) {
      return unavailablePowerPreview('duplicate-series-alias', 'Every historical official, source and production-normalized series alias must belong to one canonical series. Duplicate series evidence cannot establish a replay basis.')
    }
    if (!hasCompleteConditionalPowerHistoricalSeries(matches)) {
      return unavailablePowerPreview('incomplete-historical-inputs', 'Every historical series must have coherent scoring metadata and supplied event IDs, official or provider format evidence, and a legal decisive final score within one UTC replay date.')
    }
    const expectedRosterBasis = rosterBasisByTeam(matches)
    if (context.teamRosterBasis.size !== expectedRosterBasis.size
      || [...expectedRosterBasis].some(([team, rosterBasis]) => context.teamRosterBasis.get(team) !== rosterBasis)) {
      return unavailablePowerPreview('roster-basis-mismatch', 'The complete historical roster-basis map must match its authoritative corpus, including every team and sourced or unsourced value.')
    }
    if (!explicitLatestHomeLeaguesMatchContext(context)) {
      return unavailablePowerPreview('missing-home-league-context', 'Every historical team needs an explicit, unambiguous home league on its latest UTC date that matches the team directory.')
    }
    const terminalIds = matches.filter((match) => match.date === boundary).map(matchIdentity).sort()
    const previousMatch = state.previousMatch
    if (!terminalIds.length || JSON.stringify(terminalIds) !== JSON.stringify([...state.processedThroughUtcDateMatchIds].sort())
      || !previousMatch || previousMatch.date !== boundary
      || !matches.some((match) => matchIdentity(match) === matchIdentity(previousMatch)
        && match.id === previousMatch.id && match.date === previousMatch.date)) {
      return unavailablePowerPreview('missing-pre-state', 'The state must prove every terminal UTC-date identity and its previous match in the authoritative prefix.')
    }
    if ([state.teamLastRatedDates, state.leagueLastRatedDates, state.leagueLastUpdated].some((dates) =>
      [...dates.values()].some((date) => !realUtcDate(date) || date > boundary))) {
      return unavailablePowerPreview('missing-pre-state', 'Every rated entity date must be a real UTC date at or before the pinned boundary.')
    }
    const scoringStateProblem = historicalScoringStateProblem(basis)
    if (scoringStateProblem) return scoringStateProblem
    if (basis.teamNames.length !== 2 || basis.sourceTeamIds.length !== 2 || basis.sourceTeamIds.some((id) => !nonemptyString(id))
      || basis.sourceTeamIds[0] === basis.sourceTeamIds[1] || basis.teamNames[0] === basis.teamNames[1]
      || basis.teamNames.some((team) => !hasParticipantRoster(basis, team)) || !coherentHistoryEvidence(basis)) {
      return unavailablePowerPreview('missing-pre-state', 'Participants and historical teams need coherent corpus, history, record and rating context evidence.')
    }
    const expectedEventContext = eventWeightContextForMatches(matches)
    if (JSON.stringify([...context.eventWeightContext.worldsEndDateByCalendarYear].sort())
      !== JSON.stringify([...expectedEventContext.worldsEndDateByCalendarYear].sort())) {
      return unavailablePowerPreview('missing-pre-state', 'The pinned event weighting context must match its authoritative corpus.')
    }
    const eventContract = buildRatingCheckpointEventContract(matches, context.eventWeightContext, context.tournamentLifecycles)
    validateRatingCheckpointEventContract(state, boundary, eventContract)
    const pin = parsedPreStatePin(basis.preStateId)
    if (!pin) return unavailablePowerPreview('invalid-pre-state-pin', 'The pre-state pin must contain explicit importer, identity taxonomy, raw-prefix identities, production payload digest and complete replay-context digest.')
    if (digestCausalValue(context) !== pin.contextDigest) {
      return unavailablePowerPreview('stale-context-pin', 'The supplied replay context differs from its pinned digest. Reconstruct the basis from the changed corpus and context before projecting Power.')
    }
    const envelope = encodeRatingCheckpointEnvelope(state, pin, {
      processedThroughUtcDate: boundary, processedThroughMatchId: previousMatch.id,
    }, eventContract)
    if (envelope.metadata.payloadDigest !== pin.payloadDigest) {
      return unavailablePowerPreview('stale-pre-state-pin', 'The supplied rating state differs from the payload digest in its pinned pre-state identity.')
    }
    decodeRatingCheckpointValue(envelope, pin)
    return null
  } catch (error) {
    return unavailablePowerPreview('missing-pre-state', error instanceof Error ? error.message : 'The supplied replay basis is malformed or incomplete.')
  }
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function parsedPreStatePin(serialized: string) {
  let value: unknown
  try { value = JSON.parse(serialized) } catch { return null }
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('importerVersion' in value) || !nonemptyString(value.importerVersion)
    || !('identityTaxonomyHash' in value) || !nonemptyString(value.identityTaxonomyHash)
    || !('rawLedgerPrefixHash' in value) || !nonemptyString(value.rawLedgerPrefixHash)
    || !('payloadDigest' in value) || !nonemptyString(value.payloadDigest)
    || !('contextDigest' in value) || !nonemptyString(value.contextDigest)) return null
  return {
    importerVersion: value.importerVersion, identityTaxonomyHash: value.identityTaxonomyHash,
    rawLedgerPrefixHash: value.rawLedgerPrefixHash, payloadDigest: value.payloadDigest, contextDigest: value.contextDigest,
  }
}

const supportedRegions = new Set<Region>(['LCK', 'LPL', 'LEC', 'LCS', 'LCP', 'CBLOL', 'VCS', 'PCS', 'International'])

function explicitLatestHomeLeaguesMatchContext(context: RatingReplayContext) {
  const teams = new Set(context.authoritativeMatches.flatMap((match) => [match.teamA, match.teamB]))
  for (const team of teams) {
    const matches = context.authoritativeMatches.filter((match) => match.teamA === team || match.teamB === team)
    const latestDate = matches.map((match) => match.date).sort().at(-1)
    const league = context.teams[team]?.league
    if (!nonemptyString(league) || league === 'Unknown' || matches.filter((match) => match.date === latestDate).some((match) => {
      const observedLeague = match.teamA === team ? match.teamAHomeLeague : match.teamBHomeLeague
      return !nonemptyString(observedLeague) || observedLeague !== league
    })) return false
  }
  return true
}

function gameIdentityAliases(match: MatchRecord) {
  return [match.id, match.officialGameId, match.sourceGameId].filter(nonemptyString)
}

/** Preview-internal guard: repeated aliases within one game are valid, but cannot identify another row. */
export function hasUniqueConditionalPowerGameAliases(matches: readonly MatchRecord[]): boolean {
  const observedAliases = new Set<string>()
  for (const match of matches) {
    const aliases = new Set(gameIdentityAliases(match))
    for (const alias of aliases) {
      if (observedAliases.has(alias)) return false
    }
    for (const alias of aliases) observedAliases.add(alias)
  }
  return true
}

function seriesIdentityAliases(matches: readonly MatchRecord[]) {
  const aliases = matches.flatMap((match) => [match.officialMatchId, match.sourceMatchId].filter(nonemptyString))
  // Each supplied identity remains an alias even when a higher-priority identity wins canonical resolution.
  const sourceMatchViews = matches.filter((match) => nonemptyString(match.sourceMatchId)).map((match) => {
    const view = { ...match }
    delete view.officialMatchId
    return view
  })
  const sourceGameViews = matches.filter((match) => nonemptyString(match.sourceGameId)).map((match) => {
    const view = { ...match }
    delete view.officialMatchId
    delete view.sourceMatchId
    return view
  })
  for (const series of [matches, sourceMatchViews, sourceGameViews].flatMap((view) => resolveCanonicalSeries(view))) {
    aliases.push(series.id)
    // Use the source-series identity already normalized by the production resolver.
    const [kind, , sourceSeriesId] = series.id.split('\u0000')
    if ((kind === 'source-match' || kind === 'source-game-series') && nonemptyString(sourceSeriesId)) aliases.push(sourceSeriesId)
  }
  return aliases
}

/** Preview-internal guard: a series may repeat its aliases, but another canonical series cannot claim them. */
export function hasUniqueConditionalPowerSeriesAliases(matches: readonly MatchRecord[]): boolean {
  const observedAliases = new Set<string>()
  for (const series of resolveCanonicalSeries(matches)) {
    const aliases = new Set(seriesIdentityAliases(series.games))
    for (const alias of aliases) {
      if (observedAliases.has(alias)) return false
    }
    for (const alias of aliases) observedAliases.add(alias)
  }
  return true
}

/** Preview-internal series support shared by reconstructed and directly supplied historical bases. */
export function hasCompleteConditionalPowerHistoricalSeries(matches: readonly MatchRecord[]): boolean {
  return resolveCanonicalSeries(matches).every((series) => {
    const winsNeeded = (series.format + 1) / 2
    const final = series.finalMatch
    const suppliedEventIds = series.games.map((game) => game.officialEventId).filter((id) => id !== undefined)
    return series.state === 'completed' && [1, 3, 5].includes(series.format)
      && new Set(series.games.map((game) => game.date)).size === 1
      && new Set(suppliedEventIds).size <= 1
      && Math.max(series.winsA, series.winsB) === winsNeeded && Math.min(series.winsA, series.winsB) < winsNeeded
      && series.games.every((game) => game.bestOf === series.format && ['official', 'provider'].includes(game.bestOfBasis ?? '')
        && game.event === final.event && game.league === final.league && game.phase === final.phase
        && game.region === final.region && game.tier === final.tier)
      && canonicalSeriesOutcomeForTeam(series, final.winner) === 1
  })
}

function reusedReplayIdentityProblem(seriesId: string, historical: readonly MatchRecord[], games: readonly MatchRecord[]): PowerPreviewUnavailable | null {
  const historicalGameIds = new Set(historical.flatMap(gameIdentityAliases))
  if (games.flatMap(gameIdentityAliases).some((id) => historicalGameIds.has(id))) {
    return unavailablePowerPreview('reused-game-identity', 'Hypothetical raw and canonical game identities must be distinct from every historical game alias.')
  }
  const historicalSeriesIds = new Set(seriesIdentityAliases(historical))
  if ([seriesId, ...seriesIdentityAliases(games)].some((id) => historicalSeriesIds.has(id))) {
    return unavailablePowerPreview('reused-series-identity', 'The hypothetical series must not reuse any historical official, source or canonical series identity.')
  }
  return null
}

function realUtcDate(date: string | undefined): date is string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const timestamp = Date.parse(`${date}T00:00:00.000Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date
}

function matchIdentity(match: MatchRecord) {
  return match.officialGameId ?? match.sourceGameId ?? match.id
}

const nonMapStateFields = new Set<keyof RatingRunState>([
  'leagueHistory', 'predictions', 'eventWeightContext', 'previousMatch',
  'processedThroughUtcDate', 'processedThroughUtcDateMatchIds', 'processedMatchCount',
])

function completeStateContainers(state: RatingRunState) {
  return ratingCheckpointInventory.includedFields.every((field) => nonMapStateFields.has(field) || state[field] instanceof Map)
    && Array.isArray(state.leagueHistory) && Array.isArray(state.predictions) && Array.isArray(state.processedThroughUtcDateMatchIds)
    && state.eventWeightContext.worldsEndDateByCalendarYear instanceof Map
}

function historicalTimestampProblem(matches: readonly MatchRecord[]): PowerPreviewUnavailable | null {
  for (const match of matches) {
    if (match.datetimeUtc === undefined) continue
    const timestamp = typeof match.datetimeUtc === 'string' ? Date.parse(match.datetimeUtc) : NaN
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== match.date) {
      return unavailablePowerPreview('invalid-historical-timestamp', 'Every supplied historical timestamp must be valid and match its UTC replay date. Date-only history may omit timestamps.')
    }
    if (match.datetimeUtc !== new Date(timestamp).toISOString()) {
      return unavailablePowerPreview('historical-timestamp-normalization-required', 'The supplied state needs normalized UTC ISO historical timestamps for production ordering. Reconstruct it with the replay basis adapter; existing state cannot be rewritten or re-pinned here.')
    }
  }
  return null
}

function historicalScoringStateProblem({ context, state }: ConditionalPowerReplayBasis): PowerPreviewUnavailable | null {
  const historicalTeams = new Set(context.authoritativeMatches.flatMap((match) => [match.teamA, match.teamB]))
  for (const team of historicalTeams) {
    const missingNumericField = (['ratings', 'executionRatings', 'previousDisplayRatings', 'rosterPriorOffsets', 'momentums',
      'uncertainties', 'wins', 'losses', 'factorCounts', 'teamLastSeasons'] as const)
      .find((field) => !Number.isFinite(state[field].get(team)))
    const missingContainer = (['histories', 'forms', 'factorSums', 'latestRatingUpdates'] as const)
      .find((field) => !state[field].has(team))
    if (missingNumericField || missingContainer || !state.teamLastRatedDates.has(team)) {
      return unavailablePowerPreview('missing-pre-state', `Historical team ${team} requires production scoring state for ${missingNumericField ?? missingContainer ?? 'teamLastRatedDates'}.`)
    }
    const matches = context.authoritativeMatches.filter((match) => match.teamA === team || match.teamB === team)
    const hasCompleteRosterEvidence = matches.some((match) => rosterFingerprint(match.teamA === team ? match.teamARoster : match.teamBRoster))
    if ((matches.some((match) => match.patch) && !nonemptyString(state.lastPatchByTeam.get(team)))
      || (hasCompleteRosterEvidence && (!state.lastRosterByTeam.has(team) || !nonemptyString(state.lastRosterFingerprintByTeam.get(team))))) {
      return unavailablePowerPreview('missing-pre-state', `Historical team ${team} is missing patch or roster context established by its supplied corpus.`)
    }
  }
  const historicalLeagues = new Set(context.authoritativeMatches.flatMap((match) => [
    homeLeagueForMatch(match, 'A', context.teams), homeLeagueForMatch(match, 'B', context.teams),
  ]))
  for (const league of historicalLeagues) {
    const missingNumericField = (['leagueScores', 'previousLeagueScores', 'leagueMatchCounts', 'leagueWins', 'leagueLosses',
      'leagueExpectedWins', 'leagueOpponentRatingSums', 'leagueLastSeasons'] as const)
      .find((field) => !Number.isFinite(state[field].get(league)))
    if (missingNumericField || !state.leagueForms.has(league) || !state.leagueLastRatedDates.has(league)) {
      return unavailablePowerPreview('missing-pre-state', `Historical home league ${league} requires production scoring state for ${missingNumericField ?? (!state.leagueForms.has(league) ? 'leagueForms' : 'leagueLastRatedDates')}.`)
    }
  }
  return null
}

function coherentHistoryEvidence({ context, state }: ConditionalPowerReplayBasis) {
  const historicalTeams = new Set(context.authoritativeMatches.flatMap((match) => [match.teamA, match.teamB]))
  for (const team of historicalTeams) {
    const matches = context.authoritativeMatches.filter((match) => match.teamA === team || match.teamB === team)
    const history = state.histories.get(team)
    const wins = matches.filter((match) => match.winner === team).length
    if (!Array.isArray(history) || history.length !== matches.length || state.wins.get(team) !== wins
      || state.losses.get(team) !== matches.length - wins || state.factorCounts.get(team) !== matches.length) return false
    const expectedEvidence = matches.map((match) => JSON.stringify([
      match.date, match.event, match.teamA === team ? match.teamB : match.teamA, match.tier, match.winner === team ? 'W' : 'L',
      match.sourceProvider, match.sourceGameId, match.sourceMatchId, match.officialGameId, match.officialMatchId, match.officialEventId,
    ])).sort()
    const historyEvidence = history.map((point) => JSON.stringify([
      point.date, point.event, point.opponent, point.tier, point.result, point.source.provider,
      point.source.gameId, point.source.matchId, point.source.officialGameId, point.source.officialMatchId, point.source.officialEventId,
    ])).sort()
    if (JSON.stringify(expectedEvidence) !== JSON.stringify(historyEvidence)
      || history.some((point) => ![point.rating, point.baseRating, point.delta, ...Object.values(point.ratingComponents)].every(Number.isFinite))
      || state.teamLastRatedDates.get(team) !== matches.map((match) => match.date).sort().at(-1)) return false
  }
  for (const [league, date] of state.leagueLastRatedDates) {
    const matches = context.authoritativeMatches.filter((match) => homeLeagueForMatch(match, 'A', context.teams) === league
      || homeLeagueForMatch(match, 'B', context.teams) === league)
    if (date !== matches.map((match) => match.date).sort().at(-1)) return false
  }
  return true
}

function hasParticipantRoster(basis: ConditionalPowerReplayBasis, team: string) {
  const league = basis.context.teams[team]?.league
  return Boolean(league && league !== 'Unknown' && supportedRegions.has(basis.context.teams[team]!.region)
    && completeRoster(basis.state.lastRosterByTeam.get(team)) && basis.context.teamRosterBasis.get(team) === 'sourced'
    && nonemptyString(basis.state.lastPatchByTeam.get(team)))
}

function completeRoster(roster: MatchRosterSnapshot | undefined) {
  return roster?.completeness === 'complete-five-role' && roster.players.length === 5
    && new Set(roster.players.map((player) => player.id)).size === 5
    && ['Top', 'Jungle', 'Mid', 'Bot', 'Support'].every((role) => roster.players.some((player) => player.role === role && player.id))
}

function scenarioProblem(input: ReplayInput, basis: ConditionalPowerReplayBasis, games: MatchRecord[], playerEdges: Map<string, PregamePlayerRatingEdge>): PowerPreviewUnavailable | null {
  const startTimestamp = Date.parse(input.series.startTime!)
  const expectedDate = new Date(startTimestamp).toISOString().slice(0, 10)
  const winsNeeded = (input.series.bestOf! + 1) / 2
  const winner = basis.teamNames[input.outcome.winner === 'home' ? 0 : 1]
  if (games.some((game) => !nonemptyString(game.id) || !nonemptyString(matchIdentity(game)))) {
    return unavailablePowerPreview('missing-game-identity', 'Every hypothetical game requires a nonempty game identity and canonical source identity.')
  }
  if (games.length !== winsNeeded + input.outcome.loserWins) {
    return unavailablePowerPreview('invalid-score', 'Game count must match the selected legal score.')
  }
  if (!hasUniqueConditionalPowerGameAliases(games)) {
    return unavailablePowerPreview('duplicate-game-alias', 'Every hypothetical raw, official and source game alias must belong to one game row. A legal score cannot reuse game evidence.')
  }
  if (games.some((game, index) => game.sourceProvider !== 'seed' || game.officialMatchId !== input.series.id
    || game.officialEventId !== basis.event.id || game.event !== basis.event.name || game.league !== basis.event.league
    || game.tier !== basis.event.tier || game.phase !== basis.event.phase || game.region !== basis.event.region
    || game.date !== expectedDate || game.date <= basis.state.processedThroughUtcDate!
    || game.season !== Number(expectedDate.slice(0, 4)) || game.bestOf !== input.series.bestOf || game.bestOfBasis !== 'official'
    || game.teamA !== basis.teamNames[0] || game.teamB !== basis.teamNames[1]
    || (game.teamAHomeLeague !== undefined && game.teamAHomeLeague !== basis.context.teams[game.teamA]?.league)
    || (game.teamBHomeLeague !== undefined && game.teamBHomeLeague !== basis.context.teams[game.teamB]?.league)
    || (game.teamARegion !== undefined && game.teamARegion !== basis.context.teams[game.teamA]?.region)
    || (game.teamBRegion !== undefined && game.teamBRegion !== basis.context.teams[game.teamB]?.region)
    || !basis.teamNames.includes(game.winner) || game.gameNumber !== index + 1
    || !game.datetimeUtc || !Number.isFinite(Date.parse(game.datetimeUtc))
    || new Date(Date.parse(game.datetimeUtc)).toISOString().slice(0, 10) !== expectedDate
    || Date.parse(game.datetimeUtc) < startTimestamp
    || (index > 0 && Date.parse(game.datetimeUtc) <= Date.parse(games[index - 1]!.datetimeUtc!)))) {
    return unavailablePowerPreview('unsupported-scenario', 'Supply one ordered, synthetic, verified-format series after the pinned boundary, with matching event and participant identities.')
  }
  if (games.filter((game) => game.winner === winner).length !== winsNeeded || games.at(-1)?.winner !== winner) {
    return unavailablePowerPreview('invalid-score', 'The selected winner must reach the winning score on the final game only.')
  }
  if (games.some((game) => !completeRoster(game.teamARoster) || !completeRoster(game.teamBRoster) || !game.patch
    || !['blue', 'red'].includes(game.teamASide ?? '') || !['blue', 'red'].includes(game.teamBSide ?? '') || game.teamASide === game.teamBSide
    || ![game.teamAKills, game.teamBKills, game.teamAGold, game.teamBGold, game.teamATowers, game.teamBTowers,
      game.teamADragons, game.teamBDragons, game.teamABarons, game.teamBBarons, game.gameLengthSeconds]
      .every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0))) {
    return unavailablePowerPreview('missing-future-inputs', 'Lineups, patch, sides, duration and every performance statistic must be explicit. Missing objectives cannot become zero.')
  }
  if (games.some((game) => {
    const homePlayers = new Set(game.teamARoster!.players.map((player) => player.id))
    return game.teamBRoster!.players.some((player) => homePlayers.has(player.id))
  })) return unavailablePowerPreview('unsupported-scenario', 'Opposing lineups must have distinct player identities in each game.')
  if (games.some((game) => {
    const edge = playerEdges.get(game.id)
    return !edge || !Number.isFinite(edge.teamAAdjustment) || !Number.isFinite(edge.teamBAdjustment)
      || !['prior-observed', 'pregame-confirmed'].includes(edge.teamAEvidenceBasis)
      || !['prior-observed', 'pregame-confirmed'].includes(edge.teamBEvidenceBasis)
      || ![edge.teamACoverage, edge.teamBCoverage, edge.teamAFreshnessWeight, edge.teamBFreshnessWeight]
        .every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)
      || [edge.teamAAdjustment, edge.teamBAdjustment].some((value) => Math.abs(value) > playerModelParameters.playerPregameEdgeCap)
      || ((edge.teamACoverage < playerModelParameters.playerPregameMinCoverage || edge.teamAFreshnessWeight === 0) && edge.teamAAdjustment !== 0)
      || ((edge.teamBCoverage < playerModelParameters.playerPregameMinCoverage || edge.teamBFreshnessWeight === 0) && edge.teamBAdjustment !== 0)
  })) return unavailablePowerPreview('missing-player-priors', 'Every hypothetical game needs explicit available player priors within production cap, coverage and freshness limits. Below minimum coverage or at zero freshness, the supplied adjustment must be zero.')
  return null
}
