export function temperatureProbability(probability: number, temperature: number) {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1
    || !Number.isFinite(temperature) || temperature <= 0) throw new Error('Invalid temperature calibration')
  if (temperature === 1 || probability === 0 || probability === 1) return probability
  return 1 / (1 + Math.exp(-Math.log(probability / (1 - probability)) / temperature))
}

export function seriesWinnerProbability(probabilities: readonly number[], bestOf: 1 | 3 | 5, dependence = 0) {
  if (![1, 3, 5].includes(bestOf) || probabilities.length !== bestOf
    || probabilities.some(p => !Number.isFinite(p) || p < 0 || p > 1)
    || !Number.isFinite(dependence) || dependence < 0) throw new Error('Invalid forward series input')
  const needed = (bestOf + 1) / 2
  const independent = (shift: number) => {
    const adjusted = probabilities.map(p => p === 0 || p === 1 || shift === 0 ? p : 1 / (1 + Math.exp(-Math.log(p / (1 - p)) - shift)))
    const visit = (a: number, b: number): number => a === needed ? 1 : b === needed ? 0
      : adjusted[a + b] * visit(a + 1, b) + (1 - adjusted[a + b]) * visit(a, b + 1)
    return visit(0, 0)
  }
  return dependence === 0 ? independent(0) : independent(-dependence) / 6 + independent(0) * 2 / 3 + independent(dependence) / 6
}
