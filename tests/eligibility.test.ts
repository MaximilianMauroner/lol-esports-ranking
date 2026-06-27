import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateTeamEligibility } from '../src/lib/eligibility.ts'
import type { TeamHistoryPoint } from '../src/types.ts'

test('eligibility reports explicit current-window and staleness reasons', () => {
  const eligibility = evaluateTeamEligibility({
    history: [historyPoint('2026-01-01')],
    lastDate: '2026-06-26',
    uncertainty: 120,
    leagueTier: 'unknown',
    leagueInternationalMatches: 0,
  })

  assert.equal(eligibility.eligible, false)
  assert.deepEqual(eligibility.reasons, ['low-total-volume', 'low-current-volume', 'stale', 'high-uncertainty', 'unanchored-league'])
  assert.equal(eligibility.totalGames, 1)
  assert.equal(eligibility.minTotalGames, 30)
  assert.equal(eligibility.currentWindowGames, 0)
  assert.equal(eligibility.daysSinceLastMatch, 176)
})

test('anchored major teams with enough current matches become eligible', () => {
  const eligibility = evaluateTeamEligibility({
    history: Array.from({ length: 30 }, (_, index) => historyPoint(`2026-06-${String((index % 26) + 1).padStart(2, '0')}`)),
    lastDate: '2026-06-26',
    uncertainty: 80,
    leagueTier: 'tier-one',
    leagueInternationalMatches: 0,
  })

  assert.equal(eligibility.eligible, true)
  assert.deepEqual(eligibility.reasons, [])
})

test('anchored major teams with only a short qualifier run stay in audit rows', () => {
  const eligibility = evaluateTeamEligibility({
    history: Array.from({ length: 11 }, (_, index) => historyPoint(`2026-06-${String(index + 1).padStart(2, '0')}`)),
    lastDate: '2026-06-26',
    uncertainty: 80,
    leagueTier: 'tier-two',
    leagueInternationalMatches: 0,
  })

  assert.equal(eligibility.eligible, false)
  assert.deepEqual(eligibility.reasons, ['low-total-volume'])
  assert.equal(eligibility.totalGames, 11)
})

test('tier-three regional teams can become eligible with international signal', () => {
  const eligibility = evaluateTeamEligibility({
    history: Array.from({ length: 30 }, (_, index) => historyPoint(`2026-06-${String((index % 26) + 1).padStart(2, '0')}`)),
    lastDate: '2026-06-26',
    uncertainty: 80,
    leagueTier: 'tier-three',
    leagueInternationalMatches: 6,
  })

  assert.equal(eligibility.eligible, true)
  assert.deepEqual(eligibility.reasons, [])
})

test('developmental teams remain unanchored even when their parent league is certified', () => {
  const eligibility = evaluateTeamEligibility({
    history: Array.from({ length: 30 }, (_, index) => historyPoint(`2026-06-${String((index % 26) + 1).padStart(2, '0')}`)),
    lastDate: '2026-06-26',
    uncertainty: 80,
    leagueTier: 'tier-three',
    leagueInternationalMatches: 6,
    isDevelopmentalTeam: true,
  })

  assert.equal(eligibility.eligible, false)
  assert.deepEqual(eligibility.reasons, ['unanchored-league'])
})

test('emerging leagues remain unanchored even with cross-ecosystem matches', () => {
  const eligibility = evaluateTeamEligibility({
    history: Array.from({ length: 30 }, (_, index) => historyPoint(`2026-06-${String((index % 26) + 1).padStart(2, '0')}`)),
    lastDate: '2026-06-26',
    uncertainty: 80,
    leagueTier: 'emerging',
    leagueInternationalMatches: 200,
  })

  assert.equal(eligibility.eligible, false)
  assert.deepEqual(eligibility.reasons, ['unanchored-league'])
})

function historyPoint(date: string): TeamHistoryPoint {
  return {
    date,
    event: 'Fixture Event',
    opponent: 'Opponent',
    rating: 1500,
    baseRating: 1500,
    leagueAdjustment: 0,
    sideAdjustment: 0,
    rank: 1,
    delta: 0,
    tier: 'regional-regular',
    result: 'W',
    source: {},
  }
}
