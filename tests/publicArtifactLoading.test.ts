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

test('generation-backed snapshot loading does not outer-retry abort, HTTP, or integrity failures', async (t) => {
  for (const scenario of ['abort', 'http', 'integrity'] as const) {
    await t.test(scenario, async () => {
      let targetRequests = 0
      const controller = new AbortController()
      const fixture = await generationBackedSnapshotFixture(async () => {
        targetRequests += 1
        if (scenario === 'abort') {
          controller.abort()
          throw new DOMException('Aborted', 'AbortError')
        }
        if (scenario === 'http') return new Response(null, { status: 403 })
        return jsonResponse(createPublicSemanticArtifact({ artifactKind: 'corrupt-generation-shard' }))
      })

      await assert.rejects(
        fetchPublicSnapshotShard(
          fixture.expected.url,
          fixture.snapshotKey,
          fixture.expected,
          fixture.manifest,
          { fetcher: fixture.fetcher, signal: controller.signal },
        ),
        scenario === 'abort' ? /Aborted/ : scenario === 'http' ? /403/ : /semantic digest mismatch/,
      )
      assert.equal(targetRequests, 1)
    })
  }
})

test('generation-backed network plus proxy failure makes exactly two requests', async () => {
  let targetRequests = 0
  const fixture = await generationBackedSnapshotFixture(async () => {
    targetRequests += 1
    if (targetRequests === 1) throw new TypeError('Failed to fetch')
    return new Response(null, { status: 503 })
  })

  await assert.rejects(
    fetchPublicSnapshotShard(
      fixture.expected.url,
      fixture.snapshotKey,
      fixture.expected,
      fixture.manifest,
      { fetcher: fixture.fetcher },
    ),
    /503/,
  )
  assert.equal(targetRequests, 2)
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
      storageEncoding: 'identity',
      transportEncodings: ['identity'],
    }
    const generation = parsePublicArtifactGenerationManifest({
      artifactKind: 'public-artifact-generation-manifest',
      schemaVersion: 2,
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
  claimedGzip.artifacts[fixture.shardEntry.logicalPath]!.transportEncodings = ['gzip']
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
  delete (missingStorageEncoding.artifacts[fixture.rootEntry.logicalPath] as { storageEncoding?: string }).storageEncoding
  assert.throws(() => parsePublicArtifactGenerationManifest(missingStorageEncoding), /storageEncoding/)

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

test('redirected immutable-object failures retry the original same-origin URL once through the proxy', async () => {
  const fixture = await presignedDeliveryFixture('v=generation-test&delivery=direct')
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const redirectedForbidden = redirectedErrorResponse(403)
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init })
    return requests.length === 1 ? redirectedForbidden : jsonResponse(fixture.semantic)
  }

  const loaded = await fetchPublicArtifact(fixture.owner, fixture.logicalPath, '/data/generation.json', recordParser, {
    fetcher,
    cache: 'no-cache',
  })

  assert.equal(requests.length, 2)
  assert.equal(requests[0]?.url, fixture.objectUrl)
  const proxyUrl = new URL(requests[1]?.url ?? '', 'https://same-origin.invalid')
  assert.equal(proxyUrl.pathname, `/data/objects/sha256/${fixture.identity.sha256}`)
  assert.equal(proxyUrl.searchParams.get('v'), 'generation-test')
  assert.equal(proxyUrl.searchParams.get('delivery'), 'proxy')
  assert.equal(requests[0]?.init?.cache, 'no-cache')
  assert.equal(requests[1]?.init?.cache, 'no-cache')
  assert.equal(new Headers(requests[1]?.init?.headers).get('Accept'), 'application/json')
  assert.equal((loaded.artifactMeta as Record<string, unknown>).runId, fixture.generation.runId)
})

test('immutable-object network rejection retries once, while proxy failure does not loop', async () => {
  const fixture = await presignedDeliveryFixture()
  const requests: string[] = []
  const fetcher: typeof fetch = async (input) => {
    requests.push(String(input))
    if (requests.length === 1) throw new TypeError('Failed to fetch')
    return new Response(null, { status: 503 })
  }

  await assert.rejects(
    fetchPublicArtifact(fixture.owner, fixture.logicalPath, '/data/generation.json', recordParser, { fetcher }),
    /503/,
  )
  assert.equal(requests.length, 2)
  assert.match(requests[1] ?? '', /[?&]delivery=proxy(?:&|$)/)
})

test('ordinary same-origin HTTP failures do not trigger proxy fallback', async () => {
  const fixture = await presignedDeliveryFixture()
  let requests = 0
  await assert.rejects(
    fetchPublicArtifact(fixture.owner, fixture.logicalPath, '/data/generation.json', recordParser, {
      fetcher: async () => {
        requests += 1
        return new Response(null, { status: 403 })
      },
    }),
    /403/,
  )
  assert.equal(requests, 1)
})

test('aborted immutable-object requests never retry through the proxy', async () => {
  const fixture = await presignedDeliveryFixture()
  const controller = new AbortController()
  controller.abort()
  let requests = 0
  const fetcher: typeof fetch = async () => {
    requests += 1
    throw new DOMException('Aborted', 'AbortError')
  }

  await assert.rejects(
    fetchPublicArtifact(fixture.owner, fixture.logicalPath, '/data/generation.json', recordParser, {
      fetcher,
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  )
  assert.equal(requests, 1)
})

test('direct and proxy immutable delivery share hydration and digest validation', async () => {
  const direct = await presignedDeliveryFixture()
  const proxied = await presignedDeliveryFixture()
  const directLoaded = await fetchPublicArtifact(
    direct.owner,
    direct.logicalPath,
    '/data/generation.json',
    recordParser,
    { fetcher: async () => jsonResponse(direct.semantic) },
  )
  let proxyRequests = 0
  const proxyLoaded = await fetchPublicArtifact(
    proxied.owner,
    proxied.logicalPath,
    '/data/generation.json',
    recordParser,
    {
      fetcher: async () => {
        proxyRequests += 1
        return proxyRequests === 1 ? redirectedErrorResponse(403) : jsonResponse(proxied.semantic)
      },
    },
  )
  assert.deepEqual(proxyLoaded, directLoaded)

  const corrupt = await presignedDeliveryFixture()
  let corruptRequests = 0
  await assert.rejects(
    fetchPublicArtifact(corrupt.owner, corrupt.logicalPath, '/data/generation.json', recordParser, {
      fetcher: async () => {
        corruptRequests += 1
        return corruptRequests === 1
          ? redirectedErrorResponse(403)
          : jsonResponse(createPublicSemanticArtifact({ artifactKind: 'corrupt-proxy-content' }))
      },
    }),
    /semantic digest mismatch/,
  )
  assert.equal(corruptRequests, 2)
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

async function presignedDeliveryFixture(query = '') {
  const fixture = await generationFixture()
  const generationSource = structuredClone(fixture.generation)
  const root = generationSource.artifacts[fixture.rootEntry.logicalPath]!
  root.objectUrl = `/data/objects/sha256/${root.sha256}${query ? `?${query}` : ''}`
  root.encoding = 'gzip'
  root.storageEncoding = 'gzip'
  root.transportEncodings = ['identity', 'gzip']
  const generation = parsePublicArtifactGenerationManifest(generationSource)
  const owner = {}
  registerGenerationContext(owner, generation, '/data/generation.json')
  return {
    owner,
    generation,
    logicalPath: fixture.rootEntry.logicalPath,
    objectUrl: root.objectUrl,
    semantic: fixture.rootSemantic,
    identity: await semanticArtifactIdentity(fixture.rootSemantic),
  }
}

async function generationBackedSnapshotFixture(targetResponse: () => Promise<Response>) {
  const fixture = await generationFixture()
  const generationSource = structuredClone(fixture.generation)
  for (const logicalPath of [fixture.rootEntry.logicalPath, fixture.shardEntry.logicalPath]) {
    const artifact = generationSource.artifacts[logicalPath]!
    artifact.objectUrl = `/data/objects/sha256/${artifact.sha256}`
    artifact.encoding = 'gzip'
    artifact.storageEncoding = 'gzip'
    artifact.transportEncodings = ['identity', 'gzip']
  }
  const generation = parsePublicArtifactGenerationManifest(generationSource)
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    if (url === '/data/generation.json') return jsonResponse(generation)
    if (url === generation.artifacts[fixture.rootEntry.logicalPath]?.objectUrl) return jsonResponse(fixture.rootSemantic)
    const targetUrl = generation.artifacts[fixture.shardEntry.logicalPath]?.objectUrl
    if (url === targetUrl || url.startsWith(`${targetUrl}?`)) return targetResponse()
    return new Response(null, { status: 404 })
  }
  const manifest = await createPublicRankingManifestLoader('/data/generation.json', fetcher)()
  const snapshotKey = '2026__All__All'
  return { manifest, snapshotKey, expected: manifest.snapshotIndex[snapshotKey], fetcher }
}

function recordParser(value: unknown) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

function redirectedErrorResponse(status: number) {
  const response = new Response(null, { status })
  Object.defineProperty(response, 'redirected', { value: true })
  return response
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
    schemaVersion: 2,
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
    storageEncoding: 'identity',
    transportEncodings: ['identity'],
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
