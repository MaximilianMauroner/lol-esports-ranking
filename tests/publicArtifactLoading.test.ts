import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fetchPublicSnapshotShard } from '../src/lib/publicArtifacts/resolver.ts'
import { parsePublicRankingManifest, parsePublicRankingShard } from '../src/lib/publicArtifacts/schema.ts'
import { createPublicRankingManifestLoader } from '../src/lib/publicArtifacts/manifestLoader.ts'

const generatedArtifactTest = existsSync('.generated/ranking-data/ranking-summary.json') ? test : test.skip

generatedArtifactTest('manifest loader deduplicates concurrent bootstrap and hook requests', async () => {
  const manifestJson = await readFile('.generated/ranking-data/ranking-summary.json', 'utf8')
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

generatedArtifactTest('manifest loader retries after a shared request rejects', async () => {
  const manifestJson = await readFile('.generated/ranking-data/ranking-summary.json', 'utf8')
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

generatedArtifactTest('snapshot loading repairs a cached shard from an older publish', async () => {
  const manifest = parsePublicRankingManifest(JSON.parse(await readFile('.generated/ranking-data/ranking-summary.json', 'utf8')))
  const key = '2026__All__All'
  const expected = manifest.snapshotIndex[key]
  const shard = parsePublicRankingShard(JSON.parse(await readFile('.generated/ranking-data/scopes/season-2026.json', 'utf8')))
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
