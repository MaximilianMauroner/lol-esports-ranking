import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { canonicalJsonFor, canonicalPublicLogicalPath, createGenerationManifest, prepareSemanticArtifact } from '../scripts/public-artifact-storage.mjs'
import { createGenerationPublicationReceipt, publicationReceiptBytes } from '../scripts/generation-publication.mjs'
import { createPublicRankingManifestLoader } from '../src/lib/publicArtifacts/manifestLoader.ts'
import { fetchPublicSnapshotShard } from '../src/lib/publicArtifacts/resolver.ts'
import { parsePublicRankingManifest } from '../src/lib/publicArtifacts/schema.ts'

test('Railway server returns app shell only for known app routes', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-server-'))
  const distDir = join(tempDir, 'dist')
  const dataDir = join(tempDir, 'data')
  await mkdir(distDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(distDir, 'index.html'), '<!doctype html><div id="root">app shell</div>\n')
  await writeFile(join(distDir, 'llms.txt'), '# LoL Esports Power Index\n')

  const server = await startRailwayServer(distDir, dataDir)
  try {
    const live = await httpRequest(server.port, '/api/live')
    assert.equal(live.statusCode, 200)
    assert.equal(JSON.parse(live.body).ok, true)

    const notReady = await httpRequest(server.port, '/api/ready')
    assert.equal(notReady.statusCode, 503)
    await writeFile(join(dataDir, 'ranking-summary.json'), '{}\n')
    const ready = await httpRequest(server.port, '/api/ready')
    assert.equal(ready.statusCode, 200)
    assert.equal(JSON.parse(ready.body).data, 'local')

    const scheduler = await httpRequest(server.port, '/api/scheduler')
    assert.equal(scheduler.statusCode, 200)
    assert.equal(JSON.parse(scheduler.body).ok, false)

    const root = await httpRequest(server.port, '/')
    assert.equal(root.statusCode, 200)
    assert.equal(root.headers['cache-control'], 'no-store')
    assert.match(root.body, /app shell/)

    const teams = await httpRequest(server.port, '/teams')
    assert.equal(teams.statusCode, 200)
    assert.equal(teams.headers['cache-control'], 'no-store')
    assert.match(teams.body, /app shell/)

    const regions = await httpRequest(server.port, '/regions')
    assert.equal(regions.statusCode, 200)
    assert.match(regions.body, /app shell/)

    const llms = await httpRequest(server.port, '/llms.txt')
    assert.equal(llms.statusCode, 200)
    assert.match(llms.body, /^# LoL Esports Power Index/m)

    const missing = await httpRequest(server.port, '/__definitely_missing_test_path_20260709', {
      headers: { accept: 'text/html' },
    })
    assert.equal(missing.statusCode, 404)
    assert.equal(missing.headers['x-robots-tag'], 'noindex')
    assert.match(missing.body, /<h1>Not found<\/h1>/)
    assert.doesNotMatch(missing.body, /app shell/)

    const missingAsset = await httpRequest(server.port, '/missing.js')
    assert.equal(missingAsset.statusCode, 404)
    assert.equal(missingAsset.headers['x-robots-tag'], 'noindex')
    assert.doesNotMatch(missingAsset.body, /app shell/)
  } finally {
    await server.close()
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('Railway server prefers refreshed bucket data over its bundled snapshot', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-server-'))
  const distDir = join(tempDir, 'dist')
  const dataDir = join(tempDir, 'data')
  await mkdir(distDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(distDir, 'index.html'), '<!doctype html><div id="root">app shell</div>\n')
  await writeFile(join(dataDir, 'ranking-summary.json'), JSON.stringify({ source: 'bundled' }))

  const bucket = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    if (pathname === '/test-bucket/rankings/active-generation.json') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ generationId: 'fresh' }))
      return
    }
    if (pathname === '/test-bucket/rankings/generations/fresh/data/ranking-summary.json') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ source: 'bucket' }))
      return
    }
    response.statusCode = 404
    response.end()
  })
  await new Promise<void>((resolve) => bucket.listen(0, '127.0.0.1', resolve))
  const bucketPort = (bucket.address() as AddressInfo).port

  const server = await startRailwayServer(distDir, dataDir, {
    RANKING_BUCKET_NAME: 'test-bucket',
    RANKING_BUCKET_ENDPOINT: `http://127.0.0.1:${bucketPort}`,
    RANKING_BUCKET_ACCESS_KEY_ID: 'test',
    RANKING_BUCKET_SECRET_ACCESS_KEY: 'test',
    RANKING_BUCKET_FORCE_PATH_STYLE: 'true',
  })
  try {
    const response = await httpRequest(server.port, '/data/ranking-summary.json')
    assert.equal(response.statusCode, 200)
    assert.equal(JSON.parse(response.body).source, 'bucket')
  } finally {
    await server.close()
    await new Promise<void>((resolve, reject) => bucket.close((error) => error ? reject(error) : resolve()))
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('Railway server reuses its verified root cache and invalidates it when the active ETag changes', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-server-cache-'))
  const distDir = join(tempDir, 'dist')
  const dataDir = join(tempDir, 'data')
  await mkdir(distDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(distDir, 'index.html'), '<!doctype html><div id="root">app shell</div>\n')

  const generationId = 'server-root-cache'
  const rootManifest = {
    artifactKind: 'public-ranking-manifest',
    schemaVersion: 23,
    generatedAt: '2026-07-23T00:00:00.000Z',
    source: 'production-shaped-server-test',
    sources: [{ name: 'fixture' }],
    dataMode: 'scheduled-public-data',
    model: { version: 'model-v1', configHash: 'config-v1' },
    artifactMeta: { runId: generationId },
    coverage: { sourceProviders: ['fixture'] },
  }
  const preparedRoot = prepareSemanticArtifact(rootManifest)
  const manifest = createGenerationManifest({
    generationId,
    rootManifest,
    entries: [{
      logicalPath: '/data/ranking-summary.json',
      digest: preparedRoot.digest,
      bytes: preparedRoot.bytes,
    }],
  })
  const manifestBody = Buffer.from(canonicalJsonFor(manifest))
  const manifestDigest = createHash('sha256').update(manifestBody).digest('hex')
  const manifestEtag = '"manifest-etag"'
  const rawDigest = 'b'.repeat(64)
  const receipt = createGenerationPublicationReceipt({
    generationId,
    preparedAt: '2026-07-23T00:00:00.000Z',
    prefix: 'rankings',
    fencingToken: 1,
    leaseOwner: 'server-cache-fixture',
    promotionEtag: '"promotion-etag"',
    provenance: {
      modelVersion: rootManifest.model.version,
      modelConfigHash: rootManifest.model.configHash,
      source: rootManifest.source,
      dataMode: rootManifest.dataMode,
      sourceProviders: rootManifest.coverage.sourceProviders,
    },
    authorities: {
      publicManifest: {
        key: `rankings/generations/${generationId}/manifest.json`,
        digest: manifestDigest,
        bytes: manifestBody.byteLength,
      },
      rawReceipt: {
        key: `rankings/raw/objects/sha256/${rawDigest}`,
        digest: rawDigest,
        bytes: 123,
      },
    },
    objects: [
      {
        key: `rankings/generations/${generationId}/manifest.json`,
        digest: manifestDigest,
        bytes: manifestBody.byteLength,
        outcome: 'uploaded',
      },
      {
        key: `rankings/objects/sha256/${preparedRoot.digest}`,
        digest: preparedRoot.digest,
        bytes: preparedRoot.compressedBytes,
        outcome: 'uploaded',
      },
      {
        key: `rankings/raw/objects/sha256/${rawDigest}`,
        digest: rawDigest,
        bytes: 123,
        outcome: 'uploaded',
      },
    ],
  })
  const preparedReceipt = publicationReceiptBytes(receipt)
  const receiptEtag = '"receipt-etag"'
  const activeBody = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    generationId,
    fencingToken: 1,
    promotedAt: '2026-07-23T00:00:00.000Z',
    manifestKey: `rankings/generations/${generationId}/manifest.json`,
    publicManifestSchemaVersion: 2,
    storageMode: 'content-addressed-gzip-v1',
    manifestDigest,
    manifestBytes: manifestBody.byteLength,
    manifestEtag,
    rawReceiptKey: `rankings/raw/objects/sha256/${rawDigest}`,
    rawReceiptDigest: rawDigest,
    rawReceiptBytes: 100,
    rawReceiptCompressedBytes: 123,
    sourceReceiptDigest: 'c'.repeat(64),
    rawIdentityDigest: 'd'.repeat(64),
    publicationSchemaVersion: 1,
    publicationReceiptKey: `rankings/generations/${generationId}/publish.json`,
    publicationReceiptDigest: preparedReceipt.digest,
    publicationReceiptBytes: preparedReceipt.bytes,
    publicationReceiptEtag: receiptEtag,
  }))
  let activeEtag = '"active-etag-1"'
  const bucketReads: string[] = []
  const bucket = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    bucketReads.push(pathname)
    const sendObject = (
      body: Buffer,
      {
        etag,
        contentType = 'application/json; charset=utf-8',
        contentEncoding,
        metadata = {},
      }: {
        etag: string
        contentType?: string
        contentEncoding?: string
        metadata?: Record<string, string>
      },
    ) => {
      response.setHeader('ETag', etag)
      response.setHeader('Content-Type', contentType)
      response.setHeader('Content-Length', String(body.byteLength))
      if (contentEncoding) response.setHeader('Content-Encoding', contentEncoding)
      for (const [key, value] of Object.entries(metadata)) response.setHeader(`x-amz-meta-${key}`, value)
      response.end(body)
    }
    if (pathname === '/test-bucket/rankings/active-generation.json') {
      sendObject(activeBody, { etag: activeEtag })
    } else if (pathname === `/test-bucket/rankings/generations/${generationId}/publish.json`) {
      sendObject(preparedReceipt.body, {
        etag: receiptEtag,
        metadata: { sha256: preparedReceipt.digest, 'semantic-bytes': String(preparedReceipt.bytes) },
      })
    } else if (pathname === `/test-bucket/rankings/generations/${generationId}/manifest.json`) {
      sendObject(manifestBody, {
        etag: manifestEtag,
        metadata: { sha256: manifestDigest, 'semantic-bytes': String(manifestBody.byteLength) },
      })
    } else if (pathname === `/test-bucket/rankings/objects/sha256/${preparedRoot.digest}`) {
      sendObject(preparedRoot.compressed, {
        etag: '"root-etag"',
        contentEncoding: 'gzip',
        metadata: {
          sha256: preparedRoot.digest,
          'semantic-bytes': String(preparedRoot.bytes),
          encoding: 'gzip',
        },
      })
    } else {
      response.statusCode = 404
      response.end()
    }
  })
  await new Promise<void>((resolve) => bucket.listen(0, '127.0.0.1', resolve))
  const bucketPort = (bucket.address() as AddressInfo).port
  const server = await startRailwayServer(distDir, dataDir, {
    RANKING_BUCKET_NAME: 'test-bucket',
    RANKING_BUCKET_ENDPOINT: `http://127.0.0.1:${bucketPort}`,
    RANKING_BUCKET_ACCESS_KEY_ID: 'test',
    RANKING_BUCKET_SECRET_ACCESS_KEY: 'test',
    RANKING_BUCKET_FORCE_PATH_STYLE: 'true',
  })
  try {
    const expectedInitialReads = [
      '/test-bucket/rankings/active-generation.json',
      `/test-bucket/rankings/generations/${generationId}/publish.json`,
      `/test-bucket/rankings/generations/${generationId}/manifest.json`,
      `/test-bucket/rankings/objects/sha256/${preparedRoot.digest}`,
    ]
    const first = await httpRequest(server.port, '/data/ranking-summary.json')
    assert.equal(first.statusCode, 200)
    assert.deepEqual(bucketReads, expectedInitialReads)

    const second = await httpRequest(server.port, '/data/ranking-summary.json')
    assert.equal(second.statusCode, 200)
    assert.deepEqual(bucketReads.slice(4), ['/test-bucket/rankings/active-generation.json'])

    activeEtag = '"active-etag-2"'
    const third = await httpRequest(server.port, '/data/ranking-summary.json')
    assert.equal(third.statusCode, 200)
    assert.deepEqual(bucketReads.slice(5), expectedInitialReads)
  } finally {
    await server.close()
    await new Promise<void>((resolve, reject) => bucket.close((error) => error ? reject(error) : resolve()))
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('Railway server serves versioned data from the requested bucket generation', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-server-'))
  const distDir = join(tempDir, 'dist')
  const dataDir = join(tempDir, 'data')
  await mkdir(distDir, { recursive: true })
  await mkdir(join(dataDir, 'history', 'tournament-moves'), { recursive: true })
  await writeFile(join(distDir, 'index.html'), '<!doctype html><div id="root">app shell</div>\n')
  await writeFile(join(dataDir, 'history', 'tournament-moves', 'index.json'), JSON.stringify({ source: 'bundled' }))

  const bucket = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    if (pathname === '/test-bucket/rankings/active-generation.json') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ generationId: 'fresh' }))
      return
    }
    if (pathname === '/test-bucket/rankings/generations/fresh/data/history/tournament-moves/index.json') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ source: 'fresh' }))
      return
    }
    if (pathname === '/test-bucket/rankings/generations/stale/data/history/tournament-moves/index.json') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ source: 'stale' }))
      return
    }
    response.statusCode = 404
    response.end()
  })
  await new Promise<void>((resolve) => bucket.listen(0, '127.0.0.1', resolve))
  const bucketPort = (bucket.address() as AddressInfo).port

  const server = await startRailwayServer(distDir, dataDir, {
    RANKING_BUCKET_NAME: 'test-bucket',
    RANKING_BUCKET_ENDPOINT: `http://127.0.0.1:${bucketPort}`,
    RANKING_BUCKET_ACCESS_KEY_ID: 'test',
    RANKING_BUCKET_SECRET_ACCESS_KEY: 'test',
    RANKING_BUCKET_FORCE_PATH_STYLE: 'true',
  })
  try {
    const active = await httpRequest(server.port, '/data/history/tournament-moves/index.json')
    assert.equal(active.statusCode, 200)
    assert.equal(JSON.parse(active.body).source, 'fresh')

    const stale = await httpRequest(server.port, '/data/history/tournament-moves/index.json?v=stale')
    assert.equal(stale.statusCode, 200)
    assert.equal(JSON.parse(stale.body).source, 'stale')

    const missing = await httpRequest(server.port, '/data/history/tournament-moves/index.json?v=missing')
    assert.equal(missing.statusCode, 404)
    assert.doesNotMatch(missing.body, /bundled/)
  } finally {
    await server.close()
    await new Promise<void>((resolve, reject) => bucket.close((error) => error ? reject(error) : resolve()))
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('Railway server and production reader support identity and gzip delivery of gzip-stored artifacts', async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-server-content-'))
  const distDir = join(tempDir, 'dist')
  const dataDir = join(tempDir, 'data')
  await mkdir(distDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(distDir, 'index.html'), '<!doctype html><div id="root">app shell</div>\n')
  const fixture = await contentAddressedReaderFixture()
  const bucket = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    if (pathname === '/test-bucket/rankings/active-generation.json') {
      response.setHeader('Content-Type', 'application/json')
      response.setHeader('ETag', fixture.activeEtag)
      response.end(fixture.activeBody)
      return
    }
    if (pathname === `/test-bucket/rankings/generations/${fixture.generationId}/publish.json`) {
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.setHeader('Content-Length', String(fixture.receipt.body.byteLength))
      response.setHeader('ETag', fixture.receiptEtag)
      response.setHeader('x-amz-meta-sha256', fixture.receipt.digest)
      response.setHeader('x-amz-meta-semantic-bytes', String(fixture.receipt.bytes))
      response.end(fixture.receipt.body)
      return
    }
    if (pathname === `/test-bucket/rankings/generations/${fixture.generationId}/manifest.json`) {
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.setHeader('Content-Length', String(fixture.manifestBody.byteLength))
      response.setHeader('ETag', fixture.manifestEtag)
      response.setHeader('x-amz-meta-sha256', fixture.manifestDigest)
      response.setHeader('x-amz-meta-semantic-bytes', String(fixture.manifestBody.byteLength))
      response.end(fixture.manifestBody)
      return
    }
    const stored = fixture.objects.get(pathname)
    if (stored) {
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.setHeader('Content-Encoding', 'gzip')
      response.setHeader('Content-Length', String(stored.compressed.byteLength))
      response.setHeader('x-amz-meta-sha256', stored.digest)
      response.setHeader('x-amz-meta-semantic-bytes', String(stored.bytes))
      response.setHeader('x-amz-meta-encoding', 'gzip')
      response.end(stored.compressed)
      return
    }
    response.statusCode = 404
    response.end()
  })
  await new Promise<void>((resolve) => bucket.listen(0, '127.0.0.1', resolve))
  const bucketPort = (bucket.address() as AddressInfo).port
  try {
    for (const gzipEnabled of [false, true]) {
      await t.test(gzipEnabled ? 'passes stored gzip through' : 'delivers decoded identity', async () => {
        const server = await startRailwayServer(distDir, dataDir, {
          RANKING_BUCKET_NAME: 'test-bucket',
          RANKING_BUCKET_ENDPOINT: `http://127.0.0.1:${bucketPort}`,
          RANKING_BUCKET_ACCESS_KEY_ID: 'test',
          RANKING_BUCKET_SECRET_ACCESS_KEY: 'test',
          RANKING_BUCKET_FORCE_PATH_STYLE: 'true',
          RANKING_GZIP_ENABLED: String(gzipEnabled),
        })
        try {
          const objectResponseEncodings: Array<string | null> = []
          const baseUrl = `http://127.0.0.1:${server.port}`
          const fetcher: typeof fetch = async (input, init) => {
            const response = await fetch(new URL(String(input), baseUrl), init)
            if (new URL(response.url).pathname.startsWith('/data/objects/sha256/')) {
              objectResponseEncodings.push(response.headers.get('content-encoding'))
              assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')
            }
            return response
          }
          const manifest = await createPublicRankingManifestLoader(`${baseUrl}/data/ranking-summary.json`, fetcher)()
          const expected = manifest.snapshotIndex[fixture.snapshotKey]
          const shard = await fetchPublicSnapshotShard(expected.url, fixture.snapshotKey, expected, manifest, { fetcher })

          assert.equal(shard.matchCount, fixture.expectedMatchCount)
          assert.deepEqual(objectResponseEncodings, gzipEnabled ? ['gzip', 'gzip'] : [null, null])

          const invalidObject = await httpRequest(server.port, '/data/objects/sha256/not-a-digest')
          assert.equal(invalidObject.statusCode, 404)
          assert.notEqual(invalidObject.headers['cache-control'], 'public, max-age=31536000, immutable')
        } finally {
          await server.close()
        }
      })
    }
  } finally {
    await new Promise<void>((resolve, reject) => bucket.close((error) => error ? reject(error) : resolve()))
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('Railway server hybrid delivery redirects only eligible immutable objects and preserves proxy recovery', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-server-presigned-'))
  const distDir = join(tempDir, 'dist')
  const dataDir = join(tempDir, 'data')
  await mkdir(distDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(distDir, 'index.html'), '<!doctype html><div id="root">app shell</div>\n')
  await writeFile(join(dataDir, 'ranking-summary.json'), JSON.stringify({ source: 'bundled' }))
  const storedBodies = [
    { source: 'large', semantic: Buffer.from(JSON.stringify({ source: 'large' })) },
    { source: 'small', semantic: Buffer.from(JSON.stringify({ source: 'small' })) },
    { source: 'head-fallback', semantic: Buffer.from(JSON.stringify({ source: 'head-fallback' })) },
  ].map((entry) => ({
    ...entry,
    digest: createHash('sha256').update(entry.semantic).digest('hex'),
    compressed: gzipSync(entry.semantic),
  }))
  const [large, small, failing] = storedBodies
  const largeDigest = large.digest
  const smallDigest = small.digest
  const failingDigest = failing.digest
  const bodies = new Map(storedBodies.map((entry) => [entry.digest, entry]))
  const bucketCalls: Array<{ method: string; pathname: string }> = []
  const bucket = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const match = /^\/test-bucket\/rankings\/objects\/sha256\/([a-f0-9]{64})$/.exec(url.pathname)
    bucketCalls.push({ method: request.method ?? 'GET', pathname: url.pathname })
    if (!match) {
      response.statusCode = 404
      response.end()
      return
    }
    const objectDigest = match[1]
    const stored = bodies.get(objectDigest)
    if (!stored) {
      response.statusCode = 404
      response.end()
      return
    }
    if (request.method === 'HEAD' && objectDigest === failingDigest) {
      response.statusCode = 500
      response.end()
      return
    }
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Content-Encoding', 'gzip')
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    response.setHeader('ETag', `"${objectDigest.slice(0, 8)}"`)
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Expose-Headers', 'Content-Encoding, ETag, Cache-Control')
    response.setHeader('x-amz-meta-sha256', objectDigest)
    response.setHeader('x-amz-meta-semantic-bytes', String(stored.semantic.byteLength))
    response.setHeader('x-amz-meta-encoding', 'gzip')
    response.setHeader('Content-Length', request.method === 'HEAD'
      ? String(objectDigest === smallDigest ? 100 : 70_000)
      : String(stored.compressed.byteLength))
    response.end(request.method === 'HEAD' ? undefined : stored.compressed)
  })
  await new Promise<void>((resolve) => bucket.listen(0, '127.0.0.1', resolve))
  const bucketPort = (bucket.address() as AddressInfo).port
  const server = await startRailwayServer(distDir, dataDir, {
    RANKING_BUCKET_NAME: 'test-bucket',
    RANKING_BUCKET_ENDPOINT: `http://127.0.0.1:${bucketPort}`,
    RANKING_BUCKET_ACCESS_KEY_ID: 'test',
    RANKING_BUCKET_SECRET_ACCESS_KEY: 'test',
    RANKING_BUCKET_FORCE_PATH_STYLE: 'true',
    RANKING_PRESIGNED_DELIVERY_ENABLED: 'true',
    RANKING_PRESIGNED_DELIVERY_THRESHOLD_BYTES: '65536',
  })

  try {
    const largePath = `/data/objects/sha256/${largeDigest}`
    const getRedirect = await httpRequest(server.port, largePath)
    assert.equal(getRedirect.statusCode, 307)
    assert.equal(getRedirect.headers['cache-control'], 'private, no-store')
    assert.equal(getRedirect.body, '')
    const getLocation = String(getRedirect.headers.location)
    assert.equal(new URL(getLocation).searchParams.get('X-Amz-Expires'), '3600')
    assert.deepEqual(bucketCalls.map((call) => call.method), ['HEAD'])

    const headRedirect = await httpRequest(server.port, largePath, { method: 'HEAD' })
    assert.equal(headRedirect.statusCode, 307)
    assert.equal(headRedirect.body, '')
    const headLocation = String(headRedirect.headers.location)
    assert.equal(new URL(headLocation).searchParams.get('X-Amz-Expires'), '3600')
    assert.notEqual(new URL(headLocation).searchParams.get('X-Amz-Signature'), new URL(getLocation).searchParams.get('X-Amz-Signature'))
    assert.deepEqual(bucketCalls.map((call) => call.method), ['HEAD', 'HEAD'])

    const callsBeforeCanonicalQuery = bucketCalls.length
    const queryRedirect = await httpRequest(server.port, `${largePath}?v=generation-test&source=browser`)
    assert.equal(queryRedirect.statusCode, 307)
    assert.deepEqual(bucketCalls.slice(callsBeforeCanonicalQuery).map((call) => call.method), ['HEAD'])

    const direct = await fetch(getLocation)
    assert.equal(direct.status, 200)
    assert.equal(direct.headers.get('content-encoding'), 'gzip')
    assert.equal(direct.headers.get('etag'), `"${largeDigest.slice(0, 8)}"`)
    assert.equal(direct.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.equal(direct.headers.get('access-control-allow-origin'), '*')

    const callsBeforeProxy = bucketCalls.length
    const proxy = await httpRequest(server.port, `${largePath}?delivery=proxy`)
    assert.equal(proxy.statusCode, 200)
    assert.deepEqual(JSON.parse(proxy.body), { source: 'large' })
    assert.deepEqual(bucketCalls.slice(callsBeforeProxy).map((call) => call.method), ['GET'])
    assert.equal(proxy.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(proxy.headers['cache-control'], 'public, max-age=31536000, immutable')
    assert.equal(proxy.headers.etag, `"${largeDigest.slice(0, 8)}"`)

    const callsBeforeProxyHead = bucketCalls.length
    const proxyHead = await httpRequest(server.port, `${largePath}?delivery=proxy`, {
      method: 'HEAD',
      headers: { 'accept-encoding': 'gzip' },
    })
    assert.equal(proxyHead.statusCode, 200)
    assert.equal(proxyHead.body, '')
    assert.equal(proxyHead.headers['content-length'], '70000')
    assert.equal(proxyHead.headers['content-encoding'], 'gzip')
    assert.equal(proxyHead.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(proxyHead.headers['cache-control'], 'public, max-age=31536000, immutable')
    assert.equal(proxyHead.headers.etag, `"${largeDigest.slice(0, 8)}"`)
    assert.deepEqual(bucketCalls.slice(callsBeforeProxyHead).map((call) => call.method), ['HEAD'])

    const callsBeforeSmall = bucketCalls.length
    const small = await httpRequest(server.port, `/data/objects/sha256/${smallDigest}`)
    assert.equal(small.statusCode, 200)
    assert.deepEqual(JSON.parse(small.body), { source: 'small' })
    assert.deepEqual(bucketCalls.slice(callsBeforeSmall).map((call) => call.method), ['HEAD', 'GET'])

    const callsBeforeSmallHead = bucketCalls.length
    const smallHead = await httpRequest(server.port, `/data/objects/sha256/${smallDigest}`, {
      method: 'HEAD',
      headers: { 'accept-encoding': 'gzip' },
    })
    assert.equal(smallHead.statusCode, 200)
    assert.equal(smallHead.body, '')
    assert.equal(smallHead.headers['content-length'], '100')
    assert.equal(smallHead.headers['content-encoding'], 'gzip')
    assert.deepEqual(bucketCalls.slice(callsBeforeSmallHead).map((call) => call.method), ['HEAD'])

    const callsBeforeFailure = bucketCalls.length
    const headFailure = await httpRequest(server.port, `/data/objects/sha256/${failingDigest}`)
    assert.equal(headFailure.statusCode, 200)
    assert.deepEqual(JSON.parse(headFailure.body), { source: 'head-fallback' })
    assert.equal(bucketCalls.slice(callsBeforeFailure).some((call) => call.method === 'HEAD'), true)
    assert.equal(bucketCalls.slice(callsBeforeFailure).at(-1)?.method, 'GET')

    const callsBeforeHeadFailure = bucketCalls.length
    const failedHead = await httpRequest(server.port, `/data/objects/sha256/${failingDigest}`, { method: 'HEAD' })
    assert.equal(failedHead.statusCode, 404)
    assert.equal(failedHead.body, '')
    assert.equal(bucketCalls.slice(callsBeforeHeadFailure).some((call) => call.method === 'GET'), false)

    const callsBeforeInvalid = bucketCalls.length
    const invalid = await httpRequest(server.port, `/data/objects/sha256/${'A'.repeat(64)}`)
    assert.equal(invalid.statusCode, 404)
    assert.equal(bucketCalls.length, callsBeforeInvalid)

    for (const invalidPath of [
      `/data/%2e%2e/data/objects/sha256/${largeDigest}`,
      `/data/objects/sha256/%61${largeDigest.slice(2)}`,
      `/data/%6fbjects/sha256/${largeDigest}`,
      `/data//objects/sha256/${largeDigest}`,
      `/data/objects/sha256/${largeDigest.toUpperCase()}`,
      `/data/objects/sha256/${largeDigest}.json`,
    ]) {
      const callsBeforeMalformed = bucketCalls.length
      const malformed = await httpRequest(server.port, invalidPath)
      assert.notEqual(malformed.statusCode, 307)
      assert.equal(bucketCalls.slice(callsBeforeMalformed).some((call) => call.method === 'HEAD'), false)
      if (invalidPath.includes('%')) assert.equal(bucketCalls.length, callsBeforeMalformed)
    }

    const summary = await httpRequest(server.port, '/data/ranking-summary.json')
    assert.equal(summary.statusCode, 200)
    assert.deepEqual(JSON.parse(summary.body), { source: 'bundled' })
    assert.equal(bucketCalls.at(-1)?.method, 'GET')

    const proxyServer = await startRailwayServer(distDir, dataDir, {
      RANKING_BUCKET_NAME: 'test-bucket',
      RANKING_BUCKET_ENDPOINT: `http://127.0.0.1:${bucketPort}`,
      RANKING_BUCKET_ACCESS_KEY_ID: 'test',
      RANKING_BUCKET_SECRET_ACCESS_KEY: 'test',
      RANKING_BUCKET_FORCE_PATH_STYLE: 'true',
      RANKING_PRESIGNED_DELIVERY_ENABLED: 'false',
    })
    try {
      const callsBeforeDefaultHead = bucketCalls.length
      const defaultHead = await httpRequest(proxyServer.port, largePath, {
        method: 'HEAD',
        headers: { 'accept-encoding': 'gzip' },
      })
      assert.equal(defaultHead.statusCode, 200)
      assert.equal(defaultHead.body, '')
      assert.equal(defaultHead.headers['content-length'], '70000')
      assert.deepEqual(bucketCalls.slice(callsBeforeDefaultHead).map((call) => call.method), ['HEAD'])

      const [defaultLarge, defaultSmall, defaultManifest] = await Promise.all([
        httpRequest(proxyServer.port, largePath),
        httpRequest(proxyServer.port, `/data/objects/sha256/${smallDigest}`),
        httpRequest(proxyServer.port, '/data/ranking-summary.json'),
      ])
      assertHttpRepresentationEqual(defaultLarge, proxy)
      assertHttpRepresentationEqual(defaultSmall, small)
      assertHttpRepresentationEqual(defaultManifest, summary)
    } finally {
      await proxyServer.close()
    }
  } finally {
    await server.close()
    await new Promise<void>((resolve, reject) => bucket.close((error) => error ? reject(error) : resolve()))
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('Railway server injects the latest current-season crawler snapshot on each request', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-server-'))
  const distDir = join(tempDir, 'dist')
  const dataDir = join(tempDir, 'data')
  const scopeDir = join(dataDir, 'scopes')
  const seasonKey = `${new Date().getUTCFullYear()}__All__All`
  const shardPath = join(scopeDir, 'current.json')
  await mkdir(distDir, { recursive: true })
  await mkdir(scopeDir, { recursive: true })
  await writeFile(
    join(distDir, 'index.html'),
    '<!doctype html><div id="root"><!--homepage-prerender:start--><p>build snapshot</p><!--homepage-prerender:end--></div>\n',
  )
  await writeFile(join(distDir, 'sitemap.xml'), '<urlset><url><lastmod>2020-01-01</lastmod></url></urlset>')
  await writeFile(join(dataDir, 'ranking-summary.json'), JSON.stringify({
    generatedAt: '2026-07-10T12:00:00.000Z',
    defaultSnapshotKey: 'All__All__All',
    snapshotIndex: {
      All__All__All: { url: '/data/scopes/all.json' },
      [seasonKey]: { url: '/data/scopes/current.json' },
    },
    model: { version: 'test-model', configHash: 'test-config' },
    coverage: { matchCount: 10 },
    source: 'Test source',
  }))
  await writeCrawlerShard(shardPath, 'Fresh Team')

  const server = await startRailwayServer(distDir, dataDir)
  try {
    const first = await httpRequest(server.port, '/')
    assert.equal(first.statusCode, 200)
    assert.match(first.body, new RegExp(`data-snapshot-key="${seasonKey}"`))
    assert.match(first.body, /Fresh Team/)

    const sitemap = await httpRequest(server.port, '/sitemap.xml')
    assert.match(sitemap.body, /<lastmod>2026-07-10<\/lastmod>/)

    await writeCrawlerShard(shardPath, 'Refreshed Team')
    const second = await httpRequest(server.port, '/')
    assert.match(second.body, /Refreshed Team/)
    assert.doesNotMatch(second.body, /Fresh Team/)
  } finally {
    await server.close()
    await rm(tempDir, { recursive: true, force: true })
  }
})

type TestServer = {
  port: number
  close: () => Promise<void>
}

async function contentAddressedReaderFixture() {
  const rootSource: unknown = JSON.parse(await readFile('public/data/ranking-summary.json', 'utf8'))
  const rankingManifest = parsePublicRankingManifest(rootSource)
  const generationId = rankingManifest.artifactMeta?.runId
  if (!generationId) throw new Error('Expected ranking fixture to declare an artifact runId')
  const snapshotKey = rankingManifest.defaultSnapshotKey
  const snapshotEntry = rankingManifest.snapshotIndex[snapshotKey]
  const snapshotPath = new URL(snapshotEntry.url, 'https://fixture.invalid').pathname
  const shardSource: unknown = JSON.parse(await readFile(join('public', snapshotPath.replace(/^\//, '')), 'utf8'))
  const rootArtifact = prepareSemanticArtifact(rootSource)
  const shardArtifact = prepareSemanticArtifact(shardSource)
  const logicalPaths = rankingManifestLogicalPaths(rankingManifest)
  const entries = logicalPaths.map((logicalPath, index) => {
    const artifact = logicalPath === '/data/ranking-summary.json'
      ? rootArtifact
      : logicalPath === canonicalPublicLogicalPath(snapshotEntry.url)
        ? shardArtifact
        : undefined
    return {
      logicalPath,
      digest: artifact?.digest ?? (index + 1).toString(16).padStart(64, '0'),
      bytes: artifact?.bytes ?? 1,
    }
  })
  const generationManifest = createGenerationManifest({
    generationId,
    rootManifest: rootSource as Record<string, unknown>,
    entries,
  })
  const manifestBody = Buffer.from(canonicalJsonFor(generationManifest))
  const manifestDigest = createHash('sha256').update(manifestBody).digest('hex')
  const manifestEtag = '"content-reader-manifest"'
  const rawDigest = 'f'.repeat(64)
  const receipt = createGenerationPublicationReceipt({
    generationId,
    preparedAt: rankingManifest.generatedAt,
    prefix: 'rankings',
    fencingToken: 1,
    leaseOwner: 'content-reader-fixture',
    promotionEtag: '"content-reader-promotion"',
    provenance: {
      modelVersion: rankingManifest.model.version,
      modelConfigHash: rankingManifest.model.configHash,
      source: rankingManifest.source,
      dataMode: rankingManifest.dataMode,
      sourceProviders: rankingManifest.sources.map((source) => source.name),
    },
    authorities: {
      publicManifest: {
        key: `rankings/generations/${generationId}/manifest.json`,
        digest: manifestDigest,
        bytes: manifestBody.byteLength,
      },
      rawReceipt: {
        key: `rankings/raw/objects/sha256/${rawDigest}`,
        digest: rawDigest,
        bytes: 1,
      },
    },
    objects: [
      {
        key: `rankings/generations/${generationId}/manifest.json`,
        digest: manifestDigest,
        bytes: manifestBody.byteLength,
        outcome: 'uploaded',
      },
      ...entries.map((entry) => ({
        key: `rankings/objects/sha256/${entry.digest}`,
        digest: entry.digest,
        bytes: logicalPaths.includes(entry.logicalPath)
          ? (entry.logicalPath === '/data/ranking-summary.json'
              ? rootArtifact.compressedBytes
              : entry.logicalPath === canonicalPublicLogicalPath(snapshotEntry.url)
                ? shardArtifact.compressedBytes
                : 1)
          : 1,
        outcome: 'uploaded',
      })),
      {
        key: `rankings/raw/objects/sha256/${rawDigest}`,
        digest: rawDigest,
        bytes: 1,
        outcome: 'uploaded',
      },
    ],
  })
  const preparedReceipt = publicationReceiptBytes(receipt)
  const receiptEtag = '"content-reader-receipt"'
  const activeEtag = '"content-reader-active"'
  const activeBody = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    generationId,
    fencingToken: 1,
    promotedAt: rankingManifest.generatedAt,
    manifestKey: `rankings/generations/${generationId}/manifest.json`,
    publicManifestSchemaVersion: 2,
    storageMode: 'content-addressed-gzip-v1',
    manifestDigest,
    manifestBytes: manifestBody.byteLength,
    manifestEtag,
    publicationSchemaVersion: 1,
    publicationReceiptKey: `rankings/generations/${generationId}/publish.json`,
    publicationReceiptDigest: preparedReceipt.digest,
    publicationReceiptBytes: preparedReceipt.bytes,
    publicationReceiptEtag: receiptEtag,
  }))
  return {
    generationId,
    generationManifest,
    manifestBody,
    manifestDigest,
    manifestEtag,
    receipt: preparedReceipt,
    receiptEtag,
    activeBody,
    activeEtag,
    snapshotKey,
    expectedMatchCount: snapshotEntry.matchCount,
    objects: new Map([
      [`/test-bucket/rankings/objects/sha256/${rootArtifact.digest}`, rootArtifact],
      [`/test-bucket/rankings/objects/sha256/${shardArtifact.digest}`, shardArtifact],
    ]),
  }
}

function rankingManifestLogicalPaths(manifest: ReturnType<typeof parsePublicRankingManifest>) {
  const urls = [
    '/data/ranking-summary.json',
    manifest.playerDirectoryUrl,
    manifest.fullSnapshotUrl,
    manifest.teamDirectoryUrl,
    manifest.teamHistoryIndexUrl,
    manifest.regionHistoryUrl,
    manifest.tournamentMovementIndexUrl,
    manifest.matchHistoryIndexUrl,
    ...Object.values(manifest.snapshotIndex).map((entry) => entry.url),
  ].filter((value): value is string => Boolean(value))
  return [...new Set(urls.map(canonicalPublicLogicalPath))]
}

type HttpResponse = {
  statusCode: number
  headers: IncomingHttpHeaders
  body: string
}

async function startRailwayServer(
  distDir: string,
  dataDir: string,
  env: Record<string, string> = {},
): Promise<TestServer> {
  const port = await freePort()
  const child = spawn(process.execPath, ['scripts/railway-server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      RAILWAY_DIST_DIR: distDir,
      RANKING_PUBLIC_DATA_DIR: dataDir,
      RANKING_TRIGGER_STATE: join(dataDir, 'refresh-trigger-state.json'),
      RANKING_REFRESH_ENABLED: 'false',
      RANKING_BUCKET_NAME: '',
      RANKING_BUCKET_ENDPOINT: '',
      RANKING_BUCKET_ACCESS_KEY_ID: '',
      RANKING_BUCKET_SECRET_ACCESS_KEY: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })

  await waitForHealthy(port, child, () => output)
  return {
    port,
    close: () => stopChild(child),
  }
}

async function waitForHealthy(port: number, child: ChildProcess, output: () => string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Railway server exited with ${child.exitCode}:\n${output()}`)
    }
    try {
      const response = await httpRequest(port, '/api/live')
      if (response.statusCode === 200) return
    } catch {
      await delay(50)
    }
  }
  throw new Error(`Timed out waiting for Railway server:\n${output()}`)
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null) return
  child.kill()
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 1_000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  return port
}

function httpRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const clientRequest = request({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: options.headers,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    clientRequest.on('error', reject)
    clientRequest.end()
  })
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assertHttpRepresentationEqual(actual: HttpResponse, expected: HttpResponse) {
  assert.equal(actual.statusCode, expected.statusCode)
  assert.equal(actual.body, expected.body)
  for (const name of ['content-type', 'content-encoding', 'content-length', 'cache-control', 'etag', 'last-modified', 'vary']) {
    assert.equal(actual.headers[name], expected.headers[name], `${name} must remain byte/header compatible`)
  }
}

async function writeCrawlerShard(path: string, team: string) {
  await writeFile(path, JSON.stringify({
    matchCount: 10,
    standings: [{ team, code: 'TEST', region: 'LCK', rank: 1, rating: 2000, wins: 5, losses: 0, eligibility: { eligible: true } }],
    regions: [{ region: 'LCK', rank: 1, score: 2000, teamCount: 1, flagshipLeague: 'LCK' }],
  }))
}
