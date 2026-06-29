import type { ModelInfo, RankingSummaryStanding } from './snapshot'
import {
  estimateMatchupProbability,
  type MatchupSideAssumption,
  type MatchupUncertaintyBand,
  type ProbabilityBand,
} from './matchupMath'

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

type PublicMatchupModel = Pick<ModelInfo, 'version' | 'configHash'>

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
  const homeRating = home.rating ?? 1500
  const awayRating = away.rating ?? 1500
  const prediction = estimateMatchupProbability(
    { team: home.team, rating: homeRating, uncertainty: home.uncertainty ?? 100 },
    { team: away.team, rating: awayRating, uncertainty: away.uncertainty ?? 100 },
    {
      ...options,
      sideAssumption: toMatchupSideAssumption(options.sideAssumption),
    },
  )

  return {
    home,
    away,
    ratingEdge: homeRating - awayRating,
    sideRatingEdge: prediction.sideRatingEdge,
    adjustedRatingEdge: prediction.adjustedRatingEdge,
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
