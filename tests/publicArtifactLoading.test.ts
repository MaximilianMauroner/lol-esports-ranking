import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fetchPublicSnapshotShard } from '../src/lib/publicArtifacts/resolver.ts'
import { parsePublicRankingManifest, parsePublicRankingShard } from '../src/lib/publicArtifacts/schema.ts'
import { createPublicRankingManifestLoader } from '../src/lib/publicArtifacts/manifestLoader.ts'
import {
  createPublicSemanticArtifact,
  fetchPublicArtifact,
  parsePublicArtifactGenerationManifest,
  registerGenerationContext,
  semanticArtifactIdentity,
  type PublicArtifactGenerationManifest,
  type PublicGenerationArtifactEntry,
  type PublicSemanticArtifact,
} from '../src/lib/publicArtifacts/artifactIdentity.ts'
import type { PublicRankingManifest, PublicRankingShard } from '../src/lib/publicArtifacts/schema.ts'

test('manifest loader deduplicates concurrent bootstrap and hook requests', async () => {
  const manifestJson = await readFile('public/data/ranking-summary.json', 'utf8')
  let requests = 0
  const loader = createPublicRankingManifestLoader('/data/ranking-summary.json', async () => {
    requests += 1
    return new Response(manifestJson)
  })

  const bootstrapRequest = loader()
  const hookRequest = loader()
  assert.equal(bootstrapRequest, hookRequest)
  const [bootstrapManifest, hookManifest] = await Promise.all([bootstrapRequest, hookRequest])

  assert.equal(requests, 1)
  assert.equal(bootstrapManifest, hookManifest)
})

test('manifest loader retries after a shared request rejects', async () => {
  const manifestJson = await readFile('public/data/ranking-summary.json', 'utf8')
  let requests = 0
  const loader = createPublicRankingManifestLoader('/data/ranking-summary.json', async () => {
    requests += 1
    return requests === 1 ? new Response(null, { status: 503 }) : new Response(manifestJson)
  })

  await assert.rejects(loader(), /Snapshot request failed with 503/)
  const manifest = await loader()

  assert.equal(requests, 2)
  assert.equal(manifest.artifactKind, 'public-ranking-manifest')
})

test('snapshot loading repairs a cached shard from an older publish', async () => {
  const manifest = parsePublicRankingManifest(JSON.parse(await readFile('public/data/ranking-summary.json', 'utf8')))
  const key = '2026__All__All'
  const expected = manifest.snapshotIndex[key]
  const shard = parsePublicRankingShard(JSON.parse(await readFile('public/data/scopes/season-2026.json', 'utf8')))
  const staleShard = { ...shard, matchCount: shard.matchCount - 1 }
  const requests: Array<{ url: string; cache?: string }> = []
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), cache: init?.cache })
    return new Response(JSON.stringify(requests.length === 1 ? staleShard : shard))
  }

  const loaded = await fetchPublicSnapshotShard(expected.url, key, expected, manifest, { fetcher })

  assert.equal(loaded.matchCount, expected.matchCount)
  assert.equal(requests.length, 2)
  assert.match(requests[1]?.url ?? '', /[?&]cache-repair=\d+$/)
  assert.equal(requests[1]?.cache, 'reload')
})

test('generation manifest loads semantic artifacts through the manifest loader and snapshot resolver', async () => {
  const fixture = await generationFixture()
  const requests: string[] = []
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url === '/data/generation.json') return jsonResponse(fixture.generation)
    if (url === fixture.rootEntry.objectUrl) return jsonResponse(fixture.rootSemantic)
    if (url === fixture.shardEntry.objectUrl) return jsonResponse(fixture.shardSemantic)
    return new Response(null, { status: 404 })
  }
  const loader = createPublicRankingManifestLoader('/data/generation.json', fetcher)
  const manifest = await loader()
  const key = '2026__All__All'
  const expected = manifest.snapshotIndex[key]
  const shard = await fetchPublicSnapshotShard(expected.url, key, expected, manifest, { fetcher })

  assert.equal(manifest.model.version, fixture.legacyManifest.model.version)
  assert.equal(shard.matchCount, fixture.legacyShard.matchCount)
  assert.deepEqual(requests, ['/data/generation.json', fixture.rootEntry.objectUrl, fixture.shardEntry.objectUrl])
})

test('semantic identity excludes volatile run metadata and uses deterministic key ordering', async () => {
  const legacy = JSON.parse(await readFile('public/data/scopes/season-2026.json', 'utf8')) as Record<string, unknown>
  const changedRun = {
    generatedAt: '2099-12-31T23:59:59.000Z',
    artifactMeta: {
      schemaVersion: 23,
      runId: 'run_different',
      generatedAt: '2099-12-31T23:59:59.000Z',
      modelVersion: 'different-run-label',
      modelConfigHash: 'different-run-config',
    },
    ...Object.fromEntries(Object.entries(legacy).reverse()),
  }
  changedRun.generatedAt = '2099-12-31T23:59:59.000Z'
  changedRun.artifactMeta = {
    schemaVersion: 23,
    runId: 'run_different',
    generatedAt: '2099-12-31T23:59:59.000Z',
    modelVersion: 'different-run-label',
    modelConfigHash: 'different-run-config',
  }

  const first = await semanticArtifactIdentity(createPublicSemanticArtifact(legacy))
  const second = await semanticArtifactIdentity(createPublicSemanticArtifact(changedRun))

  assert.deepEqual(second, first)
})

test('reader mapping canonicalizes double-encoded logical paths exactly once', async () => {
  for (const [logicalUrl, logicalPath] of [
    ['/data/%2520.json', '/data/%20.json'],
    ['/data/%252F.json', '/data/%2F.json'],
    ['/data/%252e%252e.json', '/data/%2e%2e.json'],
  ] as const) {
    const semantic = createPublicSemanticArtifact({ artifactKind: 'mapping-test', logicalUrl })
    const identity = await semanticArtifactIdentity(semantic)
    const generationId = 'generation-path-mapping'
    const objectUrl = `/objects/${identity.sha256}.json`
    const entry: PublicGenerationArtifactEntry = {
      logicalPath,
      objectUrl,
      generationId,
      sha256: identity.sha256,
      bytes: identity.bytes,
      encoding: 'identity',
    }
    const generation = parsePublicArtifactGenerationManifest({
      artifactKind: 'public-artifact-generation-manifest',
      schemaVersion: 1,
      generationId,
      runId: generationId,
      generatedAt: '2026-07-22T00:00:00.000Z',
      model: { version: 'mapping-test', configHash: 'mapping-test' },
      provenance: { source: 'test', dataMode: 'no-data', sourceProviders: [] },
      rootArtifact: logicalPath,
      artifacts: { [logicalPath]: entry },
    })
    const owner = {}
    registerGenerationContext(owner, generation, '/data/generation.json')
    let requested = ''
    const loaded = await fetchPublicArtifact(
      owner,
      logicalUrl,
      '/data/fallback.json',
      (value) => value as Record<string, unknown>,
      {
        fetcher: async (input) => {
          requested = String(input)
          return jsonResponse(semantic)
        },
      },
    )
    assert.equal(requested, objectUrl)
    assert.equal(loaded.logicalUrl, logicalUrl)
  }
})

test('generation manifest and semantic loading fail closed on integrity and generation errors', async () => {
  const fixture = await generationFixture()
  const mixedGeneration = structuredClone(fixture.generation)
  mixedGeneration.artifacts[fixture.shardEntry.logicalPath]!.generationId = 'generation-other'
  assert.throws(() => parsePublicArtifactGenerationManifest(mixedGeneration), /generationId/)

  const traversal = structuredClone(fixture.generation)
  const traversalEntry = traversal.artifacts[fixture.shardEntry.logicalPath]!
  traversalEntry.objectUrl = '/objects/%2e%2e/private.json'
  assert.throws(() => parsePublicArtifactGenerationManifest(traversal), /path traversal/)

  assert.throws(
    () => parsePublicArtifactGenerationManifest({ ...fixture.generation, schemaVersion: 999 }),
    /schemaVersion/,
  )

  const incomplete = structuredClone(fixture.generation)
  delete incomplete.artifacts[fixture.shardEntry.logicalPath]
  const incompleteLoader = createPublicRankingManifestLoader('/data/generation.json', generationFetcher(incomplete, fixture))
  await assert.rejects(incompleteLoader(), /mapping is incomplete/)

  const claimedGzip = structuredClone(fixture.generation)
  claimedGzip.artifacts[fixture.shardEntry.logicalPath]!.encoding = 'gzip'
  const claimedGzipFetcher = generationFetcher(claimedGzip, fixture)
  const claimedGzipManifest = await createPublicRankingManifestLoader('/data/generation.json', claimedGzipFetcher)()
  const claimedGzipExpected = claimedGzipManifest.snapshotIndex['2026__All__All']
  await assert.rejects(
    fetchPublicSnapshotShard(
      claimedGzipExpected.url,
      '2026__All__All',
      claimedGzipExpected,
      claimedGzipManifest,
      { fetcher: claimedGzipFetcher },
    ),
    /identity transport is not allowed/,
  )

  const missingStorageEncoding = structuredClone(fixture.generation)
  missingStorageEncoding.artifacts[fixture.rootEntry.logicalPath]!.transportEncodings = ['identity', 'gzip']
  assert.throws(() => parsePublicArtifactGenerationManifest(missingStorageEncoding), /storageEncoding is required/)

  const wrongModel = structuredClone(fixture.generation)
  wrongModel.model.version = 'wrong-model'
  const wrongModelLoader = createPublicRankingManifestLoader('/data/generation.json', generationFetcher(wrongModel, fixture))
  await assert.rejects(wrongModelLoader(), /model identity mismatch/)

  const badDigest = structuredClone(fixture.generation)
  badDigest.artifacts[fixture.shardEntry.logicalPath]!.sha256 = '0'.repeat(64)
  badDigest.artifacts[fixture.shardEntry.logicalPath]!.objectUrl = `/objects/${'0'.repeat(64)}.json`
  const badDigestFetcher = generationFetcher(badDigest, fixture)
  const badDigestManifest = await createPublicRankingManifestLoader('/data/generation.json', badDigestFetcher)()
  const key = '2026__All__All'
  await assert.rejects(
    fetchPublicSnapshotShard(
      badDigestManifest.snapshotIndex[key].url,
      key,
      badDigestManifest.snapshotIndex[key],
      badDigestManifest,
      { fetcher: badDigestFetcher },
    ),
    /semantic digest mismatch/,
  )
})

type GenerationFixture = {
  generation: PublicArtifactGenerationManifest
  legacyManifest: PublicRankingManifest
  legacyShard: PublicRankingShard
  rootSemantic: PublicSemanticArtifact
  shardSemantic: PublicSemanticArtifact
  rootEntry: PublicGenerationArtifactEntry
  shardEntry: PublicGenerationArtifactEntry
}

async function generationFixture(): Promise<GenerationFixture> {
  const legacyManifest = parsePublicRankingManifest(JSON.parse(await readFile('public/data/ranking-summary.json', 'utf8')))
  const legacyShard = parsePublicRankingShard(JSON.parse(await readFile('public/data/scopes/season-2026.json', 'utf8')))
  const rootSemantic = createPublicSemanticArtifact(legacyManifest)
  const shardSemantic = createPublicSemanticArtifact(legacyShard)
  const rootIdentity = await semanticArtifactIdentity(rootSemantic)
  const shardIdentity = await semanticArtifactIdentity(shardSemantic)
  const generationId = 'generation-test'
  const rootPath = '/data/ranking-summary.json'
  const shardPath = '/data/scopes/season-2026.json'
  const rootEntry = entry(rootPath, generationId, rootIdentity)
  const shardEntry = entry(shardPath, generationId, shardIdentity)
  const artifacts = Object.fromEntries(
    manifestUrls(legacyManifest).map((logicalPath, index) => [
      logicalPath,
      entry(logicalPath, generationId, { sha256: 'f'.repeat(64), bytes: index }),
    ]),
  )
  artifacts[rootPath] = rootEntry
  artifacts[shardPath] = shardEntry
  const generation = parsePublicArtifactGenerationManifest({
    artifactKind: 'public-artifact-generation-manifest',
    schemaVersion: 1,
    generationId,
    runId: legacyManifest.artifactMeta?.runId ?? 'run_test',
    generatedAt: legacyManifest.generatedAt,
    model: {
      version: legacyManifest.model.version,
      configHash: legacyManifest.model.configHash,
    },
    provenance: {
      source: legacyManifest.source,
      dataMode: legacyManifest.dataMode,
      sourceProviders: legacyManifest.sources.map((source) => source.name),
    },
    rootArtifact: rootPath,
    artifacts,
  })
  return { generation, legacyManifest, legacyShard, rootSemantic, shardSemantic, rootEntry, shardEntry }
}

function manifestUrls(manifest: PublicRankingManifest) {
  const values = [
    '/data/ranking-summary.json',
    manifest.playerDirectoryUrl,
    manifest.teamDirectoryUrl,
    manifest.teamHistoryIndexUrl,
    manifest.teamHistoryUrl,
    manifest.regionHistoryUrl,
    manifest.tournamentMovementIndexUrl,
    manifest.matchHistoryIndexUrl,
    ...Object.values(manifest.snapshotIndex).map((entry) => entry.url),
  ].filter((value): value is string => Boolean(value))
  return [...new Set(values.map((value) => new URL(value, 'https://fixture.invalid').pathname))]
}

function entry(
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
    encoding: 'identity',
  }
}

function generationFetcher(generation: PublicArtifactGenerationManifest, fixture: GenerationFixture): typeof fetch {
  return async (input) => {
    const url = String(input)
    if (url === '/data/generation.json') return jsonResponse(generation)
    if (url === generation.artifacts[fixture.rootEntry.logicalPath]?.objectUrl) return jsonResponse(fixture.rootSemantic)
    if (url === generation.artifacts[fixture.shardEntry.logicalPath]?.objectUrl) return jsonResponse(fixture.shardSemantic)
    return new Response(null, { status: 404 })
  }
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
}
