import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium, type Page } from 'playwright-core'
import { createServer } from 'vite'
import { tournamentMovementShardUrlPathForId } from '../src/domains/rankings/internal/published/schema.ts'
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
    page.setDefaultNavigationTimeout(30_000)
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'connection', { value: { saveData: true } })
      const events: Array<{ type: string; trusted: boolean }> = []
      Reflect.set(window, 'teamNavigationEvents', events)
      Reflect.set(window, 'initialHistoryLength', history.length)
      for (const name of ['hashchange', 'popstate']) window.addEventListener(name, (event) => events.push({ type: event.type, trusted: event.isTrusted }))
    })
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
      fixture.held.add('/data/scopes/season-2025.json')
      await page.goto(`${base}${invalid}`)
      await page.locator('table tbody tr').first().waitFor()
      const entries = await page.evaluate(() => Reflect.get(window, 'initialHistoryLength'))
      await notice(page).waitFor()
      assert.equal(await drawer(page).count(), 0)
      assert.deepEqual(await query(page), { scope: 'season:2026', eligibility: 'all', team: 'Synthetic', sort: 'rating', keep: 'untouched' })
      assert.equal(await page.evaluate(() => history.length), entries, 'Repair replaces the current entry')
      await page.getByRole('heading', { name: 'Power over time', exact: true }).hover()
      await page.locator('.recharts-line-curve').first().waitFor()
      assert.ok(fixture.requests.some((path) => path.startsWith('/data/history/team-series/')))
      await page.getByLabel('Season', { exact: true }).selectOption('2025')
      await page.getByRole('status').filter({ hasText: 'Loading 2025 source season' }).waitFor()
      assert.equal((await query(page)).teamDetail, undefined)
      fixture.release('/data/scopes/season-2025.json')
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

const setHash = (page: Page, hash: string) => page.evaluate((next) => { location.hash = next }, hash)
const repaired = (page: Page) => page.waitForFunction(() => !new URLSearchParams(location.hash.split('?')[1]).has('teamDetail'))

async function expectTeam(page: Page, name: string) {
  await drawer(page).getByRole('heading', { name: `Synthetic ${name}`, exact: true }).waitFor()
}

for (const width of [1280, 390]) {
  for (const cold of [false, true]) {
    test(`an omitted-scope native rejection stays consumed after a ${cold ? 'cold' : 'warm'} scope switch and reload at ${width}px`, { timeout: 60_000 }, async () => {
      await withFixture(async (page, base, fixture) => {
        if (cold) fixture.held.add('/data/scopes/season-2025.json')
        else {
          await page.goto(`${base}${board('2025')}`)
          await page.getByTitle('Open Synthetic Retired', { exact: true }).waitFor()
        }
        if (cold) await page.goto(`${base}${board()}`)
        else {
          await page.getByLabel('Season', { exact: true }).selectOption('2026')
          await page.getByTitle('Open Synthetic Retired', { exact: true }).waitFor({ state: 'hidden' })
        }
        await page.getByTitle('Open Synthetic Alpha', { exact: true }).waitFor()
        for (let repeat = 0; repeat < 2; repeat++) {
          const before = await page.evaluate(() => ({ entries: history.length, events: Reflect.get(window, 'teamNavigationEvents').length }))
          await setHash(page, `#rankings?eligibility=all&teamDetail=${teamIds.retired}`)
          await notice(page).waitFor()
          assert.equal(await page.getByLabel('Season', { exact: true }).inputValue(), '2026')
          await repaired(page)
          assert.deepEqual(await query(page), { eligibility: 'all' })
          assert.equal(await drawer(page).count(), 0)
          assert.equal(await page.evaluate(() => history.length), before.entries + 1, 'Only the native navigation adds an entry')
          const events = await page.evaluate(() => Reflect.get(window, 'teamNavigationEvents') as Array<{ type: string; trusted: boolean }>)
          const received = events.slice(before.events)
          assert.equal(received.filter((event) => event.type === 'hashchange').length, 1)
          assert.ok(received.every((event) => event.trusted), 'Repair emits no synthetic global event')
        }
        await page.getByRole('heading', { name: 'Power over time', exact: true }).hover()
        await page.locator('.recharts-line-curve').first().waitFor()
        assert.ok(fixture.requests.some((path) => path.startsWith('/data/history/team-series/')))
        await page.getByLabel('Season', { exact: true }).selectOption('2025')
        if (cold) {
          await page.getByRole('status').filter({ hasText: 'Loading 2025 source season' }).waitFor()
          assert.equal((await query(page)).teamDetail, undefined)
          fixture.release('/data/scopes/season-2025.json')
        }
        await page.getByTitle('Open Synthetic Retired', { exact: true }).waitFor()
        assert.equal(await drawer(page).count(), 0)
        assert.equal(await notice(page).count(), 0)
        await page.reload()
        await page.getByTitle('Open Synthetic Retired', { exact: true }).waitFor()
        assert.equal(await drawer(page).count(), 0, 'Reload cannot revive the rejected request')
        assert.equal((await query(page)).teamDetail, undefined)
      }, width)
    })
  }
}

test('valid omitted-scope native links retain the selected season, filters and unknown parameters', { timeout: 60_000 }, async () => {
  await withFixture(async (page, base) => {
    for (const [season, name, id] of [['2025', 'Retired', teamIds.retired], ['2026', 'Alpha', teamIds.alpha]]) {
      await page.goto(`${base}${board(season)}`)
      await page.getByTitle(`Open Synthetic ${name}`, { exact: true }).waitFor()
      await setHash(page, `#rankings?eligibility=all&teamDetail=${id}&team=Hidden&region=LEC&sort=wins&size=15&keep=omitted`)
      await expectTeam(page, name)
      assert.equal(await page.getByLabel('Season', { exact: true }).inputValue(), season)
      assert.equal(await notice(page).count(), 0)
      assert.deepEqual(await query(page), { eligibility: 'all', teamDetail: id, team: 'Hidden', region: 'LEC', sort: 'wins', size: '15', keep: 'omitted' })
      const entries = await page.evaluate(() => history.length)
      await drawer(page).getByRole('button', { name: 'Close', exact: true }).click()
      await drawer(page).waitFor({ state: 'hidden' })
      assert.equal(await page.evaluate(() => history.length), entries)
      assert.equal((await query(page)).keep, 'omitted')
      assert.equal((await query(page)).teamDetail, undefined)
    }
  })
})

test('a rejected link stays consumed through a warm scope change and repeated native requests are distinct', { timeout: 60_000 }, async () => {
  await withFixture(async (page, base) => {
    await page.goto(`${base}${board('2025')}`)
    await page.getByTitle('Open Synthetic Retired', { exact: true }).waitFor()
    for (let repeat = 0; repeat < 2; repeat++) {
      const before = await page.evaluate(() => Reflect.get(window, 'teamNavigationEvents').filter((event: { type: string }) => event.type === 'hashchange').length)
      await setHash(page, invalid)
      await notice(page).waitFor()
      await repaired(page)
      const events = await page.evaluate(() => Reflect.get(window, 'teamNavigationEvents') as Array<{ type: string; trusted: boolean }>)
      assert.equal(events.filter((event) => event.type === 'hashchange').length, before + 1)
      assert.ok(events.every((event) => event.trusted), 'Repair emits no synthetic global event')
      await notice(page).getByRole('button', { name: 'Dismiss', exact: true }).click()
      assert.equal(await notice(page).count(), 0)
    }
    await setHash(page, invalid)
    await notice(page).waitFor()
    await repaired(page)
    await page.getByLabel('Season', { exact: true }).selectOption('2025')
    await page.getByTitle('Open Synthetic Retired', { exact: true }).waitFor()
    assert.equal(await drawer(page).count(), 0)
    assert.equal(await notice(page).count(), 0)
    await page.getByLabel('Season', { exact: true }).selectOption('2026')
    await page.getByTitle('Open Synthetic Alpha', { exact: true }).waitFor()
    assert.equal(await notice(page).count(), 0, 'Returning does not revive the old notice')
  })
})

test('valid cold and native links retain filters and use replace-close or push/Back as appropriate', { timeout: 60_000 }, async () => {
  await withFixture(async (page, base) => {
    await page.goto(`${base}${board('2026', `teamDetail=${teamIds.alpha}&keep=safe`)}`)
    await expectTeam(page, 'Alpha')
    await drawer(page).locator('.recharts-line-curve').first().waitFor()
    const initial = await page.evaluate(() => history.length)
    await drawer(page).getByRole('button', { name: 'Close', exact: true }).click()
    await drawer(page).waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => history.length), initial)
    assert.deepEqual(await query(page), { scope: 'season:2026', eligibility: 'all', keep: 'safe' })
    await page.getByTitle('Open Synthetic Beta', { exact: true }).click()
    await expectTeam(page, 'Beta')
    assert.equal(await page.evaluate(() => history.length), initial + 1)
    await drawer(page).getByRole('button', { name: 'Close', exact: true }).click()
    await drawer(page).waitFor({ state: 'hidden' })
    await page.getByTitle('Open Synthetic Beta', { exact: true }).click()
    await expectTeam(page, 'Beta')
    await page.goBack()
    await drawer(page).waitFor({ state: 'hidden' })
    await page.goForward()
    await expectTeam(page, 'Beta')
    const forwarded = await page.evaluate(() => history.length)
    await drawer(page).getByRole('button', { name: 'Close', exact: true }).click()
    await drawer(page).waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => history.length), forwarded)
    for (const [name, id] of [['Alpha', teamIds.alpha], ['Beta', teamIds.beta]]) {
      await setHash(page, board('2026', `teamDetail=${id}&team=Hidden&region=LEC&tier=S&sort=wins&size=15&keep=safe`))
      await expectTeam(page, name)
      assert.equal((await query(page)).teamDetail, id, 'Board filters cannot prove absence')
      assert.equal(await notice(page).count(), 0)
    }
  })
})

for (const width of [1280, 390]) {
  test(`Forward applies the scope and team from one native receipt at ${width}px`, { timeout: 60_000 }, async () => {
    await withFixture(async (page, base) => {
      await page.goto(`${base}${board('2025')}`)
      await page.getByTitle('Open Synthetic Retired', { exact: true }).click()
      await expectTeam(page, 'Retired')
      await page.goBack()
      await drawer(page).waitFor({ state: 'hidden' })
      await page.getByLabel('Season', { exact: true }).selectOption('2026')
      await page.getByTitle('Open Synthetic Alpha', { exact: true }).waitFor()
      await page.goForward()
      await expectTeam(page, 'Retired')
      assert.equal((await query(page)).scope, 'season:2025')
      assert.equal((await query(page)).teamDetail, teamIds.retired)
      assert.equal(await notice(page).count(), 0)
    }, width)
  })
}

test('normalization and pending or failed data never supply false absence evidence', { timeout: 60_000 }, async () => {
  await withFixture(async (page, base, fixture) => {
    const target = '/data/scopes/season-2026.json'
    for (const scope of ['2019', '2026:checkpoint:missing']) {
      fixture.held.add('/data/ranking-summary.json')
      fixture.held.add(target)
      await page.goto(`${base}?case=${scope}${board(scope, `teamDetail=${teamIds.retired}&keep=normalized`)}`)
      await page.getByRole('heading', { name: 'Team Power Index', exact: true }).waitFor()
      assert.equal((await query(page)).teamDetail, teamIds.retired)
      fixture.release('/data/ranking-summary.json')
      await page.getByRole('status').filter({ hasText: 'Loading 2026 source season' }).waitFor()
      assert.equal((await query(page)).teamDetail, teamIds.retired)
      fixture.release(target)
      await notice(page).waitFor()
      await repaired(page)
      assert.equal((await query(page)).scope, 'season:2026')
      assert.equal((await query(page)).keep, 'normalized')
    }
    const oldScope = '/data/scopes/season-2025.json'
    fixture.held.add(oldScope)
    await page.goto(`${base}?case=valid-pending${board('2025', `teamDetail=${teamIds.retired}`)}`)
    await page.getByRole('status').filter({ hasText: 'Loading 2025 source season' }).waitFor()
    assert.equal((await query(page)).teamDetail, teamIds.retired)
    await setHash(page, board('2026', `teamDetail=${teamIds.alpha}`))
    await expectTeam(page, 'Alpha')
    fixture.release(oldScope)
    await drawer(page).locator('.recharts-line-curve').first().waitFor()
    assert.equal((await query(page)).teamDetail, teamIds.alpha)
    assert.equal((await query(page)).scope, 'season:2026')
    fixture.failed.add(target)
    await page.goto(`${base}?case=failed${board('2026', `teamDetail=${teamIds.alpha}`)}`)
    await page.getByText('Snapshot unavailable for 2026 source season', { exact: true }).waitFor()
    assert.equal((await query(page)).teamDetail, teamIds.alpha)
    assert.equal(await notice(page).count(), 0)
    fixture.failed.delete(target)
    fixture.held.add(target)
    await page.goto(`${base}?case=depart${board('2026', `teamDetail=${teamIds.retired}`)}`)
    await page.getByRole('status').filter({ hasText: 'Loading 2026 source season' }).waitFor()
    await setHash(page, '#tournaments?scope=season:2026&keep=departed&teamDetail=external')
    await page.getByRole('heading', { name: 'Tournaments', exact: true }).first().waitFor()
    fixture.release(target)
    assert.equal(await page.evaluate(() => location.hash), '#tournaments?scope=season:2026&keep=departed&teamDetail=external')
  })
})

test('a valid team key survives delayed exact tournament projection without a scope-row drawer fallback', { timeout: 60_000 }, async () => {
  await withFixture(async (page, base, fixture) => {
    const path = tournamentMovementShardUrlPathForId('msi:2025')
    assert.ok(fixture.bodies.has(path), 'The fixture contains the exact MSI 2025 projection')
    fixture.held.add(path)
    const requested = page.waitForRequest((request) => new URL(request.url()).pathname === path)
    await page.goto(`${base}${board('2025', `tournament=tournament:msi:2025&teamDetail=${teamIds.retired}&keep=projected`)}`)
    await expectTeam(page, 'Retired')
    assert.equal((await query(page)).teamDetail, teamIds.retired)
    await requested
    fixture.release(path)
    await page.getByRole('heading', { name: 'MSI 2025 standings', exact: true }).waitFor()
    await drawer(page).waitFor({ state: 'hidden' })
    assert.equal((await query(page)).teamDetail, teamIds.retired)
    assert.equal(await notice(page).count(), 0)
    assert.equal(await page.getByTitle('Open Synthetic Retired', { exact: true }).count(), 0)
    await setHash(page, board('2025', `tournament=tournament:msi:2025&teamDetail=${teamIds.alpha}`))
    await expectTeam(page, 'Alpha')
    await drawer(page).locator('.recharts-line-curve').first().waitFor()
    assert.equal((await query(page)).tournament, 'tournament:msi:2025')
  })
})
