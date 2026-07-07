import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDssRosterEras,
  dssRosterEraObservationsForMatches,
  dssOrgCoachContinuity,
  dssPatchAdjustedRosterValidity,
  dssPatchSimilarity,
  dssRetainedPlayerContributionShare,
  dssRetainedSynergy,
  dssRoleCriticalContinuity,
  dssRosterCarryover,
  dssRosterEraModelParameters,
  dssSubstituteCreatesRosterEra,
  type RosterContributionShare,
} from '../src/lib/rosterEras.ts'
import type { MatchRecord, MatchRosterSnapshot, Role } from '../src/types.ts'

test('DSS retained player contribution uses prior result shares, not raw player count', () => {
  const priorShares: RosterContributionShare[] = [
    { playerId: 'old-top', role: 'Top', share: 0.18 },
    { playerId: 'old-jungle', role: 'Jungle', share: 0.22 },
    { playerId: 'old-mid', role: 'Mid', share: 0.23 },
    { playerId: 'old-bot', role: 'Bot', share: 0.21 },
    { playerId: 'old-support', role: 'Support', share: 0.16 },
  ]
  const current = rosterFixture('old', {
    Top: 'new-top',
    Jungle: 'old-jungle',
    Mid: 'old-mid',
    Bot: 'new-bot',
    Support: 'old-support',
  })

  assert.equal(dssRetainedPlayerContributionShare(priorShares, current), 0.61)
  assert.equal(dssRetainedPlayerContributionShare(priorShares, { ...current, completeness: 'partial' }), 0)
})

test('DSS retained synergy follows PDF pair weights when shotcaller is known', () => {
  const previous = rosterFixture('previous')
  const current = rosterFixture('current', {
    Top: 'previous-Top',
    Jungle: 'previous-Jungle',
    Mid: 'previous-Mid',
    Bot: 'new-Bot',
    Support: 'previous-Support',
  })

  near(dssRetainedSynergy({
    previousRoster: previous,
    currentRoster: current,
    previousCoachId: 'coach-a',
    currentCoachId: 'coach-a',
    shotcallerId: 'previous-Support',
  }), 0.7)
})

test('DSS retained synergy falls back to retained player count when shotcaller is unknown', () => {
  const previous = rosterFixture('previous')
  const current = rosterFixture('current', {
    Top: 'previous-Top',
    Jungle: 'previous-Jungle',
    Mid: 'new-Mid',
    Bot: 'new-Bot',
    Support: 'previous-Support',
  })

  assert.equal(dssRetainedSynergy({ previousRoster: previous, currentRoster: current }), 0.6)
})

test('DSS org coach continuity uses organization-only fallback when coach data is missing', () => {
  assert.equal(dssOrgCoachContinuity({ sameOrganizationSlot: true }), 1)
  assert.equal(dssOrgCoachContinuity({ sameOrganizationSlot: false }), 0)
  assert.equal(dssOrgCoachContinuity({
    sameOrganizationSlot: true,
    previousCoachId: 'coach-a',
    currentCoachId: 'coach-b',
  }), 0.6)
})

test('DSS role-critical continuity uses direct support and jungle proxies when shotcaller is unknown', () => {
  const previous = rosterFixture('previous')
  const current = rosterFixture('current', {
    Top: 'previous-Top',
    Jungle: 'previous-Jungle',
    Mid: 'previous-Mid',
    Bot: 'new-Bot',
    Support: 'previous-Support',
  })

  near(dssRoleCriticalContinuity({
    previousRoster: previous,
    currentRoster: current,
    shotcallerId: 'previous-Support',
  }), 0.7)
  near(dssRoleCriticalContinuity({ previousRoster: previous, currentRoster: current }), 0.7)
})

test('DSS roster carryover combines org, contribution, synergy, and role-critical continuity', () => {
  near(dssRosterCarryover({
    orgCoachContinuity: 1,
    retainedPlayerContributionShare: 0.61,
    retainedSynergy: 0.7,
    roleCriticalContinuity: 0.7,
  }), 0.715)
})

test('DSS substitute thresholds only create eras for meaningful or permanent substitutes', () => {
  assert.equal(dssSubstituteCreatesRosterEra({ seriesCount: 2, splitGameShare: 0.19 }), false)
  assert.equal(dssSubstituteCreatesRosterEra({ seriesCount: 3 }), true)
  assert.equal(dssSubstituteCreatesRosterEra({ splitGameShare: 0.2 }), true)
  assert.equal(dssSubstituteCreatesRosterEra({ permanent: true }), true)
})

test('DSS patch similarity is optional and multiplicative', () => {
  assert.equal(dssPatchSimilarity('none'), 1)
  assert.equal(dssPatchSimilarity('moderate'), 0.85)
  assert.equal(dssPatchSimilarity('major'), 0.7)
  assert.equal(dssPatchSimilarity('preseason'), 0.55)
  near(dssPatchAdjustedRosterValidity(0.8, 'major'), 0.56)
})

test('DSS roster era carryover constants mirror the PDF season and split policies', () => {
  assert.deepEqual(dssRosterEraModelParameters.seasonCarryover, {
    teamResume: 0.25,
    playerResume: 0.4,
    playerSkillPrior: 0.6,
    leagueTranslation: 0.8,
    regionResume: 0.35,
    regionTranslationPrior: 0.75,
  })
  assert.deepEqual(dssRosterEraModelParameters.splitCarryover, {
    teamResume: 0.55,
    playerResume: 0.65,
    playerSkillPrior: 0.75,
    leagueTranslation: 0.9,
    regionResume: 0.7,
  })
})

test('DSS roster era observations skip partial rosters unless explicitly included', () => {
  const partial = rosterFixture('partial', { Mid: 'partial-Mid' })
  const matches = [matchFixture({
    teamARoster: rosterFixture('t1'),
    teamBRoster: { ...partial, completeness: 'partial', players: partial.players.slice(0, 2) },
  })]

  assert.equal(dssRosterEraObservationsForMatches(matches).length, 1)
  assert.equal(dssRosterEraObservationsForMatches(matches, { includePartialRosters: true }).length, 2)
})

test('DSS roster era builder splits on roster and coach changes while carrying ledger ids', () => {
  const sameRoster = rosterFixture('t1')
  const changedRoster = rosterFixture('t1', { Mid: 'new-mid' })
  const eras = buildDssRosterEras([
    matchFixture({ id: 'match-1', date: '2026-01-01', teamARoster: sameRoster }),
    matchFixture({ id: 'match-2', date: '2026-01-02', teamARoster: sameRoster }),
    matchFixture({ id: 'match-3', date: '2026-01-03', teamARoster: changedRoster }),
    matchFixture({ id: 'match-4', date: '2026-01-04', teamARoster: changedRoster }),
  ], {
    coachIdFor: ({ match }) => match.id === 'match-4' ? 'coach-b' : 'coach-a',
    resumeLedgerIdsFor: (observation) => [`resume:${observation.matchId}`],
    playerContributionLedgerIdsFor: (observation) => [`players:${observation.matchId}`],
    synergyLedgerIdsFor: (observation) => [`synergy:${observation.matchId}`],
    uncertaintyFor: (era) => 100 - era.matches.length,
  }).filter((era) => era.team === 'T1')

  assert.equal(eras.length, 3)
  assert.deepEqual(eras[0].matches, ['match-1', 'match-2'])
  assert.equal(eras[0].startDate, '2026-01-01')
  assert.equal(eras[0].endDate, '2026-01-03')
  assert.deepEqual(eras[0].resumeLedger, ['resume:match-1', 'resume:match-2'])
  assert.deepEqual(eras[0].playerContributionLedger, ['players:match-1', 'players:match-2'])
  assert.deepEqual(eras[0].synergyLedger, ['synergy:match-1', 'synergy:match-2'])
  assert.equal(eras[0].uncertainty, 98)
  assert.deepEqual(eras[1].matches, ['match-3'])
  assert.equal(eras[1].endDate, '2026-01-04')
  assert.equal(eras[2].coachId, 'coach-b')
  assert.deepEqual(eras[2].matches, ['match-4'])
})

function rosterFixture(
  teamId: string,
  ids: Partial<Record<Role, string>> = {},
): MatchRosterSnapshot {
  const roles: Role[] = ['Top', 'Jungle', 'Mid', 'Bot', 'Support']
  return {
    sourceProvider: 'oracles-elixir',
    teamId,
    observedAt: '2026-01-01',
    completeness: 'complete-five-role',
    players: roles.map((role) => ({
      id: ids[role] ?? `${teamId}-${role}`,
      name: `${teamId} ${role}`,
      role,
    })),
  }
}

function matchFixture(overrides: Partial<MatchRecord> = {}): MatchRecord {
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
    teamA: 'T1',
    teamB: 'Gen.G',
    winner: 'T1',
    teamAKills: 20,
    teamBKills: 12,
    teamAGold: 65000,
    teamBGold: 59000,
    ...overrides,
  }
}

function near(actual: number, expected: number, epsilon = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} should be within ${epsilon} of ${expected}`)
}
