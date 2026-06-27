import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveRegionStrength } from '../src/lib/regionStrength.ts'
import type { LeagueStrength, Region } from '../src/types.ts'
import type { RankingSummaryStanding } from '../src/lib/snapshot.ts'

function league(overrides: Partial<LeagueStrength> & Pick<LeagueStrength, 'league' | 'region'>): LeagueStrength {
  return {
    tier: 'tier-one',
    priorScore: 1500,
    rawScore: 1500,
    connectivity: 0.8,
    score: 1500,
    adjustment: 0,
    delta: 0,
    wins: 0,
    losses: 0,
    internationalMatches: 0,
    form: [],
    ...overrides,
  }
}

function team(name: string, region: Region, rating: number, rank: number): RankingSummaryStanding {
  return { team: name, code: name.slice(0, 3).toUpperCase(), region, league: region, rating, rank } as RankingSummaryStanding
}

test('deriveRegionStrength ranks regions by weighted score and excludes International', () => {
  const leagues: LeagueStrength[] = [
    league({ league: 'LCK', region: 'LCK', score: 1520, wins: 18, losses: 6, internationalMatches: 24, connectivity: 0.8 }),
    league({ league: 'LEC', region: 'LEC', score: 1480, wins: 9, losses: 12, internationalMatches: 21, connectivity: 0.7 }),
    league({ league: 'Worlds', region: 'International', score: 1600, wins: 5, losses: 5, internationalMatches: 10 }),
  ]
  const standings: RankingSummaryStanding[] = [
    team('Gen.G', 'LCK', 1640, 1),
    team('T1', 'LCK', 1610, 2),
    team('G2', 'LEC', 1560, 3),
  ]

  const rows = deriveRegionStrength(leagues, standings)

  assert.equal(rows.length, 2)
  assert.equal(rows.some((row) => row.region === 'International'), false)
  assert.deepEqual(rows.map((row) => row.region), ['LCK', 'LEC'])
  assert.deepEqual(rows.map((row) => row.rank), [1, 2])

  const lck = rows[0]
  assert.equal(lck.topTeamRating, 1640)
  assert.equal(lck.internationalWins, 18)
  assert.equal(lck.internationalLosses, 6)
  assert.ok(lck.internationalWinRate && lck.internationalWinRate > 0.7)
  assert.equal(lck.flagshipLeague, 'LCK')
  assert.equal(lck.teamCount, 2)
  assert.equal(lck.ecosystemTeamCount, 2)
  assert.deepEqual(lck.topTeams.map((entry) => entry.team), ['Gen.G', 'T1'])
})

test('deriveRegionStrength uses flagship leagues instead of diluting majors with lower tiers', () => {
  const rows = deriveRegionStrength(
    [
      league({ league: 'LEC', region: 'LEC', tier: 'tier-two', score: 1460, wins: 6, losses: 4, internationalMatches: 10, connectivity: 0.7 }),
      league({ league: 'PRM', region: 'LEC', tier: 'tier-three', score: 1320, wins: 40, losses: 10, internationalMatches: 50, connectivity: 0.5 }),
      league({ league: 'LCK', region: 'LCK', tier: 'tier-one', score: 1500, wins: 5, losses: 5, internationalMatches: 10, connectivity: 0.8 }),
    ],
    [
      { ...team('G2 Esports', 'LEC', 1550, 1), league: 'LEC' },
      { ...team('ERL Stack', 'LEC', 1400, 2), league: 'PRM' },
      team('Gen.G', 'LCK', 1560, 3),
    ],
  )
  const lec = rows.find((row) => row.region === 'LEC')

  assert.ok(lec)
  assert.equal(lec.score, 1460)
  assert.equal(lec.flagshipLeague, 'LEC')
  assert.equal(lec.teamCount, 1)
  assert.equal(lec.ecosystemTeamCount, 2)
  assert.deepEqual(lec.topTeams.map((entry) => entry.team), ['G2 Esports'])
})

test('deriveRegionStrength folds APAC domestic feeders under LCP for current top-tier region power', () => {
  const rows = deriveRegionStrength(
    [
      league({ league: 'LCP', region: 'LCP', tier: 'tier-two', score: 1430, wins: 5, losses: 5, internationalMatches: 10, connectivity: 0.7 }),
      league({ league: 'PCS', region: 'PCS', tier: 'tier-three', score: 1370, wins: 12, losses: 8, internationalMatches: 20, connectivity: 0.5 }),
      league({ league: 'VCS', region: 'VCS', tier: 'tier-three', score: 1360, wins: 7, losses: 13, internationalMatches: 20, connectivity: 0.4 }),
      league({ league: 'LCK', region: 'LCK', tier: 'tier-one', score: 1500, wins: 5, losses: 5, internationalMatches: 10, connectivity: 0.8 }),
    ],
    [
      { ...team('CTBC Flying Oyster', 'LCP', 1500, 1), league: 'LCP' },
      { ...team('PSG Talon', 'PCS', 1420, 2), league: 'PCS' },
      { ...team('GAM Esports', 'VCS', 1410, 3), league: 'VCS' },
      team('Gen.G', 'LCK', 1560, 4),
    ],
  )

  assert.equal(rows.some((row) => row.region === 'PCS' || row.region === 'VCS'), false)

  const lcp = rows.find((row) => row.region === 'LCP')
  assert.ok(lcp)
  assert.equal(lcp.score, 1430)
  assert.equal(lcp.flagshipLeague, 'LCP')
  assert.equal(lcp.teamCount, 1)
  assert.equal(lcp.ecosystemTeamCount, 3)
  assert.equal(lcp.leagueCount, 1)
  assert.equal(lcp.ecosystemLeagueCount, 3)
  assert.deepEqual(lcp.topTeams.map((entry) => entry.team), ['CTBC Flying Oyster'])
})

test('deriveRegionStrength exposes opponent-adjusted international resume', () => {
  const rows = deriveRegionStrength(
    [
      league({
        league: 'LCK',
        region: 'LCK',
        score: 1500,
        wins: 5,
        losses: 5,
        internationalMatches: 10,
        expectedWins: 3,
        winsOverExpected: 2,
        opponentAdjustedWinRate: 0.7,
        averageOpponentRating: 1540,
      }),
      league({
        league: 'LCS',
        region: 'LCS',
        score: 1500,
        wins: 6,
        losses: 4,
        internationalMatches: 10,
        expectedWins: 7,
        winsOverExpected: -1,
        opponentAdjustedWinRate: 0.4,
        averageOpponentRating: 1440,
      }),
    ],
    [
      team('Gen.G', 'LCK', 1600, 1),
      team('FlyQuest', 'LCS', 1560, 2),
    ],
  )

  const lck = rows.find((row) => row.region === 'LCK')
  const lcs = rows.find((row) => row.region === 'LCS')

  assert.ok(lck)
  assert.ok(lcs)
  assert.equal(lck.expectedWins, 3)
  assert.equal(lck.winsOverExpected, 2)
  assert.equal(lck.opponentAdjustedWinRate, 0.7)
  assert.equal(lck.averageOpponentRating, 1540)
  assert.ok((lck.winsOverExpected ?? 0) > (lcs.winsOverExpected ?? 0))
})

test('deriveRegionStrength can include International when requested', () => {
  const rows = deriveRegionStrength(
    [league({ league: 'Worlds', region: 'International', score: 1600, wins: 5, losses: 5 })],
    [team('Mixed', 'International', 1600, 1)],
    { includeInternational: true },
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].region, 'International')
})
