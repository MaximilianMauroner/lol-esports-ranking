import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareRiotGprBenchmark,
  extractRiotGprEntries,
  type RiotGprComparisonThresholds,
} from '../scripts/compare-riot-gpr.ts'
import type { PublicRankingShard, PublicTeamStanding } from '../src/lib/publicArtifacts/schema.ts'

const thresholds: RiotGprComparisonThresholds = {
  maxRankDelta: 3,
  maxLargeDeltas: 0,
  top: 10,
  eliteTop: 2,
  maxEliteRankDelta: 4,
  minMatched: 2,
}

test('extracts official ranking entries from fetched Apollo payload snapshots', () => {
  const entries = extractRiotGprEntries({
    source: 'https://lolesports.com/en-US/gpr/2026/current',
    payloads: [
      {
        data: {
          powerRanking: {
            standings: [
              { rank: 2, team: { name: 'Gen.G', code: 'GEN' } },
              { ranking: '1', teamName: 'T1', acronym: 'T1' },
            ],
          },
        },
      },
    ],
  })

  assert.deepEqual(entries, [
    { rank: 1, team: 'T1', code: 'T1' },
    { rank: 2, team: 'Gen.G', code: 'GEN' },
  ])
})

test('extracts official ranking entries from nested team records', () => {
  const entries = extractRiotGprEntries({
    payloads: [
      {
        events: [
          {
            type: 'next',
            result: {
              data: {
                teamGPR: [
                  {
                    currentTeamGPR: { rank: 10, gprScore: 1369 },
                    team: { name: 'Team Secret Whales', code: 'TSW' },
                  },
                  {
                    currentTeamGPR: { rank: 14, gprScore: 1340 },
                    team: { name: 'CTBC Flying Oyster', code: 'CFO' },
                  },
                ],
              },
            },
          },
        ],
      },
    ],
  })

  assert.deepEqual(entries, [
    { rank: 10, team: 'Team Secret Whales', code: 'TSW' },
    { rank: 14, team: 'CTBC Flying Oyster', code: 'CFO' },
  ])
})

test('compares current standings against official ranking data and flags large top-rank deltas', () => {
  const report = compareRiotGprBenchmark({
    currentShard: shard([
      standing({ team: 'T1', code: 'T1', rank: 1 }),
      standing({ team: 'Gen.G', code: 'GEN', rank: 8 }),
      standing({ team: 'Bilibili Gaming', code: 'BLG', rank: 3 }),
      standing({ team: 'Top Esports', code: 'TES', rank: 4 }),
    ]),
    currentArtifact: artifact(),
    riotSnapshot: { path: 'riot.json', entryCount: 3 },
    riotEntries: [
      { team: 'T1', code: 'T1', rank: 1 },
      { team: 'Gen.G', code: 'GEN', rank: 2 },
      { team: 'Hanwha Life Esports', code: 'HLE', rank: 3 },
    ],
    thresholds,
  })

  assert.equal(report.summary.comparedTeams, 2)
  assert.equal(report.summary.flaggedTeams, 1)
  assert.equal(report.summary.passed, false)
  assert.deepEqual(report.rows[0], {
    team: 'Gen.G',
    code: 'GEN',
    currentRank: 8,
    riotRank: 2,
    rankDelta: 6,
    absRankDelta: 6,
    flagged: true,
    reasons: ['elite-rank-inversion', 'top-band-rank-delta'],
  })
  assert.deepEqual(report.missingFromCurrent, [
    { team: 'Hanwha Life Esports', code: 'HLE', rank: 3 },
  ])
  assert.deepEqual(report.missingFromRiot, [
    { team: 'Bilibili Gaming', code: 'BLG', rank: 3 },
    { team: 'Top Esports', code: 'TES', rank: 4 },
  ])
})

test('passes when matched deltas are within thresholds', () => {
  const report = compareRiotGprBenchmark({
    currentShard: shard([
      standing({ team: 'T1', code: 'T1', rank: 1 }),
      standing({ team: 'Gen.G', code: 'GEN', rank: 3 }),
    ]),
    currentArtifact: artifact(),
    riotSnapshot: { path: 'riot.json', entryCount: 2 },
    riotEntries: [
      { team: 'T1', code: 'T1', rank: 2 },
      { team: 'Gen.G', code: 'GEN', rank: 1 },
    ],
    thresholds,
  })

  assert.equal(report.summary.passed, true)
  assert.equal(report.summary.maxAbsRankDelta, 2)
})

test('allows limited top-band disagreement without treating Riot as a formula clone', () => {
  const report = compareRiotGprBenchmark({
    currentShard: shard([
      standing({ team: 'T1', code: 'T1', rank: 1 }),
      standing({ team: 'Gen.G', code: 'GEN', rank: 2 }),
      standing({ team: 'CTBC Flying Oyster', code: 'CFO', rank: 18 }),
    ]),
    currentArtifact: artifact(),
    riotSnapshot: { path: 'riot.json', entryCount: 3 },
    riotEntries: [
      { team: 'T1', code: 'T1', rank: 1 },
      { team: 'Gen.G', code: 'GEN', rank: 2 },
      { team: 'CTBC Flying Oyster', code: 'CFO', rank: 8 },
    ],
    thresholds: {
      ...thresholds,
      maxLargeDeltas: 1,
    },
  })

  assert.equal(report.summary.flaggedTeams, 1)
  assert.equal(report.summary.eliteFlaggedTeams, 0)
  assert.equal(report.summary.passed, true)
  assert.deepEqual(report.rows[0].reasons, ['top-band-rank-delta'])
})

test('fails when a model elite team is far outside the Riot benchmark', () => {
  const report = compareRiotGprBenchmark({
    currentShard: shard([
      standing({ team: 'T1', code: 'T1', rank: 1 }),
      standing({ team: 'Worst Plausible Team', code: 'WPT', rank: 2 }),
    ]),
    currentArtifact: artifact(),
    riotSnapshot: { path: 'riot.json', entryCount: 2 },
    riotEntries: [
      { team: 'T1', code: 'T1', rank: 1 },
      { team: 'Worst Plausible Team', code: 'WPT', rank: 50 },
    ],
    thresholds: {
      ...thresholds,
      maxLargeDeltas: 10,
    },
  })

  assert.equal(report.summary.flaggedTeams, 1)
  assert.equal(report.summary.eliteFlaggedTeams, 1)
  assert.equal(report.summary.passed, false)
  assert.deepEqual(report.rows[0].reasons, ['elite-rank-inversion', 'top-band-rank-delta'])
})

test('matches common Riot naming aliases before reporting coverage gaps', () => {
  const report = compareRiotGprBenchmark({
    currentShard: shard([
      standing({ team: 'Team Liquid', code: 'TL', rank: 12 }),
      standing({ team: 'Team WE', code: 'TW', rank: 16 }),
    ]),
    currentArtifact: artifact(),
    riotSnapshot: { path: 'riot.json', entryCount: 2 },
    riotEntries: [
      { team: 'Team Liquid Alienware', code: 'TLAW', rank: 17 },
      { team: "Xi'an Team WE", code: 'WE', rank: 25 },
    ],
    thresholds,
  })

  assert.equal(report.summary.comparedTeams, 2)
  assert.equal(report.summary.missingFromCurrent, 0)
  assert.equal(report.summary.missingFromRiot, 0)
})

test('elite missing-team checks are not truncated by a narrower reporting band', () => {
  const report = compareRiotGprBenchmark({
    currentShard: shard([standing({ team: 'T1', code: 'T1', rank: 1 })]),
    currentArtifact: artifact(),
    riotSnapshot: { path: 'riot.json', entryCount: 2 },
    riotEntries: [
      { team: 'T1', code: 'T1', rank: 1 },
      { team: 'Missing Elite', code: 'MISS', rank: 5 },
    ],
    thresholds: {
      ...thresholds,
      top: 2,
      eliteTop: 10,
      minMatched: 1,
    },
  })

  assert.equal(report.summary.missingFromCurrent, 0)
  assert.equal(report.summary.missingEliteFromCurrent, 1)
  assert.equal(report.summary.passed, false)
})

function artifact() {
  return {
    manifestPath: '.generated/ranking-data/ranking-summary.json',
    shardPath: '.generated/ranking-data/scopes/all.json',
    defaultSnapshotKey: 'All__All__All',
    modelVersion: 'transparent-power-index-v0.0.0',
    modelConfigHash: 'test-hash',
  }
}

function shard(standings: PublicTeamStanding[]) {
  return { standings } as unknown as PublicRankingShard
}

function standing(overrides: Pick<PublicTeamStanding, 'team' | 'code' | 'rank'>): PublicTeamStanding {
  return {
    teamId: overrides.code.toLowerCase(),
    leagueId: 'lck',
    team: overrides.team,
    code: overrides.code,
    region: 'LCK',
    league: 'LCK',
    rosterBasis: 'unknown',
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
      uncertainty: 0,
    },
    rating: 1500,
    previousRating: 1500,
    delta: 0,
    rank: overrides.rank,
    previousRank: overrides.rank,
    movement: 0,
    wins: 0,
    losses: 0,
    recordBasis: 'standing-record-from-ranking-model',
    scoreFamily: 'power-index',
    confidence: 0,
    uncertainty: 0,
    form: [],
    strongestFactor: 'league',
    eligibility: { eligible: true, reasons: [] },
    factors: {
      context: 0,
      recency: 0,
      execution: 0,
      opponent: 0,
      league: 0,
    },
    recentEvents: [],
    recentMatches: [],
  }
}
