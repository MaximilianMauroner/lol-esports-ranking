import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createServer, type Plugin } from 'vite'
import { createStaticRankingData } from '../src/domains/rankings/internal/projections/snapshot.ts'
import { createPublicArtifactWritePlan, publicMatchHistoryShardPath } from '../src/domains/rankings/internal/published/writePlan.ts'
import { parsePublicMatchHistoryCatalog } from '../src/domains/rankings/internal/published/schema.ts'
import type { MatchRecord } from '../src/domains/rankings/types.ts'

test('prefetching an older match page retains the loaded page on screen', { timeout: 60_000 }, async () => {
  const matches: MatchRecord[] = Array.from({ length: 450 }, (_, index) => {
    const datetimeUtc = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString()
    return {
      id: `prefetch-game-${index}`, officialMatchId: `prefetch-series-${index}`, sourceProvider: 'seed',
      date: datetimeUtc.slice(0, 10), datetimeUtc, season: 2026, event: 'Synthetic page retention',
      phase: 'Regular season', region: 'LCK', league: 'LCK', patch: '',
      teamAKills: 10, teamBKills: 5, teamAGold: 60_000, teamBGold: 55_000,
      bestOf: 1, bestOfBasis: 'provider', tier: 'regional-regular',
      teamA: 'Alpha', teamB: 'Beta', winner: index % 2 ? 'Alpha' : 'Beta',
    }
  })
  const data = createStaticRankingData({
    matches, teams: {
      Alpha: { name: 'Alpha', code: 'ALP', league: 'LCK', region: 'LCK' },
      Beta: { name: 'Beta', code: 'BET', league: 'LCK', region: 'LCK' },
    }, rosters: {}, generatedAt: '2026-01-02T00:00:00.000Z', dataMode: 'seeded-sample',
    materializeSnapshotKeys: new Set(['All__All__All']), materializeTournamentIds: new Set(),
  })
  const plan = createPublicArtifactWritePlan(data)
  const catalogWrite = plan.writes.find((write) => write.relativePath === publicMatchHistoryShardPath('All__All__All'))
  assert.ok(catalogWrite)
  const catalog = parsePublicMatchHistoryCatalog(catalogWrite.value)
  assert.equal(catalog.seriesCount, 450)
  assert.equal(catalog.pages.length, 18)
  const oldestPage = catalog.pages.find((page) => page.page === catalog.series.at(-1)?.page)
  assert.ok(oldestPage)
  const oldestPath = new URL(oldestPage.url, 'http://fixture.invalid').pathname
  const bodies = new Map(plan.writes.map((write) => [`/data/${write.relativePath}`, write.contents]))
  const fixture: Plugin = { name: 'match-page-prefetch-fixture', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
      if (!path.startsWith('/data/')) return next()
      const body = bodies.get(path)
      response.setHeader('content-type', 'application/json')
      response.statusCode = body ? 200 : 404
      response.end(body ?? '{}')
    })
  } }
  const server = await createServer({ publicDir: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, plugins: [fixture] })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer!.address()
    assert.ok(address && typeof address !== 'string')
    const executablePath = chromium.executablePath()
    browser = await chromium.launch(existsSync(executablePath) ? { headless: true } : { headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const connection = { saveData: false, effectiveType: '4g', downlink: 10 }
    await page.addInitScript((settings) => {
      Object.defineProperty(navigator, 'connection', { configurable: true, value: settings })
    }, connection)
    await page.bringToFront()
    const errors: string[] = []
    const requests: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith('/data/')) requests.push(path)
    })
    const next = page.getByRole('button', { name: 'Next page', exact: true })
    const rows = page.locator('table tbody tr')
    await page.goto(`http://127.0.0.1:${address.port}/#matches?scope=all`)
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible')
    assert.deepEqual(await page.evaluate(() => Object.getOwnPropertyDescriptor(navigator, 'connection')?.value), connection)
    await rows.nth(24).waitFor()
    for (let currentPage = 2; currentPage <= 16; currentPage++) {
      await next.click()
      await page.getByText(`Page ${currentPage} of 18`, { exact: true }).waitFor()
      await rows.nth(24).waitFor()
      const heading = page.getByRole('heading', { name: 'Series ledger' })
      assert.ok(await heading.evaluate((node) => {
        const top = node.getBoundingClientRect().top
        const headerBottom = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0
        return top >= headerBottom && top < innerHeight / 2
      }), 'Explicit pagination returns to the results heading below the sticky navigation')
    }
    const prefetched = page.waitForResponse((response) => new URL(response.url()).pathname === oldestPath).catch(async (error: unknown) => {
      const eligibility = await page.evaluate(() => ({
        visibility: document.visibilityState,
        connection: Object.getOwnPropertyDescriptor(navigator, 'connection')?.value,
      }))
      console.error('Match page prefetch diagnostics:', JSON.stringify({ oldestPath, requests, eligibility, rows: await rows.count(), errors }))
      throw error
    })
    await next.click()
    await page.getByText('Page 17 of 18', { exact: true }).waitFor()
    assert.equal((await prefetched).status(), 200)
    await rows.nth(24).waitFor({ timeout: 5_000 })
    assert.equal(await rows.count(), 25, 'Next-page prefetch must retain all 25 visible series')
    assert.equal(await page.getByText('Loading matches', { exact: true }).count(), 0)
    const first = page.getByRole('button', { name: 'First page', exact: true })
    await first.hover()
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await rows.nth(24).waitFor({ timeout: 5_000 })
    assert.equal(await rows.count(), 25, 'Hover prefetch must retain all 25 visible series')
    await first.focus()
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await rows.nth(24).waitFor({ timeout: 5_000 })
    assert.equal(await rows.count(), 25, 'Focus prefetch must retain all 25 visible series')
    await page.getByText('Page 17 of 18', { exact: true }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await browser?.close(); await server.close() }
})
