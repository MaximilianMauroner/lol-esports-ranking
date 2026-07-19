import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import handler from '../api/rankings.ts'
import { parsePublicRankingManifest } from '../src/lib/publicArtifacts/schema.ts'
import { PUBLIC_ARTIFACT_FIXTURE_DIR } from './fixtures/publicArtifactBundle.ts'

test('/api/rankings reads versioned local public artifact URLs', async () => {
  const manifest = parsePublicRankingManifest(await readJson(join(PUBLIC_ARTIFACT_FIXTURE_DIR, 'ranking-summary.json')))
  const defaultEntry = manifest.snapshotIndex[manifest.defaultSnapshotKey]
  assert.ok(defaultEntry)
  assert.match(defaultEntry.url, /\?v=/)

  const response = new MockResponse()
  const previous = process.env.RANKING_PUBLIC_DATA_DIR
  process.env.RANKING_PUBLIC_DATA_DIR = PUBLIC_ARTIFACT_FIXTURE_DIR
  try {
    await handler({ method: 'GET', query: { pageSize: '3' } }, response)
  } finally {
    if (previous === undefined) delete process.env.RANKING_PUBLIC_DATA_DIR
    else process.env.RANKING_PUBLIC_DATA_DIR = previous
  }

  assert.equal(response.statusCode, 200)
  assertRecord(response.body)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.pageSize, 3)
  assert.equal(typeof response.body.total, 'number')
  assert.equal(Array.isArray(response.body.standings), true)
  assert.equal((response.body.standings as unknown[]).length <= 3, true)
})

test('/api/rankings normalizes external directory and explicit manifest configurations', async () => {
  const originalFetch = globalThis.fetch
  const previous = process.env.RANKING_DATA_URL
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    const parsed = new URL(url)
    const relativePath = parsed.pathname.replace(/^\/x\//, '')
    return new Response(await readFile(join(PUBLIC_ARTIFACT_FIXTURE_DIR, relativePath)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    for (const configured of ['https://cdn.example/x/', 'https://cdn.example/x/ranking-summary.json']) {
      requests.length = 0
      process.env.RANKING_DATA_URL = configured
      const response = new MockResponse()
      await handler({ method: 'GET', query: { pageSize: '1' } }, response)
      assert.equal(response.statusCode, 200)
      assert.equal(requests[0], 'https://cdn.example/x/ranking-summary.json')
      assert.match(requests[1] ?? '', /^https:\/\/cdn\.example\/x\/scopes\/all\.json\?v=/)
    }
  } finally {
    globalThis.fetch = originalFetch
    if (previous === undefined) delete process.env.RANKING_DATA_URL
    else process.env.RANKING_DATA_URL = previous
  }
})

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'))
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.equal(typeof value, 'object')
  assert.notEqual(value, null)
  assert.equal(Array.isArray(value), false)
}

class MockResponse {
  statusCode = 200
  body: unknown
  headers: Record<string, string> = {}

  status(code: number) {
    this.statusCode = code
    return this
  }

  json(value: unknown) {
    this.body = value
  }

  setHeader(name: string, value: string) {
    this.headers[name] = value
  }
}
