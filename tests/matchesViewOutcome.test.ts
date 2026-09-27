import assert from 'node:assert/strict'
import test from 'node:test'
import { deltaBarWidth, seriesRatingChange } from '../src/components/matches/seriesOutcome.ts'
import type { PublicMatchHistoryEntry } from '../src/lib/publicArtifacts/schema.ts'

function series(overrides: Partial<PublicMatchHistoryEntry>): PublicMatchHistoryEntry {
  return {
    id: 'g1',
    date: '2026-07-21',
    event: 'KeSPA Cup',
    phase: 'Playoffs',
    league: 'KeSPA',
    region: 'LCK',
    patch: '26.14',
    bestOf: 1,
    gameNumber: 1,
    seriesId: 's1',
    seriesState: 'completed',
    seriesWinsA: 0,
    seriesWinsB: 1,
    teamA: { id: 'gen', name: 'Gen.G', code: 'GEN' },
    teamB: { id: 'bro', name: 'HANJIN BRION', code: 'BRO' },
    winnerId: 'bro',
    impact: { unit: 'series-applied', teamA: -45, teamB: 46, expectedTeamA: 0.78, eventWeight: 1.643 },
    source: { provider: 'leaguepedia-cargo' },
    ...overrides,
  }
}

test('reports the pre-match chance of the series winner and flags upsets', () => {
  const change = seriesRatingChange(series({}))
  assert.equal(change.kind, 'applied')
  if (change.kind !== 'applied') return
  assert.equal(change.chanceSide, 'B')
  assert.ok(Math.abs((change.chance ?? 0) - 0.22) < 1e-9)
  assert.equal(change.upset, true)

  const favourite = seriesRatingChange(series({ seriesWinsA: 1, seriesWinsB: 0, winnerId: 'gen', impact: { unit: 'series-applied', teamA: 20, teamB: -20, expectedTeamA: 0.78 } }))
  assert.equal(favourite.kind === 'applied' && favourite.upset, false)
})

test('hides the rating change when the deltas contradict the winner', () => {
  assert.deepEqual(seriesRatingChange(series({ impact: { unit: 'series-applied', teamA: 45, teamB: -46, expectedTeamA: 0.1 } })), { kind: 'missing' })
  assert.deepEqual(seriesRatingChange(series({ impact: { unit: 'held' } })), { kind: 'held' })
})

test('caps the delta bar and keeps small changes visible', () => {
  assert.equal(deltaBarWidth(120, 36), 36)
  assert.equal(deltaBarWidth(-25, 36), 18)
  assert.equal(deltaBarWidth(0.4, 36), 2)
  assert.equal(deltaBarWidth(0, 36), 0)
})
