import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createServer, type Plugin } from 'vite'
import { createStaticRankingData } from '../src/domains/rankings/internal/projections/snapshot.ts'
import { createPublicArtifactWritePlan, publicMatchHistoryShardPath } from '../src/domains/rankings/internal/published/writePlan.ts'
import { createGenerationManifest, prepareSemanticArtifact } from '../scripts/public-artifact-storage.mjs'
import type { MatchRecord } from '../src/domains/rankings/types.ts'

test('Matches event choices and addressed pages survive catalog loading and real document reloads', { timeout: 90_000 }, async (t) => {
  const matches: MatchRecord[] = Array.from({ length: 66 }, (_, index) => {
    const year = index < 31 ? 2025 : 2026
    const event = index < 27 ? 'DCup 2025' : index === 27 ? 'Demacia Cup 2025' : index < 31 ? 'Unknown Invitational 2025' : index === 65 ? 'First Stand 2026' : 'LCK 2026 Spring'
    const league = index < 28 ? 'LPL' : index < 31 ? 'LEC' : index === 65 ? 'FST' : 'LCK'
    const region = index < 28 ? 'LPL' : index < 31 ? 'LEC' : index === 65 ? 'International' : 'LCK'
    const datetimeUtc = new Date(Date.UTC(year, 0, 1) + index * 60_000).toISOString()
    return {
      id: `matches-address-game-${index}`, officialMatchId: `matches-address-series-${index}`,
      sourceProvider: index === 27 ? 'leaguepedia-cargo' : 'oracles-elixir',
      date: datetimeUtc.slice(0, 10), datetimeUtc, season: year, event, league, region,
      phase: 'Regular season', patch: '', bestOf: 1, bestOfBasis: 'provider', tier: 'regional-regular',
      teamAKills: 10, teamBKills: 5, teamAGold: 60_000, teamBGold: 55_000,
      teamA: 'Alpha', teamB: 'Beta', winner: index % 2 ? 'Alpha' : 'Beta',
    }
  })
  const data = createStaticRankingData({
    matches, teams: {
      Alpha: { name: 'Alpha', code: 'ALP', league: 'LCK', region: 'LCK' },
      Beta: { name: 'Beta', code: 'BET', league: 'LCK', region: 'LCK' },
    }, rosters: {}, generatedAt: '2026-02-01T00:00:00.000Z', dataMode: 'seeded-sample',
  })
  const plan = createPublicArtifactWritePlan(data)
  const entries: Array<{ logicalPath: string; digest: string; bytes: number }> = []
  const objects = new Map<string, string>()
  for (const write of plan.writes) {
    const prepared = prepareSemanticArtifact(write.value)
    entries.push({ logicalPath: `/data/${write.relativePath}`, digest: prepared.digest, bytes: prepared.bytes })
    for (const object of [...(prepared.children ?? []), prepared]) objects.set(`/data/objects/sha256/${object.digest}`, object.canonicalJson)
  }
  const meta = plan.manifest.artifactMeta
  assert.ok(meta)
  const manifest = createGenerationManifest({ generationId: meta.runId, rootManifest: plan.manifest, entries })
  const catalogEntry = entries.find((entry) => entry.logicalPath === `/data/${publicMatchHistoryShardPath('All__All__All')}`)
  assert.ok(catalogEntry)
  const catalogPath = `/data/objects/sha256/${catalogEntry.digest}`
  const snapshotUrl = new URL(plan.manifest.snapshotIndex['2026__All__All'].url, 'http://fixture.invalid')
  const snapshotEntry = entries.find((entry) => entry.logicalPath === snapshotUrl.pathname)
  assert.ok(snapshotEntry)
  const snapshotPath = `/data/objects/sha256/${snapshotEntry.digest}`
  const checkpointUrl = new URL(plan.manifest.snapshotIndex['2026__All__All__split-1'].url, 'http://fixture.invalid')
  const checkpointEntry = entries.find((entry) => entry.logicalPath === checkpointUrl.pathname)
  assert.ok(checkpointEntry)
  const checkpointPath = `/data/objects/sha256/${checkpointEntry.digest}`
  let holdCatalog = false
  const pendingCatalog: Array<() => void> = []
  let holdSnapshot = false
  const pendingSnapshot: Array<() => void> = []
  const fixture: Plugin = { name: 'matches-address-fixture', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
      if (!path.startsWith('/data/')) return next()
      const body = path === '/data/ranking-summary.json' ? JSON.stringify(manifest) : objects.get(path)
      response.setHeader('content-type', 'application/json')
      response.statusCode = body ? 200 : 404
      if (holdCatalog && path === catalogPath) { pendingCatalog.push(() => response.end(body)); return }
      if (holdSnapshot && (path === snapshotPath || path === checkpointPath)) { pendingSnapshot.push(() => response.end(body)); return }
      response.end(body ?? '{}')
    })
  } }
  const server = await createServer({ publicDir: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, plugins: [fixture] })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer!.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const executablePath = chromium.executablePath()
    browser = await chromium.launch(existsSync(executablePath) ? { headless: true } : { headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.setDefaultTimeout(5_000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const rows = page.locator('table tbody tr')
    const pager = page.getByLabel('Match history pagination', { exact: true })
    const pageTwo = '#matches?scope=all&matchesYear=2025&event=DCup+2025&page=2'
    let documentId = 0
    async function navigate(hash: string) {
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto(`${base}/?matchesCase=${++documentId}${hash}`)
    }

    await t.test('distinct Event labels retain raw filtering and fit narrow layouts', async () => {
      await navigate('#matches?scope=all&matchesYear=2025')
      const event = page.getByRole('combobox', { name: 'Event', exact: true })
      await event.waitFor()
      const options = await event.locator('option').evaluateAll((options) => options.map((option) => ({ value: option.getAttribute('value'), label: option.textContent })))
      assert.ok(options.some((option) => option.value === 'DCup 2025' && option.label === 'Demacia Cup 2025 · 27 series (DCup 2025)'))
      assert.ok(options.some((option) => option.value === 'Demacia Cup 2025' && option.label === 'Demacia Cup 2025 · 1 series (Demacia Cup 2025)'))
      assert.ok(options.some((option) => option.value === 'Unknown Invitational 2025' && option.label === option.value))
      assert.equal(new Set(options.map((option) => option.label)).size, options.length)
      await event.selectOption('Demacia Cup 2025')
      await rows.first().getByText('Leaguepedia', { exact: true }).waitFor()
      assert.equal(await rows.count(), 1)
      await pager.getByText('1–1 of 1', { exact: true }).waitFor()
      await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('event') === 'Demacia Cup 2025')
      await event.selectOption('DCup 2025')
      await rows.nth(24).getByText("Oracle's Elixir", { exact: true }).waitFor()
      await pager.getByText('1–25 of 27', { exact: true }).waitFor()
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 })
        await page.waitForFunction(() => !document.querySelector('[aria-label="Match history results"] table'))
        assert.equal(await event.inputValue(), 'DCup 2025')
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no overflow at ${width}px`)
        await event.selectOption('Demacia Cup 2025')
        await pager.getByText('1–1 of 1', { exact: true }).waitFor()
        await page.getByLabel('Match history results').getByText(/Leaguepedia/).filter({ visible: true }).first().waitFor()
        await event.selectOption('DCup 2025')
        await pager.getByText('1–25 of 27', { exact: true }).waitFor()
      }
      await page.setViewportSize({ width: 1280, height: 800 })
    })

    await t.test('pager links, actual reload and fresh documents retain the two-row final page', async () => {
      await navigate('#matches?scope=all&matchesYear=2025&event=DCup+2025')
      await rows.nth(24).waitFor()
      await page.getByRole('button', { name: 'Next page', exact: true }).click()
      await pager.getByText('26–27 of 27', { exact: true }).waitFor()
      await rows.nth(1).waitFor()
      assert.equal(await rows.count(), 2)
      await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('page') === '2')
      const firstRows = await rows.allTextContents()
      const before = await page.evaluate(() => performance.timeOrigin)
      await page.reload()
      await pager.getByText('Page 2 of 2', { exact: true }).waitFor()
      await rows.nth(1).waitFor()
      assert.equal(await rows.count(), 2)
      assert.notEqual(await page.evaluate(() => performance.timeOrigin), before)
      assert.deepEqual(await rows.allTextContents(), firstRows)
      assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('page'), '2')
      const fresh = await browser!.newPage()
      try {
        await fresh.goto(`${base}/${pageTwo}`)
        await fresh.getByText('Page 2 of 2', { exact: true }).waitFor({ timeout: 5_000 })
        await fresh.locator('table tbody tr').nth(1).waitFor()
        assert.equal(await fresh.locator('table tbody tr').count(), 2)
        assert.equal(new URLSearchParams(new URL(fresh.url()).hash.split('?')[1]).get('page'), '2')
      } finally { await fresh.close() }
    })

    await t.test('delayed catalogs retain valid pages and clamp out-of-range pages only after loading', async () => {
      for (const requested of [2, 99]) {
        holdCatalog = true
        const requestedCatalog = page.waitForRequest((request) => new URL(request.url()).pathname === catalogPath)
        await navigate(pageTwo.replace('page=2', `page=${requested}`))
        await requestedCatalog
        await page.getByText('Loading match history', { exact: true }).waitFor()
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('page'), String(requested), 'loading must not erase or clamp the addressed page')
        holdCatalog = false
        pendingCatalog.splice(0).forEach((respond) => respond())
        await pager.getByText('Page 2 of 2', { exact: true }).waitFor()
        await rows.nth(1).waitFor()
        assert.equal(await rows.count(), 2)
        await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('page') === '2')
      }
      await navigate('#matches?scope=all&matchesYear=2025&team=Nobody&page=7')
      await page.getByText('No series match these filters', { exact: true }).waitFor()
      await pager.getByText('Page 1 of 1', { exact: true }).waitFor()
      await page.waitForFunction(() => !new URLSearchParams(location.hash.split('?')[1]).has('page'))
    })

    await t.test('compatible league changes retain events while filters, years and scopes reset pages', async () => {
      await navigate(pageTwo)
      await pager.getByText('Page 2 of 2', { exact: true }).waitFor()
      await page.getByRole('combobox', { name: 'League', exact: true }).selectOption('LPL')
      await pager.getByText('Page 1 of 2', { exact: true }).waitFor()
      assert.equal(await page.getByRole('combobox', { name: 'Event', exact: true }).inputValue(), 'DCup 2025')
      await pager.getByText('1–25 of 27', { exact: true }).waitFor()
      await page.getByRole('combobox', { name: 'League', exact: true }).selectOption('LEC')
      assert.equal(await page.getByRole('combobox', { name: 'Event', exact: true }).inputValue(), 'All')
      await pager.getByText('1–3 of 3', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
      await page.getByRole('button', { name: 'Next page', exact: true }).click()
      await pager.getByText('Page 2 of 2', { exact: true }).waitFor()
      await page.getByLabel('Match history year').selectOption('2026')
      await pager.getByText('1–25 of 35', { exact: true }).waitFor()
      await pager.getByText('Page 1 of 2', { exact: true }).waitFor()
      await page.getByLabel('Match history year').selectOption('2025')
      await pager.getByText('1–25 of 31', { exact: true }).waitFor()
      await pager.getByText('Page 1 of 2', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Next page', exact: true }).click()
      await pager.getByText('Page 2 of 2', { exact: true }).waitFor()
      await page.getByLabel('Season', { exact: true }).selectOption('2025')
      await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('scope') === 'season:2025')
      await pager.getByText('Page 1 of 2', { exact: true }).waitFor()
      await page.getByLabel('Season', { exact: true }).selectOption('All')
      await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('scope') === 'all')
      await pager.getByText('Page 1 of 2', { exact: true }).waitFor()
      await page.waitForFunction(() => !new URLSearchParams(location.hash.split('?')[1]).has('page'))
    })

    await t.test('user scope changes reset pages across cold snapshot remounts without changing addressed navigation', async () => {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } })
      })
      holdSnapshot = true
      await navigate('#matches?scope=all&page=2')
      await rows.nth(24).waitFor()
      await pager.getByText('Page 2 of 3', { exact: true }).waitFor()
      await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('page') === '2')
      const requestedSnapshot = page.waitForRequest((request) => new URL(request.url()).pathname === snapshotPath)
      await page.getByLabel('Season', { exact: true }).selectOption('2026')
      await requestedSnapshot
      await page.getByText('Loading 2026 source season', { exact: true }).waitFor()
      await page.waitForFunction(() => !document.querySelector('[aria-label="Match history results"]'))
      assert.ok(pendingSnapshot.length > 0, 'the selected scope must require an uncached snapshot')
      holdSnapshot = false
      pendingSnapshot.splice(0).forEach((respond) => respond())
      await pager.getByText(/Page [12] of 2/).waitFor()
      await rows.nth(9).waitFor()
      console.log('Cold scope control receipt:', JSON.stringify({ hash: new URL(page.url()).hash, pager: await pager.innerText(), rows: await rows.count(), errors }))
      await pager.getByText('Page 1 of 2', { exact: true }).waitFor()
      await pager.getByText('1–25 of 35', { exact: true }).waitFor()
      assert.equal(await rows.count(), 25)
      await page.waitForFunction(() => !new URLSearchParams(location.hash.split('?')[1]).has('page'))

      await page.getByRole('button', { name: 'Next page', exact: true }).click()
      await pager.getByText('Page 2 of 2', { exact: true }).waitFor()
      await page.getByLabel('Season', { exact: true }).selectOption('2026')
      await pager.getByText('Page 2 of 2', { exact: true }).waitFor()
      assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('page'), '2', 'selecting the current scope is a no-op')

      holdSnapshot = true
      const requestedCheckpoint = page.waitForRequest((request) => new URL(request.url()).pathname === checkpointPath)
      await page.getByRole('button', { name: 'Split 1', exact: true }).click()
      await requestedCheckpoint
      await page.waitForFunction(() => !document.querySelector('[aria-label="Match history results"]'))
      assert.ok(pendingSnapshot.length > 0, 'the checkpoint must also require an uncached snapshot')
      holdSnapshot = false
      pendingSnapshot.splice(0).forEach((respond) => respond())
      await pager.getByText('Page 1 of 2', { exact: true }).waitFor()
      await rows.nth(24).waitFor()
      await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('scope') === 'season:2026:checkpoint:split-1' && !new URLSearchParams(location.hash.split('?')[1]).has('page'))
      await page.getByRole('button', { name: 'Next page', exact: true }).click()
      await pager.getByText('Page 2 of 2', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Split 1', exact: true }).click()
      await pager.getByText('Page 2 of 2', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Full year', exact: true }).click()
      await pager.getByText('Page 1 of 2', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Next page', exact: true }).click()
      await pager.getByText('Page 2 of 2', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Split 1', exact: true }).click()
      await pager.getByText('Page 1 of 2', { exact: true }).waitFor()

      await page.getByLabel('Season', { exact: true }).selectOption('All')
      await pager.getByText('Page 1 of 3', { exact: true }).waitFor()
      await rows.nth(24).waitFor()
      await page.getByRole('button', { name: 'Next page', exact: true }).click()
      await pager.getByText('Page 2 of 3', { exact: true }).waitFor()
      await page.getByLabel('Season', { exact: true }).selectOption('2026')
      await pager.getByText('Page 1 of 2', { exact: true }).waitFor()

      await navigate('#matches?scope=all')
      await pager.getByText('Page 1 of 3', { exact: true }).waitFor()
      await page.evaluate(() => { location.hash = '#matches?scope=season:2026&page=2' })
      await pager.getByText('Page 2 of 2', { exact: true }).waitFor()
      await rows.nth(9).waitFor()
      assert.equal(await rows.count(), 10)
      assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('page'), '2', 'address restoration must keep its explicitly requested page')
    })
    assert.deepEqual(errors, [])
  } finally {
    holdCatalog = false
    pendingCatalog.splice(0).forEach((respond) => respond())
    holdSnapshot = false
    pendingSnapshot.splice(0).forEach((respond) => respond())
    await browser?.close()
    await server.close()
  }
})
