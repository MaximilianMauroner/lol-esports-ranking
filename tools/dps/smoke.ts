import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { once } from 'node:events'
import { chromium, type Page } from 'playwright-core'
import { ensureReferencePublicData, referencePublicDataDir } from '../../scripts/reference-public-data.mjs'

await ensureReferencePublicData()
const portServer = createServer()
portServer.listen(0, '127.0.0.1')
await once(portServer, 'listening')
const address = portServer.address()
assert.ok(address && typeof address !== 'string')
const port = address.port
await new Promise<void>((done) => portServer.close(() => done()))
const base = `http://127.0.0.1:${port}`
const password = randomUUID()
const scratch = await mkdtemp(join(tmpdir(), 'rift-delta-smoke-'))
await mkdir(join(scratch, 'tournament-data'))
await writeFile(join(scratch, 'tournament-data/feed.json'), JSON.stringify({ version: 1, source: 'leaguepedia-cargo', dataMode: 'synthetic-fixture', events: [], coverage: { complete: true, warnings: [] } }))
const child = spawn(process.execPath, ['scripts/railway-server.mjs'], {
  env: {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test',
    PORT: String(port), HOST: '127.0.0.1', RAILWAY_DIST_DIR: resolve('dist'),
    RANKING_PUBLIC_DATA_DIR: referencePublicDataDir,
    TOURNAMENT_PUBLIC_DATA_DIR: join(scratch, 'tournament-data'),
    PROTOTYPE_ACCESS_PASSWORD: password, PROTOTYPE_SESSION_SECRET: randomUUID(),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
child.stdout.on('data', (data) => { output += String(data) })
child.stderr.on('data', (data) => { output += String(data) })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let debugPage: Page | undefined
const pageErrors: string[] = []
const failures: string[] = []
const expectedImageFailures: string[] = []
const cancelledRankingPreloads: string[] = []
let completedRankingManifests = 0
try {
  const deadline = Date.now() + 20_000
  while (true) {
    if ((await fetch(`${base}/api/live`).catch(() => null))?.ok) break
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Server did not start. ${output}`)
    await new Promise((done) => setTimeout(done, 50))
  }
  for (const [path, method] of [['cohort', 'POST'], ['progression', 'GET'], ['simulate', 'POST']]) {
    assert.equal((await fetch(`${base}/api/dps/${path}`, { method })).status, 401)
  }
  const unauthenticated = await fetch(`${base}/lab`, { redirect: 'manual' })
  assert.equal(unauthenticated.status, 302)
  assert.match(unauthenticated.headers.get('location') ?? '', /\/lab\/login/)
  assert.match(await (await fetch(`${base}/licenses/inter-OFL.txt`)).text(), /Copyright 2016 The Inter Project Authors[\s\S]*SIL OPEN FONT LICENSE Version 1.1/)
  const login = await fetch(`${base}/api/dps/auth/login`, { method: 'POST', body: JSON.stringify({ password }) })
  assert.equal(login.status, 200)
  const setCookie = login.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Lax/)
  const cookie = setCookie.split(';')[0]
  const call = (path: string, body?: unknown) => fetch(`${base}/api/dps/${path}`, { method: body ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const cohort = await call('cohort', { phase: 'yunara-level', level: 13 })
  assert.equal(cohort.status, 200)
  const cohortData = await cohort.json() as { dataset: { provenance: string; targets: unknown[] } }
  assert.equal(cohortData.dataset.provenance, 'fixture')
  assert.ok(cohortData.dataset.targets.length > 0)
  const progression = await call('progression?champion=Yunara&level=13')
  assert.equal(progression.status, 200)
  assert.equal((await progression.json() as { provenance: string }).provenance, 'fixture')
  const simulation = await call('simulate', {})
  assert.equal(simulation.status, 200)
  const simulated = await simulation.json() as { patch: string; dataVersion: string; results: { a: { totalDamage: number; events: unknown[] } } }
  assert.equal(simulated.patch, '26.18')
  assert.equal(simulated.dataVersion, '16.18.1')
  assert.ok(simulated.results.a.totalDamage > 0)
  assert.ok(simulated.results.a.events.length > 0)
  assert.equal((await call('simulate', { actions: ['UNKNOWN'] })).status, 400)
  assert.equal((await call('progression?level=19')).status, 400)
  assert.equal((await fetch(`${base}/api/dps/cohort`, { method: 'POST', headers: { cookie }, body: 'x'.repeat(40_000) })).status, 413)
  assert.equal((await fetch(`${base}/api/dps/auth/login`, { method: 'POST', headers: { origin: 'https://other.invalid' }, body: JSON.stringify({ password }) })).status, 403)

  const executablePath = chromium.executablePath()
  browser = await chromium.launch(existsSync(executablePath) ? { headless: true } : { headless: true, channel: 'chrome' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  debugPage = page
  page.on('response', (response) => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`) })
  page.on('requestfailed', (request) => {
    const failure = `${request.failure()?.errorText} ${request.url()}`
    if (request.url() === `${base}/data/ranking-summary.json`
      && request.failure()?.errorText === 'net::ERR_ABORTED'
      && request.resourceType() === 'other') cancelledRankingPreloads.push(failure)
    else failures.push(failure)
  })
  page.on('requestfinished', (request) => {
    if (request.url() === `${base}/data/ranking-summary.json`) completedRankingManifests++
  })
  const workers: string[] = []
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const url = message.location().url
    if (url.startsWith('https://ddragon.leagueoflegends.com/cdn/16.18.1/img/item/')) expectedImageFailures.push(message.text())
    else pageErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('worker', (worker) => workers.push(worker.url()))
  await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort())
  await page.goto(`${base}/lab`)
  await page.getByRole('heading', { name: 'rift-delta DPS lab' }).waitFor()
  await page.getByLabel('ACCESS PASSWORD', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'ENTER PROTOTYPE' }).click()
  await page.waitForURL(`${base}/lab`)
  await page.getByRole('button', { name: 'Run again', exact: true }).waitFor()
  assert.match(await page.locator('body').innerText(), /Fixture/)
  assert.equal(await page.locator('.dps-surface .error').count(), 0)
  await page.locator('summary').filter({ hasText: 'Damage trace' }).click()
  await page.locator('table.trace').first().waitFor()
  assert.ok(await page.locator('table.trace tbody tr').count() > 0)
  const targetId = await page.locator('#target-sel option').nth(1).getAttribute('value')
  assert.ok(targetId)
  await page.getByLabel('Selected target', { exact: true }).selectOption(targetId)
  await page.getByRole('button', { name: 'Run again', exact: true }).waitFor()
  await page.getByLabel('Completed slots', { exact: true }).selectOption('3')
  await page.getByRole('button', { name: 'Search all builds' }).click()
  await page.getByText(/legal modeled builds searched/).waitFor({ timeout: 60_000 })
  assert.ok(await page.locator('.optimizer-row').count() > 0)
  assert.ok(workers.some((url) => /simulation\.worker/.test(url)))
  assert.ok(workers.some((url) => /optimizer\.worker/.test(url)))
  await page.getByLabel('Build B item 1', { exact: true }).selectOption('3031')
  await page.getByRole('heading', { name: 'Both builds are identical', exact: true }).waitFor()
  await page.screenshot({ path: '.agents/artifacts/rift-delta/lab.png', fullPage: true })
  await page.getByRole('navigation', { name: 'rift-delta', exact: true }).getByRole('link', { name: 'Rankings', exact: true }).click()
  await page.getByRole('heading', { name: 'Team Power Index', exact: true }).waitFor()
  await page.locator('table tbody tr').first().waitFor()
  const search = page.getByPlaceholder('Find a team')
  await search.fill('T1')
  await page.waitForURL(/T1/)
  await page.screenshot({ path: '.agents/artifacts/rift-delta/rankings.png', fullPage: true })
  await page.getByRole('navigation', { name: 'rift-delta', exact: true }).getByRole('link', { name: 'DPS lab', exact: true }).click()
  await page.getByRole('button', { name: 'Run again', exact: true }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  const mobileLayout = await page.evaluate('({ viewport: innerWidth, document: document.documentElement.scrollWidth })') as { viewport: number; document: number }
  assert.ok(mobileLayout.document <= mobileLayout.viewport + 1, JSON.stringify(mobileLayout))
  await page.screenshot({ path: '.agents/artifacts/rift-delta/lab-mobile.png', fullPage: true })
  assert.equal(await page.getByRole('navigation', { name: 'rift-delta', exact: true }).getByRole('link', { name: 'Rankings', exact: true }).isVisible(), true)
  assert.ok(completedRankingManifests > 0)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(failures.filter((failure) => !failure.includes('https://ddragon.leagueoflegends.com/cdn/16.18.1/img/item/')), [])
  const logout = await fetch(`${base}/api/dps/auth/logout`, { method: 'POST', headers: { cookie } })
  assert.equal(logout.status, 200)
  assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/)
  await writeFile('.agents/artifacts/rift-delta/smoke.json', JSON.stringify({ mode: 'fixture', rankingSource: 'frozen reference corpus', patch: '26.18', dataVersion: '16.18.1', workers, pageErrors, expectedImageFailures, cancelledRankingPreloads, completedRankingManifests, mobileLayout, checks: ['private APIs', 'login', 'cohort', 'progression', 'simulate', 'request limits', 'cross-origin rejection', 'selected trace', 'optimizer', 'worker assets', 'shared navigation', 'ranking search', 'mobile navigation', 'logout'] }, null, 2))
  console.log('rift-delta production browser and API smoke passed with fixture DPS and reference rankings')
} catch (error) {
  if (debugPage) {
    await debugPage.screenshot({ path: '.agents/artifacts/rift-delta/smoke-failure.png', fullPage: true })
    await writeFile('.agents/artifacts/rift-delta/smoke-failure.json', JSON.stringify({ url: debugPage.url(), text: await debugPage.locator('body').innerText(), pageErrors, failures, cancelledRankingPreloads, completedRankingManifests }, null, 2))
  }
  throw error
} finally {
  await browser?.close()
  if (child.exitCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
  await rm(scratch, { recursive: true, force: true })
}
