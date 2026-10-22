import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { chromium, type Locator, type Page } from 'playwright-core'
import { createServer } from 'vite'

async function centre(chart: Locator, team: string) {
  const box = await chart.locator(`g[data-team="${team}"] circle`).first().boundingBox()
  assert.ok(box, `no dot for ${team}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

function status(chart: Locator) {
  return chart.locator('xpath=..').getByRole('status')
}

test('point charts share the line chart hover model', { timeout: 90_000 }, async (t) => {
  const server = await createServer({ publicDir: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const fixtureUrl = `http://127.0.0.1:${address.port}/tests/fixtures/pointChart.html`
    const executablePath = chromium.executablePath()
    browser = await chromium.launch(existsSync(executablePath) ? { headless: true } : { headless: true, channel: 'chrome' })
    const open = async (page: Page) => {
      page.on('pageerror', (error) => console.error(error.message))
      await page.goto(fixtureUrl)
      const depth = page.getByRole('application', { name: /^Region depth/ })
      const ladder = page.getByRole('application', { name: /^Power ladder/ })
      await depth.locator('g[data-team="Estuary"]').waitFor()
      return { depth, ladder }
    }
    const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } })
    const { depth, ladder } = await open(page)

    await t.test('the pointer snaps to the nearest dot and draws a crosshair at its value', async () => {
      const aurora = await centre(depth, 'Aurora')
      const boreal = await centre(depth, 'Boreal')
      await page.mouse.move(boreal.x + (aurora.x - boreal.x) * 0.3, boreal.y + 6)
      const tooltip = status(depth)
      await tooltip.getByText('Boreal', { exact: true }).waitFor()
      assert.equal(await tooltip.getAttribute('aria-live'), 'polite')
      const crosshairs = await depth.locator('line[stroke="var(--line-strong)"][stroke-width="1"]').evaluateAll((lines) => lines.map((line) => line.getBoundingClientRect().x))
      assert.equal(crosshairs.length, 1)
      assert.ok(Math.abs(crosshairs[0] - boreal.x) < 1, 'the crosshair sits on the active dot')
      await page.mouse.move(0, 0)
      await tooltip.getByText('Boreal', { exact: true }).waitFor({ state: 'hidden' })
    })

    await t.test('the chart is one tab stop, and the arrow keys move between dots and rows', async () => {
      await page.getByRole('button', { name: 'Before depth' }).focus()
      await page.keyboard.press('Tab')
      const ring = await depth.evaluate((svg) => ({ focused: document.activeElement === svg, style: getComputedStyle(svg).outlineStyle, width: getComputedStyle(svg).outlineWidth }))
      assert.deepEqual(ring, { focused: true, style: 'solid', width: '2px' })
      const tooltip = status(depth)
      await tooltip.getByText('Aurora', { exact: true }).waitFor()
      await page.keyboard.press('ArrowDown')
      await tooltip.getByText('Delta', { exact: true }).waitFor()
      await page.keyboard.press('ArrowLeft')
      await tooltip.getByText('Estuary', { exact: true }).waitFor()
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'After depth')
      await tooltip.getByText('Estuary', { exact: true }).waitFor({ state: 'hidden' })
    })

    await t.test('Enter and a click on a ladder row open that team', async () => {
      await page.keyboard.press('Tab')
      const tooltip = status(ladder)
      await tooltip.getByText('Alpha', { exact: true }).waitFor()
      await page.keyboard.press('ArrowDown')
      await tooltip.getByText('Bravo', { exact: true }).waitFor()
      await page.keyboard.press('Enter')
      await page.getByText('Opened Bravo', { exact: true }).waitFor()
      const box = await ladder.boundingBox()
      const charlie = await ladder.locator('g[data-team="Charlie"] rect').boundingBox()
      assert.ok(box && charlie)
      await page.mouse.click(box.x + box.width - 4, charlie.y + charlie.height / 2)
      await page.getByText('Opened Charlie', { exact: true }).waitFor()
    })

    await t.test('a tap shows the tooltip after the finger lifts, and a horizontal scrub moves it', async () => {
      assert.ok(browser)
      const touchPage = await browser.newPage({ viewport: { width: 1000, height: 1400 }, hasTouch: true })
      try {
        const { depth: touchDepth } = await open(touchPage)
        const cdp = await touchPage.context().newCDPSession(touchPage)
        const estuary = await centre(touchDepth, 'Estuary')
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: estuary.x + 4, y: estuary.y }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        const tooltip = status(touchDepth)
        await tooltip.getByText('Estuary', { exact: true }).waitFor()
        const aurora = await centre(touchDepth, 'Aurora')
        const cirrus = await centre(touchDepth, 'Cirrus')
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: aurora.x, y: aurora.y }] })
        await tooltip.getByText('Aurora', { exact: true }).waitFor()
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: (aurora.x + cirrus.x) / 2 - 20, y: aurora.y }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cirrus.x, y: aurora.y }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await tooltip.getByText('Cirrus', { exact: true }).waitFor()
      } finally {
        await touchPage.close()
      }
    })
  } finally {
    await browser?.close()
    await server.close()
  }
})
