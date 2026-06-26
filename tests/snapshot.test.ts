import assert from 'node:assert/strict'
import test from 'node:test'
import { rosters, sampleMatches, teams } from '../src/data/sampleData.ts'
import { createStaticRankingData, snapshotKey } from '../src/lib/snapshot.ts'

test('generated snapshots carry model and source provenance', () => {
  const data = createStaticRankingData({
    matches: sampleMatches,
    teams,
    rosters,
    generatedAt: '2026-06-26T00:00:00.000Z',
  })

  assert.equal(data.dataMode, 'seeded-sample')
  assert.equal(data.coverage.seededSample, true)
  assert.equal(data.coverage.sourceProviders.includes('seed'), true)
  assert.match(data.model.version, /^transparent-gpr-v/)
  assert.match(data.model.configHash, /^fnv1a-/)
  assert.equal(data.snapshots[data.defaultSnapshotKey].modelVersion, data.model.version)
  assert.equal(data.snapshots[data.defaultSnapshotKey].modelConfigHash, data.model.configHash)
  assert.equal(sampleMatches.every((match) => match.sourceProvider === 'seed'), true)
})

test('event filters preserve the global rating scale instead of rebuilding mini-models', () => {
  const data = createStaticRankingData({
    matches: sampleMatches,
    teams,
    rosters,
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
  const globalSnapshot = data.snapshots[data.defaultSnapshotKey]
  const eventSnapshot = data.snapshots[snapshotKey({ season: 'All', event: 'MSI 2026', region: 'All' })]
  const globalGenG = globalSnapshot.standings.find((standing) => standing.team === 'Gen.G')
  const eventGenG = eventSnapshot.standings.find((standing) => standing.team === 'Gen.G')

  assert.ok(globalGenG)
  assert.ok(eventGenG)
  assert.equal(eventGenG.rating, globalGenG.rating)
  assert.equal(eventSnapshot.modelVersion, data.model.version)
})

test('empty usable inputs create a no-data snapshot instead of seeded rankings', () => {
  const data = createStaticRankingData({
    matches: [],
    teams: {},
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
    source: 'no public match data available',
  })
  const snapshot = data.snapshots[data.defaultSnapshotKey]

  assert.equal(data.dataMode, 'no-data')
  assert.equal(data.coverage.matchCount, 0)
  assert.equal(data.coverage.seededSample, false)
  assert.equal(data.filterOptions.seasons.length, 1)
  assert.equal(snapshot.standings.length, 0)
  assert.equal(snapshot.leagues.length, 0)
  assert.equal(snapshot.players.length, 0)
})
