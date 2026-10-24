import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createServer, type Plugin } from 'vite'
import { createStaticRankingData } from '../src/domains/rankings/internal/projections/snapshot.ts'
import { createPublicArtifactWritePlan } from '../src/domains/rankings/internal/published/writePlan.ts'
import type { MatchRecord, TeamProfile } from '../src/domains/rankings/types.ts'

const regions = ['LEC', 'LCS'] as const
const teams: Record<string, TeamProfile> = Object.fromEntries(regions.flatMap((region) =>
  Array.from({ length: 6 }, (_, index) => {
    const name = `${region} Team ${index + 1}`
    return [name, { name, code: `${region[1]}${index + 1}`, league: region, region }]
  })))

function series(id: string, date: string, region: typeof regions[number], teamA: string, teamB: string, winner: string): MatchRecord {
  return { id, sourceProvider: 'oracles-elixir', date, datetimeUtc: `${date}T12:00:00.000Z`, season: Number(date.slice(0, 4)), event: `${region} ${date.slice(0, 4)}`,
    phase: 'Regular season', region, league: region, patch: '', bestOf: 1, bestOfBasis: 'provider', tier: 'regional-regular', teamA, teamB, winner,
    teamAKills: 15, teamBKills: 9, teamAGold: 60_000, teamBGold: 55_000 }
}

// Four round robins from March to June give every team the 20 games, and the recent games, that eligibility needs.
const matches = regions.flatMap((region) => {
  const names = Object.values(teams).filter((team) => team.region === region).map((team) => team.name)
  const pairs = names.flatMap((teamA, a) => names.slice(a + 1).map((teamB) => [teamA, teamB] as const))
  return [3, 4, 5, 6].flatMap((month, round) => pairs.map(([teamA, teamB], index) =>
    series(`${region}-${round}-${index}`, `2026-0${month}-${String(index + 1).padStart(2, '0')}`, region, teamA, teamB, (index + round) % 3 === 0 ? teamB : teamA)))
})

test('the Regions page charts region power over time for the compared regions', { timeout: 60_000 }, async (t) => {
  const data = createStaticRankingData({ matches, teams, rosters: {}, generatedAt: '2026-07-01T00:00:00.000Z', dataMode: 'seeded-sample' })
  const bodies = new Map(createPublicArtifactWritePlan(data).writes.map((write) => [`/data/${write.relativePath}`, write.contents]))
  const fixture: Plugin = { name: 'region-power-fixture', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
      if (!path.startsWith('/data/')) return next()
      const body = bodies.get(path)
      response.statusCode = body ? 200 : 404
      response.setHeader('content-type', 'application/json')
      response.end(body ?? '{}')
    })
  } }
  const server = await createServer({ publicDir: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, plugins: [fixture] })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const executablePath = chromium.executablePath()
    browser = await chromium.launch(existsSync(executablePath) ? { headless: true } : { headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(`http://127.0.0.1:${address.port}/#regions?scope=all`)
    const details = page.getByRole('region', { name: 'Selected chart point details' })

    await t.test('every region has a line while no region is compared', async () => {
      await page.getByRole('application', { name: /^Region power over time for (LEC, LCS|LCS, LEC)$/ }).waitFor({ timeout: 20_000 })
    })
    await t.test('the details show each region on the last day with the three teams behind its value', async () => {
      const text = await details.innerText()
      assert.match(text, /LEC\s+[\d,]+\s+E\d · E\d · E\d/)
      assert.match(text, /LCS\s+[\d,]+\s+C\d · C\d · C\d/)
    })
    await t.test('the chart states the field and carried-forward history limits', async () => {
      await page.getByText(/not eligibility on each past date/).waitFor()
      await page.getByText(/Days without updates keep the last published value/).waitFor()
    })
    await t.test('the chart fits narrow screens and has daily values without point markers', async () => {
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no page overflow at ${width}`)
      }
      const chart = page.getByRole('application', { name: /^Region power over time for / })
      const summary = await page.locator(`[id="${await chart.getAttribute('aria-describedby')}"]`).textContent()
      assert.match(summary ?? '', /1\d{2} points/)
      assert.equal(await chart.locator('.recharts-line-dot').count(), 0)
      await chart.focus()
      const latest = await details.innerText()
      await page.keyboard.press('ArrowRight')
      await page.waitForFunction((text) => {
        const element = document.querySelector('[aria-label="Selected chart point details"]')
        return element instanceof HTMLElement && element.innerText !== text
      }, latest)
      assert.notEqual(await details.innerText(), latest, 'keyboard navigation changes the selected day')
    })
    await t.test('comparing one region leaves only its line', async () => {
      await page.getByRole('checkbox', { name: 'Compare LEC' }).check()
      await page.getByRole('application', { name: 'Region power over time for LEC' }).waitFor()
      assert.doesNotMatch(await details.innerText(), /LCS/)
    })
  } finally {
    await browser?.close()
    await server.close()
  }
})
