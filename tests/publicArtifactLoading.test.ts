import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fetchPublicSnapshotShard } from '../src/lib/publicArtifacts/resolver.ts'
import { parsePublicRankingManifest, parsePublicRankingShard } from '../src/lib/publicArtifacts/schema.ts'

test('snapshot loading repairs a cached shard from an older publish', async () => {
  const manifest = parsePublicRankingManifest(JSON.parse(await readFile('public/data/ranking-summary.json', 'utf8')))
  const key = '2026__All__All'
  const expected = manifest.snapshotIndex[key]
  const shard = parsePublicRankingShard(JSON.parse(await readFile('public/data/scopes/season-2026.json', 'utf8')))
  const staleShard = { ...shard, matchCount: shard.matchCount - 1 }
  const requests: Array<{ url: string; cache?: RequestCache }> = []
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
