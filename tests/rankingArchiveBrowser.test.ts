import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createServer, type Plugin } from 'vite'
import { createStaticRankingData } from '../src/lib/snapshot.ts'
import { createPublicArtifactWritePlan } from '../src/lib/publicArtifacts/writePlan.ts'
import { createGenerationManifest, prepareSemanticArtifact } from '../scripts/public-artifact-storage.mjs'
import { archiveReferences } from '../src/lib/publicArtifacts/archive.mjs'
import type { MatchRecord } from '../src/types.ts'

test('ranking browser bootstraps without archive history, selects a year, pages, and reports missing archive objects', { timeout: 60_000 }, async () => {
  const matches: MatchRecord[] = Array.from({ length: 120 }, (_, index) => {
    const year = index < 60 ? 2025 : 2026
    const date = `${year}-01-${String(index % 28 + 1).padStart(2, '0')}`
    return { id: `sample-game-${index}`, officialMatchId: `sample-series-${index}-${'s'.repeat(6000)}`, sourceProvider: 'oracles-elixir',
      date, datetimeUtc: `${date}T12:00:00.000Z`, season: year, event: `Sample ${year}`, phase: 'Regular season', region: 'LCK', league: 'LCK',
      teamAKills: 10, teamBKills: 5, teamAGold: 60_000, teamBGold: 55_000, patch: '', bestOf: 1, bestOfBasis: 'provider', tier: 'regional-regular', teamA: 'Alpha', teamB: 'Beta', winner: index % 2 ? 'Alpha' : 'Beta' }
  })
  const data = createStaticRankingData({ matches, teams: { Alpha: { name: 'Alpha', code: 'ALP', league: 'LCK', region: 'LCK' }, Beta: { name: 'Beta', code: 'BET', league: 'LCK', region: 'LCK' } }, rosters: {}, generatedAt: '2026-10-02T00:00:00.000Z', dataMode: 'seeded-sample' })
  const plan = createPublicArtifactWritePlan(data)
  const entries: Array<{ logicalPath: string; digest: string; bytes: number }> = []
  const objects = new Map<string, string>()
  const nodesByYear = new Map<string, Set<string>>()
  for (const write of plan.writes) {
    const prepared = prepareSemanticArtifact(write.value)
    entries.push({ logicalPath: `/data/${write.relativePath}`, digest: prepared.digest, bytes: prepared.bytes })
    for (const object of [...(prepared.children ?? []), prepared]) {
      objects.set(`/data/objects/sha256/${object.digest}`, object.canonicalJson)
      for (const ref of archiveReferences(object.semantic.content)) if (ref.year) {
        if (!nodesByYear.has(ref.year)) nodesByYear.set(ref.year, new Set())
        nodesByYear.get(ref.year)!.add(`/data/objects/sha256/${ref.sha256}`)
      }
    }
  }
  const root = { ...plan.manifest }
  const meta = root.artifactMeta
  assert.ok(meta)
  const manifest = createGenerationManifest({ generationId: meta.runId, rootManifest: root, entries })
  const requests: string[] = []
  let failObjects = false
  const fixture: Plugin = { name: 'ranking-archive-browser-fixture', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
      if (!path.startsWith('/data/')) return next()
      requests.push(path)
      response.setHeader('content-type', 'application/json')
      const body = path === '/data/ranking-summary.json' ? JSON.stringify(manifest) : objects.get(path)
      response.statusCode = body && !(failObjects && path.startsWith('/data/objects/')) ? 200 : 404
      response.end(response.statusCode === 200 ? body : '{}')
    })
  } }
  const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, plugins: [fixture] })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer!.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const executablePath = chromium.executablePath()
    browser = await chromium.launch(existsSync(executablePath) ? { headless: true } : { headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    // Hold the off-screen chart observer so this assertion measures bootstrap.
    await page.addInitScript(() => { window.IntersectionObserver = class implements IntersectionObserver { readonly root = null; readonly rootMargin = '0px'; readonly scrollMargin = '0px'; readonly thresholds = []; observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } } })
    await page.goto(base)
    await page.getByRole('heading', { name: 'Team Power Index', exact: true }).waitFor()
    const bootstrap = new Set(requests)
    const historyObjects = entries.filter((entry) => /\/history\/|\/matches\//.test(entry.logicalPath) && !entry.logicalPath.endsWith('/tournament-moves/index.json')).map((entry) => `/data/objects/sha256/${entry.digest}`)
    assert.ok(historyObjects.every((path) => !bootstrap.has(path)), JSON.stringify(entries.filter((entry) => bootstrap.has(`/data/objects/sha256/${entry.digest}`)).map((entry) => entry.logicalPath)))
    requests.length = 0
    await page.goto(`${base}/#matches?scope=all&matchesYear=2026`)
    await page.getByLabel('Match history year').waitFor()
    assert.equal(await page.getByLabel('Match history year').inputValue(), '2026')
    await page.locator('table').getByText('Sample 2026', { exact: true }).first().waitFor()
    assert.ok((nodesByYear.get('2025')?.size ?? 0) > 0)
    // Catalog loading for the selected year must not hydrate old-year nodes.
    assert.ok(requests.every((path) => !nodesByYear.get('2025')?.has(path)))
    await page.getByLabel('Match history year').selectOption('2025')
    await page.locator('table').getByText('Sample 2025', { exact: true }).first().waitFor()
    await page.getByLabel('Match history year').selectOption('All')
    await page.locator('table').getByText('Sample 2026', { exact: true }).first().waitFor()
    await page.setViewportSize({ width: 390, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    failObjects = true
    await page.getByLabel('Match history year').selectOption('2025')
    await page.getByRole('button', { name: 'Retry', exact: true }).first().waitFor()
    failObjects = false
    await page.getByRole('button', { name: 'Retry', exact: true }).first().click()
    await page.getByLabel('Match history year').waitFor()
  } finally { await browser?.close(); await server.close() }
})
