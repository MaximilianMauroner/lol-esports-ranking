import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import {
  assertGenerationMapping,
  createPublicSemanticArtifact,
  fetchPublicArtifact,
  parsePublicArtifactGenerationManifest,
  registerGenerationContext,
  semanticArtifactIdentity,
  type PublicArtifactEncoding,
  type PublicGenerationArtifactEntry,
  type PublicSemanticArtifact,
} from '../src/lib/publicArtifacts/artifactIdentity.ts'
import { createPublicRankingManifestLoader } from '../src/lib/publicArtifacts/manifestLoader.ts'
import { fetchPublicSnapshotShard, validatePublicTeamHistoryShard, validatePublicTournamentMovementIndex, validatePublicTournamentMovementShard } from '../src/lib/publicArtifacts/resolver.ts'
import {
  parsePublicMatchHistoryCatalog,
  parsePublicMatchHistoryIndex,
  parsePublicMatchHistoryPage,
  parsePublicPlayerDirectory,
  parsePublicRankingManifest,
  parsePublicRankingShard,
  parsePublicRegionHistory,
  parsePublicTeamHistoryIndex,
  parsePublicTeamHistoryShard,
  parsePublicTournamentMovementIndex,
  parsePublicTournamentMovementShard,
  type PublicRankingManifest,
} from '../src/lib/publicArtifacts/schema.ts'

test('known logical URL fields have run identity normalized for every index family', async () => {
  const families = [
    (runId: string, target = 'players.json', locale = 'en') => ({
      artifactKind: 'public-ranking-manifest',
      schemaVersion: 23,
      generatedAt: generatedAtFor(runId),
      artifactMeta: artifactMeta(runId),
      playerDirectoryUrl: `/data/entities/${target}?locale=${locale}&v=${runId}`,
      tournamentMovementIndexUrl: `/data/history/tournament-moves/index.json?v=${runId}`,
      snapshotIndex: { All__All__All: { url: `/data/scopes/all.json?v=${runId}&locale=${locale}` } },
    }),
    (runId: string, target = 'All__All__All.json') => ({
      artifactKind: 'team-history-index', schemaVersion: 23, generatedAt: generatedAtFor(runId), artifactMeta: artifactMeta(runId),
      scopeIndex: { All__All__All: { url: `/data/history/team-series/${target}?v=${runId}` } },
    }),
    (runId: string, target = 'ewc-2026.json') => ({
      artifactKind: 'tournament-movement-index', schemaVersion: 23, generatedAt: generatedAtFor(runId), artifactMeta: artifactMeta(runId),
      tournaments: [{ url: `/data/history/tournament-moves/${target}?v=${runId}` }],
    }),
    (runId: string, target = 'all.json') => ({
      artifactKind: 'match-history-index', schemaVersion: 23, generatedAt: generatedAtFor(runId), artifactMeta: artifactMeta(runId),
      scopeIndex: { All__All__All: {
        url: `/data/matches/${target}?v=${runId}`,
        pages: [{ url: `/data/matches/pages/${target.replace('.json', '-1.json')}?v=${runId}` }],
      } },
    }),
    (runId: string, target = 'all-1.json') => ({
      artifactKind: 'match-history-catalog', schemaVersion: 23, generatedAt: generatedAtFor(runId), artifactMeta: artifactMeta(runId),
      pages: [{ url: `/data/matches/pages/${target}?v=${runId}` }],
    }),
    (runId: string, target = 'All') => ({
      artifactKind: 'region-history', schemaVersion: 23, generatedAt: generatedAtFor(runId), artifactMeta: artifactMeta(runId),
      scopes: { [target]: { pointCount: 0 } },
    }),
  ]

  for (const createFamily of families) {
    const first = await identityFor(createFamily('run_one'))
    const second = await identityFor(createFamily('run_two'))
    const changedTarget = await identityFor(createFamily('run_two', 'changed-target.json'))
    assert.deepEqual(second, first, `${createFamily('run_one').artifactKind} retained volatile run identity`)
    assert.notDeepEqual(changedTarget, first, `${createFamily('run_one').artifactKind} ignored a semantic target change`)
  }

  const localeEn = await identityFor(families[0]('run_one', 'players.json', 'en'))
  const localeKo = await identityFor(families[0]('run_two', 'players.json', 'ko'))
  assert.notDeepEqual(localeKo, localeEn, 'semantic query parameters must remain part of identity')

  const externalSourceA = await identityFor(matchPageWithSource('run_one', 'https://source.example/game?v=one'))
  const externalSourceB = await identityFor(matchPageWithSource('run_two', 'https://source.example/game?v=two'))
  assert.notDeepEqual(externalSourceB, externalSourceA, 'non-logical source URLs must not be broadly rewritten')
})

test('gzip transport is decoded by fetch and verified against canonical uncompressed semantic JSON', async (t) => {
  const source = artifactSource('gzip-run')
  const semantic = createPublicSemanticArtifact(source)
  const identity = await semanticArtifactIdentity(semantic)
  const logicalPath = '/data/example.json'
  const compressed = gzipSync(JSON.stringify(semantic))
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/objects/')) {
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Encoding',
        'Content-Encoding': 'gzip',
        'Content-Type': 'application/json',
      })
      response.end(compressed)
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const objectUrl = `http://127.0.0.1:${address.port}/objects/${identity.sha256}.json`
  const generation = generationFor(logicalPath, identity, 'gzip', objectUrl)
  registerGenerationContext(generation, generation, `http://127.0.0.1:${address.port}/generation.json`)

  const loaded = await fetchPublicArtifact(generation, logicalPath, '/data/generation.json', parseObject)

  assert.equal(loaded.artifactKind, source.artifactKind)
  assert.equal(loaded.generatedAt, generation.generatedAt)
  assert.equal(generation.artifacts[logicalPath].bytes, identity.bytes)
})

test('transport encoding mismatches and non-decoded gzip fail closed', async () => {
  const source = artifactSource('transport-run')
  const semantic = createPublicSemanticArtifact(source)
  const identity = await semanticArtifactIdentity(semantic)
  const logicalPath = '/data/example.json'

  for (const [label, encoding, response, message] of [
    ['missing CORS-visible header', 'gzip', jsonResponse(semantic), /identity transport is not allowed for \/data\/example\.json/],
    ['wrong gzip header', 'gzip', jsonResponse(semantic, { 'Content-Encoding': 'br' }), /unsupported Content-Encoding br for \/data\/example\.json/],
    ['unexpected identity encoding', 'identity', jsonResponse(semantic, { 'Content-Encoding': 'gzip' }), /gzip transport is not allowed for \/data\/example\.json/],
    ['gzip bytes not decoded by fetch', 'gzip', new Response(gzipSync(JSON.stringify(semantic)), { headers: { 'Content-Encoding': 'gzip' } }), /gzip transport was not decoded by fetch for \/data\/example\.json/],
  ] as const) {
    const generation = generationFor(logicalPath, identity, encoding, `/objects/${identity.sha256}.json`)
    registerGenerationContext(generation, generation, '/data/generation.json')
    await assert.rejects(
      fetchPublicArtifact(generation, logicalPath, '/data/generation.json', parseObject, { fetcher: async () => response.clone() }),
      message,
      label,
    )
  }
})

test('generation context loads every lazy public artifact family through production reader boundaries', async () => {
  const fixture = await completeGenerationFixture()
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    if (url === '/data/generation.json') return jsonResponse(fixture.generation)
    const semantic = fixture.semanticByObjectUrl.get(url)
    return semantic ? jsonResponse(semantic) : new Response(null, { status: 404 })
  }
  const manifest = await createPublicRankingManifestLoader('/data/generation.json', fetcher)()
  const key = manifest.defaultSnapshotKey
  const snapshotExpected = manifest.snapshotIndex[key]
  const snapshot = await fetchPublicSnapshotShard(snapshotExpected.url, key, snapshotExpected, manifest, { fetcher })

  const players = await fetchPublicArtifact(manifest, manifest.playerDirectoryUrl!, '/data/generation.json', parsePublicPlayerDirectory, { fetcher })
  const teamIndex = await fetchPublicArtifact(manifest, manifest.teamHistoryIndexUrl!, '/data/generation.json', parsePublicTeamHistoryIndex, { fetcher })
  Object.values(teamIndex.scopeIndex).forEach((entry) => assertGenerationMapping(teamIndex, entry.url))
  const teamExpected = teamIndex.scopeIndex[key]
  const teamShard = await fetchPublicArtifact(teamIndex, teamExpected.url, '/data/generation.json', parsePublicTeamHistoryShard, { fetcher })
  validatePublicTeamHistoryShard(key, teamExpected, teamShard, teamIndex)

  const regions = await fetchPublicArtifact(manifest, manifest.regionHistoryUrl!, '/data/generation.json', parsePublicRegionHistory, { fetcher })
  const tournamentIndex = await fetchPublicArtifact(manifest, manifest.tournamentMovementIndexUrl, '/data/generation.json', parsePublicTournamentMovementIndex, { fetcher })
  validatePublicTournamentMovementIndex(tournamentIndex, manifest)
  tournamentIndex.tournaments.forEach((entry) => assertGenerationMapping(tournamentIndex, entry.url))
  const tournamentExpected = tournamentIndex.tournaments[0]
  const tournament = await fetchPublicArtifact(tournamentIndex, tournamentExpected.url, '/data/generation.json', parsePublicTournamentMovementShard, { fetcher })
  validatePublicTournamentMovementShard(tournamentExpected, tournament, tournamentIndex)

  const matchIndex = await fetchPublicArtifact(manifest, manifest.matchHistoryIndexUrl!, '/data/generation.json', parsePublicMatchHistoryIndex, { fetcher })
  Object.values(matchIndex.scopeIndex).forEach((entry) => assertGenerationMapping(matchIndex, entry.url))
  const matchExpected = matchIndex.scopeIndex[key]
  const catalog = await fetchPublicArtifact(matchIndex, matchExpected.url, '/data/generation.json', parsePublicMatchHistoryCatalog, { fetcher })
  catalog.pages.forEach((entry) => assertGenerationMapping(catalog, entry.url))
  const matchPage = await fetchPublicArtifact(catalog, catalog.pages[0].url, '/data/generation.json', parsePublicMatchHistoryPage, { fetcher })

  assert.equal(snapshot.artifactKind, 'public-snapshot-shard')
  assert.equal(players.artifactKind, 'player-directory')
  assert.equal(teamShard.artifactKind, 'team-history-scope')
  assert.equal(regions.artifactKind, 'region-history')
  assert.equal(tournament.artifactKind, 'tournament-movement')
  assert.equal(catalog.artifactKind, 'match-history-catalog')
  assert.equal(matchPage.artifactKind, 'match-history-page')
})

async function completeGenerationFixture() {
  const root = parsePublicRankingManifest(await readPublicArtifact('/data/ranking-summary.json'))
  const key = root.defaultSnapshotKey
  const teamIndex = parsePublicTeamHistoryIndex(await readPublicArtifact(root.teamHistoryIndexUrl!))
  const tournamentIndex = parsePublicTournamentMovementIndex(await readPublicArtifact(root.tournamentMovementIndexUrl))
  const matchIndex = parsePublicMatchHistoryIndex(await readPublicArtifact(root.matchHistoryIndexUrl!))
  const catalog = parsePublicMatchHistoryCatalog(await readPublicArtifact(matchIndex.scopeIndex[key].url))
  const selected: Array<[string, object]> = [
    ['/data/ranking-summary.json', root],
    [root.snapshotIndex[key].url, parsePublicRankingShard(await readPublicArtifact(root.snapshotIndex[key].url))],
    [root.playerDirectoryUrl!, parsePublicPlayerDirectory(await readPublicArtifact(root.playerDirectoryUrl!))],
    [root.teamHistoryIndexUrl!, teamIndex],
    [teamIndex.scopeIndex[key].url, parsePublicTeamHistoryShard(await readPublicArtifact(teamIndex.scopeIndex[key].url))],
    [root.regionHistoryUrl!, parsePublicRegionHistory(await readPublicArtifact(root.regionHistoryUrl!))],
    [root.tournamentMovementIndexUrl, tournamentIndex],
    [tournamentIndex.tournaments[0].url, parsePublicTournamentMovementShard(await readPublicArtifact(tournamentIndex.tournaments[0].url))],
    [root.matchHistoryIndexUrl!, matchIndex],
    [matchIndex.scopeIndex[key].url, catalog],
    [catalog.pages[0].url, parsePublicMatchHistoryPage(await readPublicArtifact(catalog.pages[0].url))],
  ]
  const generationId = 'generation-complete'
  const artifacts: Record<string, PublicGenerationArtifactEntry> = {}
  const semanticByObjectUrl = new Map<string, PublicSemanticArtifact>()
  const logicalUrls = [
    ...rootLogicalUrls(root),
    ...Object.values(teamIndex.scopeIndex).map((entry) => entry.url),
    ...tournamentIndex.tournaments.map((entry) => entry.url),
    ...Object.values(matchIndex.scopeIndex).map((entry) => entry.url),
    ...catalog.pages.map((entry) => entry.url),
  ]
  logicalUrls.forEach((url, index) => {
    const logicalPath = pathFor(url)
    artifacts[logicalPath] = artifactEntry(logicalPath, generationId, { sha256: `${index}`.padStart(64, 'a').slice(-64), bytes: 0 })
  })
  for (const [url, value] of selected) {
    const logicalPath = pathFor(url)
    const semantic = createPublicSemanticArtifact(value)
    const identity = await semanticArtifactIdentity(semantic)
    const entry = artifactEntry(logicalPath, generationId, identity)
    artifacts[logicalPath] = entry
    semanticByObjectUrl.set(entry.objectUrl, semantic)
  }
  const generation = parsePublicArtifactGenerationManifest({
    artifactKind: 'public-artifact-generation-manifest',
    schemaVersion: 2,
    generationId,
    runId: root.artifactMeta!.runId,
    generatedAt: root.generatedAt,
    model: { version: root.model.version, configHash: root.model.configHash },
    provenance: {
      source: root.source,
      dataMode: root.dataMode,
      sourceProviders: root.sources.map((source) => source.name),
    },
    rootArtifact: '/data/ranking-summary.json',
    artifacts,
  })
  return { generation, semanticByObjectUrl }
}

function rootLogicalUrls(manifest: PublicRankingManifest) {
  return [
    '/data/ranking-summary.json',
    manifest.fullSnapshotUrl,
    manifest.playerDirectoryUrl,
    manifest.teamDirectoryUrl,
    manifest.teamHistoryIndexUrl,
    manifest.regionHistoryUrl,
    manifest.tournamentMovementIndexUrl,
    manifest.matchHistoryIndexUrl,
    ...Object.values(manifest.snapshotIndex).map((entry) => entry.url),
  ].filter((value): value is string => Boolean(value))
}

async function readPublicArtifact(url: string) {
  return JSON.parse(await readFile(`public${pathFor(url)}`, 'utf8')) as unknown
}

function pathFor(url: string) {
  return new URL(url, 'https://fixture.invalid').pathname
}

function artifactEntry(
  logicalPath: string,
  generationId: string,
  identity: { sha256: string; bytes: number },
): PublicGenerationArtifactEntry {
  return {
    logicalPath,
    objectUrl: `/objects/${identity.sha256}.json`,
    generationId,
    sha256: identity.sha256,
    bytes: identity.bytes,
    encoding: 'identity' as const,
    storageEncoding: 'identity' as const,
    transportEncodings: ['identity'],
  }
}

function artifactSource(runId: string) {
  return {
    artifactKind: 'example-public-artifact',
    schemaVersion: 23,
    generatedAt: generatedAtFor(runId),
    artifactMeta: artifactMeta(runId),
    value: { stable: true },
  }
}

function generationFor(
  logicalPath: string,
  identity: { sha256: string; bytes: number },
  encoding: PublicArtifactEncoding,
  objectUrl: string,
) {
  const generationId = 'generation-transport'
  return parsePublicArtifactGenerationManifest({
    artifactKind: 'public-artifact-generation-manifest',
    schemaVersion: 2,
    generationId,
    runId: 'run_transport',
    generatedAt: generatedAtFor('transport'),
    model: { version: 'test-model', configHash: 'test-config' },
    provenance: { source: 'test source', dataMode: 'no-data', sourceProviders: ['test'] },
    rootArtifact: logicalPath,
    artifacts: {
      [logicalPath]: {
        logicalPath,
        objectUrl,
        generationId,
        ...identity,
        encoding,
        storageEncoding: encoding,
        transportEncodings: [encoding],
      },
    },
  })
}

function matchPageWithSource(runId: string, sourceUrl: string) {
  return {
    artifactKind: 'match-history-page',
    schemaVersion: 23,
    generatedAt: generatedAtFor(runId),
    artifactMeta: artifactMeta(runId),
    matches: [{ source: { url: sourceUrl } }],
  }
}

function generatedAtFor(runId: string) {
  return runId.endsWith('one') ? '2026-01-01T00:00:00.000Z' : '2026-02-01T00:00:00.000Z'
}

function artifactMeta(runId: string) {
  return { schemaVersion: 23, runId, generatedAt: generatedAtFor(runId), modelVersion: 'test-model', modelConfigHash: 'test-config' }
}

async function identityFor(value: object) {
  return semanticArtifactIdentity(createPublicSemanticArtifact(value))
}

function parseObject(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

function jsonResponse(value: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', ...headers } })
}
