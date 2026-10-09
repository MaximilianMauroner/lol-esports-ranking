import { join } from 'node:path'
import { referencePublicDataDir, referencePublicDir } from '../scripts/reference-public-data.mjs'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createServer, type Plugin } from 'vite'
import { appendForecastReceipt, createPreMatchReceipt, emptyForecastLedger, forecastTournamentSeries, pinPreMatchReceipt } from '../src/lib/tournamentForecast'
import { parsePublicRankingManifest, parsePublicRankingShard } from '../src/lib/publicArtifacts/schema'
import type { TournamentFeed, TournamentSeries } from '../src/lib/tournamentFeed'

const eventId = 'worlds:2026'
const identityMap = { version: 1 as const, source: 'lolesports-persisted-site-api' as const, revision: 'reviewed-synthetic-fixture', mappings: [
  { sourceTeamId: 'fixture-t1', teamId: 'team:t1:t1' }, { sourceTeamId: 'fixture-gen', teamId: 'team:gen:gen-g' },
] }
function team(id: string, name: string, wins: number | null = null) { return { id, name, code: name, gameWins: wins, outcome: null } }
function series(startTime: string, bestOf = 5): TournamentSeries {
  return { id: `fixture-match-${bestOf}`, eventId, startTime, stage: 'Synthetic knockout', status: 'upcoming', sourceState: 'unstarted', bestOf,
    teams: [team('fixture-t1', 'T1'), team('fixture-gen', 'Gen.G')], vodUrls: [] }
}

test('synthetic tournament card keeps published pre-match odds through live and finished states', { timeout: 60_000 }, async () => {
  const manifestJson = await readFile(join(referencePublicDataDir, 'ranking-summary.json'), 'utf8')
  const manifest = parsePublicRankingManifest(JSON.parse(manifestJson))
  const shardUrl = manifest.snapshotIndex[manifest.defaultSnapshotKey]?.url
  assert.ok(shardUrl?.startsWith('/data/'))
  const shard = parsePublicRankingShard(JSON.parse(await readFile(join(referencePublicDir, new URL(shardUrl, 'http://fixture').pathname.slice(1)), 'utf8')))
  const ratingDate = manifest.coverage.latestMatchDate!
  const at = new Date(Math.max(Date.parse(manifest.generatedAt), Date.parse(ratingDate)) + 86_400_000).toISOString()
  const afterMinutes = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString()
  const start = afterMinutes(20)
  const forecastBasis = { snapshotId: `${manifest.artifactMeta?.runId ?? manifest.generatedAt}/${manifest.defaultSnapshotKey}`,
    ratingDataAsOf: manifest.coverage.latestMatchDate!, ratingPublishedAt: manifest.generatedAt,
    dataMode: manifest.dataMode, model: manifest.model, snapshot: shard, identityMap }
  const upcoming = series(start)
  const estimate = forecastTournamentSeries(upcoming, forecastBasis)
  assert.equal(estimate.status, 'ready')
  let servedManifestJson = manifestJson
  let ledger = emptyForecastLedger
  let ledgerStatus = 503
  let identityStatus = 503
  let feed: TournamentFeed = { version: 1, source: 'lolesports-persisted-site-api', unsupportedApi: true, dataMode: 'synthetic-fixture',
    fetchedAt: at, sourceUpdatedAt: null, coverage: { start: at, end: new Date(Date.parse(at) + 45 * 86_400_000).toISOString(), complete: true, warnings: [] },
    events: [{ id: eventId, sourceTournamentId: 'fixture-worlds', competition: 'worlds', label: 'Worlds 2026', season: '2026',
      series: [upcoming, series(start, 2)] }] }
  const fixturePlugin: Plugin = { name: 'forecast-fixture', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      if (path === '/data/ranking-summary.json') {
        response.setHeader('content-type', 'application/json')
        setTimeout(() => response.end(servedManifestJson), 500)
        return
      }
      if (!path.startsWith('/tournament-data/')) return next()
      response.setHeader('content-type', 'application/json')
      const body = path === '/tournament-data/feed.json' ? feed
        : path === '/tournament-data/feed.json.health.json' ? { checkedAt: feed.fetchedAt, complete: true, warnings: [] }
          : path === '/tournament-data/forecasts/team-ids.json' ? identityMap
            : path === '/tournament-data/forecasts/ledger.json' ? ledger : null
      response.statusCode = path === '/tournament-data/forecasts/ledger.json' ? ledgerStatus
        : path === '/tournament-data/forecasts/team-ids.json' ? identityStatus : body ? 200 : 404
      response.end(JSON.stringify(body))
    })
  } }
  const server = await createServer({
    publicDir: referencePublicDir, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, plugins: [fixturePlugin],
    define: {
      'import.meta.env.VITE_TOURNAMENT_HUB_ENABLED': JSON.stringify('1'),
      'import.meta.env.VITE_TOURNAMENT_FORECASTS_ENABLED': JSON.stringify('1'),
    },
  })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const executablePath = chromium.executablePath()
    browser = await chromium.launch(existsSync(executablePath) ? { headless: true } : { headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const external: string[] = []
    page.on('request', (request) => { if (!request.url().startsWith(base)) external.push(request.url()) })
    await page.clock.install({ time: new Date(at) })
    await page.goto(`${base}/#tournaments?event=worlds%3A2026`)
    await page.getByText(/Forecast unavailable: No reviewed source-to-ranking team ID map is published/).first().waitFor()
    await page.getByText(/Forecast receipt check failed; showing the last valid ledger/).waitFor()
    await page.getByText('Conditional Power preview', { exact: true }).first().click()
    await page.getByText(/Power delta unavailable: No reviewed source-to-ranking/).waitFor()
    identityStatus = 200
    await page.clock.fastForward(65_000)
    await page.getByText('Current model estimate · not archived').waitFor()
    assert.match(await page.locator('body').innerText(), /Game win: T1 .* Gen\.G/)
    assert.match(await page.locator('body').innerText(), /Series win \(Bo5\): T1 .* Gen\.G/)
    assert.match(await page.locator('body').innerText(), /Only decisive Bo1, Bo3 and Bo5 are supported/)
    assert.match(await page.locator('body').innerText(), /Local synthetic fixture\. These are not official/)
    assert.match(await page.locator('body').innerText(), new RegExp(`Power data through ${ratingDate}`))
    // A new model basis resets the hypothetical selection instead of keeping a stale preview.
    await page.getByText('Conditional Power preview', { exact: true }).first().click()
    await page.getByText(/Current Power \(snapshot\): T1/).waitFor()
    const preview = page.locator('details').filter({ has: page.getByText('Conditional Power preview', { exact: true }) }).first()
    const originalStores = JSON.stringify({ forecastBasis, ledger, feed })
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 })
      await preview.getByLabel('Winner', { exact: true }).selectOption('away')
      await preview.getByLabel('Series score (winner first)').selectOption('2')
      await preview.getByRole('status').filter({ hasText: 'Gen.G wins 3–2.' }).waitFor()
      await preview.getByLabel('Winner', { exact: true }).focus()
      await page.keyboard.press('Home')
      await page.keyboard.press('Tab')
      await page.keyboard.press('Home')
      await preview.getByRole('status').filter({ hasText: 'T1 wins 3–0.' }).waitFor()
      assert.match(await preview.innerText(), /internal pre-series state or verified event weighting/)
      assert.match(await preview.innerText(), /Future lineups, patch, game order and performance inputs are also unavailable/)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Preview overflow at ${width}px`)
    }
    assert.equal(JSON.stringify({ forecastBasis, ledger, feed }), originalStores)
    await preview.getByLabel('Winner', { exact: true }).selectOption('away')
    const firstProvenance = await page.getByText(/Power data through/).first().innerText()
    servedManifestJson = JSON.stringify({ ...manifest, generatedAt: afterMinutes(10) })
    await page.clock.fastForward(10 * 60_000 + 5_000)
    await page.waitForFunction((previous) => [...document.querySelectorAll('span')].some((element) =>
      element.textContent?.startsWith('Power data through') && element.textContent !== previous), firstProvenance)
    await page.getByText('Conditional Power preview', { exact: true }).first().click()
    assert.equal(await page.getByLabel('Winner', { exact: true }).inputValue(), 'home')

    ledgerStatus = 200
    const created = createPreMatchReceipt({ series: upcoming, basis: forecastBasis, forecastRevision: 'fixture-rev-1',
      generatedAt: at, publishedAt: new Date(Date.parse(at) + 1000).toISOString(), observedAt: at })
    assert.equal(created.status, 'ready')
    if (created.status !== 'ready') return
    ledger = appendForecastReceipt(ledger, created)
    const live = { ...upcoming, status: 'live' as const, sourceState: 'inProgress', teams: [team('fixture-t1', 'T1', 1), team('fixture-gen', 'Gen.G', 0)] }
    ledger = pinPreMatchReceipt(ledger, live, afterMinutes(20))
    feed = { ...feed, fetchedAt: afterMinutes(20), events: [{ ...feed.events[0]!, series: [live, series(start, 2)] }] }
    await page.clock.fastForward(9 * 60_000)
    await page.getByText('Published pre-match forecast').waitFor()
    assert.match(await page.locator('body').innerText(), /Score-conditioned series odds:/)
    assert.match(await page.locator('body').innerText(), /frozen pre-series model, not in-game telemetry/)
    const liveSection = page.locator('section[aria-label="live"]')
    await liveSection.getByText('Conditional Power preview', { exact: true }).click()
    assert.match(await liveSection.innerText(), /Pre-series Power previews close when the source reports play/)
    assert.match(await liveSection.innerText(), /Pre-match Power \(snapshot\): T1/)
    assert.doesNotMatch(await liveSection.innerText(), /Current Power \(snapshot\):/)
    assert.equal(await liveSection.getByLabel('Winner', { exact: true }).count(), 0)
    ledgerStatus = 503
    feed = { ...feed, fetchedAt: afterMinutes(21) }
    await page.clock.fastForward(60_000)
    await page.getByText(/Forecast receipt check failed; showing the last valid ledger/).waitFor()
    assert.match(await page.locator('section[aria-label="live"]').innerText(), /Published pre-match forecast/)
    ledgerStatus = 200
    const completed = { ...live, status: 'completed' as const, sourceState: 'completed', teams: [team('fixture-t1', 'T1', 3), team('fixture-gen', 'Gen.G', 1)] }
    feed = { ...feed, fetchedAt: afterMinutes(22), events: [{ ...feed.events[0]!, series: [completed, series(start, 2)] }] }
    await page.clock.fastForward(60_000)
    await page.getByText('T1 3–1 Gen.G').waitFor()
    await page.getByText(/Forecast receipt check failed; showing the last valid ledger/).waitFor({ state: 'hidden' })
    assert.match(await page.locator('section[aria-label="results"]').innerText(), /Published pre-match forecast/)
    await page.locator('section[aria-label="results"]').getByText('Conditional Power preview', { exact: true }).click()
    assert.match(await page.locator('section[aria-label="results"]').innerText(), /Actual rating impact belongs to the rating evidence ledger/)
    assert.match(await page.locator('section[aria-label="results"]').innerText(), /Pre-match Power \(snapshot\): T1/)
    assert.doesNotMatch(await page.locator('section[aria-label="results"]').innerText(), /Current Power \(snapshot\):/)
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Horizontal overflow at ${width}px`)
    }
    assert.deepEqual(external, [])
  } finally {
    await browser?.close()
    await server.close()
  }
})
