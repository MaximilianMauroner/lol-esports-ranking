import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { chromium, type Page } from 'playwright-core'
import { buildStyleProfiles } from '../src/domains/style/build.ts'
import { styleGame } from './styleProfileFixtures.ts'

async function waitValue(page: Page, label: string, expected: string) {
  await page.getByLabel(label, { exact: true }).evaluate((element, value) => {
    if ((element as HTMLSelectElement).value !== value) throw new Error(`Expected ${value}`)
  }, expected)
}

test('Profiles restores URL state, compares peers, excludes missing axes, filters leagues and retries, without a server', { timeout: 120_000 }, async () => {
  console.log('Build the app bundle for the isolated Profiles journey')
  const build = spawnSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build'], { encoding: 'utf8', timeout: 100_000 })
  assert.equal(build.status, 0, `${build.error?.message ?? ''} ${build.stdout} ${build.stderr}`)
  const root = resolve('dist')
  const games = Array.from({ length: 20 }, (_, i) => styleGame(String(i)))
  delete games[0].teamARoster!.players[4].stats!.goldDiffAt15
  const old = styleGame('old', 2025)
  const artifact = buildStyleProfiles([...games, old], 'a'.repeat(64))
  const requests: string[] = []
  const errors: string[] = []
  let artifactStatus = 503
  const executablePath = chromium.executablePath()
  assert.ok(existsSync(executablePath), 'Use an already installed Chromium')
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
    page.on('pageerror', error => { errors.push(error.message); console.log('Browser page error', error.message) })
    page.setDefaultTimeout(8_000)
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      const path = url.pathname
      if (path.startsWith('/data/')) requests.push(path)
      if (path === '/data/style-profiles.json') {
        await route.fulfill({ status: artifactStatus, contentType: 'application/json', body: JSON.stringify(artifact) })
        return
      }
      if (url.hostname !== 'profiles.test' || path.startsWith('/data/') || path.startsWith('/tournament-data/')) {
        await route.fulfill({ status: 404, body: 'Unavailable in the isolated fixture' })
        return
      }
      const file = path === '/' ? resolve(root, 'index.html') : resolve(root, `.${path}`)
      if (!file.startsWith(`${root}${sep}`) || !existsSync(file)) {
        await route.fulfill({ status: 404, body: '' })
        return
      }
      const contentType = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream'
      await route.fulfill({ status: 200, contentType, body: await readFile(file) })
    })
    await page.goto('http://profiles.test/#profiles?scope=season:2026:checkpoint:split-2&view=player&role=Support&pa=a-4%7CSupport&pb=b-4%7CSupport&paxis=goldDiffAt15&future=keep')
    await page.getByRole('heading', { name: 'Style profiles could not be loaded' }).waitFor()
    artifactStatus = 200
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await page.getByRole('heading', { name: 'a-4', exact: true }).waitFor()
    await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('scope') === 'season:2026')
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('future'), 'keep')
    assert.equal(await page.locator('.style-shape.style-series-a').getAttribute('data-closed'), 'false')
    assert.equal(await page.locator('.style-shape.style-series-a path').getAttribute('fill'), 'none')
    assert.equal(await page.locator('.style-shape.style-series-a circle').count(), 7)
    assert.equal(await page.locator('#style-inspector .style-value-card').count(), 2)
    const survival = page.getByRole('button', { name: /^Survival\. / })
    await survival.focus()
    await survival.press('Enter')
    await page.locator('#style-inspector-title').filter({ hasText: 'Survival' }).waitFor()
    assert.equal(await survival.evaluate(element => element === document.activeElement), true)
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('paxis'), 'deathsPerMinute')
    await page.getByRole('button', { name: 'Teams', exact: true }).click()
    await page.getByLabel('Compare with', { exact: true }).selectOption('b')
    await page.getByRole('button', { name: /^Towers per game\. / }).click()
    await page.getByLabel('League', { exact: true }).selectOption('LCK')
    await waitValue(page, 'Team', 'a')
    await waitValue(page, 'Compare with', '')
    assert.equal(await page.getByLabel('Team', { exact: true }).locator('option').count(), 1)
    await page.locator('#style-inspector').getByText('Fewer than 2 eligible peers. No percentile is shown.', { exact: true }).waitFor()
    await page.goBack()
    await page.waitForFunction(() => (document.querySelector('select') as HTMLSelectElement)?.value === 'season:2026'
      && [...document.querySelectorAll('select')].some(select => select.value === 'b'))
    await waitValue(page, 'League', '')
    await waitValue(page, 'Compare with', 'b')
    await page.goForward()
    await page.waitForFunction(() => [...document.querySelectorAll('select')].some(select => select.value === 'LCK'))
    await page.reload()
    await page.getByRole('heading', { name: 'Alpha', exact: true, level: 2 }).waitFor()
    await waitValue(page, 'League', 'LCK')
    await page.getByLabel('Scope', { exact: true }).selectOption('season:2025')
    await page.locator('.style-radar-empty').waitFor()
    assert.equal(await page.locator('.style-shape.style-series-a circle').count(), 0)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Players', exact: true }).click()
    await page.getByLabel('Role', { exact: true }).selectOption('Support')
    await page.getByLabel('Compare with', { exact: true }).selectOption('b-4|Support')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    assert.equal(await page.getByRole('table', { name: 'Style profile measures' }).count(), 1)
    assert.ok(requests.filter(path => path === '/data/style-profiles.json').length >= 3)
    assert.deepEqual([...new Set(requests.filter(path => path !== '/data/style-profiles.json' && path !== '/data/ranking-summary.json'))], [], 'Profiles must not request ranking snapshots, checkpoint data or player artifacts')
    assert.deepEqual(errors, [])
    await page.setViewportSize({ width: 1280, height: 1000 })
    await page.getByRole('link', { name: 'Players', exact: true }).first().click()
    await page.getByRole('heading', { name: 'Player rankings', exact: true, level: 1 }).waitFor()
    await page.waitForLoadState('networkidle')
    assert.ok(new URL(page.url()).hash.startsWith('#players?'))
    assert.equal(await page.locator('.style-profiles').count(), 0)
    await page.goBack()
    await page.getByRole('heading', { name: 'Style profiles', exact: true, level: 1 }).waitFor()
    await page.locator('.style-radar-empty').waitFor()
    assert.ok(new URL(page.url()).hash.startsWith('#profiles?'))
  } finally {
    await browser.close()
  }
})
