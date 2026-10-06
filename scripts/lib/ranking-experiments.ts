import { chronologicalCohorts, seededRandom, summarizeEvaluation, type EvaluationExport } from '../../src/lib/rankingEvaluation'

export const searchParameters = [
  { file: 'src/lib/modelConfig.ts', key: 'recencyHalfLifeDays', group: 'temporal', low: 240, high: 720 },
  { file: 'src/lib/modelConfig.ts', key: 'normalPatchTeamRetention', group: 'temporal', low: .95, high: 1 },
  { file: 'src/lib/modelConfig.ts', key: 'splitBreakTeamRetention', group: 'temporal', low: .8, high: 1 },
  { file: 'src/lib/modelConfig.ts', key: 'seasonStartTeamRetention', group: 'temporal', low: .6, high: 1 },
  { file: 'src/lib/modelConfig.ts', key: 'winProbabilityUncertaintyScale', group: 'probability', low: 400, high: 1200 },
  { file: 'src/lib/modelConfig.ts', key: 'winProbabilityUncertaintyFloor', group: 'probability', low: .35, high: .65 },
  { file: 'src/lib/playerModel.ts', key: 'playerPregameEdgeCoefficient', group: 'player', low: 1, high: 4 },
  { file: 'src/lib/modelConfig.ts', key: 'momentumGameDecay', group: 'momentum', low: .75, high: .97 },
  { file: 'src/lib/modelConfig.ts', key: 'momentumCap', group: 'momentum', low: 30, high: 100 },
  { file: 'src/lib/modelConfig.ts', key: 'tier-two', group: 'transfer', low: .45, high: 1 },
  { file: 'src/lib/modelConfig.ts', key: 'tier-three', group: 'transfer', low: .25, high: .45 },
  { file: 'src/lib/modelConfig.ts', key: 'emerging', group: 'transfer', low: .1, high: .25 },
] as const
export type SearchValues = Record<typeof searchParameters[number]['key'], number>

function parameterPattern(key: string) {
  return key.includes('-') || key === 'emerging'
    ? new RegExp(`(${key.includes('-') ? `'${key}'` : key}:\\s*)([0-9.]+)`, 'g')
    : new RegExp(`((?:export )?const ${key} = )([0-9.]+)`, 'g')
}

export function readSearchValues(files: ReadonlyMap<string, string>): SearchValues {
  return Object.fromEntries(searchParameters.map((parameter) => {
    const matches = [...(files.get(parameter.file) ?? '').matchAll(parameterPattern(parameter.key))]
    if (matches.length !== 1) throw new Error(`Expected one numeric definition for ${parameter.key}`)
    return [parameter.key, Number(matches[0][2])]
  })) as SearchValues
}

export function applySearchValues(files: ReadonlyMap<string, string>, values: SearchValues) {
  const result = new Map(files)
  for (const parameter of searchParameters) {
    const value = values[parameter.key]
    if (!Number.isFinite(value) || value < parameter.low || value > parameter.high) throw new Error(`Parameter outside bounds: ${parameter.key}`)
    const original = result.get(parameter.file)!
    if ([...original.matchAll(parameterPattern(parameter.key))].length !== 1) throw new Error(`Ambiguous parameter: ${parameter.key}`)
    result.set(parameter.file, original.replace(parameterPattern(parameter.key), (_, prefix: string) => `${prefix}${value}`))
  }
  return result
}

export function searchTrials(baseline: SearchValues, seed: number, maximum: number) {
  if (!Number.isInteger(maximum) || maximum < 6 || maximum > 24) throw new Error('Search requires 6 to 24 trials')
  const random = seededRandom(seed)
  const groups = [...new Set(searchParameters.map((parameter) => parameter.group))]
  const values = [baseline, ...groups.map((group) => ({ ...baseline, ...Object.fromEntries(
    searchParameters.filter((parameter) => parameter.group === group).map((parameter) => [parameter.key, (parameter.low + parameter.high) / 2]),
  ) }))]
  while (values.length < maximum) values.push(Object.fromEntries(searchParameters.map((parameter) => [parameter.key,
    parameter.low + random() * (parameter.high - parameter.low)])) as SearchValues)
  return values.map((parameters, index) => ({ index, label: index === 0 ? 'baseline' : index <= groups.length ? `group:${groups[index - 1]}` : 'joint', parameters }))
}

export function scoreTrial(data: EvaluationExport, folds: Array<{ fitThrough: string; validateThrough: string }>) {
  return folds.map((fold) => {
    const cohort = chronologicalCohorts(data.rows, fold.fitThrough, fold.validateThrough)
    return { ...fold, fit: summarizeEvaluation(cohort.fit), validation: summarizeEvaluation(cohort.validation) }
  })
}

/** Legal observed paths. A common latent logit shift models within-series dependence. */
export function seriesPathLikelihood(outcomes: readonly (0 | 1)[], probabilities: readonly number[], bestOf: 1 | 2 | 3 | 5, dependence = 0) {
  if (outcomes.length !== probabilities.length || !outcomes.length || outcomes.length > bestOf
    || probabilities.some((value) => !Number.isFinite(value) || value <= 0 || value >= 1)
    || !Number.isFinite(dependence) || dependence < 0) throw new Error('Invalid series likelihood input')
  const needed = Math.floor(bestOf / 2) + 1
  let wins = 0
  for (let index = 0; index < outcomes.length; index += 1) {
    wins += outcomes[index]
    if (bestOf !== 2 && (wins >= needed || index + 1 - wins >= needed) && index !== outcomes.length - 1) throw new Error('Games after series stop')
  }
  const complete = bestOf === 2 ? outcomes.length === 2 : wins >= needed || outcomes.length - wins >= needed
  const mixture = [-dependence, 0, dependence].map((shift, index) => {
    const weight = index === 1 ? 2 / 3 : 1 / 6
    const adjusted = probabilities.map((p) => 1 / (1 + Math.exp(-Math.log(p / (1 - p)) - shift)))
    const likelihood = adjusted.reduce((total, p, i) => total * (outcomes[i] ? p : 1 - p), 1)
    return { weight, likelihood, gradient: adjusted.reduce((total, p, i) => total + outcomes[i] - p, 0) }
  })
  const likelihood = mixture.reduce((total, term) => total + term.weight * term.likelihood, 0)
  return { complete, likelihood, logLoss: -Math.log(likelihood),
    gradient: mixture.reduce((total, term) => total + term.weight * term.likelihood * term.gradient, 0) / likelihood }
}

/** Sum legal paths for a score when the source cannot certify the observed game order. */
export function seriesScoreLikelihood(winsA: number, winsB: number, probabilities: readonly number[], bestOf: 1 | 2 | 3 | 5, dependence = 0) {
  if (![winsA, winsB].every((value) => Number.isInteger(value) && value >= 0)
    || winsA + winsB !== probabilities.length || !probabilities.length || probabilities.length > bestOf) throw new Error('Invalid series score')
  const paths: ReturnType<typeof seriesPathLikelihood>[] = []
  const visit = (outcomes: Array<0 | 1>, a: number, b: number) => {
    if (a > winsA || b > winsB) return
    if (outcomes.length === probabilities.length) { paths.push(seriesPathLikelihood(outcomes, probabilities, bestOf, dependence)); return }
    const needed = Math.floor(bestOf / 2) + 1
    if (bestOf !== 2 && (a >= needed || b >= needed)) return
    visit([...outcomes, 1], a + 1, b); visit([...outcomes, 0], a, b + 1)
  }
  visit([], 0, 0)
  if (!paths.length) throw new Error('Impossible series score')
  const likelihood = paths.reduce((sum, path) => sum + path.likelihood, 0)
  return { complete: paths[0].complete, likelihood, logLoss: -Math.log(likelihood),
    gradient: paths.reduce((sum, path) => sum + path.likelihood * path.gradient, 0) / likelihood }
}
