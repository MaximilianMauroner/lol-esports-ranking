import { effectiveLeagueRating, leaguePriorFor, leagueTierFor } from '../data/leagueTiers'
import type {
  FactorBreakdown,
  LeagueStrengthHistoryPoint,
  MatchRecord,
  PregamePrediction,
  RatingComponents,
  RatingUpdateLedger,
  Region,
  TeamHistoryPoint,
  TeamProfile,
} from '../types'
import {
  executionResidualPredictionWeight,
  executionResidualShadowWeight,
  executionSoftOutcome,
  teamExecutionIndex,
} from './executionResidual'
import { eventKFactorForMatch, eventWeightForMatch, leagueKFactorForMatch } from './eventWeighting'
import { updateLeagueStrengthForSeries } from './leagueRatings'
import { homeLeagueForMatch, sourceTraceFor } from './matchContext'
import type { PregamePlayerRatingEdge } from './playerModel'
import { trackMatchForPlacement } from './placementResiduals'
import { predictionSegmentsFor, recordTeamContext } from './predictionContext'
import { predictionVariantFromWinProbability } from './predictionVariants'
import {
  clamp,
  expectedScore,
  gameKFor,
  isInternationalMatch,
  leagueAdjustment,
  normalize,
  nextUncertainty,
  powerRating,
  publishedRosterPriorOffset,
  ratingComponents,
  ratingFromComponents,
  recencyWeight,
  roundedRatingUpdateLedger,
  rosterVolatilityMultiplier,
  uncertaintyKMultiplier,
} from './ratingCalculations'
import type { RatingRunState } from './ratingRunState'
import { makeRankMap } from './ratingRunState'
import { roundedContinuity } from './rosterContinuityRating'
import { recordSideAdjustmentSample, sideAdjustmentFor } from './sideAdjustments'
import { resolveCanonicalSeries, type CanonicalSeries } from './seriesResolver'
import { neutralWinProbability } from './winProbability'
import {
  domesticStableTransferWeightsByTier,
  initialTeamRating,
  latentStrengthResultBudgetShares,
  maximumUncertainty,
  momentumCap,
  momentumGameDecay,
  playerRatingPredictionWeight,
  playerRatingShadowWeight,
  ratingUpdateRecencyWeight,
  transparentGprModelMetadata,
} from './modelConfig'

type PregamePlayerRatingEdges = Map<string, PregamePlayerRatingEdge>

type RatingBatchSnapshot = Pick<RatingRunState,
  'ratings' | 'executionRatings' | 'momentums' | 'rosterPriorOffsets' | 'uncertainties' | 'leagueScores' | 'leagueMatchCounts'
>

function ratingBatchSnapshot(state: RatingRunState): RatingBatchSnapshot {
  return {
    ratings: new Map(state.ratings),
    executionRatings: new Map(state.executionRatings),
    momentums: new Map(state.momentums),
    rosterPriorOffsets: new Map(state.rosterPriorOffsets),
    uncertainties: new Map(state.uncertainties),
    leagueScores: new Map(state.leagueScores),
    leagueMatchCounts: new Map(state.leagueMatchCounts),
  }
}

export function emitPregamePredictionsForDate({
  matches,
  teams,
  state,
  pregamePlayerRatingEdges,
  sideAdjustments,
}: {
  matches: MatchRecord[]
  teams: Record<string, TeamProfile>
  state: RatingRunState
  pregamePlayerRatingEdges: PregamePlayerRatingEdges
  sideAdjustments: Map<string, number>
}) {
  const batch = ratingBatchSnapshot(state)
  for (const series of resolveCanonicalSeries(matches).toSorted((left, right) => left.id.localeCompare(right.id))) {
    for (const match of series.games) {
      state.predictions.push(pregamePredictionForMatch({
        match,
        series,
        teams,
        state,
        batch,
        pregamePlayerRatingEdges,
        sideAdjustments,
      }))
    }
  }
}

export function processRatingSeriesForDate({
  matches,
  teams,
  state,
  sideAdjustments,
  lastDate,
  pregamePlayerRatingEdges,
}: {
  matches: MatchRecord[]
  teams: Record<string, TeamProfile>
  state: RatingRunState
  sideAdjustments: Map<string, number>
  lastDate: string
  pregamePlayerRatingEdges: PregamePlayerRatingEdges
}) {
  const batch = ratingBatchSnapshot(state)
  for (const series of ratingSeriesGroupsForDate(matches).toSorted((left, right) => left.key.localeCompare(right.key))) {
    processRatingSeries({ series, teams, state, batch, sideAdjustments, lastDate, pregamePlayerRatingEdges })
  }
}

function pregamePredictionForMatch({
  match,
  series,
  teams,
  state,
  batch,
  pregamePlayerRatingEdges,
  sideAdjustments,
}: {
  match: MatchRecord
  series: CanonicalSeries
  teams: Record<string, TeamProfile>
  state: RatingRunState
  batch: RatingBatchSnapshot
  pregamePlayerRatingEdges: PregamePlayerRatingEdges
  sideAdjustments: Map<string, number>
}): PregamePrediction {
  const leagueA = homeLeagueForMatch(match, 'A', teams)
  const leagueB = homeLeagueForMatch(match, 'B', teams)
  const ratingA = batch.ratings.get(match.teamA) ?? initialTeamRating
  const ratingB = batch.ratings.get(match.teamB) ?? initialTeamRating
  const executionRatingA = batch.executionRatings.get(match.teamA) ?? initialTeamRating
  const executionRatingB = batch.executionRatings.get(match.teamB) ?? initialTeamRating
  const leagueScoreA = effectiveLeagueRating(leagueA, batch.leagueScores.get(leagueA) ?? leaguePriorFor(leagueA), batch.leagueMatchCounts.get(leagueA) ?? 0)
  const leagueScoreB = effectiveLeagueRating(leagueB, batch.leagueScores.get(leagueB) ?? leaguePriorFor(leagueB), batch.leagueMatchCounts.get(leagueB) ?? 0)
  const powerRatingA = powerRating(ratingA, leagueScoreA)
  const powerRatingB = powerRating(ratingB, leagueScoreB)
  const executionPowerRatingA = powerRating(executionRatingA, leagueScoreA)
  const executionPowerRatingB = powerRating(executionRatingB, leagueScoreB)
  const executionResidualAdjustmentA = executionPowerRatingA - powerRatingA
  const executionResidualAdjustmentB = executionPowerRatingB - powerRatingB
  const playerRatingEdge = pregamePlayerRatingEdges.get(match.id)
  const playerRatingAdjustmentA = playerRatingEdge?.teamAAdjustment ?? 0
  const playerRatingAdjustmentB = playerRatingEdge?.teamBAdjustment ?? 0
  const { teamA: rosterPriorOffsetA, teamB: rosterPriorOffsetB } = rosterPriorOffsetsForMatch(match, pregamePlayerRatingEdges, batch.rosterPriorOffsets)
  const momentumA = batch.momentums.get(match.teamA) ?? 0
  const momentumB = batch.momentums.get(match.teamB) ?? 0
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
    { team: match.teamA, rating: powerRatingA, uncertainty: batch.uncertainties.get(match.teamA) ?? maximumUncertainty },
    { team: match.teamB, rating: powerRatingB, uncertainty: batch.uncertainties.get(match.teamB) ?? maximumUncertainty },
    series.format,
  )
  const executionBaselinePrediction = neutralWinProbability(
    { team: match.teamA, rating: noExecutionRatingA, uncertainty: batch.uncertainties.get(match.teamA) ?? maximumUncertainty },
    { team: match.teamB, rating: noExecutionRatingB, uncertainty: batch.uncertainties.get(match.teamB) ?? maximumUncertainty },
    series.format,
  )
  const publishedPrediction = neutralWinProbability(
    { team: match.teamA, rating: publishedRatingA, uncertainty: batch.uncertainties.get(match.teamA) ?? maximumUncertainty },
    { team: match.teamB, rating: publishedRatingB, uncertainty: batch.uncertainties.get(match.teamB) ?? maximumUncertainty },
    series.format,
  )
  const playerAdjustedPrediction = neutralWinProbability(
    { team: match.teamA, rating: playerAdjustedRatingA, uncertainty: batch.uncertainties.get(match.teamA) ?? maximumUncertainty },
    { team: match.teamB, rating: playerAdjustedRatingB, uncertainty: batch.uncertainties.get(match.teamB) ?? maximumUncertainty },
    series.format,
  )
  const executionAdjustedPrediction = neutralWinProbability(
    { team: match.teamA, rating: executionAdjustedRatingA, uncertainty: batch.uncertainties.get(match.teamA) ?? maximumUncertainty },
    { team: match.teamB, rating: executionAdjustedRatingB, uncertainty: batch.uncertainties.get(match.teamB) ?? maximumUncertainty },
    series.format,
  )
  const variants = {
    published: predictionVariantFromWinProbability(publishedPrediction, publishedRatingA, publishedRatingB),
    'team-only': predictionVariantFromWinProbability(teamOnlyPrediction, powerRatingA, powerRatingB),
    'player-adjusted': predictionVariantFromWinProbability(playerAdjustedPrediction, playerAdjustedRatingA, playerAdjustedRatingB),
    'execution-baseline': predictionVariantFromWinProbability(executionBaselinePrediction, noExecutionRatingA, noExecutionRatingB),
    'execution-adjusted': predictionVariantFromWinProbability(executionAdjustedPrediction, executionAdjustedRatingA, executionAdjustedRatingB),
  }

  return {
    id: match.id,
    seriesId: series.id,
    date: match.date,
    event: match.event,
    patch: match.patch,
    bestOf: publishedPrediction.bestOf,
    formatBasis: series.formatBasis,
    formatConfidence: series.formatConfidence,
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
    teamAExpectedSeriesPoints: publishedPrediction.teamAExpectedSeriesPoints,
    teamBExpectedSeriesPoints: publishedPrediction.teamBExpectedSeriesPoints,
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
    teamAUncertainty: Math.round(batch.uncertainties.get(match.teamA) ?? maximumUncertainty),
    teamBUncertainty: Math.round(batch.uncertainties.get(match.teamB) ?? maximumUncertainty),
    teamAPregameWins: state.wins.get(match.teamA) ?? 0,
    teamAPregameLosses: state.losses.get(match.teamA) ?? 0,
    teamBPregameWins: state.wins.get(match.teamB) ?? 0,
    teamBPregameLosses: state.losses.get(match.teamB) ?? 0,
    teamARosterContinuity: roundedContinuity(state.currentRosterContinuity.get(match.teamA)),
    teamBRosterContinuity: roundedContinuity(state.currentRosterContinuity.get(match.teamB)),
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
    segments: predictionSegmentsFor(match, teams, state.lastPatchByTeam, state.lastRosterFingerprintByTeam, series.format),
    trainingMatchCount: state.processedMatchCount,
    dataCutoff: state.previousMatch?.date,
    modelVersion: transparentGprModelMetadata.version,
    modelConfigHash: transparentGprModelMetadata.configHash,
    source: sourceTraceFor(match, series),
  }
}

function rosterPriorOffsetsForMatch(
  match: MatchRecord,
  pregamePlayerRatingEdges: PregamePlayerRatingEdges,
  previousRosterPriorOffsets: Map<string, number>,
) {
  const playerRatingEdge = pregamePlayerRatingEdges.get(match.id)
  return {
    teamA: rosterPriorOffsetForSide(match.teamARoster, playerRatingEdge?.teamAAdjustment, previousRosterPriorOffsets.get(match.teamA)),
    teamB: rosterPriorOffsetForSide(match.teamBRoster, playerRatingEdge?.teamBAdjustment, previousRosterPriorOffsets.get(match.teamB)),
  }
}

function rosterPriorOffsetForSide(
  roster: MatchRecord['teamARoster'],
  playerRatingAdjustment: number | undefined,
  previousRosterPriorOffset: number | undefined,
) {
  if (!roster) return previousRosterPriorOffset ?? 0
  return (playerRatingAdjustment ?? 0) * playerRatingPredictionWeight
}

function processRatingSeries({
  series,
  teams,
  state,
  batch,
  sideAdjustments,
  lastDate,
  pregamePlayerRatingEdges,
}: {
  series: RatingSeriesGroup
  teams: Record<string, TeamProfile>
  state: RatingRunState
  batch: RatingBatchSnapshot
  sideAdjustments: Map<string, number>
  lastDate: string
  pregamePlayerRatingEdges: PregamePlayerRatingEdges
}) {
  const finalMatch = series.finalMatch
  const seriesLeagueA = homeLeagueForTeam(finalMatch, series.teamA, teams)
  const seriesLeagueB = homeLeagueForTeam(finalMatch, series.teamB, teams)
  const seriesRatingA = batch.ratings.get(series.teamA) ?? initialTeamRating
  const seriesRatingB = batch.ratings.get(series.teamB) ?? initialTeamRating
  const seriesRawLeagueScoreA = batch.leagueScores.get(seriesLeagueA) ?? leaguePriorFor(seriesLeagueA)
  const seriesRawLeagueScoreB = batch.leagueScores.get(seriesLeagueB) ?? leaguePriorFor(seriesLeagueB)
  const seriesLeagueScoreA = effectiveLeagueRating(seriesLeagueA, seriesRawLeagueScoreA, batch.leagueMatchCounts.get(seriesLeagueA) ?? 0)
  const seriesLeagueScoreB = effectiveLeagueRating(seriesLeagueB, seriesRawLeagueScoreB, batch.leagueMatchCounts.get(seriesLeagueB) ?? 0)
  const seriesPowerRatingA = powerRating(seriesRatingA, seriesLeagueScoreA)
  const seriesPowerRatingB = powerRating(seriesRatingB, seriesLeagueScoreB)
  const finalRosterPriorOffsets = rosterPriorOffsetsForMatch(finalMatch, pregamePlayerRatingEdges, batch.rosterPriorOffsets)
  const seriesRosterPriorOffsetA = finalMatch.teamA === series.teamA ? finalRosterPriorOffsets.teamA : finalRosterPriorOffsets.teamB
  const seriesRosterPriorOffsetB = finalMatch.teamB === series.teamB ? finalRosterPriorOffsets.teamB : finalRosterPriorOffsets.teamA
  const seriesMomentumA = batch.momentums.get(series.teamA) ?? 0
  const seriesMomentumB = batch.momentums.get(series.teamB) ?? 0
  const seriesCurrentPowerRatingA = seriesPowerRatingA + seriesRosterPriorOffsetA + seriesMomentumA
  const seriesCurrentPowerRatingB = seriesPowerRatingB + seriesRosterPriorOffsetB + seriesMomentumB
  const seriesUncertaintyA = batch.uncertainties.get(series.teamA) ?? maximumUncertainty
  const seriesUncertaintyB = batch.uncertainties.get(series.teamB) ?? maximumUncertainty
  const seriesExpected = neutralWinProbability(
    { team: series.teamA, rating: seriesCurrentPowerRatingA, uncertainty: seriesUncertaintyA },
    { team: series.teamB, rating: seriesCurrentPowerRatingB, uncertainty: seriesUncertaintyB },
    series.bestOf,
  )
  const expectedOutcomeA = seriesExpected.teamAExpectedSeriesPoints
  const expectedOutcomeB = seriesExpected.teamBExpectedSeriesPoints
  const eventK = eventKFactorForMatch(finalMatch, state.eventWeightContext)
  const hasLeagueSignal = seriesLeagueA !== seriesLeagueB
    && seriesLeagueA !== 'Unknown'
    && seriesLeagueB !== 'Unknown'
    && leagueKFactorForMatch(finalMatch, state.eventWeightContext) !== 0
    && isInternationalMatch(finalMatch)
  const leagueSignalShare = hasLeagueSignal ? latentStrengthResultBudgetShares.leagueAnchor : 0
  const teamStableShare = (1 - leagueSignalShare) * latentStrengthResultBudgetShares.teamStable
  const teamFormShare = (1 - leagueSignalShare) * latentStrengthResultBudgetShares.teamForm
  const effectiveSeriesKA = eventK
    * series.strengthSignal
    * uncertaintyKMultiplier(seriesUncertaintyA)
    * rosterVolatilityMultiplier(state.currentRosterContinuity.get(series.teamA))
  const effectiveSeriesKB = eventK
    * series.strengthSignal
    * uncertaintyKMultiplier(seriesUncertaintyB)
    * rosterVolatilityMultiplier(state.currentRosterContinuity.get(series.teamB))
  const seriesResidualA = series.observedOutcomeA - expectedOutcomeA
  const seriesResidualB = series.observedOutcomeB - expectedOutcomeB
  const seriesResultEvidenceA = effectiveSeriesKA * ratingUpdateRecencyWeight * seriesResidualA
  const seriesResultEvidenceB = effectiveSeriesKB * ratingUpdateRecencyWeight * seriesResidualB
  const stableTransferWeightA = teamStableTransferWeightForSeries(finalMatch, seriesLeagueA, seriesLeagueB)
  const stableTransferWeightB = teamStableTransferWeightForSeries(finalMatch, seriesLeagueB, seriesLeagueA)
  const appliedTeamStableShareA = teamStableShare * stableTransferWeightA
  const appliedTeamStableShareB = teamStableShare * stableTransferWeightB
  const seriesDeltaA = Math.round(seriesResultEvidenceA * appliedTeamStableShareA)
  const seriesDeltaB = Math.round(seriesResultEvidenceB * appliedTeamStableShareB)
  const seriesDeltaByTeam = new Map([[series.teamA, seriesDeltaA], [series.teamB, seriesDeltaB]])
  const seriesResidualByTeam = new Map([[series.teamA, seriesResidualA], [series.teamB, seriesResidualB]])
  const seriesEvidenceByTeam = new Map([[series.teamA, seriesResultEvidenceA], [series.teamB, seriesResultEvidenceB]])
  const seriesExpectedByTeam = new Map([[series.teamA, expectedOutcomeA], [series.teamB, expectedOutcomeB]])
  const seriesObservedByTeam = new Map([[series.teamA, series.observedOutcomeA], [series.teamB, series.observedOutcomeB]])
  const seriesExecutionRatings = new Map(batch.executionRatings)

  for (const match of series.matches) {
    processSeriesMember({
      match,
      finalMatch,
      series,
      teams,
      state,
      batch,
      seriesExecutionRatings,
      sideAdjustments,
      lastDate,
      seriesDeltaByTeam,
      seriesResidualByTeam,
      seriesEvidenceByTeam,
      seriesExpectedByTeam,
      seriesObservedByTeam,
      stableTransferWeightA,
      stableTransferWeightB,
      appliedTeamStableShareA,
      appliedTeamStableShareB,
      teamFormShare,
      leagueSignalShare,
      pregamePlayerRatingEdges,
    })
  }
}

function processSeriesMember({
  match,
  finalMatch,
  series,
  teams,
  state,
  batch,
  seriesExecutionRatings,
  sideAdjustments,
  lastDate,
  seriesDeltaByTeam,
  seriesResidualByTeam,
  seriesEvidenceByTeam,
  seriesExpectedByTeam,
  seriesObservedByTeam,
  stableTransferWeightA,
  stableTransferWeightB,
  appliedTeamStableShareA,
  appliedTeamStableShareB,
  teamFormShare,
  leagueSignalShare,
  pregamePlayerRatingEdges,
}: {
  match: MatchRecord
  finalMatch: MatchRecord
  series: RatingSeriesGroup
  teams: Record<string, TeamProfile>
  state: RatingRunState
  batch: RatingBatchSnapshot
  seriesExecutionRatings: Map<string, number>
  sideAdjustments: Map<string, number>
  lastDate: string
  seriesDeltaByTeam: Map<string, number>
  seriesResidualByTeam: Map<string, number>
  seriesEvidenceByTeam: Map<string, number>
  seriesExpectedByTeam: Map<string, number>
  seriesObservedByTeam: Map<string, number>
  stableTransferWeightA: number
  stableTransferWeightB: number
  appliedTeamStableShareA: number
  appliedTeamStableShareB: number
  teamFormShare: number
  leagueSignalShare: number
  pregamePlayerRatingEdges: PregamePlayerRatingEdges
}) {
  const ratingA = batch.ratings.get(match.teamA) ?? initialTeamRating
  const ratingB = batch.ratings.get(match.teamB) ?? initialTeamRating
  const executionRatingA = seriesExecutionRatings.get(match.teamA) ?? initialTeamRating
  const executionRatingB = seriesExecutionRatings.get(match.teamB) ?? initialTeamRating
  const leagueA = homeLeagueForMatch(match, 'A', teams)
  const leagueB = homeLeagueForMatch(match, 'B', teams)
  const rawLeagueScoreA = batch.leagueScores.get(leagueA) ?? leaguePriorFor(leagueA)
  const rawLeagueScoreB = batch.leagueScores.get(leagueB) ?? leaguePriorFor(leagueB)
  const leagueScoreA = effectiveLeagueRating(leagueA, rawLeagueScoreA, batch.leagueMatchCounts.get(leagueA) ?? 0)
  const leagueScoreB = effectiveLeagueRating(leagueB, rawLeagueScoreB, batch.leagueMatchCounts.get(leagueB) ?? 0)
  const powerRatingA = powerRating(ratingA, leagueScoreA)
  const powerRatingB = powerRating(ratingB, leagueScoreB)
  const executionPowerRatingA = powerRating(executionRatingA, leagueScoreA)
  const executionPowerRatingB = powerRating(executionRatingB, leagueScoreB)
  const sideAdjustmentA = sideAdjustmentFor(match, 'A', sideAdjustments)
  const sideAdjustmentB = sideAdjustmentFor(match, 'B', sideAdjustments)
  const { teamA: rosterPriorOffsetA, teamB: rosterPriorOffsetB } = rosterPriorOffsetsForMatch(match, pregamePlayerRatingEdges, batch.rosterPriorOffsets)
  const currentWinsA = state.wins.get(match.teamA) ?? 0
  const currentLossesA = state.losses.get(match.teamA) ?? 0
  const currentWinsB = state.wins.get(match.teamB) ?? 0
  const currentLossesB = state.losses.get(match.teamB) ?? 0
  const publishedRosterPriorOffsetA = publishedRosterPriorOffset(rosterPriorOffsetA, currentWinsA, currentLossesA)
  const publishedRosterPriorOffsetB = publishedRosterPriorOffset(rosterPriorOffsetB, currentWinsB, currentLossesB)
  const momentumA = batch.momentums.get(match.teamA) ?? 0
  const momentumB = batch.momentums.get(match.teamB) ?? 0
  const currentPowerRatingA = powerRatingA + rosterPriorOffsetA + momentumA
  const currentPowerRatingB = powerRatingB + rosterPriorOffsetB + momentumB
  const currentPublishedPowerRatingA = powerRatingA + publishedRosterPriorOffsetA + momentumA
  const currentPublishedPowerRatingB = powerRatingB + publishedRosterPriorOffsetB + momentumB
  const effectiveRatingA = currentPowerRatingA + sideAdjustmentA
  const effectiveRatingB = currentPowerRatingB + sideAdjustmentB
  const executionEffectiveRatingA = executionPowerRatingA + rosterPriorOffsetA + momentumA + sideAdjustmentA
  const executionEffectiveRatingB = executionPowerRatingB + rosterPriorOffsetB + momentumB + sideAdjustmentB
  const matchEventK = eventKFactorForMatch(match, state.eventWeightContext)
  const matchEventWeight = eventWeightForMatch(match, state.eventWeightContext)
  const gameK = gameKFor(match, state.eventWeightContext, series.bestOf)
  const factorRecency = recencyWeight(match.date, lastDate)
  const aWon = match.winner === match.teamA
  const isSeriesFinal = series.state === 'completed' && match.id === finalMatch.id
  const resultResidualA = isSeriesFinal ? (seriesResidualByTeam.get(match.teamA) ?? 0) : 0
  const resultResidualB = isSeriesFinal ? (seriesResidualByTeam.get(match.teamB) ?? 0) : 0
  const resultEvidenceA = isSeriesFinal ? (seriesEvidenceByTeam.get(match.teamA) ?? 0) : 0
  const resultEvidenceB = isSeriesFinal ? (seriesEvidenceByTeam.get(match.teamB) ?? 0) : 0
  const deltaA = isSeriesFinal ? (seriesDeltaByTeam.get(match.teamA) ?? 0) : 0
  const deltaB = isSeriesFinal ? (seriesDeltaByTeam.get(match.teamB) ?? 0) : 0
  const ledgerTeamStableShareA = isSeriesFinal ? appliedTeamStableShareA : 0
  const ledgerTeamStableShareB = isSeriesFinal ? appliedTeamStableShareB : 0
  const ledgerTeamFormShare = isSeriesFinal ? teamFormShare : 0
  const ledgerLeagueSignalShare = isSeriesFinal ? leagueSignalShare : 0
  const seriesStrengthSignal = isSeriesFinal ? series.strengthSignal : 0
  const executionExpectedA = expectedScore(executionEffectiveRatingA, executionEffectiveRatingB)
  const executionExpectedB = 1 - executionExpectedA
  const executionOutcomeA = executionSoftOutcome(aWon ? 1 : 0, teamExecutionIndex(match, 'A'))
  const executionOutcomeB = executionSoftOutcome(aWon ? 0 : 1, teamExecutionIndex(match, 'B'))
  const executionDeltaA = Math.round(gameK * ratingUpdateRecencyWeight * (executionOutcomeA - executionExpectedA))
  const executionDeltaB = Math.round(gameK * ratingUpdateRecencyWeight * (executionOutcomeB - executionExpectedB))

  state.previousDisplayRatings.set(match.teamA, currentPublishedPowerRatingA)
  state.previousDisplayRatings.set(match.teamB, currentPublishedPowerRatingB)
  addRatingDelta(state.ratings, match.teamA, deltaA)
  addRatingDelta(state.ratings, match.teamB, deltaB)
  seriesExecutionRatings.set(match.teamA, executionRatingA + executionDeltaA)
  seriesExecutionRatings.set(match.teamB, executionRatingB + executionDeltaB)
  addRatingDelta(state.executionRatings, match.teamA, executionDeltaA)
  addRatingDelta(state.executionRatings, match.teamB, executionDeltaB)
  state.rosterPriorOffsets.set(match.teamA, rosterPriorOffsetA)
  state.rosterPriorOffsets.set(match.teamB, rosterPriorOffsetB)
  const uncertaintyA = batch.uncertainties.get(match.teamA) ?? maximumUncertainty
  const uncertaintyB = batch.uncertainties.get(match.teamB) ?? maximumUncertainty
  const nextUncertaintyA = isSeriesFinal ? nextUncertainty(uncertaintyA, match, leagueA, leagueB, state.eventWeightContext) : uncertaintyA
  const nextUncertaintyB = isSeriesFinal ? nextUncertainty(uncertaintyB, match, leagueB, leagueA, state.eventWeightContext) : uncertaintyB
  state.uncertainties.set(match.teamA, nextUncertaintyA)
  state.uncertainties.set(match.teamB, nextUncertaintyB)
  const leagueDelta = isSeriesFinal
    ? updateLeagueStrengthForSeries({
      match,
      leagueA,
      leagueB,
      leagueScoreA: rawLeagueScoreA,
      leagueScoreB: rawLeagueScoreB,
      leagueExpectedRatingA: currentPowerRatingA,
      leagueExpectedRatingB: currentPowerRatingB,
      expectedOutcomeA: seriesExpectedByTeam.get(match.teamA) ?? 0,
      expectedOutcomeB: seriesExpectedByTeam.get(match.teamB) ?? 0,
      observedOutcomeA: seriesObservedByTeam.get(match.teamA) ?? 0,
      observedOutcomeB: seriesObservedByTeam.get(match.teamB) ?? 0,
      strengthSignal: series.strengthSignal,
      recency: ratingUpdateRecencyWeight,
      eventWeightContext: state.eventWeightContext,
      leagueScores: new Map(state.leagueScores),
      previousLeagueScores: new Map(state.previousLeagueScores),
      leagueWins: state.leagueWins,
      leagueLosses: state.leagueLosses,
      leagueExpectedWins: state.leagueExpectedWins,
      leagueOpponentRatingSums: state.leagueOpponentRatingSums,
      leagueForms: state.leagueForms,
      leagueMatchCounts: state.leagueMatchCounts,
      leagueLastEvents: state.leagueLastEvents,
      leagueLastUpdated: state.leagueLastUpdated,
    })
    : { deltaA: 0, deltaB: 0 }
  applyLeagueDelta(leagueA, leagueDelta.deltaA, state.leagueScores, state.previousLeagueScores)
  applyLeagueDelta(leagueB, leagueDelta.deltaB, state.leagueScores, state.previousLeagueScores)
  const updatedLeagueScoreA = effectiveLeagueRating(leagueA, state.leagueScores.get(leagueA) ?? leaguePriorFor(leagueA), state.leagueMatchCounts.get(leagueA) ?? 0)
  const updatedLeagueScoreB = effectiveLeagueRating(leagueB, state.leagueScores.get(leagueB) ?? leaguePriorFor(leagueB), state.leagueMatchCounts.get(leagueB) ?? 0)
  if (isSeriesFinal && series.observedOutcomeA !== series.observedOutcomeB) {
    recordLeagueStrengthHistory({
      match,
      leagueA,
      leagueB,
      regionA: teamRegionForMatch(match, 'A', teams),
      regionB: teamRegionForMatch(match, 'B', teams),
      scoreA: updatedLeagueScoreA,
      scoreB: updatedLeagueScoreB,
      deltaA: leagueDelta.deltaA,
      deltaB: leagueDelta.deltaB,
      state,
    })
  }
  const updatedLeagueAdjustmentA = leagueAdjustment(ratingA + deltaA, updatedLeagueScoreA)
  const updatedLeagueAdjustmentB = leagueAdjustment(ratingB + deltaB, updatedLeagueScoreB)
  const momentumDeltaA = resultEvidenceA * ledgerTeamFormShare
  const momentumDeltaB = resultEvidenceB * ledgerTeamFormShare
  const updatedMomentumA = isSeriesFinal ? clamp(momentumA * momentumGameDecay + momentumDeltaA, -momentumCap, momentumCap) : momentumA
  const updatedMomentumB = isSeriesFinal ? clamp(momentumB * momentumGameDecay + momentumDeltaB, -momentumCap, momentumCap) : momentumB
  state.momentums.set(match.teamA, updatedMomentumA)
  state.momentums.set(match.teamB, updatedMomentumB)
  const publishedRecordWinsA = isSeriesFinal ? currentWinsA + Number(aWon) : currentWinsA
  const publishedRecordLossesA = isSeriesFinal ? currentLossesA + Number(!aWon) : currentLossesA
  const publishedRecordWinsB = isSeriesFinal ? currentWinsB + Number(!aWon) : currentWinsB
  const publishedRecordLossesB = isSeriesFinal ? currentLossesB + Number(aWon) : currentLossesB
  const updatedRosterPriorOffsetA = publishedRosterPriorOffset(rosterPriorOffsetA, publishedRecordWinsA, publishedRecordLossesA)
  const updatedRosterPriorOffsetB = publishedRosterPriorOffset(rosterPriorOffsetB, publishedRecordWinsB, publishedRecordLossesB)
  const updatedComponentsA = ratingComponents({
    teamRating: ratingA + deltaA,
    leagueScore: updatedLeagueScoreA,
    rosterPriorOffset: updatedRosterPriorOffsetA,
    momentum: updatedMomentumA,
    contextAdjustment: 0,
    uncertainty: nextUncertaintyA,
  })
  const updatedComponentsB = ratingComponents({
    teamRating: ratingB + deltaB,
    leagueScore: updatedLeagueScoreB,
    rosterPriorOffset: updatedRosterPriorOffsetB,
    momentum: updatedMomentumB,
    contextAdjustment: 0,
    uncertainty: nextUncertaintyB,
  })
  const updatedPowerRatingA = ratingFromComponents(updatedComponentsA)
  const updatedPowerRatingB = ratingFromComponents(updatedComponentsB)
  const baseUnavailableChannels = ['draft-skill:source-missing', 'matchup-style:shadow-unavailable', 'lineup-synergy:shadow-unavailable', 'direct-region:derived-from-league-posterior']
  const unavailableChannelsA = stableTransferWeightA < 1
    ? [...baseUnavailableChannels, 'domestic-relative-strength:global-transfer-shrunk']
    : baseUnavailableChannels
  const unavailableChannelsB = stableTransferWeightB < 1
    ? [...baseUnavailableChannels, 'domestic-relative-strength:global-transfer-shrunk']
    : baseUnavailableChannels
  const updateLedgerA = roundedRatingUpdateLedger({
    teamStableDelta: deltaA,
    leagueGameDelta: leagueDelta.deltaA,
    leaguePlacementDelta: 0,
    momentumDelta: updatedMomentumA - momentumA,
    rosterPriorDelta: 0,
    uncertaintyDelta: nextUncertaintyA - uncertaintyA,
    sideAdjustment: sideAdjustmentA,
    patchAdjustment: 0,
    ratingTarget: 'context-neutral-latent-team-strength',
    updateUnit: isSeriesFinal ? 'series-atomic' : 'series-member-no-team-update',
    eventWeight: matchEventWeight,
    resultEvidence: resultEvidenceA,
    neutralResultResidual: resultResidualA,
    seriesStrengthSignal,
    teamStableShare: ledgerTeamStableShareA,
    teamFormShare: ledgerTeamFormShare,
    playerSignalShare: latentStrengthResultBudgetShares.playerSignalShadow,
    lineupSignalShare: latentStrengthResultBudgetShares.lineupSignalShadow,
    leagueSignalShare: ledgerLeagueSignalShare,
    directRegionSignalShare: latentStrengthResultBudgetShares.directRegionShadow,
    playerSignalDelta: resultEvidenceA * latentStrengthResultBudgetShares.playerSignalShadow,
    lineupSignalDelta: resultEvidenceA * latentStrengthResultBudgetShares.lineupSignalShadow,
    directRegionSignalDelta: resultEvidenceA * latentStrengthResultBudgetShares.directRegionShadow,
    unavailableChannels: unavailableChannelsA,
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
    ratingTarget: 'context-neutral-latent-team-strength',
    updateUnit: isSeriesFinal ? 'series-atomic' : 'series-member-no-team-update',
    eventWeight: matchEventWeight,
    resultEvidence: resultEvidenceB,
    neutralResultResidual: resultResidualB,
    seriesStrengthSignal,
    teamStableShare: ledgerTeamStableShareB,
    teamFormShare: ledgerTeamFormShare,
    playerSignalShare: latentStrengthResultBudgetShares.playerSignalShadow,
    lineupSignalShare: latentStrengthResultBudgetShares.lineupSignalShadow,
    leagueSignalShare: ledgerLeagueSignalShare,
    directRegionSignalShare: latentStrengthResultBudgetShares.directRegionShadow,
    playerSignalDelta: resultEvidenceB * latentStrengthResultBudgetShares.playerSignalShadow,
    lineupSignalDelta: resultEvidenceB * latentStrengthResultBudgetShares.lineupSignalShadow,
    directRegionSignalDelta: resultEvidenceB * latentStrengthResultBudgetShares.directRegionShadow,
    unavailableChannels: unavailableChannelsB,
  })
  state.latestRatingUpdates.set(match.teamA, updateLedgerA)
  state.latestRatingUpdates.set(match.teamB, updateLedgerB)

  const historyDeltaA = isSeriesFinal ? updatedPowerRatingA - currentPublishedPowerRatingA : 0
  const historyDeltaB = isSeriesFinal ? updatedPowerRatingB - currentPublishedPowerRatingB : 0
  updateRecord(match.teamA, aWon, state)
  updateRecord(match.teamB, !aWon, state)
  const historyRanks = historyDisplayRankMap(state, teams)
  addFactors(match.teamA, {
    context: normalize(matchEventK, 12, 34),
    recency: factorRecency,
    execution: aWon ? 1 : 0,
    opponent: normalize(effectiveRatingB, 1350, 1700),
    league: normalize(leagueScoreA + Math.max(0, leagueDelta.deltaA), 1440, 1560),
  }, state)
  addFactors(match.teamB, {
    context: normalize(matchEventK, 12, 34),
    recency: factorRecency,
    execution: aWon ? 0 : 1,
    opponent: normalize(effectiveRatingA, 1350, 1700),
    league: normalize(leagueScoreB + Math.max(0, leagueDelta.deltaB), 1440, 1560),
  }, state)
  appendHistory(match, match.teamA, match.teamB, updatedPowerRatingA, ratingA + deltaA, updatedLeagueAdjustmentA, sideAdjustmentA, updatedComponentsA, updateLedgerA, historyDeltaA, historyRanks.get(match.teamA) ?? 1, aWon, state.histories, series)
  appendHistory(match, match.teamB, match.teamA, updatedPowerRatingB, ratingB + deltaB, updatedLeagueAdjustmentB, sideAdjustmentB, updatedComponentsB, updateLedgerB, historyDeltaB, historyRanks.get(match.teamB) ?? 1, !aWon, state.histories, series)
  recordSideAdjustmentSample(match, state.sideAdjustmentSamples)
  recordTeamContext(match, state.lastRosterByTeam, state.lastPatchByTeam, state.lastRosterFingerprintByTeam)
  trackMatchForPlacement(state.eventTrackers, match, teams)
  state.previousMatch = match
  state.processedMatchCount += 1
}

function recordLeagueStrengthHistory({
  match,
  leagueA,
  leagueB,
  regionA,
  regionB,
  scoreA,
  scoreB,
  deltaA,
  deltaB,
  state,
}: {
  match: MatchRecord
  leagueA: string
  leagueB: string
  regionA: Region
  regionB: Region
  scoreA: number
  scoreB: number
  deltaA: number
  deltaB: number
  state: RatingRunState
}) {
  if (deltaA === 0 && deltaB === 0) return
  state.leagueHistory.push(
    leagueStrengthHistoryPoint({
      match,
      league: leagueA,
      region: regionA,
      opponentLeague: leagueB,
      opponentRegion: regionB,
      result: deltaA >= deltaB ? 'W' : 'L',
      score: scoreA,
      delta: deltaA,
      state,
    }),
    leagueStrengthHistoryPoint({
      match,
      league: leagueB,
      region: regionB,
      opponentLeague: leagueA,
      opponentRegion: regionA,
      result: deltaB >= deltaA ? 'W' : 'L',
      score: scoreB,
      delta: deltaB,
      state,
    }),
  )
}

function leagueStrengthHistoryPoint({
  match,
  league,
  region,
  opponentLeague,
  opponentRegion,
  result,
  score,
  delta,
  state,
}: {
  match: MatchRecord
  league: string
  region: Region
  opponentLeague: string
  opponentRegion: Region
  result: 'W' | 'L'
  score: number
  delta: number
  state: RatingRunState
}): LeagueStrengthHistoryPoint {
  const wins = state.leagueWins.get(league) ?? 0
  const losses = state.leagueLosses.get(league) ?? 0
  const internationalMatches = state.leagueMatchCounts.get(league) ?? 0
  const expectedWins = state.leagueExpectedWins.get(league) ?? 0
  const winsOverExpected = wins - expectedWins
  const averageOpponentRating = internationalMatches > 0
    ? (state.leagueOpponentRatingSums.get(league) ?? 0) / internationalMatches
    : undefined
  const opponentAdjustedWinRate = internationalMatches > 0
    ? clamp((winsOverExpected + internationalMatches * 0.5) / internationalMatches, 0, 1)
    : undefined

  return {
    date: match.date,
    event: match.event,
    tier: match.tier,
    league,
    region,
    opponentLeague,
    opponentRegion,
    result,
    score: Number(score.toFixed(1)),
    delta: Number(delta.toFixed(1)),
    wins,
    losses,
    expectedWins: internationalMatches > 0 ? Number(expectedWins.toFixed(2)) : undefined,
    winsOverExpected: internationalMatches > 0 ? Number(winsOverExpected.toFixed(2)) : undefined,
    opponentAdjustedWinRate: opponentAdjustedWinRate === undefined ? undefined : Number(opponentAdjustedWinRate.toFixed(3)),
    averageOpponentRating: averageOpponentRating === undefined ? undefined : Number(averageOpponentRating.toFixed(1)),
    internationalMatches,
  }
}

function addRatingDelta(ratings: Map<string, number>, team: string, delta: number) {
  if (delta === 0) return
  ratings.set(team, (ratings.get(team) ?? initialTeamRating) + delta)
}

function applyLeagueDelta(
  league: string,
  delta: number,
  leagueScores: Map<string, number>,
  previousLeagueScores: Map<string, number>,
) {
  if (delta === 0) return
  const currentScore = leagueScores.get(league) ?? leaguePriorFor(league)
  previousLeagueScores.set(league, currentScore)
  leagueScores.set(league, currentScore + delta)
}

function teamRegionForMatch(match: MatchRecord, side: 'A' | 'B', teams: Record<string, TeamProfile>): Region {
  if (side === 'A') return match.teamARegion ?? teams[match.teamA]?.region ?? match.region
  return match.teamBRegion ?? teams[match.teamB]?.region ?? match.region
}

function homeLeagueForTeam(match: MatchRecord, team: string, teams: Record<string, TeamProfile>) {
  if (match.teamA === team) return homeLeagueForMatch(match, 'A', teams)
  if (match.teamB === team) return homeLeagueForMatch(match, 'B', teams)
  return teams[team]?.league ?? 'Unknown'
}

type RatingSeriesGroup = {
  key: string
  matches: MatchRecord[]
  finalMatch: MatchRecord
  teamA: string
  teamB: string
  winsA: number
  winsB: number
  games: number
  bestOf: CanonicalSeries['format']
  formatBasis: CanonicalSeries['formatBasis']
  formatConfidence: CanonicalSeries['formatConfidence']
  observedOutcomeA: number
  observedOutcomeB: number
  strengthSignal: number
  state: CanonicalSeries['state']
}

function ratingSeriesGroupsForDate(matches: MatchRecord[]): RatingSeriesGroup[] {
  return resolveCanonicalSeries(matches).map((series) => ({
    key: series.id,
    matches: series.games,
    finalMatch: series.finalMatch,
    teamA: series.teamA,
    teamB: series.teamB,
    winsA: series.winsA,
    winsB: series.winsB,
    games: series.games.length,
    bestOf: series.format,
    formatBasis: series.formatBasis,
    formatConfidence: series.formatConfidence,
    observedOutcomeA: series.outcomeA,
    observedOutcomeB: 1 - series.outcomeA,
    strengthSignal: seriesStrengthSignal(series.games.length, series.format, series.winsA, series.winsB),
    state: series.state,
  }))
}

function seriesStrengthSignal(games: number, bestOf: CanonicalSeries['format'], winsA: number, winsB: number) {
  const requiredWins = Math.max(winsA, winsB)
  const winsNeeded = Math.floor(bestOf / 2) + 1
  if (requiredWins < winsNeeded) return 1

  const unusedGames = Math.max(0, bestOf - games)
  const decisivenessBonus = bestOf > 1 ? Math.min(0.18, unusedGames * 0.06) : 0
  return 1 + decisivenessBonus
}

function teamStableTransferWeightForSeries(match: MatchRecord, league: string, opponentLeague: string) {
  if (league !== opponentLeague && isInternationalMatch(match)) return 1
  const tier = leagueTierFor(league).tier
  if (league === opponentLeague) return domesticStableTransferWeightsByTier[tier]
  const opponentTier = leagueTierFor(opponentLeague).tier
  return Math.min(domesticStableTransferWeightsByTier[tier], domesticStableTransferWeightsByTier[opponentTier])
}

function updateRecord(team: string, won: boolean, state: RatingRunState) {
  if (won) state.wins.set(team, (state.wins.get(team) ?? 0) + 1)
  else state.losses.set(team, (state.losses.get(team) ?? 0) + 1)
  state.forms.set(team, [...(state.forms.get(team) ?? []), won ? 'W' : 'L'].slice(-5))
}

function addFactors(team: string, next: FactorBreakdown, state: RatingRunState) {
  const current = state.factorSums.get(team) ?? { context: 0, recency: 0, execution: 0, opponent: 0, league: 0.5 }
  state.factorSums.set(team, {
    context: current.context + next.context,
    recency: current.recency + next.recency,
    execution: current.execution + next.execution,
    opponent: current.opponent + next.opponent,
    league: current.league + next.league,
  })
  state.factorCounts.set(team, (state.factorCounts.get(team) ?? 0) + 1)
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
  rank: number,
  won: boolean,
  histories: Map<string, TeamHistoryPoint[]>,
  series: RatingSeriesGroup,
) {
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
      rank,
      delta: Math.round(delta),
      tier: match.tier,
      result: won ? 'W' : 'L',
      source: {
        ...sourceTraceFor(match, {
          id: series.key,
          format: series.bestOf,
          formatBasis: series.formatBasis,
          formatConfidence: series.formatConfidence,
          state: series.state,
        }),
        ...(series.state === 'completed' ? {
          seriesOutcome: team === series.teamA
            ? series.observedOutcomeA as 0 | 0.5 | 1
            : series.observedOutcomeB as 0 | 0.5 | 1,
        } : {}),
      },
    },
  ])
}

function historyDisplayRankMap(state: RatingRunState, teams: Record<string, TeamProfile>) {
  const displayRatings = new Map<string, number>()
  for (const [team, rating] of state.ratings) {
    const profile = teams[team] ?? { name: team, code: team.slice(0, 3).toUpperCase(), region: 'International' as Region, league: 'Unknown' }
    const leagueScore = effectiveLeagueRating(profile.league, state.leagueScores.get(profile.league) ?? leaguePriorFor(profile.league), state.leagueMatchCounts.get(profile.league) ?? 0)
    const components = ratingComponents({
      teamRating: rating,
      leagueScore,
      rosterPriorOffset: publishedRosterPriorOffset(
        state.rosterPriorOffsets.get(team) ?? 0,
        state.wins.get(team) ?? 0,
        state.losses.get(team) ?? 0,
      ),
      momentum: state.momentums.get(team) ?? 0,
      contextAdjustment: 0,
      uncertainty: state.uncertainties.get(team) ?? maximumUncertainty,
    })
    displayRatings.set(team, ratingFromComponents(components))
  }
  return makeRankMap(displayRatings)
}
