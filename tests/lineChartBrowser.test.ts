import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

test('line charts share one hover model', { timeout: 90_000 }, async (t) => {
  const server = await createServer({ publicDir: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const fixtureUrl = `http://127.0.0.1:${address.port}/tests/fixtures/lineChart.html`
    const executablePath = chromium.executablePath()
    browser = await chromium.launch(existsSync(executablePath) ? { headless: true } : { headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1280, height: 1200 }, timezoneId: 'America/Los_Angeles' })
    page.on('pageerror', (error) => console.error(error.message))
    await page.goto(fixtureUrl)
    const chart = page.getByRole('application', { name: 'Rating over time for Alpha' })
    await chart.locator('.recharts-xAxis-tick-labels text').last().waitFor()
    const calendarBox = page.locator('[data-slot="chart"]').first()
    const details = page.getByRole('region', { name: 'Selected chart point details' })

    await t.test('details show the latest row before any hover', async () => {
      assert.equal(await details.innerText(), 'Row 2026-06-30: Alpha 1600')
    })
    await t.test('axis ticks show the recorded calendar days', async () => {
      const ticks = await chart.locator('.recharts-xAxis-tick-labels text').allTextContents()
      assert.equal(ticks[0], 'Jun 1')
      assert.equal(ticks.at(-1), 'Jun 30')
    })
    await t.test('an axis over many months has ticks on month starts, and the first tick and January show the year', async () => {
      const span = page.getByRole('application', { name: 'Span over time for Beta' })
      assert.deepEqual(await span.locator('.recharts-xAxis-tick-labels text').allTextContents(), ['May 2025', 'Sep', 'Jan 2026', 'May', 'Sep'])
    })
    await t.test('screen-reader summary shows the recorded calendar days', async () => {
      const summaryId = await chart.getAttribute('aria-describedby')
      assert.ok(summaryId)
      assert.equal(await page.locator(`[id="${summaryId}"]`).textContent(),
        'Rating chart data summary. Alpha: latest 1600 on Jun 30, 2026, minimum 1500 on Jun 1, 2026, maximum 1600 on Jun 30, 2026, 2 points.')
    })
    await t.test('tooltip shows the same calendar day as the axis in a polite live region', async () => {
      const box = await chart.boundingBox()
      assert.ok(box)
      await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2)
      const status = calendarBox.locator('.recharts-tooltip-wrapper').getByRole('status')
      await status.getByText('Jun 30, 2026', { exact: true }).waitFor()
      assert.equal(await status.getAttribute('aria-live'), 'polite')
    })
    await t.test('hover moves the details, and they keep the row after the pointer leaves', async () => {
      const box = await chart.boundingBox()
      assert.ok(box)
      await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2)
      await details.getByText('Row 2026-06-01: Alpha 1500', { exact: true }).waitFor()
      await page.mouse.move(0, 0)
      await calendarBox.locator('.recharts-tooltip-wrapper').getByText('Jun 1, 2026', { exact: true }).waitFor({ state: 'hidden' })
      assert.equal(await details.innerText(), 'Row 2026-06-01: Alpha 1500')
    })
    await t.test('ArrowRight after keyboard focus moves the details', async () => {
      await chart.focus()
      await page.keyboard.press('ArrowRight')
      await details.getByText('Row 2026-06-30: Alpha 1600', { exact: true }).waitFor()
    })
    await t.test('Tab focus draws a 2px ring on the chart surface', async () => {
      await page.reload()
      await chart.locator('.recharts-xAxis-tick-labels text').last().waitFor()
      await page.keyboard.press('Tab')
      const ring = await chart.evaluate((svg) => {
        const style = getComputedStyle(svg)
        return { focused: document.activeElement === svg, style: style.outlineStyle, width: style.outlineWidth }
      })
      assert.deepEqual(ring, { focused: true, style: 'solid', width: '2px' })
    })

    await t.test('a horizontal touch scrub shows the tooltip and moves the details', async () => {
      assert.ok(browser)
      const touchPage = await browser.newPage({ viewport: { width: 1280, height: 1200 }, timezoneId: 'America/Los_Angeles', hasTouch: true })
      try {
        await touchPage.goto(fixtureUrl)
        const touchChart = touchPage.getByRole('application', { name: 'Rating over time for Alpha' })
        await touchChart.locator('.recharts-xAxis-tick-labels text').last().waitFor()
        const box = await touchChart.boundingBox()
        assert.ok(box)
        const y = box.y + box.height / 2
        const cdp = await touchPage.context().newCDPSession(touchPage)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width * 0.9, y }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width * 0.5, y }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width * 0.1, y }] })
        await touchPage.locator('[data-slot="chart"]').first().locator('.recharts-tooltip-wrapper').getByText('Jun 1, 2026', { exact: true }).waitFor()
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await touchPage.getByRole('region', { name: 'Selected chart point details' }).getByText('Row 2026-06-01: Alpha 1500', { exact: true }).waitFor()
      } finally {
        await touchPage.close()
      }
    })
  } finally {
    await browser?.close()
    await server.close()
  }
})
