import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { chromium, type Locator, type Page } from 'playwright-core'
import { createServer, type Plugin } from 'vite'
import { createPublicArtifactWritePlan } from '../src/domains/rankings/internal/published/writePlan'
import { createStaticRankingData } from '../src/domains/rankings/internal/projections/snapshot'
import { encodeChoices, fillDraw, resolveScenario, seedBaseline, type DrawnRound, type SwissBaseline } from '../src/domains/tournaments/internal/swissScenario'
import { worldsRandom } from '../src/domains/tournaments/internal/worldsSimulation'
import type { MatchRecord, TeamProfile } from '../src/domains/rankings/types'
import { closedSelectKeysChangeValue } from './fixtures/nativeSelect'

const at = '2026-10-20T12:00:00.000Z'
const mainId = '2026 Season World Championship/Main Event'
const playInId = '2026 Season World Championship/Play-In'
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
/** Power ratings for the seeded field and Fnatic. Each team beats every team after it, so ratings fall down the list. */
function rankingArtifacts() {
  const field: Array<[string, TeamProfile['region']]> = [['Gen.G', 'LCK'], ['Hanwha Life Esports', 'LCK'], ['T1', 'LCK'], ['Dplus KIA', 'LCK'], ["Anyone's Legend", 'LPL'],
    ['Bilibili Gaming', 'LPL'], ['Top Esports', 'LPL'], ['Invictus Gaming', 'LPL'], ['G2 Esports', 'LEC'], ['Movistar KOI', 'LEC'], ['Fnatic', 'LEC'],
    ['Team Liquid', 'LCS'], ['LYON', 'LCS'], ['Team Secret Whales', 'LCP'], ['CTBC Flying Oyster', 'LCP'], ['LØS', 'CBLOL']]
  const teams: Record<string, TeamProfile> = Object.fromEntries(field.map(([name, region]) => [name, { name, code: name.slice(0, 3), league: region, region }]))
  const matches = field.flatMap(([teamA], a) => field.slice(a + 1).map(([teamB], offset): MatchRecord => {
    const date = `2026-0${1 + (a % 8)}-${String(offset + 1).padStart(2, '0')}`
    return { id: `${teamA}-${teamB}`, sourceProvider: 'oracles-elixir', date, datetimeUtc: `${date}T12:00:00.000Z`, season: 2026, event: 'MSI 2026',
      phase: 'Bracket', region: 'International', league: 'MSI', patch: '', bestOf: 1, bestOfBasis: 'provider', tier: 'msi-bracket', teamA, teamB,
      winner: teamA, teamAKills: 15, teamBKills: 9, teamAGold: 60_000, teamBGold: 55_000 }
  }))
  const data = createStaticRankingData({ matches, teams, rosters: {}, generatedAt: '2026-10-01T00:00:00.000Z', dataMode: 'seeded-sample' })
  return new Map(createPublicArtifactWritePlan(data).writes.map((write) => [`/data/${write.relativePath}`, write.contents]))
}

function fixtureFeed() {
  return {
    version: 1, source: 'leaguepedia-cargo', unsupportedApi: false, dataMode: 'synthetic-fixture', fetchedAt: at, sourceUpdatedAt: null,
    coverage: { start: '2026-10-06T00:00:00.000Z', end: '2026-12-05T23:59:59.999Z', complete: true, warnings: [] as string[] },
    events: [
      { id: mainId, sourceTournamentId: mainId, competition: 'worlds', label: 'Worlds 2026 Main Event', season: '2026',
        series: sizes.flatMap((size, index) => Array.from({ length: size }, (_, slot) => swissSeries(index + 1, slot))) },
      { id: playInId, sourceTournamentId: playInId, competition: 'worlds', label: 'Worlds 2026 Play-In', season: '2026',
        series: [{ ...swissSeries(1, 0, [team('Fnatic'), team('Tango')]), id: 'worlds-play-in', eventId: playInId, stage: 'Play-In', startTime: '2026-10-14T10:00:00.000Z' }] },
      { id: 'lcs:2027:promotion', sourceTournamentId: 'LCS/2027 Season/Promotion', competition: 'lcs', label: 'LCS 2027 Promotion', season: '2027',
        series: [{ ...swissSeries(1, 0, [team('Rook'), team('Pawn')]), id: 'lcs-promo', eventId: 'lcs:2027:promotion', stage: 'Finals', bestOf: 5 }] },
    ],
  }
}

for (const forecasts of ['0', '1']) for (const ratingsAvailable of [true, false]) {
test(`Swiss manual preview preserves scenarios with forecasts=${forecasts}, ratings=${ratingsAvailable}`, { timeout: 90_000 }, async () => {
  const feed = fixtureFeed()
  const ratings = rankingArtifacts()
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
        if (ratingsAvailable && ratings.has(path)) return response.end(ratings.get(path))
        response.statusCode = 503
        response.end(JSON.stringify({ error: 'ranking artifacts unavailable' }))
      })
    },
  }
  const server = await createServer({
    configFile: false, logLevel: 'silent',
    define: { 'import.meta.env.VITE_TOURNAMENT_FORECASTS_ENABLED': JSON.stringify(forecasts) },
    resolve: { alias: { '@': new URL('../src', import.meta.url).pathname } },
    server: { host: '127.0.0.1', port: 0 }, plugins: [fixturePlugin, react(), tailwindcss()],
  })
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
    await page.route('**/*', (route) => {
      if (route.request().url().startsWith(base)) return route.continue()
      external.push(route.request().url())
      return route.abort()
    })
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
    await page.getByText('Future Swiss draw probabilities are unavailable.', { exact: true }).waitFor({ timeout: 5_000 })
    await page.getByText('Use picks and draws to explore possible outcomes.', { exact: true }).waitFor()
    assert.equal(await page.getByRole('region', { name: 'Region odds' }).count(), 0)
    assert.doesNotMatch(await body(page), /\d+(\.\d+)?%/, 'the preview shows no team or region advancement percentages')

    await page.locator('#swiss-playin').selectOption('LEC')
    assert.equal(await page.locator('#swiss-playin option:checked').textContent(), 'Fnatic (LEC)')
    assert.doesNotMatch(await body(page), /\d+(\.\d+)?%/, 'selecting the full field does not add advancement percentages')
    const playInPool = page.getByRole('list', { name: 'Round 1 pools' })
    assert.match(await playInPool.getByTitle('Fnatic', { exact: true }).innerText(), /FNC[\s\S]*LEC/)
    await page.reload()
    await page.getByRole('heading', { name: 'Worlds 2026 Swiss preview' }).waitFor()
    assert.equal(await page.locator('#swiss-playin option:checked').textContent(), 'Fnatic (LEC)')
    assert.equal(await playInPool.getByTitle('Fnatic', { exact: true }).count(), 1)
    await page.locator('#swiss-playin').selectOption('LCS')
    assert.equal(await page.getByText('Future Swiss draw probabilities are unavailable.', { exact: true }).count(), 1)
    // The whole bracket is visible before the draw: Round 1 offers the draw, later rounds wait for it.
    assert.equal(await fillButton(page, 1).count(), 1)
    for (const round of [2, 3, 4, 5]) assert.match(await page.getByRole('region', { name: `Round ${round}` }).innerText(), new RegExp(`Drawn after Round ${round - 1}`))
    const pools = page.getByRole('list', { name: 'Round 1 pools' })
    assert.match(await pools.innerText(), /Pool 4\s+meets Pool 1/)
    assert.match(await pools.getByTitle('Gen.G', { exact: true }).innerText(), /GEN[\s\S]*LCK 1/, 'a seed slot shows its confirmed team')
    assert.match(await pools.getByTitle('Play-In winner', { exact: true }).innerText(), /Play-In[\s\S]*LCS/)
    assert.match(await page.getByRole('region', { name: 'Standings' }).innerText(), /Advanced\s+0\s+of 8\s+Out\s+0\s+of 8\s+Playing\s+16/)
    await fillButton(page, 1).click()
    const roundOne = page.getByRole('region', { name: 'Round 1' })
    await roundOne.waitFor()
    assert.equal(await roundOne.evaluate((element) => element === document.activeElement), true, 'focus moves to the drawn round')
    assert.equal(await roundOne.getByRole('group').count(), 8)
    assert.match(await roundOne.innerText(), /8 to pick/)
    assert.equal(await roundOne.getByRole('group', { name: 'Round 1: Team Liquid against Play-In winner' }).count(), 0, 'no same-region pairing')
    assert.equal(await roundOne.getByRole('button', { name: /^GEN LCK 1\W+Gen\.G$/ }).count(), 1, 'a pick is named by its visible code and slot, then the full name')

    const shownDraw = () => roundOne.getByRole('group').evaluateAll((groups) => groups.map((group) => group.getAttribute('aria-label')).sort().join('\n'))
    const firstDraw = await shownDraw()
    const draws = new Set([firstDraw])
    for (let clicks = 0; clicks < 10 && draws.size < 2; clicks++) {
      await roundOne.getByRole('button', { name: 'Draw again' }).click()
      draws.add(await shownDraw())
    }
    assert.equal(draws.size, 2, '"Draw again" gives another valid draw')
    await roundOne.getByRole('button', { name: 'Clear draw' }).click()
    await fillButton(page, 1).click()
    await roundOne.getByRole('button', { name: 'Draw again' }).waitFor()
    const kept = await shownDraw()
    await page.reload()
    await roundOne.getByRole('group').first().waitFor()
    assert.equal(await shownDraw(), kept, 'a reload shows the same draw from the address')
    await roundOne.focus()

    const firstPick = roundOne.getByRole('group').first().getByRole('button').first()
    for (let presses = 0; presses < 6 && !await firstPick.evaluate((element) => element === document.activeElement); presses++) await page.keyboard.press('Tab')
    assert.equal(await firstPick.evaluate((element) => element === document.activeElement), true, 'the first pick is reachable by keyboard')
    await page.keyboard.press('Enter')
    assert.equal(await firstPick.getAttribute('aria-pressed'), 'true')
    // A picked winner moves on to its next record group before the next draw.
    const winnerCode = (await firstPick.innerText()).trim().split(/\s+/)[0]
    assert.match(await page.getByRole('region', { name: 'Round 2' }).innerText(), new RegExp(`1–0[\\s\\S]*${winnerCode}[\\s\\S]*0–1`))
    await pickAll(page, 1, 0)
    await page.getByText('Round 2 is not drawn yet.').waitFor()
    assert.equal(await fillButton(page, 2).count(), 1)
    assert.match(await page.getByRole('region', { name: 'Round 3' }).innerText(), /Drawn after Round 2/)

    // The finished round also offers the next draw, below its last pick: on a phone the next column is out of view.
    await roundOne.getByRole('button', { name: 'Fill a valid draw for Round 2' }).click()
    const roundTwo = page.getByRole('region', { name: 'Round 2' })
    await roundTwo.getByRole('button', { name: 'Clear draw' }).waitFor()
    assert.equal(await isFocused(roundTwo), true, 'focus moves to the round that was drawn')
    const scenarioA = page.getByRole('button', { name: 'A', exact: true })
    await page.getByRole('button', { name: 'B', exact: true }).click()
    await scenarioA.click()
    await roundTwo.getByRole('button', { name: 'Change pairings' }).waitFor()
    assert.equal(await isFocused(scenarioA), true, 'switching scenarios leaves focus on the scenario button')

    await roundTwo.getByRole('button', { name: 'Change pairings' }).click()
    // The draw is random, so the swap uses whichever team leads the first match.
    const swap = roundTwo.getByLabel(/^Opponent for /).first()
    const matchName = await swap.evaluate((select) => select.closest('li')!.querySelector('[role="group"]')!.getAttribute('aria-label')!)
    const leader = matchName.replace(/^Round 2: /, '').split(' against ')[0]
    const before = await swap.inputValue()
    await swap.focus()
    const atLast = await swap.evaluate((select: HTMLSelectElement) => [...select.options].filter((option) => !option.disabled).at(-1)?.value === select.value)
    if (closedSelectKeysChangeValue) await page.keyboard.press(atLast ? 'ArrowUp' : 'ArrowDown')
    else await swap.selectOption(await swap.evaluate((select: HTMLSelectElement) => [...select.options].find((option) => !option.disabled && option.value !== select.value)?.value ?? select.value))
    const choice = await swap.inputValue()
    assert.notEqual(choice, before, 'the opponent select chooses another valid opponent')
    await roundTwo.getByRole('group', { name: `Round 2: ${leader} against ${teamName(choice)}`, exact: true }).waitFor()
    assert.equal(await isFocused(swap), true, 'focus stays on the opponent select after a swap')
    await roundTwo.getByRole('button', { name: 'Clear draw' }).click()
    await fillButton(page, 2).waitFor()
    assert.equal(await isFocused(roundTwo), true, 'focus moves to the cleared round')
    await fillButton(page, 2).click()
    assert.equal(await roundTwo.getByRole('button', { name: 'Change pairings' }).getAttribute('aria-pressed'), 'false', 'a new draw starts with Change pairings off')
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

    // An edited link, then Back, set the scenario and the Play-In region from the address again.
    const edited = hashQuery(shared)
    edited.delete('scenario')
    edited.set('playin', 'LEC')
    await page.evaluate((hash) => { location.hash = hash }, `tournaments?${edited}`)
    await page.getByRole('button', { name: 'A', exact: true, pressed: true }).waitFor()
    assert.equal(await page.locator('#swiss-playin').inputValue(), 'LEC')
    await page.goBack()
    await page.getByRole('button', { name: 'B', exact: true, pressed: true }).waitFor()
    assert.equal(await page.locator('#swiss-playin').inputValue(), 'LCS')
    assert.match(await page.getByRole('region', { name: 'Standings' }).innerText(), /Scenarios A and B differ for 2 teams\./)

    await page.getByRole('region', { name: 'Round 1' }).getByRole('group').first().getByRole('button').last().click()
    await page.getByText('The next round was cleared, because it was drawn from records that changed.').waitFor()
    assert.equal(await fillButton(page, 2).count(), 1, 'Round 2 can be drawn again')
    await page.getByRole('button', { name: 'Reset B' }).click()
    await page.getByText('Scenario B is back at the starting point.').waitFor()
    assert.equal(await fillButton(page, 1).count(), 1)

    // Undo brings back the scenario before the reset; undo stays focusable when nothing is left to undo.
    const undo = page.getByRole('button', { name: 'Undo' })
    await undo.click()
    await page.getByText('The last change to scenario B was undone.').waitFor()
    assert.deepEqual([await fillButton(page, 1).count(), await fillButton(page, 2).count()], [0, 1])
    await page.getByRole('button', { name: 'Reset B' }).click()
    await page.getByText('Scenario B is back at the starting point.').waitFor()
    await page.reload()
    await page.getByRole('heading', { name: 'Worlds 2026 Swiss preview' }).waitFor()
    assert.equal(await undo.getAttribute('aria-disabled'), 'true', 'a reload starts without undo steps')
    await undo.focus()
    await page.keyboard.press('Enter')
    assert.equal(await isFocused(undo), true)
    assert.equal(await page.getByText(/was undone/).count(), 0, 'nothing is undone')
    assert.equal(hashQuery(page.url()).has('b'), false, 'a reset scenario leaves the address')
    assert.equal(await fillButton(page, 1).count(), 1, 'the reset scenario stays reset after a reload')

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
    assert.match(await page.getByRole('region', { name: 'Standings' }).innerText(), /Gen\.G[\s\S]*LCK 1/)
    await page.locator('#swiss-start').selectOption('live')
    await page.getByText('Both scenarios were reset for the new starting point.').waitFor()
    const liveRound = page.getByRole('region', { name: 'Round 1' })
    assert.match(await liveRound.innerText(), /Live draw/)
    assert.equal(await liveRound.getByRole('group', { name: 'Round 1: Alpha against Bravo' }).getByRole('button').count(), 0, 'live results cannot be changed')
    const played = liveRound.getByRole('group', { name: 'Round 1: Alpha against Bravo' })
    assert.deepEqual([await played.getByTitle('Alpha', { exact: true }).textContent(), await played.getByTitle('Bravo', { exact: true }).textContent()], ['ALPH, Alpha, won', 'BRAV, Bravo, lost'])
    assert.match(await liveRound.innerText(), /1 to pick/)
    await liveRound.getByRole('button', { name: /^PAPA\W+Papa$/ }).click()
    await fillButton(page, 2).waitFor()

    main.series.find((series) => series.id.endsWith('Round 1_8'))!.teams = [team('Oscar', 1, 'win'), team('Papa', 0, 'loss')]
    main.series.find((series) => series.id.endsWith('Round 1_8'))!.status = 'completed'
    feed.fetchedAt = '2026-10-23T21:00:00.000Z'
    await page.getByRole('button', { name: 'Refresh' }).click()
    await page.getByText('Live results replaced one of your picks.').waitFor()
    assert.equal(await liveRound.getByRole('group', { name: 'Round 1: Oscar against Papa' }).getByTitle('Oscar', { exact: true }).textContent(), 'OSCA, Oscar, won')
    assert.doesNotMatch(await liveRound.innerText(), /to pick/, 'Round 1 is fully played')

    // A later feed breaks the live draw. The live scenario stays in the address, unread, until the user chooses qualified teams.
    await fillButton(page, 2).click()
    await page.getByRole('region', { name: 'Round 2' }).getByRole('group').first().getByRole('button').first().click()
    const keptLive = page.url()
    assert.equal(hashQuery(keptLive).has('b'), true)
    main.series.filter((series) => series.stage === 'Round 2').forEach((series, slot) => { series.teams = [team(names[slot]), team(names[15 - slot])] })
    feed.fetchedAt = '2026-10-23T22:00:00.000Z'
    await page.getByRole('button', { name: 'Refresh' }).click()
    await page.getByText(/Your live picks stay in the page address/).waitFor()
    assert.match(await body(page), /Live draws are not available: Round 2 in the schedule does not follow the Swiss draw rules: Alpha and Papa: different record\./)
    assert.equal(await page.locator('#swiss-start').inputValue(), 'live')
    assert.equal(await page.locator('#swiss-start option[value="live"]').isDisabled(), true)
    assert.equal(await page.getByRole('region', { name: /^(Round \d|Standings)$/ }).count(), 0, 'no seed rounds or standings')
    assert.equal(await page.getByRole('button', { name: /^(Copy|Reset|Fill)/ }).count(), 0, 'no actions that change the kept scenarios')
    assert.equal(page.url(), keptLive, 'the kept live scenarios stay unchanged in the address')
    await page.locator('#swiss-start').selectOption('seeds')
    await page.getByText('Both scenarios were reset for the new starting point.').waitFor()
    assert.equal(await fillButton(page, 1).count(), 1)
    assert.equal(hashQuery(page.url()).has('b'), false)

    // A Play-In region change can hide a draw that no longer fits. Reset and Copy must still discard it.
    for (const action of ['Reset A', 'Copy B into A']) {
      await page.getByRole('button', { name: 'A', exact: true }).click()
      await page.locator('#swiss-playin').selectOption('LCS')
      await fillButton(page, 1).click()
      // With LCS chosen, G2 Esports (LEC 1) is the only Pool 1 opponent that a change to LEC makes illegal, so draw until it meets the Play-In winner.
      const playInMatch = page.getByRole('group', { name: /Play-In winner/ })
      for (let clicks = 0; clicks < 40 && !(await playInMatch.getAttribute('aria-label'))!.includes('G2 Esports'); clicks++) {
        await page.getByRole('region', { name: 'Round 1' }).getByRole('button', { name: 'Draw again' }).click()
      }
      assert.match((await playInMatch.getAttribute('aria-label'))!, /G2 Esports/)
      await page.locator('#swiss-playin').selectOption('LEC')
      await fillButton(page, 1).waitFor()
      await page.getByRole('button', { name: action }).click()
      await page.locator('#swiss-playin').selectOption('LCS')
      assert.equal(await fillButton(page, 1).count(), 1, `${action} discards a hidden draw`)
    }

    // The Play-In is also a Worlds 2026 event, but the Swiss rounds belong to the Main Event.
    await page.locator('#tournament-event').selectOption(playInId)
    await page.getByRole('heading', { name: 'Worlds 2026 Play-In' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Swiss preview' }).count(), 0, 'the Play-In has no Swiss preview, even with view=swiss')
    await page.locator('#tournament-event').selectOption(mainId)
    await page.getByRole('heading', { name: 'Worlds 2026 Swiss preview' }).waitFor()

    await page.getByRole('button', { name: 'Schedule' }).click()
    await page.getByRole('heading', { name: 'Worlds 2026 Main Event' }).waitFor()
    assert.doesNotMatch(page.url(), /view=swiss/)
    assert.match(await page.locator('section[aria-label="results"]').innerText(), /Alpha 1–0 Bravo/)
    assert.match(await page.locator('section[aria-label="results"]').innerText(), /Oscar 1–0 Papa/)

    await page.locator('#tournament-event').selectOption('lcs:2027:promotion')
    await page.getByRole('heading', { name: 'LCS 2027 Promotion' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Swiss preview' }).count(), 0, 'the preview belongs to the Worlds 2026 Main Event only')

    // Scenario A plays every match, so the standings table holds its longest rows.
    const finished = hashQuery(shared)
    finished.delete('scenario')
    finished.set('a', playedOut(seedBaseline('LCS')))
    await page.goto(`${base}/#tournaments?${finished}`)
    await page.getByText('Swiss stage complete. The eight Advanced teams go to the quarterfinals.').waitFor()
    assert.match(await page.getByRole('region', { name: 'Standings' }).innerText(), /Scenarios A and B differ for 16 teams\./)

    // The page fits from phone to desktop widths. Only the bracket scrolls sideways, inside its own region.
    await page.getByRole('region', { name: 'Round 2' }).getByRole('button', { name: 'Change pairings' }).click()
    const table = page.getByRole('region', { name: 'Standings' }).getByRole('table')
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 })
      const layout = await page.evaluate(() => {
        const bracket = document.querySelector('[role="region"][aria-label="Swiss bracket"]')!
        return {
          viewport: innerWidth, content: document.documentElement.scrollWidth, bracketScrolls: bracket.scrollWidth > bracket.clientWidth,
          clipped: [...document.querySelectorAll('main button')].filter((button) => !bracket.contains(button) && button.getBoundingClientRect().right > innerWidth).length,
        }
      })
      assert.ok(layout.content <= layout.viewport && layout.clipped === 0, `Horizontal overflow at ${width}px: ${JSON.stringify(layout)}`)
      assert.equal(layout.bracketScrolls, width <= 1024, `The six bracket columns fit at 1440 px and wider and scroll at 1024 px and narrower: ${width}px`)
      const tableOverflow = await table.evaluate((element) => element.parentElement!.scrollWidth - element.parentElement!.clientWidth)
      assert.ok(tableOverflow <= 1, `The standings table fits its panel at ${width}px: ${tableOverflow}px too wide`)
    }

    if (forecasts === '0') assert.deepEqual(requests.filter((entry) => entry.startsWith('GET /data/')), [], 'the manual preview does not load ratings when forecasts are disabled')
    assert.equal(await page.getByRole('region', { name: 'Region odds' }).count(), 0)
    assert.doesNotMatch(await body(page), /\d+(\.\d+)?%/, 'completed scenarios do not add advancement percentages')
    assert.deepEqual(errors, [])
    assert.deepEqual(external, [])
    assert.ok(requests.every((entry) => entry.startsWith('GET ')), `Only reads are sent: ${requests.filter((entry) => !entry.startsWith('GET '))}`)
  } finally {
    await browser?.close()
    await server.close()
  }
})

}

function teamName(seed: string) {
  return seedBaseline(null).teams.find((team) => team.id === seed)!.label
}
function fillButton(page: Page, round: number) {
  return page.getByRole('region', { name: `Round ${round}` }).getByRole('button', { name: 'Fill a valid draw', exact: true })
}
/** The address text of a scenario that fills every draw and picks the first team of every match. */
function playedOut(baseline: SwissBaseline) {
  const random = worldsRandom(1)
  const choices: DrawnRound[] = []
  for (let scenario = resolveScenario(baseline, choices); scenario.next.kind === 'draw'; scenario = resolveScenario(baseline, choices)) {
    const pairs = fillDraw(scenario.next.context, random)!
    choices.push({ pairs, winners: pairs.map(([first]) => first) })
  }
  return encodeChoices(baseline, choices)
}
async function body(page: Page) {
  return page.locator('body').innerText()
}
async function isFocused(locator: Locator) {
  return locator.evaluate((element) => element === document.activeElement)
}
function hashQuery(url: string) {
  return new URLSearchParams(new URL(url).hash.split('?')[1] ?? '')
}

/** Picks the first (0) or second (1) team in every open match of a round. */
async function pickAll(page: Page, round: number, side: 0 | 1) {
  const groups = page.getByRole('region', { name: `Round ${round}` }).getByRole('group')
  for (let index = 0; index < await groups.count(); index++) {
    const button = groups.nth(index).getByRole('button').nth(side)
    if (await button.getAttribute('aria-pressed') !== 'true') await button.click()
  }
}
