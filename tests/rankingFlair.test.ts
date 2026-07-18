import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveRankingFlair,
  deriveMovementPicks,
  deriveSpicyTakeConfidence,
  deriveTierLabels,
  deriveTopThreePodium,
  deriveUpsetHeadline,
  firstPageForTier,
} from '../src/lib/rankingFlair.ts'
import type { PublicRecentMatch, PublicTeamStanding } from '../src/lib/publicArtifacts/schema.ts'

test('derives deterministic S/A/B/C tiers from power-score bands', () => {
  const tiers = deriveTierLabels([
    standing({ team: 'Alpha', code: 'ALP', rank: 1, rating: 1800 }),
    standing({ team: 'Bravo', code: 'BRV', rank: 2, rating: 1745 }),
    standing({ team: 'Charlie', code: 'CHR', rank: 3, rating: 1500 }),
    standing({ team: 'Delta', code: 'DLT', rank: 4, rating: 1350 }),
  ])

  assert.deepEqual(
    tiers.map((tier) => [tier.team, tier.powerScore, tier.tier]),
    [
      ['Alpha', 1800, 'S'],
      ['Bravo', 1745, 'A'],
      ['Charlie', 1500, 'B'],
      ['Delta', 1350, 'C'],
    ],
  )
})

test('keeps close contenders in A tier after a tight S-tier leader pack', () => {
  const tiers = deriveTierLabels([
    standing({ team: 'Bilibili Gaming', code: 'BLG', rank: 1, rating: 2294 }),
    standing({ team: 'Gen.G', code: 'GEN', rank: 2, rating: 2255 }),
    standing({ team: 'T1', code: 'T1', rank: 3, rating: 2141 }),
    standing({ team: 'G2 Esports', code: 'G2', rank: 4, rating: 2102 }),
    standing({ team: "Anyone's Legend", code: 'AL', rank: 5, rating: 2080 }),
    standing({ team: 'Dplus KIA', code: 'DK', rank: 6, rating: 2076 }),
    standing({ team: 'JD Gaming', code: 'JDG', rank: 7, rating: 2041 }),
  ])

  assert.deepEqual(
    tiers.map((tier) => [tier.code, tier.tier]),
    [
      ['BLG', 'S'],
      ['GEN', 'S'],
      ['T1', 'A'],
      ['G2', 'A'],
      ['AL', 'A'],
      ['DK', 'A'],
      ['JDG', 'B'],
    ],
  )
})

test('does not split tier badges across small adjacent rating gaps', () => {
  const tiers = deriveTierLabels([
    standing({ team: 'Bilibili Gaming', code: 'BLG', rank: 1, rating: 2301 }),
    standing({ team: 'Gen.G', code: 'GEN', rank: 2, rating: 2271 }),
    standing({ team: 'Hanwha Life Esports', code: 'HLE', rank: 3, rating: 2255 }),
    standing({ team: 'T1', code: 'T1', rank: 4, rating: 2245 }),
    standing({ team: 'G2 Esports', code: 'G2', rank: 5, rating: 2148 }),
    standing({ team: 'Dplus KIA', code: 'DK', rank: 6, rating: 2083 }),
    standing({ team: 'KT Rolster', code: 'KT', rank: 7, rating: 2070 }),
    standing({ team: 'Top Esports', code: 'TES', rank: 8, rating: 2067 }),
    standing({ team: "Anyone's Legend", code: 'AL', rank: 9, rating: 2047 }),
    standing({ team: 'Karmine Corp', code: 'KC', rank: 10, rating: 1998 }),
  ])

  assert.deepEqual(
    tiers.map((tier) => [tier.code, tier.tier]),
    [
      ['BLG', 'S'],
      ['GEN', 'S'],
      ['HLE', 'S'],
      ['T1', 'S'],
      ['G2', 'A'],
      ['DK', 'A'],
      ['KT', 'A'],
      ['TES', 'A'],
      ['AL', 'A'],
      ['KC', 'B'],
    ],
  )
})

test('filtered ranking flair preserves tiers from the full ranked universe', () => {
  const universe = [
    standing({ team: 'Leader', code: 'LEAD', rank: 1, rating: 2300 }),
    standing({ team: 'Middle', code: 'MID', rank: 20, rating: 1900 }),
    standing({ team: 'Last', code: 'LAST', rank: 56, rating: 1500 }),
  ]

  const flair = deriveRankingFlair([universe[2]], { tierUniverse: universe })

  assert.equal(flair.tiers[0]?.tier, 'C')
  assert.equal(flair.podium[0]?.tier, 'C')
})

test('tier navigation resolves the first page containing that canonical tier', () => {
  const standings = Array.from({ length: 30 }, (_, index) => standing({
    team: `Team ${index + 1}`,
    code: `T${index + 1}`,
    rank: index + 1,
    rating: index < 25 ? 2100 - index : 1500 - index,
  }))
  const tiers = deriveTierLabels(standings)

  assert.equal(firstPageForTier(standings, tiers, 'C', 25), 2)
})

test('keeps championship-score clusters together when no visible boundary gap exists', () => {
  const tiers = deriveTierLabels([
    standing({ team: 'Bilibili Gaming', code: 'BLG', rank: 1, rating: 2385 }),
    standing({ team: 'Hanwha Life Esports', code: 'HLE', rank: 2, rating: 2268 }),
    standing({ team: 'Gen.G', code: 'GEN', rank: 3, rating: 2239 }),
    standing({ team: 'G2 Esports', code: 'G2', rank: 4, rating: 2216 }),
  ])

  assert.deepEqual(
    tiers.map((tier) => [tier.code, tier.tier]),
    [
      ['BLG', 'S'],
      ['HLE', 'S'],
      ['GEN', 'S'],
      ['G2', 'S'],
    ],
  )
})

test('derives podium and 30-day Power movement picks with deterministic tie-breakers', () => {
  const standings = [
    standing({ team: 'First', code: 'FST', rank: 1, rating: 1800, rollingMovement: rolling(1800, 1, 0, 2) }),
    standing({ team: 'Second', code: 'SND', rank: 2, rating: 1760, rollingMovement: rolling(1760, 2, 20, 4) }),
    standing({ team: 'Third', code: 'TRD', rank: 3, rating: 1720, rollingMovement: rolling(1720, 3, 12, 4) }),
    standing({ team: 'Drop', code: 'DRP', rank: 8, rating: 1580, rollingMovement: rolling(1580, 8, -28, -5) }),
    standing({ team: 'Slide', code: 'SLD', rank: 9, rating: 1570, rollingMovement: rolling(1570, 9, -12, -5) }),
  ]

  assert.deepEqual(
    deriveTopThreePodium(standings).map((entry) => [entry.place, entry.team]),
    [
      [1, 'First'],
      [2, 'Second'],
      [3, 'Third'],
    ],
  )

  const movement = deriveMovementPicks(standings)
  assert.equal(movement.biggestRiser?.team, 'Second')
  assert.equal(movement.biggestFaller?.team, 'Drop')
})

test('movement picks use Power delta first and exclude inactive teams', () => {
  const movement = deriveMovementPicks([
    standing({ team: 'Rank Only', code: 'RNO', rank: 2, rollingMovement: rolling(1500, 2, -5, 18) }),
    standing({ team: 'True Riser', code: 'TRU', rank: 3, rollingMovement: rolling(1500, 3, 18, 5) }),
    standing({ team: 'Drop Only', code: 'DRO', rank: 20, rollingMovement: rolling(1500, 20, 5, -18) }),
    standing({ team: 'True Faller', code: 'TRF', rank: 19, rollingMovement: rolling(1500, 19, -18, -9) }),
    standing({ team: 'Inactive spike', code: 'INA', rank: 21, rollingMovement: { ...rolling(1500, 21, 100, 20), status: 'inactive', scoredSeries: 0 } }),
  ])

  assert.equal(movement.biggestRiser?.team, 'True Riser')
  assert.equal(movement.biggestFaller?.team, 'True Faller')
})

test('derives upset headline from lowest pre-series expectation in the rolling window', () => {
  const headline = deriveUpsetHeadline([
    standing({
      team: 'Favorite',
      code: 'FAV',
      rank: 1,
      rating: 1800,
      rollingMovement: { ...rolling(1800, 1, 12, 0), biggestUpsetWin: { date: '2026-05-01', event: 'LCK', opponent: 'Mid', expectedWinProbability: 0.4, ratingDelta: 12 } },
    }),
    standing({
      team: 'Underdog',
      code: 'DOG',
      rank: 9,
      rating: 1580,
      rollingMovement: { ...rolling(1580, 9, 24, 0), biggestUpsetWin: { date: '2026-05-01', event: 'MSI 2026', opponent: 'Favorite', expectedWinProbability: 0.22, ratingDelta: 24 } },
    }),
    standing({ team: 'Mid', code: 'MID', rank: 5, rating: 1680 }),
  ], { kind: 'rolling-power-movement', days: 30, startDate: '2026-04-01', endDate: '2026-05-01', modelVersion: 'test', modelConfigHash: 'test' })

  assert.equal(headline?.winner, 'Underdog')
  assert.equal(headline?.opponentCode, 'FAV')
  assert.equal(headline?.expectedWinProbability, 0.22)
  assert.match(headline?.headline ?? '', /DOG beat FAV.*22%/)
})

test('derives spicy-take confidence bands from confidence, uncertainty, and recent evidence', () => {
  assert.equal(
    deriveSpicyTakeConfidence(
      standing({
        team: 'Stable',
        confidence: 88,
        uncertainty: 45,
        recentMatches: [
          recentMatch({ opponent: 'A' }),
          recentMatch({ opponent: 'B' }),
          recentMatch({ opponent: 'C' }),
        ],
      }),
    ).band,
    'high',
  )

  assert.equal(
    deriveSpicyTakeConfidence(
      standing({
        team: 'Volatile',
        confidence: 42,
        uncertainty: 130,
        recentMatches: [recentMatch({ opponent: 'A' })],
      }),
    ).band,
    'low',
  )
})

function recentMatch(overrides: Partial<PublicRecentMatch> = {}): PublicRecentMatch {
  return {
    date: '2026-05-01',
    event: 'LCK 2026 Spring',
    opponent: 'Opponent',
    result: 'W',
    rating: 1500,
    delta: 10,
    ...overrides,
  }
}

function rolling(currentRating: number, currentRank: number, ratingDelta: number, rankMovement: number): NonNullable<PublicTeamStanding['rollingMovement']> {
  return {
    status: 'active',
    baselineRating: currentRating - ratingDelta,
    currentRating,
    ratingDelta,
    baselineRank: currentRank + rankMovement,
    currentRank,
    rankMovement,
    scoredSeries: 1,
    rankPoints: [['2026-04-01', currentRank + rankMovement], ['2026-05-01', currentRank]],
  }
}

function standing(overrides: Partial<PublicTeamStanding> = {}): PublicTeamStanding {
  return {
    teamId: 'Example__LCK__EX',
    leagueId: 'LCK',
    team: 'Example',
    code: 'EX',
    region: 'LCK',
    league: 'LCK',
    rosterBasis: 'sourced',
    rosterContinuity: 1,
    baseRating: 1500,
    leagueScore: 1500,
    leagueAdjustment: 0,
    leagueDelta: 0,
    ratingComponents: {
      leagueAnchor: 1500,
      teamStableOffset: 0,
      rosterPriorOffset: 0,
      momentum: 0,
      contextAdjustment: 0,
      uncertainty: 60,
    },
    ratingUpdate: {
      teamStableDelta: 0,
      leagueGameDelta: 0,
      leaguePlacementDelta: 0,
      momentumDelta: 0,
      rosterPriorDelta: 0,
      uncertaintyDelta: 0,
      sideAdjustment: 0,
      patchAdjustment: 0,
    },
    rating: 1500,
    previousRating: 1490,
    delta: 10,
    rank: 1,
    previousRank: 1,
    movement: 0,
    wins: 10,
    losses: 5,
    confidence: 75,
    uncertainty: 70,
    form: ['W', 'L', 'W'],
    strongestFactor: 'league',
    eligibility: {
      eligible: true,
      reasons: [],
      totalGames: 15,
      minTotalGames: 5,
      currentWindowGames: 5,
      minCurrentWindowGames: 3,
      windowDays: 180,
    },
    factors: {
      context: 0,
      recency: 0,
      execution: 0,
      opponent: 0,
      league: 1,
    },
    recentEvents: ['LCK 2026 Spring'],
    recentMatches: [],
    ...overrides,
    recordBasis: overrides.recordBasis ?? 'grouped-match-record-from-scope-history',
    scoreFamily: overrides.scoreFamily ?? 'power-index',
  }
}
