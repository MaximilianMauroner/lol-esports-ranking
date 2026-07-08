import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateTeamEligibility, matchLevelEligibilityHistory } from '../src/lib/eligibility.ts'
import { emptyRatingUpdateLedger } from '../src/lib/ratingCalculations.ts'
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
  assert.equal(eligibility.minTotalGames, 20)
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

test('current rated leagues with international signal can clear scoped total-volume noise', () => {
  const eligibility = evaluateTeamEligibility({
    history: Array.from({ length: 11 }, (_, index) => historyPoint(`2026-06-${String(index + 1).padStart(2, '0')}`)),
    lastDate: '2026-06-26',
    uncertainty: 80,
    league: 'LCP',
    leagueTier: 'tier-two',
    leagueInternationalMatches: 2,
  })

  assert.equal(eligibility.eligible, true)
  assert.deepEqual(eligibility.reasons, [])
  assert.equal(eligibility.totalGames, 11)
  assert.equal(eligibility.currentWindowGames, 11)
})

test('rated-league total-volume waiver still requires current local activity', () => {
  const eligibility = evaluateTeamEligibility({
    history: Array.from({ length: 5 }, (_, index) => historyPoint(`2026-06-${String(index + 1).padStart(2, '0')}`)),
    lastDate: '2026-06-26',
    uncertainty: 80,
    league: 'LCP',
    leagueTier: 'tier-two',
    leagueInternationalMatches: 2,
  })

  assert.equal(eligibility.eligible, false)
  assert.deepEqual(eligibility.reasons, ['low-total-volume', 'low-current-volume'])
})

test('rated-league total-volume waiver requires international connectivity', () => {
  const eligibility = evaluateTeamEligibility({
    history: Array.from({ length: 11 }, (_, index) => historyPoint(`2026-06-${String(index + 1).padStart(2, '0')}`)),
    lastDate: '2026-06-26',
    uncertainty: 80,
    league: 'LCP',
    leagueTier: 'tier-two',
    leagueInternationalMatches: 1,
  })

  assert.equal(eligibility.eligible, false)
  assert.deepEqual(eligibility.reasons, ['low-total-volume'])
})

test('match-level eligibility history groups game rows from resolved series', () => {
  const rawHistory = Array.from({ length: 16 }).flatMap((_, index) => {
    const date = `2026-06-${String(index + 1).padStart(2, '0')}`
    return [
      historyPoint(date, { opponent: `Opponent ${index}`, source: { provider: 'oracles-elixir', fileName: 'fixture.csv', bestOf: 3 } }),
      historyPoint(date, { opponent: `Opponent ${index}`, source: { provider: 'oracles-elixir', fileName: 'fixture.csv', bestOf: 3 } }),
    ]
  })
  const matchHistory = matchLevelEligibilityHistory(rawHistory)
  const eligibility = evaluateTeamEligibility({
    history: matchHistory,
    lastDate: '2026-06-26',
    uncertainty: 80,
    leagueTier: 'tier-one',
    leagueInternationalMatches: 0,
  })

  assert.equal(rawHistory.length, 32)
  assert.equal(matchHistory.length, 16)
  assert.equal(eligibility.eligible, false)
  assert.deepEqual(eligibility.reasons, ['low-total-volume'])
  assert.equal(eligibility.totalGames, 16)
  assert.equal(eligibility.currentWindowGames, 16)
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

function historyPoint(date: string, overrides: Partial<TeamHistoryPoint> = {}): TeamHistoryPoint {
  return {
    date,
    event: 'Fixture Event',
    opponent: 'Opponent',
    rating: 1500,
    baseRating: 1500,
    leagueAdjustment: 0,
    sideAdjustment: 0,
    ratingComponents: {
      leagueAnchor: 1500,
      teamStableOffset: 0,
      rosterPriorOffset: 0,
      momentum: 0,
      contextAdjustment: 0,
      uncertainty: 50,
    },
    ratingUpdate: emptyRatingUpdateLedger(),
    rank: 1,
    delta: 0,
    tier: 'regional-regular',
    result: 'W',
    source: {},
    ...overrides,
  }
}
