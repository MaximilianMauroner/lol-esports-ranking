import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium, type Page } from 'playwright-core'
import { createServer } from 'vite'
import { createTeamDetailFixture, teamIds } from './fixtures/teamDetailAddress.ts'

const board = (season = '2026', extra = '') => `#rankings?scope=season:${season}&eligibility=all${extra ? `&${extra}` : ''}`
const invalid = board('2026', `teamDetail=${teamIds.retired}&team=Synthetic&sort=rating&keep=untouched`)
const notice = (page: Page) => page.getByRole('status').filter({ hasText: 'This team is not available' })
const drawer = (page: Page) => page.getByRole('dialog')
const query = (page: Page) => page.evaluate(() => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1])))

async function withFixture(run: (page: Page, base: string, fixture: ReturnType<typeof createTeamDetailFixture>) => Promise<void>, width = 1280) {
  const fixture = createTeamDetailFixture()
  for (const season of ['2025', '2026']) {
    const snapshot = fixture.plan.writes.find((write) => write.relativePath === `scopes/season-${season}.json`)
    assert.ok(snapshot)
    const members = JSON.parse(snapshot.contents).standings.map((team: { teamId: string }) => team.teamId).sort()
    assert.deepEqual(members, (season === '2025' ? Object.values(teamIds) : [teamIds.alpha, teamIds.beta]).sort())
  }
  const server = await createServer({ publicDir: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, plugins: [fixture.plugin] })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const executablePath = chromium.executablePath()
    browser = await chromium.launch({ headless: true, ...(existsSync(executablePath) ? {} : { channel: 'chrome' }) })
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 800 } })
    page.setDefaultTimeout(5_000)
    await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
    await run(page, `http://127.0.0.1:${address.port}/`, fixture)
  } finally {
    for (const path of fixture.held) fixture.release(path)
    await browser?.close()
    await server.close()
  }
}

for (const width of [1280, 390]) {
  test(`an unavailable team link releases board history and cannot open on a later scope at ${width}px`, { timeout: 60_000 }, async () => {
    await withFixture(async (page, base, fixture) => {
      await page.goto(`${base}${invalid}`)
      await page.locator('table tbody tr').first().waitFor()
      const entries = await page.evaluate(() => history.length)
      await notice(page).waitFor()
      assert.equal(await drawer(page).count(), 0)
      assert.deepEqual(await query(page), { scope: 'season:2026', eligibility: 'all', team: 'Synthetic', sort: 'rating', keep: 'untouched' })
      assert.equal(await page.evaluate(() => history.length), entries, 'Repair replaces the current entry')
      await page.getByRole('heading', { name: 'Power over time', exact: true }).hover()
      await page.locator('.recharts-line-curve').first().waitFor()
      assert.ok(fixture.requests.some((path) => path.startsWith('/data/history/team-series/')))
      await page.getByLabel('Season', { exact: true }).selectOption('2025')
      await page.getByTitle('Open Synthetic Retired', { exact: true }).waitFor()
      assert.equal(await drawer(page).count(), 0, 'A consumed request cannot open in a later season')
      assert.equal(await notice(page).count(), 0)
      await page.getByTitle('Open Synthetic Retired', { exact: true }).click()
      await drawer(page).waitFor()
      await drawer(page).locator('.recharts-line-curve').first().waitFor()
      assert.equal((await query(page)).teamDetail, teamIds.retired)
    }, width)
  })
}
