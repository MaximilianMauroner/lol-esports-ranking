import { eventTierConfig } from '../data/rankingConfig'
import { leagueTierModelParameters } from '../data/leagueTiers'
import { currentRegionTaxonomyModelParameters } from '../data/regionTaxonomy'
import type { FactorBreakdown } from '../types'
import { defaultEligibilityConfig } from './eligibility'
import { executionResidualModelParameters } from './executionResidual'
import { playerModelParameters } from './playerModel'
import { publishedFeatureWeight, shadowFeatureWeight, type PredictionFeaturePolicy } from './predictionFeaturePolicy'
import { walkForwardSegmentKeys } from './predictionContext'
import { defaultRosterContinuityConfig } from './rosters'

export const initialTeamRating = 1500
export const initialLeagueRating = 1500
export const leagueEloWeight = 1
export const leagueAdjustmentPolicy = 'seasonal-hierarchical-anchor'
export const recencyFloor = 0.62
export const recencyRange = 0.38
export const recencyDecayDays = 180
export const normalPatchTeamRetention = 0.985
export const splitBreakTeamRetention = 0.92
export const seasonStartTeamRetention = 0.8
export const splitBreakLeagueRetention = 0.97
export const seasonStartLeagueRetention = 0.94
export const splitBreakMinimumGapDays = 21
export const sideAdjustmentShrinkageGames = 24
export const sideAdjustmentLearning = 'walk-forward-prior-only'
export const publishedPredictionSideAdjustment = 'side-aware-prior-only'
export const sameDayPredictionBatching = true
export const onlineRecencyDecay = 'state-gap-regression'
export const ratingUpdateRecencyWeight = 1
export const leagueExpectedScoreSource = 'pregame-team-power-with-side-context'
export const sourcePipelineVersion = 'canonical-identity-stat-dedupe-v10'
export const snapshotSeasonScopePolicy = 'source-season-ranking-profile-with-prior-baseline'
export const validationBaselinePolicy = ['coin-flip', 'pregame-win-rate', 'team-only'] as const
export const rosterBasisSource = 'latest-observed-oracle-game-roster'
export const rosterContinuityFloor = 0.55
export const rosterChangeUncertaintyPenalty = 40
export const rosterContinuityValueBasis = 'role-share'
export const rosterContinuityMatch = 'player-id-by-role'
export const rosterContinuityRequiresCompleteLineups = true
export const minimumUncertainty = 30
export const maximumUncertainty = 140
export const normalUncertainty = 50
export const uncertaintyKMultiplierFloor = 0.75
export const uncertaintyKMultiplierCeiling = 1.75
export const uncertaintyKScale = 100
export const rosterVolatilityKCeiling = 1.35
export const momentumGameDecay = 0.88
export const momentumSplitRetention = 0.2
export const momentumPatchRetention = 0.65
export const momentumKFactor = 10
export const momentumExecutionKFactor = 0
export const momentumCap = 70
export const worldsPlacementResidualK = 2
export const msiPlacementResidualK = 1.65
export const minorPlacementResidualK = 1.25
export const worldsPlacementResidualCap = 35
export const msiPlacementResidualCap = 25
export const minorPlacementResidualCap = 18
export const playerRatingPredictionPolicy = {
  key: 'player-rating',
  mode: 'live',
  liveWeight: 1,
  shadowWeight: 1,
  gate: {
    minimumPredictions: 200,
    minimumBrierImprovement: 0.001,
    requirePositiveLogLossDelta: true,
    requireNonNegativeRosterChangeDelta: true,
    requireNonNegativePatchTransitionDelta: true,
  },
  description: 'Sourced prior-only player ratings are published because the walk-forward gate cleared after Oracle player-stat coverage was added.',
} as const satisfies PredictionFeaturePolicy
export const playerRatingPredictionWeight = publishedFeatureWeight(playerRatingPredictionPolicy)
export const playerRatingShadowWeight = shadowFeatureWeight(playerRatingPredictionPolicy)
export const transparentGprModelVersion = 'transparent-gpr-v0.35.0'
export const transparentGprModelParameters = {
  initialTeamRating,
  initialLeagueRating,
  leagueEloWeight,
  leagueAdjustmentPolicy,
  recencyFloor,
  recencyRange,
  recencyDecayDays,
  normalPatchTeamRetention,
  splitBreakTeamRetention,
  seasonStartTeamRetention,
  splitBreakLeagueRetention,
  seasonStartLeagueRetention,
  splitBreakMinimumGapDays,
  sideAdjustmentShrinkageGames,
  sideAdjustmentLearning,
  publishedPredictionSideAdjustment,
  sameDayPredictionBatching,
  onlineRecencyDecay,
  ratingUpdateRecencyWeight,
  leagueExpectedScoreSource,
  sourcePipelineVersion,
  snapshotSeasonScopePolicy,
  validationBaselinePolicy,
  rosterBasisSource,
  rosterContinuityFloor,
  rosterChangeUncertaintyPenalty,
  rosterContinuityValueBasis,
  rosterContinuityMatch,
  rosterContinuityRequiresCompleteLineups,
  rosterContinuity: defaultRosterContinuityConfig,
  minimumUncertainty,
  maximumUncertainty,
  normalUncertainty,
  uncertaintyKMultiplierFloor,
  uncertaintyKMultiplierCeiling,
  uncertaintyKScale,
  rosterVolatilityKCeiling,
  momentumGameDecay,
  momentumSplitRetention,
  momentumPatchRetention,
  momentumKFactor,
  momentumExecutionKFactor,
  momentumCap,
  worldsPlacementResidualK,
  msiPlacementResidualK,
  minorPlacementResidualK,
  worldsPlacementResidualCap,
  msiPlacementResidualCap,
  minorPlacementResidualCap,
  playerRatingPredictionPolicy,
  playerRatingPredictionPublishedWeight: playerRatingPredictionWeight,
  playerRatingPredictionShadowWeight: playerRatingShadowWeight,
  executionResidual: executionResidualModelParameters,
  playerModel: playerModelParameters,
  eligibility: defaultEligibilityConfig,
  leagueTiers: leagueTierModelParameters,
  regionTaxonomy: currentRegionTaxonomyModelParameters,
  walkForwardSegments: walkForwardSegmentKeys,
  eventKFactors: Object.fromEntries(Object.entries(eventTierConfig).map(([tier, config]) => [tier, config.kFactor])),
  leagueKFactors: Object.fromEntries(Object.entries(eventTierConfig).map(([tier, config]) => [tier, config.leagueKFactor])),
} as const

export const transparentGprModelMetadata = {
  name: 'Transparent GPR',
  version: transparentGprModelVersion,
  configHash: stableHash(transparentGprModelParameters),
  parameters: transparentGprModelParameters,
} as const

const factorLabels: Record<keyof FactorBreakdown, string> = {
  context: 'Context',
  recency: 'Recency',
  execution: 'Result signal',
  opponent: 'Opponent',
  league: 'League strength',
}

export function factorLabel(key: keyof FactorBreakdown) {
  return factorLabels[key]
}

function stableHash(value: unknown) {
  const input = stableStringify(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
