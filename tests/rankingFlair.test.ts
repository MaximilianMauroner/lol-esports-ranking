import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveMovementPicks,
  deriveSpicyTakeConfidence,
  deriveTierLabels,
  deriveTopThreePodium,
  deriveUpsetHeadline,
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

test('keeps championship-score teams in S tier even when the leader has separation', () => {
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
      ['GEN', 'A'],
      ['G2', 'A'],
    ],
  )
})

test('derives podium and movement picks with deterministic tie-breakers', () => {
  const standings = [
    standing({ team: 'First', code: 'FST', rank: 1, rating: 1800, movement: 1, previousRank: 2 }),
    standing({ team: 'Second', code: 'SND', rank: 2, rating: 1760, movement: 4, previousRank: 6, delta: 20 }),
    standing({ team: 'Third', code: 'TRD', rank: 3, rating: 1720, movement: 4, previousRank: 7, delta: 12 }),
    standing({ team: 'Drop', code: 'DRP', rank: 8, rating: 1580, movement: -5, previousRank: 3, delta: -28 }),
    standing({ team: 'Slide', code: 'SLD', rank: 9, rating: 1570, movement: -5, previousRank: 4, delta: -12 }),
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

test('movement picks require rank and rating to move in the same direction', () => {
  const movement = deriveMovementPicks([
    standing({ team: 'Rank Only', code: 'RNO', rank: 2, previousRank: 20, movement: 18, delta: -5 }),
    standing({ team: 'True Riser', code: 'TRU', rank: 3, previousRank: 8, movement: 5, delta: 18 }),
    standing({ team: 'Drop Only', code: 'DRO', rank: 20, previousRank: 2, movement: -18, delta: 5 }),
    standing({ team: 'True Faller', code: 'TRF', rank: 19, previousRank: 10, movement: -9, delta: -18 }),
  ])

  assert.equal(movement.biggestRiser?.team, 'True Riser')
  assert.equal(movement.biggestFaller?.team, 'True Faller')
})

test('derives upset headline from recent winning matches and opponent standing gaps', () => {
  const headline = deriveUpsetHeadline([
    standing({
      team: 'Favorite',
      code: 'FAV',
      rank: 1,
      rating: 1800,
      recentMatches: [recentMatch({ opponent: 'Mid', delta: 12, result: 'W' })],
    }),
    standing({
      team: 'Underdog',
      code: 'DOG',
      rank: 9,
      rating: 1580,
      recentMatches: [recentMatch({ opponent: 'Favorite', delta: 24, result: 'W', event: 'MSI 2026' })],
    }),
    standing({ team: 'Mid', code: 'MID', rank: 5, rating: 1680 }),
  ])

  assert.equal(headline?.winner, 'Underdog')
  assert.equal(headline?.opponentCode, 'FAV')
  assert.equal(headline?.ratingGap, 220)
  assert.match(headline?.headline ?? '', /DOG upset FAV/)
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
  }
}
