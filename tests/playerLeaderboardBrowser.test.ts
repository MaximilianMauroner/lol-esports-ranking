import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium, type Page } from 'playwright-core'
import { createServer, type Plugin } from 'vite'
import { createStaticRankingData } from '../src/domains/rankings/internal/projections/snapshot.ts'
import { createPublicArtifactWritePlan } from '../src/domains/rankings/internal/published/writePlan.ts'
import { statsPowerPolicy } from '../src/domains/rankings/internal/policy/statsPowerPolicy.ts'
import type { CompactPlayer, MatchRecord, PublicPlayerDirectory } from '../src/domains/rankings/types.ts'

const playerPath = '/data/entities/players.json'
const playersAddress = '#players?scope=season%3A2026'

function player(name: string, team: string, role: CompactPlayer['role'], rating: number, rank: number): CompactPlayer {
  return {
    id: `synthetic-${name}`, name, team, role, rating, rank, games: 30 + rank,
    delta: 0, impactMultiplier: 1, ratingBasis: 'sourced-player-stats', sourceProvider: 'synthetic-fixture',
  }
}

function withStatsPower(row: CompactPlayer, score: number, sampleGames: number): CompactPlayer {
  const evidence = { observed: sampleGames, missing: row.games - sampleGames, effectiveGames: sampleGames }
  return {
    ...row,
    teamGames: 10 + row.rank,
    statsPower: {
      version: statsPowerPolicy.version, score, role: row.role, sampleGames, eligibleGames: row.games, priorOnly: sampleGames === 0,
      leagueAnchor: 100, evidenceThrough: '2025-07-01',
      metrics: Object.fromEntries(statsPowerPolicy.roleMetrics[row.role].map((metric) => [metric, evidence])),
    },
  }
}

function fixtureBodies() {
  const matches: MatchRecord[] = [2024, 2025, 2026].map((season) => ({
    id: `synthetic-${season}`, sourceProvider: 'seed', date: `${season}-07-01`,
    datetimeUtc: `${season}-07-01T12:00:00.000Z`, season, event: season === 2026 ? 'MSI 2026' : `Synthetic ${season}`,
    phase: 'Regular season', region: season === 2026 ? 'International' : 'LCK', league: season === 2026 ? 'MSI' : 'LCK', patch: '', bestOf: 1, bestOfBasis: 'provider',
    tier: 'regional-regular', teamA: 'Fixture Alpha', teamB: 'Fixture Beta', winner: 'Fixture Alpha',
    teamAKills: 10, teamBKills: 5, teamAGold: 60_000, teamBGold: 55_000,
  }))
  const data = createStaticRankingData({
    matches, teams: {
      'Fixture Alpha': { name: 'Fixture Alpha', code: 'FXA', league: 'LCK', region: 'LCK' },
      'Fixture Beta': { name: 'Fixture Beta', code: 'FXB', league: 'LCK', region: 'LCK' },
    }, rosters: {}, generatedAt: '2026-07-02T00:00:00.000Z', dataMode: 'seeded-sample',
    materializeSnapshotKeys: new Set(['All__All__All', '2026__All__All', '2026__All__All__split-2', '2025__All__All', '2024__All__All']),
    materializeTournamentIds: new Set(),
  })
  const bodies = new Map(createPublicArtifactWritePlan(data).writes.map((write) => [`/data/${write.relativePath}`, write.contents]))
  const original = bodies.get(playerPath)
  assert.ok(original, 'The fixture must use the normal published player artifact')
  const seasonPlayers = [
    player('Cedar', 'Fixture Beta', 'Mid', 230, 3),
    player('Aster', 'Fixture Alpha', 'Mid', 320, 1),
    player('Beacon', 'Fixture Alpha', 'Support', 260, 2),
  ]
  const legacy = player('Other-season only', 'Legacy Team', 'Top', 900, 1)
  const statsSeason = [
    withStatsPower(player('Delta', 'Legacy Team', 'Top', 400, 1), 101.2, 18),
    withStatsPower(player('Echo', 'Legacy Team', 'Mid', 300, 2), 104.5, 22),
    withStatsPower(player('Foxtrot', 'Legacy Team', 'Support', 200, 3), 104.5, 25),
  ]
  const directory: PublicPlayerDirectory = {
    ...JSON.parse(original) as PublicPlayerDirectory,
    sourceProvider: 'synthetic-fixture', ratedPlayerCount: 7, ratedTeamCount: 3,
    roles: ['Top', 'Mid', 'Support'], currentLineups: {},
    players: [legacy, ...seasonPlayers.map((row) => ({ ...row, rank: row.rank + 1 }))],
    scopedPlayers: { '2026__All__All': seasonPlayers, '2025__All__All': statsSeason, '2024__All__All': [] },
  }
  bodies.set(playerPath, JSON.stringify(directory))
  return bodies
}

async function expectPlayers(page: Page, names: string[]) {
  await page.waitForFunction((expected) => {
    const actual = [...document.querySelectorAll('table[aria-label="Player rankings"] tbody tr td:nth-child(2)')]
      .map((cell) => cell.textContent)
    return JSON.stringify(actual) === JSON.stringify(expected)
  }, names, { timeout: 5_000 })
  assert.deepEqual(await page.getByRole('table', { name: 'Player rankings' }).locator('tbody tr td:nth-child(2)').allTextContents(), names)
}

test('Players supports navigation, exact seasons, score order, addressed filters and explicit artifact states', { timeout: 60_000 }, async () => {
  const bodies = fixtureBodies()
  const requests: string[] = []
  let holdPlayers = true
  let playerStatus = 200
  const pendingPlayers: Array<() => void> = []
  const fixture: Plugin = { name: 'synthetic-player-leaderboard-fixture', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
      if (path.startsWith('/tournament-data/')) {
        response.statusCode = 503
        response.end('{}')
        return
      }
      if (!path.startsWith('/data/')) return next()
      requests.push(path)
      const respond = () => {
        response.statusCode = path === playerPath ? playerStatus : bodies.has(path) ? 200 : 404
        response.setHeader('content-type', 'application/json')
        response.setHeader('cache-control', 'no-store')
        response.end(response.statusCode === 200 ? bodies.get(path) : '{}')
      }
      if (path === playerPath && holdPlayers) pendingPlayers.push(respond)
      else respond()
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
    await page.addInitScript(() => {
      window.IntersectionObserver = class extends window.IntersectionObserver { observe() {} }
    })
    const navigation = page.getByRole('navigation', { name: 'Primary', exact: true }).filter({ visible: true })
    const search = page.getByRole('searchbox', { name: 'Find a player or team', exact: true })
    const role = page.getByRole('combobox', { name: 'Role', exact: true })
    const rows = page.getByRole('table', { name: 'Player rankings' }).locator('tbody tr')
    const setHash = (hash: string) => page.evaluate((next) => { location.hash = next }, hash)

    await page.goto(`${base}#rankings?scope=season%3A2026&eligibility=all`)
    await page.locator('table tbody tr').first().waitFor()
    await page.getByRole('group', { name: '2026 period', exact: true }).waitFor()
    await page.getByRole('group', { name: '2026 period', exact: true }).getByRole('button', { name: 'Split 2', exact: true }).click()
    await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('scope') === 'season:2026:checkpoint:split-2')
    assert.equal(requests.includes(playerPath), false, 'The team board must keep player artifacts lazy')
    await navigation.getByRole('link', { name: 'Players', exact: true }).click()
    await page.getByRole('heading', { name: 'Player rankings', exact: true }).waitFor()
    await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('scope') === 'season:2026', null, { timeout: 5_000 })
    await page.getByRole('status').filter({ hasText: 'Loading player rankings' }).waitFor()
    assert.equal(await page.getByRole('group', { name: '2026 period', exact: true }).count(), 0, 'Players must not offer unpublished checkpoint scopes')
    assert.equal(await rows.count(), 0, 'Pending player data must not show another scope')
    assert.equal(await navigation.getByRole('link', { name: 'Players', exact: true }).getAttribute('aria-current'), 'page')
    await navigation.getByRole('link', { name: 'Rankings', exact: true }).click()
    await page.getByRole('heading', { name: 'Team Power Index', exact: true }).waitFor()
    const directoryLoaded = page.waitForResponse((response) => new URL(response.url()).pathname === playerPath, { timeout: 5_000 })
    holdPlayers = false
    pendingPlayers.splice(0).forEach((respond) => respond())
    await directoryLoaded
    await navigation.getByRole('link', { name: 'Players', exact: true }).click()
    await expectPlayers(page, ['Aster', 'Beacon', 'Cedar'])
    assert.equal(requests.filter((path) => path === playerPath).length, 1, 'Leaving Players must keep its pending directory load')
    assert.deepEqual(await rows.locator('td:nth-child(5)').allTextContents(), ['320', '260', '230'])
    assert.deepEqual(await rows.locator('td:nth-child(6)').allTextContents(), ['31', '32', '33'])
    await page.getByRole('status').filter({ hasText: 'These are not official LoL Esports rankings.' }).waitFor()
    await page.getByText(/Source synthetic-fixture/).waitFor()
    await page.getByText(/Role Power uses model .+ includes individual stats, results, opponent strength and event context/).waitFor()
    assert.equal(await page.getByText(/Stats Power stats-power-v3 scores/).count(), 0, 'Role Power rows must not claim Stats Power')

    await navigation.getByRole('link', { name: 'Rankings', exact: true }).click()
    await page.getByRole('heading', { name: 'Team Power Index', exact: true }).waitFor()
    await page.getByRole('group', { name: '2026 period', exact: true }).getByRole('button', { name: 'Split 2', exact: true }).click()
    await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('scope') === 'season:2026:checkpoint:split-2')
    await navigation.getByRole('link', { name: 'Players', exact: true }).click()
    await expectPlayers(page, ['Aster', 'Beacon', 'Cedar'])
    await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('scope') === 'season:2026')
    for (const checkpoint of ['checkpoint%3Asplit-2', 'split-2']) {
      await page.goto(`${base}#players?scope=season%3A2026%3A${checkpoint}`)
      await expectPlayers(page, ['Aster', 'Beacon', 'Cedar'])
      await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('scope') === 'season:2026', null, { timeout: 5_000 })
      await page.goBack()
      await expectPlayers(page, ['Aster', 'Beacon', 'Cedar'])
    }
    await page.goBack()
    await page.getByRole('heading', { name: 'Team Power Index', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.split('?')[1]).get('scope')), 'season:2026:checkpoint:split-2')
    await page.goForward()
    await expectPlayers(page, ['Aster', 'Beacon', 'Cedar'])
    await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('scope') === 'season:2026')
    await page.reload()
    await expectPlayers(page, ['Aster', 'Beacon', 'Cedar'])
    await page.goto('about:blank')
    await page.goto(`${base}#players?scope=season%3A2026%3Acheckpoint%3Asplit-2`)
    await expectPlayers(page, ['Aster', 'Beacon', 'Cedar'])
    await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('scope') === 'season:2026')
    await page.reload()
    await expectPlayers(page, ['Aster', 'Beacon', 'Cedar'])

    await page.keyboard.press('/')
    assert.equal(await search.evaluate((input) => input === document.activeElement), true)
    await search.fill('Fixture')
    await role.selectOption('Mid')
    await expectPlayers(page, ['Aster', 'Cedar'])
    assert.deepEqual(await rows.locator('td:first-child').allTextContents(), ['1', '3'])
    await search.fill('cEdAr')
    await expectPlayers(page, ['Cedar'])
    await page.waitForFunction(() => {
      const query = new URLSearchParams(location.hash.split('?')[1])
      return location.hash.startsWith('#players?') && query.get('player') === 'cEdAr' && query.get('role') === 'Mid'
    })
    assert.equal(await page.getByRole('searchbox', { name: 'Find a team', exact: true }).count(), 0, 'Players search must not redirect to teams')
    await page.reload()
    await expectPlayers(page, ['Cedar'])
    assert.equal(await search.inputValue(), 'cEdAr')
    assert.equal(await role.inputValue(), 'Mid')
    assert.deepEqual(await rows.locator('td:first-child').allTextContents(), ['3'])

    await setHash(`${playersAddress}&player=Fixture+Alpha&role=Support`)
    await expectPlayers(page, ['Beacon'])
    await setHash(`${playersAddress}&role=Mid`)
    await expectPlayers(page, ['Aster', 'Cedar'])
    await page.goBack()
    await expectPlayers(page, ['Beacon'])
    await page.goForward()
    await expectPlayers(page, ['Aster', 'Cedar'])

    await search.fill('No such player')
    await page.getByRole('heading', { name: 'No players match these filters', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
    await expectPlayers(page, ['Aster', 'Beacon', 'Cedar'])
    await page.getByRole('combobox', { name: 'Season', exact: true }).selectOption('2025')
    await expectPlayers(page, ['Echo', 'Foxtrot', 'Delta'])
    assert.deepEqual(await rows.locator('td:first-child').allTextContents(), ['1', '1', '3'], 'Equal Stats Power shares a rank')
    assert.deepEqual(await rows.locator('td:nth-child(5)').allTextContents(), ['104.5', '104.5', '101.2'])
    assert.deepEqual(await rows.locator('td:nth-child(6)').allTextContents(), ['22', '25', '18'], 'Stat games stay separate from games')
    assert.deepEqual(await rows.locator('td:nth-child(7)').allTextContents(), ['300', '200', '400'], 'Role Power stays visible')
    assert.deepEqual(await rows.locator('td:nth-child(8)').allTextContents(), ['12', '13', '11'], 'Credited-team games stay separate from raw stat games')
    await page.getByRole('columnheader', { name: 'Stats Power', exact: true }).waitFor()
    await page.getByText(/Stats Power stats-power-v3 scores lane leads/).waitFor()
    await page.getByRole('combobox', { name: 'Season', exact: true }).selectOption('2024')
    await page.getByRole('heading', { name: 'No ranked players in this scope', exact: true }).waitFor()
    assert.equal(await rows.count(), 0, 'An empty exact season must not borrow all-season players')

    await page.goto('about:blank')
    await page.goto(`${base}${playersAddress}&player=Fixture&role=Mid`)
    await expectPlayers(page, ['Aster', 'Cedar'])
    assert.equal(await search.inputValue(), 'Fixture')
    for (const width of [320, 375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `The page must fit at ${width}px`)
      await search.focus()
      await search.press('Tab')
      assert.equal(await role.evaluate((select) => select === document.activeElement), true)
    }
    await page.setViewportSize({ width: 320, height: 900 })
    const table = page.getByRole('table', { name: 'Player rankings' })
    await table.focus()
    await table.press('ArrowRight')
    await page.waitForFunction(() => (document.querySelector('table[aria-label="Player rankings"]')?.parentElement?.scrollLeft ?? 0) > 0)
    await navigation.getByRole('link', { name: 'Rankings', exact: true }).click()
    await page.getByRole('heading', { name: 'Team Power Index', exact: true }).waitFor()
    await navigation.getByRole('link', { name: 'Players', exact: true }).click()
    await expectPlayers(page, ['Aster', 'Beacon', 'Cedar'])

    playerStatus = 503
    await page.reload()
    const error = page.getByRole('alert').filter({ hasText: 'Player rankings unavailable' })
    await error.waitFor()
    assert.equal(await rows.count(), 0)
    assert.equal(await navigation.getByRole('link', { name: 'Rankings', exact: true }).isVisible(), true)
    playerStatus = 200
    await error.getByRole('button', { name: 'Retry', exact: true }).click()
    await expectPlayers(page, ['Aster', 'Beacon', 'Cedar'])
    playerStatus = 404
    await page.reload()
    await error.waitFor()
    assert.equal(await rows.count(), 0)
  } finally {
    pendingPlayers.splice(0).forEach((respond) => respond())
    await browser?.close()
    await server.close()
  }
})
