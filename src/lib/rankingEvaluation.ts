import { binaryMetricContract, binaryPredictionLoss } from './binaryPredictionMetrics'

export type EvaluationRow = {
  id: string
  seriesId: string
  eventId: string
  date: string
  teamA: string
  teamB: string
  leagueA: string
  leagueB: string
  actual: 0 | 1
  probability: number
  segments: string[]
}

export type EvaluationExport = {
  schemaVersion: 1
  target: 'game' | 'series'
  modelVersion: string
  modelConfigHash: string
  sourceIdentity: string
  temporalPolicy: 'latest-corrected-prior-replay'
  metricContract: typeof binaryMetricContract
  rows: EvaluationRow[]
}

export function readEvaluationExport(input: unknown): EvaluationExport {
  const data = object(input)
  const metric = object(data.metricContract)
  if (data.schemaVersion !== 1 || (data.target !== 'game' && data.target !== 'series')
    || data.temporalPolicy !== 'latest-corrected-prior-replay'
    || Object.entries(binaryMetricContract).some(([key, value]) => metric[key] !== value)
    || !Array.isArray(data.rows)) throw new Error('Unsupported prediction export or metric/temporal contract')
  const rows = data.rows.map((value): EvaluationRow => {
    const row = object(value)
    const actual = row.actual
    if (actual !== 0 && actual !== 1) throw new Error('Outcome must be binary')
    if (typeof row.probability !== 'number' || !Number.isFinite(row.probability)
      || row.probability < 0 || row.probability > 1) throw new Error('Invalid probability')
    if (!Array.isArray(row.segments) || !row.segments.every((segment): segment is string => typeof segment === 'string')) {
      throw new Error('Invalid segments')
    }
    const result: EvaluationRow = { id: string(row.id), seriesId: string(row.seriesId), eventId: string(row.eventId),
      date: string(row.date), teamA: string(row.teamA), teamB: string(row.teamB),
      leagueA: string(row.leagueA), leagueB: string(row.leagueB), actual,
      probability: row.probability, segments: [...new Set(row.segments)].sort() }
    if (!validDate(result.date) || result.teamA === result.teamB) throw new Error('Invalid prediction date or teams')
    return result
  })
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error('Duplicate prediction identities')
  const seriesEvents = new Map<string, string>()
  for (const row of rows) {
    const previous = seriesEvents.get(row.seriesId)
    if (previous && previous !== row.eventId) throw new Error('Series crosses event identities')
    seriesEvents.set(row.seriesId, row.eventId)
    if (data.target === 'series' && row.id !== row.seriesId) throw new Error('Series target requires one row per series')
  }
  return { schemaVersion: 1, target: data.target, modelVersion: string(data.modelVersion),
    modelConfigHash: string(data.modelConfigHash), sourceIdentity: string(data.sourceIdentity),
    temporalPolicy: data.temporalPolicy, metricContract: binaryMetricContract,
    rows: rows.toSorted((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)) }
}

export function summarizeEvaluation(rows: readonly EvaluationRow[]) {
  const losses = rows.map((row) => binaryPredictionLoss(row.probability, row.actual === 1))
  const calibration = Array.from({ length: 10 }, (_, index) => {
    const bucket = rows.filter((row) => Math.min(9, Math.floor(row.probability * 10)) === index)
    return { lower: index / 10, upper: (index + 1) / 10, count: bucket.length,
      meanPredicted: mean(bucket.map((row) => row.probability)), observedWinRate: mean(bucket.map((row) => row.actual)) }
  })
  return { count: rows.length, series: new Set(rows.map((row) => row.seriesId)).size,
    events: new Set(rows.map((row) => row.eventId)).size,
    brier: mean(losses.map((loss) => loss.brierScore)), logLoss: mean(losses.map((loss) => loss.logLoss)),
    accuracy: mean(rows.map((row) => Number((row.probability >= 0.5) === (row.actual === 1)))),
    impossibleOutcomes: rows.filter((row) => row.actual ? row.probability === 0 : row.probability === 1).length,
    calibration }
}

type Pair = { old: EvaluationRow; next: EvaluationRow }
type Delta = { brier: number; logLoss: number }

export function compareEvaluationExports(oldInput: unknown, nextInput: unknown, iterations = 10_000) {
  if (!Number.isInteger(iterations) || iterations < 100) throw new Error('Bootstrap iterations must be at least 100')
  const oldData = readEvaluationExport(oldInput)
  const nextData = readEvaluationExport(nextInput)
  if (oldData.target !== nextData.target || oldData.sourceIdentity !== nextData.sourceIdentity) {
    throw new Error('Prediction target or source identities differ')
  }
  const oldById = new Map(oldData.rows.map((row) => [row.id, row]))
  if (oldById.size !== nextData.rows.length) throw new Error('Prediction identities differ')
  const pairs = nextData.rows.map((next): Pair => {
    const old = oldById.get(next.id)
    if (!old || ['seriesId', 'eventId', 'date', 'teamA', 'teamB', 'leagueA', 'leagueB', 'actual', 'segments']
      .some((key) => JSON.stringify(object(old)[key]) !== JSON.stringify(object(next)[key]))) {
      throw new Error(`Prediction cohort or outcome differs for ${next.id}`)
    }
    return { old, next }
  })
  const summarize = (selected: Pair[]) => {
    const old = summarizeEvaluation(selected.map((pair) => pair.old))
    const next = summarizeEvaluation(selected.map((pair) => pair.next))
    return { count: selected.length, old, next, brierDelta: difference(next.brier, old.brier),
      logLossDelta: difference(next.logLoss, old.logLoss),
      confidence95: clusterIntervals(selected, 'eventId', iterations),
      seriesSensitivity95: clusterIntervals(selected, 'seriesId', iterations) }
  }
  const global = summarize(pairs)
  const crossRegion = summarize(pairs.filter((pair) => pair.next.segments.includes('cross-region')))
  const segments = [...new Set(pairs.flatMap((pair) => pair.next.segments))].sort()
  const slices = Object.fromEntries(segments.map((segment) => [segment,
    summarize(pairs.filter((pair) => pair.next.segments.includes(segment)))]))
  const leagues = [...new Set(pairs.flatMap((pair) => [pair.next.leagueA, pair.next.leagueB]))]
    .filter((league) => league !== 'Unknown').sort().map((league) => ({ league,
      ...summarize(pairs.filter((pair) => pair.next.leagueA === league || pair.next.leagueB === league)) }))
  const failures: string[] = []
  const limits = (label: string, summary: typeof global) => {
    if (summary.confidence95.status !== 'estimated') failures.push(`${label}: insufficient independent events`)
    else {
      if (summary.confidence95.brier.high > 0.0005) failures.push(`${label} Brier upper bound exceeds 0.0005`)
      if (label === 'global' && summary.confidence95.logLoss.high > 0.001) failures.push('global log-loss upper bound exceeds 0.001')
    }
  }
  limits('global', global)
  limits('cross-region', crossRegion)
  if (crossRegion.brierDelta !== null && crossRegion.brierDelta > 0) failures.push('cross-region Brier point estimate worsened')
  for (const league of leagues) {
    if (league.count >= 50 && league.brierDelta !== null && league.brierDelta > 0.001) failures.push(`${league.league} Brier worsened by more than 0.001`)
  }
  for (const [segment, allowance] of [['roster-change', 0.001], ['partial-lineup', 0]] as const) {
    const slice = slices[segment]
    if (slice && slice.count >= 50 && slice.brierDelta !== null && slice.brierDelta > allowance) failures.push(`${segment} Brier worsened`)
  }
  return { target: nextData.target, metricContract: binaryMetricContract,
    oldModel: { version: oldData.modelVersion, configHash: oldData.modelConfigHash },
    nextModel: { version: nextData.modelVersion, configHash: nextData.modelConfigHash },
    pairedPredictions: pairs.length, global, crossRegion, slices, leagues,
    superiority: { status: global.confidence95.status === 'estimated' && global.confidence95.logLoss.high < 0
      ? 'supported-on-this-cohort' : 'inconclusive', publishedAccuracyClaim: false },
    passed: failures.length === 0, failures }
}

function clusterIntervals(pairs: Pair[], key: 'eventId' | 'seriesId', iterations: number) {
  const grouped = [...groupEvaluationBy(pairs, (pair) => pair.next[key]).values()]
  // Two clusters produce a numerical interval but no useful event uncertainty estimate.
  if (grouped.length < 5) return { status: 'unavailable' as const, clusters: grouped.length,
    reason: 'fewer-than-five-independent-clusters' }
  const aggregates = grouped.map((cluster) => ({ count: cluster.length,
    brier: cluster.reduce((total, pair) => total + lossDelta(pair).brier, 0),
    logLoss: cluster.reduce((total, pair) => total + lossDelta(pair).logLoss, 0) }))
  const random = seededRandom(0x51a7e)
  const brier: number[] = []; const logLoss: number[] = []
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let count = 0; let brierSum = 0; let logLossSum = 0
    for (let index = 0; index < aggregates.length; index += 1) {
      const cluster = aggregates[Math.floor(random() * aggregates.length)]
      count += cluster.count; brierSum += cluster.brier; logLossSum += cluster.logLoss
    }
    brier.push(brierSum / count); logLoss.push(logLossSum / count)
  }
  return { status: 'estimated' as const, clusters: grouped.length, brier: interval(brier), logLoss: interval(logLoss) }
}

export function chronologicalCohorts(rows: EvaluationRow[], fitThrough: string, validateThrough: string) {
  if (!validDate(fitThrough) || !validDate(validateThrough) || fitThrough >= validateThrough) throw new Error('Invalid chronological fold')
  const fit: EvaluationRow[] = []; const validation: EvaluationRow[] = []; const excluded: EvaluationRow[] = []
  for (const event of groupEvaluationBy(rows, (row) => row.eventId).values()) {
    const dates = event.map((row) => row.date).sort()
    if (dates.at(-1)! <= fitThrough) fit.push(...event)
    else if (dates[0] > fitThrough && dates.at(-1)! <= validateThrough) validation.push(...event)
    else excluded.push(...event)
  }
  return { fit, validation, excluded }
}

export function groupEvaluationBy<T>(values: readonly T[], key: (value: T) => string) {
  const groups = new Map<string, T[]>()
  for (const value of values) {
    const id = key(value)
    const group = groups.get(id) ?? []
    group.push(value); groups.set(id, group)
  }
  return groups
}

export function seededRandom(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

function lossDelta(pair: Pair): Delta {
  const old = binaryPredictionLoss(pair.old.probability, pair.old.actual === 1)
  const next = binaryPredictionLoss(pair.next.probability, pair.next.actual === 1)
  return { brier: next.brierScore - old.brierScore, logLoss: next.logLoss - old.logLoss }
}
function interval(values: number[]) {
  values.sort((a, b) => a - b)
  return { low: values[Math.floor(values.length * .025)], high: values[Math.floor(values.length * .975)] }
}
function mean(values: number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null }
function difference(a: number | null, b: number | null) { return a === null || b === null ? null : a - b }
function validDate(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value }
function string(input: unknown) { if (typeof input !== 'string' || !input.trim()) throw new Error('Missing prediction identity'); return input }
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected prediction object')
  return Object.fromEntries(Object.entries(input))
}
