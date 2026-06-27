import type { RosterBasis } from '../types'
import type { WalkForwardMetrics } from './predictionModel'

export type RankingExplanationTarget =
  | 'seasonal-anchoring'
  | 'team-result'
  | 'league-strength'
  | 'recent-form'
  | 'uncertainty'
  | 'roster-basis'
  | 'player-ratings'
  | 'execution-residuals'
  | 'walk-forward-metrics'

export type RankingExplanation = {
  target: RankingExplanationTarget
  label: string
  description: string
}

export const rankingTargetExplanations: RankingExplanation[] = [
  {
    target: 'seasonal-anchoring',
    label: 'Seasonal Anchor',
    description: 'Teams start from a league anchor, then add stable team offset, roster prior, momentum, context, and uncertainty.',
  },
  {
    target: 'team-result',
    label: 'Team Result',
    description: 'Game outcomes update stable team offset with event weight, best-of damping, and uncertainty-sensitive movement.',
  },
  {
    target: 'league-strength',
    label: 'League Strength',
    description: 'Cross-league international games anchor regional context before it adjusts team power.',
  },
  {
    target: 'recent-form',
    label: 'Momentum',
    description: 'Recent overperformance adds a capped, fast-decaying form layer instead of becoming permanent team strength.',
  },
  {
    target: 'uncertainty',
    label: 'Uncertainty',
    description: 'Low current volume, stale schedules, and weak league anchors keep teams provisional.',
  },
  {
    target: 'roster-basis',
    label: 'Roster Basis',
    description: 'Oracle player rows mark roster provenance and drive value-weighted continuity adjustments.',
  },
  {
    target: 'player-ratings',
    label: 'Player Ratings',
    description: 'Sourced Oracle player stats produce post-game ratings and a gated pre-game adjustment with team-only audit metrics.',
  },
  {
    target: 'execution-residuals',
    label: 'Execution Residuals',
    description: 'Post-game kills, gold, and objectives update a shadow ledger only after each date batch is predicted.',
  },
  {
    target: 'walk-forward-metrics',
    label: 'Walk-Forward',
    description: 'Validation predicts each game from only prior data; published rows use known side context, while baseline variants stay neutral.',
  },
]

export function describeRosterBasis(rosterBasis: RosterBasis) {
  if (rosterBasis === 'sourced') return 'Latest observed Oracle roster is complete by role.'
  if (rosterBasis === 'assumed-continuous') return 'Only partial sourced roster evidence is available.'
  return 'No sourced current roster evidence is available.'
}

export function describeUncertainty(uncertainty?: number) {
  if (typeof uncertainty !== 'number' || !Number.isFinite(uncertainty)) return 'Uncertainty unavailable.'
  if (uncertainty <= 55) return 'Low uncertainty from repeated recent evidence.'
  if (uncertainty <= 105) return 'Moderate uncertainty; still eligible if other gates pass.'
  return 'High uncertainty; ranking should be treated as provisional.'
}

export function formatWalkForwardMetrics(metrics?: WalkForwardMetrics) {
  if (!metrics || metrics.predictionCount === 0) return 'No walk-forward validation rows are available.'
  const winRateBaseline = metrics.baselineComparisons?.find((baseline) => baseline.key === 'pregame-win-rate')
  return [
    `${formatInteger(metrics.predictionCount)} ${walkForwardTargetLabel(metrics.target)} predictions`,
    `${formatPercent(metrics.accuracy)} accuracy`,
    `Brier ${formatDecimal(metrics.brierScore)}`,
    `log loss ${formatDecimal(metrics.logLoss)}`,
    ...(winRateBaseline ? [`${formatSignedDecimal(winRateBaseline.publishedBrierDelta)} Brier vs pre-game win rate`] : []),
  ].join(' · ')
}

function walkForwardTargetLabel(target: WalkForwardMetrics['target']) {
  if (target === 'published-game') return 'published game-level'
  if (target === 'neutral-game') return 'neutral game-level'
  return target
}

function formatInteger(value: number) {
  return new Intl.NumberFormat('en').format(value)
}

function formatPercent(value: number) {
  return `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value * 100)}%`
}

function formatDecimal(value: number) {
  return new Intl.NumberFormat('en', { maximumFractionDigits: 3 }).format(value)
}

function formatSignedDecimal(value: number) {
  return new Intl.NumberFormat('en', { maximumFractionDigits: 3, signDisplay: 'exceptZero' }).format(value)
}
