export type PredictionFeatureMode = 'live' | 'shadow' | 'off'

export type PredictionFeatureGate = Record<string, boolean | number>

export type PredictionFeaturePolicy = {
  key: 'player-rating' | 'execution-residual'
  mode: PredictionFeatureMode
  liveWeight: number
  shadowWeight: number
  gate: PredictionFeatureGate
  description: string
}

export function publishedFeatureWeight(policy: PredictionFeaturePolicy) {
  return policy.mode === 'live' ? policy.liveWeight : 0
}

export function shadowFeatureWeight(policy: PredictionFeaturePolicy) {
  return policy.mode === 'off' ? 0 : policy.shadowWeight
}
