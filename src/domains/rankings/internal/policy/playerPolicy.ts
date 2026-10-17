import type { LeagueTierName, Role } from '../../types.ts'
import { playerPerformancePolicy } from './playerPerformancePolicy.ts'

export const initialPlayerRating = 100
export const sourcedPlayerKFactor = 8
export const playerRatingScale = 80
export const playerLeagueAnchorRating = 1500
export const playerLeagueBaselineCoefficient = 0.2
export const playerLeagueBaselineBounds = {
  min: 50,
  max: 110,
} as const
export const playerLeagueSignalMultiplierByTier: Record<LeagueTierName, number> = {
  'tier-one': 1,
  'tier-two': 0.9,
  'tier-three': 0.65,
  emerging: 0.35,
  unknown: 0.25,
} as const
export const playerPregameEdgeCoefficient = 2.5
export const playerPregameEdgeSoftCap = 40
export const playerPregameEdgeCap = 70
export const playerPregameEdgeOverflowMultiplier = 0.4
export const playerPregameMinCoverage = 0.6
export const playerPregameMinGames = 1
export const minimumRankedSourcedPlayerGames = 20
export const thinAppearanceSampleGames = 5
export const baseRoleShares: Record<Role, number> = {
  Top: 0.18,
  Jungle: 0.22,
  Mid: 0.22,
  Bot: 0.2,
  Support: 0.18,
}
export const playerImpactWeights = {
  objectiveImpactZ: 0.12,
  awardResidualZ: 0.06,
  recentFormZ: 0.04,
} as const
export const playerImpactMultiplierBounds = {
  min: 0.7,
  max: 1.45,
} as const
export const sourcedPerformanceWeights = {
  win: 0.38,
  damageShare: 0.2,
  earnedGoldShare: 0.18,
  kda: 0.14,
  vision: 0.1,
} as const
export const individualResidualMetricVersion = 'individual-residual-v0'
export const individualResidualStrengthProxyWeight = 0.28
export const individualResidualScoreScale = 100
export const individualResidualMinimumRankedGames = minimumRankedSourcedPlayerGames
export const roleStatBaselines: Record<Role, { damageShare: number; earnedGoldShare: number; kda: number; vspm: number }> = {
  Top: { damageShare: 0.23, earnedGoldShare: 0.21, kda: 3, vspm: 0.9 },
  Jungle: { damageShare: 0.16, earnedGoldShare: 0.18, kda: 3.4, vspm: 1.2 },
  Mid: { damageShare: 0.25, earnedGoldShare: 0.22, kda: 3.6, vspm: 1 },
  Bot: { damageShare: 0.28, earnedGoldShare: 0.25, kda: 3.8, vspm: 0.8 },
  Support: { damageShare: 0.08, earnedGoldShare: 0.13, kda: 3.2, vspm: 2.4 },
}

export const playerModelParameters = {
  initialPlayerRating,
  sourcedPlayerKFactor,
  playerRatingScale,
  playerLeagueAnchorRating,
  playerLeagueBaselineCoefficient,
  playerLeagueBaselineBounds,
  playerLeagueSignalMultiplierByTier,
  playerPregameEdgeCoefficient,
  playerPregameEdgeSoftCap,
  playerPregameEdgeCap,
  playerPregameEdgeOverflowMultiplier,
  playerPregameMinCoverage,
  playerPregameMinGames,
  minimumRankedSourcedPlayerGames,
  baseRoleShares,
  playerImpactWeights,
  playerImpactMultiplierBounds,
  sourcedPerformanceWeights,
  individualResidualMetricVersion,
  individualResidualStrengthProxyWeight,
  individualResidualScoreScale,
  individualResidualMinimumRankedGames,
  roleStatBaselines,
  playerPerformancePolicy,
} as const
