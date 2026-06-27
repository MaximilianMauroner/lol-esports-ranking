import { eventTierConfig } from '../data/rankingConfig'
import { effectiveLeagueRating, leaguePriorFor, leagueTierFor } from '../data/leagueTiers'
import type {
  EventSummary,
  FactorBreakdown,
  LeagueStrength,
  MatchRecord,
  MatchRosterSnapshot,
  PregamePrediction,
  RatingComponents,
  RatingUpdateLedger,
  Region,
  SeasonSummary,
  TeamHistoryPoint,
  TeamProfile,
  TeamStanding,
} from '../types'
import { evaluateTeamEligibility } from './eligibility'
import {
  executionResidualPredictionWeight,
  executionResidualShadowWeight,
  executionSoftOutcome,
  teamExecutionIndex,
} from './executionResidual'
import { ensureLeague, updateLeagueStrengthForMatch } from './leagueRatings'
import { homeLeagueForMatch, matchesByDate, sourceTraceFor } from './matchContext'
import { buildEventSummaries, buildLeagueStrengths, buildSeasonSummaries } from './modelSummaries'
import { buildPregamePlayerRatingEdges } from './playerModel'
import {
  applyCompletedPlacementResiduals,
  buildEventTrackers,
  startEventTrackersForDate,
  trackMatchForPlacement,
} from './placementResiduals'
import { predictionSegmentsFor, recordTeamContext } from './predictionContext'
import { predictionVariantFromWinProbability } from './predictionVariants'
import { applyContextDecayToRatingChannels } from './ratingContext'
import {
  applyMomentumBoundaryDecay,
  clamp,
  emptyRatingUpdateLedger,
  expectedScore,
  gameKFor,
  leagueAdjustment,
  momentumDelta,
  nextUncertainty,
  normalize,
  powerRating,
  ratingComponents,
  ratingFromComponents,
  recencyWeight,
  roundedRatingUpdateLedger,
  rosterVolatilityMultiplier,
  uncertaintyKMultiplier,
} from './ratingCalculations'
import { applyRosterContinuityForDate, roundedContinuity } from './rosterContinuityRating'
import { rosterBasisByTeam } from './rosters'
import { recordSideAdjustmentSample, sideAdjustmentFor, sideAdjustmentsFromSamples, type SideAdjustmentSamples } from './sideAdjustments'
import { neutralWinProbability } from './winProbability'
import {
  initialLeagueRating,
  initialTeamRating,
  leagueEloWeight,
  maximumUncertainty,
  momentumCap,
  momentumGameDecay,
  normalPatchTeamRetention,
  playerRatingPredictionWeight,
  playerRatingShadowWeight,
  ratingUpdateRecencyWeight,
  recencyDecayDays,
  recencyFloor,
  recencyRange,
  seasonStartLeagueRetention,
  seasonStartTeamRetention,
  splitBreakLeagueRetention,
  splitBreakMinimumGapDays,
  splitBreakTeamRetention,
  transparentGprModelMetadata,
} from './modelConfig'

export { buildPlayerModel } from './playerModel'
export { factorLabel, transparentGprModelMetadata } from './modelConfig'

export function buildRankingModel(
  matches: MatchRecord[],
  teams: Record<string, TeamProfile>,
): {
  standings: TeamStanding[]
  leagues: LeagueStrength[]
  events: EventSummary[]
  seasons: SeasonSummary[]
  regions: Region[]
  predictions: PregamePrediction[]
} {
  const sortedMatches = matches.toSorted((a, b) => a.date.localeCompare(b.date))
  const pregamePlayerRatingEdges = buildPregamePlayerRatingEdges(sortedMatches, { teams })
  const teamRosterBasis = rosterBasisByTeam(sortedMatches)
  const ratings = new Map<string, number>()
  const executionRatings = new Map<string, number>()
  const previousDisplayRatings = new Map<string, number>()
  const momentums = new Map<string, number>()
  const rosterPriorOffsets = new Map<string, number>()
  const latestRatingUpdates = new Map<string, RatingUpdateLedger>()
  const leaguePlacementDeltas = new Map<string, number>()
  const wins = new Map<string, number>()
  const losses = new Map<string, number>()
  const forms = new Map<string, string[]>()
  const histories = new Map<string, TeamHistoryPoint[]>()
  const factorSums = new Map<string, FactorBreakdown>()
  const factorCounts = new Map<string, number>()
  const leagueScores = new Map<string, number>()
  const previousLeagueScores = new Map<string, number>()
  const uncertainties = new Map<string, number>()
  const leagueWins = new Map<string, number>()
  const leagueLosses = new Map<string, number>()
  const leagueExpectedWins = new Map<string, number>()
  const leagueOpponentRatingSums = new Map<string, number>()
  const leagueForms = new Map<string, string[]>()
  const leagueMatchCounts = new Map<string, number>()
  const leagueLastEvents = new Map<string, string>()
  const leagueLastUpdated = new Map<string, string>()
  const predictions: PregamePrediction[] = []
  const lastDate = sortedMatches.at(-1)?.date ?? new Date().toISOString().slice(0, 10)
  const sideAdjustmentSamples: SideAdjustmentSamples = new Map()
  const lastRosterByTeam = new Map<string, MatchRosterSnapshot>()
  const currentRosterContinuity = new Map<string, number>()
  const lastPatchByTeam = new Map<string, string>()
  const lastRosterFingerprintByTeam = new Map<string, string>()
  const eventTrackers = buildEventTrackers(sortedMatches)
  let previousMatch: MatchRecord | undefined

  for (const team of Object.keys(teams)) {
    ratings.set(team, initialTeamRating)
    executionRatings.set(team, initialTeamRating)
    previousDisplayRatings.set(team, initialTeamRating)
    momentums.set(team, 0)
    rosterPriorOffsets.set(team, 0)
    latestRatingUpdates.set(team, emptyRatingUpdateLedger())
    uncertainties.set(team, maximumUncertainty)
    wins.set(team, 0)
    losses.set(team, 0)
    forms.set(team, [])
    histories.set(team, [])
    factorSums.set(team, { context: 0, recency: 0, execution: 0, opponent: 0, league: 0.5 })
    factorCounts.set(team, 0)
    ensureLeague(teams[team]?.league ?? 'Unknown', leagueScores, previousLeagueScores, leagueWins, leagueLosses, leagueExpectedWins, leagueOpponentRatingSums, leagueForms, leagueMatchCounts)
  }

  let processedMatchCount = 0
  for (const dateMatches of matchesByDate(sortedMatches)) {
    const firstMatch = dateMatches[0]
    if (!firstMatch) continue

    applyCompletedPlacementResiduals({
      cutoffDate: firstMatch.date,
      eventTrackers,
      teams,
      ratings,
      leagueScores,
      previousLeagueScores,
      leagueLastEvents,
      leagueLastUpdated,
      leaguePlacementDeltas,
      latestRatingUpdates,
    })

    applyContextDecayToRatingChannels(
      firstMatch,
      previousMatch,
      teams,
      [ratings, executionRatings],
      leagueScores,
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
    applyMomentumBoundaryDecay(firstMatch, previousMatch, momentums)

    for (const match of dateMatches) {
      ensureMatchEntities(match, teams, ratings, executionRatings, previousDisplayRatings, momentums, rosterPriorOffsets, latestRatingUpdates, wins, losses, forms, histories, factorSums, factorCounts, uncertainties)
      ensureLeague(homeLeagueForMatch(match, 'A', teams), leagueScores, previousLeagueScores, leagueWins, leagueLosses, leagueExpectedWins, leagueOpponentRatingSums, leagueForms, leagueMatchCounts)
      ensureLeague(homeLeagueForMatch(match, 'B', teams), leagueScores, previousLeagueScores, leagueWins, leagueLosses, leagueExpectedWins, leagueOpponentRatingSums, leagueForms, leagueMatchCounts)
    }

    applyRosterContinuityForDate(dateMatches, ratings, executionRatings, uncertainties, lastRosterByTeam, currentRosterContinuity)
    startEventTrackersForDate(dateMatches, eventTrackers, teams, ratings, momentums, rosterPriorOffsets, uncertainties, leagueScores, leagueMatchCounts)

    const sideAdjustments = sideAdjustmentsFromSamples(sideAdjustmentSamples)
    for (const match of dateMatches) {
      const leagueA = homeLeagueForMatch(match, 'A', teams)
      const leagueB = homeLeagueForMatch(match, 'B', teams)
      const ratingA = ratings.get(match.teamA) ?? initialTeamRating
      const ratingB = ratings.get(match.teamB) ?? initialTeamRating
      const executionRatingA = executionRatings.get(match.teamA) ?? initialTeamRating
      const executionRatingB = executionRatings.get(match.teamB) ?? initialTeamRating
      const leagueScoreA = effectiveLeagueRating(leagueA, leagueScores.get(leagueA) ?? leaguePriorFor(leagueA), leagueMatchCounts.get(leagueA) ?? 0)
      const leagueScoreB = effectiveLeagueRating(leagueB, leagueScores.get(leagueB) ?? leaguePriorFor(leagueB), leagueMatchCounts.get(leagueB) ?? 0)
      const powerRatingA = powerRating(ratingA, leagueScoreA)
      const powerRatingB = powerRating(ratingB, leagueScoreB)
      const executionPowerRatingA = powerRating(executionRatingA, leagueScoreA)
      const executionPowerRatingB = powerRating(executionRatingB, leagueScoreB)
      const executionResidualAdjustmentA = executionPowerRatingA - powerRatingA
      const executionResidualAdjustmentB = executionPowerRatingB - powerRatingB
      const playerRatingEdge = pregamePlayerRatingEdges.get(match.id)
      const playerRatingAdjustmentA = playerRatingEdge?.teamAAdjustment ?? 0
      const playerRatingAdjustmentB = playerRatingEdge?.teamBAdjustment ?? 0
      const rosterPriorOffsetA = playerRatingAdjustmentA * playerRatingPredictionWeight
      const rosterPriorOffsetB = playerRatingAdjustmentB * playerRatingPredictionWeight
      rosterPriorOffsets.set(match.teamA, rosterPriorOffsetA)
      rosterPriorOffsets.set(match.teamB, rosterPriorOffsetB)
      const momentumA = momentums.get(match.teamA) ?? 0
      const momentumB = momentums.get(match.teamB) ?? 0
      const noExecutionRatingA = powerRatingA + rosterPriorOffsetA + momentumA
      const noExecutionRatingB = powerRatingB + rosterPriorOffsetB + momentumB
      const predictionRatingA = noExecutionRatingA + executionResidualAdjustmentA * executionResidualPredictionWeight
      const predictionRatingB = noExecutionRatingB + executionResidualAdjustmentB * executionResidualPredictionWeight
      const sideAdjustmentA = sideAdjustmentFor(match, 'A', sideAdjustments)
      const sideAdjustmentB = sideAdjustmentFor(match, 'B', sideAdjustments)
      const publishedRatingA = predictionRatingA + sideAdjustmentA
      const publishedRatingB = predictionRatingB + sideAdjustmentB
      const playerAdjustedRatingA = powerRatingA + playerRatingAdjustmentA * playerRatingShadowWeight + momentumA
      const playerAdjustedRatingB = powerRatingB + playerRatingAdjustmentB * playerRatingShadowWeight + momentumB
      const executionAdjustedRatingA = noExecutionRatingA + executionResidualAdjustmentA * executionResidualShadowWeight
      const executionAdjustedRatingB = noExecutionRatingB + executionResidualAdjustmentB * executionResidualShadowWeight
      const teamOnlyPrediction = neutralWinProbability(
        { team: match.teamA, rating: powerRatingA, uncertainty: uncertainties.get(match.teamA) ?? maximumUncertainty },
        { team: match.teamB, rating: powerRatingB, uncertainty: uncertainties.get(match.teamB) ?? maximumUncertainty },
        match.bestOf,
      )
      const executionBaselinePrediction = neutralWinProbability(
        { team: match.teamA, rating: noExecutionRatingA, uncertainty: uncertainties.get(match.teamA) ?? maximumUncertainty },
        { team: match.teamB, rating: noExecutionRatingB, uncertainty: uncertainties.get(match.teamB) ?? maximumUncertainty },
        match.bestOf,
      )
      const publishedPrediction = neutralWinProbability(
        { team: match.teamA, rating: publishedRatingA, uncertainty: uncertainties.get(match.teamA) ?? maximumUncertainty },
        { team: match.teamB, rating: publishedRatingB, uncertainty: uncertainties.get(match.teamB) ?? maximumUncertainty },
        match.bestOf,
      )
      const playerAdjustedPrediction = neutralWinProbability(
        { team: match.teamA, rating: playerAdjustedRatingA, uncertainty: uncertainties.get(match.teamA) ?? maximumUncertainty },
        { team: match.teamB, rating: playerAdjustedRatingB, uncertainty: uncertainties.get(match.teamB) ?? maximumUncertainty },
        match.bestOf,
      )
      const executionAdjustedPrediction = neutralWinProbability(
        { team: match.teamA, rating: executionAdjustedRatingA, uncertainty: uncertainties.get(match.teamA) ?? maximumUncertainty },
        { team: match.teamB, rating: executionAdjustedRatingB, uncertainty: uncertainties.get(match.teamB) ?? maximumUncertainty },
        match.bestOf,
      )
      const variants = {
        published: predictionVariantFromWinProbability(publishedPrediction, publishedRatingA, publishedRatingB),
        'team-only': predictionVariantFromWinProbability(teamOnlyPrediction, powerRatingA, powerRatingB),
        'player-adjusted': predictionVariantFromWinProbability(playerAdjustedPrediction, playerAdjustedRatingA, playerAdjustedRatingB),
        'execution-baseline': predictionVariantFromWinProbability(executionBaselinePrediction, noExecutionRatingA, noExecutionRatingB),
        'execution-adjusted': predictionVariantFromWinProbability(executionAdjustedPrediction, executionAdjustedRatingA, executionAdjustedRatingB),
      }
      predictions.push({
        id: match.id,
        date: match.date,
        event: match.event,
        patch: match.patch,
        bestOf: publishedPrediction.bestOf,
        teamA: match.teamA,
        teamB: match.teamB,
        teamASide: match.teamASide,
        teamBSide: match.teamBSide,
        actualWinner: match.winner,
        predictedWinner: publishedPrediction.teamAGameWinProbability >= 0.5 ? match.teamA : match.teamB,
        teamAGameWinProbability: publishedPrediction.teamAGameWinProbability,
        teamBGameWinProbability: publishedPrediction.teamBGameWinProbability,
        teamASeriesWinProbability: publishedPrediction.teamASeriesWinProbability,
        teamBSeriesWinProbability: publishedPrediction.teamBSeriesWinProbability,
        teamAGameWinProbabilityTeamOnly: teamOnlyPrediction.teamAGameWinProbability,
        teamBGameWinProbabilityTeamOnly: teamOnlyPrediction.teamBGameWinProbability,
        teamASeriesWinProbabilityTeamOnly: teamOnlyPrediction.teamASeriesWinProbability,
        teamBSeriesWinProbabilityTeamOnly: teamOnlyPrediction.teamBSeriesWinProbability,
        teamAGameWinProbabilityExecutionBaseline: executionBaselinePrediction.teamAGameWinProbability,
        teamBGameWinProbabilityExecutionBaseline: executionBaselinePrediction.teamBGameWinProbability,
        teamASeriesWinProbabilityExecutionBaseline: executionBaselinePrediction.teamASeriesWinProbability,
        teamBSeriesWinProbabilityExecutionBaseline: executionBaselinePrediction.teamBSeriesWinProbability,
        uncertaintyPenalty: publishedPrediction.uncertaintyPenalty,
        teamARating: Math.round(predictionRatingA),
        teamBRating: Math.round(predictionRatingB),
        teamAUncertainty: Math.round(uncertainties.get(match.teamA) ?? maximumUncertainty),
        teamBUncertainty: Math.round(uncertainties.get(match.teamB) ?? maximumUncertainty),
        teamAPregameWins: wins.get(match.teamA) ?? 0,
        teamAPregameLosses: losses.get(match.teamA) ?? 0,
        teamBPregameWins: wins.get(match.teamB) ?? 0,
        teamBPregameLosses: losses.get(match.teamB) ?? 0,
        teamARosterContinuity: roundedContinuity(currentRosterContinuity.get(match.teamA)),
        teamBRosterContinuity: roundedContinuity(currentRosterContinuity.get(match.teamB)),
        teamAPlayerRatingAdjustment: playerRatingAdjustmentA,
        teamBPlayerRatingAdjustment: playerRatingAdjustmentB,
        teamASideAdjustment: Number(sideAdjustmentA.toFixed(1)),
        teamBSideAdjustment: Number(sideAdjustmentB.toFixed(1)),
        teamAPlayerRatingCoverage: playerRatingEdge?.teamACoverage ?? 0,
        teamBPlayerRatingCoverage: playerRatingEdge?.teamBCoverage ?? 0,
        teamAGameWinProbabilityPlayerAdjusted: playerAdjustedPrediction.teamAGameWinProbability,
        teamBGameWinProbabilityPlayerAdjusted: playerAdjustedPrediction.teamBGameWinProbability,
        teamASeriesWinProbabilityPlayerAdjusted: playerAdjustedPrediction.teamASeriesWinProbability,
        teamBSeriesWinProbabilityPlayerAdjusted: playerAdjustedPrediction.teamBSeriesWinProbability,
        playerRatingPredictionWeight,
        teamAExecutionResidualAdjustment: Number(executionResidualAdjustmentA.toFixed(1)),
        teamBExecutionResidualAdjustment: Number(executionResidualAdjustmentB.toFixed(1)),
        teamAGameWinProbabilityExecutionAdjusted: executionAdjustedPrediction.teamAGameWinProbability,
        teamBGameWinProbabilityExecutionAdjusted: executionAdjustedPrediction.teamBGameWinProbability,
        teamASeriesWinProbabilityExecutionAdjusted: executionAdjustedPrediction.teamASeriesWinProbability,
        teamBSeriesWinProbabilityExecutionAdjusted: executionAdjustedPrediction.teamBSeriesWinProbability,
        executionResidualPredictionWeight,
        variants,
        segments: predictionSegmentsFor(match, teams, lastPatchByTeam, lastRosterFingerprintByTeam),
        trainingMatchCount: processedMatchCount,
        dataCutoff: previousMatch?.date,
        modelVersion: transparentGprModelMetadata.version,
        modelConfigHash: transparentGprModelMetadata.configHash,
        source: sourceTraceFor(match),
      })
    }

    for (const match of dateMatches) {
      const ratingA = ratings.get(match.teamA) ?? initialTeamRating
      const ratingB = ratings.get(match.teamB) ?? initialTeamRating
      const executionRatingA = executionRatings.get(match.teamA) ?? initialTeamRating
      const executionRatingB = executionRatings.get(match.teamB) ?? initialTeamRating
      const leagueA = homeLeagueForMatch(match, 'A', teams)
      const leagueB = homeLeagueForMatch(match, 'B', teams)
      const rawLeagueScoreA = leagueScores.get(leagueA) ?? leaguePriorFor(leagueA)
      const rawLeagueScoreB = leagueScores.get(leagueB) ?? leaguePriorFor(leagueB)
      const leagueScoreA = effectiveLeagueRating(leagueA, rawLeagueScoreA, leagueMatchCounts.get(leagueA) ?? 0)
      const leagueScoreB = effectiveLeagueRating(leagueB, rawLeagueScoreB, leagueMatchCounts.get(leagueB) ?? 0)
      const powerRatingA = powerRating(ratingA, leagueScoreA)
      const powerRatingB = powerRating(ratingB, leagueScoreB)
      const executionPowerRatingA = powerRating(executionRatingA, leagueScoreA)
      const executionPowerRatingB = powerRating(executionRatingB, leagueScoreB)
      const sideAdjustmentA = sideAdjustmentFor(match, 'A', sideAdjustments)
      const sideAdjustmentB = sideAdjustmentFor(match, 'B', sideAdjustments)
      const rosterPriorOffsetA = rosterPriorOffsets.get(match.teamA) ?? 0
      const rosterPriorOffsetB = rosterPriorOffsets.get(match.teamB) ?? 0
      const momentumA = momentums.get(match.teamA) ?? 0
      const momentumB = momentums.get(match.teamB) ?? 0
      const currentPowerRatingA = powerRatingA + rosterPriorOffsetA + momentumA
      const currentPowerRatingB = powerRatingB + rosterPriorOffsetB + momentumB
      const effectiveRatingA = currentPowerRatingA + sideAdjustmentA
      const effectiveRatingB = currentPowerRatingB + sideAdjustmentB
      const executionEffectiveRatingA = executionPowerRatingA + rosterPriorOffsetA + momentumA + sideAdjustmentA
      const executionEffectiveRatingB = executionPowerRatingB + rosterPriorOffsetB + momentumB + sideAdjustmentB
      const eventK = eventTierConfig[match.tier].kFactor
      const gameK = gameKFor(match)
      const uncertaintyA = uncertainties.get(match.teamA) ?? maximumUncertainty
      const uncertaintyB = uncertainties.get(match.teamB) ?? maximumUncertainty
      const effectiveGameKA = gameK * uncertaintyKMultiplier(uncertaintyA) * rosterVolatilityMultiplier(currentRosterContinuity.get(match.teamA))
      const effectiveGameKB = gameK * uncertaintyKMultiplier(uncertaintyB) * rosterVolatilityMultiplier(currentRosterContinuity.get(match.teamB))
      const factorRecency = recencyWeight(match.date, lastDate)
      const expectedA = expectedScore(effectiveRatingA, effectiveRatingB)
      const expectedB = 1 - expectedA
      const aWon = match.winner === match.teamA
      const resultResidualA = (aWon ? 1 : 0) - expectedA
      const resultResidualB = (aWon ? 0 : 1) - expectedB
      const deltaA = Math.round(effectiveGameKA * ratingUpdateRecencyWeight * resultResidualA)
      const deltaB = Math.round(effectiveGameKB * ratingUpdateRecencyWeight * resultResidualB)
      const executionExpectedA = expectedScore(executionEffectiveRatingA, executionEffectiveRatingB)
      const executionExpectedB = 1 - executionExpectedA
      const executionOutcomeA = executionSoftOutcome(aWon ? 1 : 0, teamExecutionIndex(match, 'A'))
      const executionOutcomeB = executionSoftOutcome(aWon ? 0 : 1, teamExecutionIndex(match, 'B'))
      const executionDeltaA = Math.round(gameK * ratingUpdateRecencyWeight * (executionOutcomeA - executionExpectedA))
      const executionDeltaB = Math.round(gameK * ratingUpdateRecencyWeight * (executionOutcomeB - executionExpectedB))

      previousDisplayRatings.set(match.teamA, currentPowerRatingA)
      previousDisplayRatings.set(match.teamB, currentPowerRatingB)
      ratings.set(match.teamA, ratingA + deltaA)
      ratings.set(match.teamB, ratingB + deltaB)
      executionRatings.set(match.teamA, executionRatingA + executionDeltaA)
      executionRatings.set(match.teamB, executionRatingB + executionDeltaB)
      const nextUncertaintyA = nextUncertainty(uncertaintyA, match, leagueA, leagueB)
      const nextUncertaintyB = nextUncertainty(uncertaintyB, match, leagueB, leagueA)
      uncertainties.set(match.teamA, nextUncertaintyA)
      uncertainties.set(match.teamB, nextUncertaintyB)
      const leagueDelta = updateLeagueStrengthForMatch({
        match,
        leagueA,
        leagueB,
        leagueScoreA: rawLeagueScoreA,
        leagueScoreB: rawLeagueScoreB,
        leagueExpectedRatingA: effectiveRatingA,
        leagueExpectedRatingB: effectiveRatingB,
        aWon,
        recency: ratingUpdateRecencyWeight,
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
      })
      const updatedLeagueScoreA = effectiveLeagueRating(leagueA, leagueScores.get(leagueA) ?? leaguePriorFor(leagueA), leagueMatchCounts.get(leagueA) ?? 0)
      const updatedLeagueScoreB = effectiveLeagueRating(leagueB, leagueScores.get(leagueB) ?? leaguePriorFor(leagueB), leagueMatchCounts.get(leagueB) ?? 0)
      const updatedLeagueAdjustmentA = leagueAdjustment(ratingA + deltaA, updatedLeagueScoreA)
      const updatedLeagueAdjustmentB = leagueAdjustment(ratingB + deltaB, updatedLeagueScoreB)
      const momentumDeltaA = momentumDelta(resultResidualA, executionOutcomeA - executionExpectedA)
      const momentumDeltaB = momentumDelta(resultResidualB, executionOutcomeB - executionExpectedB)
      const updatedMomentumA = clamp(momentumA * momentumGameDecay + momentumDeltaA, -momentumCap, momentumCap)
      const updatedMomentumB = clamp(momentumB * momentumGameDecay + momentumDeltaB, -momentumCap, momentumCap)
      momentums.set(match.teamA, updatedMomentumA)
      momentums.set(match.teamB, updatedMomentumB)
      const updatedComponentsA = ratingComponents({
        teamRating: ratingA + deltaA,
        leagueScore: updatedLeagueScoreA,
        rosterPriorOffset: rosterPriorOffsetA,
        momentum: updatedMomentumA,
        contextAdjustment: 0,
        uncertainty: nextUncertaintyA,
      })
      const updatedComponentsB = ratingComponents({
        teamRating: ratingB + deltaB,
        leagueScore: updatedLeagueScoreB,
        rosterPriorOffset: rosterPriorOffsetB,
        momentum: updatedMomentumB,
        contextAdjustment: 0,
        uncertainty: nextUncertaintyB,
      })
      const updatedPowerRatingA = ratingFromComponents(updatedComponentsA)
      const updatedPowerRatingB = ratingFromComponents(updatedComponentsB)
      const updateLedgerA = roundedRatingUpdateLedger({
        teamStableDelta: deltaA,
        leagueGameDelta: leagueDelta.deltaA,
        leaguePlacementDelta: 0,
        momentumDelta: updatedMomentumA - momentumA,
        rosterPriorDelta: 0,
        uncertaintyDelta: nextUncertaintyA - uncertaintyA,
        sideAdjustment: sideAdjustmentA,
        patchAdjustment: 0,
      })
      const updateLedgerB = roundedRatingUpdateLedger({
        teamStableDelta: deltaB,
        leagueGameDelta: leagueDelta.deltaB,
        leaguePlacementDelta: 0,
        momentumDelta: updatedMomentumB - momentumB,
        rosterPriorDelta: 0,
        uncertaintyDelta: nextUncertaintyB - uncertaintyB,
        sideAdjustment: sideAdjustmentB,
        patchAdjustment: 0,
      })
      latestRatingUpdates.set(match.teamA, updateLedgerA)
      latestRatingUpdates.set(match.teamB, updateLedgerB)

      updateRecord(match.teamA, aWon, wins, losses, forms)
      updateRecord(match.teamB, !aWon, wins, losses, forms)
      addFactors(match.teamA, {
        context: normalize(eventK, 12, 34),
        recency: factorRecency,
        execution: aWon ? 1 : 0,
        opponent: normalize(effectiveRatingB, 1350, 1700),
        league: normalize(leagueScoreA + Math.max(0, leagueDelta.deltaA), 1440, 1560),
      }, factorSums, factorCounts)
      addFactors(match.teamB, {
        context: normalize(eventK, 12, 34),
        recency: factorRecency,
        execution: aWon ? 0 : 1,
        opponent: normalize(effectiveRatingA, 1350, 1700),
        league: normalize(leagueScoreB + Math.max(0, leagueDelta.deltaB), 1440, 1560),
      }, factorSums, factorCounts)
      appendHistory(match, match.teamA, match.teamB, updatedPowerRatingA, ratingA + deltaA, updatedLeagueAdjustmentA, sideAdjustmentA, updatedComponentsA, updateLedgerA, updatedPowerRatingA - currentPowerRatingA, aWon, histories)
      appendHistory(match, match.teamB, match.teamA, updatedPowerRatingB, ratingB + deltaB, updatedLeagueAdjustmentB, sideAdjustmentB, updatedComponentsB, updateLedgerB, updatedPowerRatingB - currentPowerRatingB, !aWon, histories)
      recordSideAdjustmentSample(match, sideAdjustmentSamples)
      recordTeamContext(match, lastRosterByTeam, lastPatchByTeam, lastRosterFingerprintByTeam)
      trackMatchForPlacement(eventTrackers, match, teams)
      previousMatch = match
      processedMatchCount += 1
    }
  }

  applyCompletedPlacementResiduals({
    cutoffDate: undefined,
    eventTrackers,
    teams,
    ratings,
    leagueScores,
    previousLeagueScores,
    leagueLastEvents,
    leagueLastUpdated,
    leaguePlacementDeltas,
    latestRatingUpdates,
  })

  const displayRatings = makeDisplayRatings(ratings, teams, leagueScores, leagueMatchCounts, rosterPriorOffsets, momentums, uncertainties)
  const currentRanks = makeRankMap(displayRatings)
  const previousRankMap = makeRankMap(previousDisplayRatings)
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

  const standings = Array.from(displayRatings.entries())
    .map(([team, displayRating]) => {
      const profile = teams[team] ?? { name: team, code: team.slice(0, 3).toUpperCase(), region: 'International' as Region, league: 'Unknown' }
      const baseRating = ratings.get(team) ?? initialTeamRating
      const leagueTier = leagueTierFor(profile.league)
      const leagueScore = effectiveLeagueRating(profile.league, leagueScores.get(profile.league) ?? leagueTier.priorRating, leagueMatchCounts.get(profile.league) ?? 0)
      const previousLeagueScore = effectiveLeagueRating(profile.league, previousLeagueScores.get(profile.league) ?? leagueTier.priorRating, leagueMatchCounts.get(profile.league) ?? 0)
      const currentLeagueAdjustment = leagueAdjustment(baseRating, leagueScore)
      const components = ratingComponents({
        teamRating: baseRating,
        leagueScore,
        rosterPriorOffset: rosterPriorOffsets.get(team) ?? 0,
        momentum: momentums.get(team) ?? 0,
        contextAdjustment: 0,
        uncertainty: uncertainties.get(team) ?? maximumUncertainty,
      })
      const priorDisplayRating = previousDisplayRatings.get(team) ?? initialTeamRating
      const factors = averageFactors(factorSums.get(team), factorCounts.get(team) ?? 0)
      const history = histories.get(team) ?? []
      const recentEvents = Array.from(new Set(history.slice(-4).map((point) => point.event))).reverse()
      const rank = currentRanks.get(team) ?? 999
      const previousRank = previousRankMap.get(team) ?? rank

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
        rating: Math.round(displayRating),
        previousRating: Math.round(priorDisplayRating),
        delta: Math.round(displayRating - priorDisplayRating),
        rank,
        previousRank,
        movement: previousRank - rank,
        wins: wins.get(team) ?? 0,
        losses: losses.get(team) ?? 0,
        confidence: confidenceFor(history, displayRating, standingsSpread(displayRatings)),
        uncertainty: Math.round(uncertainties.get(team) ?? maximumUncertainty),
        form: forms.get(team) ?? [],
        strongestFactor: strongestFactor(factors),
        eligibility: evaluateTeamEligibility({
          history,
          lastDate,
          uncertainty: Math.round(uncertainties.get(team) ?? maximumUncertainty),
          leagueTier: leagueTier.tier,
          leagueInternationalMatches: leagueMatchCounts.get(profile.league) ?? 0,
          isDevelopmentalTeam: isDevelopmentalTeamName(team),
        }),
        factors,
        history,
        recentEvents,
      }
    })
    .sort((a, b) => Number(b.eligibility.eligible) - Number(a.eligibility.eligible) || b.rating - a.rating)
    .map((standing, index) => ({ ...standing, rank: index + 1 }))

  return {
    standings,
    leagues,
    events: buildEventSummaries(sortedMatches, histories),
    seasons: buildSeasonSummaries(sortedMatches, standings),
    regions: Array.from(new Set(standings.map((standing) => standing.region))).sort(),
    predictions,
  }
}

function ensureMatchEntities(
  match: MatchRecord,
  teams: Record<string, TeamProfile>,
  ratings: Map<string, number>,
  executionRatings: Map<string, number>,
  previousDisplayRatings: Map<string, number>,
  momentums: Map<string, number>,
  rosterPriorOffsets: Map<string, number>,
  latestRatingUpdates: Map<string, RatingUpdateLedger>,
  wins: Map<string, number>,
  losses: Map<string, number>,
  forms: Map<string, string[]>,
  histories: Map<string, TeamHistoryPoint[]>,
  factorSums: Map<string, FactorBreakdown>,
  factorCounts: Map<string, number>,
  uncertainties: Map<string, number>,
) {
  ensureTeam(match.teamA, teams, ratings, previousDisplayRatings, momentums, rosterPriorOffsets, latestRatingUpdates, wins, losses, forms, histories, factorSums, factorCounts)
  ensureTeam(match.teamB, teams, ratings, previousDisplayRatings, momentums, rosterPriorOffsets, latestRatingUpdates, wins, losses, forms, histories, factorSums, factorCounts)
  if (!executionRatings.has(match.teamA)) executionRatings.set(match.teamA, initialTeamRating)
  if (!executionRatings.has(match.teamB)) executionRatings.set(match.teamB, initialTeamRating)
  if (!uncertainties.has(match.teamA)) uncertainties.set(match.teamA, maximumUncertainty)
  if (!uncertainties.has(match.teamB)) uncertainties.set(match.teamB, maximumUncertainty)
}

function ensureTeam(
  team: string,
  teams: Record<string, TeamProfile>,
  ratings: Map<string, number>,
  previousDisplayRatings: Map<string, number>,
  momentums: Map<string, number>,
  rosterPriorOffsets: Map<string, number>,
  latestRatingUpdates: Map<string, RatingUpdateLedger>,
  wins: Map<string, number>,
  losses: Map<string, number>,
  forms: Map<string, string[]>,
  histories: Map<string, TeamHistoryPoint[]>,
  factorSums: Map<string, FactorBreakdown>,
  factorCounts: Map<string, number>,
) {
  if (ratings.has(team)) return
  ratings.set(team, initialTeamRating)
  previousDisplayRatings.set(team, initialTeamRating)
  momentums.set(team, 0)
  rosterPriorOffsets.set(team, 0)
  latestRatingUpdates.set(team, emptyRatingUpdateLedger())
  wins.set(team, 0)
  losses.set(team, 0)
  forms.set(team, [])
  histories.set(team, [])
  factorSums.set(team, { context: 0, recency: 0, execution: 0, opponent: 0, league: 0.5 })
  factorCounts.set(team, 0)
  if (!teams[team]) {
    teams[team] = { name: team, code: team.slice(0, 3).toUpperCase(), region: 'International', league: 'Unknown' }
  }
}

function updateRecord(
  team: string,
  won: boolean,
  wins: Map<string, number>,
  losses: Map<string, number>,
  forms: Map<string, string[]>,
) {
  if (won) wins.set(team, (wins.get(team) ?? 0) + 1)
  else losses.set(team, (losses.get(team) ?? 0) + 1)
  forms.set(team, [...(forms.get(team) ?? []), won ? 'W' : 'L'].slice(-5))
}

function addFactors(
  team: string,
  next: FactorBreakdown,
  factorSums: Map<string, FactorBreakdown>,
  factorCounts: Map<string, number>,
) {
  const current = factorSums.get(team) ?? { context: 0, recency: 0, execution: 0, opponent: 0, league: 0.5 }
  factorSums.set(team, {
    context: current.context + next.context,
    recency: current.recency + next.recency,
    execution: current.execution + next.execution,
    opponent: current.opponent + next.opponent,
    league: current.league + next.league,
  })
  factorCounts.set(team, (factorCounts.get(team) ?? 0) + 1)
}

function appendHistory(
  match: MatchRecord,
  team: string,
  opponent: string,
  rating: number,
  baseRating: number,
  teamLeagueAdjustment: number,
  sideAdjustment: number,
  components: RatingComponents,
  update: RatingUpdateLedger,
  delta: number,
  won: boolean,
  histories: Map<string, TeamHistoryPoint[]>,
) {
  const snapshotRanks = makeRankMap(new Map([[team, rating], [opponent, rating - delta]]))
  histories.set(team, [
    ...(histories.get(team) ?? []),
    {
      date: match.date,
      event: match.event,
      opponent,
      rating: Math.round(rating),
      baseRating: Math.round(baseRating),
      leagueAdjustment: teamLeagueAdjustment,
      sideAdjustment,
      ratingComponents: components,
      ratingUpdate: update,
      rank: snapshotRanks.get(team) ?? 1,
      delta: Math.round(delta),
      tier: match.tier,
      result: won ? 'W' : 'L',
      source: {
        ...sourceTraceFor(match),
      },
    },
  ])
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

function makeRankMap(ratings: Map<string, number>) {
  return new Map(
    Array.from(ratings.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([team], index) => [team, index + 1]),
  )
}

function makeDisplayRatings(
  ratings: Map<string, number>,
  teams: Record<string, TeamProfile>,
  leagueScores: Map<string, number>,
  leagueMatchCounts: Map<string, number>,
  rosterPriorOffsets: Map<string, number>,
  momentums: Map<string, number>,
  uncertainties: Map<string, number>,
) {
  return new Map(
    Array.from(ratings.entries()).map(([team, rating]) => {
      const league = teams[team]?.league ?? 'Unknown'
      const leagueScore = effectiveLeagueRating(league, leagueScores.get(league) ?? leaguePriorFor(league), leagueMatchCounts.get(league) ?? 0)
      return [team, ratingFromComponents(ratingComponents({
        teamRating: rating,
        leagueScore,
        rosterPriorOffset: rosterPriorOffsets.get(team) ?? 0,
        momentum: momentums.get(team) ?? 0,
        contextAdjustment: 0,
        uncertainty: uncertainties.get(team) ?? maximumUncertainty,
      }))]
    }),
  )
}

function confidenceFor(history: TeamHistoryPoint[], rating: number, spread: number) {
  const volume = clamp(history.length / 12, 0, 1)
  const recent = history.slice(-5).length / 5
  const separation = clamp(spread / Math.max(Math.abs(rating - 1500), 80), 0, 1)
  return Math.round((0.45 * volume + 0.35 * recent + 0.2 * separation) * 100)
}

export function isDevelopmentalTeamName(team: string) {
  return /\b(?:academy|challengers?|youth)\b/i.test(team)
}

function standingsSpread(ratings: Map<string, number>) {
  const values = Array.from(ratings.values())
  return Math.max(...values) - Math.min(...values)
}
