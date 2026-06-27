import type { ModelInfo, RankingSummaryStanding } from './snapshot'
import { neutralWinProbability } from './winProbability'

export type PublicMatchupEstimate = {
  home: RankingSummaryStanding
  away: RankingSummaryStanding
  ratingEdge: number
  homeWinProbability: number
  modelVersion: string
  modelConfigHash: string
}

export function estimatePublicMatchup(
  home: RankingSummaryStanding,
  away: RankingSummaryStanding,
  model?: Pick<ModelInfo, 'version' | 'configHash'>,
): PublicMatchupEstimate {
  const homeRating = home.rating ?? 1500
  const awayRating = away.rating ?? 1500
  const prediction = neutralWinProbability(
    { team: home.team, rating: homeRating, uncertainty: home.uncertainty ?? 100 },
    { team: away.team, rating: awayRating, uncertainty: away.uncertainty ?? 100 },
  )

  return {
    home,
    away,
    ratingEdge: homeRating - awayRating,
    homeWinProbability: prediction.teamAGameWinProbability,
    modelVersion: model?.version ?? 'unknown-model',
    modelConfigHash: model?.configHash ?? 'unknown-config',
  }
}
