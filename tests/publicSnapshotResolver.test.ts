import assert from 'node:assert/strict'
import test from 'node:test'
import { publishedRatingScale } from '../src/lib/modelConfig.ts'
import { resolvePublicSnapshotState, validatePublicSnapshotShard, validatePublicTeamHistoryShard } from '../src/lib/publicArtifacts/resolver.ts'
import { PUBLIC_ARTIFACT_SCHEMA_VERSION, snapshotKey, type PublicRankingManifest, type PublicRankingShard, type PublicTeamHistoryIndex, type PublicTeamHistoryShard } from '../src/lib/publicArtifacts/schema.ts'

test('non-default missing snapshot never falls back to embedded default snapshot', () => {
  const data = manifest()
  const state = resolvePublicSnapshotState(data, { season: '2026', event: 'All', region: 'All' }, {})

  assert.equal(state.status, 'missing')
})

test('non-default indexed snapshot reports loading until exact shard arrives', () => {
  const data = manifest({
    snapshotIndex: {
      All__All__All: {
        filter: { season: 'All', event: 'All', region: 'All' },
        url: '/data/scopes/all.json',
        matchCount: 10,
        sourceBreakdown: [],
      },
      '2026__All__All': {
        filter: { season: '2026', event: 'All', region: 'All' },
        url: '/data/scopes/season-2026.json',
        matchCount: 4,
        sourceBreakdown: [],
      },
    },
  })
  const state = resolvePublicSnapshotState(data, { season: '2026', event: 'All', region: 'All' }, {})

  assert.equal(state.status, 'loading')
})

test('checkpoint indexed snapshot reports loading until exact shard arrives', () => {
  const filter = { season: '2026', event: 'All', region: 'All', checkpoint: 'split-1' } as const
  const key = snapshotKey(filter)
  const data = manifest({
    snapshotIndex: {
      All__All__All: {
        filter: { season: 'All', event: 'All', region: 'All' },
        url: '/data/scopes/all.json',
        matchCount: 10,
        sourceBreakdown: [],
      },
      [key]: {
        filter,
        url: '/data/scopes/season-2026-split-1.json',
        matchCount: 5,
        sourceBreakdown: [],
      },
    },
  })
  const state = resolvePublicSnapshotState(data, filter, {})

  assert.equal(state.status, 'loading')
})

test('cached exact shard resolves without using default snapshot', () => {
  const exact = shard({ filter: { season: '2026', event: 'All', region: 'All' }, matchCount: 4 })
  const state = resolvePublicSnapshotState(
    manifest(),
    { season: '2026', event: 'All', region: 'All' },
    { '2026__All__All': { status: 'ready', snapshot: exact } },
  )

  assert.equal(state.status, 'ready')
  assert.equal(state.snapshot.matchCount, 4)
})

test('shard validation rejects scope drift', () => {
  const data = manifest()
  assert.throws(() =>
    validatePublicSnapshotShard(
      '2026__All__All',
      {
        filter: { season: '2026', event: 'All', region: 'All' },
        url: '/data/scopes/season-2026.json',
        matchCount: 4,
        sourceBreakdown: [],
      },
      shard({ filter: { season: 'All', event: 'All', region: 'All' }, matchCount: 4 }),
      data,
    ),
  )
})

test('team history shard validation rejects scope drift', () => {
  const index = teamHistoryIndex()
  assert.throws(() =>
    validatePublicTeamHistoryShard(
      '2026__All__All',
      index.scopeIndex['2026__All__All'],
      teamHistoryShard({ filter: { season: 'All', event: 'All', region: 'All' }, teamCount: 1, pointCount: 2 }),
      index,
    ),
  )
})

function manifest(overrides: Partial<PublicRankingManifest> = {}): PublicRankingManifest {
  return {
    artifactKind: 'public-ranking-manifest',
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    artifactMeta: artifactMeta(),
    ratingScale: publishedRatingScale,
    generatedAt: '2026-06-27T00:00:00.000Z',
    source: 'test',
    sources: [],
    model: { name: 'Transparent GPR', version: 'test-model', configHash: 'test-config', parameters: {} },
    coverage: { matchCount: 10, sourceProviders: [], seededSample: false },
    dataQuality: {
      matchCount: 10,
      sourceProviderCounts: {},
      dataCompletenessCounts: {},
      missing: { sourceProviderCount: 0, sourceGameIdCount: 0, patchCount: 0, sideCount: 0 },
      rosterCoverage: { rosterSides: 0, completeRosterSides: 0, partialRosterSides: 0, missingRosterSides: 0, playerStatRows: 0 },
      identityCoverage: {
        teamProfileCount: 0,
        mappedTeamProfileCount: 0,
        unknownLeagueTeamCount: 0,
        internationalRegionTeamCount: 0,
        unresolvedLeagueSummaries: [],
      },
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
    defaultFilter: { season: 'All', event: 'All', region: 'All' },
    defaultSnapshotKey: 'All__All__All',
    summaryMode: 'browser-summary',
    teamCount: 0,
    snapshotIndex: {
      All__All__All: {
        filter: { season: 'All', event: 'All', region: 'All' },
        url: '/data/scopes/all.json',
        matchCount: 10,
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
    ratingScale: publishedRatingScale,
    generatedAt: '2026-06-27T00:00:00.000Z',
    modelVersion: 'test-model',
    modelConfigHash: 'test-config',
    defaultScopeKey: 'All__All__All',
    omissionPolicy: {
      minimumPointsPerSeries: 2,
      omittedSeriesCount: 0,
      reason: 'test',
    },
    scopeIndex: {
      All__All__All: {
        filter: { season: 'All', event: 'All', region: 'All' },
        url: '/data/history/team-series/all.json',
        teamCount: 1,
        pointCount: 2,
      },
      '2026__All__All': {
        filter: { season: '2026', event: 'All', region: 'All' },
        url: '/data/history/team-series/season-2026.json',
        teamCount: 1,
        pointCount: 2,
      },
    },
    ...overrides,
  }
}

function teamHistoryShard(
  overrides: Pick<PublicTeamHistoryShard, 'filter' | 'teamCount' | 'pointCount'>,
): PublicTeamHistoryShard {
  return {
    artifactKind: 'team-history-scope',
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    artifactMeta: artifactMeta(),
    ratingScale: publishedRatingScale,
    generatedAt: '2026-06-27T00:00:00.000Z',
    modelVersion: 'test-model',
    modelConfigHash: 'test-config',
    filter: overrides.filter,
    omissionPolicy: {
      minimumPointsPerSeries: 2,
      omittedSeriesCount: 0,
      reason: 'test',
    },
    teamCount: overrides.teamCount,
    pointCount: overrides.pointCount,
    series: {},
  }
}

function shard(overrides: Pick<PublicRankingShard, 'filter' | 'matchCount'>): PublicRankingShard {
    return {
      artifactKind: 'public-snapshot-shard',
      artifactMeta: artifactMeta(),
      ratingScale: publishedRatingScale,
      filter: overrides.filter,
    modelVersion: 'test-model',
    modelConfigHash: 'test-config',
    matchCount: overrides.matchCount,
    sourceBreakdown: [],
    standings: [],
    leagues: [],
    regions: [],
  }
}

function artifactMeta() {
  return {
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    runId: 'run_test_test-model_test-config',
    generatedAt: '2026-06-27T00:00:00.000Z',
    modelVersion: 'test-model',
    modelConfigHash: 'test-config',
  }
}
