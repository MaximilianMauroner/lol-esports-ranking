import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  parsePublicMatchHistoryCatalog,
  parsePublicMatchHistoryIndex,
  parsePublicMatchHistoryPage,
  parsePublicPlayerDirectory,
  parsePublicRankingManifest,
  parsePublicRankingShard,
  parsePublicRegionHistory,
  parsePublicTeamDirectory,
  parsePublicTeamHistoryIndex,
  parsePublicTeamHistoryShard,
  parsePublicTournamentMovementIndex,
  parsePublicTournamentMovementShard,
  PUBLIC_ARTIFACT_SCHEMA_VERSION,
} from '../src/lib/publicArtifacts/schema.ts'
import { PUBLIC_ARTIFACT_BUDGETS } from '../src/lib/publicArtifacts/writePlan.ts'
import { validatePublicArtifactBundle } from '../scripts/materialize-ranking-data.ts'
import { PUBLIC_ARTIFACT_FIXTURE_DIR, PUBLIC_ARTIFACT_FIXTURE_RUN } from './fixtures/publicArtifactBundle.ts'

test('deterministic browser fixture is a complete schema-valid artifact graph', async () => {
  const validated = await validatePublicArtifactBundle(PUBLIC_ARTIFACT_FIXTURE_DIR)
  assert.ok(validated.relativePaths.length > 10)
  assert.equal(validated.manifest.schemaVersion, PUBLIC_ARTIFACT_SCHEMA_VERSION)
  assert.equal(validated.manifest.artifactKind, 'public-ranking-manifest')
  assert.equal(validated.manifest.artifactMeta?.runId, PUBLIC_ARTIFACT_FIXTURE_RUN.runId)
})

test('browser artifacts stay compact and exclude full audit snapshots', async () => {
  const manifestPath = join(PUBLIC_ARTIFACT_FIXTURE_DIR, 'ranking-summary.json')
  const playersPath = join(PUBLIC_ARTIFACT_FIXTURE_DIR, 'entities/players.json')
  assert.ok((await stat(manifestPath)).size <= PUBLIC_ARTIFACT_BUDGETS.manifestBytes)
  assert.ok((await stat(playersPath)).size <= PUBLIC_ARTIFACT_BUDGETS.playersBytes)
  await assert.rejects(stat(join(PUBLIC_ARTIFACT_FIXTURE_DIR, 'ranking-snapshot.json')))
  await assert.rejects(stat(join(PUBLIC_ARTIFACT_FIXTURE_DIR, 'ranking-snapshot.full.json')))
})

test('manifest references schema-valid scope and entity companions with one provenance spine', async () => {
  const manifest = parsePublicRankingManifest(await json('ranking-summary.json'))
  const teams = parsePublicTeamDirectory(await json(dataPath(manifest.teamDirectoryUrl)))
  const players = parsePublicPlayerDirectory(await json(dataPath(manifest.playerDirectoryUrl)))
  assert.equal(teams.teamCount, teams.teams.length)
  assert.ok(Array.isArray(players.players))
  for (const [key, expected] of Object.entries(manifest.snapshotIndex)) {
    const shard = parsePublicRankingShard(await json(dataPath(expected.url)))
    assert.equal(shard.artifactMeta.runId, manifest.artifactMeta?.runId, key)
    assert.equal(shard.modelVersion, manifest.model.version, key)
    assert.equal(shard.modelConfigHash, manifest.model.configHash, key)
    assert.equal(shard.matchCount, expected.matchCount, key)
  }
})

test('team, region, and tournament history indexes resolve every referenced shard', async () => {
  const manifest = parsePublicRankingManifest(await json('ranking-summary.json'))
  const teamIndex = parsePublicTeamHistoryIndex(await json(dataPath(manifest.teamHistoryIndexUrl)))
  for (const [key, expected] of Object.entries(teamIndex.scopeIndex)) {
    const shard = parsePublicTeamHistoryShard(await json(dataPath(expected.url)))
    assert.equal(shard.teamCount, expected.teamCount, key)
    assert.equal(shard.pointCount, expected.pointCount, key)
  }
  const regions = parsePublicRegionHistory(await json(dataPath(manifest.regionHistoryUrl)))
  assert.ok(regions.scopes[regions.defaultScopeKey])
  const tournaments = parsePublicTournamentMovementIndex(await json(dataPath(manifest.tournamentMovementIndexUrl)))
  for (const expected of tournaments.tournaments) {
    const shard = parsePublicTournamentMovementShard(await json(dataPath(expected.url)))
    assert.equal(shard.id, expected.id)
    assert.equal(shard.artifactMeta.runId, manifest.artifactMeta?.runId)
  }
})

test('match history index, catalogs, and pages form a complete count-consistent graph', async () => {
  const manifest = parsePublicRankingManifest(await json('ranking-summary.json'))
  const index = parsePublicMatchHistoryIndex(await json(dataPath(manifest.matchHistoryIndexUrl)))
  for (const [key, expected] of Object.entries(index.scopeIndex)) {
    const catalog = parsePublicMatchHistoryCatalog(await json(dataPath(expected.url)))
    const pages = await Promise.all(catalog.pages.map(async (entry) => parsePublicMatchHistoryPage(await json(dataPath(entry.url)))))
    assert.equal(pages.reduce((sum, page) => sum + page.gameCount, 0), catalog.gameCount, key)
    assert.equal(catalog.pages.length, expected.pageCount, key)
    assert.ok(pages.every((page) => page.artifactMeta.runId === manifest.artifactMeta?.runId))
  }
})

function dataPath(url: string | undefined) {
  assert.ok(url?.startsWith('/data/'))
  return url.slice('/data/'.length).split('?', 1)[0]
}

async function json(relativePath: string) {
  return JSON.parse(await readFile(join(PUBLIC_ARTIFACT_FIXTURE_DIR, relativePath), 'utf8')) as unknown
}
