import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

test('line charts share one hover model', { timeout: 60_000 }, async (t) => {
  const server = await createServer({ publicDir: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const executablePath = chromium.executablePath()
    browser = await chromium.launch(existsSync(executablePath) ? { headless: true } : { headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1280, height: 1200 }, timezoneId: 'America/Los_Angeles' })
    page.on('pageerror', (error) => console.error(error.message))
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/lineChart.html`)
    const chart = page.getByRole('application', { name: 'Rating over time for Alpha' })
    await chart.locator('.recharts-xAxis-tick-labels text').last().waitFor()
    const [calendarBox, powerBox, averageBox] = await page.locator('[data-slot="chart"]').all()
    const power = page.getByRole('application', { name: 'Power over seasons for North, South' })
    const average = page.getByRole('application', { name: 'Average over seasons for North, South' })

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
      const box = await chart.boundingBox()
      assert.ok(box)
      await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2)
      await calendarBox.locator('.recharts-tooltip-wrapper').getByText('Jun 30, 2026', { exact: true }).waitFor()
    })
    await t.test('hovering one season chart shows the same season in its sibling', async () => {
      const box = await power.boundingBox()
      assert.ok(box)
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2)
      const sibling = averageBox.locator('.recharts-tooltip-wrapper')
      await sibling.getByText('2025', { exact: true }).waitFor()
      assert.match(await sibling.innerText(), /North\s+2140/)
      assert.match(await sibling.innerText(), /South\s+No value/)
    })
    await t.test('keyboard focus and ArrowRight move the active season', async () => {
      await page.mouse.move(0, 0)
      await average.focus()
      const tooltip = averageBox.locator('.recharts-tooltip-wrapper')
      await tooltip.getByText('2025', { exact: true }).waitFor()
      await page.keyboard.press('ArrowRight')
      await tooltip.getByText('2026 · in progress', { exact: true }).waitFor()
      assert.match(await tooltip.innerText(), /South\s+1700/)
      await powerBox.locator('.recharts-tooltip-wrapper').getByText('2026 · in progress', { exact: true }).waitFor()
    })
  } finally {
    await browser?.close()
    await server.close()
  }
})
