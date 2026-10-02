import assert from 'node:assert/strict'
import test from 'node:test'
import { binaryPredictionLoss } from '../src/lib/binaryPredictionMetrics.ts'
import { summarizeOfflineForecastMetrics, type SyntheticBaselineFixture } from '../src/lib/offlineForecastMetrics.ts'
import { before, outcome, receipt, replay } from './fixtures/offlineForecastFixtures.ts'

function cohort(probabilities: number[], wins = probabilities.map(() => true)) {
  const receipts = probabilities.map((probability, index) => {
    const row = receipt(String(index))
    const matchId = `fixture-${index}`
    const eventStateVersion = JSON.stringify([matchId, row.eventId, row.scheduledStartAt, 'upcoming', 'unstarted', row.bestOf,
      [['alpha', null, null], ['beta', null, null]]])
    return { ...row, matchId, eventStateVersion,
      receiptKey: JSON.stringify([matchId, eventStateVersion, row.forecastRevision]),
      homeSeriesWinProbability: probability, awaySeriesWinProbability: 1 - probability }
  })
  const result = replay(receipts, receipts.map((row, index) => ({ ...outcome, matchId: row.matchId,
    gameWins: (wins[index] ? [3, 1] : [1, 3]) as [number, number] })))
  assert.equal(result.status, 'replayed')
  if (result.status !== 'replayed') throw new Error('Fixture cohort unavailable')
  assert.equal(result.rows.length, probabilities.length)
  return result
}

function baseline(rows: SyntheticBaselineFixture['rows']): SyntheticBaselineFixture {
  return { key: 'synthetic-series-reference', modelVersion: 'fixture-baseline-v1', modelConfigHash: 'fixture-baseline-config',
    evidence: { kind: 'synthetic-fixture', reference: 'tests/offlineForecastMetrics.test.ts' }, rows }
}
function summarized(input = cohort([0.2, 0.8], [false, true]), baselines: SyntheticBaselineFixture[] = []) {
  const result = summarizeOfflineForecastMetrics(input, baselines)
  assert.equal(result.status, 'summarized')
  if (result.status !== 'summarized') throw new Error('Fixture metrics unavailable')
  return result
}
function close(actual: number | null, expected: number) {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`)
}

test('hand-computable home-oriented bins and losses retain offline provenance', () => {
  const input = cohort([0, 0.2, 0.2, 0.5, 0.8, 1], [false, true, false, true, true, true])
  const original = structuredClone(input)
  const result = summarized(input)
  assert.equal(result.seriesCount, 6)
  assert.equal(result.eventCount, 1)
  assert.equal(result.target, 'series')
  assert.equal(result.evaluationEligible, false)
  assert.deepEqual(result.policy, input.policy)
  assert.equal(result.evidenceReference, input.evidenceReference)
  assert.deepEqual(result.calibration, input.calibration)
  assert.equal(result.uncertainty.status, 'unsupported')
  assert.deepEqual(result.bins.map((bin) => bin.count), [1, 0, 2, 0, 0, 1, 0, 0, 1, 1])
  close(result.bins[2].meanPredicted, 0.2)
  close(result.bins[2].observedWinRate, 0.5)
  assert.equal(result.bins[1].meanPredicted, null)
  assert.equal(result.bins[1].observedWinRate, null)
  assert.equal(result.bins[9].upperInclusive, true)
  close(result.metrics.brierScore, (0.64 + 0.04 + 0.25 + 0.04) / 6)
  close(result.metrics.logLoss, (-2 * Math.log(0.999) - Math.log(0.2) - 2 * Math.log(0.8) - Math.log(0.5)) / 6)
  assert.equal(result.metrics.impossibleOutcomeCount, 0)
  assert.deepEqual(input, original)
})

test('empty, tiny, all-correct/all-wrong and exact zero/one cases are explicit', () => {
  const empty = summarized(cohort([]))
  assert.deepEqual(empty.metrics, { count: 0, brierScore: null, logLoss: null, impossibleOutcomeCount: 0 })
  assert.equal(empty.baselineComparisons[0].forecastBrierImprovement, null)
  assert.equal(empty.baselineComparisons[0].pairedCount, 0)
  close(summarized(cohort([0.5])).metrics.logLoss, Math.log(2))
  for (const correct of [true, false]) {
    const result = summarized(cohort([0, 1], [!correct, correct]))
    close(result.metrics.brierScore, correct ? 0 : 1)
    close(result.metrics.logLoss, -Math.log(correct ? 0.999 : 0.001))
    assert.equal(result.metrics.impossibleOutcomeCount, correct ? 0 : 2)
  }
  assert.equal(empty.metricContract.version, 'binary-brier-clipped-log-loss-v1')
  assert.deepEqual(binaryPredictionLoss(0, true), { brierScore: 1, logLoss: -Math.log(0.001) })
})

test('baseline comparison scores both forecasts on the identical paired subset', () => {
  const input = cohort([0.9, 0.2, 0.8], [true, true, false])
  const rows = [{ receiptKey: input.rows[0].receiptKey, homeWinProbability: 0.5, informationAsOf: before }]
  const fixture = baseline([...rows, ...rows, { receiptKey: 'unmatched', homeWinProbability: 0.5, informationAsOf: before }])
  const result = summarized(input, [fixture])
  const paired = result.baselineComparisons[1]
  assert.equal(paired.pairedCount, 1)
  assert.equal(paired.forecast.count, paired.baseline.count)
  assert.deepEqual(paired.receiptKeys, [input.rows[0].receiptKey])
  close(paired.forecast.brierScore, 0.01)
  close(paired.baseline.brierScore, 0.25)
  close(paired.forecastBrierImprovement, 0.24)
  close(paired.forecastLogLossImprovement, Math.log(0.9 / 0.5))
  assert.deepEqual(paired.exclusions, input.rows.slice(1).map((row) => ({ receiptKey: row.receiptKey, reason: 'missing' })))
  assert.equal(paired.unmatchedBaselineRows, 1)
  assert.equal(result.baselineComparisons[0].pairedCount, 3)
  assert.equal(result.baselineComparisons[0].baseline.brierScore, 0.25)
  assert.deepEqual(result, summarized(input, [baseline([...fixture.rows].reverse())]))
  assert.equal('modelVersion' in paired && paired.modelVersion, fixture.modelVersion)
})

test('conflicting, invalid and late baseline rows cannot alter a paired denominator', () => {
  const input = cohort([0.8, 0.8, 0.8, 0.8])
  const rows = input.rows.map((row) => ({ receiptKey: row.receiptKey, homeWinProbability: 0.5, informationAsOf: before }))
  rows[1].homeWinProbability = Number.NaN
  rows[2].informationAsOf = outcome.startedAt
  rows[3].informationAsOf = 'invalid'
  const fixture = baseline([...rows, { ...rows[0], homeWinProbability: 0.6 }])
  const result = summarized(input, [fixture]).baselineComparisons[1]
  assert.equal(result.pairedCount, 0)
  assert.equal(result.forecastBrierImprovement, null)
  assert.deepEqual(result.exclusions.map((row) => row.reason), ['conflicting', 'invalid-probability', 'after-information-cutoff', 'after-information-cutoff'])
})

test('a worse forecast has negative paired improvement and baseline endpoint errors remain visible', () => {
  const input = cohort([0.2, 0.8], [true, false])
  const result = summarized(input)
  close(result.baselineComparisons[0].forecastBrierImprovement, -0.39)
  close(result.baselineComparisons[0].forecastLogLossImprovement, Math.log(0.2 / 0.5))
  const fixture = baseline(input.rows.map((row) => ({ receiptKey: row.receiptKey,
    homeWinProbability: row.homeWon ? 0 : 1, informationAsOf: before })))
  const paired = summarized(input, [fixture]).baselineComparisons[1]
  assert.equal(paired.baseline.impossibleOutcomeCount, 2)
  close(paired.baseline.logLoss, -Math.log(0.001))
})

test('unsupported cohorts, duplicated series, invalid probabilities and ambiguous baseline provenance fail closed', () => {
  assert.deepEqual(summarizeOfflineForecastMetrics({ status: 'unsupported', reason: 'invalid-ledger' }),
    { status: 'unsupported', reason: 'invalid-ledger' })
  const input = cohort([0.5])
  assert.deepEqual(summarizeOfflineForecastMetrics({ ...input, rows: [...input.rows, ...input.rows] }),
    { status: 'unsupported', reason: 'invalid-series-cohort' })
  for (const probability of [-0.1, 1.1, Infinity, NaN]) {
    assert.equal(summarizeOfflineForecastMetrics({ ...input, rows: [{ ...input.rows[0], homeWinProbability: probability }] }).status, 'unsupported')
  }
  for (const fixtures of [[baseline([]), baseline([])], [{ ...baseline([]), key: 'coin-flip' }], [{ ...baseline([]), modelVersion: '' }]]) {
    assert.deepEqual(summarizeOfflineForecastMetrics(input, fixtures), { status: 'unsupported', reason: 'invalid-baseline-fixtures' })
  }
})
