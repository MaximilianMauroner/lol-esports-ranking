import assert from 'node:assert/strict'
import test from 'node:test'
import { publishedRatingScale } from '../src/lib/modelConfig.ts'
import {
  PUBLIC_ARTIFACT_SCHEMA_VERSION,
  filterFromSnapshotKey,
  parsePublicRankingManifest,
  parsePublicRankingShard,
  parsePublicRegionHistory,
  parsePublicTeamHistoryIndex,
  parsePublicTeamHistoryShard,
  parsePublicTournamentMovementIndex,
  parsePublicTournamentMovementShard,
  publicScoreFamilies,
  type PublicRankingShard,
  type PublicTeamStanding,
  type PublicTeamHistoryComponentSnapshot,
  snapshotKey,
  snapshotShardUrlPathForKey,
  teamHistoryShardUrlPathForKey,
  type PublicRankingManifest,
  type PublicRegionHistoryDirectory,
  type PublicTeamHistoryIndex,
  type PublicTeamHistoryShard,
  type PublicTournamentMovementIndex,
  type PublicTournamentMovementShard,
  type SnapshotFilter,
} from '../src/lib/publicArtifacts/schema.ts'

test('public ranking manifest parser validates nested filters and data URL paths', () => {
  assert.doesNotThrow(() => parsePublicRankingManifest(manifest()))
  assert.doesNotThrow(() => parsePublicRankingManifest(manifest({
    playerDirectoryUrl: '/data/entities/players.json?v=run_20260628000000_test-model_test-config',
    snapshotIndex: {
      All__All__All: {
        filter: { season: 'All', event: 'All', region: 'All' },
        url: '/data/scopes/all.json?v=run_20260628000000_test-model_test-config',
        matchCount: 0,
        sourceBreakdown: [],
      },
    },
  })))
  assert.doesNotThrow(() => parsePublicRankingManifest(manifest({
    sources: [
      {
        name: 'Data Dragon static data',
        kind: 'static-metadata',
        description: 'Static metadata only',
        status: 'reference-only',
      },
      {
        name: 'Cito LoL API experiment',
        kind: 'experimental-api',
        description: 'Free-tier experiment only',
        status: 'reference-only',
      },
      {
        name: 'LoL Esports schedule API',
        kind: 'official-reference',
        description: 'Cached unsupported schedule reference',
        status: 'active',
        warnings: [{
          kind: 'source-policy',
          severity: 'warning',
          message: 'Unsupported site endpoint',
        }],
      },
    ],
  })))

  assert.throws(
    () => parsePublicRankingManifest(manifest({
      snapshotIndex: {
        All__All__All: {
          filter: { season: 'All', event: 'All', region: 'All' },
          url: '/data/scopes/all.json?cache=1',
          matchCount: 0,
          sourceBreakdown: [],
        },
      },
    })),
    /v query parameter/,
  )

  assert.throws(
    () => parsePublicRankingManifest(manifest({
      snapshotIndex: {
        '2026__All__All': {
          filter: { season: 'All', event: 'All', region: 'All' },
          url: snapshotShardUrlPathForKey('2026__All__All'),
          matchCount: 0,
          sourceBreakdown: [],
        },
      },
    })),
    /must match its filter/,
  )
})

test('public ranking shard parser validates source, standing, and league rows', () => {
  const standing = publicStanding()
  const league = publicLeague()
  const validShard = rankingShard({ standings: [standing], leagues: [league], scoreFamilies: [...publicScoreFamilies] })

  assert.doesNotThrow(() => parsePublicRankingShard(validShard))

  assert.throws(
    () => parsePublicRankingShard({ ...validShard, scoreFamilies: undefined }),
    /scoreFamilies/,
  )

  assert.throws(
    () => parsePublicRankingShard({
      ...validShard,
      standings: [{ ...standing, recordBasis: undefined }],
    }),
    /recordBasis/,
  )

  assert.throws(
    () => parsePublicRankingShard({
      ...validShard,
      sourceBreakdown: [{ provider: 'oracles-elixir', matchCount: '1', completeness: [] }],
    }),
    /sourceBreakdown\[0\] matchCount/,
  )

  assert.throws(
    () => parsePublicRankingShard({
      ...validShard,
      standings: [{ ...standing, rank: '1' }],
    }),
    /standings\[0\] rank/,
  )

  assert.throws(
    () => parsePublicRankingShard({
      ...validShard,
      standings: [{ ...standing, recordBasis: 'raw-table-record' } as unknown as PublicTeamStanding],
    }),
    /standings\[0\] recordBasis/,
  )

  assert.throws(
    () => parsePublicRankingShard({
      ...validShard,
      scoreFamilies: [{ ...publicScoreFamilies[0], scoreField: 1 }] as unknown as PublicRankingShard['scoreFamilies'],
    }),
    /scoreFamilies\[0\] scoreField/,
  )

  assert.throws(
    () => parsePublicRankingShard({
      ...validShard,
      leagues: [{ ...league, score: '1500' }],
    }),
    /leagues\[0\] score/,
  )
})

test('checkpoint filters round-trip through public keys and manifest options', () => {
  const checkpoint = {
    id: 'split-2',
    season: '2026',
    label: 'Split 2',
    startDate: '2026-03-23',
    endDate: '2026-06-28',
    boundaryEvent: 'MSI 2026',
    previousEndDate: '2026-03-22',
    description: '2026 Split 2 through MSI 2026',
  }
  const filter = { season: '2026', event: 'All', region: 'All', checkpoint: checkpoint.id } satisfies SnapshotFilter
  const key = '2026__All__All__split-2'
  const parsed = parsePublicRankingManifest(manifest({
    filterOptions: {
      seasons: ['All', '2026'],
      events: ['All'],
      regions: ['All'],
      checkpoints: { 2026: [checkpoint] },
    },
    snapshotIndex: {
      All__All__All: {
        filter: { season: 'All', event: 'All', region: 'All' },
        url: snapshotShardUrlPathForKey('All__All__All'),
        matchCount: 0,
        sourceBreakdown: [],
      },
      [key]: {
        filter,
        url: snapshotShardUrlPathForKey(key),
        matchCount: 5,
        sourceBreakdown: [],
      },
    },
  }))

  assert.equal(snapshotKey(filter), key)
  assert.deepEqual(filterFromSnapshotKey(key), filter)
  assert.equal(snapshotShardUrlPathForKey(key), '/data/scopes/season-2026-split-2.json')
  assert.equal(parsed.filterOptions.checkpoints?.['2026']?.[0]?.boundaryEvent, 'MSI 2026')
})

test('team history index parser requires schemaVersion, matching scopes, and canonical URLs', () => {
  assert.doesNotThrow(() => parsePublicTeamHistoryIndex(teamHistoryIndex()))

  assert.throws(
    () => parsePublicTeamHistoryIndex({ ...teamHistoryIndex(), schemaVersion: undefined }),
    /schemaVersion/,
  )

  assert.throws(
    () => parsePublicTeamHistoryIndex(teamHistoryIndex({
      scopeIndex: {
        All__All__All: {
          filter: { season: 'All', event: 'All', region: 'All' },
          url: '/data/history/..%2Fescape.json',
          teamCount: 1,
          pointCount: 1,
        },
      },
    })),
    /encoded path separators|must be/,
  )
})

test('team history shard parser validates point tuples and compact model context', () => {
  assert.doesNotThrow(() => parsePublicTeamHistoryShard(teamHistoryShard()))

  assert.throws(
    () => parsePublicTeamHistoryShard(teamHistoryShard({
      series: {
        Example__LCK__EX: {
          team: 'Example',
          region: 'LCK',
          points: [['2026-01-01', 1500] as unknown as PublicTeamHistoryShard['series'][string]['points'][number]],
          currentStanding: currentStanding(),
        },
      },
      pointCount: 1,
    })),
    /tuple/,
  )

  assert.throws(
    () => parsePublicTeamHistoryShard(teamHistoryShard({
      series: {
        Example__LCK__EX: {
          team: 'Example',
          region: 'LCK',
          points: [
            [
              '2026-01-01',
              1500,
              1,
              { model: { c: [1500, 10, 5, 0] as unknown as PublicTeamHistoryComponentSnapshot } },
            ],
          ],
          currentStanding: currentStanding(),
        },
      },
      pointCount: 1,
    })),
    /five-number component tuple/,
  )
})

test('tournament movement parsers require matching identities and explicit boundaries', () => {
  assert.doesNotThrow(() => parsePublicTournamentMovementIndex(tournamentMovementIndex()))
  assert.doesNotThrow(() => parsePublicTournamentMovementShard(tournamentMovementShard()))
  assert.throws(() => parsePublicTournamentMovementIndex(tournamentMovementIndex({
    tournaments: [{ ...tournamentMovementIndex().tournaments[0], id: 'msi:2025' }],
  })), /id must match family and season/)
  assert.throws(() => parsePublicTournamentMovementShard(tournamentMovementShard({
    teams: [{
      ...tournamentMovementShard().teams[0],
      points: tournamentMovementShard().teams[0].points.slice(1),
    }],
  })), /start with a tournament-start boundary/)
})

test('region history parser validates scoped series and tuple context', () => {
  assert.doesNotThrow(() => parsePublicRegionHistory(regionHistory()))

  assert.throws(
    () => parsePublicRegionHistory(regionHistory({
      scopes: {
        '2026__All__All': {
          filter: { season: 'All', event: 'All', region: 'All' },
          regionCount: 1,
          pointCount: 2,
          metricDefinitions: regionMetricDefinitions(),
          leagueStrengthSeries: {
            LCK: { region: 'LCK', points: [['2026-01-01', 1500, 1]] },
          },
          regionPowerSeries: {
            LCK: { region: 'LCK', points: [['2026-01-01', 1500, 1]] },
          },
        },
      },
    })),
    /must match its filter/,
  )

  assert.throws(
    () => parsePublicRegionHistory(regionHistory({
      scopes: {
        All__All__All: {
          filter: { season: 'All', event: 'All', region: 'All' },
          regionCount: 1,
          pointCount: 2,
          metricDefinitions: regionMetricDefinitions(),
          leagueStrengthSeries: {
            LCK: {
              region: 'LCK',
              points: [['2026-01-01', 1500, 1, { source: 'manual' }] as unknown as PublicRegionHistoryDirectory['scopes'][string]['leagueStrengthSeries'][string]['points'][number]],
            },
          },
          regionPowerSeries: {
            LCK: { region: 'LCK', points: [['2026-01-01', 1500, 1]] },
          },
        },
      },
    })),
    /source/,
  )
})

function manifest(overrides: Partial<PublicRankingManifest> = {}): PublicRankingManifest {
  const filter = { season: 'All', event: 'All', region: 'All' } satisfies SnapshotFilter
  const key = 'All__All__All'
  return {
    artifactKind: 'public-ranking-manifest',
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    artifactMeta: artifactMeta(),
    generatedAt: '2026-06-28T00:00:00.000Z',
    source: 'test',
    sources: [],
    model: { name: 'Transparent Power Index', version: 'test-model', configHash: 'test-config', parameters: {} },
    ratingScale: publishedRatingScale,
    coverage: { matchCount: 0, sourceProviders: [], seededSample: false },
    dataQuality: {
      matchCount: 0,
      pipelineCounts: { importedMatchCount: 0, publishedMatchCount: 0, filteredMatchCount: 0 },
      sourceProviderCounts: {},
      dataCompletenessCounts: {},
      missing: { sourceProviderCount: 0, sourceGameIdCount: 0, patchCount: 0, sideCount: 0 },
      rosterCoverage: { rosterSides: 0, completeRosterSides: 0, partialRosterSides: 0, missingRosterSides: 0, playerStatRows: 0 },
      identityCoverage: { teamProfileCount: 0, mappedTeamProfileCount: 0, unknownLeagueTeamCount: 0, internationalRegionTeamCount: 0, unresolvedLeagueSummaries: [], duplicateTeamCodes: [], unresolvedLineages: [] },
      notes: [],
    },
    playerData: {
      status: 'no-data',
      description: 'test',
      metric: {
        id: 'role-power',
        label: 'Role Power',
        shortLabel: 'Role Power',
        description: 'Role-conditioned player rating from sourced game stats.',
        interpretation: 'This metric includes team-result signal and should not be read as independent best-in-role proof.',
        teamResultSignal: 'included',
        independentSkillClaim: false,
      },
      awardSignals: { status: 'source-missing', description: 'test', sourceProvidersChecked: [], awardResidualsApplied: false },
    },
    walkForward: { metrics: {} as PublicRankingManifest['walkForward']['metrics'] },
    dataMode: 'no-data',
    filterOptions: { seasons: ['All'], events: ['All'], regions: ['All'] },
    defaultFilter: filter,
    defaultSnapshotKey: key,
    summaryMode: 'browser-summary',
    playerDirectoryUrl: '/data/entities/players.json',
    teamDirectoryUrl: '/data/entities/teams.json',
    teamHistoryUrl: '/data/history/team-series.json',
    regionHistoryUrl: '/data/history/region-series.json',
    tournamentMovementIndexUrl: '/data/history/tournament-moves/index.json',
    teamCount: 0,
    snapshotIndex: {
      [key]: {
        filter,
        url: snapshotShardUrlPathForKey(key),
        matchCount: 0,
        sourceBreakdown: [],
      },
    },
    ...overrides,
  }
}

function rankingShard(overrides: Partial<PublicRankingShard> = {}): PublicRankingShard {
  const filter = { season: 'All', event: 'All', region: 'All' } satisfies SnapshotFilter
  return {
    artifactKind: 'public-snapshot-shard',
    artifactMeta: artifactMeta(),
    ratingScale: publishedRatingScale,
    filter,
    modelVersion: 'test-model',
    modelConfigHash: 'test-config',
    matchCount: 1,
    sourceBreakdown: [{ provider: 'oracles-elixir', matchCount: 1, completeness: ['complete'] }],
    scoreFamilies: [...publicScoreFamilies],
    standings: [publicStanding()],
    leagues: [publicLeague()],
    regions: [{
      region: 'LCK',
      rank: 1,
      score: 1500,
      topTeamRating: 1500,
      topThreeTeamRating: 1500,
      totalTeamRating: 1500,
      teamCount: 1,
      ecosystemTeamCount: 1,
      leagueCount: 1,
      ecosystemLeagueCount: 1,
      flagshipLeagues: ['LCK'],
      connectivity: 1,
      internationalWins: 1,
      internationalLosses: 0,
      topTeams: [{ team: 'Example', code: 'EX', rating: 1500, rank: 1 }],
    }],
    ...overrides,
  }
}

function publicStanding(): PublicTeamStanding {
  return {
    teamId: 'team:ex:example',
    leagueId: 'league:lck:lck',
    team: 'Example',
    code: 'EX',
    region: 'LCK',
    league: 'LCK',
    rosterBasis: 'sourced',
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
    previousRating: 1490,
    delta: 10,
    rank: 1,
    previousRank: 2,
    movement: 1,
    wins: 1,
    losses: 0,
    recordBasis: 'grouped-match-record-from-scope-history',
    scoreFamily: 'power-index',
    confidence: 0.8,
    uncertainty: 10,
    form: ['W'],
    strongestFactor: 'league',
    eligibility: { eligible: true, reasons: [] },
    factors: {
      context: 0,
      recency: 0,
      execution: 0,
      opponent: 0,
      league: 1,
    },
    recentEvents: ['Example Cup'],
    recentMatches: [{
      date: '2026-01-01',
      event: 'Example Cup',
      opponent: 'Opponent',
      result: 'W',
      rating: 1500,
      delta: 10,
      wins: 1,
      losses: 0,
      games: 1,
      bestOf: 1,
    }],
  }
}

function publicLeague(): PublicRankingShard['leagues'][number] {
  return {
    league: 'LCK',
    region: 'LCK',
    tier: 'tier-one',
    priorScore: 1500,
    rawScore: 1500,
    connectivity: 1,
    score: 1500,
    adjustment: 0,
    delta: 0,
    wins: 1,
    losses: 0,
    internationalMatches: 1,
    form: ['W'],
  }
}

function teamHistoryIndex(overrides: Partial<PublicTeamHistoryIndex> = {}): PublicTeamHistoryIndex {
  return {
    artifactKind: 'team-history-index',
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    artifactMeta: artifactMeta(),
    generatedAt: '2026-06-28T00:00:00.000Z',
    modelVersion: 'test-model',
    modelConfigHash: 'test-config',
    ratingScale: publishedRatingScale,
    defaultScopeKey: 'All__All__All',
    omissionPolicy: { minimumPointsPerSeries: 2, omittedSeriesCount: 0, reason: 'test' },
    scopeIndex: {
      All__All__All: {
        filter: { season: 'All', event: 'All', region: 'All' },
        url: teamHistoryShardUrlPathForKey('All__All__All'),
        teamCount: 1,
        pointCount: 1,
      },
    },
    ...overrides,
  }
}

function teamHistoryShard(overrides: Partial<PublicTeamHistoryShard> = {}): PublicTeamHistoryShard {
  return {
    artifactKind: 'team-history-scope',
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    artifactMeta: artifactMeta(),
    generatedAt: '2026-06-28T00:00:00.000Z',
    modelVersion: 'test-model',
    modelConfigHash: 'test-config',
    ratingScale: publishedRatingScale,
    filter: { season: 'All', event: 'All', region: 'All' },
    omissionPolicy: { minimumPointsPerSeries: 2, omittedSeriesCount: 0, reason: 'test' },
    teamCount: 1,
    pointCount: 1,
    series: {
      Example__LCK__EX: {
        team: 'Example',
        code: 'EX',
        region: 'LCK',
        points: [
          [
            '2026-01-01',
            1500,
            1,
            {
              event: 'Example Cup',
              opponent: 'Opponent',
              result: 'W',
              wins: 1,
              losses: 0,
              games: 1,
              bestOf: 1,
              sourceProvider: 'oracles-elixir',
              sourceGameIds: ['game-1'],
              officialEventId: 'official-event-1',
              officialMatchId: 'official-match-1',
              officialGameId: 'official-game-1',
              model: { e: 0.5, a: [['s', 1]], c: [1500, 10, 5, 0, 0] },
            },
          ],
        ],
        currentStanding: currentStanding(),
      },
    },
    ...overrides,
  }
}

function regionHistory(overrides: Partial<PublicRegionHistoryDirectory> = {}): PublicRegionHistoryDirectory {
  return {
    artifactKind: 'region-history',
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    artifactMeta: artifactMeta(),
    generatedAt: '2026-06-28T00:00:00.000Z',
    modelVersion: 'test-model',
    modelConfigHash: 'test-config',
    ratingScale: publishedRatingScale,
    defaultScopeKey: 'All__All__All',
    scopes: {
      All__All__All: {
        filter: { season: 'All', event: 'All', region: 'All' },
        regionCount: 1,
        pointCount: 2,
        metricDefinitions: regionMetricDefinitions(),
        leagueStrengthSeries: {
          LCK: {
            region: 'LCK',
            points: [
              [
                '2026-01-01',
                1500,
                1,
                {
                  event: 'Example Cup',
                  tier: 'international',
                  leagues: ['LCK'],
                  opponentRegions: ['LPL'],
                  wins: 1,
                  losses: 0,
                  winsOverExpected: 0.2,
                  opponentAdjustedWinRate: 0.7,
                  source: 'league-strength-history',
                },
              ],
            ],
          },
        },
        regionPowerSeries: {
          LCK: {
            region: 'LCK',
            points: [['2026-01-01', 1500, 1, { event: 'Power checkpoint', source: 'region-power-history', contributingTeams: ['Example'] }]],
          },
        },
      },
    },
    ...overrides,
  }
}

function currentStanding() {
  return {
    asOf: '2026-01-02T00:00:00.000Z',
    rating: 1500,
    rank: 1,
    lastMatchRating: 1500,
    adjustment: 0,
  }
}

function regionMetricDefinitions() {
  return {
    leagueStrength: 'League strength fixture.',
    regionPower: 'Region power fixture.',
  }
}

function tournamentMovementIndex(overrides: Partial<PublicTournamentMovementIndex> = {}): PublicTournamentMovementIndex {
  return {
    artifactKind: 'tournament-movement-index',
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    artifactMeta: artifactMeta(),
    ratingScale: publishedRatingScale,
    generatedAt: '2026-06-28T00:00:00.000Z',
    modelVersion: 'test-model',
    modelConfigHash: 'test-config',
    tournaments: [{
      id: 'msi:2026',
      family: 'msi',
      season: '2026',
      label: 'MSI 2026',
      status: 'ongoing',
      startDate: '2026-06-28',
      boundaryDate: '2026-07-10',
      ratedThroughDate: '2026-07-08',
      scheduledEndDate: '2026-07-12',
      dataLag: false,
      participantCount: 1,
      url: '/data/history/tournament-moves/msi-2026.json',
    }],
    ...overrides,
  }
}

function tournamentMovementShard(overrides: Partial<PublicTournamentMovementShard> = {}): PublicTournamentMovementShard {
  return {
    artifactKind: 'tournament-movement',
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    artifactMeta: artifactMeta(),
    ratingScale: publishedRatingScale,
    generatedAt: '2026-06-28T00:00:00.000Z',
    modelVersion: 'test-model',
    modelConfigHash: 'test-config',
    id: 'msi:2026',
    family: 'msi',
    season: '2026',
    label: 'MSI 2026',
    status: 'ongoing',
    startDate: '2026-06-28',
    boundaryDate: '2026-07-10',
    ratedThroughDate: '2026-07-08',
    scheduledEndDate: '2026-07-12',
    dataLag: false,
    participantCount: 1,
    teams: [{
      teamId: 'example__lck__ex',
      team: 'Example',
      code: 'EX',
      eligible: true,
      eligibilityReasons: [],
      startRank: 4,
      endRank: 2,
      rankMovement: 2,
      startRating: 1500,
      endRating: 1540,
      ratingDelta: 40,
      points: [
        ['2026-06-28', 1500, 4, { kind: 'tournament-start', event: 'MSI 2026 start' }],
        ['2026-07-01', 1520, 3, { kind: 'match', event: 'MSI 2026', opponent: 'Opponent', result: 'W' }],
        ['2026-07-10', 1540, 2, { kind: 'tournament-today', event: 'MSI 2026 today' }],
      ],
    }],
    ...overrides,
  }
}

function artifactMeta() {
  return {
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    runId: 'run_test_test-model_test-config',
    generatedAt: '2026-06-28T00:00:00.000Z',
    modelVersion: 'test-model',
    modelConfigHash: 'test-config',
  }
}
