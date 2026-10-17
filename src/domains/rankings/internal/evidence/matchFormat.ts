export type NormalizedBestOf = 1 | 2 | 3 | 5
export type DecisiveBestOf = 1 | 3 | 5

export function normalizedBestOf(bestOf: number): NormalizedBestOf {
  return bestOf === 2 || bestOf === 3 || bestOf === 5 ? bestOf : 1
}

export function normalizedDecisiveBestOf(bestOf: number): DecisiveBestOf {
  return bestOf === 3 || bestOf === 5 ? bestOf : 1
}
