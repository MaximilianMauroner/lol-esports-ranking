import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createServer, type Plugin } from 'vite'

test('the tournament skeleton fits mobile and stays visible between chunk and feed loading', { timeout: 30_000 }, async () => {
  let releaseChunk!: () => void
  const chunkReady = new Promise<void>((resolve) => { releaseChunk = resolve })
  const pendingFeed: Array<() => void> = []
  const fixture: Plugin = { name: 'loading-transition-fixture', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (!request.url?.startsWith('/tournament-data/')) return next()
      pendingFeed.push(() => { response.statusCode = 503; response.end('{}') })
    })
  } }
  const server = await createServer({ publicDir: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, plugins: [fixture] })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer!.address()
    assert.ok(address && typeof address !== 'string')
    const executablePath = chromium.executablePath()
    browser = await chromium.launch(existsSync(executablePath) ? { headless: true } : { headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 320, height: 800 } })
    await page.route('**/src/views/tournaments/TournamentsView.tsx*', async (route) => { await chunkReady; await route.continue() })
    await page.goto(`http://127.0.0.1:${address.port}/#tournaments`, { waitUntil: 'domcontentloaded' })
    const initialLoader = page.getByRole('status').filter({ hasText: 'Loading Tournaments' })
    await initialLoader.waitFor()
    const fitsViewport = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        const loader = [...document.querySelectorAll('[role="status"]')]
          .find((node) => node.textContent?.includes('Loading tournament schedule'))
        if (!loader) return
        document.body.dataset.loaderHandoffVisible = String(getComputedStyle(loader).visibility === 'visible')
        observer.disconnect()
      })
      observer.observe(document.body, { childList: true, subtree: true })
    })
    releaseChunk()
    const feedLoader = page.getByRole('status').filter({ hasText: 'Loading tournament schedule' })
    await feedLoader.waitFor({ state: 'attached' })
    const staysVisible = await page.evaluate(() => document.body.dataset.loaderHandoffVisible === 'true')
    assert.deepEqual({ fitsViewport, staysVisible }, { fitsViewport: true, staysVisible: true })
  } finally {
    releaseChunk()
    pendingFeed.splice(0).forEach((respond) => respond())
    await browser?.close()
    await server.close()
  }
})
