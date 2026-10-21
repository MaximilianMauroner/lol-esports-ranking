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
    const [calendarBox, powerBox, averageBox, gapBox] = await page.locator('[data-slot="chart"]').all()
    const power = page.getByRole('application', { name: 'Power over seasons for North, South' })
    const average = page.getByRole('application', { name: 'Average over seasons for North, South' })
    const details = page.getByRole('region', { name: 'Selected chart point details' })

    await t.test('details show the latest row before any hover', async () => {
      assert.equal(await details.innerText(), 'Row 2026-06-30: Alpha 1600')
    })
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
    await t.test('hovering one season chart shows the same season in its sibling', async () => {
      const box = await power.boundingBox()
      assert.ok(box)
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2)
      const sibling = averageBox.locator('.recharts-tooltip-wrapper')
      await sibling.getByText('2025', { exact: true }).waitFor()
      assert.match(await sibling.innerText(), /North\s+2140/)
      assert.match(await sibling.innerText(), /South\s+No value/)
    })
    await t.test('Tab focus draws a 2px ring, and ArrowRight moves the active season in both charts', async () => {
      await page.mouse.move(0, 0)
      await power.focus()
      await page.keyboard.press('Tab')
      const ring = await average.evaluate((svg) => {
        const style = getComputedStyle(svg)
        return { focused: document.activeElement === svg, style: style.outlineStyle, width: style.outlineWidth }
      })
      assert.deepEqual(ring, { focused: true, style: 'solid', width: '2px' })
      const tooltip = averageBox.locator('.recharts-tooltip-wrapper')
      await tooltip.getByText('2025', { exact: true }).waitFor()
      await page.keyboard.press('ArrowRight')
      await tooltip.getByText('2026 · in progress', { exact: true }).waitFor()
      assert.match(await tooltip.innerText(), /South\s+1700/)
      await powerBox.locator('.recharts-tooltip-wrapper').getByText('2026 · in progress', { exact: true }).waitFor()
    })
    await t.test('no line crosses a season without a value', async () => {
      const tick2024 = await gapBox.locator('.recharts-xAxis-tick-labels text').filter({ hasText: /^2024$/ }).boundingBox()
      assert.ok(tick2024)
      const x2024 = tick2024.x + tick2024.width / 2
      const lines = await gapBox.locator('.recharts-line path.recharts-curve').evaluateAll((paths) => paths.map((path) => {
        const rect = path.getBoundingClientRect()
        return { left: rect.left, right: rect.right, dashed: path.getAttribute('stroke-dasharray') }
      }))
      assert.ok(lines.length > 0)
      assert.deepEqual(lines.filter((line) => line.left < x2024 && line.right > x2024), [])
      assert.equal(lines.filter((line) => line.dashed === '4 4').length, 1, 'only the connector into the in-progress season is dashed')
      await gapBox.locator('xpath=..').getByText('2026 is in progress. The dashed line leads to its value so far.').waitFor()
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
