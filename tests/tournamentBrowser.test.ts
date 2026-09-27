import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createServer, type Plugin } from 'vite'

const at = '2026-09-27T12:00:00.000Z'
const tournamentPath = '/data/tournaments/feed.json'
const healthPath = `${tournamentPath}.health.json`

function team(id: string, name: string, gameWins: number | null = null, outcome: string | null = null) {
  return { id, name, code: name.slice(0, 3).toUpperCase(), gameWins, outcome }
}

function series(id: string, eventId: string, teams: ReturnType<typeof team>[], status: string, sourceState: string) {
  return { id, eventId, startTime: '2026-09-27T13:00:00.000Z', stage: 'Playoffs', status, sourceState, bestOf: 5, teams, vodUrls: [] }
}

function fixtureFeed() {
  return {
    version: 1, source: 'lolesports-persisted-site-api', unsupportedApi: true, dataMode: 'synthetic-fixture',
    fetchedAt: at, sourceUpdatedAt: null,
    coverage: { start: '2026-09-13T00:00:00.000Z', end: '2026-11-12T23:59:59.999Z', complete: true, warnings: [] as string[] },
    events: [
      { id: 'lcs:2026:fixture-lcs', sourceTournamentId: 'fixture-lcs', competition: 'lcs', label: 'LCS 2026', season: '2026',
        series: [series('lcs-series', 'lcs:2026:fixture-lcs', [team('alpha', 'Alpha'), team('beta', 'Beta')], 'live', 'inProgress')] },
      { id: 'worlds:2026', sourceTournamentId: 'fixture-worlds', competition: 'worlds', label: 'Worlds 2026', season: '2026',
        series: [series('worlds-series', 'worlds:2026', [team('gamma', 'Gamma'), team('delta', 'Delta')], 'upcoming', 'unstarted')] },
    ],
  }
}

test('tournament browser follows deep links, updates, stale state, recovery and a narrow layout without provider calls', { timeout: 60_000 }, async () => {
  process.env.VITE_TOURNAMENT_HUB_ENABLED = '1'
  const feed = fixtureFeed()
  let health = { checkedAt: at, complete: true, warnings: [] as string[] }
  let feedStatus = 200
  const dataRequests: string[] = []
  const fixturePlugin: Plugin = {
    name: 'tournament-browser-fixture',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        if (!path.startsWith('/data/')) return next()
        dataRequests.push(path)
        response.setHeader('content-type', 'application/json')
        response.statusCode = path === tournamentPath ? feedStatus : path === healthPath ? 200 : 503
        response.end(JSON.stringify(path === tournamentPath ? feed : path === healthPath ? health : { error: 'ranking artifacts unavailable' }))
      })
    },
  }
  const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, plugins: [fixturePlugin] })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const executablePath = chromium.executablePath()
    browser = await chromium.launch(existsSync(executablePath) ? { headless: true } : { headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, timezoneId: 'Europe/Vienna' })
    const externalRequests: string[] = []
    page.on('request', (request) => { if (!request.url().startsWith(base)) externalRequests.push(request.url()) })
    await page.clock.install({ time: new Date(at) })

    await page.goto(`${base}/#tournaments?event=worlds%3A2026`)
    await page.getByRole('heading', { name: 'Worlds 2026' }).waitFor()
    assert.match(await page.locator('body').innerText(), /Gamma.*Delta/)
    assert.match(await page.locator('body').innerText(), /Local synthetic fixture\. These are not official/)
    assert.match(await page.locator('body').innerText(), /Forecast unavailable: rules not verified/)
    assert.ok(dataRequests.includes(tournamentPath))
    assert.ok(dataRequests.every((path) => path === tournamentPath || path === healthPath), `Unexpected data requests: ${dataRequests}`)
    assert.deepEqual(externalRequests, [])

    await page.locator('#tournament-event').selectOption('lcs:2026:fixture-lcs')
    await page.getByRole('heading', { name: 'LCS 2026' }).waitFor()
    assert.match(page.url(), /event=lcs%3A2026%3Afixture-lcs/)
    assert.match(await page.locator('body').innerText(), /Alpha.*Beta/)
    await page.goBack()
    await page.getByRole('heading', { name: 'Worlds 2026' }).waitFor()
    assert.equal(await page.locator('#tournament-event').inputValue(), 'worlds:2026')
    await page.goForward()
    await page.getByRole('heading', { name: 'LCS 2026' }).waitFor()
    assert.equal(await page.locator('#tournament-event').inputValue(), 'lcs:2026:fixture-lcs')

    feed.events[0]!.series[0] = series('lcs-series', 'lcs:2026:fixture-lcs', [team('alpha', 'Alpha', 3, 'win'), team('beta', 'Beta', 1, 'loss')], 'completed', 'completed')
    feed.fetchedAt = '2026-09-27T12:01:00.000Z'
    health.checkedAt = feed.fetchedAt
    await page.clock.fastForward(60_000)
    await page.getByText('Alpha 3–1 Beta').waitFor()
    assert.match(await page.locator('section[aria-label="results"]').innerText(), /Alpha 3–1 Beta/)

    health = { checkedAt: '2026-09-27T12:02:00.000Z', complete: false, warnings: ['Synthetic provider outage.'] }
    await page.clock.fastForward(60_000)
    await page.getByText(/Schedule may be stale/).waitFor()
    assert.match(await page.locator('body').innerText(), /Synthetic provider outage/)
    assert.match(await page.locator('body').innerText(), /Alpha 3–1 Beta/)

    health = { checkedAt: '2026-09-27T12:03:00.000Z', complete: true, warnings: [] }
    await page.clock.fastForward(60_000)
    await page.getByText(/Schedule may be stale/).waitFor({ state: 'hidden' })
    feedStatus = 503
    await page.clock.fastForward(60_000)
    await page.getByText(/Schedule may be stale/).waitFor()
    assert.match(await page.locator('body').innerText(), /Alpha 3–1 Beta/)

    feedStatus = 200
    health = { checkedAt: '2026-09-27T12:05:00.000Z', complete: true, warnings: [] }
    await page.clock.fastForward(60_000)
    await page.getByText(/Schedule may be stale/).waitFor({ state: 'hidden' })
    const originalEvents = feed.events
    feed.events = []
    feed.fetchedAt = '2026-09-27T12:06:00.000Z'
    health.checkedAt = feed.fetchedAt
    await page.clock.fastForward(60_000)
    await page.getByText('No supported tournament is in the available schedule window.').waitFor()
    assert.equal(await page.locator('#tournament-event').inputValue(), '')
    feed.events = originalEvents
    feed.fetchedAt = '2026-09-27T12:07:00.000Z'
    health.checkedAt = feed.fetchedAt
    await page.clock.fastForward(60_000)
    await page.getByRole('heading', { name: 'LCS 2026' }).waitFor()
    assert.equal(await page.locator('#tournament-event').inputValue(), 'lcs:2026:fixture-lcs')

    await page.locator('a[href="#main-content"]').focus()
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'main-content')
    for (const width of [320, 390, 768, 1024, 1280]) {
      await page.setViewportSize({ width, height: 800 })
      const layout = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }))
      assert.ok(layout.content <= layout.viewport, `Horizontal overflow at ${width}px: ${JSON.stringify(layout)}`)
    }
    assert.deepEqual(externalRequests, [])
  } finally {
    await browser?.close()
    await server.close()
    delete process.env.VITE_TOURNAMENT_HUB_ENABLED
  }
})
