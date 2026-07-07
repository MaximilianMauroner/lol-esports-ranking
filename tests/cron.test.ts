import assert from 'node:assert/strict'
import test from 'node:test'
import handler, { isAuthorizedCronRequest, publishSnapshot } from '../api/recalculate-rankings.ts'
import { createStaticRankingData } from '../src/lib/snapshot.ts'
import { parsePublicRankingManifest, parsePublicRegionHistory, parsePublicTeamHistoryIndex, parsePublicTeamHistoryShard } from '../src/lib/publicArtifacts/schema.ts'
import { rosters, sampleMatches, teams } from './fixtures/rankingFixtures.ts'

test('cron auth requires the configured bearer secret', () => {
  assert.equal(isAuthorizedCronRequest(undefined, undefined), false)
  assert.equal(isAuthorizedCronRequest(undefined, 'secret'), false)
  assert.equal(isAuthorizedCronRequest('Bearer wrong', 'secret'), false)
  assert.equal(isAuthorizedCronRequest('Bearer secret', 'secret'), true)
})

test('cron reports no-data snapshots instead of falling back to seeded rows', async () => {
  const previousEnv = { ...process.env }
  process.env.CRON_SECRET = 'secret'
  delete process.env.ORACLES_ELIXIR_CSV_URL
  delete process.env.LEAGUEPEDIA_MATCHES_JSON_URL
  delete process.env.BLOB_READ_WRITE_TOKEN

  try {
    const unauthenticated = await callHandler({ authorization: undefined, userAgent: 'vercel-cron/1.0' })
    assert.equal(unauthenticated.statusCode, 401)
    assert.deepEqual(unauthenticated.body, { ok: false, error: 'Unauthorized' })

    const noPublicRows = await callHandler({ authorization: 'Bearer secret' })
    assert.equal(noPublicRows.statusCode, 200)
    assert.equal(noPublicRows.body.ok, true)
    assert.equal(noPublicRows.body.dataMode, 'no-data')
    assert.equal(noPublicRows.body.source, 'no public match data available')
    assert.match(String(noPublicRows.body.warning), /not published/)

    process.env.ALLOW_SEEDED_SNAPSHOT = 'true'
    const ignoredDemoFlag = await callHandler({ authorization: 'Bearer secret' })
    assert.equal(ignoredDemoFlag.statusCode, 200)
    assert.equal(ignoredDemoFlag.body.ok, true)
    assert.equal(ignoredDemoFlag.body.dataMode, 'no-data')
    assert.equal(ignoredDemoFlag.body.source, 'no public match data available')
  } finally {
    process.env = previousEnv
  }
})

test('cron publisher uploads static-parity companion artifacts without full snapshot by default', async () => {
  const snapshot = createStaticRankingData({
    matches: sampleMatches,
    teams,
    rosters,
    source: 'cron publisher fixture',
  })
  const uploads: Array<{ pathname: string; value: unknown }> = []

  const published = await publishSnapshot(snapshot, async (pathname, body, options) => {
    assert.deepEqual(options, {
      access: 'public',
      allowOverwrite: true,
      contentType: 'application/json',
    })
    uploads.push({ pathname, value: JSON.parse(body) })
    return { url: `https://blob.example/${pathname}` }
  })
  const uploadPaths = new Set(uploads.map((upload) => upload.pathname))

  assert.equal(uploadPaths.has('rankings/latest-full.json'), false)
  assert.equal(uploadPaths.has('rankings/team-history.json'), false)
  assert.equal(uploadPaths.has('rankings/history/team-series.json'), false)
  assert.equal(uploadPaths.has('rankings/history/team-series/index.json'), true)
  assert.equal(uploadPaths.has('rankings/history/region-series.json'), true)
  assert.equal(published.fullBlobUrl, undefined)
  assert.equal(published.teamHistoryIndexBlobUrl, 'https://blob.example/rankings/history/team-series/index.json')
  assert.equal(published.regionHistoryBlobUrl, 'https://blob.example/rankings/history/region-series.json')

  const summary = parsePublicRankingManifest(uploadedValue(uploads, 'rankings/latest-summary.json'))
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'fullSnapshotUrl'), false)
  assert.equal(summary.playerDirectoryUrl, 'https://blob.example/rankings/entities/players.json')
  assert.equal(summary.teamDirectoryUrl, 'https://blob.example/rankings/entities/teams.json')
  assert.equal(summary.teamHistoryIndexUrl, 'https://blob.example/rankings/history/team-series/index.json')
  assert.equal(summary.regionHistoryUrl, 'https://blob.example/rankings/history/region-series.json')
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'teamHistoryUrl'), false)

  for (const entry of Object.values(summary.snapshotIndex)) {
    assert.match(entry.url, /^https:\/\/blob\.example\/rankings\/scopes\//)
    assert.equal(uploadPaths.has(blobPath(entry.url)), true, `missing uploaded snapshot shard ${entry.url}`)
  }

  const teamHistoryIndex = parsePublicTeamHistoryIndex(uploadedValue(uploads, 'rankings/history/team-series/index.json'))
  assert.equal(teamHistoryIndex.artifactKind, 'team-history-index')
  assert.equal(Object.keys(teamHistoryIndex.scopeIndex).length, published.teamHistoryShardCount)
  for (const entry of Object.values(teamHistoryIndex.scopeIndex)) {
    assert.match(entry.url, /^https:\/\/blob\.example\/rankings\/history\/team-series\//)
    assert.equal(uploadPaths.has(blobPath(entry.url)), true, `missing uploaded team-history shard ${entry.url}`)
    const teamHistoryShard = parsePublicTeamHistoryShard(uploadedValue(uploads, blobPath(entry.url)))
    assert.equal(teamHistoryShard.artifactKind, 'team-history-scope')
    assert.deepEqual(teamHistoryShard.filter, entry.filter)
    assert.equal(teamHistoryShard.teamCount, entry.teamCount)
    assert.equal(teamHistoryShard.pointCount, entry.pointCount)
  }

  const regionHistory = parsePublicRegionHistory(uploadedValue(uploads, 'rankings/history/region-series.json'))
  assert.equal(regionHistory.defaultScopeKey, snapshot.defaultSnapshotKey)
})

test('cron publisher can opt in to full snapshot blob upload', async () => {
  const snapshot = createStaticRankingData({
    matches: sampleMatches,
    teams,
    rosters,
    source: 'cron publisher fixture',
  })
  const uploads: Array<{ pathname: string; value: unknown }> = []

  const published = await publishSnapshot(
    snapshot,
    async (pathname, body) => {
      uploads.push({ pathname, value: JSON.parse(body) })
      return { url: `https://blob.example/${pathname}` }
    },
    { uploadFullSnapshot: true },
  )

  assert.equal(published.fullBlobUrl, 'https://blob.example/rankings/latest-full.json')
  const fullSnapshot = uploadedValue(uploads, 'rankings/latest-full.json') as { artifactKind?: string; generatedAt?: string }
  assert.equal(fullSnapshot.artifactKind, 'full-ranking-artifact')
  assert.equal(fullSnapshot.generatedAt, snapshot.generatedAt)

  const summary = parsePublicRankingManifest(uploadedValue(uploads, 'rankings/latest-summary.json'))
  assert.equal(summary.fullSnapshotUrl, 'https://blob.example/rankings/latest-full.json')
})

async function callHandler({ authorization, userAgent }: { authorization?: string; userAgent?: string }) {
  const response = new MockResponse()
  await handler(
    {
      method: 'GET',
      headers: {
        authorization,
        'user-agent': userAgent,
      },
    },
    response,
  )
  return response
}

function uploadedValue(uploads: Array<{ pathname: string; value: unknown }>, pathname: string) {
  const upload = uploads.findLast((entry) => entry.pathname === pathname)
  assert.ok(upload, `missing upload ${pathname}`)
  return upload.value
}

function blobPath(url: string) {
  const prefix = 'https://blob.example/'
  assert.equal(url.startsWith(prefix), true)
  return url.slice(prefix.length)
}

class MockResponse {
  statusCode = 200
  body: Record<string, unknown> = {}
  headers: Record<string, string> = {}

  status(code: number) {
    this.statusCode = code
    return this
  }

  json(value: unknown) {
    this.body = value as Record<string, unknown>
  }

  setHeader(name: string, value: string) {
    this.headers[name] = value
  }
}
