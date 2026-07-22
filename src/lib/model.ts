import { effectiveLeagueRating, leaguePriorFor, leagueTierFor } from '../data/leagueTiers'
import type {
  EventSummary,
  FactorBreakdown,
  LeagueStrengthHistoryPoint,
  LeagueStrength,
  MatchRecord,
  PregamePrediction,
  Region,
  RosterBasis,
  SeasonSummary,
  TeamHistoryPoint,
  TeamProfile,
  TeamStanding,
} from '../types'
import { evaluateTeamEligibility, matchLevelEligibilityHistory } from './eligibility'
import { eventWeightContextForMatches } from './eventWeighting'
import { ensureLeague } from './leagueRatings'
import { homeLeagueForMatch, matchesByDate } from './matchContext'
import { buildEventSummaries, buildLeagueStrengths, buildSeasonSummaries } from './modelSummaries'
import { buildPregamePlayerRatingEdges, type PregamePlayerRatingEdge } from './playerModel'
import {
  applyCompletedPlacementResiduals,
  startEventTrackersForDate,
} from './placementResiduals'
import { applyContextDecayToRatingChannels } from './ratingContext'
import {
  applyMomentumBoundaryDecay,
  clamp,
  evidenceWeightedPublishedLeagueAnchor,
  evidenceWeightedPublishedStanding,
  emptyRatingUpdateLedger,
  leagueAdjustment,
  publishedLeagueAnchorContextAdjustment,
  publishedRosterPriorOffset,
  recencyWeight,
  ratingComponents,
  ratingFromComponents,
} from './ratingCalculations'
import { createRatingRunState, ensureMatchRunEntities, type RatingRunState } from './ratingRunState'
import type { PlacementTournamentLifecycle } from './placementResiduals'
import { emitPregamePredictionsForDate, processRatingSeriesForDate } from './ratingSeriesEngine'
import { applyRosterContinuityForDate, roundedContinuity } from './rosterContinuityRating'
import { rosterBasisByTeam } from './rosters'
import { sideAdjustmentsFromSamples } from './sideAdjustments'
import {
  directHeadToHeadContextConfig,
  initialLeagueRating,
  initialTeamRating,
  leagueEloWeight,
  maximumUncertainty,
  normalPatchTeamRetention,
  recencyDecayDays,
  recencyFloor,
  recencyRange,
  seasonStartLeagueRetention,
  seasonStartTeamRetention,
  splitBreakLeagueRetention,
  splitBreakMinimumGapDays,
  splitBreakTeamRetention,
} from './modelConfig'

export { buildPlayerModel } from './playerModel'
export { factorLabel, transparentGprModelMetadata } from './modelConfig'

export type RankingModelOutput = {
  standings: TeamStanding[]
  leagues: LeagueStrength[]
  events: EventSummary[]
  seasons: SeasonSummary[]
  regions: Region[]
  leagueHistory: LeagueStrengthHistoryPoint[]
  predictions: PregamePrediction[]
}

export type RatingReplayContext = {
  authoritativeMatches: MatchRecord[]
  teams: Record<string, TeamProfile>
  eventWeightContext: ReturnType<typeof eventWeightContextForMatches>
  pregamePlayerRatingEdges: Map<string, PregamePlayerRatingEdge>
  teamRosterBasis: Map<string, RosterBasis>
  tournamentLifecycles: ReadonlyMap<string, PlacementTournamentLifecycle>
  lastDate: string
}

export function createRatingReplayContext(
  authoritativeMatches: readonly MatchRecord[],
  teams: Record<string, TeamProfile>,
  { tournamentLifecycles = new Map() }: { tournamentLifecycles?: ReadonlyMap<string, PlacementTournamentLifecycle> } = {},
): RatingReplayContext {
  const sortedMatches = authoritativeMatches.toSorted(compareReplayMatches)
  const eventWeightContext = eventWeightContextForMatches(sortedMatches)
  return {
    authoritativeMatches: sortedMatches,
    teams,
    eventWeightContext,
    pregamePlayerRatingEdges: buildPregamePlayerRatingEdges(sortedMatches, { teams, eventWeightContext }),
    teamRosterBasis: rosterBasisByTeam(sortedMatches),
    tournamentLifecycles,
    lastDate: sortedMatches.at(-1)?.date ?? new Date().toISOString().slice(0, 10),
  }
}

export function replayRatingDates({
  context,
  state = createRatingRunState(
    context.authoritativeMatches,
    context.teams,
    context.eventWeightContext,
    context.tournamentLifecycles,
  ),
  replayMatches,
}: {
  context: RatingReplayContext
  state?: RatingRunState
  replayMatches: readonly MatchRecord[]
}) {
  const sortedReplayMatches = replayMatches.toSorted(compareReplayMatches)
  if (state.processedThroughUtcDate) rebaseCheckpointRecencyFactors(state, context.lastDate)
  const replayDates = new Set(sortedReplayMatches.map((match) => match.date))
  if (state.processedThroughUtcDate && [...replayDates].some((date) => date <= state.processedThroughUtcDate!)) {
    throw new Error(`Rating replay must start strictly after checkpoint ${state.processedThroughUtcDate}`)
  }
  for (const date of replayDates) {
    const authoritativeIds = context.authoritativeMatches
      .filter((match) => match.date === date)
      .map((match) => replayMatchIdentity(match))
      .sort()
    const replayIds = sortedReplayMatches
      .filter((match) => match.date === date)
      .map((match) => replayMatchIdentity(match))
      .sort()
    if (authoritativeIds.join('\u0000') !== replayIds.join('\u0000')) {
      throw new Error(`Rating replay for ${date} must contain the complete authoritative UTC date`)
    }
  }

  for (const team of Object.keys(context.teams)) {
    ensureLeague(context.teams[team]?.league ?? 'Unknown', state.leagueScores, state.previousLeagueScores, state.leagueWins, state.leagueLosses, state.leagueExpectedWins, state.leagueOpponentRatingSums, state.leagueForms, state.leagueMatchCounts)
  }
  for (const dateMatches of matchesByDate(sortedReplayMatches)) {
    processRatingUtcDateBoundary({
      dateMatches,
      teams: context.teams,
      state,
      lastDate: context.lastDate,
      pregamePlayerRatingEdges: context.pregamePlayerRatingEdges,
    })
  }
  return state
}

/** Checkpoint factor sums were evaluated against the prior corpus end date. */
function rebaseCheckpointRecencyFactors(state: RatingRunState, lastDate: string) {
  for (const [team, factors] of state.factorSums) {
    const history = state.histories.get(team) ?? []
    state.factorSums.set(team, {
      ...factors,
      recency: history.reduce((sum, point) => sum + recencyWeight(point.date, lastDate), 0),
    })
  }
}

export type RatingUtcDateBoundaryInput = {
  dateMatches: MatchRecord[]
  teams: Record<string, TeamProfile>
  state: RatingRunState
  lastDate: string
  pregamePlayerRatingEdges: Map<string, PregamePlayerRatingEdge>
}

/**
 * Applies one complete UTC date atomically from the shared pre-date snapshot.
 * Callers must replay the whole date when any match on that date changes.
 */
export function processRatingUtcDateBoundary({
  dateMatches,
  teams,
  state,
  lastDate,
  pregamePlayerRatingEdges,
}: RatingUtcDateBoundaryInput) {
  const firstMatch = dateMatches[0]
  if (!firstMatch) throw new Error('A rating UTC date boundary cannot be empty')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(firstMatch.date)) {
    throw new Error(`Invalid UTC rating boundary date: ${firstMatch.date}`)
  }
  if (dateMatches.some((match) => match.date !== firstMatch.date)) {
    throw new Error(`Rating boundary ${firstMatch.date} contains matches from another UTC date`)
  }
  if (state.processedThroughUtcDate && firstMatch.date <= state.processedThroughUtcDate) {
    throw new Error(`Rating boundary ${firstMatch.date} does not follow ${state.processedThroughUtcDate}`)
  }

  applyCompletedPlacementResiduals({
    cutoffDate: firstMatch.date,
    eventTrackers: state.eventTrackers,
    teams,
    ratings: state.ratings,
    leagueScores: state.leagueScores,
    previousLeagueScores: state.previousLeagueScores,
    leagueLastEvents: state.leagueLastEvents,
    leagueLastUpdated: state.leagueLastUpdated,
    leaguePlacementDeltas: state.leaguePlacementDeltas,
    latestRatingUpdates: state.latestRatingUpdates,
  })

  applyContextDecayToRatingChannels(
    firstMatch,
    state.previousMatch,
    teams,
    [state.ratings, state.executionRatings],
    state.leagueScores,
    {
      initialTeamRating,
      recencyFloor,
      recencyRange,
      recencyDecayDays,
      normalPatchTeamRetention,
      splitBreakTeamRetention,
      seasonStartTeamRetention,
      splitBreakLeagueRetention,
      seasonStartLeagueRetention,
      splitBreakMinimumGapDays,
    },
  )
  applyMomentumBoundaryDecay(firstMatch, state.previousMatch, state.momentums)

  for (const match of dateMatches) {
    ensureMatchRunEntities(state, match, teams)
    ensureLeague(homeLeagueForMatch(match, 'A', teams), state.leagueScores, state.previousLeagueScores, state.leagueWins, state.leagueLosses, state.leagueExpectedWins, state.leagueOpponentRatingSums, state.leagueForms, state.leagueMatchCounts)
    ensureLeague(homeLeagueForMatch(match, 'B', teams), state.leagueScores, state.previousLeagueScores, state.leagueWins, state.leagueLosses, state.leagueExpectedWins, state.leagueOpponentRatingSums, state.leagueForms, state.leagueMatchCounts)
  }

  applyRosterContinuityForDate(dateMatches, state.ratings, state.executionRatings, state.uncertainties, state.lastRosterByTeam, state.currentRosterContinuity)
  startEventTrackersForDate(dateMatches, state.eventTrackers, teams, state.ratings, state.momentums, state.rosterPriorOffsets, state.uncertainties, state.leagueScores, state.leagueMatchCounts)

  const sideAdjustments = sideAdjustmentsFromSamples(state.sideAdjustmentSamples)
  emitPregamePredictionsForDate({
    matches: dateMatches,
    teams,
    state,
    pregamePlayerRatingEdges,
    sideAdjustments,
  })
  processRatingSeriesForDate({
    matches: dateMatches,
    teams,
    state,
    sideAdjustments,
    lastDate,
    pregamePlayerRatingEdges,
  })
  state.processedThroughUtcDate = firstMatch.date
  state.processedThroughUtcDateMatchIds = dateMatches
    .map(replayMatchIdentity)
    .sort()
}

export function finalizeRatingRunStateAtUtcBoundary(
  state: RatingRunState,
  teams: Record<string, TeamProfile>,
) {
  const processedThroughUtcDate = state.processedThroughUtcDate
  if (!processedThroughUtcDate) return undefined
  applyCompletedPlacementResiduals({
    cutoffDate: utcDateAfter(processedThroughUtcDate),
    eventTrackers: state.eventTrackers,
    teams,
    ratings: state.ratings,
    leagueScores: state.leagueScores,
    previousLeagueScores: state.previousLeagueScores,
    leagueLastEvents: state.leagueLastEvents,
    leagueLastUpdated: state.leagueLastUpdated,
    leaguePlacementDeltas: state.leaguePlacementDeltas,
    latestRatingUpdates: state.latestRatingUpdates,
  })
  return processedThroughUtcDate
}

function utcDateAfter(date: string) {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid processed-through UTC date ${date}`)
  }
  parsed.setUTCDate(parsed.getUTCDate() + 1)
  return parsed.toISOString().slice(0, 10)
}

export function buildRankingModel(
  matches: MatchRecord[],
  teams: Record<string, TeamProfile>,
  { tournamentLifecycles = new Map() }: { tournamentLifecycles?: ReadonlyMap<string, PlacementTournamentLifecycle> } = {},
): RankingModelOutput {
  const context = createRatingReplayContext(matches, teams, { tournamentLifecycles })
  const state = replayRatingDates({ context, replayMatches: context.authoritativeMatches })
  return materializeRankingModel({ context, state })
}

export function materializeRankingModel({
  context,
  state,
}: {
  context: RatingReplayContext
  state: RatingRunState
}): RankingModelOutput {
  const sortedMatches = context.authoritativeMatches
  const teams = context.teams
  const teamRosterBasis = context.teamRosterBasis
  const {
    ratings,
    previousDisplayRatings,
    momentums,
    rosterPriorOffsets,
    latestRatingUpdates,
    wins,
    losses,
    forms,
    histories,
    factorSums,
    factorCounts,
    leagueScores,
    previousLeagueScores,
    uncertainties,
    leagueWins,
    leagueLosses,
    leagueExpectedWins,
    leagueOpponentRatingSums,
    leagueForms,
    leagueMatchCounts,
    leagueLastEvents,
    leagueLastUpdated,
    leagueHistory,
    predictions,
    currentRosterContinuity,
  } = state
  const lastDate = context.lastDate

  finalizeRatingRunStateAtUtcBoundary(state, teams)

  const preliminaryDisplayRatings = makeDisplayRatings(ratings, teams, leagueScores, leagueMatchCounts, rosterPriorOffsets, momentums, uncertainties, wins, losses, teamRosterBasis)
  const directHeadToHeadContextAdjustments = makeDirectHeadToHeadContextAdjustments({
    displayRatings: preliminaryDisplayRatings,
    teams,
    histories,
    uncertainties,
    wins,
    losses,
    teamRosterBasis,
    lastDate,
  })
  const displayRatings = makeDisplayRatings(ratings, teams, leagueScores, leagueMatchCounts, rosterPriorOffsets, momentums, uncertainties, wins, losses, teamRosterBasis, directHeadToHeadContextAdjustments)
  const leagues = buildLeagueStrengths(
    teams,
    leagueScores,
    previousLeagueScores,
    leagueWins,
    leagueLosses,
    leagueExpectedWins,
    leagueOpponentRatingSums,
    leagueForms,
    leagueMatchCounts,
    leagueLastEvents,
    leagueLastUpdated,
    { initialLeagueRating, leagueEloWeight },
  )

  const draftStandings = Array.from(displayRatings.entries())
    .map(([team]) => {
      const profile = teams[team] ?? { name: team, code: team.slice(0, 3).toUpperCase(), region: 'International' as Region, league: 'Unknown' }
      const baseRating = ratings.get(team) ?? initialTeamRating
      const leagueTier = leagueTierFor(profile.league)
      const leagueScore = effectiveLeagueRating(profile.league, leagueScores.get(profile.league) ?? leagueTier.priorRating, leagueMatchCounts.get(profile.league) ?? 0)
      const previousLeagueScore = effectiveLeagueRating(profile.league, previousLeagueScores.get(profile.league) ?? leagueTier.priorRating, leagueMatchCounts.get(profile.league) ?? 0)
      const history = histories.get(team) ?? []
      const eligibilityHistory = matchLevelEligibilityHistory(history)
      const evidenceMatchCount = eligibilityHistory.length
      const publishedLeagueScore = evidenceWeightedPublishedLeagueAnchor(leagueScore, evidenceMatchCount)
      const currentLeagueAdjustment = leagueAdjustment(baseRating, publishedLeagueScore)
      const rosterPriorOffset = publishedRosterPriorOffset(
        rosterPriorOffsets.get(team) ?? 0,
        wins.get(team) ?? 0,
        losses.get(team) ?? 0,
      )
      const uncertainty = Math.round(uncertainties.get(team) ?? maximumUncertainty)
      const baseContextAdjustment = publishedLeagueAnchorContextAdjustment({
        leagueScore: publishedLeagueScore,
        teamRating: baseRating,
        wins: wins.get(team) ?? 0,
        losses: losses.get(team) ?? 0,
        uncertainty,
        rosterBasis: teamRosterBasis.get(team),
      }) + (directHeadToHeadContextAdjustments.get(team) ?? 0)
      const rawCurrentRating = ratingFromComponents(ratingComponents({
        teamRating: baseRating,
        leagueScore: publishedLeagueScore,
        rosterPriorOffset,
        momentum: momentums.get(team) ?? 0,
        contextAdjustment: baseContextAdjustment,
        uncertainty,
      }))
      const evidenceWeightedStanding = evidenceWeightedPublishedStanding(
        rawCurrentRating,
        history.at(-1)?.rating,
        evidenceMatchCount,
      )
      const sparseEvidenceAdjustment = evidenceWeightedStanding - rawCurrentRating
      const contextAdjustment = baseContextAdjustment + sparseEvidenceAdjustment
      const components = ratingComponents({
        teamRating: baseRating,
        leagueScore: publishedLeagueScore,
        rosterPriorOffset,
        momentum: momentums.get(team) ?? 0,
        contextAdjustment,
        uncertainty,
      })
      const publishedDisplayRating = ratingFromComponents(components)
      const priorDisplayRating = previousDisplayRatings.get(team) ?? initialTeamRating
      const factors = averageFactors(factorSums.get(team), factorCounts.get(team) ?? 0)
      const recentEvents = Array.from(new Set(history.slice(-4).map((point) => point.event))).reverse()
      const eligibility = evaluateTeamEligibility({
        history: eligibilityHistory,
        lastDate,
        uncertainty,
        league: profile.league,
        leagueTier: leagueTier.tier,
        leagueInternationalMatches: leagueMatchCounts.get(profile.league) ?? 0,
        isDevelopmentalTeam: isDevelopmentalTeamName(team),
      })

      return {
        team,
        code: profile.code,
        region: profile.region,
        league: profile.league,
        rosterBasis: teamRosterBasis.get(team) ?? 'unknown',
        rosterContinuity: roundedContinuity(currentRosterContinuity.get(team)),
        baseRating: Math.round(baseRating),
        leagueScore: Math.round(leagueScore),
        leagueAdjustment: currentLeagueAdjustment,
        leagueDelta: Math.round(leagueScore - previousLeagueScore),
        ratingComponents: components,
        ratingUpdate: latestRatingUpdates.get(team) ?? emptyRatingUpdateLedger(),
        rating: Math.round(publishedDisplayRating),
        previousRating: Math.round(priorDisplayRating),
        delta: Math.round(publishedDisplayRating - priorDisplayRating),
        rank: 0,
        previousRank: 0,
        movement: 0,
        wins: wins.get(team) ?? 0,
        losses: losses.get(team) ?? 0,
        confidence: confidenceFor({
          history: eligibilityHistory,
          uncertainty,
          eligibility,
          rosterBasis: teamRosterBasis.get(team) ?? 'unknown',
          lastDate,
        }),
        uncertainty,
        form: forms.get(team) ?? [],
        strongestFactor: strongestFactor(factors),
        eligibility,
        factors,
        history,
        recentEvents,
      }
    })
  const previousRankMap = makeStandingRankMap(draftStandings, (standing) => standing.previousRating)
  const standings = draftStandings
    .sort((a, b) => compareStandingsByRating(a, b, (standing) => standing.rating))
    .map((standing, index) => {
      const rank = index + 1
      const previousRank = previousRankMap.get(standing.team) ?? rank
      return { ...standing, rank, previousRank, movement: previousRank - rank }
    })

  return {
    standings,
    leagues,
    events: buildEventSummaries(sortedMatches, histories),
    seasons: buildSeasonSummaries(sortedMatches, standings),
    regions: Array.from(new Set(standings.map((standing) => standing.region))).sort(),
    leagueHistory,
    predictions,
  }
}

function compareReplayMatches(left: MatchRecord, right: MatchRecord) {
  return left.date.localeCompare(right.date)
    || (left.datetimeUtc ?? '').localeCompare(right.datetimeUtc ?? '')
    || (left.gameNumber ?? 0) - (right.gameNumber ?? 0)
    || replayMatchIdentity(left).localeCompare(replayMatchIdentity(right))
}

function replayMatchIdentity(match: MatchRecord) {
  return match.officialGameId ?? match.sourceGameId ?? match.id
}

function averageFactors(sum?: FactorBreakdown, count = 0): FactorBreakdown {
  if (!sum || count === 0) return { context: 0, recency: 0, execution: 0, opponent: 0, league: 0.5 }
  return {
    context: Number((sum.context / count).toFixed(3)),
    recency: Number((sum.recency / count).toFixed(3)),
    execution: Number((sum.execution / count).toFixed(3)),
    opponent: Number((sum.opponent / count).toFixed(3)),
    league: Number((sum.league / count).toFixed(3)),
  }
}

function makeStandingRankMap(standings: TeamStanding[], ratingFor: (standing: TeamStanding) => number) {
  return new Map(
    [...standings]
      .sort((a, b) => compareStandingsByRating(a, b, ratingFor))
      .map((standing, index) => [standing.team, index + 1]),
  )
}

function compareStandingsByRating(
  a: TeamStanding,
  b: TeamStanding,
  ratingFor: (standing: TeamStanding) => number,
) {
  return Number(b.eligibility.eligible) - Number(a.eligibility.eligible)
    || ratingFor(b) - ratingFor(a)
}

function strongestFactor(factors: FactorBreakdown): keyof FactorBreakdown {
  let strongest: keyof FactorBreakdown = 'context'
  let strongestValue = Number.NEGATIVE_INFINITY
  for (const [factor, value] of Object.entries(factors) as [keyof FactorBreakdown, number][]) {
    if (value > strongestValue) {
      strongest = factor
      strongestValue = value
    }
  }
  return strongest
}

type DirectHeadToHeadContextInput = {
  displayRatings: Map<string, number>
  teams: Record<string, TeamProfile>
  histories: Map<string, TeamHistoryPoint[]>
  uncertainties: Map<string, number>
  wins: Map<string, number>
  losses: Map<string, number>
  teamRosterBasis: Map<string, RosterBasis>
  lastDate: string
}

function makeDirectHeadToHeadContextAdjustments({
  displayRatings,
  teams,
  histories,
  uncertainties,
  wins,
  losses,
  teamRosterBasis,
  lastDate,
}: DirectHeadToHeadContextInput) {
  const latestSeriesByPair = new Map<string, { winner: string, loser: string, date: string }>()

  for (const [team, history] of histories.entries()) {
    for (const point of history) {
      if (point.result !== 'W') continue
      if (point.ratingUpdate.updateUnit !== 'series-atomic') continue
      if (point.source.seriesOutcome !== 1) continue
      if ((point.source.bestOf ?? 1) < directHeadToHeadContextConfig.minimumBestOf) continue
      if (daysBetween(point.date, lastDate) > directHeadToHeadContextConfig.maxDays) continue

      const opponent = point.opponent
      const teamProfile = teams[team]
      const opponentProfile = teams[opponent]
      if (!teamProfile || !opponentProfile) continue
      if (teamProfile.league !== opponentProfile.league) continue

      const pairKey = [team, opponent].sort((a, b) => a.localeCompare(b)).join('\u0000')
      const current = latestSeriesByPair.get(pairKey)
      if (!current || point.date > current.date) {
        latestSeriesByPair.set(pairKey, { winner: team, loser: opponent, date: point.date })
      }
    }
  }

  const adjustments = new Map<string, number>()
  for (const { winner, loser } of latestSeriesByPair.values()) {
    if (!canUseDirectHeadToHeadContext(winner, uncertainties, wins, losses, teamRosterBasis)) continue
    if (!canUseDirectHeadToHeadContext(loser, uncertainties, wins, losses, teamRosterBasis)) continue

    const winnerRating = displayRatings.get(winner)
    const loserRating = displayRatings.get(loser)
    if (winnerRating === undefined || loserRating === undefined) continue

    const gap = loserRating - winnerRating
    if (gap <= 0 || gap > directHeadToHeadContextConfig.maxRatingGap) continue

    const adjustment = Math.min(
      directHeadToHeadContextConfig.maxAdjustment,
      gap / 2 + directHeadToHeadContextConfig.overtakeMargin,
    )
    addCappedDirectHeadToHeadAdjustment(adjustments, winner, adjustment)
    addCappedDirectHeadToHeadAdjustment(adjustments, loser, -adjustment)
  }

  return adjustments
}

function canUseDirectHeadToHeadContext(
  team: string,
  uncertainties: Map<string, number>,
  wins: Map<string, number>,
  losses: Map<string, number>,
  teamRosterBasis: Map<string, RosterBasis>,
) {
  if (teamRosterBasis.get(team) !== 'sourced') return false
  if ((wins.get(team) ?? 0) + (losses.get(team) ?? 0) < directHeadToHeadContextConfig.minimumGames) return false
  return (uncertainties.get(team) ?? maximumUncertainty) <= directHeadToHeadContextConfig.maxUncertainty
}

function addCappedDirectHeadToHeadAdjustment(adjustments: Map<string, number>, team: string, adjustment: number) {
  const next = (adjustments.get(team) ?? 0) + adjustment
  adjustments.set(team, Number(clamp(
    next,
    -directHeadToHeadContextConfig.maxAdjustment,
    directHeadToHeadContextConfig.maxAdjustment,
  ).toFixed(1)))
}

function daysBetween(date: string, lastDate: string) {
  return Math.max(0, Math.floor((Date.parse(lastDate) - Date.parse(date)) / 86_400_000))
}

function makeDisplayRatings(
  ratings: Map<string, number>,
  teams: Record<string, TeamProfile>,
  leagueScores: Map<string, number>,
  leagueMatchCounts: Map<string, number>,
  rosterPriorOffsets: Map<string, number>,
  momentums: Map<string, number>,
  uncertainties: Map<string, number>,
  wins: Map<string, number>,
  losses: Map<string, number>,
  teamRosterBasis: Map<string, RosterBasis>,
  directHeadToHeadContextAdjustments = new Map<string, number>(),
) {
  return new Map(
    Array.from(ratings.entries()).map(([team, rating]) => {
      const league = teams[team]?.league ?? 'Unknown'
      const leagueScore = effectiveLeagueRating(league, leagueScores.get(league) ?? leaguePriorFor(league), leagueMatchCounts.get(league) ?? 0)
      const uncertainty = uncertainties.get(team) ?? maximumUncertainty
      const matchCount = (wins.get(team) ?? 0) + (losses.get(team) ?? 0)
      const publishedLeagueScore = evidenceWeightedPublishedLeagueAnchor(leagueScore, matchCount)
      return [team, ratingFromComponents(ratingComponents({
        teamRating: rating,
        leagueScore: publishedLeagueScore,
        rosterPriorOffset: publishedRosterPriorOffset(
          rosterPriorOffsets.get(team) ?? 0,
          wins.get(team) ?? 0,
          losses.get(team) ?? 0,
        ),
        momentum: momentums.get(team) ?? 0,
        contextAdjustment: publishedLeagueAnchorContextAdjustment({
          leagueScore: publishedLeagueScore,
          teamRating: rating,
          wins: wins.get(team) ?? 0,
          losses: losses.get(team) ?? 0,
          uncertainty,
          rosterBasis: teamRosterBasis.get(team),
        }) + (directHeadToHeadContextAdjustments.get(team) ?? 0),
        uncertainty,
      }))]
    }),
  )
}

function confidenceFor({
  history,
  uncertainty,
  eligibility,
  rosterBasis,
  lastDate,
}: {
  history: TeamHistoryPoint[]
  uncertainty: number
  eligibility: TeamStanding['eligibility']
  rosterBasis: RosterBasis
  lastDate: string
}) {
  const volume = clamp(history.length / 20, 0, 1)
  const daysSinceLastMatch = history.at(-1)?.date ? daysBetween(history.at(-1)!.date, lastDate) : 365
  const recency = clamp(1 - daysSinceLastMatch / 120, 0, 1)
  const uncertaintyEvidence = clamp((maximumUncertainty - uncertainty) / (maximumUncertainty - 35), 0, 1)
  const rosterEvidence = rosterBasis === 'sourced' ? 1 : rosterBasis === 'assumed-continuous' ? 0.55 : 0.3
  const base = 0.4 * volume + 0.25 * recency + 0.25 * uncertaintyEvidence + 0.1 * rosterEvidence
  const eligibilityScale = eligibility.eligible ? 1 : eligibility.reasons.includes('stale') ? 0.55 : 0.72
  return Math.min(99, Math.round(base * eligibilityScale * 100))
}

export function isDevelopmentalTeamName(team: string) {
  return /\b(?:academy|challengers?|youth)\b/i.test(team)
}
