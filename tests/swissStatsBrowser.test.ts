import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { chromium } from 'playwright-core'
import { createServer, type Plugin } from 'vite'
import { fixtureFeed, mainId, rankingArtifacts, swissSeries, team } from './fixtures/swissPreviewFixtures'

test('on-demand hypothetical stats load, cancel, retry, and replace changed scenarios without stale estimates', { timeout: 120_000 }, async () => {
  const feed = fixtureFeed()
  const ratings = rankingArtifacts()
  const requests: string[] = []
  let ratingsAvailable = true
  let holdRatings = false
  let releaseRatings: (() => void) | undefined
  const plugin: Plugin = {
    name: 'swiss-stats-fixture',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        if (!path.startsWith('/data/') && !path.startsWith('/tournament-data/')) return next()
        requests.push(`${request.method} ${path}`)
        response.setHeader('content-type', 'application/json')
        if (path === '/tournament-data/feed.json') return response.end(JSON.stringify(feed))
        if (path === '/tournament-data/feed.json.health.json') return response.end(JSON.stringify({ checkedAt: feed.fetchedAt, complete: true, warnings: [] }))
        if (holdRatings && path === '/data/ranking-summary.json') await new Promise<void>((resolve) => { releaseRatings = resolve })
        if (ratingsAvailable && ratings.has(path)) return response.end(ratings.get(path))
        response.statusCode = 503
        response.end('{}')
      })
    },
  }
  const server = await createServer({ configFile: false, logLevel: 'silent',
    define: { 'import.meta.env.VITE_TOURNAMENT_FORECASTS_ENABLED': JSON.stringify('0') },
    resolve: { alias: { '@': new URL('../src', import.meta.url).pathname } },
    server: { host: '127.0.0.1', port: 0 }, plugins: [plugin, react(), tailwindcss()],
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch(existsSync(chromium.executablePath()) ? { headless: true } : { headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' })
    const errors: string[] = []
    const external: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.route('**/*', (route) => {
      if (route.request().url().startsWith(base)) return route.continue()
      external.push(route.request().url()); return route.abort()
    })
    await page.goto(`${base}/#tournaments?event=${encodeURIComponent(mainId)}&view=swiss`)
    const panel = page.getByRole('region', { name: 'Swiss stats', exact: true })
    await panel.getByRole('button', { name: 'Preview stats', exact: true }).waitFor()
    assert.deepEqual(requests.filter((request) => request.includes('/data/')), [])
    assert.doesNotMatch(await panel.innerText(), /\d+(\.\d+)?%/)
    await panel.getByRole('button', { name: 'Preview stats', exact: true }).click()
    await panel.getByText(/Choose a named Play-In winner/).waitFor()
    assert.deepEqual(requests.filter((request) => request.includes('/data/')), [], 'unknown identities do not load ratings')

    holdRatings = true
    await page.locator('#swiss-playin').selectOption('LEC')
    await panel.getByText('Loading published Power ratings.').waitFor()
    await panel.locator('[data-slot="skeleton"]').first().waitFor()
    assert.equal(await panel.getByRole('table').count(), 0)
    const releaseHeld = async () => {
      for (let attempt = 0; attempt < 100 && !releaseRatings; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
      assert.ok(releaseRatings, 'the rating request reached the fixture server')
      const release = releaseRatings; releaseRatings = undefined; holdRatings = false; release()
    }
    await panel.getByRole('button', { name: 'Cancel stats' }).click()
    await panel.getByText('Stats cancelled. No estimates are shown.').waitFor()
    await releaseHeld()
    assert.equal(await panel.getByRole('table').count(), 0)

    await page.evaluate(() => {
      const values: number[] = []
      Object.assign(window, { swissStatsProgress: values })
      new MutationObserver(() => {
        const progress = document.querySelector<HTMLProgressElement>('progress[aria-label="Swiss stats progress"]')
        if (progress) values.push(progress.value)
      }).observe(document.body, { subtree: true, childList: true, attributes: true })
    })
    await panel.getByRole('button', { name: 'Retry stats' }).click()
    await panel.getByRole('progressbar', { name: 'Swiss stats progress' }).waitFor()
    await panel.getByRole('button', { name: 'Cancel stats' }).click()
    await panel.getByText('Stats cancelled. No estimates are shown.').waitFor()
    await panel.getByRole('button', { name: 'Retry stats' }).click()
    await panel.getByRole('table', { name: 'Team advancement', exact: true }).waitFor()
    await panel.getByText(/The ratings are sample data/).waitFor()
    assert.equal(await panel.getByRole('table', { name: 'Team advancement' }).getByRole('row').count(), 17)
    assert.match(await panel.innerText(), /sampling error, not model confidence/)
    assert.match(await panel.innerText(), /uniform-legal-v1/)
    assert.match(await panel.innerText(), /Snapshot .*Model .*Config /)
    assert.equal(await page.evaluate(() => (window as unknown as { swissStatsProgress: number[] }).swissStatsProgress.some((count) => count > 0 && count < 4000)), true, 'real trial completion reaches the DOM')

    holdRatings = true
    await page.getByRole('region', { name: 'Round 1', exact: true }).getByRole('button', { name: 'Fill a valid draw', exact: true }).click()
    await panel.getByText('Loading published Power ratings.').waitFor()
    assert.equal(await panel.getByRole('table').count(), 0, 'an edit removes old percentages before the next result')
    await panel.getByRole('button', { name: 'Cancel stats' }).click()
    await releaseHeld()
    await page.getByRole('region', { name: 'Round 1', exact: true }).getByRole('group').first().getByRole('button').first().click()
    await panel.getByRole('button', { name: 'Preview stats', exact: true }).click()
    await panel.getByRole('table', { name: 'Team advancement' }).waitFor()
    assert.match(await panel.innerText(), /1 drawn rounds and 1 observed results or picks stay fixed/)

    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no page overflow at ${width}`)
      assert.ok(await panel.getByRole('table', { name: 'Team advancement' }).evaluate((table) => table.parentElement!.scrollWidth - table.parentElement!.clientWidth <= 1), `the stats table fits at ${width}px`)
    }
    assert.equal(await panel.locator('.motion-reduce\\:animate-none').evaluate((element) => getComputedStyle(element).animationName), 'none')

    holdRatings = true
    await page.getByRole('button', { name: 'B', exact: true }).click()
    await panel.getByText('Loading published Power ratings.').waitFor()
    assert.equal(await panel.getByRole('table').count(), 0, 'switching scenario removes stale percentages')
    ratingsAvailable = false
    await releaseHeld()
    await panel.getByRole('alert').filter({ hasText: 'Stats are unavailable.' }).waitFor()
    ratingsAvailable = true
    await panel.getByRole('button', { name: 'Retry stats' }).click()
    await panel.getByRole('table', { name: 'Team advancement' }).waitFor()

    feed.events[1].series[0].teams[1] = team('Cloud9')
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.locator('#swiss-playin').selectOption('LCS')
    await panel.getByText(/unique published Power rating is required for Cloud9/).waitFor()
    assert.equal(await panel.getByRole('table').count(), 0)

    await page.locator('#swiss-playin').selectOption('LEC')
    await panel.getByRole('table', { name: 'Team advancement' }).waitFor()
    const roundOne = page.getByRole('region', { name: 'Round 1', exact: true })
    await roundOne.getByRole('button', { name: 'Fill a valid draw', exact: true }).click()
    const pair = (await roundOne.getByRole('group').first().getAttribute('aria-label'))!.replace('Round 1: ', '').split(' against ')
    feed.events[0].series[0] = swissSeries(1, 0, [team(pair[0], 1), team(pair[1], 0)], 'live')
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await panel.getByText(/Pre-match estimates cannot use that score/).waitFor()
    assert.equal(await panel.getByRole('table').count(), 0)
    await roundOne.getByRole('group').first().getByRole('button').first().click()
    await panel.getByText(/fixed to your picked winner/).waitFor()
    await panel.getByRole('table', { name: 'Team advancement' }).waitFor()
    assert.deepEqual(errors, [])
    assert.deepEqual(external, [])
    assert.ok(requests.every((request) => request.startsWith('GET ')))
  } finally {
    releaseRatings?.()
    await browser?.close()
    await server.close()
  }
})
