import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { createWorldsFixtureServer } from './fixtures/worldsBrowserFixture'

test('Worlds fixture journey computes off-thread, cancels, navigates and invalidates stale state', { timeout: 60_000 }, async () => {
  const { server, controls } = await createWorldsFixtureServer()
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const path = chromium.executablePath()
    browser = await chromium.launch(existsSync(path) ? { headless: true } : { headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${base}/#tournaments`)
    await page.getByText('Current stage: Swiss · round 5', { exact: true }).waitFor()
    await page.getByText('Computation complete.', { exact: true }).waitFor()
    assert.equal(await page.locator('table').first().locator('tbody tr').count(), 19)
    assert.match(await page.locator('table').first().getByRole('cell', { name: 'Swiss: 100.0%; observed outcome', exact: true }).first().getAttribute('aria-label') ?? '', /observed outcome/)
    await page.getByText('Simulation basis and precision', { exact: true }).click()
    await page.getByText(/seeded-monte-carlo · 10,000 sampled trials/).waitFor()
    assert.match(await page.locator('body').innerText(), /Synthetic Worlds state and model evidence/)
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Page overflow at ${width}`)
      await page.getByRole('region', { name: 'Worlds cumulative probabilities' }).focus()
      assert.equal(await page.getByRole('region', { name: 'Worlds cumulative probabilities' }).evaluate((element) => element === document.activeElement), true)
    }
    // A fresh page has no baseline cache. Main-thread marks continue while its worker runs.
    await page.reload()
    await page.getByRole('button', { name: 'Cancel simulation', exact: true }).waitFor()
    // A string avoids tsx's named-function helper inside the isolated browser realm.
    const cancellation: number = await page.evaluate(`(() => {
      const start = performance.now();
      [...document.querySelectorAll('button')].find(element => element.textContent === 'Cancel simulation').click();
      return new Promise(resolve => {
        const check = () => document.body.textContent.includes('Simulation cancelled.') ? resolve(performance.now() - start) : requestAnimationFrame(check);
        check();
      });
    })()`)
    assert.ok(cancellation < 250, `Cancellation took ${cancellation}ms`)
    console.log(`Synthetic browser cancellation acknowledgement: ${cancellation.toFixed(1)} ms`)
    await page.waitForTimeout(1000)
    await page.getByText('Simulation cancelled. Observed state remains available.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Run simulation', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel simulation', exact: true }).waitFor()
    await page.getByText(/^Sampling ·/).waitFor()
    // Correct the source while the restarted worker is active. Its result cannot replace the new state.
    controls.stage = 'completed'
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByText('Current stage: Completed', { exact: true }).waitFor()
    await page.getByText('Computation complete.', { exact: true }).waitFor()
    const champion = page.locator('table').first().getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Fixture LCK1 · LCK1', exact: true }) })
    assert.match(await champion.innerText(), /Reached champion/)
    assert.match(await champion.innerText(), /100.0%/)
    controls.stage = 'swiss-5'; controls.revision++
    await page.reload()
    await page.getByRole('button', { name: 'Cancel simulation', exact: true }).waitFor()
    await page.getByText(/^Sampling ·/).waitFor()
    const navigationStart = performance.now()
    await page.getByRole('link', { name: 'Matches', exact: true }).click()
    await page.waitForURL(/#matches/)
    const navigationMs = performance.now() - navigationStart
    assert.ok(navigationMs < 1000, `Navigation during simulation took ${navigationMs}ms`)
    console.log(`Synthetic browser navigation during simulation: ${navigationMs.toFixed(1)} ms`)
    await page.waitForTimeout(1000)
    assert.equal(await page.getByRole('region', { name: 'Worlds cumulative probabilities' }).count(), 0)
    controls.corrupt = true
    await page.goto(`${base}/#tournaments`)
    await page.getByText(/Worlds state does not match this schedule revision/).waitFor()
    assert.equal(await page.getByRole('region', { name: 'Worlds cumulative probabilities' }).count(), 0)
    controls.corrupt = false; controls.stage = 'play-in'
    await page.reload()
    await page.getByText(/slot displacement, look-ahead order/).waitFor()
    controls.stage = 'swiss-5'; controls.missingModel = true
    await page.reload()
    await page.getByText(/Remaining-stage forecast: the frozen model snapshot is unavailable/).waitFor()
    controls.missingModel = false
    controls.live = true
    await page.reload()
    await page.getByText(/Worlds advancement is unavailable while a series has live/).waitFor()
    assert.equal(await page.getByRole('region', { name: 'Worlds cumulative probabilities' }).count(), 0)
    controls.live = false
    controls.stage = 'historical'
    await page.reload()
    await page.getByText('Worlds 2022 · Group A · Observed results', { exact: true }).waitFor()
    assert.match(await page.locator('body').innerText(), /Current ratings are not used/)
    controls.stage = 'historical-tie'
    await page.reload()
    await page.getByText(/Historical group replay unavailable: A tie crosses/).waitFor()
    await page.getByRole('link', { name: 'Matches', exact: true }).click()
    await page.waitForURL(/#matches/)
    assert.deepEqual(errors, [])
  } finally { await browser?.close(); await server.close() }
})
