import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getHeapStatistics } from 'node:v8'

const prep = dirname(fileURLToPath(import.meta.url))
const old = '/home/codex/.local/state/pstack/mistake-prevention-20261015/max-update'
const hostPath = `${old}/r3-live-server-ledger-fix-v4/fixture-host.mjs`
const [root, head, tree, out, unit, ordinal] = process.argv.slice(2)
assert.equal(process.argv.length, 8, 'root head tree observer-output unit ordinal')
assert.ok(isAbsolute(root) && isAbsolute(out) && process.cwd() === root)
const expected = Number(ordinal) % 2 ? ['baseline', '65749ff73a401959d9bdc5b1e8e4001ce4464e0e', 'e0652c073d5308fb140a46a55335734d4b3bbaf8'] : ['head', 'd38add5f228e67022a3001e27a820ad76657f37f', '10c19882806045f340674c6627b4715929ee020e']
assert.ok(['1', '2', '3', '4'].includes(ordinal))
assert.equal(unit, `requests-${ordinal}-${expected[0]}`)
assert.equal(head, expected[1]); assert.equal(tree, expected[2])
assert.match(process.version, /^v24\./)
process.env.GIT_OPTIONAL_LOCKS = '0'
const sha = (body) => createHash('sha256').update(body).digest('hex')
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const inputs = json(join(prep, 'input-manifest.json'))
for (const input of inputs) assert.equal(sha(readFileSync(input.path)), input.sha256, `input ${input.path}`)
assert.equal(sha(readFileSync(hostPath)), '0bd06eef1c5d8bc10889334a37b108e277e580f03a5ec6a1327531af6bbce2bf')
const origins = json(`${old}/r3-live-server-ledger-fix-v4/fixture-origins.json`)
const { sourceIdentity } = await import(pathToFileURL(origins.identityHelper).href)
const driverOut = join(out, 'driver')
mkdirSync(driverOut, { mode: 0o700 })
const save = (name, value) => writeFileSync(join(driverOut, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
const eventPath = join(driverOut, 'events.jsonl')
writeFileSync(eventPath, '', { flag: 'wx', mode: 0o600 })
let sequence = 0
let window = 'setup'
let ledgerError = null
const emit = (source, kind, value = {}) => {
  try { appendFileSync(eventPath, `${JSON.stringify({ seq: ++sequence, hr: String(process.hrtime.bigint()), wall: new Date().toISOString(), window, source, kind, ...value })}\n`) }
  catch (error) { ledgerError ??= String(error); process.exitCode = 1; console.error('sticky-ledger-error', error) }
}
const cache = () => {
  const path = join(root, 'node_modules/.vite/deps/_metadata.json')
  const body = existsSync(path) ? readFileSync(path) : null
  return { path, exists: body !== null, sha256: body ? sha(body) : null }
}
const dependencyPins = json(join(prep, 'dependency-state-pins.json'))
const dependencyState = () => Object.fromEntries(dependencyPins.paths.map((path) => [path, sha(readFileSync(join(root, path)))]))
const runtimeReceipt = (pid) => {
  const values = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
  const value = (key) => values.find((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1) ?? null
  return { pid, argv: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean), nodeOptions: value('NODE_OPTIONS'), workspaceOverride: value('NPM_CONFIG_WORKSPACE_DIR') }
}
const capValid = (runtime, script) => runtime.nodeOptions === '--max-old-space-size=1536' && runtime.workspaceOverride === null && runtime.argv.indexOf(script) > 0 && !runtime.argv.slice(1, runtime.argv.indexOf(script)).some((arg) => /^--(?:max[-_]old[-_]space[-_]size|huge[-_]max[-_]old[-_]generation[-_]size)/.test(arg))
const instrumentSources = () => Object.fromEntries(['abab-driver.mjs', 'locked-abab.sh', 'compare-abab.mjs', 'input-manifest.json', 'dependency-state-pins.json'].map((name) => [name, sha(readFileSync(join(prep, name)))]))
const session = join(out, 'session')
const metadata = { instrumentSources: instrumentSources(), label: 'SYNTHETIC seeded-sample. Not official LoL Esports data.', unit, orderIndex: Number(ordinal), side: expected[0], root, expectedHead: head, expectedTree: tree, out, driverPid: process.pid, started: new Date().toISOString(), argv: process.argv, node: process.version, hostPath, hostSha256: sha(readFileSync(hostPath)), viewport: { width: 1280, height: 900 }, cachePolicy: { route: false, setCacheDisabled: false, serviceWorkersOption: 'default', controlFetchCacheOption: 'default' }, launch: { headless: true }, config: { quietMs: 3000, actionSettleMs: 3000, defaultTimeoutMs: 30000, retries: 0, warmup: false, variant: 'request65' } }
let child, context, browser, page, cdp, childClosed, childExit, sourceBefore, fixtureBefore
let hostOutFd, hostErrFd
const cleanupErrors = []
const pwIds = new WeakMap()
let pwSeq = 0
const requestId = (request) => {
  if (!pwIds.has(request)) pwIds.set(request, ++pwSeq)
  return pwIds.get(request)
}
const inflight = new Set()
let lastArtifact = process.hrtime.bigint()
let base
const artifact = (url) => {
  try { const u = new URL(url); return /^\/(data|tournament-data)\//.test(u.pathname) }
  catch { return false }
}
const pause = async (ms) => {
  const deadline = process.hrtime.bigint() + BigInt(ms) * 1_000_000n
  let remaining = deadline - process.hrtime.bigint()
  while (remaining > 0n) {
    await new Promise((resolve) => setTimeout(resolve, Number(remaining) / 1_000_000))
    remaining = deadline - process.hrtime.bigint()
  }
}
async function barrier() {
  const hrBefore = String(process.hrtime.bigint())
  const pagePerfNow = await page.evaluate(() => performance.now())
  const reply = await cdp.send('Runtime.evaluate', { expression: 'performance.now()', returnByValue: true })
  assert.ok(!reply.exceptionDetails && Number.isFinite(reply.result.value), 'CDP barrier reply')
  const dom = await page.evaluate(() => ({ tableHtml: document.querySelector('table')?.outerHTML ?? '', hash: location.hash, query: location.hash.split('?')[1] ?? '', rowTitles: [...document.querySelectorAll('table tbody tr')].map((row) => ({ text: row.textContent, titles: [...row.querySelectorAll('[title]')].map((node) => node.getAttribute('title')) })), ariaSort: Object.fromEntries([...document.querySelectorAll('th')].map((node) => [node.querySelector('button > span')?.textContent ?? node.textContent, node.getAttribute('aria-sort')])), filtersVisible: [...document.querySelectorAll('button')].filter((node) => /^Filters/.test(node.textContent)).map((node) => ({ text: node.textContent, visible: !!node.getClientRects().length })) }))
  writeFileSync(join(driverOut, `${window}-table.html`), dom.tableHtml, { flag: 'wx', mode: 0o600 })
  dom.tableSha256 = sha(dom.tableHtml)
  delete dom.tableHtml
  emit('driver', 'barrier', { hrBefore, hrAfter: String(process.hrtime.bigint()), pagePerfNow, cdpPerfNow: reply.result.value, dom })
}
async function step(action, run) {
  const names = { 'sort Power': 'a01-sort-power', 'sort Record': 'a02-sort-record', 'sort Rank': 'a03-sort-rank', 'tier S': 'a04-tier-s', 'tier All': 'a05-tier-all', 'region LCK': 'a06-region-lck', 'region All': 'a07-region-all', 'search Alp': 'a08-search-alp', 'search clear': 'a09-search-clear', 'include unranked': 'a10-include-unranked', 'ranked only': 'a11-ranked-only' }
  window = names[action] ?? action
  emit('driver', 'window-open')
  emit('driver', 'action-start', { action })
  await run()
  emit('driver', 'postcondition-met', { action })
  await pause(3000)
  await barrier()
  emit('driver', 'window-close')
}
try {
  emit('driver', 'start', { ...metadata })
  const dependencyBefore = dependencyState()
  save('dependency-state-before.json', dependencyBefore)
  assert.deepEqual(dependencyBefore, dependencyPins.expected[expected[0]], 'pinned dependency state before host launch')
  const forbiddenEnv = Object.keys(process.env).filter((key) => key.startsWith('VITE_') || ['PLAYWRIGHT_DISABLE_SERVICE_WORKER_NETWORK', 'PLAYWRIGHT_BROWSERS_PATH', 'NPM_CONFIG_WORKSPACE_DIR'].includes(key))
  const envFiles = readdirSync(root).filter((name) => name.startsWith('.env'))
  emit('driver', 'environment', { forbiddenEnv, envFiles })
  assert.deepEqual(forbiddenEnv, []); assert.deepEqual(envFiles, [])
  sourceBefore = sourceIdentity(root, head, tree)
  fixtureBefore = sourceIdentity(origins.fixtureRoot, origins.fixtureHead, origins.fixtureTree)
  save('source-before.json', sourceBefore); save('fixture-source-before.json', fixtureBefore)
  save('cache-before-launch.json', cache())
  const pkg = json(join(root, 'node_modules/playwright-core/package.json'))
  const browserCatalog = json(join(root, 'node_modules/playwright-core/browsers.json'))
  const shell = browserCatalog.browsers.find((entry) => entry.name === 'chromium-headless-shell')
  assert.equal(pkg.version, '1.63.0'); assert.equal(shell.revision, '1243'); assert.equal(shell.browserVersion, '153.0.8010.12')
  metadata.playwrightCore = pkg.version; metadata.browserCatalog = shell
  hostOutFd = openSync(join(driverOut, 'host.stdout'), 'wx')
  hostErrFd = openSync(join(driverOut, 'host.stderr'), 'wx')
  const args = ['exec', 'tsx', '--tsconfig', 'tsconfig.app.json', hostPath, root, head, tree, session, 'request65']
  emit('driver', 'host-spawn', { command: 'pnpm', args, cwd: root })
  child = spawn('pnpm', args, { cwd: root, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', COREPACK_ENABLE_NETWORK: '0' }, stdio: ['ignore', hostOutFd, hostErrFd] })
  let spawnError = null
  child.once('error', (error) => { spawnError = String(error); emit('driver', 'host-spawn-error', { error: spawnError }) })
  childClosed = new Promise((resolve) => child.once('close', (code, signal) => { childExit = { code, signal, spawnError, childPid: child.pid ?? null }; emit('driver', 'host-close', childExit); resolve() }))
  const readinessDeadline = Date.now() + 13 * 60_000
  while (!existsSync(join(session, 'server-identity.json'))) {
    assert.ok(!childExit, 'host closed before identity')
    assert.ok(Date.now() < readinessDeadline, 'host readiness exhausted its existing budget')
    await pause(100)
  }
  const identity = json(join(session, 'server-identity.json'))
  assert.equal(identity.root, root); assert.equal(identity.head, head); assert.equal(identity.tree, tree)
  assert.equal(identity.variant, 'request65'); assert.equal(identity.controlPath, join(session, 'control.jsonl'))
  assert.equal(identity.base, `http://127.0.0.1:${identity.port}`)
  base = identity.base
  emit('driver', 'host-identity', identity)
  const driverRuntime = { ...runtimeReceipt(process.pid), execArgv: process.execArgv, heapSizeLimitBytes: getHeapStatistics().heap_size_limit }
  const hostRuntime = runtimeReceipt(identity.pid)
  emit('driver', 'runtime-cap', { driver: driverRuntime, host: hostRuntime })
  assert.ok(capValid(driverRuntime, fileURLToPath(import.meta.url)) && capValid(hostRuntime, hostPath), 'raw driver/actual host 1536 MiB cap and workspace override unset')
  const { chromium } = await import(pathToFileURL(join(root, 'node_modules/playwright-core/index.mjs')).href)
  browser = await chromium.launch({ headless: true })
  metadata.browserVersion = browser.version()
  assert.equal(metadata.browserVersion, shell.browserVersion)
  const browserSession = await browser.newBrowserCDPSession()
  const info = await browserSession.send('SystemInfo.getProcessInfo')
  const browserPid = info.processInfo.find((item) => item.type === 'browser')?.id
  assert.ok(Number.isInteger(browserPid), 'actual browser PID')
  const executable = readlinkSync(`/proc/${browserPid}/exe`)
  assert.ok(executable.includes('chromium_headless_shell-1243/'), 'actual pinned installed shell')
  emit('driver', 'browser-identity', { browserPid, executable, executableSha256: sha(readFileSync(executable)), version: metadata.browserVersion, catalog: shell, playwrightCore: pkg.version, launch: metadata.launch })
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  context.on('request', (request) => {
    const id = requestId(request)
    const url = request.url()
    if (artifact(url)) { inflight.add(`pw:${id}`); lastArtifact = process.hrtime.bigint() }
    let frameUrl = null
    try { frameUrl = request.frame().url() } catch {}
    emit('pw', 'request', { pwId: id, url, headers: request.headers(), method: request.method(), resourceType: request.resourceType(), isNavigation: request.isNavigationRequest(), redirectedFromPwId: request.redirectedFrom() ? requestId(request.redirectedFrom()) : null, frameUrl, serviceWorker: !!request.serviceWorker() })
  })
  context.on('response', (response) => emit('pw', 'response', { pwId: requestId(response.request()), url: response.url(), status: response.status(), headers: response.headers(), fromServiceWorker: response.fromServiceWorker() }))
  context.on('requestfinished', (request) => { inflight.delete(`pw:${requestId(request)}`); emit('pw', 'requestfinished', { pwId: requestId(request), url: request.url() }) })
  context.on('requestfailed', (request) => { inflight.delete(`pw:${requestId(request)}`); emit('pw', 'requestfailed', { pwId: requestId(request), url: request.url(), failure: request.failure() }) })
  context.on('serviceworker', (worker) => emit('ctx', 'serviceworker', { url: worker.url() }))
  context.on('console', (message) => emit('ctx', 'console', { type: message.type(), text: message.text(), location: message.location() }))
  context.on('weberror', (error) => emit('ctx', 'weberror', { error: String(error.error()), stack: error.error()?.stack }))
  context.on('page', (p) => emit('ctx', 'page', { url: p.url() }))
  context.on('close', () => emit('ctx', 'close'))
  page = await context.newPage()
  page.on('worker', (worker) => emit('page', 'worker', { url: worker.url() }))
  page.on('frameattached', (frame) => emit('page', 'frameattached', { url: frame.url() }))
  page.on('framenavigated', (frame) => emit('page', 'framenavigated', { url: frame.url(), main: frame === page.mainFrame() }))
  for (const kind of ['domcontentloaded', 'load', 'crash', 'close']) page.on(kind, () => emit('page', kind, { url: page.url() }))
  page.on('pageerror', (error) => emit('page', 'pageerror', { error: String(error), stack: error.stack }))
  page.on('console', (message) => emit('page', 'console', { type: message.type(), text: message.text(), location: message.location() }))
  cdp = await context.newCDPSession(page)
  for (const kind of ['requestWillBeSent', 'requestWillBeSentExtraInfo', 'requestServedFromCache', 'responseReceived', 'responseReceivedExtraInfo', 'loadingFinished', 'loadingFailed']) cdp.on(`Network.${kind}`, (raw) => {
    if (kind === 'requestWillBeSent') {
      inflight.delete(`cdp:${raw.requestId}`)
      if (artifact(raw.request.url)) { inflight.add(`cdp:${raw.requestId}`); lastArtifact = process.hrtime.bigint() }
    }
    if (kind === 'loadingFinished' || kind === 'loadingFailed') inflight.delete(`cdp:${raw.requestId}`)
    emit('cdp', kind, { raw })
  })
  await cdp.send('Network.enable')
  emit('driver', 'listeners-ready', { frames: page.frames().map((frame) => frame.url()), workers: page.workers().map((worker) => worker.url()), serviceWorkers: context.serviceWorkers().map((worker) => worker.url()) })
  window = 'load'; emit('driver', 'window-open')
  const rows = page.locator('table tbody tr')
  emit('driver', 'goto', { url: `${base}/#rankings` })
  await page.goto(`${base}/#rankings`)
  await page.getByRole('heading', { name: 'Team Power Index', exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 4)
  emit('driver', 'initial-four-rows', { rows: await rows.count() })
  await page.waitForLoadState('networkidle')
  emit('driver', 'first-networkidle')
  const quietDeadline = Date.now() + 30000
  while (inflight.size || process.hrtime.bigint() - lastArtifact < 3_000_000_000n) {
    assert.ok(Date.now() < quietDeadline, 'load artifact quiet boundary timed out')
    await pause(50)
  }
  emit('driver', 'load-quiet', { lastArtifactHr: String(lastArtifact), inflight: [...inflight] })
  await barrier()
  assert.equal(inflight.size, 0, 'load barrier has no artifact inflight')
  assert.ok(process.hrtime.bigint() - lastArtifact >= 3_000_000_000n, 'load barrier still quiet')
  save('cache-loaded-boundary.json', cache())
  emit('driver', 'loaded-boundary')
  emit('driver', 'window-close')
  const sortButton = (name) => page.getByRole('columnheader', { name }).getByRole('button')
  const chip = (group, name) => page.getByRole('group', { name: group }).getByRole('button', { name })
  await step('sort Power', async () => { await sortButton('Power').click(); await page.getByRole('columnheader', { name: 'Power' }).and(page.locator('[aria-sort="descending"]')).waitFor() })
  await step('sort Record', async () => { await sortButton('Record').click(); await page.getByRole('columnheader', { name: 'Record' }).and(page.locator('[aria-sort="descending"]')).waitFor() })
  await step('sort Rank', async () => { await sortButton('Rank').click(); await page.getByRole('columnheader', { name: 'Rank' }).and(page.locator('[aria-sort="ascending"]')).waitFor() })
  await step('tier S', async () => { await chip('Tier', /^S · [1-9]/).click(); await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('tier') === 'S') })
  await step('tier All', async () => { await chip('Tier', 'All tiers').click(); await page.waitForFunction(() => !new URLSearchParams(location.hash.split('?')[1]).has('tier')) })
  await step('region LCK', async () => { await page.getByRole('group', { name: 'Region' }).getByRole('button').nth(1).click(); await page.waitForFunction(() => new URLSearchParams(location.hash.split('?')[1]).get('region') === 'LCK') })
  await step('region All', async () => { await chip('Region', 'All regions').click(); await page.waitForFunction(() => !new URLSearchParams(location.hash.split('?')[1]).has('region')) })
  await step('search Alp', async () => { await page.getByRole('searchbox', { name: 'Find a team' }).fill('Alp'); await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 1) })
  await step('search clear', async () => { await page.getByRole('searchbox', { name: 'Find a team' }).fill(''); await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 4) })
  const unranked = page.getByRole('checkbox', { name: /Include unranked/ })
  const filtersButton = page.getByRole('button', { name: /^Filters/ })
  await step('a09b-filters-open', async () => {
    const visible = await filtersButton.isVisible()
    emit('driver', 'filters-button', { visible })
    if (visible) await filtersButton.click()
  })
  await step('include unranked', async () => { await unranked.check(); await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 5) })
  await step('ranked only', async () => { await unranked.uncheck(); await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 4) })
  await step('tail', async () => {})
  const events = readFileSync(eventPath, 'utf8').trim().split('\n').map(JSON.parse)
  const candidate = events.find((e) => e.source === 'pw' && e.kind === 'response' && e.window === 'load' && e.status === 200 && new URL(e.url).origin === base && /^\/data\/objects\/sha256\/[a-f0-9]{64}$/.test(new URL(e.url).pathname))
  assert.ok(candidate, 'cached positive control needs actual loaded immutable object')
  window = 'control'; emit('driver', 'window-open')
  const controlId = randomUUID()
  emit('driver', 'control-start', { controlId, url: candidate.url, header: 'X-R3-Positive-Control' })
  const status = await page.evaluate(async ({ url, controlId }) => { const response = await fetch(url, { headers: { 'X-R3-Positive-Control': controlId } }); await response.arrayBuffer(); return response.status }, { url: candidate.url, controlId })
  emit('driver', 'control-result', { controlId, url: candidate.url, status })
  await pause(3000); await barrier(); emit('driver', 'window-close')
} catch (error) {
  process.exitCode = 1
  emit('driver', 'error', { error: String(error), stack: error.stack })
  console.error(error)
} finally {
  window = 'teardown'; emit('driver', 'window-open')
  for (const [name, close] of [['context', async () => { if (context) { await context.close(); emit('driver', 'context-closed') } }], ['browser', async () => { if (browser) { await browser.close(); emit('driver', 'browser-closed', { connected: browser.isConnected() }) } }]]) {
    try { await close() } catch (error) { cleanupErrors.push({ name, error: String(error) }); process.exitCode = 1; emit('driver', 'cleanup-error', { name, error: String(error) }) }
  }
  try {
    if (existsSync(join(session, 'control.jsonl'))) { appendFileSync(join(session, 'control.jsonl'), '{"op":"stop"}\n'); emit('driver', 'host-stop-requested') }
    if (childClosed) await childClosed
    if (hostOutFd !== undefined) closeSync(hostOutFd)
    if (hostErrFd !== undefined) closeSync(hostErrFd)
    const dependencyAfter = dependencyState()
    save('dependency-state-after.json', dependencyAfter)
    assert.deepEqual(dependencyAfter, json(join(driverOut, 'dependency-state-before.json')), 'dependency state unchanged through host close')
    save('cache-after.json', cache())
    save('source-after.json', sourceIdentity(root, head, tree))
    save('fixture-source-after.json', sourceIdentity(origins.fixtureRoot, origins.fixtureHead, origins.fixtureTree))
  } catch (error) { cleanupErrors.push({ name: 'host/source-after', error: String(error) }); process.exitCode = 1; emit('driver', 'cleanup-error', { error: String(error) }) }
  emit('driver', 'window-close')
  save('unit.json', { ...metadata, ended: new Date().toISOString(), childExit: childExit ?? null, cleanupErrors, ledgerError })
  emit('driver', 'end')
  save('end.json', { ended: new Date().toISOString(), ledgerError, eventsSha256: sha(readFileSync(eventPath)), instrumentSources: instrumentSources() })
  if (ledgerError || !childExit || childExit.code !== 0 || childExit.signal || childExit.spawnError) process.exitCode = 1
}
