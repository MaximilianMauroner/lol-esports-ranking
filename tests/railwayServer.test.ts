import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { canonicalPublicLogicalPath, createGenerationManifest, prepareSemanticArtifact } from '../scripts/public-artifact-storage.mjs'
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
      response.end(JSON.stringify({ generationId: fixture.generationId, storageMode: 'content-addressed-gzip-v1' }))
      return
    }
    if (pathname === `/test-bucket/rankings/generations/${fixture.generationId}/manifest.json`) {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(fixture.generationManifest))
      return
    }
    const stored = fixture.objects.get(pathname)
    if (stored) {
      response.setHeader('Content-Type', 'application/json')
      response.setHeader('Content-Encoding', 'gzip')
      response.end(stored)
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
  const largeDigest = 'a'.repeat(64)
  const smallDigest = 'b'.repeat(64)
  const failingDigest = 'c'.repeat(64)
  const bodies = new Map([
    [largeDigest, gzipSync(JSON.stringify({ source: 'large' }))],
    [smallDigest, gzipSync(JSON.stringify({ source: 'small' }))],
    [failingDigest, gzipSync(JSON.stringify({ source: 'head-fallback' }))],
  ])
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
    const body = bodies.get(objectDigest)
    if (!body) {
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
    response.setHeader('x-amz-meta-semantic-bytes', '140000')
    response.setHeader('x-amz-meta-encoding', 'gzip')
    response.setHeader('Content-Length', request.method === 'HEAD'
      ? String(objectDigest === smallDigest ? 100 : 70_000)
      : String(body.byteLength))
    response.end(request.method === 'HEAD' ? undefined : body)
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

    const health = JSON.parse((await httpRequest(server.port, '/api/health')).body)
    assert.deepEqual(health.presignedDelivery, {
      enabled: true,
      mode: 'hybrid',
      thresholdBytes: 65_536,
      expiresInSeconds: 3600,
    })

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

test('Railway server keeps presigned delivery disabled by default', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-server-proxy-default-'))
  const distDir = join(tempDir, 'dist')
  const dataDir = join(tempDir, 'data')
  await mkdir(distDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(distDir, 'index.html'), '<!doctype html><div id="root">app shell</div>\n')
  const server = await startRailwayServer(distDir, dataDir)
  try {
    const health = JSON.parse((await httpRequest(server.port, '/api/health')).body)
    assert.deepEqual(health.presignedDelivery, {
      enabled: false,
      mode: 'proxy',
      thresholdBytes: 65_536,
      expiresInSeconds: 3600,
    })
  } finally {
    await server.close()
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('Railway server reports stale-source refresh status as healthy', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-server-'))
  const distDir = join(tempDir, 'dist')
  const dataDir = join(tempDir, 'data')
  const refreshStatePath = join(tempDir, 'raw', 'refresh-state.json')
  const refreshScriptPath = join(tempDir, 'stale-refresh.mjs')
  await mkdir(distDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(distDir, 'index.html'), '<!doctype html><div id="root">app shell</div>\n')
  await writeFile(refreshScriptPath, `
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const statePath = process.env.RANKING_REFRESH_STATE
await mkdir(dirname(statePath), { recursive: true })
await writeFile(statePath, JSON.stringify({
  status: 'stale-source',
  reason: 'no-current-match-source-data',
  downloadStart: '2026-07-02',
  downloadEnd: '2026-07-09',
  coverageStart: '2026-01-01',
  coverageEnd: '2026-07-08',
  crunch: {
    skipped: true,
    reason: 'no-current-match-source-data'
  }
}, null, 2))
`)

  const server = await startRailwayServer(distDir, dataDir, {
    RANKING_REFRESH_ENABLED: 'true',
    RANKING_REFRESH_ON_START: 'true',
    RANKING_REFRESH_INTERVAL_MINUTES: '60',
    RANKING_REFRESH_SCRIPT: refreshScriptPath,
    RANKING_REFRESH_STATE: refreshStatePath,
  })
  try {
    const health = await waitForRefreshStatus(server.port, 'stale-source')
    assert.equal(health.ok, true)
    assert.equal(health.lastRefresh.status, 'stale-source')
    assert.equal(health.lastRefresh.error, 'no-current-match-source-data')
    assert.equal(health.lastRefresh.details?.coverageEnd, '2026-07-08')
  } finally {
    await server.close()
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
      bytes: artifact?.bytes ?? 0,
    }
  })
  const generationManifest = createGenerationManifest({
    generationId,
    rootManifest: rootSource as Record<string, unknown>,
    entries,
  })
  return {
    generationId,
    generationManifest,
    snapshotKey,
    expectedMatchCount: snapshotEntry.matchCount,
    objects: new Map([
      [`/test-bucket/rankings/objects/sha256/${rootArtifact.digest}`, rootArtifact.compressed],
      [`/test-bucket/rankings/objects/sha256/${shardArtifact.digest}`, shardArtifact.compressed],
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
    manifest.teamHistoryUrl,
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

type HealthJson = {
  ok: boolean
  lastRefresh: {
    status: string
    error: string | null
    details?: {
      coverageEnd?: string
    } | null
  }
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

async function waitForRefreshStatus(port: number, status: string): Promise<HealthJson> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const response = await httpRequest(port, '/api/health')
    if (response.statusCode === 200) {
      const health = JSON.parse(response.body) as HealthJson
      if (health.lastRefresh?.status === status) return health
    }
    await delay(50)
  }
  throw new Error(`Timed out waiting for refresh status ${status}`)
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
