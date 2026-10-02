/** Existing walk-forward contract: binary Brier and natural-log loss clipped at 0.001/0.999. */
export const binaryMetricContract = {
  version: 'binary-brier-clipped-log-loss-v1',
  logLossProbabilityFloor: 0.001,
  logLossProbabilityCeiling: 0.999,
} as const

export function binaryPredictionLoss(probability: number, won: boolean) {
  const observedProbability = Math.min(binaryMetricContract.logLossProbabilityCeiling,
    Math.max(binaryMetricContract.logLossProbabilityFloor, won ? probability : 1 - probability))
  return { brierScore: (probability - Number(won)) ** 2, logLoss: -Math.log(observedProbability) }
}
