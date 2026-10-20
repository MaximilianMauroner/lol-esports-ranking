import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

test('chart calendar dates stay consistent west of UTC', { timeout: 60_000 }, async (t) => {
  const server = await createServer({ publicDir: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const executablePath = chromium.executablePath()
    browser = await chromium.launch(existsSync(executablePath) ? { headless: true } : { headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, timezoneId: 'America/Los_Angeles' })
    page.on('pageerror', (error) => console.error(error.message))
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/chartCalendar.html`)
    const chart = page.getByRole('img', { name: 'Rating over time for Alpha' })
    await chart.locator('.recharts-xAxis-tick-labels text').last().waitFor()

    await t.test('axis ticks show the recorded calendar days', async () => {
      const ticks = await chart.locator('.recharts-xAxis-tick-labels text').allTextContents()
      assert.equal(ticks[0], 'Jun 1')
      assert.equal(ticks.at(-1), 'Jun 30')
    })
    await t.test('screen-reader summary shows the recorded calendar days', async () => {
      const summaryId = await chart.getAttribute('aria-describedby')
      assert.ok(summaryId)
      assert.equal(await page.locator(`[id="${summaryId}"]`).textContent(),
        'Rating chart data summary. Alpha: latest 1600 on Jun 30, 2026, minimum 1500 on Jun 1, 2026, maximum 1600 on Jun 30, 2026, 2 points.')
    })
    await t.test('tooltip shows the same calendar day as the axis', async () => {
      await chart.getByText('Jun 30, 2026', { exact: true }).waitFor()
    })
  } finally {
    await browser?.close()
    await server.close()
  }
})
