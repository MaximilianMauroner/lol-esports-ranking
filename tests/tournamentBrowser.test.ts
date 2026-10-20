import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createServer, type Plugin } from 'vite'

const at = '2026-09-27T12:00:00.000Z'
const tournamentPath = '/tournament-data/feed.json'
const healthPath = `${tournamentPath}.health.json`
const longWinner = 'Northern Lights International Esports Club'
const disabledForecasts = 'Match forecasts are not enabled for this schedule.'

function team(id: string, name: string | null, gameWins: number | null = null, outcome: string | null = null) {
  return { id, name, code: name?.slice(0, 3).toUpperCase() ?? null, gameWins, outcome }
}

function series(id: string, eventId: string, teams: ReturnType<typeof team>[], status: string, sourceState: string) {
  return { id, eventId, startTime: '2026-09-27T13:00:00.000Z', stage: 'Playoffs', status, sourceState, bestOf: 5, teams, vodUrls: [] }
}

function fixtureFeed() {
  return {
    version: 1, source: 'leaguepedia-cargo', unsupportedApi: false, dataMode: 'synthetic-fixture',
    fetchedAt: at, sourceUpdatedAt: null,
    coverage: { start: '2026-09-13T00:00:00.000Z', end: '2026-11-12T23:59:59.999Z', complete: true, warnings: [] as string[] },
    events: [
      { id: 'lcs:2026:fixture-lcs', sourceTournamentId: 'fixture-lcs', competition: 'lcs', label: 'LCS 2026', season: '2026',
        series: [
          series('lcs-series', 'lcs:2026:fixture-lcs', [team('alpha', 'Alpha', 1), team('beta', 'Beta', 0)], 'live', 'inProgress'),
          series('second-wins', 'lcs:2026:fixture-lcs', [team('cloud9', 'Cloud9', 1), team('northern', longWinner, 3)], 'completed', 'completed'),
          series('outcome-only', 'lcs:2026:fixture-lcs', [team('harbor', 'Harbor Wolves', null, 'win'), team('river', 'River Guardians', null, 'loss')], 'completed', 'completed'),
          series('unnamed-winner', 'lcs:2026:fixture-lcs', [team('unnamed', null, null, 'win'), team('valley', 'Valley Vipers', null, 'loss')], 'completed', 'completed'),
          series('tied', 'lcs:2026:fixture-lcs', [team('east', 'Eastern Falcons', 2), team('west', 'Western Ravens', 2)], 'completed', 'completed'),
          series('missing-score', 'lcs:2026:fixture-lcs', [team('coastal', 'Coastal Foxes', 2), team('mountain', 'Mountain Lions')], 'completed', 'completed'),
          series('unknown', 'lcs:2026:fixture-lcs', [team('forest', 'Forest Owls', 3), team('desert', 'Desert Hawks', 1)], 'unknown', 'result-missing'),
          { ...series('tbd', 'lcs:2026:fixture-lcs', [team('island', 'Island Otters'), team('tbd', null)], 'upcoming', 'unstarted'), startTime: '2026-10-15T13:00:00.000Z' },
        ] },
      { id: 'worlds:2026', sourceTournamentId: 'fixture-worlds', competition: 'worlds', label: 'Worlds 2026', season: '2026',
        series: [series('worlds-series', 'worlds:2026', [team('gamma', 'Gamma'), team('delta', 'Delta')], 'upcoming', 'unstarted')] },
    ],
  }
}

test('tournament browser follows deep links, updates, stale state, recovery and a narrow layout without provider calls', { timeout: 60_000 }, async () => {
  const feed = fixtureFeed()
  let health = { checkedAt: at, complete: true, warnings: [] as string[] }
  let feedStatus = 200
  let holdHealth = true
  const pendingHealth: Array<() => void> = []
  let holdNextFeed = true
  const pendingFeed: Array<() => void> = []
  const dataRequests: string[] = []
  const fixturePlugin: Plugin = {
    name: 'tournament-browser-fixture',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        if (!path.startsWith('/data/') && !path.startsWith('/tournament-data/')) return next()
        dataRequests.push(path)
        response.setHeader('content-type', 'application/json')
        response.statusCode = path === tournamentPath ? feedStatus : path === healthPath ? 200 : 503
        if (path === tournamentPath && holdNextFeed) {
          holdNextFeed = false
          const olderBody = JSON.stringify(feed)
          pendingFeed.push(() => response.end(olderBody))
          return
        }
        if (path === healthPath && holdHealth) {
          pendingHealth.push(() => response.end(JSON.stringify(health)))
          return
        }
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
    await page.addInitScript((cached) => {
      if (!localStorage.getItem('tournament-feed')) localStorage.setItem('tournament-feed', JSON.stringify(cached))
    }, { ...feed, events: feed.events.slice(0, 1) })

    await page.goto(`${base}/#tournaments?event=worlds%3A2026&view=schedule`)
    await waitForPendingFeed(pendingFeed)
    assert.equal(await page.getByRole('heading', { name: 'LCS 2026', exact: true }).count(), 0, 'A cache without the addressed event must not substitute another competition')
    assert.match(page.url(), /event=worlds%3A2026/)
    await page.getByText('Loading tournament schedule', { exact: true }).waitFor()
    pendingFeed.splice(0).forEach((respond) => respond())
    await page.getByRole('heading', { name: 'Worlds 2026' }).waitFor()
    assert.doesNotMatch(await page.locator('body').innerText(), /Schedule may be stale/, 'Pending health is not a stale result')
    holdHealth = false
    pendingHealth.splice(0).forEach((respond) => respond())
    await page.getByRole('button', { name: 'Refresh' }).click()
    await page.getByText(/Schedule may be stale/).waitFor({ state: 'hidden' })
    const headingTop = await page.getByRole('heading', { name: 'Worlds 2026' }).evaluate((node) => node.getBoundingClientRect().top)
    holdHealth = true
    await page.getByRole('button', { name: 'Refresh' }).click()
    await page.waitForFunction(() => document.body.innerText.includes('Gamma'))
    await waitForPendingFeed(pendingHealth)
    assert.doesNotMatch(await page.locator('body').innerText(), /Schedule may be stale/, 'A healthy refresh keeps its last checked status')
    assert.equal(await page.getByRole('heading', { name: 'Worlds 2026' }).evaluate((node) => node.getBoundingClientRect().top), headingTop)
    holdHealth = false
    pendingHealth.splice(0).forEach((respond) => respond())
    assert.match(await page.locator('body').innerText(), /Gamma.*Delta/)
    assert.match(await page.locator('body').innerText(), /Test fixture data\. Not official/)
    assert.equal(await page.getByRole('link', { name: 'Leaguepedia' }).getAttribute('href'), 'https://lol.fandom.com/wiki/fixture-worlds')
    assert.equal(await page.getByRole('link', { name: 'CC BY-SA 3.0' }).getAttribute('href'), 'https://creativecommons.org/licenses/by-sa/3.0/')
    assert.ok(dataRequests.includes(tournamentPath))
    assert.ok(dataRequests.every((path) => path === tournamentPath || path === healthPath), `Unexpected data requests: ${dataRequests}`)
    assert.deepEqual(externalRequests, [])

    await page.locator('#tournament-event').selectOption('lcs:2026:fixture-lcs')
    await page.getByRole('heading', { name: 'LCS 2026' }).waitFor()
    assert.match(page.url(), /event=lcs%3A2026%3Afixture-lcs/)
    assert.match(await page.locator('body').innerText(), /Alpha.*Beta/)
    const live = page.locator('section[aria-label="live"]')
    await live.getByText('Alpha 1–0 Beta', { exact: true }).waitFor()
    await live.locator('[data-slot="badge"]').filter({ hasText: /^Live$/ }).waitFor({ state: 'visible' })
    assert.doesNotMatch(await live.innerText(), /Winner:/, 'A live lead is not a confirmed winner')
    const results = page.locator('section[aria-label="results"]')
    await results.getByText(`Winner: ${longWinner}`, { exact: true }).waitFor()
    await results.getByText('Winner: Harbor Wolves', { exact: true }).waitFor()
    for (const matchup of ['Eastern Falcons 2–2 Western Ravens', 'Coastal Foxes 2–– Mountain Lions', 'Forest Owls 3–1 Desert Hawks', 'Island Otters vs TBD', 'TBD vs Valley Vipers']) {
      const row = page.locator('li').filter({ has: page.getByText(matchup, { exact: true }) })
      assert.equal(await row.count(), 1)
      assert.doesNotMatch(await row.innerText(), /Winner:/, `${matchup} has no confirmed named winner`)
    }
    const markedRow = results.locator('li').filter({ hasText: 'Cloud9 1–3' })
    const winnerWeight = await markedRow.getByText(longWinner, { exact: true }).evaluate((node) => Number(getComputedStyle(node).fontWeight))
    const loserWeight = await markedRow.getByText('Cloud9', { exact: true }).evaluate((node) => Number(getComputedStyle(node).fontWeight))
    assert.ok(winnerWeight > loserWeight, 'The confirmed winner has distinct text emphasis')
    const liveWeights = await Promise.all(['Alpha', 'Beta'].map((name) => live.getByText(name, { exact: true }).evaluate((node) => getComputedStyle(node).fontWeight)))
    assert.equal(liveWeights[0], liveWeights[1], 'A live lead does not gain winner emphasis')
    const cloud9Logo = markedRow.locator('[title="Cloud9 (C9)"] img')
    await cloud9Logo.waitFor({ state: 'visible' })
    await page.waitForFunction((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0, await cloud9Logo.elementHandle())
    const fallback = markedRow.locator(`[title="${longWinner} (NOR)"]`)
    assert.equal(await fallback.innerText(), 'N')
    assert.equal(await fallback.locator('img').count(), 0, 'An unbranded source team uses its initial')
    const tbdRow = page.locator('li').filter({ hasText: 'Island Otters vs TBD' })
    assert.equal(await tbdRow.locator('[title]').count(), 1, 'TBD does not gain a team identity')
    assert.equal(await page.getByText(disabledForecasts, { exact: true }).count(), 1)
    assert.doesNotMatch(await page.locator('#main-content').innerText(), /Game win:|Series win \(Bo/)
    assert.match(await page.locator('#main-content p').last().innerText(), /Live means the start time has passed and no result is in yet/)
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
    assert.match(await results.innerText(), /Alpha 3–1 Beta/)
    await results.getByText('Winner: Alpha', { exact: true }).waitFor()
    assert.equal(await page.locator('section[aria-label="live"]').count(), 0)

    health = { checkedAt: '2026-09-27T12:02:00.000Z', complete: false, warnings: ['Synthetic provider outage.'] }
    await page.clock.fastForward(60_000)
    await page.getByText(/Schedule may be stale/).waitFor()
    assert.match(await page.locator('body').innerText(), /Synthetic provider outage/)
    assert.match(await page.getByText(/Schedule may be stale/).innerText(), /Feed changed 1 minute ago, last checked less than a minute ago/)
    assert.match(await page.locator('body').innerText(), /Alpha 3–1 Beta/)

    health = { checkedAt: '2026-09-27T12:03:00.000Z', complete: true, warnings: [] }
    await page.clock.fastForward(60_000)
    await page.getByText(/Schedule may be stale/).waitFor({ state: 'hidden' })
    feedStatus = 503
    await page.clock.fastForward(60_000)
    await page.getByText(/Schedule may be stale/).waitFor()
    assert.match(await page.locator('body').innerText(), /Alpha 3–1 Beta/)

    feedStatus = 200
    health = { checkedAt: '2026-09-27T12:04:00.000Z', complete: true, warnings: [] }
    const requestsBeforeRetry = dataRequests.length
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await page.getByText(/Schedule may be stale/).waitFor({ state: 'hidden' })
    assert.ok(dataRequests.slice(requestsBeforeRetry).includes(tournamentPath))
    await page.clock.fastForward(60_000)
    const originalEvents = feed.events
    feed.events = []
    feed.fetchedAt = '2026-09-27T12:06:00.000Z'
    health.checkedAt = feed.fetchedAt
    await page.clock.fastForward(60_000)
    await page.getByText('No tournaments in the schedule window.').waitFor()
    assert.equal(await page.locator('#tournament-event').inputValue(), '')
    feed.events = originalEvents
    feed.fetchedAt = '2026-09-27T12:07:00.000Z'
    health.checkedAt = feed.fetchedAt
    await page.clock.fastForward(60_000)
    await page.getByRole('heading', { name: 'LCS 2026' }).waitFor()
    assert.equal(await page.locator('#tournament-event').inputValue(), 'lcs:2026:fixture-lcs')

    feed.events[0]!.series.push({ ...series('far-lcs', 'lcs:2026:fixture-lcs', [team('alpha', 'Alpha'), team('beta', 'Beta')], 'upcoming', 'unstarted'), startTime: '2026-10-15T13:00:00.000Z' })
    feed.events[1]!.series.push(series('worlds-other', 'worlds:2026', [team('epsilon', 'Epsilon'), team('zeta', 'Zeta')], 'upcoming', 'unstarted'))
    await page.goto(`${base}/#tournaments`)
    await page.getByRole('heading', { name: 'Worlds 2026' }).waitFor()
    assert.equal(await page.locator('#tournament-event').inputValue(), 'worlds:2026')
    assert.equal(await page.getByRole('button', { name: 'Bracket', exact: true }).getAttribute('aria-pressed'), 'true', 'The bracket is the default view')
    assert.equal(await page.getByText(disabledForecasts, { exact: true }).count(), 0, 'The disabled schedule message is absent from the bracket')
    const gamma = page.getByRole('button', { name: 'Gamma' })
    await gamma.click()
    assert.equal(await gamma.getAttribute('aria-pressed'), 'true')
    await page.getByText('Tracing Gamma').waitFor()
    await page.keyboard.press('Escape')
    await page.getByText('Tracing Gamma').waitFor({ state: 'hidden' })
    // Escape also clears the trace from a team that keeps keyboard focus.
    await page.getByRole('button', { name: 'Refresh' }).click()
    await page.getByRole('button', { name: 'Epsilon' }).waitFor()
    const dimmedCards = page.locator('[aria-label="Bracket, scrolls sideways"] article.opacity-40')
    await page.mouse.move(0, 0)
    await page.getByRole('button', { name: 'Bracket', exact: true }).focus()
    await gamma.focus()
    await page.keyboard.press('Enter')
    await page.getByText('Tracing Gamma').waitFor()
    assert.equal(await dimmedCards.count(), 1, 'The series without Gamma is dimmed while tracing')
    await page.keyboard.press('Escape')
    await page.getByText('Tracing Gamma').waitFor({ state: 'hidden' })
    assert.equal(await gamma.getAttribute('aria-pressed'), 'false')
    assert.equal(await dimmedCards.count(), 0, 'No series stays dimmed after Escape')
    feed.events[1]!.series.pop()
    await page.getByRole('button', { name: 'Schedule', exact: true }).click()
    assert.match(page.url(), /view=schedule/)
    await page.locator('section[aria-label="upcoming"]').waitFor()

    await page.goto(`${base}/#tournaments?event=worlds%3A2026&view=schedule`)
    await page.getByRole('heading', { name: 'Worlds 2026' }).waitFor()
    holdNextFeed = true
    await page.getByRole('button', { name: 'Refresh' }).click()
    await waitForPendingFeed(pendingFeed)
    feed.events[1]!.series[0] = series('worlds-series', 'worlds:2026', [team('gamma', 'Gamma', 3, 'win'), team('delta', 'Delta', 1, 'loss')], 'completed', 'completed')
    feed.fetchedAt = '2026-09-27T12:08:00.000Z'
    health.checkedAt = feed.fetchedAt
    await page.getByRole('button', { name: 'Refresh' }).click()
    await page.getByText('Gamma 3–1 Delta').waitFor()
    const oldResponse = page.waitForResponse((response) => response.url().endsWith(tournamentPath))
    pendingFeed.splice(0).forEach((respond) => respond())
    await oldResponse
    await page.waitForTimeout(50)
    assert.match(await page.locator('section[aria-label="results"]').innerText(), /Gamma 3–1 Delta/)

    await page.goto(`${base}/tournaments`)
    await page.getByRole('heading', { name: 'Tournaments', exact: true }).waitFor()
    await page.getByRole('heading', { name: 'LCS 2026' }).waitFor()
    await page.getByRole('button', { name: 'Schedule', exact: true }).focus()
    await page.keyboard.press('Enter')
    await page.getByText(`Winner: ${longWinner}`, { exact: true }).waitFor()
    assert.equal(await page.getByText(disabledForecasts, { exact: true }).count(), 1)

    await page.locator('a[href="#main-content"]').focus()
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'main-content')
    for (const width of [320, 390, 768, 1024, 1280]) {
      await page.setViewportSize({ width, height: 800 })
      const layout = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }))
      assert.ok(layout.content <= layout.viewport, `Horizontal overflow at ${width}px: ${JSON.stringify(layout)}`)
      const winnerLabel = page.getByText(`Winner: ${longWinner}`, { exact: true })
      const winnerLayout = await winnerLabel.evaluate((node) => {
        const bounds = node.getBoundingClientRect()
        return { left: bounds.left, right: bounds.right }
      })
      assert.ok(winnerLayout.left >= 0 && winnerLayout.right <= width, `Winner label stays readable at ${width}px`)
      if (width < 640) {
        const clearance = await page.evaluate(() => {
          window.scrollTo(0, document.documentElement.scrollHeight)
          const finalContent = [...document.querySelectorAll('#main-content p')].at(-1)
          const tabBar = [...document.querySelectorAll('nav[aria-label="Primary"]')]
            .find((element) => getComputedStyle(element).position === 'fixed')
          return { finalContentBottom: finalContent?.getBoundingClientRect().bottom, tabBarTop: tabBar?.getBoundingClientRect().top }
        })
        assert.ok(clearance.finalContentBottom !== undefined && clearance.tabBarTop !== undefined
          && clearance.finalContentBottom < clearance.tabBarTop,
        `Final tournament content overlaps mobile navigation at ${width}px: ${JSON.stringify(clearance)}`)
      }
    }
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith(healthPath)),
      page.getByRole('button', { name: 'Refresh' }).click(),
    ])
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    const requestsWhileHidden = dataRequests.length
    await page.clock.fastForward(180_000)
    assert.equal(dataRequests.length, requestsWhileHidden, 'Hidden tournament pages do not poll')
    const resumed = page.waitForResponse((response) => response.url().endsWith(tournamentPath))
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await resumed
    assert.ok(dataRequests.length > requestsWhileHidden, 'Returning to the tournament page refreshes immediately')

    holdNextFeed = true
    await page.reload()
    await page.locator('#tournament-event').waitFor()
    await waitForPendingFeed(pendingFeed)
    assert.equal(await page.getByText('Loading tournament schedule', { exact: true }).count(), 0, 'A return visit shows the last schedule while the feed request is held')
    pendingFeed.splice(0).forEach((respond) => respond())
    assert.deepEqual(externalRequests, [])
  } finally {
    pendingHealth.splice(0).forEach((respond) => respond())
    pendingFeed.splice(0).forEach((respond) => respond())
    await browser?.close()
    await server.close()
  }
})

test('tournament results keep matchup, score and winner metadata readable at each responsive width', { timeout: 60_000 }, async () => {
  const feed = fixtureFeed()
  feed.events[0]!.series = [
    series('maryville-result', 'lcs:2026:fixture-lcs', [team('maryville', 'Maryville University', 3), team('zeu5', 'Zeu5 Esports', 1)], 'completed', 'completed'),
    series('maryville-cupid', 'lcs:2026:fixture-lcs', [team('maryville', 'Maryville University', 3), team('cupid', 'Cupid Esports', 0)], 'completed', 'completed'),
    series('maryville-disguised', 'lcs:2026:fixture-lcs', [team('maryville', 'Maryville University', 0), team('disguised', 'Disguised', 3)], 'completed', 'completed'),
    series('shopify-kt', 'lcs:2026:fixture-lcs', [team('shopify', 'Shopify Rebellion', 0), team('kt', 'KT Rolster', 1)], 'completed', 'completed'),
    series('shopify-jd', 'lcs:2026:fixture-lcs', [team('shopify', 'Shopify Rebellion', 0), team('jd', 'JD Gaming', 2)], 'completed', 'completed'),
    series('kabum-lions', 'lcs:2026:fixture-lcs', [team('kabum', 'KaBuM! Ilha das Lendas', 3), team('lions', 'Golden Lions', 0)], 'completed', 'completed'),
    series('kabum-9z', 'lcs:2026:fixture-lcs', [team('kabum', 'KaBuM! Ilha das Lendas', 3), team('9z', '9z Globant', 1)], 'completed', 'completed'),
    series('long-result', 'lcs:2026:fixture-lcs', [team('cloud9', 'Cloud9', 1), team('northern', longWinner, 3)], 'completed', 'completed'),
  ]
  const fixturePlugin: Plugin = { name: 'tournament-readability-fixture', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      if (!path.startsWith('/data/') && !path.startsWith('/tournament-data/')) return next()
      response.setHeader('content-type', 'application/json')
      response.statusCode = path === tournamentPath || path === healthPath ? 200 : 503
      response.end(JSON.stringify(path === tournamentPath ? feed : path === healthPath
        ? { checkedAt: at, complete: true, warnings: [] } : { error: 'ranking artifacts unavailable' }))
    })
  } }
  const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, plugins: [fixturePlugin] })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const executablePath = chromium.executablePath()
    browser = await chromium.launch(existsSync(executablePath) ? { headless: true } : { headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 768, height: 800 } })
    await page.clock.install({ time: new Date(at) })
    await page.goto(`http://127.0.0.1:${address.port}/#tournaments?event=lcs%3A2026%3Afixture-lcs&view=schedule`)
    await page.getByText('Winner: Maryville University', { exact: true }).first().waitFor()
    await page.evaluate(() => document.fonts.ready)
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), 'The fixture schedule scrolls naturally')
    const widths = [...new Set([
      320, 335, 390, 768, 800, 850, 910, 1024, 1280,
      ...([[330, 340], [768, 780], [796, 816], [836, 856], [900, 918]] as const)
        .flatMap(([start, end]) => Array.from({ length: (end - start) / 2 + 1 }, (_, index) => start + index * 2)),
    ])].sort((a, b) => a - b)
    const failures: Array<{ width: number, matchup: string, layout: unknown }> = []
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 })
      for (const result of feed.events[0]!.series) {
        const [first, second] = result.teams
        const matchup = `${first!.name} ${first!.gameWins}–${second!.gameWins} ${second!.name}`
        const row = page.locator('li').filter({ has: page.getByText(matchup, { exact: true }) })
        const layout = await row.evaluate((node) => {
          const [matchup, metadata] = node.querySelectorAll('p')
          const textFits = [matchup!, metadata!].map((element) => {
            const bounds = element.getBoundingClientRect()
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
            let text: Node | null
            while ((text = walker.nextNode())) {
              if (!text.textContent?.trim()) continue
              const range = document.createRange()
              range.selectNodeContents(text)
              if ([...range.getClientRects()].some((rect) => rect.left < bounds.left - 1 || rect.right > bounds.right + 1)) return false
            }
            return bounds.width > 0 && bounds.left >= 0 && bounds.right <= innerWidth
          })
          const score = matchup!.querySelector('.font-mono')!
          const range = document.createRange()
          range.selectNodeContents(score)
          const matchupBounds = matchup!.getBoundingClientRect()
          const metadataBounds = metadata!.getBoundingClientRect()
          return {
            matchupWidth: matchupBounds.width,
            matchupFits: textFits[0], metadataFits: textFits[1],
            scoreLines: new Set([...range.getClientRects()].map((rect) => rect.top)).size,
            separated: matchupBounds.right <= metadataBounds.left || metadataBounds.right <= matchupBounds.left
              || matchupBounds.bottom <= metadataBounds.top || metadataBounds.bottom <= matchupBounds.top,
          }
        })
        if (!layout.matchupFits || !layout.metadataFits || layout.scoreLines !== 1 || !layout.separated) {
          failures.push({ width, matchup, layout })
        }
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Horizontal overflow at ${width}px`)
    }
    console.log(JSON.stringify({ readabilityWidths: widths, rows: feed.events[0]!.series.length, failures }))
    assert.deepEqual(failures, [], 'Matchups, atomic scores and winner metadata stay readable across responsive widths')
  } finally {
    await browser?.close()
    await server.close()
  }
})

async function waitForPendingFeed(pending: Array<() => void>) {
  const deadline = Date.now() + 5_000
  while (pending.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(pending.length > 0, 'Expected a held tournament feed response')
}
