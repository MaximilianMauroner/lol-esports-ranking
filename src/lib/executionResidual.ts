import type { MatchRecord } from '../types'
import { publishedFeatureWeight, shadowFeatureWeight, type PredictionFeaturePolicy } from './predictionFeaturePolicy'

export const executionResidualWeights = {
  kills: 0.14,
  gold: 0.72,
  objectives: 0.14,
} as const

export const executionResidualCap = 0.25
export const executionResidualUpdateWeight = 0.25
export const executionResidualPredictionPolicy = {
  key: 'execution-residual',
  mode: 'shadow',
  liveWeight: 1,
  shadowWeight: 1,
  gate: {
    minimumPredictions: 200,
    minimumBrierImprovement: 0.001,
    requirePositiveLogLossDelta: true,
    requireNonNegativeCrossRegionDelta: true,
    requireNonNegativePatchTransitionDelta: true,
  },
  description: 'Execution-residual ratings are trained from post-game stat residuals, but remain shadow-only until walk-forward gates clear across cross-region and patch-transition slices.',
} as const satisfies PredictionFeaturePolicy
export const executionResidualPredictionWeight = publishedFeatureWeight(executionResidualPredictionPolicy)
export const executionResidualShadowWeight = shadowFeatureWeight(executionResidualPredictionPolicy)

export const executionResidualModelParameters = {
  executionResidualWeights,
  executionResidualCap,
  executionResidualUpdateWeight,
  executionResidualPredictionPolicy,
  executionResidualPredictionWeight,
  executionResidualShadowWeight,
} as const

export function teamExecutionIndex(match: MatchRecord, team: 'A' | 'B') {
  if (team === 'A') {
    return executionIndexFromStats(
      match.teamAKills,
      match.teamBKills,
      match.teamAGold,
      match.teamBGold,
      teamObjectiveCount(match, 'A'),
      teamObjectiveCount(match, 'B'),
    )
  }

  return executionIndexFromStats(
    match.teamBKills,
    match.teamAKills,
    match.teamBGold,
    match.teamAGold,
    teamObjectiveCount(match, 'B'),
    teamObjectiveCount(match, 'A'),
  )
}

export function executionIndexFromStats(
  killsFor: number,
  killsAgainst: number,
  goldFor: number,
  goldAgainst: number,
  objectivesFor = 0,
  objectivesAgainst = 0,
) {
  const killScore = (killsFor - killsAgainst) / Math.max(killsFor + killsAgainst, 1)
  const goldScore = (goldFor - goldAgainst) / Math.max(goldFor + goldAgainst, 1)
  const objectiveTotal = Math.max(objectivesFor + objectivesAgainst, 1)
  const objectiveScore = (objectivesFor - objectivesAgainst) / objectiveTotal

  return clamp(
    killScore * executionResidualWeights.kills
      + goldScore * executionResidualWeights.gold
      + objectiveScore * executionResidualWeights.objectives,
    -executionResidualCap,
    executionResidualCap,
  )
}

export function executionSoftOutcome(binaryOutcome: number, executionIndex: number) {
  return clamp(
    (1 - executionResidualUpdateWeight) * binaryOutcome
      + executionResidualUpdateWeight * (0.5 + executionIndex),
    0,
    1,
  )
}

function teamObjectiveCount(match: MatchRecord, team: 'A' | 'B') {
  if (team === 'A') return (match.teamATowers ?? 0) + (match.teamADragons ?? 0) + (match.teamABarons ?? 0) * 2
  return (match.teamBTowers ?? 0) + (match.teamBDragons ?? 0) + (match.teamBBarons ?? 0) * 2
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
