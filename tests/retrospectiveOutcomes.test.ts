import assert from 'node:assert/strict'
import test from 'node:test'
import { candidates, evaluateOutcomes, pairedComparison, parseOutcomeRows, replayOutcomes } from '../tools/calibration/retrospective-outcomes.ts'
import type { OutcomeSeries } from '../tools/calibration/retrospective-outcomes.ts'

function row(id: string, date = '2025-02-01') {
  return { id, seriesId: id, date, datetimeUtc: `${date}T12:00:00.000Z`, event: `event-${date}`,
    bestOf: 1, gameNumber: 1, teamA: { id: 'a' }, teamB: { id: 'b' }, winnerId: 'a',
    seriesState: 'completed', seriesWinsA: 1, seriesWinsB: 0 }
}
function series(id: string, date: string, outcome: 0 | 1 = 1): OutcomeSeries {
  return { id, date, event: `event-${date}`, teamA: 'a', teamB: 'b', bestOf: 1, outcome, gameIds: [id] }
}

test('all same-date predictions use prior-date state and do not learn the current result', () => {
  const a = series('a', '2025-02-01'), b = series('b', '2025-02-01'), c = series('c', '2025-02-02')
  const rows = replayOutcomes([c, b, a], candidates[0])
  assert.equal(rows[0].probability, .5)
  assert.equal(rows[1].probability, .5)
  assert.equal(rows[1].priorSeriesA, 0)
  assert.ok(rows[2].probability > .5)
  assert.equal(rows[2].priorSeriesA, 2)
  const changed = replayOutcomes([a, { ...b, outcome: 0 }, c], candidates[0])
  assert.equal(changed[1].probability, rows[1].probability)
  assert.equal(changed[2].probability, .5)
})

test('future outcomes and row order cannot change earlier predictions', () => {
  const input = [series('a', '2025-02-01'), series('b', '2025-02-02'), series('c', '2026-02-01')]
  const base = replayOutcomes(input, candidates[3])
  const changed = replayOutcomes([ { ...input[2], outcome: 0 }, input[1], input[0] ], candidates[3])
  assert.deepEqual(base.map(s => s.probability), changed.map(s => s.probability))
  assert.deepEqual(input[0], series('a', '2025-02-01'))
})

test('format conversion, inactivity and calendar mean reversion change only later predictions', () => {
  const input = [series('a', '2025-02-01'), series('b', '2026-02-01')]
  const base = replayOutcomes(input, candidates[0])
  for (const candidate of [candidates[3], candidates[4], candidates[5]]) {
    const next = replayOutcomes(input, candidate)
    assert.equal(next[0].probability, base[0].probability)
    assert.ok(next[1].probability > .5 && next[1].probability < base[1].probability)
  }
  const bo3 = replayOutcomes([input[0], { ...input[1], bestOf: 3 }], candidates[0])
  const bo5 = replayOutcomes([input[0], { ...input[1], bestOf: 5 }], candidates[0])
  assert.ok(base[1].probability < bo3[1].probability && bo3[1].probability < bo5[1].probability)
})

test('parser rejects duplicate games, wrong team joins, conflicting formats and invalid dates', () => {
  assert.throws(() => parseOutcomeRows([row('a'), row('a')]), /Duplicate game/)
  assert.throws(() => parseOutcomeRows([{ ...row('a'), winnerId: 'absent' }]), /team\/winner join/)
  assert.throws(() => parseOutcomeRows([{ ...row('a'), date: '2025-02-30' }]), /Invalid UTC date/)
  assert.throws(() => parseOutcomeRows([{ ...row('a'), bestOf: 2 }]), /Unsupported/)
  assert.throws(() => parseOutcomeRows([row('a'), { ...row('b'), seriesId: 'a', bestOf: 3 }]), /Conflicting series identity/)
  assert.throws(() => parseOutcomeRows([row('a'), { ...row('b'), seriesId: 'a', teamB: { id: 'c' } }]), /Conflicting series identity/)
})

test('parser quarantines missing games and invalid terminal scores without inventing results', () => {
  const first = { ...row('a'), bestOf: 3 }
  const final = { ...row('b'), seriesId: 'a', bestOf: 3, gameNumber: 2, seriesWinsA: 2 }
  assert.equal(parseOutcomeRows([first, final]).series.length, 1)
  assert.deepEqual(parseOutcomeRows([first]).excluded, [{ id: 'a', reason: 'nonterminal-completed' }])
  assert.deepEqual(parseOutcomeRows([first, { ...final, gameNumber: 3 }]).excluded, [{ id: 'a', reason: 'invalid-game-sequence' }])
  assert.deepEqual(parseOutcomeRows([first, { ...final, seriesWinsA: 1 }]).excluded, [{ id: 'a', reason: 'invalid-cumulative-score' }])
})

test('team orientation changes preserve canonical series outcome and cumulative score checks', () => {
  const first = { ...row('a'), bestOf: 3 }
  const final = { ...row('b'), seriesId: 'a', bestOf: 3, gameNumber: 2,
    teamA: { id: 'b' }, teamB: { id: 'a' }, seriesWinsA: 0, seriesWinsB: 2 }
  const parsed = parseOutcomeRows([first, final])
  assert.equal(parsed.series[0].teamA, 'a')
  assert.equal(parsed.series[0].outcome, 1)
})

test('incomplete series, cross-date series and events crossing development boundaries cannot update state', () => {
  const incomplete = { ...row('ongoing'), bestOf: 3, seriesState: 'ongoing' }
  const first = { ...row('cross', '2025-02-01'), bestOf: 3 }
  const last = { ...row('cross2', '2025-02-02'), seriesId: 'cross', event: first.event,
    bestOf: 3, gameNumber: 2, seriesWinsA: 2 }
  const boundary = [row('march', '2025-03-31'), { ...row('april', '2025-04-01'), event: 'event-2025-03-31' }]
  const result = parseOutcomeRows([incomplete, first, last, ...boundary, row('valid')])
  assert.deepEqual(result.series.map(s => s.id), ['valid'])
  assert.deepEqual(result.excluded.map(s => s.reason).sort(), ['boundary-event', 'boundary-event', 'cross-utc-date', 'ongoing'])
})

test('development selection cannot see any 2026 labels and retains three fixed folds', () => {
  const input = [series('warmup', '2025-02-01'), series('q2', '2025-05-01'),
    series('q3', '2025-08-01'), series('q4', '2025-11-01'), series('test', '2026-02-01')]
  const base = evaluateOutcomes(input)
  const changed = evaluateOutcomes([...input.slice(0, -1), { ...input.at(-1)!, outcome: 0 }])
  assert.deepEqual(base.selected, changed.selected)
  assert.deepEqual(base.development, changed.development)
  assert.equal(base.development[0].folds.length, 3)
  assert.deepEqual(base.warmupIds, ['warmup'])
  assert.equal(base.predictions[0].probability, changed.predictions[0].probability)
})

test('paired evaluation rejects label or identity mismatches and bootstrap is deterministic', () => {
  const rows = replayOutcomes([series('a', '2025-02-01'), series('b', '2025-02-02')], candidates[0])
  const other = replayOutcomes([series('a', '2025-02-01'), series('b', '2025-02-02')], candidates[2])
  assert.deepEqual(pairedComparison(rows, other), pairedComparison(rows, other))
  assert.throws(() => pairedComparison(rows, [...other].reverse()), /identity mismatch/)
  assert.throws(() => pairedComparison(rows, other.map(s => ({ ...s, outcome: 0 }))), /identity mismatch/)
  assert.throws(() => pairedComparison(rows, []), /Invalid paired cohort/)
  assert.deepEqual(pairedComparison(rows, rows).eventBootstrap.percentile95.brier, [0, 0])
})

test('invalid candidate settings and empty evaluation cohorts fail closed', () => {
  assert.throws(() => replayOutcomes([], { ...candidates[0], k: NaN }), /Invalid candidate/)
  assert.throws(() => replayOutcomes([], { ...candidates[0], halfLife: -1 }), /Invalid candidate/)
  assert.throws(() => evaluateOutcomes([]), /Empty scoring cohort/)
})
