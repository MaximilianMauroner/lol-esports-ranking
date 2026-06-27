import assert from 'node:assert/strict'
import test from 'node:test'
import { executionIndexFromStats, executionSoftOutcome, teamExecutionIndex } from '../src/lib/executionResidual.ts'
import type { MatchRecord } from '../src/types.ts'

test('execution index is bounded and rewards stronger stat lines', () => {
  const dominant = executionIndexFromStats(30, 5, 76000, 42000, 12, 2)
  const narrow = executionIndexFromStats(14, 13, 60100, 59900, 5, 4)
  const reverse = executionIndexFromStats(5, 30, 42000, 76000, 2, 12)

  assert.ok(dominant > narrow)
  assert.ok(narrow > reverse)
  assert.ok(dominant <= 0.25)
  assert.ok(reverse >= -0.25)
})

test('execution soft outcome dampens binary results without flipping them by itself', () => {
  assert.ok(executionSoftOutcome(1, 0.25) < 1)
  assert.ok(executionSoftOutcome(1, 0.25) > executionSoftOutcome(1, -0.25))
  assert.ok(executionSoftOutcome(0, 0.25) > executionSoftOutcome(0, -0.25))
  assert.ok(executionSoftOutcome(0, 0.25) < 0.5)
})

test('team execution index is symmetric by match side', () => {
  const match = matchFixture({
    teamAKills: 30,
    teamBKills: 5,
    teamAGold: 76000,
    teamBGold: 42000,
    teamATowers: 10,
    teamBTowers: 2,
    teamADragons: 4,
    teamBDragons: 1,
    teamABarons: 1,
    teamBBarons: 0,
  })

  assert.equal(teamExecutionIndex(match, 'A'), -teamExecutionIndex(match, 'B'))
})

function matchFixture(overrides: Partial<MatchRecord>): MatchRecord {
  return {
    id: 'fixture',
    sourceProvider: 'oracles-elixir',
    sourceGameId: 'fixture',
    dataCompleteness: 'scoreboard-game-stats',
    date: '2026-01-01',
    season: 2026,
    event: 'LCK 2026 Spring',
    phase: 'Regular season',
    region: 'LCK',
    league: 'LCK',
    teamAHomeLeague: 'LCK',
    teamBHomeLeague: 'LCK',
    teamARegion: 'LCK',
    teamBRegion: 'LCK',
    patch: '26.1',
    bestOf: 1,
    tier: 'regional-regular',
    teamA: 'Alpha',
    teamB: 'Beta',
    winner: 'Alpha',
    teamAKills: 20,
    teamBKills: 12,
    teamAGold: 65000,
    teamBGold: 59000,
    ...overrides,
  }
}
