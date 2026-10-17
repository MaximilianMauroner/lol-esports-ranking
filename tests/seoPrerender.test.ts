import { join } from 'node:path'
import { referencePublicDataDir, referencePublicDir } from '../scripts/reference-public-data.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { renderFallbackHomepagePrerender, renderHomepagePrerender, renderHomepagePrerenderFromPublicData, RIOT_PROJECT_NOTICE } from '../scripts/seo-prerender.ts'
import { preferredPublicSnapshotKey } from '../src/lib/defaultScope.ts'
import { showsManifestErrorInAppShell } from '../src/lib/bootstrap.ts'

test('homepage prerender includes ranking snapshot content from public artifacts', async () => {
  const html = await renderHomepagePrerenderFromPublicData(join(referencePublicDir, '..'))

  assert.match(html, /<h1>LoL Esports Power Index<\/h1>/)
  assert.match(html, /Top teams/)
  assert.match(html, /Region power/)
  assert.match(html, /Bilibili Gaming|Gen\.G|T1|Hanwha Life Esports/)
  assert.match(html, new RegExp(escapeRegExp(escapedNotice())))
  assert.doesNotMatch(html, /<script\b/i)

  const manifest = JSON.parse(await readFile(join(referencePublicDataDir, 'ranking-summary.json'), 'utf8'))
  assert.ok(html.includes(`Source: ${escapeHtml(manifest.source)}`))
  const expectedKey = preferredPublicSnapshotKey(Object.keys(manifest.snapshotIndex), manifest.defaultSnapshotKey)
  assert.ok(expectedKey)
  assert.match(html, new RegExp(`data-snapshot-key="${escapeRegExp(expectedKey)}"`))
  const shardPath = manifest.snapshotIndex[expectedKey].url.split('?', 1)[0].replace(/^\/data\//, `${referencePublicDataDir}/`)
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

test('Tailwind scans utilities owned only by the prerender source file', async () => {
  const [stylesheet, prerenderSource] = await Promise.all([
    readFile('src/index.css', 'utf8'),
    readFile('scripts/seo-prerender.ts', 'utf8'),
  ])
  assert.match(stylesheet, /@source\s+["']\.\.\/scripts\/seo-prerender\.ts["']/)
  assert.match(prerenderSource, /max-w-\[1080px\]/)
})

test('visible startup stays the same across ranking refreshes and missing data', () => {
  const first = renderHomepagePrerender({
    generatedAt: '2026-10-11T12:00:00Z',
    modelVersion: 'model-one',
    source: 'first-source',
    teams: [{ team: 'First leader', rank: 1, rating: 2100 }],
    regions: [],
  })
  const refreshed = renderHomepagePrerender({
    generatedAt: '2026-10-12T12:00:00Z',
    modelVersion: 'model-two',
    source: 'second-source',
    seededSample: true,
    teams: [{ team: 'New leader', rank: 1, rating: 2300 }],
    regions: [],
  })
  const visibleStartup = (html: string) => html.split('<noscript>', 1)[0]

  assert.equal(visibleStartup(first), visibleStartup(refreshed))
  assert.equal(visibleStartup(first), visibleStartup(renderFallbackHomepagePrerender()))
  assert.match(visibleStartup(first), /Loading rankings/)
  assert.match(visibleStartup(first), /role="status".*aria-busy="true"/)
  assert.doesNotMatch(visibleStartup(first), /First leader|2,100|model-one|first-source|2026/)
  // The data-bound content remains readable when JavaScript is disabled.
  assert.match(first, /<noscript>.*First leader.*Source: first-source.*<\/noscript>/)
  assert.match(refreshed, /<noscript>.*Seeded sample data is loaded.*New leader.*<\/noscript>/)
  assert.match(first, /<noscript><style>\.homepage-startup\{display:none\}<\/style>/)
})

test('non-ranking manifest errors stay in the app shell', () => {
  assert.equal(showsManifestErrorInAppShell('matches'), true)
  assert.equal(showsManifestErrorInAppShell('tournaments'), true)
  assert.equal(showsManifestErrorInAppShell('regions'), true)
  assert.equal(showsManifestErrorInAppShell('rankings'), false)
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
