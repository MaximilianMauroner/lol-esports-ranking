import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { renderHomepagePrerenderFromPublicData, RIOT_PROJECT_NOTICE } from '../scripts/seo-prerender.ts'
import { preferredPublicSnapshotKey } from '../src/lib/defaultScope.ts'

test('homepage prerender includes ranking snapshot content from public artifacts', async () => {
  const html = await renderHomepagePrerenderFromPublicData()

  assert.match(html, /<h1>LoL Esports Power Index<\/h1>/)
  assert.match(html, /Top teams/)
  assert.match(html, /Region power/)
  assert.match(html, /Bilibili Gaming|Gen\.G|T1|Hanwha Life Esports/)
  assert.match(html, /Oracle&#39;s Elixir primary with Leaguepedia Cargo gap-fill/)
  assert.match(html, new RegExp(escapeRegExp(escapedNotice())))
  assert.doesNotMatch(html, /<script\b/i)

  const manifest = JSON.parse(await readFile('public/data/ranking-summary.json', 'utf8'))
  const expectedKey = preferredPublicSnapshotKey(Object.keys(manifest.snapshotIndex), manifest.defaultSnapshotKey)
  assert.ok(expectedKey)
  assert.match(html, new RegExp(`data-snapshot-key="${escapeRegExp(expectedKey)}"`))
  const shardPath = manifest.snapshotIndex[expectedKey].url.split('?', 1)[0].replace(/^\/data\//, 'public/data/')
  const shard = JSON.parse(await readFile(shardPath, 'utf8')) as {
    standings: Array<{ team: string; eligibility?: { eligible?: boolean } }>
  }
  const topTeams = shard.standings.filter((standing) => standing.eligibility?.eligible !== false).slice(0, 5)
  let lastPosition = -1
  for (const team of topTeams) {
    const position = html.indexOf(escapeHtml(team.team))
    assert.ok(position > lastPosition, `${team.team} should appear in current-scope rank order`)
    lastPosition = position
  }
})

function escapedNotice() {
  return RIOT_PROJECT_NOTICE
    .replace(/&/g, '&amp;')
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
