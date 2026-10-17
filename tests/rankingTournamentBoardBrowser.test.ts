import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium, type Page } from 'playwright-core'
import { createServer, type Plugin } from 'vite'
import { createStaticRankingData } from '../src/lib/snapshot.ts'
import { createPublicArtifactWritePlan } from '../src/lib/publicArtifacts/writePlan.ts'
import { createGenerationManifest, prepareSemanticArtifact } from '../scripts/public-artifact-storage.mjs'
import { tournamentMovementShardUrlPathForId } from '../src/lib/publicArtifacts/schema.ts'
import type { MatchRecord, TeamProfile } from '../src/types.ts'

// Four LCK teams with a full season, and Rookie, which plays only MSI 2026 and so stays unranked.
const strength: Record<string, number> = { Alpha: 4, Beta: 3, Gamma: 2, Delta: 1, Rookie: 0 }
const teams: Record<string, TeamProfile> = Object.fromEntries(Object.keys(strength).map((name) => [name, { name, code: name.slice(0, 3).toUpperCase(), region: 'LCK', league: 'LCK' }]))

const EVENTS = {
  lck: { event: 'LCK 2026 Rounds 1-2', phase: 'Regular season', region: 'LCK', league: 'LCK', tier: 'regional-regular' },
  fst: { event: 'First Stand 2026', phase: 'Bracket', region: 'International', league: 'FST', tier: 'msi-bracket' },
  msi: { event: 'MSI 2026', phase: 'Bracket', region: 'International', league: 'MSI', tier: 'msi-bracket' },
} as const

function game(id: string, date: string, teamA: string, teamB: string, event: keyof typeof EVENTS, upset = false): MatchRecord {
  const favourite = strength[teamA]! >= strength[teamB]! ? teamA : teamB
  const winner = upset ? (favourite === teamA ? teamB : teamA) : favourite
  return {
    id, sourceProvider: 'seed', dataCompleteness: 'complete', date, datetimeUtc: `${date}T12:00:00.000Z`, season: 2026,
    ...EVENTS[event],
    teamAHomeLeague: 'LCK', teamBHomeLeague: 'LCK', teamARegion: 'LCK', teamBRegion: 'LCK', patch: '26.1', bestOf: 1,
    teamA, teamB, winner,
    teamAKills: winner === teamA ? 20 : 12, teamBKills: winner === teamB ? 20 : 12,
    teamAGold: winner === teamA ? 70_000 : 58_000, teamBGold: winner === teamB ? 70_000 : 58_000,
  }
}

const pairs = [['Alpha', 'Beta'], ['Gamma', 'Delta'], ['Alpha', 'Gamma'], ['Beta', 'Delta'], ['Alpha', 'Delta'], ['Beta', 'Gamma']] as const

function fixtureMatches() {
  const season = Array.from({ length: 60 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 2, 1) + Math.floor(index / 2) * 3 * 86_400_000).toISOString().slice(0, 10)
    const [teamA, teamB] = pairs[index % pairs.length]!
    return game(`lck-${index}`, date, teamA, teamB, 'lck', index % 7 === 0)
  })
  return [
    ...season,
    game('msi-1', '2026-06-28', 'Alpha', 'Rookie', 'msi'),
    game('msi-2', '2026-06-29', 'Beta', 'Rookie', 'msi', true),
    game('msi-3', '2026-06-30', 'Gamma', 'Rookie', 'msi'),
    game('msi-4', '2026-07-01', 'Alpha', 'Beta', 'msi'),
    game('msi-5', '2026-07-02', 'Beta', 'Gamma', 'msi'),
  ]
}

async function withBoard(matches: MatchRecord[], run: (page: Page, base: string, objectPathFor: (logicalPath: string) => string) => Promise<void>) {
  const data = createStaticRankingData({ matches, teams, rosters: {}, generatedAt: '2026-07-03T00:00:00.000Z', dataMode: 'seeded-sample' })
  const plan = createPublicArtifactWritePlan(data)
  const entries: Array<{ logicalPath: string; digest: string; bytes: number }> = []
  const objects = new Map<string, string>()
  for (const write of plan.writes) {
    const prepared = prepareSemanticArtifact(write.value)
    entries.push({ logicalPath: `/data/${write.relativePath}`, digest: prepared.digest, bytes: prepared.bytes })
    for (const object of [...(prepared.children ?? []), prepared]) objects.set(`/data/objects/sha256/${object.digest}`, object.canonicalJson)
  }
  const meta = plan.manifest.artifactMeta
  assert.ok(meta)
  const manifest = createGenerationManifest({ generationId: meta.runId, rootManifest: { ...plan.manifest }, entries })
  const fixture: Plugin = { name: 'ranking-tournament-board-fixture', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
      // Tournament feed files are absent, so local public data cannot change the board.
      if (!path.startsWith('/data/') && !path.startsWith('/tournament-data/')) return next()
      const body = path === '/data/ranking-summary.json' ? JSON.stringify(manifest) : objects.get(path)
      response.setHeader('content-type', 'application/json')
      response.statusCode = body ? 200 : 404
      response.end(body ?? '{}')
    })
  } }
  const objectPathFor = (logicalPath: string) => {
    const entry = entries.find((candidate) => candidate.logicalPath === logicalPath)
    assert.ok(entry, `generated ${logicalPath}`)
    return `/data/objects/sha256/${entry.digest}`
  }
  const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, plugins: [fixture] })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer!.address()
    assert.ok(address && typeof address !== 'string')
    const executablePath = chromium.executablePath()
    browser = await chromium.launch(existsSync(executablePath) ? { headless: true } : { headless: true, channel: 'chrome' })
    await run(await browser.newPage({ viewport: { width: 390, height: 844 } }), `http://127.0.0.1:${address.port}`, objectPathFor)
  } finally { await browser?.close(); await server.close() }
}

test('a tournament board lists every participant without changing the unranked setting', { timeout: 60_000 }, async () => {
  await withBoard(fixtureMatches(), async (page, base) => {
    const hashParams = () => page.evaluate(() => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] ?? '')))
    const rows = page.locator('table tbody tr')
    const tournamentSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Any tournament' }) })
    const filtersButton = page.getByRole('button', { name: /^Filters/ })
    const unrankedSetting = page.getByRole('checkbox', { name: /Include unranked/ })
    const unrankedNote = page.getByText(/^Includes \d+ unranked$/)
    const tierChip = (name: string) => page.getByRole('group', { name: 'Tier' }).getByRole('button', { name })

    await page.goto(`${base}/#rankings`)
    await page.getByRole('heading', { name: 'Team Power Index', exact: true }).waitFor()
    await filtersButton.click()
    await unrankedSetting.waitFor()
    assert.equal(await unrankedSetting.isChecked(), false)
    assert.equal(await rows.count(), 4)

    await tournamentSelect.locator('option[value="tournament:msi:2026"]').waitFor({ state: 'attached' })
    await tournamentSelect.selectOption('tournament:msi:2026')
    await page.getByRole('heading', { name: 'MSI 2026 standings' }).waitFor()
    assert.equal((await hashParams()).eligibility, undefined)
    await page.locator('table').getByText('Rookie', { exact: true }).waitFor()
    assert.equal(await rows.count(), 4)
    assert.equal(await unrankedNote.textContent(), 'Includes 1 unranked')
    assert.equal(await unrankedSetting.count(), 0)
    assert.equal(await filtersButton.textContent(), 'Filters (1)')

    // A tier filter removes the unranked participant, so the note goes with it.
    await tierChip('S · 1').click()
    await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 1)
    assert.equal(await unrankedNote.count(), 0)
    assert.equal(await filtersButton.textContent(), 'Filters (2)')

    await tierChip('All tiers').click()
    await tournamentSelect.selectOption('All')
    await page.getByRole('heading', { name: 'Power ranking' }).waitFor()
    assert.equal(await unrankedSetting.isChecked(), false)
    assert.equal(await rows.count(), 4)
    assert.equal((await hashParams()).eligibility, undefined)

    // The user's own unranked setting survives a tournament and does not count as a filter there.
    await unrankedSetting.check()
    await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 5)
    await tournamentSelect.selectOption('tournament:msi:2026')
    await page.getByRole('heading', { name: 'MSI 2026 standings' }).waitFor()
    assert.equal(await filtersButton.textContent(), 'Filters (1)')
    assert.equal((await hashParams()).eligibility, 'all')
    await tournamentSelect.selectOption('All')
    await page.getByRole('heading', { name: 'Power ranking' }).waitFor()
    assert.equal(await unrankedSetting.isChecked(), true)
    assert.equal(await rows.count(), 5)
  })
})

test('a comparison shows the board values when the address names a tournament outside the scope', { timeout: 60_000 }, async () => {
  const january = Array.from({ length: 30 }, (_, index) => {
    const [teamA, teamB] = pairs[index % pairs.length]!
    return game(`lck-january-${index}`, new Date(Date.UTC(2026, 0, 5) + index * 86_400_000).toISOString().slice(0, 10), teamA, teamB, 'lck')
  })
  const matches = [
    ...january,
    ...fixtureMatches(),
    game('fst-1', '2026-03-20', 'Alpha', 'Gamma', 'fst'),
    game('fst-2', '2026-03-21', 'Beta', 'Delta', 'fst'),
    game('fst-3', '2026-03-22', 'Alpha', 'Beta', 'fst'),
  ]
  await withBoard(matches, async (page, base, objectPathFor) => {
    const shardPath = objectPathFor(tournamentMovementShardUrlPathForId('msi:2026'))
    const shardLoaded = page.waitForResponse((response) => new URL(response.url()).pathname === shardPath && response.ok())
    await page.goto(`${base}/#rankings?scope=season:2026:checkpoint:split-1&tournament=tournament:msi:2026`)
    await page.getByRole('heading', { name: 'Power ranking' }).waitFor()
    await shardLoaded
    await page.waitForLoadState('networkidle')

    const row = page.locator('table tbody tr').filter({ has: page.getByRole('cell', { name: /^Rank \d+$/ }) }).first()
    const team = (await row.getByTitle(/^Open /).getAttribute('title'))!.replace('Open ', '')
    const rank = (await row.getByRole('cell', { name: /^Rank \d+$/ }).getAttribute('aria-label'))!.replace('Rank ', '')
    const power = (await row.getByRole('cell', { name: /^Power / }).getAttribute('aria-label'))!.replace('Power ', '')
    await row.getByRole('checkbox', { name: `Compare ${team}` }).check()

    const dock = page.getByRole('region', { name: 'Compare teams: 1 selected' })
    assert.equal(await dock.locator('span[title]').first().getAttribute('title'), `${team.slice(0, 3).toUpperCase()} · ${power} · #${rank}`)
    assert.equal(await page.getByRole('heading', { name: 'MSI 2026 standings' }).count(), 0)
  })
})
