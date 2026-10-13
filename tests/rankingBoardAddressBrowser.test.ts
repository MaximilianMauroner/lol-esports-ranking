import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium, type Page } from 'playwright-core'
import { createServer, type Plugin } from 'vite'
import { createStaticRankingData } from '../src/lib/snapshot.ts'
import { createPublicArtifactWritePlan } from '../src/lib/publicArtifacts/writePlan.ts'
import type { MatchRecord, TeamProfile } from '../src/types.ts'

// Ten teams in each of two regions, so region, size and page each change the rows on the board.
const regions = ['LEC', 'LCS'] as const
const prefixes = { LEC: 'Euro', LCS: 'Amer' }
const teams: Record<string, TeamProfile> = Object.fromEntries(regions.flatMap((region) =>
  Array.from({ length: 10 }, (_, index) => {
    const number = String(index + 1).padStart(2, '0')
    const name = `${prefixes[region]} ${number}`
    return [name, { name, code: `${prefixes[region][0]}${number}`, league: region, region }]
  })))

function roundRobin(region: typeof regions[number]): MatchRecord[] {
  const names = Object.values(teams).filter((team) => team.region === region).map((team) => team.name)
  return names.flatMap((teamA, a) => names.slice(a + 1).map((teamB, offset) => {
    const date = `2026-0${1 + (a % 6)}-${String(offset + 1).padStart(2, '0')}`
    return { id: `${region}-${teamA}-${teamB}`, sourceProvider: 'oracles-elixir', date, datetimeUtc: `${date}T12:00:00.000Z`, season: 2026,
      event: `${region} 2026`, phase: 'Regular season', region, league: region, patch: '', bestOf: 1, bestOfBasis: 'provider',
      tier: 'regional-regular', teamA, teamB, winner: teamA, teamAKills: 15, teamBKills: 9, teamAGold: 60_000, teamBGold: 55_000 }
  }))
}

// One MSI series gives the board an `international` tournament option with two teams.
const msi: MatchRecord = { id: 'MSI-Euro 01-Amer 01', sourceProvider: 'oracles-elixir', date: '2026-06-20', datetimeUtc: '2026-06-20T12:00:00.000Z',
  season: 2026, event: 'MSI 2026', phase: 'Bracket', region: 'International', league: 'MSI', patch: '', bestOf: 1, bestOfBasis: 'provider',
  tier: 'msi-bracket', teamA: 'Euro 01', teamB: 'Amer 01', winner: 'Euro 01', teamAKills: 15, teamBKills: 9, teamAGold: 60_000, teamBGold: 55_000 }

// Every address shows unranked teams too, so eligibility rules cannot hide a fixture team.
const board = (params: string) => `#rankings?scope=all&eligibility=all${params ? `&${params}` : ''}`

async function boardRows(page: Page) {
  return page.locator('table tbody tr').evaluateAll((rows) => rows.map((row) => row.querySelector('td:nth-child(2)')?.textContent ?? ''))
}

/** Waits until the board shows `count` rows whose team cell contains `prefix`, then reports what it shows. */
async function expectBoard(page: Page, count: number, prefix: string, step: string) {
  await page.waitForFunction(({ count, prefix }) => {
    const rows = [...document.querySelectorAll('table tbody tr td:nth-child(2)')].map((cell) => cell.textContent ?? '')
    return rows.length === count && rows.every((row) => row.includes(prefix))
  }, { count, prefix }, { timeout: 5_000 }).catch(() => undefined)
  const rows = await boardRows(page)
  assert.ok(rows.length === count && rows.every((row) => row.includes(prefix)),
    `${step}: expected ${count} ${prefix || 'any'} rows for ${await page.evaluate(() => location.hash)}, got ${JSON.stringify(rows)}`)
}

test('the Rankings board follows its address after load: typed and linked hashes, Back and Forward', { timeout: 60_000 }, async () => {
  const data = createStaticRankingData({ matches: [...regions.flatMap(roundRobin), msi], teams, rosters: {},
    generatedAt: '2026-07-01T00:00:00.000Z', dataMode: 'seeded-sample' })
  const bodies = new Map(createPublicArtifactWritePlan(data).writes.map((write) => [`/data/${write.relativePath}`, write.contents]))
  const fixture: Plugin = { name: 'ranking-board-address-fixture', configureServer(server) {
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
    const base = `http://127.0.0.1:${address.port}/`
    const executablePath = chromium.executablePath()
    browser = await chromium.launch(existsSync(executablePath) ? { headless: true } : { headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const setHash = (hash: string) => page.evaluate((next) => { location.hash = next }, hash)

    await page.goto(`${base}${board('region=LEC')}`)
    await expectBoard(page, 10, 'Euro', 'first load')

    // A typed address and an in-app link change the hash in the open tab.
    await setHash(board('region=LCS'))
    await expectBoard(page, 10, 'Amer', 'region changed in the hash')
    await setHash(board('size=15'))
    await expectBoard(page, 15, '', 'size changed in the hash')
    await setHash(board('size=15&page=2'))
    await expectBoard(page, 5, '', 'page changed in the hash')
    // App owns the search and the board owns the region: both come from the same address.
    await setHash(board('team=Amer+0&region=LCS'))
    await expectBoard(page, 9, 'Amer 0', 'search and region changed together')

    await page.goBack()
    await expectBoard(page, 5, '', 'Back to page 2')
    await page.goBack()
    await page.goBack()
    await expectBoard(page, 10, 'Amer', 'Back to the LCS address')
    await page.goForward()
    await expectBoard(page, 15, '', 'Forward to the size address')

    // The board still writes its own filters to the address.
    await setHash(board('region=LEC'))
    await expectBoard(page, 10, 'Euro', 'region changed after Forward')
    await page.getByRole('group', { name: 'Region' }).getByRole('button', { name: 'All regions', exact: true }).click()
    await page.waitForFunction(() => !new URLSearchParams(location.hash.split('?')[1]).has('region'))
    await expectBoard(page, 20, '', 'All regions chip')

    // App owns the tournament filter, and it follows the address like the board's own filters.
    await setHash(board('tournament=international'))
    await expectBoard(page, 2, '', 'tournament changed in the hash')
    await setHash(board('tournament=international&size=15'))
    await expectBoard(page, 2, '', 'size changed with a tournament')

    // The logo opens the same clean board as the Rankings tab. It is ranked
    // only, and no fixture team is ranked, so the address and chips show it.
    const hash = () => page.evaluate(() => location.hash)
    const home = page.getByTitle('Go to Rankings home')
    const selectedRegion = page.getByRole('group', { name: 'Region' }).getByRole('button', { pressed: true })
    await setHash(board('region=LEC&size=15'))
    await expectBoard(page, 10, 'Euro', 'filters before the logo')
    await home.click()
    await page.waitForFunction(() => location.hash === '#rankings?scope=all', undefined, { timeout: 5_000 }).catch(() => undefined)
    assert.equal(await hash(), '#rankings?scope=all')
    // The hash changes before React commits the region selection.
    await selectedRegion.filter({ hasText: /^All regions$/ }).waitFor({ state: 'visible', timeout: 5_000 })
    assert.equal(await selectedRegion.textContent(), 'All regions')
    // A second click leaves the hash unchanged, so no hashchange fires.
    await home.click()
    assert.equal(await hash(), '#rankings?scope=all')
    assert.equal(await selectedRegion.textContent(), 'All regions')

    // A fresh load reads what the board wrote: the page, and a sort whose direction the address omits.
    await page.goto('about:blank')
    await page.goto(`${base}${board('size=15&page=2')}`)
    await expectBoard(page, 5, '', 'page on first load')
    await page.goto('about:blank')
    await page.goto(`${base}${board('sort=rating')}`)
    await expectBoard(page, 20, '', 'sort on first load')
    assert.equal(await page.locator('.board-sort select').inputValue(), 'rating:descending')
    assert.equal(new URLSearchParams((await page.evaluate(() => location.hash)).split('?')[1]).get('dir'), null)
  } finally { await browser?.close(); await server.close() }
})
