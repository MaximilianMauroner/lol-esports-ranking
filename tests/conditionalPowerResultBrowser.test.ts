import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createServer, type Plugin } from 'vite'
import { appendForecastReceipt, createPreMatchReceipt, emptyForecastLedger, pinPreMatchReceipt } from '../src/lib/tournamentForecast'
import type { TournamentFeed } from '../src/lib/tournamentFeed'
import { conditionalPowerReceiptFixture } from './fixtures/conditionalPowerFixtures'
import { conditionalPowerResultArtifact } from '../scripts/tournament-forecast-receipts'

test('offline numeric result component follows legal outcomes, keeps frozen odds and closes at live play', { timeout: 60_000 }, async () => {
  const fixture = conditionalPowerReceiptFixture()
  const originalBasis = structuredClone(fixture.basis)
  const generatedAt = fixture.generatedAt
  const componentArtifact = conditionalPowerResultArtifact({ version: 1, receipts: [fixture.receipt] })
  const forecastReceipt = createPreMatchReceipt({ series: fixture.series, basis: fixture.forecastBasis, forecastRevision: 'controlled-component',
    generatedAt, publishedAt: generatedAt, observedAt: generatedAt })
  if (forecastReceipt.status !== 'ready') throw new Error(forecastReceipt.detail)
  let forecastLedger = appendForecastReceipt(emptyForecastLedger, forecastReceipt)
  let publishComponent = false
  let feed: TournamentFeed = {
    version: 1, source: 'lolesports-persisted-site-api', unsupportedApi: true, dataMode: 'synthetic-fixture',
    fetchedAt: generatedAt, sourceUpdatedAt: null, coverage: { start: generatedAt, end: '2026-09-17T00:00:00.000Z', complete: true, warnings: [] },
    events: [{ id: fixture.series.eventId, sourceTournamentId: 'controlled-worlds', competition: 'worlds', label: 'Controlled Worlds fixture', season: '2026', series: [fixture.series] }],
  }
  const artifactBodies = new Map(fixture.plan.writes.map((write) => [`/data/${write.relativePath}`, write.contents]))
  const plugin: Plugin = { name: 'conditional-component-offline-fixture', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = new URL(request.url ?? '/', 'http://fixture').pathname
      if (artifactBodies.has(path)) {
        response.setHeader('content-type', 'application/json')
        response.end(artifactBodies.get(path))
        return
      }
      if (path === `/tournament-data/${componentArtifact.relativePath}` && publishComponent) {
        response.setHeader('content-type', 'application/json')
        response.end(componentArtifact.contents)
        return
      }
      if (!path.startsWith('/tournament-data/')) return next()
      const body = path === '/tournament-data/feed.json' ? feed
        : path === '/tournament-data/feed.json.health.json' ? { checkedAt: feed.fetchedAt, complete: true, warnings: [] }
          : path === '/tournament-data/forecasts/team-ids.json' ? fixture.forecastBasis.identityMap
            : path === '/tournament-data/forecasts/ledger.json' ? forecastLedger : null
      response.statusCode = body ? 200 : 404
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(body))
    })
  } }
  const server = await createServer({ publicDir: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, plugins: [plugin],
    define: { 'import.meta.env.VITE_TOURNAMENT_HUB_ENABLED': JSON.stringify('1'), 'import.meta.env.VITE_TOURNAMENT_FORECASTS_ENABLED': JSON.stringify('1') } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const executablePath = chromium.executablePath()
    browser = await chromium.launch(existsSync(executablePath) ? { headless: true } : { headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } })
    const external: string[] = []
    page.on('request', (request) => { if (!request.url().startsWith(base)) external.push(request.url()) })
    await page.clock.install({ time: new Date(fixture.now) })
    await page.goto(`${base}/#tournaments?event=${encodeURIComponent(fixture.series.eventId)}`)
    await page.getByText('Conditional Power preview', { exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'Power delta unavailable' }).waitFor()
    publishComponent = true
    await page.clock.fastForward(10 * 60_000 + 5_000)
    await page.getByText('Conditional Power preview', { exact: true }).click()
    const preview = page.locator('details').filter({ has: page.getByText('Conditional Power preview', { exact: true }) }).first()
    await preview.getByText('Stable-team result component · hypothetical').waitFor()
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 800 })
      for (const output of fixture.receipt.outputs) {
        await preview.getByLabel('Winner', { exact: true }).selectOption(output.outcome.winner)
        await preview.getByLabel('Series score (winner first)').selectOption(String(output.outcome.loserWins))
        const expected = output.teams.map((team) => `${team.team}: ${team.delta > 0 ? '+' : ''}${team.delta} Power points (${team.before} → ${team.after})`).join(' · ')
        assert.equal(await preview.getByRole('status').innerText(), expected)
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Component overflow at ${width}px`)
    }
    await preview.getByLabel('Winner', { exact: true }).focus()
    await page.keyboard.press('Home')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Home')
    assert.equal(await preview.getByLabel('Winner', { exact: true }).inputValue(), 'home')
    assert.equal(await preview.getByLabel('Series score (winner first)').inputValue(), '0')
    await preview.getByText('Inputs held fixed and excluded', { exact: true }).click()
    assert.match(await preview.innerText(), /statistics.*unavailable.*not invented/)
    assert.match(await preview.innerText(), /Full future Power delta unavailable/)
    const live = { ...fixture.series, status: 'live' as const, sourceState: 'inProgress', teams: fixture.series.teams.map((team, index) => ({ ...team, gameWins: index === 0 ? 1 : 0 })) }
    forecastLedger = pinPreMatchReceipt(forecastLedger, live, fixture.series.startTime!)
    feed = { ...feed, fetchedAt: fixture.series.startTime!, events: [{ ...feed.events[0]!, series: [live] }] }
    await page.clock.fastForward(50 * 60_000)
    await page.getByText('Published pre-match forecast', { exact: true }).waitFor()
    await page.getByText('Conditional Power preview', { exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'Pre-series Power previews close' }).waitFor()
    assert.equal(await page.getByLabel('Winner', { exact: true }).count(), 0)
    assert.match(await page.locator('body').innerText(), /Uses the frozen pre-series model/)
    assert.deepEqual(fixture.basis, originalBasis)
    assert.deepEqual(external, [])
  } finally { await browser?.close(); await server.close() }
})
