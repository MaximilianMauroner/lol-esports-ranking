import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PUBLIC_ARTIFACT_SCHEMA_VERSION,
  filterFromSnapshotKey,
  parsePublicRankingManifest,
  parsePublicRegionHistory,
  parsePublicTeamHistoryIndex,
  parsePublicTeamHistoryShard,
  snapshotKey,
  snapshotShardUrlPathForKey,
  teamHistoryShardUrlPathForKey,
  type PublicRankingManifest,
  type PublicRegionHistoryDirectory,
  type PublicTeamHistoryIndex,
  type PublicTeamHistoryShard,
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
              { model: { c: [1500, 10, 5, 0] } },
            ],
          ],
        },
      },
      pointCount: 1,
    })),
    /five-number component tuple/,
  )
})

test('region history parser validates scoped series and tuple context', () => {
  assert.doesNotThrow(() => parsePublicRegionHistory(regionHistory()))

  assert.throws(
    () => parsePublicRegionHistory(regionHistory({
      scopes: {
        '2026__All__All': {
          filter: { season: 'All', event: 'All', region: 'All' },
          regionCount: 1,
          pointCount: 1,
          series: {
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
          pointCount: 1,
          series: {
            LCK: {
              region: 'LCK',
              points: [['2026-01-01', 1500, 1, { source: 'manual' }] as unknown as PublicRegionHistoryDirectory['scopes'][string]['series'][string]['points'][number]],
            },
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
    model: { name: 'Transparent GPR', version: 'test-model', configHash: 'test-config', parameters: {} },
    coverage: { matchCount: 0, sourceProviders: [], seededSample: false },
    dataQuality: {
      matchCount: 0,
      sourceProviderCounts: {},
      dataCompletenessCounts: {},
      missing: { sourceProviderCount: 0, sourceGameIdCount: 0, patchCount: 0, sideCount: 0 },
      rosterCoverage: { rosterSides: 0, completeRosterSides: 0, partialRosterSides: 0, missingRosterSides: 0, playerStatRows: 0 },
      identityCoverage: { teamProfileCount: 0, mappedTeamProfileCount: 0, unknownLeagueTeamCount: 0, internationalRegionTeamCount: 0, unresolvedLeagueSummaries: [] },
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

function teamHistoryIndex(overrides: Partial<PublicTeamHistoryIndex> = {}): PublicTeamHistoryIndex {
  return {
    artifactKind: 'team-history-index',
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    artifactMeta: artifactMeta(),
    generatedAt: '2026-06-28T00:00:00.000Z',
    modelVersion: 'test-model',
    modelConfigHash: 'test-config',
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
              model: { e: 0.5, a: [['s', 1]], c: [1500, 10, 5, 0, 0] },
            },
          ],
        ],
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
    defaultScopeKey: 'All__All__All',
    scopes: {
      All__All__All: {
        filter: { season: 'All', event: 'All', region: 'All' },
        regionCount: 1,
        pointCount: 1,
        series: {
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
      },
    },
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
