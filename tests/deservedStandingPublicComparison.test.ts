import assert from 'node:assert/strict'
import test from 'node:test'
import { createStaticRankingData, createStaticRankingSummaryData, snapshotKey } from '../src/lib/snapshot.ts'
import type { PublicDeservedStandingComparison } from '../src/lib/publicArtifacts/schema.ts'
import type { MatchRecord, Role, Side, TeamProfile } from '../src/types.ts'
import { teams } from './fixtures/rankingFixtures.ts'

function assertDeservedStandingScoreBase(comparison: PublicDeservedStandingComparison, expectedBaseScore: number) {
  const instabilityPenalty = Math.max(0, 0.65 - comparison.rosterValidity) * 20
  const expectedScore = Math.round(
    expectedBaseScore
      + comparison.resumePoints
      + comparison.scheduleStrengthPoints
      + comparison.stagePoints
      + comparison.incomingPlayerBridgeCredit
      - instabilityPenalty,
  )
  assert.ok(
    Math.abs(comparison.score - expectedScore) <= 1,
    `expected DSS score ${comparison.score} to use base ${expectedBaseScore}; rounded expectation was ${expectedScore}`,
  )
}

test('public compact standings expose DSS comparison and mark missing roster evidence provisional', () => {
  const comparisonTeams: Record<string, TeamProfile> = {
    Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
    Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
  }
  const data = createStaticRankingData({
    matches: [{
      id: 'dss-compare',
      sourceProvider: 'oracles-elixir',
      sourceGameId: 'dss-compare',
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
      teamARoster: sourcedRosterFixture('alpha', 'blue', true),
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
    }],
    teams: comparisonTeams,
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
  const { snapshots } = createStaticRankingSummaryData(data)
  const shard = snapshots[data.defaultSnapshotKey]
  const alpha = shard?.standings.find((standing) => standing.team === 'Alpha')
  const beta = shard?.standings.find((standing) => standing.team === 'Beta')

  assert.ok(alpha?.deservedStanding)
  assert.equal(alpha.deservedStanding.leaderboard, 'main-deserved-standings')
  assert.equal(typeof alpha.deservedStanding.rankDeltaFromPower, 'number')
  assert.equal(typeof alpha.deservedStanding.scoreDeltaFromPower, 'number')
  assert.equal(alpha.deservedStanding.eligibility, 'Insufficient current-roster sample')
  assert.ok(beta?.deservedStanding)
  assert.equal(beta.rosterBasis, 'unknown')
  assert.equal(beta.deservedStanding.eligibility, 'Provisional')
})

test('public DSS comparison discounts prior results after sourced roster changes', () => {
  const comparisonTeams: Record<string, TeamProfile> = {
    Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
    Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
    Gamma: { name: 'Gamma', code: 'GAM', region: 'LCK', league: 'LCK' },
  }
  const data = createStaticRankingData({
    matches: [
      {
        id: 'alpha-old-roster',
        sourceProvider: 'oracles-elixir',
        sourceGameId: 'alpha-old-roster',
        dataCompleteness: 'scoreboard-game-stats',
        date: '2025-03-01',
        season: 2025,
        event: 'LCK 2025 Spring',
        phase: 'Regular season',
        region: 'LCK',
        league: 'LCK',
        teamAHomeLeague: 'LCK',
        teamBHomeLeague: 'LCK',
        teamARegion: 'LCK',
        teamBRegion: 'LCK',
        teamARoster: sourcedRosterFixture('alpha-old', 'blue', true),
        patch: '25.5',
        bestOf: 1,
        tier: 'regional-regular',
        teamA: 'Alpha',
        teamB: 'Gamma',
        winner: 'Alpha',
        teamAKills: 20,
        teamBKills: 12,
        teamAGold: 65000,
        teamBGold: 59000,
      },
      {
        id: 'alpha-current-roster',
        sourceProvider: 'oracles-elixir',
        sourceGameId: 'alpha-current-roster',
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
        teamARoster: sourcedRosterFixture('alpha-current', 'blue', false),
        teamBRoster: sourcedRosterFixture('beta', 'red', true),
        patch: '26.1',
        bestOf: 1,
        tier: 'regional-regular',
        teamA: 'Alpha',
        teamB: 'Beta',
        winner: 'Beta',
        teamAKills: 12,
        teamBKills: 20,
        teamAGold: 59000,
        teamBGold: 65000,
      },
    ],
    teams: comparisonTeams,
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
  const { snapshots } = createStaticRankingSummaryData(data)
  const shard = snapshots[data.defaultSnapshotKey]
  const alpha = shard?.standings.find((standing) => standing.team === 'Alpha')

  assert.ok(alpha?.deservedStanding)
  assert.equal(alpha.rosterBasis, 'sourced')
  assert.ok(alpha.deservedStanding.rosterValidity < 0.8)
})

test('checkpoint DSS comparison uses previous rating as its base score', () => {
  const data = createStaticRankingData({
    matches: [
      checkpointMatch('lck-opener', '2026-01-17', 'LCK 2026 Spring', 'LCK', 'Gen.G', 'T1', 'Gen.G'),
      checkpointMatch('fst-final', '2026-03-22', 'FST 2026', 'FST', 'Gen.G', 'G2 Esports', 'Gen.G'),
      checkpointMatch('ewc-match', '2026-05-14', 'EWC 2026', 'EWC', 'G2 Esports', 'T1', 'T1'),
      checkpointMatch('msi-final', '2026-06-28', 'MSI 2026', 'MSI', 'T1', 'Gen.G', 'T1'),
      checkpointMatch('worlds-final', '2026-11-08', 'WLDs 2026', 'WLDs', 'T1', 'Bilibili Gaming', 'T1'),
    ],
    teams,
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
  const split2 = data.filterOptions.checkpoints?.['2026']?.[1]
  assert.ok(split2)
  const checkpointSnapshot = data.snapshots[snapshotKey({
    season: '2026',
    event: 'All',
    region: 'All',
    checkpoint: split2.id,
  })]
  const checkpointT1 = checkpointSnapshot.standings.find((standing) => standing.team === 'T1')

  assert.ok(checkpointT1?.deservedStanding)
  assertDeservedStandingScoreBase(checkpointT1.deservedStanding, checkpointT1.previousRating)
})

test('region-scoped DSS prices cross-region opponents from the full scope context', () => {
  const dssTeams: Record<string, TeamProfile> = {
    Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
    Beta: { name: 'Beta', code: 'BET', region: 'LPL', league: 'LPL' },
    Delta: { name: 'Delta', code: 'DEL', region: 'LPL', league: 'LPL' },
  }
  const data = createStaticRankingData({
    matches: [
      regionalMatch('beta-delta-1', '2026-04-01', 'Beta', 'Delta', 'Beta', dssTeams),
      regionalMatch('beta-delta-2', '2026-04-08', 'Beta', 'Delta', 'Beta', dssTeams),
      internationalMatch('alpha-beta-msi', '2026-05-01', 'Alpha', 'Beta', 'Beta', dssTeams),
    ],
    teams: dssTeams,
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
  const eventSnapshot = data.snapshots[snapshotKey({ season: 'All', event: 'MSI 2026', region: 'All' })]
  const lckSnapshot = data.snapshots[snapshotKey({ season: 'All', event: 'All', region: 'LCK' })]
  const eventAlpha = eventSnapshot.standings.find((standing) => standing.team === 'Alpha')
  const lckAlpha = lckSnapshot.standings.find((standing) => standing.team === 'Alpha')

  assert.ok(eventAlpha?.deservedStanding)
  assert.ok(lckAlpha?.deservedStanding)
  assert.equal(lckAlpha.deservedStanding.winsAboveExpectation, eventAlpha.deservedStanding.winsAboveExpectation)
  assert.equal(lckAlpha.deservedStanding.scheduleStrengthPoints, eventAlpha.deservedStanding.scheduleStrengthPoints)
})

function regionalMatch(
  id: string,
  date: string,
  teamA: string,
  teamB: string,
  winner: string,
  teamsByName: Record<string, TeamProfile>,
): MatchRecord {
  return {
    id,
    sourceProvider: 'seed',
    dataCompleteness: 'complete',
    date,
    season: 2026,
    event: 'LPL 2026 Split 2',
    phase: 'Regular season',
    region: 'LPL',
    league: 'LPL',
    teamAHomeLeague: teamsByName[teamA]?.league,
    teamBHomeLeague: teamsByName[teamB]?.league,
    teamARegion: teamsByName[teamA]?.region,
    teamBRegion: teamsByName[teamB]?.region,
    patch: '26.1',
    bestOf: 1,
    tier: 'regional-regular',
    teamA,
    teamB,
    winner,
    teamAKills: winner === teamA ? 20 : 12,
    teamBKills: winner === teamB ? 20 : 12,
    teamAGold: winner === teamA ? 70000 : 58000,
    teamBGold: winner === teamB ? 70000 : 58000,
  }
}

function internationalMatch(
  id: string,
  date: string,
  teamA: string,
  teamB: string,
  winner: string,
  teamsByName: Record<string, TeamProfile>,
): MatchRecord {
  return {
    id,
    sourceProvider: 'seed',
    dataCompleteness: 'complete',
    date,
    season: 2026,
    event: 'MSI 2026',
    phase: 'Bracket',
    region: 'International',
    league: 'MSI',
    teamAHomeLeague: teamsByName[teamA]?.league,
    teamBHomeLeague: teamsByName[teamB]?.league,
    teamARegion: teamsByName[teamA]?.region,
    teamBRegion: teamsByName[teamB]?.region,
    patch: '26.1',
    bestOf: 1,
    tier: 'msi-bracket',
    teamA,
    teamB,
    winner,
    teamAKills: winner === teamA ? 20 : 12,
    teamBKills: winner === teamB ? 20 : 12,
    teamAGold: winner === teamA ? 70000 : 58000,
    teamBGold: winner === teamB ? 70000 : 58000,
  }
}

function checkpointMatch(
  id: string,
  date: string,
  event: string,
  league: string,
  teamA: string,
  teamB: string,
  winner: string,
): MatchRecord {
  return {
    id,
    sourceProvider: 'seed',
    dataCompleteness: 'complete',
    season: Number(date.slice(0, 4)),
    date,
    event,
    phase: 'Bracket',
    region: league === 'LCK' ? 'LCK' : 'International',
    league,
    patch: '26.1',
    bestOf: league === 'LCK' ? 1 : 5,
    tier: checkpointTier(league),
    teamA,
    teamB,
    winner,
    teamAKills: winner === teamA ? 20 : 12,
    teamBKills: winner === teamB ? 20 : 12,
    teamAGold: winner === teamA ? 70000 : 58000,
    teamBGold: winner === teamB ? 70000 : 58000,
  }
}

function checkpointTier(league: string): MatchRecord['tier'] {
  if (league === 'LCK') return 'regional-regular'
  if (league === 'EWC') return 'minor-international'
  if (league === 'WLDs') return 'worlds-main'
  return 'msi-bracket'
}

function sourcedRosterFixture(
  prefix: string,
  side: Side,
  won: boolean,
): NonNullable<MatchRecord['teamARoster']> {
  const roles = ['Top', 'Jungle', 'Mid', 'Bot', 'Support'] as const satisfies readonly Role[]
  return {
    sourceProvider: 'oracles-elixir',
    teamId: prefix,
    observedAt: '2026-01-01',
    completeness: 'complete-five-role',
    players: roles.map((role) => ({
      id: `${prefix}-${role}`,
      name: `${prefix} ${role}`,
      role,
      stats: {
        side,
        won,
        kills: won ? 4 : 2,
        deaths: won ? 2 : 4,
        assists: won ? 9 : 5,
        damageShare: 0.2,
        earnedGoldShare: 0.2,
        vspm: role === 'Support' ? 2.2 : 1,
      },
    })),
  }
}
