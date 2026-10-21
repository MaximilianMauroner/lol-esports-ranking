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

function series(id: string, date: string, event: string, tier: MatchRecord['tier'], league: string, region: string, teamA: string, teamB: string): MatchRecord {
  return { id, sourceProvider: 'oracles-elixir', date, datetimeUtc: `${date}T12:00:00.000Z`, season: Number(date.slice(0, 4)), event,
    phase: 'Regular season', region, league, patch: '', bestOf: 1, bestOfBasis: 'provider', tier, teamA, teamB, winner: teamA,
    teamAKills: 15, teamBKills: 9, teamAGold: 60_000, teamBGold: 55_000 }
}

function roundRobin(region: typeof regions[number], season: number): MatchRecord[] {
  const names = Object.values(teams).filter((team) => team.region === region).map((team) => team.name)
  return names.flatMap((teamA, a) => names.slice(a + 1).map((teamB, offset) =>
    series(`${region}-${season}-${teamA}-${teamB}`, `${season}-0${1 + (a % 4)}-${String(offset + 1).padStart(2, '0')}`, `${region} ${season}`, 'regional-regular', region, region, teamA, teamB)))
}

// One MSI series per season gives the Regions timeline two seasons of tier-1 results.
const matches = [
  ...[2025, 2026].flatMap((season) => regions.flatMap((region) => roundRobin(region, season))),
  ...[2025, 2026].map((season) => series(`MSI-${season}`, `${season}-06-20`, `MSI ${season}`, 'msi-bracket', 'MSI', 'International', 'LEC Team 1', 'LCS Team 1')),
]

test('the Regions timeline loads again after a visit to Matches', { timeout: 60_000 }, async () => {
  const data = createStaticRankingData({ matches, teams, rosters: {}, generatedAt: '2026-07-01T00:00:00.000Z', dataMode: 'seeded-sample' })
  const bodies = new Map(createPublicArtifactWritePlan(data).writes.map((write) => [`/data/${write.relativePath}`, write.contents]))
  const fixture: Plugin = { name: 'region-timeline-fixture', configureServer(server) {
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
    const winRate = page.getByRole('application', { name: /^Series win rate against other regions over seasons for / })
    const played = page.getByRole('application', { name: /^Series played against other regions over seasons for / })
    await played.waitFor({ timeout: 20_000 })
    assert.equal(await winRate.count(), 1)

    // Matches does not use the tournament index, so returning to Regions loads it again.
    const primary = page.getByRole('navigation', { name: 'Primary', exact: true })
    await primary.getByRole('link', { name: 'Matches', exact: true }).click()
    await played.waitFor({ state: 'detached' })
    await primary.getByRole('link', { name: 'Regions', exact: true }).click()
    await played.waitFor({ timeout: 10_000 })
    assert.equal(await winRate.count(), 1)
    assert.equal(await page.getByText('Loading international results').count(), 0)
  } finally {
    await browser?.close()
    await server.close()
  }
})
