import assert from 'node:assert/strict'
import test from 'node:test'
import { formatChartInfluence, formatProbability, nonMatchDeltaFor, isValidChartPoint } from '../src/lib/chartPoints.ts'

test('chart influence formatter describes the match behind a rating point', () => {
  assert.equal(
    formatChartInfluence({
      result: 'W',
      wins: 3,
      losses: 2,
      opponent: 'Gen.G',
      event: 'LCK 2026 Rounds 1-2',
      delta: 11,
    }),
    'W 3-2 vs Gen.G · LCK 2026 Rounds 1-2 · +11',
  )
})

test('chart point validation rejects malformed chart coordinates', () => {
  assert.equal(isValidChartPoint({ t: Date.UTC(2026, 5, 7), y: 1580 }), true)
  assert.equal(isValidChartPoint({ t: Number.NaN, y: 1580 }), false)
  assert.equal(isValidChartPoint({ t: Date.UTC(2026, 5, 7), y: Number.POSITIVE_INFINITY }), false)
})

test('chart influence formatter describes aggregated day-close points', () => {
  assert.equal(
    formatChartInfluence({
      dayMatchCount: 3,
      delta: -8,
    }),
    'Day close · 3 matches · match ledger -8',
  )
})

test('chart helpers reconcile visible movement against model attribution', () => {
  assert.equal(formatProbability(0.764), '76%')
  assert.equal(
    nonMatchDeltaFor({
      visibleDelta: -8,
      model: {
        attribution: [
          { key: 'stable', label: 'Stable', value: 5 },
          { key: 'roster', label: 'Roster', value: -12 },
        ],
      },
    }),
    -1,
  )
})
