import assert from 'node:assert/strict'
import test from 'node:test'
import { binaryMetricContract } from '../src/lib/binaryPredictionMetrics.ts'
import { chronologicalCohorts, compareEvaluationExports, readEvaluationExport, summarizeEvaluation, type EvaluationExport } from '../src/lib/rankingEvaluation.ts'
import { buildEvaluationData } from '../src/lib/rankingEvaluationData.ts'
import { createRatingReplayContext, replayRatingDates } from '../src/lib/model.ts'
import { seriesWinProbability } from '../src/lib/winProbability.ts'
import type { MatchRecord, PregamePrediction } from '../src/types.ts'
import { sampleMatches, teams } from './fixtures/rankingFixtures.ts'

function fixture(): EvaluationExport {
  return { schemaVersion: 1, target: 'game', modelVersion: 'fixture', modelConfigHash: 'fixture',
    sourceIdentity: 'synthetic-fixture', temporalPolicy: 'latest-corrected-prior-replay', metricContract: binaryMetricContract,
    rows: Array.from({ length: 6 }, (_, index) => ({ id: `game-${index}`, seriesId: `series-${index}`,
      eventId: `event-${index}`, date: '2025-01-01', teamA: 'Alpha', teamB: 'Beta', leagueA: 'LCK', leagueB: 'LPL',
      actual: 1, probability: 0.5, segments: ['cross-region'] })) }
}

test('prediction pairing rejects duplicate IDs, swapped sides, changed outcomes, targets, source and segments', () => {
  const base = fixture()
  const mutations = [
    { ...base, rows: [base.rows[0], base.rows[0]] },
    { ...base, rows: base.rows.map((row) => ({ ...row, teamA: 'Beta', teamB: 'Alpha' })) },
    { ...base, rows: base.rows.map((row) => ({ ...row, actual: 0 })) },
    { ...base, rows: base.rows.map((row) => ({ ...row, segments: [] })) },
    { ...base, target: 'series' }, { ...base, sourceIdentity: 'different-corpus' },
    { ...base, rows: base.rows.map((row) => ({ ...row, probability: NaN })) },
  ]
  for (const changed of mutations) assert.throws(() => compareEvaluationExports(base, changed, 100))
})

test('empty and event-poor comparisons remain unavailable and cannot pass the gate', () => {
  const base = fixture()
  const empty = { ...base, rows: [] }
  const result = compareEvaluationExports(empty, empty, 100)
  assert.equal(result.passed, false)
  assert.equal(result.global.brierDelta, null)
  assert.equal(result.global.confidence95.status, 'unavailable')
  const oneEvent = { ...base, rows: base.rows.map((row) => ({ ...row, eventId: 'one-tournament' })) }
  assert.equal(compareEvaluationExports(oneEvent, oneEvent, 100).passed, false)
  const domestic = { ...base, rows: base.rows.map((row) => ({ ...row, segments: [] })) }
  assert.equal(compareEvaluationExports(domestic, domestic, 100).passed, false)
})

test('event-aware bootstrap preserves common event effects and reproduces paired losses', () => {
  const base = fixture()
  const next = { ...base, rows: base.rows.map((row) => ({ ...row, probability: .75 })) }
  const result = compareEvaluationExports(base, next, 100)
  assert.equal(result.global.brierDelta, -.1875)
  assert.equal(result.global.confidence95.status, 'estimated')
  assert.equal(result.passed, true)
  assert.equal(result.superiority.status, 'supported-on-this-cohort')
  assert.equal(result.superiority.publishedAccuracyClaim, false)
  assert.deepEqual(result, compareEvaluationExports(base, next, 100))
  const duplicatedGames = { ...next, rows: next.rows.flatMap((row) => [row, { ...row, id: row.id + '-second' }]) }
  assert.equal(summarizeEvaluation(duplicatedGames.rows).events, 6)
})

test('metric endpoints, bins and missing denominators match the shared versioned contract', () => {
  const row = fixture().rows[0]
  const result = summarizeEvaluation([{ ...row, probability: 0 }, { ...row, id: 'right', probability: 1 }])
  assert.equal(result.brier, .5)
  assert.equal(result.logLoss, (-Math.log(.001) - Math.log(.999)) / 2)
  assert.equal(result.impossibleOutcomes, 1)
  assert.equal(result.calibration[9].count, 1)
  assert.equal(result.calibration[1].meanPredicted, null)
  assert.equal(summarizeEvaluation([]).accuracy, null)
  assert.throws(() => readEvaluationExport({ ...fixture(), metricContract: {} }))
})

test('chronological folds withhold whole events that cross a boundary', () => {
  const row = fixture().rows[0]
  const rows = [row, { ...row, id: 'later', date: '2025-05-01' },
    { ...row, id: 'validation', seriesId: 'second', eventId: 'second', date: '2025-06-01' }]
  const split = chronologicalCohorts(rows, '2025-04-01', '2025-06-30')
  assert.equal(split.fit.length, 0)
  assert.equal(split.validation.length, 1)
  assert.equal(split.excluded.length, 2)
})

test('export builder rejects stale source joins, duplicate identities and mixed model identities', () => {
  const matches = sampleMatches.slice(0, 2)
  const context = createRatingReplayContext(matches, { ...teams })
  const { predictions } = replayRatingDates({ context, replayMatches: matches })
  const exportPredictions = (rows: PregamePrediction[], source = matches) =>
    buildEvaluationData(source, rows, { sourceIdentity: 'synthetic-fixture' })
  const first = predictions[0]
  const mutations: Array<Partial<PregamePrediction>> = [
    { teamA: first.teamB, teamB: first.teamA },
    { teamA: 'Different team' }, { date: '2025-01-01' }, { event: 'Different event' },
    { actualWinner: first.teamB }, { seriesId: 'different-series' },
  ]
  for (const mutation of mutations) assert.throws(() => exportPredictions([{ ...first, ...mutation }, predictions[1]]), /source or orientation differs/)
  assert.throws(() => exportPredictions([first, first]), /Duplicate prediction identities/)
  assert.throws(() => exportPredictions(predictions, [matches[0], matches[0]]), /Duplicate source match identities/)
  assert.throws(() => exportPredictions([first, { ...predictions[1], modelVersion: 'different-model' }]), /Mixed prediction model identities/)
  assert.throws(() => exportPredictions([first, { ...predictions[1], modelConfigHash: 'different-config' }]), /Mixed prediction model identities/)
})

test('exported aliases and swapped raw sides keep game and series probabilities aligned with canonical outcomes', () => {
  const alias = 'LYON (2024 American Team)'
  const matches: MatchRecord[] = [
    { ...sampleMatches[0], id: 'alias-1', officialMatchId: 'alias-series', gameNumber: 1,
      teamA: alias, teamB: 'Beta', winner: 'LYON', bestOf: 3 },
    { ...sampleMatches[0], id: 'alias-2', officialMatchId: 'alias-series', gameNumber: 2,
      teamA: 'Beta', teamB: 'LYON', winner: 'Beta', bestOf: 3 },
    { ...sampleMatches[0], id: 'alias-3', officialMatchId: 'alias-series', gameNumber: 3,
      teamA: 'LYON', teamB: 'Beta', winner: alias, bestOf: 3 },
  ]
  const templateContext = createRatingReplayContext(sampleMatches, { ...teams })
  const template = replayRatingDates({ context: templateContext, replayMatches: sampleMatches }).predictions[0]
  const predictions = matches.map((match): PregamePrediction => ({ ...template,
    id: match.id, seriesId: undefined, date: match.date, event: match.event,
    teamA: match.teamA === alias ? 'LYON' : match.teamA, teamB: match.teamB,
    actualWinner: match.winner, teamAGameWinProbability: match.teamA === 'Beta' ? .2 : .8 }))
  const exported = buildEvaluationData(matches, predictions, { sourceIdentity: 'synthetic-alias-fixture' })
  assert.deepEqual(exported.rows.map((row) => [row.teamA, row.teamB, row.actual, row.probability]), [
    ['LYON', 'Beta', 1, .8], ['Beta', 'LYON', 1, .2], ['LYON', 'Beta', 1, .8],
  ])
  assert.equal(exported.seriesExport.rows.length, 1)
  assert.equal(exported.seriesExport.rows[0].teamA, 'LYON')
  assert.equal(exported.seriesExport.rows[0].actual, 1)
  assert.equal(exported.seriesExport.rows[0].probability, seriesWinProbability(.8, 3))
})
