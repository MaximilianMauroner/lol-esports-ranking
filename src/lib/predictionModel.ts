import { buildRankingModel, transparentGprModelMetadata } from './model'
import { walkForwardSegmentKeys } from './predictionContext'
import { hasPredictionVariant, predictionVariantProbability } from './predictionVariants'
import { neutralWinProbability, type NeutralWinProbability } from './winProbability'
import type { MatchRecord, PregamePrediction, TeamProfile, TeamStanding, WalkForwardSegmentKey } from '../types'

export type CurrentNeutralPrediction = NeutralWinProbability & {
  modelVersion: string
  modelConfigHash: string
  teamAEligibility?: TeamStanding['eligibility']
  teamBEligibility?: TeamStanding['eligibility']
  teamARosterBasis?: TeamStanding['rosterBasis']
  teamBRosterBasis?: TeamStanding['rosterBasis']
}

export type WalkForwardTarget = 'published-game' | 'neutral-game'

export type WalkForwardMetrics = {
  target: WalkForwardTarget
  modelVersion: string
  modelConfigHash: string
  predictionCount: number
  accuracy: number
  brierScore: number
  logLoss: number
  calibration: Array<{
    bucket: string
    count: number
    meanPredicted: number
    observedWinRate: number
  }>
  segments: WalkForwardMetricSummary[]
  baselineComparisons: BaselineComparisonMetric[]
  playerRatingShadow: PlayerRatingShadowMetrics
  executionResidualShadow: ExecutionResidualShadowMetrics
}

export type BaselineComparisonKey = 'coin-flip' | 'pregame-win-rate' | 'team-only'

export type BaselineComparisonMetric = {
  key: BaselineComparisonKey
  label: string
  description: string
  predictionCount: number
  accuracy: number
  brierScore: number
  logLoss: number
  publishedAccuracyDelta: number
  publishedBrierDelta: number
  publishedLogLossDelta: number
  segments: BaselineComparisonSegmentMetric[]
}

export type WalkForwardMetricSummary = {
  key: WalkForwardSegmentKey
  predictionCount: number
  accuracy: number
  brierScore: number
  logLoss: number
}

export type BaselineComparisonSegmentMetric = WalkForwardMetricSummary & {
  publishedAccuracyDelta: number
  publishedBrierDelta: number
  publishedLogLossDelta: number
}

export type PlayerRatingShadowMetrics = {
  enabled: boolean
  predictionCount: number
  accuracy: number
  brierScore: number
  logLoss: number
  brierDelta: number
  logLossDelta: number
  rosterChangeBrierDelta: number
  patchTransitionBrierDelta: number
}

export type ExecutionResidualShadowMetrics = {
  enabled: boolean
  predictionCount: number
  accuracy: number
  brierScore: number
  logLoss: number
  brierDelta: number
  logLossDelta: number
  crossRegionBrierDelta: number
  patchTransitionBrierDelta: number
}

export function predictNeutralCurrentMatchup(
  standings: TeamStanding[],
  teamA: string,
  teamB: string,
  bestOf = 5,
): CurrentNeutralPrediction {
  const standingA = standingFor(standings, teamA)
  const standingB = standingFor(standings, teamB)
  const prediction = neutralWinProbability(standingA, standingB, bestOf)

  return {
    ...prediction,
    modelVersion: transparentGprModelMetadata.version,
    modelConfigHash: transparentGprModelMetadata.configHash,
    teamAEligibility: standingA.eligibility,
    teamBEligibility: standingB.eligibility,
    teamARosterBasis: standingA.rosterBasis,
    teamBRosterBasis: standingB.rosterBasis,
  }
}

export function buildCurrentPredictor(matches: MatchRecord[], teams: Record<string, TeamProfile>) {
  const model = buildRankingModel(matches, { ...teams })
  return {
    model,
    predictNeutral: (teamA: string, teamB: string, bestOf = 5) =>
      predictNeutralCurrentMatchup(model.standings, teamA, teamB, bestOf),
  }
}

export function buildWalkForwardBacktest(
  matches: MatchRecord[],
  teams: Record<string, TeamProfile>,
): {
  predictions: PregamePrediction[]
  metrics: WalkForwardMetrics
} {
  const model = buildRankingModel(matches, { ...teams })
  return {
    predictions: model.predictions,
    metrics: summarizePredictions(model.predictions),
  }
}

export function summarizePredictions(predictions: PregamePrediction[]): WalkForwardMetrics {
  const evaluated = predictions.filter((prediction) => prediction.actualWinner === prediction.teamA || prediction.actualWinner === prediction.teamB)
  const summary = metricSummaryFor(evaluated)

  return {
    target: 'published-game',
    modelVersion: transparentGprModelMetadata.version,
    modelConfigHash: transparentGprModelMetadata.configHash,
    predictionCount: summary.predictionCount,
    accuracy: summary.accuracy,
    brierScore: summary.brierScore,
    logLoss: summary.logLoss,
    calibration: calibrationBuckets(evaluated),
    segments: segmentSummaries(evaluated),
    baselineComparisons: baselineComparisons(evaluated),
    playerRatingShadow: playerRatingShadowMetrics(evaluated),
    executionResidualShadow: executionResidualShadowMetrics(evaluated),
  }
}

function standingFor(standings: TeamStanding[], team: string) {
  const standing = standings.find((candidate) => candidate.team === team)
  if (!standing) {
    throw new Error(`No standing found for ${team}`)
  }
  return standing
}

function calibrationBuckets(predictions: PregamePrediction[]) {
  const buckets = new Map<string, { predicted: number[]; outcomes: number[] }>()

  for (const prediction of predictions) {
    const favoriteProbability = Math.max(prediction.teamAGameWinProbability, prediction.teamBGameWinProbability)
    const bucketFloor = Math.min(90, Math.floor(favoriteProbability * 10) * 10)
    const key = `${bucketFloor}-${bucketFloor + 10}`
    const favoriteWon = prediction.predictedWinner === prediction.actualWinner ? 1 : 0
    const bucket = buckets.get(key) ?? { predicted: [], outcomes: [] }
    bucket.predicted.push(favoriteProbability)
    bucket.outcomes.push(favoriteWon)
    buckets.set(key, bucket)
  }

  return Array.from(buckets.entries())
    .map(([bucket, values]) => ({
      bucket,
      count: values.predicted.length,
      meanPredicted: roundMetric(mean(values.predicted)),
      observedWinRate: roundMetric(mean(values.outcomes)),
    }))
    .sort((left, right) => left.bucket.localeCompare(right.bucket))
}

function segmentSummaries(predictions: PregamePrediction[]): WalkForwardMetricSummary[] {
  return walkForwardSegmentKeys
    .map((key) => ({
      key,
      ...metricSummaryFor(predictions.filter((prediction) => prediction.segments.includes(key))),
    }))
    .filter((summary) => summary.predictionCount > 0)
}

function baselineComparisons(predictions: PregamePrediction[]): BaselineComparisonMetric[] {
  const definitions: Array<{
    key: BaselineComparisonKey
    label: string
    description: string
    probabilityFor: (prediction: PregamePrediction) => number
  }> = [
    {
      key: 'coin-flip',
      label: 'Coin flip',
      description: 'Always predicts 50 percent for team A; verifies the model clears a no-skill game-level baseline.',
      probabilityFor: () => 0.5,
    },
    {
      key: 'pregame-win-rate',
      label: 'Pre-game win rate',
      description: 'Uses only each team cumulative pre-game record with Laplace smoothing; ignores opponent strength, league strength, side, roster, patch, and uncertainty.',
      probabilityFor: pregameWinRateProbabilityFor,
    },
    {
      key: 'team-only',
      label: 'Team-only model',
      description: 'Uses the neutral team and league rating spine before player-rating, execution-residual, and side-context variants.',
      probabilityFor: teamOnlyProbabilityFor,
    },
  ]

  return definitions.map((definition) => {
    const baseline = metricSummaryFor(predictions, definition.probabilityFor)
    const published = metricSummaryFor(predictions)
    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      predictionCount: baseline.predictionCount,
      accuracy: baseline.accuracy,
      brierScore: baseline.brierScore,
      logLoss: baseline.logLoss,
      publishedAccuracyDelta: roundMetric(published.accuracy - baseline.accuracy),
      publishedBrierDelta: roundMetric(baseline.brierScore - published.brierScore),
      publishedLogLossDelta: roundMetric(baseline.logLoss - published.logLoss),
      segments: baselineComparisonSegments(predictions, definition.probabilityFor),
    }
  })
}

function baselineComparisonSegments(
  predictions: PregamePrediction[],
  probabilityFor: (prediction: PregamePrediction) => number,
): BaselineComparisonSegmentMetric[] {
  return walkForwardSegmentKeys
    .map((key) => {
      const segmentPredictions = predictions.filter((prediction) => prediction.segments.includes(key))
      const baseline = metricSummaryFor(segmentPredictions, probabilityFor)
      const published = metricSummaryFor(segmentPredictions)

      return {
        key,
        ...baseline,
        publishedAccuracyDelta: roundMetric(published.accuracy - baseline.accuracy),
        publishedBrierDelta: roundMetric(baseline.brierScore - published.brierScore),
        publishedLogLossDelta: roundMetric(baseline.logLoss - published.logLoss),
      }
    })
    .filter((summary) => summary.predictionCount > 0)
}

function metricSummaryFor(
  predictions: PregamePrediction[],
  teamAProbabilityFor: (prediction: PregamePrediction) => number = (prediction) => prediction.teamAGameWinProbability,
) {
  const count = predictions.length
  const accuracy = count === 0
    ? 0
    : predictions.filter((prediction) => {
      const teamAProbability = teamAProbabilityFor(prediction)
      const predictedWinner = teamAProbability >= 0.5 ? prediction.teamA : prediction.teamB
      return predictedWinner === prediction.actualWinner
    }).length / count
  const brierScore = mean(predictions.map((prediction) => {
    const outcome = prediction.actualWinner === prediction.teamA ? 1 : 0
    return (teamAProbabilityFor(prediction) - outcome) ** 2
  }))
  const logLoss = mean(predictions.map((prediction) => {
    const teamAProbability = teamAProbabilityFor(prediction)
    const probability = clamp(prediction.actualWinner === prediction.teamA ? teamAProbability : 1 - teamAProbability, 0.001, 0.999)
    return -Math.log(probability)
  }))

  return {
    predictionCount: count,
    accuracy: roundMetric(accuracy),
    brierScore: roundMetric(brierScore),
    logLoss: roundMetric(logLoss),
  }
}

function pregameWinRateProbabilityFor(prediction: PregamePrediction) {
  const teamAGames = (prediction.teamAPregameWins ?? 0) + (prediction.teamAPregameLosses ?? 0)
  const teamBGames = (prediction.teamBPregameWins ?? 0) + (prediction.teamBPregameLosses ?? 0)
  const teamAWinRate = ((prediction.teamAPregameWins ?? 0) + 1) / (teamAGames + 2)
  const teamBWinRate = ((prediction.teamBPregameWins ?? 0) + 1) / (teamBGames + 2)
  return teamAWinRate + teamBWinRate === 0 ? 0.5 : teamAWinRate / (teamAWinRate + teamBWinRate)
}

function playerRatingShadowMetrics(predictions: PregamePrediction[]): PlayerRatingShadowMetrics {
  const shadowPredictions = predictions.filter(hasPlayerAdjustedProbability)
  if (shadowPredictions.length === 0) {
    return {
      enabled: false,
      predictionCount: 0,
      accuracy: 0,
      brierScore: 0,
      logLoss: 0,
      brierDelta: 0,
      logLossDelta: 0,
      rosterChangeBrierDelta: 0,
      patchTransitionBrierDelta: 0,
    }
  }

  const baseline = metricSummaryFor(shadowPredictions, teamOnlyProbabilityFor)
  const shadow = metricSummaryFor(shadowPredictions, playerAdjustedProbabilityFor)

  return {
    enabled: shadowPredictions.some((prediction) =>
      (prediction.playerRatingPredictionWeight ?? 0) > 0
        && ((prediction.teamAPlayerRatingAdjustment ?? 0) !== 0 || (prediction.teamBPlayerRatingAdjustment ?? 0) !== 0),
    ),
    predictionCount: shadow.predictionCount,
    accuracy: shadow.accuracy,
    brierScore: shadow.brierScore,
    logLoss: shadow.logLoss,
    brierDelta: roundMetric(baseline.brierScore - shadow.brierScore),
    logLossDelta: roundMetric(baseline.logLoss - shadow.logLoss),
    rosterChangeBrierDelta: playerRatingSegmentBrierDelta(shadowPredictions, 'roster-change'),
    patchTransitionBrierDelta: playerRatingSegmentBrierDelta(shadowPredictions, 'patch-transition'),
  }
}

function playerRatingSegmentBrierDelta(predictions: PregamePrediction[], segment: WalkForwardSegmentKey) {
  const segmentPredictions = predictions.filter((prediction) => prediction.segments.includes(segment))
  if (segmentPredictions.length === 0) return 0
  const baseline = metricSummaryFor(segmentPredictions, teamOnlyProbabilityFor)
  const shadow = metricSummaryFor(segmentPredictions, playerAdjustedProbabilityFor)
  return roundMetric(baseline.brierScore - shadow.brierScore)
}

function teamOnlyProbabilityFor(prediction: PregamePrediction) {
  return predictionVariantProbability(
    prediction,
    'team-only',
    (candidate) => candidate.teamAGameWinProbabilityTeamOnly ?? candidate.teamAGameWinProbability,
  )
}

function playerAdjustedProbabilityFor(prediction: PregamePrediction) {
  return predictionVariantProbability(
    prediction,
    'player-adjusted',
    (candidate) => candidate.teamAGameWinProbabilityPlayerAdjusted ?? candidate.teamAGameWinProbability,
  )
}

function hasPlayerAdjustedProbability(prediction: PregamePrediction) {
  return hasPredictionVariant(prediction, 'player-adjusted')
    || (typeof prediction.teamAGameWinProbabilityPlayerAdjusted === 'number'
    && Number.isFinite(prediction.teamAGameWinProbabilityPlayerAdjusted)
    && typeof prediction.teamBGameWinProbabilityPlayerAdjusted === 'number'
    && Number.isFinite(prediction.teamBGameWinProbabilityPlayerAdjusted))
}

function executionResidualShadowMetrics(predictions: PregamePrediction[]): ExecutionResidualShadowMetrics {
  const executionPredictions = predictions.filter(hasExecutionAdjustedProbability)
  if (executionPredictions.length === 0) {
    return {
      enabled: false,
      predictionCount: 0,
      accuracy: 0,
      brierScore: 0,
      logLoss: 0,
      brierDelta: 0,
      logLossDelta: 0,
      crossRegionBrierDelta: 0,
      patchTransitionBrierDelta: 0,
    }
  }

  const baseline = metricSummaryFor(executionPredictions, executionBaselineProbabilityFor)
  const shadow = metricSummaryFor(executionPredictions, executionAdjustedProbabilityFor)

  return {
    enabled: executionPredictions.some((prediction) =>
      (prediction.executionResidualPredictionWeight ?? 0) > 0
        && ((prediction.teamAExecutionResidualAdjustment ?? 0) !== 0 || (prediction.teamBExecutionResidualAdjustment ?? 0) !== 0),
    ),
    predictionCount: shadow.predictionCount,
    accuracy: shadow.accuracy,
    brierScore: shadow.brierScore,
    logLoss: shadow.logLoss,
    brierDelta: roundMetric(baseline.brierScore - shadow.brierScore),
    logLossDelta: roundMetric(baseline.logLoss - shadow.logLoss),
    crossRegionBrierDelta: executionResidualSegmentBrierDelta(executionPredictions, 'cross-region'),
    patchTransitionBrierDelta: executionResidualSegmentBrierDelta(executionPredictions, 'patch-transition'),
  }
}

function executionResidualSegmentBrierDelta(predictions: PregamePrediction[], segment: WalkForwardSegmentKey) {
  const segmentPredictions = predictions.filter((prediction) => prediction.segments.includes(segment))
  if (segmentPredictions.length === 0) return 0
  const baseline = metricSummaryFor(segmentPredictions, executionBaselineProbabilityFor)
  const shadow = metricSummaryFor(segmentPredictions, executionAdjustedProbabilityFor)
  return roundMetric(baseline.brierScore - shadow.brierScore)
}

function executionBaselineProbabilityFor(prediction: PregamePrediction) {
  return predictionVariantProbability(
    prediction,
    'execution-baseline',
    (candidate) => candidate.teamAGameWinProbabilityExecutionBaseline ?? candidate.teamAGameWinProbability,
  )
}

function executionAdjustedProbabilityFor(prediction: PregamePrediction) {
  return predictionVariantProbability(
    prediction,
    'execution-adjusted',
    (candidate) => candidate.teamAGameWinProbabilityExecutionAdjusted ?? candidate.teamAGameWinProbability,
  )
}

function hasExecutionAdjustedProbability(prediction: PregamePrediction) {
  return hasPredictionVariant(prediction, 'execution-adjusted')
    || (typeof prediction.teamAGameWinProbabilityExecutionAdjusted === 'number'
    && Number.isFinite(prediction.teamAGameWinProbabilityExecutionAdjusted)
    && typeof prediction.teamBGameWinProbabilityExecutionAdjusted === 'number'
    && Number.isFinite(prediction.teamBGameWinProbabilityExecutionAdjusted))
}

function mean(values: number[]) {
  if (values.length === 0) return 0
  return values.reduce((total, value) => total + value, 0) / values.length
}

function roundMetric(value: number) {
  return Number(value.toFixed(4))
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
