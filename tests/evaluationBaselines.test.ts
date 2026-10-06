import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluationBaselineProbabilities, glickoRatingAt, updateGlicko } from '../src/lib/evaluationBaselines.ts'
import { evaluationHomeLeague } from '../src/lib/rankingEvaluationData.ts'
import { sampleMatches } from './fixtures/rankingFixtures.ts'

test('offline controls predict before a UTC-date update and ignore later results and metadata', () => {
  const first = { ...sampleMatches[0], id: 'first', date: '2025-01-01' }
  const second = { ...first, id: 'same-day' }
  const later = { ...first, id: 'later', date: '2025-02-01' }
  const base = evaluationBaselineProbabilities([first, second, later])
  assert.deepEqual(base.get(first.id), base.get(second.id))
  const changed = evaluationBaselineProbabilities([first, second, { ...later, winner: later.teamB,
    patch: 'future-patch', teamAHomeLeague: 'LPL' }])
  assert.deepEqual(base.get(first.id), changed.get(first.id))
  assert.deepEqual(base.get(later.id), changed.get(later.id))
  assert.ok(base.get(later.id)!.elo > .5)
  assert.equal(evaluationHomeLeague({ ...first, teamAHomeLeague: undefined }, 'A'), 'Unknown')
})

test('Glicko control matches the published Glicko-1 reference update and inactivity increases deviation', () => {
  const prior = { rating: 1500, deviation: 200, lastDate: '2025-01-01' }
  const next = updateGlicko(prior, [
    { opponent: { ...prior, rating: 1400, deviation: 30 }, outcome: 1 },
    { opponent: { ...prior, rating: 1550, deviation: 100 }, outcome: 0 },
    { opponent: { ...prior, rating: 1700, deviation: 300 }, outcome: 0 },
  ])
  assert.ok(Math.abs(next.rating - 1464) < .5)
  assert.ok(Math.abs(next.deviation - 151.40) < .01)
  assert.ok(glickoRatingAt(next, '2025-06-01').deviation > next.deviation)
  assert.ok(next.deviation < prior.deviation)
})
