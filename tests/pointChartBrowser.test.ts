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

function tooltip(page: Page, team: string) {
  return page.getByRole('status').locator(':scope > div').filter({ hasText: team })
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
      await tooltip(page, 'Boreal').waitFor()
      assert.equal(await tooltip(page, 'Boreal').evaluate((box) => box.parentElement?.getAttribute('aria-live')), 'polite')
      const crosshairs = await depth.locator('line[stroke="var(--line-strong)"][stroke-width="1"]').evaluateAll((lines) => lines.map((line) => line.getBoundingClientRect().x))
      assert.equal(crosshairs.length, 1)
      assert.ok(Math.abs(crosshairs[0] - boreal.x) < 1, 'the crosshair sits on the active dot')
      await page.mouse.move(0, 0)
      await tooltip(page, 'Boreal').waitFor({ state: 'hidden' })
    })

    await t.test('the chart is one tab stop, and the arrow keys move between dots and rows', async () => {
      await page.getByRole('button', { name: 'Before depth' }).focus()
      await page.keyboard.press('Tab')
      const ring = await depth.evaluate((svg) => ({ focused: document.activeElement === svg, style: getComputedStyle(svg).outlineStyle, width: getComputedStyle(svg).outlineWidth }))
      assert.deepEqual(ring, { focused: true, style: 'solid', width: '2px' })
      await tooltip(page, 'Aurora').waitFor()
      await page.keyboard.press('ArrowDown')
      await tooltip(page, 'Delta').waitFor()
      await page.keyboard.press('ArrowLeft')
      await tooltip(page, 'Estuary').waitFor()
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'After depth')
      await tooltip(page, 'Estuary').waitFor({ state: 'hidden' })
    })

    await t.test('Enter and a click on a ladder row open that team', async () => {
      await page.keyboard.press('Tab')
      await tooltip(page, 'Alpha').waitFor()
      await page.keyboard.press('ArrowDown')
      await tooltip(page, 'Bravo').waitFor()
      await page.keyboard.press('Enter')
      await page.getByText('Opened Bravo', { exact: true }).waitFor()
      const box = await ladder.boundingBox()
      const alpha = await ladder.locator('g[data-team="Alpha"] rect').boundingBox()
      assert.ok(box && alpha)
      await page.mouse.click(box.x + box.width - 4, alpha.y + alpha.height / 2)
      await page.getByText('Opened Alpha', { exact: true }).waitFor()
    })

    await t.test('a chart shorter than its tooltip inside a clipping box shows every tooltip line', async () => {
      await page.mouse.move(0, 0)
      await ladder.focus()
      await page.keyboard.press('Home')
      const lines = tooltip(page, 'Alpha').locator('p, dt, dd')
      await lines.first().waitFor()
      const ladderBox = await ladder.boundingBox()
      assert.ok(ladderBox)
      for (const line of await lines.all()) {
        const visible = await line.evaluate((element) => {
          const box = element.getBoundingClientRect()
          const clips = [new DOMRect(0, 0, innerWidth, innerHeight)]
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            if (getComputedStyle(parent).overflow !== 'visible') clips.push(parent.getBoundingClientRect())
          }
          return clips.every((outer) => box.top >= outer.top && box.bottom <= outer.bottom && box.left >= outer.left && box.right <= outer.right)
        })
        assert.ok(visible, `${await line.innerText()} is hidden or clipped`)
      }
      const tipBox = await tooltip(page, 'Alpha').boundingBox()
      assert.ok(tipBox && tipBox.height > ladderBox.height, 'the fixture tooltip must be taller than the ladder')
    })

    await t.test('after a resize the tooltip stays next to its point and inside the window', async () => {
      await ladder.focus()
      await page.keyboard.press('Home')
      await tooltip(page, 'Alpha').waitFor()
      await page.setViewportSize({ width: 280, height: 1400 })
      await page.waitForFunction(() => document.querySelector('svg[aria-label^="Power ladder"]')!.getBoundingClientRect().width < 300)
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const dot = await centre(ladder, 'Alpha')
      const box = await tooltip(page, 'Alpha').boundingBox()
      assert.ok(box)
      assert.ok(box.x >= 0 && box.x + box.width <= 280, `tooltip spans ${box.x} to ${box.x + box.width}`)
      const gaps = [box.x - dot.x, dot.x - (box.x + box.width), dot.y - (box.y + box.height), box.y - dot.y]
      assert.ok(gaps.some((gap) => Math.abs(gap - 12) <= 1.5), `tooltip is not beside the point: ${gaps.join(', ')}`)
      await page.setViewportSize({ width: 1000, height: 1400 })
    })

    await t.test('a large near-tie group keeps the tooltip readable in a short window', async () => {
      assert.ok(browser)
      const shortPage = await browser.newPage({ viewport: { width: 320, height: 240 } })
      try {
        await shortPage.goto(`${fixtureUrl}?large-group`)
        const shortLadder = shortPage.getByRole('application', { name: /^Power ladder/ })
        await shortLadder.locator('g[data-team="Near tie team 01"]').waitFor()
        await shortLadder.evaluate((element) => element.focus({ preventScroll: true }))
        await shortLadder.locator('g[data-team="Near tie team 01"]').evaluate((element) => element.scrollIntoView({ block: 'center' }))
        await shortPage.keyboard.press('Home')
        const dot = await centre(shortLadder, 'Near tie team 01')
        assert.ok(dot.y > 0 && dot.y < 240, 'the active point is in the window')
        const tip = tooltip(shortPage, 'Near tie team 01')
        await tip.waitFor()
        const box = await tip.boundingBox()
        assert.ok(box)
        assert.ok(box.y >= 8 && box.y + box.height <= 232, `tooltip spans ${box.y} to ${box.y + box.height} in a 240 px window`)
        assert.ok(box.x >= 8 && box.x + box.width <= 312, 'the whole tooltip fits the window width')
        assert.match(await tip.innerText(), /Near tie with 15 other teams\./)
        assert.match(await shortLadder.locator('path title').textContent() ?? '', /Near tie team 16/)
      } finally {
        await shortPage.close()
      }
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
        await tooltip(touchPage, 'Estuary').waitFor()
        const aurora = await centre(touchDepth, 'Aurora')
        const cirrus = await centre(touchDepth, 'Cirrus')
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: aurora.x, y: aurora.y }] })
        await tooltip(touchPage, 'Aurora').waitFor()
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: (aurora.x + cirrus.x) / 2 - 20, y: aurora.y }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cirrus.x, y: aurora.y }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await tooltip(touchPage, 'Cirrus').waitFor()
      } finally {
        await touchPage.close()
      }
    })
  } finally {
    await browser?.close()
    await server.close()
  }
})
