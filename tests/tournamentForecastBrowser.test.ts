import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createServer, type Plugin } from 'vite'
import { appendForecastReceipt, createPreMatchReceipt, emptyForecastLedger, forecastTournamentSeries, pinPreMatchReceipt } from '../src/lib/tournamentForecast'
import { parsePublicRankingManifest, parsePublicRankingShard } from '../src/lib/publicArtifacts/schema'
import type { TournamentFeed, TournamentSeries } from '../src/lib/tournamentFeed'

const at = '2026-09-27T12:00:00.000Z'
const start = '2026-09-27T13:00:00.000Z'
const eventId = 'worlds:2026'
const identityMap = { version: 1 as const, source: 'lolesports-persisted-site-api' as const, revision: 'reviewed-synthetic-fixture', mappings: [
  { sourceTeamId: 'fixture-t1', teamId: 'team:t1:t1' }, { sourceTeamId: 'fixture-gen', teamId: 'team:gen:gen-g' },
] }
function team(id: string, name: string, wins: number | null = null) { return { id, name, code: name, gameWins: wins, outcome: null } }
function series(bestOf = 5): TournamentSeries {
  return { id: `fixture-match-${bestOf}`, eventId, startTime: start, stage: 'Synthetic knockout', status: 'upcoming', sourceState: 'unstarted', bestOf,
    teams: [team('fixture-t1', 'T1'), team('fixture-gen', 'Gen.G')], vodUrls: [] }
}

test('synthetic tournament card keeps published pre-match odds through live and finished states', { timeout: 60_000 }, async () => {
  const manifestJson = await readFile('public/data/ranking-summary.json', 'utf8')
  const manifest = parsePublicRankingManifest(JSON.parse(manifestJson))
  const shard = parsePublicRankingShard(JSON.parse(await readFile('public/data/scopes/all.json', 'utf8')))
  const forecastBasis = { snapshotId: `${manifest.artifactMeta?.runId ?? manifest.generatedAt}/${manifest.defaultSnapshotKey}`,
    ratingDataAsOf: manifest.coverage.latestMatchDate!, ratingPublishedAt: manifest.generatedAt,
    dataMode: manifest.dataMode, model: manifest.model, snapshot: shard, identityMap }
  const upcoming = series()
  const estimate = forecastTournamentSeries(upcoming, forecastBasis)
  assert.equal(estimate.status, 'ready')
  let ledger = emptyForecastLedger
  let ledgerStatus = 503
  let feed: TournamentFeed = { version: 1, source: 'lolesports-persisted-site-api', unsupportedApi: true, dataMode: 'synthetic-fixture',
    fetchedAt: at, sourceUpdatedAt: null, coverage: { start: at, end: '2026-11-01T00:00:00.000Z', complete: true, warnings: [] },
    events: [{ id: eventId, sourceTournamentId: 'fixture-worlds', competition: 'worlds', label: 'Worlds 2026', season: '2026',
      series: [upcoming, series(2)] }] }
  const fixturePlugin: Plugin = { name: 'forecast-fixture', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      if (path === '/data/ranking-summary.json') {
        response.setHeader('content-type', 'application/json')
        setTimeout(() => response.end(manifestJson), 500)
        return
      }
      if (!path.startsWith('/data/tournaments/')) return next()
      response.setHeader('content-type', 'application/json')
      const body = path === '/data/tournaments/feed.json' ? feed
        : path === '/data/tournaments/feed.json.health.json' ? { checkedAt: feed.fetchedAt, complete: true, warnings: [] }
          : path === '/data/tournaments/forecasts/team-ids.json' ? identityMap
            : path === '/data/tournaments/forecasts/ledger.json' ? ledger : null
      response.statusCode = path === '/data/tournaments/forecasts/ledger.json' ? ledgerStatus : body ? 200 : 404
      response.end(JSON.stringify(body))
    })
  } }
  const server = await createServer({
    logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, plugins: [fixturePlugin],
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
    await page.getByText('Current model estimate · not archived').waitFor()
    await page.getByText(/Forecast receipt check failed; showing the last valid ledger/).waitFor()
    assert.match(await page.locator('body').innerText(), /Game win: T1 .* Gen\.G/)
    assert.match(await page.locator('body').innerText(), /Series win \(Bo5\): T1 .* Gen\.G/)
    assert.match(await page.locator('body').innerText(), /Only decisive Bo1, Bo3 and Bo5 are supported/)
    assert.match(await page.locator('body').innerText(), /Local synthetic fixture\. These are not official/)
    assert.match(await page.locator('body').innerText(), /Power data through 2026-07-26/)

    ledgerStatus = 200
    const created = createPreMatchReceipt({ series: upcoming, forecast: estimate, forecastRevision: 'fixture-rev-1',
      generatedAt: at, publishedAt: '2026-09-27T12:00:01.000Z', observedAt: at })
    assert.equal(created.status, 'ready')
    if (created.status !== 'ready') return
    ledger = appendForecastReceipt(ledger, created)
    const live = { ...upcoming, status: 'live' as const, sourceState: 'inProgress', teams: [team('fixture-t1', 'T1', 1), team('fixture-gen', 'Gen.G', 0)] }
    ledger = pinPreMatchReceipt(ledger, live, '2026-09-27T12:01:00.000Z')
    feed = { ...feed, fetchedAt: '2026-09-27T12:01:00.000Z', events: [{ ...feed.events[0]!, series: [live, series(2)] }] }
    await page.clock.fastForward(60_000)
    await page.getByText('Published pre-match forecast').waitFor()
    assert.match(await page.locator('body').innerText(), /Score-conditioned series odds:/)
    assert.match(await page.locator('body').innerText(), /frozen pre-series model, not in-game telemetry/)
    ledgerStatus = 503
    feed = { ...feed, fetchedAt: '2026-09-27T12:02:00.000Z' }
    await page.clock.fastForward(60_000)
    await page.getByText(/Forecast receipt check failed; showing the last valid ledger/).waitFor()
    assert.match(await page.locator('section[aria-label="live"]').innerText(), /Published pre-match forecast/)
    ledgerStatus = 200
    const completed = { ...live, status: 'completed' as const, sourceState: 'completed', teams: [team('fixture-t1', 'T1', 3), team('fixture-gen', 'Gen.G', 1)] }
    feed = { ...feed, fetchedAt: '2026-09-27T12:03:00.000Z', events: [{ ...feed.events[0]!, series: [completed, series(2)] }] }
    await page.clock.fastForward(60_000)
    await page.getByText('T1 3–1 Gen.G').waitFor()
    await page.getByText(/Forecast receipt check failed; showing the last valid ledger/).waitFor({ state: 'hidden' })
    assert.match(await page.locator('section[aria-label="results"]').innerText(), /Published pre-match forecast/)
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
