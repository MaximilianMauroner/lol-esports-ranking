import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import handler from '../api/rankings.ts'
import { parsePublicRankingManifest } from '../src/lib/publicArtifacts/schema.ts'

const generatedArtifactTest = existsSync('.generated/ranking-data/ranking-summary.json') ? test : test.skip

generatedArtifactTest('/api/rankings reads versioned local public artifact URLs', async () => {
  const manifest = parsePublicRankingManifest(await readJson('.generated/ranking-data/ranking-summary.json'))
  const defaultEntry = manifest.snapshotIndex[manifest.defaultSnapshotKey]
  assert.ok(defaultEntry)
  assert.match(defaultEntry.url, /\?v=/)

  const response = new MockResponse()
  await handler({ method: 'GET', query: { pageSize: '3' } }, response)

  assert.equal(response.statusCode, 200)
  assertRecord(response.body)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.pageSize, 3)
  assert.equal(typeof response.body.total, 'number')
  assert.equal(Array.isArray(response.body.standings), true)
  assert.equal((response.body.standings as unknown[]).length <= 3, true)
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
