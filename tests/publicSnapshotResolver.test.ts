import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePublicSnapshotState, validatePublicSnapshotShard } from '../src/lib/publicArtifacts/resolver.ts'
import type { PublicRankingManifest, PublicRankingShard } from '../src/lib/publicArtifacts/schema.ts'

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
        url: '/data/snapshots/All__All__All.json',
        matchCount: 10,
        sourceBreakdown: [],
      },
      '2026__All__All': {
        filter: { season: '2026', event: 'All', region: 'All' },
        url: '/data/snapshots/2026__All__All.json',
        matchCount: 4,
        sourceBreakdown: [],
      },
    },
  })
  const state = resolvePublicSnapshotState(data, { season: '2026', event: 'All', region: 'All' }, {})

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
        url: '/data/snapshots/2026__All__All.json',
        matchCount: 4,
        sourceBreakdown: [],
      },
      shard({ filter: { season: 'All', event: 'All', region: 'All' }, matchCount: 4 }),
      data,
    ),
  )
})

function manifest(overrides: Partial<PublicRankingManifest> = {}): PublicRankingManifest {
  const defaultShard = shard({ filter: { season: 'All', event: 'All', region: 'All' }, matchCount: 10 })
  return {
    artifactKind: 'public-ranking-manifest',
    schemaVersion: 12,
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
        url: '/data/snapshots/All__All__All.json',
        matchCount: 10,
        sourceBreakdown: [],
      },
    },
    snapshots: { All__All__All: defaultShard },
    ...overrides,
  }
}

function shard(overrides: Pick<PublicRankingShard, 'filter' | 'matchCount'>): PublicRankingShard {
  return {
    artifactKind: 'public-snapshot-shard',
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
