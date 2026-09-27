import { defaultProbabilityCalibration, type ProbabilityCalibration } from './winProbability'
import type { ModelInfo, RankingSummaryStanding } from './snapshot'
import { publishedRatingScale } from './modelConfig'
import {
  estimateMatchupProbability,
  type MatchupSideAssumption,
  type MatchupUncertaintyBand,
  type ProbabilityBand,
} from './matchupMath'
import {
  ratingScaleFromUnknown,
  toInternalRating,
  toInternalRatingDelta,
  toPublishedRatingDelta,
} from './ratingCalculations'

export type PublicMatchupSideAssumption = 'neutral' | 'home-blue' | 'home-red'

export type PublicMatchupOptions = {
  bestOf?: 1 | 3 | 5 | number
  sideAssumption?: PublicMatchupSideAssumption
  blueSideRatingEdge?: number
  uncertaintyBands?: boolean | { sigma?: number }
}

export type PublicMatchupUncertaintyBand = {
  homeGameWinProbability: ProbabilityBand
  awayGameWinProbability: ProbabilityBand
  homeSeriesWinProbability: ProbabilityBand
  awaySeriesWinProbability: ProbabilityBand
}

export type PublicMatchupEstimate = {
  home: RankingSummaryStanding
  away: RankingSummaryStanding
  ratingEdge: number
  sideRatingEdge: number
  adjustedRatingEdge: number
  bestOf: 1 | 3 | 5
  sideAssumption: PublicMatchupSideAssumption
  homeSide?: 'blue' | 'red'
  awaySide?: 'blue' | 'red'
  homeGameWinProbability: number
  awayGameWinProbability: number
  homeSeriesWinProbability: number
  awaySeriesWinProbability: number
  uncertaintyPenalty: number
  uncertaintyBand?: PublicMatchupUncertaintyBand
  homeWinProbability: number
  modelVersion: string
  modelConfigHash: string
}

export type PublicMatchupModel = Pick<ModelInfo, 'version' | 'configHash'> & Partial<Pick<ModelInfo, 'parameters' | 'ratingScale'>>

export function estimatePublicMatchup(
  home: RankingSummaryStanding,
  away: RankingSummaryStanding,
  model?: PublicMatchupModel,
  options?: PublicMatchupOptions,
): PublicMatchupEstimate
export function estimatePublicMatchup(
  home: RankingSummaryStanding,
  away: RankingSummaryStanding,
  options?: PublicMatchupOptions,
): PublicMatchupEstimate
export function estimatePublicMatchup(
  home: RankingSummaryStanding,
  away: RankingSummaryStanding,
  modelOrOptions?: PublicMatchupModel | PublicMatchupOptions,
  maybeOptions: PublicMatchupOptions = {},
): PublicMatchupEstimate {
  const model = isPublicMatchupModel(modelOrOptions) ? modelOrOptions : undefined
  const options = isPublicMatchupModel(modelOrOptions) ? maybeOptions : modelOrOptions ?? {}
  const ratingScale = ratingScaleForPublicMatchup(model)
  const homePublishedRating = home.rating ?? ratingScale.publishedAnchor
  const awayPublishedRating = away.rating ?? ratingScale.publishedAnchor
  const homeRating = toInternalRating(homePublishedRating, ratingScale)
  const awayRating = toInternalRating(awayPublishedRating, ratingScale)
  const prediction = estimateMatchupProbability(
    {
      team: home.team,
      rating: homeRating,
      uncertainty: toInternalRatingDelta(home.uncertainty ?? toPublishedRatingDelta(100, ratingScale), ratingScale),
    },
    {
      team: away.team,
      rating: awayRating,
      uncertainty: toInternalRatingDelta(away.uncertainty ?? toPublishedRatingDelta(100, ratingScale), ratingScale),
    },
    {
      ...options,
      calibration: calibrationForPublicMatchup(model),
      sideAssumption: toMatchupSideAssumption(options.sideAssumption),
    },
  )

  return {
    home,
    away,
    ratingEdge: homePublishedRating - awayPublishedRating,
    sideRatingEdge: toPublishedRatingDelta(prediction.sideRatingEdge, ratingScale),
    adjustedRatingEdge: toPublishedRatingDelta(prediction.adjustedRatingEdge, ratingScale),
    bestOf: prediction.bestOf,
    sideAssumption: toPublicSideAssumption(prediction.sideAssumption),
    homeSide: prediction.teamASide,
    awaySide: prediction.teamBSide,
    homeGameWinProbability: prediction.teamAGameWinProbability,
    awayGameWinProbability: prediction.teamBGameWinProbability,
    homeSeriesWinProbability: prediction.teamASeriesWinProbability,
    awaySeriesWinProbability: prediction.teamBSeriesWinProbability,
    uncertaintyPenalty: prediction.uncertaintyPenalty,
    uncertaintyBand: toPublicUncertaintyBand(prediction.uncertaintyBand),
    homeWinProbability: prediction.teamAGameWinProbability,
    modelVersion: model?.version ?? 'unknown-model',
    modelConfigHash: model?.configHash ?? 'unknown-config',
  }
}

function isPublicMatchupModel(input: PublicMatchupModel | PublicMatchupOptions | undefined): input is PublicMatchupModel {
  return Boolean(input && ('version' in input || 'configHash' in input))
}

function ratingScaleForPublicMatchup(model: PublicMatchupModel | undefined) {
  const fromModel = ratingScaleFromUnknown(model?.ratingScale)
  if (fromModel) return fromModel
  if (model?.parameters && typeof model.parameters === 'object' && !Array.isArray(model.parameters)) {
    const fromParameters = ratingScaleFromUnknown((model.parameters as Record<string, unknown>).publishedRatingScale)
    if (fromParameters) return fromParameters
  }
  return publishedRatingScale
}

function toMatchupSideAssumption(sideAssumption: PublicMatchupSideAssumption | undefined): MatchupSideAssumption {
  if (sideAssumption === 'home-blue') return 'team-a-blue'
  if (sideAssumption === 'home-red') return 'team-a-red'
  return 'neutral'
}

function toPublicSideAssumption(sideAssumption: MatchupSideAssumption): PublicMatchupSideAssumption {
  if (sideAssumption === 'team-a-blue') return 'home-blue'
  if (sideAssumption === 'team-a-red') return 'home-red'
  return 'neutral'
}

function toPublicUncertaintyBand(band: MatchupUncertaintyBand | undefined): PublicMatchupUncertaintyBand | undefined {
  if (!band) return undefined
  return {
    homeGameWinProbability: band.teamAGameWinProbability,
    awayGameWinProbability: band.teamBGameWinProbability,
    homeSeriesWinProbability: band.teamASeriesWinProbability,
    awaySeriesWinProbability: band.teamBSeriesWinProbability,
  }
}

/**
 * Neutral single-game win chance, in whole percent, for the higher of two
 * teams `gap` published points apart, before team uncertainty. The same scale
 * and forecast engine as comparisons, so the legend's "100 points is about N%"
 * always matches the model that produced the board.
 */
export function gameWinChanceForGap(model?: PublicMatchupModel, gap = 100) {
  const scale = ratingScaleForPublicMatchup(model)
  const estimate = estimateMatchupProbability(
    { team: 'Higher', rating: scale.internalAnchor + toInternalRatingDelta(gap, scale), uncertainty: 0 },
    { team: 'Lower', rating: scale.internalAnchor, uncertainty: 0 },
    { bestOf: 1, sideAssumption: 'neutral', calibration: calibrationForPublicMatchup(model) },
  )
  return Math.round(estimate.teamAGameWinProbability * 100)
}

function calibrationForPublicMatchup(model?: PublicMatchupModel): ProbabilityCalibration {
  const parameters = model?.parameters as Record<string, unknown> | undefined
  const positive = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  const floor = parameters?.winProbabilityUncertaintyFloor
  return {
    eloScale: positive(parameters?.winProbabilityEloScale, defaultProbabilityCalibration.eloScale),
    uncertaintyScale: positive(parameters?.winProbabilityUncertaintyScale, defaultProbabilityCalibration.uncertaintyScale),
    uncertaintyFloor: typeof floor === 'number' && Number.isFinite(floor) && floor >= 0 && floor <= 1 ? floor : defaultProbabilityCalibration.uncertaintyFloor,
  }
}
