import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium, type Page } from 'playwright-core'
import { createServer, type Plugin } from 'vite'

const at = '2026-10-20T12:00:00.000Z'
const mainId = '2026 Season World Championship/Main Event'
const sizes = [8, 8, 8, 6, 3]
const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa']

type FixtureTeam = { id: string | null; name: string | null; code: null; gameWins: number | null; outcome: string | null }
function team(name: string | null, gameWins: number | null = null, outcome: string | null = null): FixtureTeam {
  return { id: name, name, code: null, gameWins, outcome }
}
function swissSeries(round: number, slot: number, teams: FixtureTeam[] = [team(null), team(null)], status = 'upcoming') {
  return {
    id: `${mainId}_Round ${round}_${slot + 1}`, eventId: mainId, startTime: `2026-10-${22 + round}T${String(10 + slot).padStart(2, '0')}:00:00.000Z`,
    stage: `Round ${round}`, status, sourceState: status === 'completed' ? 'completed' : 'scheduled', bestOf: round > 3 ? 3 : 1, teams, vodUrls: [],
  }
}
function fixtureFeed() {
  return {
    version: 1, source: 'leaguepedia-cargo', unsupportedApi: false, dataMode: 'synthetic-fixture', fetchedAt: at, sourceUpdatedAt: null,
    coverage: { start: '2026-10-06T00:00:00.000Z', end: '2026-12-05T23:59:59.999Z', complete: true, warnings: [] as string[] },
    events: [
      { id: mainId, sourceTournamentId: mainId, competition: 'worlds', label: 'Worlds 2026 Main Event', season: '2026',
        series: sizes.flatMap((size, index) => Array.from({ length: size }, (_, slot) => swissSeries(index + 1, slot))) },
      { id: 'lcs:2027:promotion', sourceTournamentId: 'LCS/2027 Season/Promotion', competition: 'lcs', label: 'LCS 2027 Promotion', season: '2027',
        series: [{ ...swissSeries(1, 0, [team('Rook'), team('Pawn')]), id: 'lcs-promo', eventId: 'lcs:2027:promotion', stage: 'Finals', bestOf: 5 }] },
    ],
  }
}

test('Swiss preview builds, compares, shares and resets scenarios without changing live data', { timeout: 90_000 }, async () => {
  const feed = fixtureFeed()
  const requests: string[] = []
  const fixturePlugin: Plugin = {
    name: 'swiss-preview-fixture',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        if (!path.startsWith('/data/') && !path.startsWith('/tournament-data/')) return next()
        requests.push(`${request.method} ${path}`)
        response.setHeader('content-type', 'application/json')
        if (path === '/tournament-data/feed.json') return response.end(JSON.stringify(feed))
        if (path === '/tournament-data/feed.json.health.json') return response.end(JSON.stringify({ checkedAt: feed.fetchedAt, complete: true, warnings: [] }))
        response.statusCode = 503
        response.end(JSON.stringify({ error: 'ranking artifacts unavailable' }))
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'Europe/Vienna' })
    const external: string[] = []
    const errors: string[] = []
    page.on('request', (request) => { if (!request.url().startsWith(base)) external.push(request.url()) })
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.clock.install({ time: new Date(at) })

    await page.goto(`${base}/#tournaments?event=${encodeURIComponent(mainId)}`)
    await page.getByRole('heading', { name: 'Worlds 2026 Main Event' }).waitFor()
    await page.getByRole('button', { name: 'Swiss preview' }).click()
    await page.getByRole('heading', { name: 'Worlds 2026 Swiss preview' }).waitFor()
    assert.match(page.url(), /view=swiss/)
    assert.match(await body(page), /Live draws are not available: The Round 1 draw is not in the schedule yet\./)
    assert.equal(await page.locator('#swiss-start').inputValue(), 'seeds')
    assert.equal(await page.locator('#swiss-start option[value="live"]').isDisabled(), true)
    assert.doesNotMatch(await body(page), /\d+(\.\d+)?%/, 'the preview shows no odds')

    await page.locator('#swiss-playin').selectOption('LCS')
    await page.getByRole('button', { name: 'Fill a valid draw' }).click()
    const roundOne = page.getByRole('region', { name: 'Round 1' })
    await roundOne.waitFor()
    assert.equal(await roundOne.evaluate((element) => element === document.activeElement), true, 'focus moves to the drawn round')
    assert.equal(await roundOne.getByRole('group').count(), 8)
    assert.equal(await roundOne.getByRole('group', { name: 'Round 1: LCS 1 against Play-In winner' }).count(), 0, 'no same-region pairing')

    const firstPick = roundOne.getByRole('group').first().getByRole('button').first()
    for (let presses = 0; presses < 6 && !await firstPick.evaluate((element) => element === document.activeElement); presses++) await page.keyboard.press('Tab')
    assert.equal(await firstPick.evaluate((element) => element === document.activeElement), true, 'the first pick is reachable by keyboard')
    await page.keyboard.press('Enter')
    assert.equal(await firstPick.getAttribute('aria-pressed'), 'true')
    assert.match(await firstPick.innerText(), /Your pick/)
    await pickAll(page, 1, 0)
    await page.getByRole('region', { name: 'Round 2' }).getByText('Not drawn yet.').waitFor()
    assert.match(await page.getByRole('region', { name: 'Round 2' }).innerText(), /1–0\s+LCK 1, /)

    await page.getByRole('button', { name: 'Fill a valid draw' }).click()
    const roundTwo = page.getByRole('region', { name: 'Round 2' })
    await roundTwo.getByRole('button', { name: 'Change pairings' }).click()
    const swap = roundTwo.getByLabel('Opponent for LCK 1')
    const before = await swap.inputValue()
    const choice = await swap.locator('option:not([disabled])').evaluateAll((options, current) => options.map((option) => (option as HTMLOptionElement).value).find((value) => value !== current), before)
    assert.ok(choice, 'another valid opponent exists')
    await swap.selectOption(choice!)
    await roundTwo.getByRole('group', { name: `Round 2: LCK 1 against ${seedLabel(choice!)}`, exact: true }).waitFor()
    await pickAll(page, 2, 0)
    const standings = page.getByRole('region', { name: 'Standings' })
    assert.match(await standings.innerText(), /Scenarios A and B differ for 16 teams\./)

    await page.getByRole('button', { name: 'B', exact: true }).click()
    await page.getByRole('button', { name: 'Copy A into B' }).click()
    assert.match(await standings.innerText(), /Scenarios A and B have the same records\./)
    const roundTwoFirst = page.getByRole('region', { name: 'Round 2' }).getByRole('group').first()
    await roundTwoFirst.getByRole('button').last().click()
    assert.match(await standings.innerText(), /Scenarios A and B differ for 2 teams\./)
    const shared = page.url()
    assert.match(shared, /scenario=b/)

    await page.reload()
    await page.getByRole('heading', { name: 'Worlds 2026 Swiss preview' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'B', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.match(await page.getByRole('region', { name: 'Standings' }).innerText(), /Scenarios A and B differ for 2 teams\./)
    assert.equal(await page.locator('#swiss-playin').inputValue(), 'LCS')

    await page.getByRole('region', { name: 'Round 1' }).getByRole('group').first().getByRole('button').last().click()
    await page.getByText('The next round was cleared, because it was drawn from records that changed.').waitFor()
    await page.getByRole('region', { name: 'Round 2' }).getByText('Not drawn yet.').waitFor()
    await page.getByRole('button', { name: 'Reset B' }).click()
    await page.getByText('Scenario B is back at the starting point.').waitFor()
    assert.equal(await page.getByRole('region', { name: 'Round 1' }).getByText('Not drawn yet.').count(), 1)

    // The live draw appears in the schedule. Live results are locked; a live result replaces a pick on the same match.
    const main = feed.events[0]
    main.series.filter((series) => series.stage === 'Round 1').forEach((series, slot) => {
      series.teams = slot < 7 ? [team(names[slot * 2], 1, 'win'), team(names[slot * 2 + 1], 0, 'loss')] : [team(names[14]), team(names[15])]
      series.status = slot < 7 ? 'completed' : 'upcoming'
    })
    feed.fetchedAt = '2026-10-23T20:00:00.000Z'
    await page.getByRole('button', { name: 'Refresh' }).click()
    await page.locator('#swiss-start option[value="live"]:not([disabled])').waitFor({ state: 'attached' })
    assert.equal(await page.locator('#swiss-start').inputValue(), 'seeds', 'new live draws never re-read a seed scenario')
    assert.match(await page.getByRole('region', { name: 'Standings' }).innerText(), /LCK 1/)
    await page.locator('#swiss-start').selectOption('live')
    await page.getByText('Both scenarios were reset for the new starting point.').waitFor()
    const liveRound = page.getByRole('region', { name: 'Round 1' })
    assert.match(await liveRound.innerText(), /Live draw/)
    assert.equal(await liveRound.getByRole('group', { name: 'Round 1: Alpha against Bravo' }).getByRole('button').count(), 0, 'live results cannot be changed')
    assert.match(await liveRound.getByRole('group', { name: 'Round 1: Alpha against Bravo' }).innerText(), /Alpha\s+Won[\s\S]*Bravo\s+Lost/)
    await liveRound.getByRole('group', { name: 'Round 1: Oscar against Papa' }).getByRole('button', { name: /Papa/ }).click()
    await page.getByRole('region', { name: 'Round 2' }).getByText('Not drawn yet.').waitFor()

    main.series.find((series) => series.id.endsWith('Round 1_8'))!.teams = [team('Oscar', 1, 'win'), team('Papa', 0, 'loss')]
    main.series.find((series) => series.id.endsWith('Round 1_8'))!.status = 'completed'
    feed.fetchedAt = '2026-10-23T21:00:00.000Z'
    await page.getByRole('button', { name: 'Refresh' }).click()
    await page.getByText('Live results replaced one of your picks.').waitFor()
    assert.match(await liveRound.getByRole('group', { name: 'Round 1: Oscar against Papa' }).innerText(), /Oscar\s+Won/)

    await page.getByRole('button', { name: 'Schedule' }).click()
    await page.getByRole('heading', { name: 'Worlds 2026 Main Event' }).waitFor()
    assert.doesNotMatch(page.url(), /view=swiss/)
    assert.match(await page.locator('section[aria-label="results"]').innerText(), /Alpha 1–0 Bravo/)
    assert.match(await page.locator('section[aria-label="results"]').innerText(), /Oscar 1–0 Papa/)

    await page.locator('#tournament-event').selectOption('lcs:2027:promotion')
    await page.getByRole('heading', { name: 'LCS 2027 Promotion' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Swiss preview' }).count(), 0, 'the preview belongs to Worlds 2026 only')

    await page.goto(`${base}/#tournaments?event=${encodeURIComponent(mainId)}&view=swiss`)
    await page.getByRole('heading', { name: 'Worlds 2026 Swiss preview' }).waitFor()
    for (const width of [320, 390, 768, 1024]) {
      await page.setViewportSize({ width, height: 900 })
      const layout = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }))
      assert.ok(layout.content <= layout.viewport, `Horizontal overflow at ${width}px: ${JSON.stringify(layout)}`)
    }

    assert.deepEqual(errors, [])
    assert.deepEqual(external, [])
    assert.ok(requests.every((entry) => entry.startsWith('GET ')), `Only reads are sent: ${requests.filter((entry) => !entry.startsWith('GET '))}`)
  } finally {
    await browser?.close()
    await server.close()
  }
})

function seedLabel(seed: string) {
  return seed === 'PLAYIN' ? 'Play-In winner' : seed.replace(/(\d+)$/, ' $1')
}
async function body(page: Page) {
  return page.locator('body').innerText()
}

/** Picks the first (0) or second (1) team in every open match of a round. */
async function pickAll(page: Page, round: number, side: 0 | 1) {
  const groups = page.getByRole('region', { name: `Round ${round}` }).getByRole('group')
  for (let index = 0; index < await groups.count(); index++) {
    const button = groups.nth(index).getByRole('button').nth(side)
    if (await button.getAttribute('aria-pressed') !== 'true') await button.click()
  }
}
