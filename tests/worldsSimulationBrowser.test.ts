import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { createWorldsFixtureServer } from './fixtures/worldsBrowserFixture'

test('Worlds fixture journey computes off-thread, cancels, navigates and invalidates stale state', { timeout: 60_000 }, async () => {
  const { server, controls, workerGate } = await createWorldsFixtureServer()
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const path = chromium.executablePath()
    browser = await chromium.launch(existsSync(path) ? { headless: true } : { headless: true, channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    async function waitForSampling() {
      const progress = await workerGate.waitForHeld()
      assert.ok(progress.completed > 0 && progress.completed < progress.total, `Gate must hold real unfinished sampling: ${JSON.stringify(progress)}`)
      await page.getByText(/^Sampling ·/).waitFor()
      await page.getByRole('button', { name: 'Cancel simulation', exact: true }).waitFor()
    }
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
    // An unchanged feed key retains the panel. A rejected companion must invalidate its old baseline.
    const feedBeforeFailure = await (await page.request.get(`${base}/tournament-data/feed.json`)).json()
    controls.corrupt = true
    const feedAfterFailure = await (await page.request.get(`${base}/tournament-data/feed.json`)).json()
    assert.deepEqual(feedAfterFailure.events, feedBeforeFailure.events)
    const refreshRequests: string[] = []
    const recordRefreshRequest = (request: { url(): string }) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith('/tournament-data/')) refreshRequests.push(path)
    }
    page.on('request', recordRefreshRequest)
    try {
      // Check the actual refresh response before judging the retained panel's rejection.
      const [refreshedFeed, refreshedCompanion] = await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === '/tournament-data/feed.json'),
        page.waitForResponse((response) => new URL(response.url()).pathname === `/tournament-data/worlds/${encodeURIComponent(feedBeforeFailure.events[0].id)}.json`),
        page.getByRole('button', { name: 'Refresh', exact: true }).click(),
      ])
      assert.equal(refreshedFeed.status(), 200)
      assert.equal(refreshedCompanion.status(), 200)
      assert.deepEqual((await refreshedFeed.json()).events, feedBeforeFailure.events)
      assert.equal((await refreshedCompanion.json()).feedEventKey, 'stale-fixture-revision')
      await page.getByText(/Worlds state does not match this schedule revision/).waitFor()
    } catch (error) {
      console.error('Same-key Worlds refresh diagnostics:', JSON.stringify({
        requests: refreshRequests, pageErrors: errors, url: page.url(), body: await page.locator('body').innerText(),
      }))
      throw error
    } finally {
      page.off('request', recordRefreshRequest)
    }
    assert.equal(await page.getByRole('region', { name: 'Worlds cumulative probabilities' }).count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Run simulation', exact: true }).count(), 0)
    await page.waitForTimeout(1000)
    await page.getByText(/Worlds state does not match this schedule revision/).waitFor()
    controls.corrupt = false
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByText('Computation complete.', { exact: true }).waitFor()
    assert.equal(await page.locator('table').first().locator('tbody tr').count(), 19)

    // A same-key reload must stop an active worker before the companion request can time out.
    controls.holdWorker = true
    await page.reload()
    await waitForSampling()
    controls.companionDelayMs = 11_000
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByText('Loading reviewed Worlds state.', { exact: true }).waitFor()
    assert.equal(await page.getByRole('region', { name: 'Worlds cumulative probabilities' }).count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Cancel simulation', exact: true }).count(), 0)
    await page.getByText(/Worlds state request timed out/).waitFor({ timeout: 15_000 })
    await page.waitForTimeout(1500)
    await page.getByText(/Worlds state request timed out/).waitFor()
    assert.equal(await page.getByRole('region', { name: 'Worlds cumulative probabilities' }).count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Run simulation', exact: true }).count(), 0)
    assert.equal(workerGate.held.length, 0)
    workerGate.release()
    controls.companionDelayMs = 0
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByText('Computation complete.', { exact: true }).waitFor()
    // A fresh page has no baseline cache. Main-thread marks continue while its worker runs.
    controls.holdWorker = true
    await page.reload()
    await waitForSampling()
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
    assert.equal(workerGate.held.length, 0)
    await page.getByRole('button', { name: 'Run simulation', exact: true }).click()
    await waitForSampling()
    // Correct the source while the restarted worker is active. Its result cannot replace the new state.
    controls.stage = 'completed'
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByText('Current stage: Completed', { exact: true }).waitFor()
    await page.getByText('Computation complete.', { exact: true }).waitFor()
    const champion = page.locator('table').first().getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Fixture LCK1 · LCK1', exact: true }) })
    assert.match(await champion.innerText(), /Reached champion/)
    assert.match(await champion.innerText(), /100.0%/)
    await page.getByText('Simulation basis and precision', { exact: true }).click()
    const completedPanel = page.locator('[aria-label="Worlds simulation"]')
    await completedPanel.getByText('No historical or current model snapshot is assumed.', { exact: true }).waitFor()
    assert.equal(await completedPanel.getByText(/^Snapshot .* · Model /).count(), 0)
    assert.equal(workerGate.held.length, 0)
    workerGate.release()

    // Source assertion tags do not turn the retained synthetic rating model into official inputs.
    controls.fictionalSourceAssertions = true; controls.stage = 'swiss-5'
    await page.reload()
    await page.getByText('Computation complete.', { exact: true }).waitFor()
    await page.getByText(/^Sample model inputs\./).waitFor()
    assert.equal(await page.getByText(/^Synthetic Worlds state and model evidence\./).count(), 0)
    assert.equal(await page.locator('details').filter({ has: page.getByText('Simulation basis and precision', { exact: true }) }).getAttribute('open'), null)
    controls.stage = 'completed'
    await page.reload()
    await page.getByText('Current stage: Completed', { exact: true }).waitFor()
    await page.getByText('Computation complete.', { exact: true }).waitFor()
    assert.equal(await page.getByText(/^Sample model inputs\./).count(), 0)
    await page.getByText('Simulation basis and precision', { exact: true }).click()
    await page.getByText('No historical or current model snapshot is assumed.', { exact: true }).waitFor()
    assert.equal(await page.locator('[aria-label="Worlds simulation"]').getByText(/^Snapshot .* · Model /).count(), 0)
    controls.fictionalSourceAssertions = false
    controls.stage = 'swiss-5'; controls.revision++
    controls.holdWorker = true
    await page.reload()
    await waitForSampling()
    const navigationStart = performance.now()
    await page.getByRole('link', { name: 'Matches', exact: true }).click()
    await page.waitForURL(/#matches/)
    const navigationMs = performance.now() - navigationStart
    assert.ok(navigationMs < 1000, `Navigation during simulation took ${navigationMs}ms`)
    console.log(`Synthetic browser navigation during simulation: ${navigationMs.toFixed(1)} ms`)
    await page.waitForTimeout(1000)
    assert.equal(await page.getByRole('region', { name: 'Worlds cumulative probabilities' }).count(), 0)
    assert.equal(workerGate.held.length, 0)
    workerGate.release()
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
    controls.historicalConflict = true
    await page.reload()
    await page.getByText(/Historical group replay.*schedule/).waitFor()
    assert.equal(await page.getByText('Worlds 2022 · Group A · Observed results', { exact: true }).count(), 0)
    controls.historicalConflict = false
    controls.stage = 'historical-tie'
    await page.reload()
    await page.getByText(/Historical group replay unavailable: A tie crosses/).waitFor()
    await page.getByRole('link', { name: 'Matches', exact: true }).click()
    await page.waitForURL(/#matches/)
    assert.deepEqual(errors, [])
  } finally { await browser?.close(); await server.close() }
})
