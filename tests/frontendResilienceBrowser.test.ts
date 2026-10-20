import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createServer, type Plugin } from 'vite'
import { frontendResilienceFixture } from './fixtures/frontendResilienceFixture'

test('Regions and Matches recover and follow addressed state', { timeout: 60_000 }, async (t) => {
  const { bodies, pagePaths } = frontendResilienceFixture()
  assert.ok(pagePaths.size > 0)
  let failPages = false
  const fixture: Plugin = { name: 'frontend-resilience-fixture', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
      if (!path.startsWith('/data/')) return next()
      const body = failPages && pagePaths.has(path) ? undefined : bodies.get(path)
      response.setHeader('content-type', 'application/json')
      response.statusCode = body ? 200 : 503
      response.end(body ?? '{}')
    })
  } }
  const server = await createServer({ publicDir: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, plugins: [fixture] })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer!.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const executablePath = chromium.executablePath()
    browser = await chromium.launch(existsSync(executablePath) ? { headless: true } : { headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(5_000)
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } })
    })

    await t.test('an international Bo2 draw retains half-win credits in the record', async () => {
      await page.goto(`${base}/#regions?scope=all`)
      const region = page.getByTitle('Open LCK region detail', { exact: true })
      await region.waitFor()
      assert.match(await region.innerText(), /International record 0\.5–0\.5/)
    })

    await t.test('an international Bo2 draw has a draw label for either region', async () => {
      await page.goto(`${base}/?draw=1#regions?scope=all&regionDetail=LCK`)
      const draw = page.getByRole('article').filter({ hasText: 'Synthetic international draw' })
      await draw.waitFor()
      assert.ok((await draw.innerText()).includes('Region draw'), 'the region must show a draw for a 1-1 series')
      assert.ok(!(await draw.innerText()).includes('Region loss'))
      await page.goto(`${base}/?draw=2#regions?scope=all&regionDetail=LEC`)
      await draw.waitFor()
      assert.ok((await draw.innerText()).includes('Region draw'))
    })

    await t.test('changing the Matches hash updates the team filter and visible series without reload', async () => {
      await page.goto(`${base}/#matches?scope=all&team=T1`)
      const rows = page.locator('table tbody tr')
      await rows.nth(1).waitFor()
      const documentTime = await page.evaluate(() => performance.timeOrigin)
      await page.evaluate(() => { location.hash = '#matches?scope=all&team=G2' })
      await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[type="search"]')?.value === 'G2')
      assert.equal(await rows.count(), 1)
      assert.match(await rows.first().innerText(), /G2/)
      assert.equal(await page.evaluate(() => performance.timeOrigin), documentTime)
      await page.goBack()
      await rows.nth(1).waitFor()
      assert.equal(await page.getByRole('searchbox', { name: 'Find a team' }).inputValue(), 'T1')
    })

    await t.test('a failed match page can be retried without losing the filters', async () => {
      failPages = true
      await page.goto(`${base}/?retry=1#matches?scope=all&team=G2`)
      const alert = page.getByRole('alert').filter({ hasText: /503/ })
      await alert.waitFor()
      failPages = false
      await alert.getByRole('button', { name: 'Retry', exact: true }).click()
      await page.locator('table tbody tr').waitFor()
      assert.equal(await page.getByRole('searchbox', { name: 'Find a team' }).inputValue(), 'G2')
      assert.equal(await alert.count(), 0)
    })
  } finally {
    await browser?.close()
    await server.close()
  }
})
