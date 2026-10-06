import type { PregamePrediction, PregamePredictionVariant, PregamePredictionVariantKey } from '../types'
import type { NeutralWinProbability } from './winProbability'

export function predictionVariantFromWinProbability(
  prediction: NeutralWinProbability,
  teamARating: number,
  teamBRating: number,
): PregamePredictionVariant {
  return {
    teamAGameWinProbability: prediction.teamAGameWinProbability,
    teamBGameWinProbability: prediction.teamBGameWinProbability,
    teamASeriesWinProbability: prediction.teamASeriesWinProbability,
    teamBSeriesWinProbability: prediction.teamBSeriesWinProbability,
    teamARating: Math.round(teamARating),
    teamBRating: Math.round(teamBRating),
  }
}

export function predictionVariantProbability(
  prediction: PregamePrediction,
  key: PregamePredictionVariantKey,
  fallback: (prediction: PregamePrediction) => number,
) {
  return prediction.variants?.[key]?.teamAGameWinProbability ?? fallback(prediction)
}

export function hasPredictionVariant(prediction: PregamePrediction, key: PregamePredictionVariantKey) {
  const probability = prediction.variants?.[key]?.teamAGameWinProbability
  return typeof probability === 'number' && Number.isFinite(probability)
}
