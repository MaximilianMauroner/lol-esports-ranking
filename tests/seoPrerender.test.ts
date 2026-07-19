import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import { renderHomepagePrerenderFromDataDir, RIOT_PROJECT_NOTICE } from '../scripts/seo-prerender.ts'
import { preferredPublicSnapshotKey } from '../src/lib/defaultScope.ts'
import { shouldHoldPrerenderForManifest, showsManifestErrorInAppShell } from '../src/lib/bootstrap.ts'
import { PUBLIC_ARTIFACT_FIXTURE_DIR } from './fixtures/publicArtifactBundle.ts'

test('homepage prerender includes ranking snapshot content from public artifacts', async () => {
  const html = await renderHomepagePrerenderFromDataDir(PUBLIC_ARTIFACT_FIXTURE_DIR)

  assert.match(html, /<h1>LoL Esports Power Index<\/h1>/)
  assert.match(html, /Region power/)
  assert.match(html, /deterministic public artifact test fixture/)
  assert.doesNotMatch(html, /Seeded sample data is loaded/)
  assert.match(html, new RegExp(escapeRegExp(escapedNotice())))
  assert.doesNotMatch(html, /<script\b/i)

  const manifest = JSON.parse(await readFile(join(PUBLIC_ARTIFACT_FIXTURE_DIR, 'ranking-summary.json'), 'utf8'))
  const expectedKey = preferredPublicSnapshotKey(Object.keys(manifest.snapshotIndex), manifest.defaultSnapshotKey)
  assert.ok(expectedKey)
  assert.match(html, new RegExp(`data-snapshot-key="${escapeRegExp(expectedKey)}"`))
  const shardPath = join(PUBLIC_ARTIFACT_FIXTURE_DIR, manifest.snapshotIndex[expectedKey].url.split('?', 1)[0].replace(/^\/data\//, ''))
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

test('Tailwind emits utilities owned only by the prerender source file', async () => {
  const stylesheet = await readFile('src/index.css', 'utf8')
  assert.match(stylesheet, /@source\s+["']\.\.\/scripts\/seo-prerender\.ts["']/)

  const vite = await createServer({
    appType: 'custom',
    configFile: 'vite.config.ts',
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  try {
    const transformed = await vite.transformRequest('/src/index.css')
    assert.ok(transformed)
    assert.match(transformed.code, /max-width:\s*1080px/)
  } finally {
    await vite.close()
  }
})

test('only ranking startup holds the prerender while the manifest loads', () => {
  assert.equal(shouldHoldPrerenderForManifest('', '/', false), true)
  assert.equal(shouldHoldPrerenderForManifest('#rankings?scope=season%3A2026', '/', false), true)
  assert.equal(shouldHoldPrerenderForManifest('#teams?scope=season%3A2026', '/', false), true)
  assert.equal(shouldHoldPrerenderForManifest('#matches', '/', false), false)
  assert.equal(shouldHoldPrerenderForManifest('#regions', '/', false), false)
  assert.equal(shouldHoldPrerenderForManifest('', '/matches', false), false)
  assert.equal(shouldHoldPrerenderForManifest('', '/teams', false), true)
  assert.equal(shouldHoldPrerenderForManifest('', '/', true), false)
})

test('non-ranking manifest errors stay in the app shell', () => {
  assert.equal(showsManifestErrorInAppShell('matches'), true)
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
