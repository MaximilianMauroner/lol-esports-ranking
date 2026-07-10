import assert from 'node:assert/strict'
import test from 'node:test'
import { publishedRatingScale } from '../src/lib/modelConfig.ts'
import { buildTeamReceipt } from '../src/lib/receipts.ts'
import { PUBLIC_ARTIFACT_SCHEMA_VERSION, type CompactPlayer, type PublicRankingManifest, type PublicRankingShard, type PublicTeamStanding } from '../src/lib/publicArtifacts/schema.ts'

test('builds a typed team receipt with rating, movement, players, source, model, and config', () => {
  const receipt = buildTeamReceipt({
    standing: standing({
      team: 'Receipt Team',
      code: 'RCT',
      rank: 2,
      previousRank: 5,
      movement: 3,
      rating: 1710,
      previousRating: 1682,
      delta: 28,
      recentEvents: ['MSI 2026', 'LCK 2026 Spring'],
    }),
    standings: [
      standing({ team: 'Leader', code: 'LED', rank: 1, rating: 1760 }),
      standing({ team: 'Receipt Team', code: 'RCT', rank: 2, rating: 1710 }),
    ],
    players: [
      player({ id: 'support', name: 'Support', role: 'Support', team: 'Receipt Team', teamCode: 'RCT', rank: 40 }),
      player({ id: 'top', name: 'Top', role: 'Top', team: 'Receipt Team', teamCode: 'RCT', rank: 12 }),
      player({ id: 'other', name: 'Other', role: 'Mid', team: 'Other Team', teamCode: 'OTH', rank: 1 }),
    ],
    manifest: manifest(),
    shard: shard(),
    asOf: '2026-06-30T00:00:00.000Z',
  })

  assert.equal(receipt.artifactKind, 'team-receipt')
  assert.equal(receipt.team.name, 'Receipt Team')
  assert.equal(receipt.team.tier, 'S')
  assert.equal(receipt.rating.current, 1710)
  assert.equal(receipt.rating.delta, 28)
  assert.equal(receipt.rating.components.leagueAnchor, 1500)
  assert.ok(receipt.rating.update)
  assert.equal(receipt.rating.update.teamStableDelta, 6)
  assert.equal(receipt.movement.rankDelta, 3)
  assert.deepEqual(receipt.players.map((player) => player.role), ['Top', 'Support'])
  assert.deepEqual(receipt.recent.events, ['MSI 2026', 'LCK 2026 Spring'])
  assert.equal(receipt.source.label, 'fixture-source')
  assert.equal(receipt.source.coverage?.matchCount, 42)
  assert.equal(receipt.source.sourceBreakdown[0]?.provider, 'oracles-elixir')
  assert.equal(receipt.model.version, 'fixture-model')
  assert.equal(receipt.config.modelConfigHash, 'fixture-config')
  assert.equal(receipt.config.filter?.season, '2026')
})

test('receipt share payload is stable and exposes staleness fields', () => {
  const input = {
    standing: standing({ team: 'Hash Team', code: 'HSH', rank: 7, rating: 1600, movement: -2, delta: -15 }),
    standings: [
      standing({ team: 'Leader', code: 'LED', rank: 1, rating: 1760 }),
      standing({ team: 'Hash Team', code: 'HSH', rank: 7, rating: 1600, movement: -2, delta: -15 }),
    ],
    manifest: manifest(),
    shard: shard(),
    asOf: '2026-07-07T00:00:00.000Z',
    staleAfterDays: 7,
  }

  const first = buildTeamReceipt(input)
  const second = buildTeamReceipt(input)

  assert.equal(first.share.hash, second.share.hash)
  assert.equal(first.share.payload.team, 'Hash Team')
  assert.equal(first.share.payload.modelVersion, 'fixture-model')
  assert.equal(first.share.payload.modelConfigHash, 'fixture-config')
  assert.equal(first.share.payload.generatedAt, '2026-06-28T00:00:00.000Z')
  assert.equal(first.share.payload.tier, 'A')
  assert.equal(first.staleness.generatedAt, '2026-06-28T00:00:00.000Z')
  assert.equal(first.staleness.asOf, '2026-07-07T00:00:00.000Z')
  assert.equal(first.staleness.ageDays, 9)
  assert.equal(first.staleness.isStale, true)
})

function manifest(): BuildManifest {
  return {
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    generatedAt: '2026-06-28T00:00:00.000Z',
    source: 'fixture-source',
    sources: [
      {
        name: 'Oracle fixture',
        kind: 'match-data',
        description: 'Fixture source',
        status: 'active',
      },
    ],
    model: {
      name: 'Fixture Power Index',
      version: 'fixture-model',
      configHash: 'fixture-config',
      ratingScale: publishedRatingScale,
      parameters: { fixture: true },
    },
    ratingScale: publishedRatingScale,
    coverage: {
      matchCount: 42,
      sourceProviders: ['oracles-elixir'],
      seededSample: false,
    },
    dataMode: 'scheduled-public-data',
    defaultFilter: { season: '2026', event: 'All', region: 'All' },
  }
}

function shard(): BuildShard {
  return {
    filter: { season: '2026', event: 'All', region: 'All' },
    modelVersion: 'fixture-model',
    modelConfigHash: 'fixture-config',
    matchCount: 42,
    sourceBreakdown: [
      {
        provider: 'oracles-elixir',
        matchCount: 42,
        completeness: ['complete'],
      },
    ],
  }
}

function player(overrides: Partial<CompactPlayer> = {}): CompactPlayer {
  return {
    id: 'player',
    name: 'Player',
    team: 'Receipt Team',
    teamCode: 'RCT',
    role: 'Mid',
    rank: 1,
    rating: 1700,
    games: 10,
    delta: 5,
    form: ['W'],
    impactMultiplier: 1,
    availability: 1,
    roleCertainty: 1,
    impactDrivers: {
      objectiveImpactZ: 0,
      awardResidualZ: 0,
      recentFormZ: 0,
    },
    sourceProvider: 'oracles-elixir',
    latestObservedAt: '2026-06-27',
    latestObservedEvent: 'LCK 2026 Spring',
    ...overrides,
  }
}

function standing(overrides: Partial<PublicTeamStanding> = {}): PublicTeamStanding {
  return {
    team: 'Example',
    teamId: 'Example__LCK__EX',
    leagueId: 'LCK',
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
      teamStableOffset: 110,
      rosterPriorOffset: 20,
      momentum: 15,
      contextAdjustment: 5,
      uncertainty: 50,
    },
    ratingUpdate: {
      teamStableDelta: 6,
      leagueGameDelta: 2,
      leaguePlacementDelta: 1,
      momentumDelta: 3,
      rosterPriorDelta: 0,
      uncertaintyDelta: -2,
      sideAdjustment: 0,
      patchAdjustment: 0,
      resultEvidence: 1,
    },
    rating: 1650,
    previousRating: 1630,
    delta: 20,
    rank: 3,
    previousRank: 4,
    movement: 1,
    wins: 12,
    losses: 4,
    confidence: 82,
    uncertainty: 50,
    form: ['W', 'W', 'L'],
    strongestFactor: 'opponent',
    eligibility: {
      eligible: true,
      reasons: [],
      totalGames: 16,
      minTotalGames: 5,
      currentWindowGames: 6,
      minCurrentWindowGames: 3,
      windowDays: 180,
    },
    factors: {
      context: 0.2,
      recency: 0.3,
      execution: 0.1,
      opponent: 0.5,
      league: 0.4,
    },
    recentEvents: ['LCK 2026 Spring'],
    recentMatches: [
      {
        date: '2026-06-20',
        event: 'LCK 2026 Spring',
        opponent: 'Opponent',
        result: 'W',
        rating: 1650,
        delta: 14,
      },
    ],
    ...overrides,
    recordBasis: overrides.recordBasis ?? 'grouped-match-record-from-scope-history',
    scoreFamily: overrides.scoreFamily ?? 'power-index',
  }
}

type BuildManifest = Pick<PublicRankingManifest, 'schemaVersion' | 'generatedAt' | 'source' | 'sources' | 'model' | 'ratingScale' | 'coverage' | 'dataMode' | 'defaultFilter'>
type BuildShard = Pick<PublicRankingShard, 'filter' | 'modelVersion' | 'modelConfigHash' | 'matchCount' | 'sourceBreakdown'>
