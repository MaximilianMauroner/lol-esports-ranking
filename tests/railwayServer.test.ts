import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

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

async function writeCrawlerShard(path: string, team: string) {
  await writeFile(path, JSON.stringify({
    matchCount: 10,
    standings: [{ team, code: 'TEST', region: 'LCK', rank: 1, rating: 2000, wins: 5, losses: 0, eligibility: { eligible: true } }],
    regions: [{ region: 'LCK', rank: 1, score: 2000, teamCount: 1, flagshipLeague: 'LCK' }],
  }))
}
