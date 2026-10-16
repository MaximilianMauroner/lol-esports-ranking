import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dependencyPins = JSON.parse(readFileSync(new URL('./dependency-state-pins.json', import.meta.url)))

export const windows = ['load', 'a01-sort-power', 'a02-sort-record', 'a03-sort-rank', 'a04-tier-s', 'a05-tier-all', 'a06-region-lck', 'a07-region-all', 'a08-search-alp', 'a09-search-clear', 'a09b-filters-open', 'a10-include-unranked', 'a11-ranked-only', 'tail', 'control', 'teardown']
const heads = ['65749ff73a401959d9bdc5b1e8e4001ce4464e0e', 'd38add5f228e67022a3001e27a820ad76657f37f']
const trees = ['e0652c073d5308fb140a46a55335734d4b3bbaf8', '10c19882806045f340674c6627b4715929ee020e']
const fixtureRoot = '/home/codex/.t3/worktrees/lol-esports-ranking/t3-14557610'
const lock = '3887d73689714304614674614fd51bd5c62f5f704050a5ca7dea4f4b8fc9c0e9'
const hostSha = '0bd06eef1c5d8bc10889334a37b108e277e580f03a5ec6a1327531af6bbce2bf'
const hash = (body) => createHash('sha256').update(body).digest('hex')
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const bag = (items) => items.map((item) => JSON.stringify(item)).sort()
const tag = (headers = {}) => Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-r3-positive-control')?.[1] ?? null
const artifact = (url) => /^\/(data|tournament-data)\//.test(new URL(url).pathname)
const attemptKey = (a) => [a.event.window, a.url, a.method, tag(a.headers)]

export function compareUnit(raw, index) {
  const blocked = []
  const gate = (condition, message) => { if (!condition) blocked.push(message) }
  const events = raw.events
  const server = raw.server
  const u = raw.unit
  const one = (source, kind) => {
    const found = events.filter((e) => e.source === source && e.kind === kind)
    gate(found.length === 1, `exactly one ${source}/${kind}`)
    return found[0]
  }
  const start = one('driver', 'start')
  gate(equal(start?.instrumentSources, u.instrumentSources) && equal(start?.instrumentSources, raw.end.instrumentSources) && ['abab-driver.mjs', 'locked-abab.sh', 'compare-abab.mjs', 'input-manifest.json', 'dependency-state-pins.json'].every((key) => /^[a-f0-9]{64}$/.test(start?.instrumentSources?.[key] ?? '')), 'instrument source before/after identities')
  const end = one('driver', 'end')
  const loaded = one('driver', 'loaded-boundary')
  const closed = one('driver', 'context-closed')
  const ready = one('driver', 'listeners-ready')
  const child = one('driver', 'host-close')
  const host = one('driver', 'host-identity')
  const browser = one('driver', 'browser-identity')
  const runtime = one('driver', 'runtime-cap')
  const capValid = (receipt, pid, script) => receipt?.pid === pid && Number.isInteger(pid) && receipt.nodeOptions === '--max-old-space-size=1536' && receipt.workspaceOverride === null && Array.isArray(receipt.argv) && receipt.argv.indexOf(script) > 0 && !receipt.argv.slice(1, receipt.argv.indexOf(script)).some((arg) => /^--(?:max[-_]old[-_]space[-_]size|huge[-_]max[-_]old[-_]generation[-_]size)/.test(arg))
  gate(capValid(runtime?.driver, u.driverPid, fileURLToPath(new URL('./abab-driver.mjs', import.meta.url))) && capValid(runtime?.host, host?.pid, '/home/codex/.local/state/pstack/mistake-prevention-20261015/max-update/r3-live-server-ledger-fix-v4/fixture-host.mjs') && runtime.seq > host?.seq && runtime.seq < browser?.seq && Array.isArray(runtime?.driver?.execArgv) && runtime.driver.execArgv.every((arg) => typeof arg === 'string' && !/^--(?:max[-_]old[-_]space[-_]size|huge[-_]max[-_]old[-_]generation[-_]size)/.test(arg)) && Number.isSafeInteger(runtime?.driver?.heapSizeLimitBytes) && runtime.driver.heapSizeLimitBytes > 0, 'raw driver/actual host 1536 MiB cap before browser and workspace override unset')
  gate(equal(raw.dependencies?.before, dependencyPins.expected[u.side]) && equal(raw.dependencies?.before, raw.dependencies?.after), 'seven pinned root-relative dependency-state hashes unchanged per unit')
  const env = one('driver', 'environment')
  const control = one('driver', 'control-start')
  const controlResult = one('driver', 'control-result')
  gate(events.at(-1) === end && raw.end.eventsSha256 === raw.eventsSha256 && raw.end.ledgerError === null && u.ledgerError === null, 'complete last end and intact event ledger')
  gate(raw.outer?.code === 0 && raw.outer.signal === null && raw.outer.spawnError === null && Number.isInteger(raw.outer.childPid), 'actual observed outer close code/signal/spawn error')
  gate(child?.code === 0 && child.signal === null && child.spawnError === null && Number.isInteger(child.childPid), 'actual observed host child close code/signal/spawn error')
  gate(equal(u.childExit, child && { code: child.code, signal: child.signal, spawnError: child.spawnError, childPid: child.childPid }), 'host child close matches metadata')
  gate(Array.isArray(u.cleanupErrors) && u.cleanupErrors.length === 0, 'cleanup errors absent')
  gate(u.orderIndex === index + 1 && u.side === (index % 2 ? 'head' : 'baseline') && u.unit === `requests-${index + 1}-${u.side}` && u.expectedHead === heads[index % 2] && u.expectedTree === trees[index % 2], 'exact ABAB unit identity')
  gate(u.hostSha256 === hostSha && host?.variant === 'request65' && host.root === u.root && host.head === u.expectedHead && host.tree === u.expectedTree && Number.isInteger(host.pid) && Number.isInteger(host.port) && host.base === `http://127.0.0.1:${host.port}` && host.controlPath === join(u.out, 'session/control.jsonl'), 'actual immutable host runtime identity')
  gate(equal(raw.hostIdentity, host && Object.fromEntries(Object.entries(host).filter(([key]) => !['seq', 'hr', 'wall', 'window', 'source', 'kind'].includes(key)))), 'raw saved host identity agreement')
  gate(host?.configFile === join(u.root, 'vite.config.ts') && host?.cacheDir === join(u.root, 'node_modules/.vite'), 'own runtime configuration/cache')
  gate(browser?.version === '153.0.8010.12' && u.browserVersion === browser.version && browser.playwrightCore === '1.63.0' && u.playwrightCore === '1.63.0' && browser.catalog?.revision === '1243' && browser.catalog?.name === 'chromium-headless-shell' && browser.executable?.includes('chromium_headless_shell-1243/') && /^[a-f0-9]{64}$/.test(browser.executableSha256 ?? '') && Number.isInteger(browser.browserPid) && equal(browser.launch, { headless: true }) && equal(u.launch, browser.launch), 'actual pinned installed headless shell, no fallback')
  gate(equal(u.viewport, { width: 1280, height: 900 }) && equal(u.cachePolicy, { route: false, setCacheDisabled: false, serviceWorkersOption: 'default', controlFetchCacheOption: 'default' }) && equal(u.config, { quietMs: 3000, actionSettleMs: 3000, defaultTimeoutMs: 30000, retries: 0, warmup: false, variant: 'request65' }), 'exact action/cache/default-timeout configuration')
  gate(equal(env?.forbiddenEnv, []) && equal(env?.envFiles, []), 'forbidden environment and dotenv absent')
  gate(equal(ready?.workers, []) && equal(ready?.serviceWorkers, []) && ready?.frames?.length === 1 && events.filter((e) => e.source === 'ctx' && e.kind === 'page').length === 1, 'single page/frame with no existing workers')
  let activeWindow = 'setup', openWindow = false, windowCursor = 0
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e.kind === 'window-open') {
      gate(!openWindow && e.window === windows[windowCursor++], `window transition ${e.window}`)
      activeWindow = e.window; openWindow = true
    }
    gate(e.window === activeWindow, `raw event window attribution ${e.seq}`)
    if (e.kind === 'window-close') { gate(openWindow, `closing open window ${e.window}`); openWindow = false }
    gate(e.seq === i + 1 && /^\d+$/.test(e.hr) && Number.isFinite(Date.parse(e.wall)) && (i === 0 || BigInt(e.hr) >= BigInt(events[i - 1].hr)), `event append-only sequence/clock ${i + 1}`)
    if (['worker', 'serviceworker', 'frameattached', 'crash', 'pageerror', 'weberror', 'error', 'cleanup-error', 'host-spawn-error', 'forced-termination'].includes(e.kind) || (e.kind === 'console' && e.type === 'error')) gate(false, `runtime coverage/error ${e.source}/${e.kind} seq ${e.seq}`)
    if (loaded && e.seq > loaded.seq && (e.kind === 'domcontentloaded' || e.kind === 'load' || (e.kind === 'framenavigated' && (!e.main || !equal(new URL(e.url).pathname, '/'))))) gate(false, `postboundary reload/navigation ${e.kind}`)
  }
  for (let i = 0; i < server.length; i++) gate(server[i].sequence === i + 1 && /^\d+$/.test(server[i].monotonicNs) && (i === 0 || BigInt(server[i].monotonicNs) >= BigInt(server[i - 1].monotonicNs)), `server append-only sequence/clock ${i + 1}`)
  gate(server.at(-1)?.kind === 'process-exit-event' && server.at(-1).code === 0, 'host ledger final process exit')
  gate(server.filter((e) => e.kind === 'own-server-closed' && e.listening === false).length === 1 && server.filter((e) => e.kind === 'stop-requested' && e.reason === 'own-control-file').length === 1, 'own host control stop and closed server')
  gate(!server.some((e) => /error/.test(e.kind)), 'no host raw errors')
  gate(events.filter((e) => e.kind === 'browser-closed' && e.connected === false).length === 1 && events.filter((e) => e.kind === 'host-stop-requested').length === 1 && closed?.seq < child?.seq, 'context/browser/host cleanup observed')
  for (const [prefix, expectedRoot, expectedHead, expectedTree] of [['source', u.root, heads[index % 2], trees[index % 2]], ['fixture-source', fixtureRoot, heads[1], trees[1]]]) {
    const before = raw.identities[`${prefix}-before`]
    const after = raw.identities[`${prefix}-after`]
    const hostBefore = raw.identities[`host-${prefix}-before`]
    const hostAfter = raw.identities[`host-${prefix}-after`]
    gate(equal(before, after) && equal(before, hostBefore) && equal(before, hostAfter) && before?.root === expectedRoot && before.head === expectedHead && before.tree === expectedTree && before.installedLockSha256 === lock && Object.keys(before.sources ?? {}).length > 0 && Object.values(before.sources ?? {}).every((s) => /^[a-f0-9]{64}$/.test(s.sha256) && /^[a-f0-9]{40}$/.test(s.gitBlob)) && before.sources?.['pnpm-lock.yaml']?.sha256 === lock, `exact runtime/host ${prefix} before/after identity`)
  }
  gate(equal(raw.caches.loaded, raw.caches.after) && equal(raw.caches.loaded, { path: raw.hostCacheAfter.path, exists: raw.hostCacheAfter.exists, sha256: raw.hostCacheAfter.sha256 }) && raw.caches.before?.path === join(u.root, 'node_modules/.vite/deps/_metadata.json'), 'optimizer recorded before launch and stable loaded-boundary to after')
  gate(raw.bootstrapCache?.cacheControl === 'no-store' && raw.bootstrapCache.etag === false && raw.bootstrapCache.productionEquivalent === false, 'disclosed fixture bootstrap policy')
  gate(raw.fixture.matches?.length === 65 && Object.keys(raw.fixture.teams ?? {}).length === 5 && raw.fixture.label === 'SYNTHETIC seeded-sample', 'actual saved request65 fixture body')
  gate(raw.hostInvocation.variant === 'request65' && raw.hostInvocation.pid === host?.pid && raw.hostTiming.ownBudgetMs === 780000 && Number.isFinite(Date.parse(raw.hostTiming.actualStopAt)) && raw.hostTiming.stopRequestedAt !== null, 'host invocation and final budget/cleanup timing')
  const openings = events.filter((e) => e.kind === 'window-open')
  const closings = events.filter((e) => e.kind === 'window-close')
  gate(equal(openings.map((e) => e.window), windows) && equal(closings.map((e) => e.window), windows), 'complete ordered action/control/teardown windows')
  for (const name of windows) {
    const open = openings.find((e) => e.window === name)
    const close = closings.find((e) => e.window === name)
    gate(open && close && open.seq < close.seq, `window boundaries ${name}`)
    if (!['load', 'teardown'].includes(name)) {
      const bars = events.filter((e) => e.window === name && e.kind === 'barrier')
      gate(bars.length === 1 && bars[0].seq < close?.seq && Number.isFinite(bars[0].pagePerfNow) && Number.isFinite(bars[0].cdpPerfNow) && /^\d+$/.test(bars[0].hrBefore) && BigInt(bars[0].hrAfter) >= BigInt(bars[0].hrBefore) && bars[0].dom && typeof bars[0].dom.hash === 'string' && typeof bars[0].dom.query === 'string' && Array.isArray(bars[0].dom.rowTitles) && bars[0].dom.ariaSort, `two-session barrier and DOM facts ${name}`)
      if (name !== 'control') {
        const post = events.filter((e) => e.window === name && e.kind === 'postcondition-met')
        const action = events.filter((e) => e.window === name && e.kind === 'action-start')
        gate(post.length === 1 && action.length === 1 && action[0].seq > open?.seq && action[0].seq < post[0].seq && bars.length === 1 && BigInt(bars[0].hrBefore) - BigInt(post[0].hr) >= 3_000_000_000n, `original action postcondition and 3000ms settle ${name}`)
      }
    }
  }
  gate(events.filter((e) => e.kind === 'filters-button' && typeof e.visible === 'boolean' && e.window === 'a09b-filters-open').length === 1, 'incidental Filters click visibility retained inside measured window')
  const boundaryDOM = new Map(events.filter((e) => e.kind === 'barrier').map((e) => [e.window, e.dom]))
  for (const [name, dom] of boundaryDOM) gate(raw.domHashes[name] === dom?.tableSha256 && /^[a-f0-9]{64}$/.test(dom?.tableSha256 ?? ''), `retained raw boundary table bytes ${name}`)
  const domAt = (name) => boundaryDOM.get(name)
  const queryAt = (name) => new URLSearchParams(domAt(name)?.query ?? '')
  gate(domAt('load')?.rowTitles?.length === 4 && domAt('load')?.ariaSort?.Power === 'none' && domAt('a01-sort-power')?.ariaSort?.Power === 'descending' && domAt('a02-sort-record')?.ariaSort?.Record === 'descending' && domAt('a03-sort-rank')?.ariaSort?.Rank === 'ascending', 'raw loaded rows and original sort postconditions')
  gate(queryAt('a04-tier-s').get('tier') === 'S' && !queryAt('a05-tier-all').has('tier') && queryAt('a06-region-lck').get('region') === 'LCK' && !queryAt('a07-region-all').has('region'), 'raw original tier/region query postconditions')
  for (const [name, count] of [['a08-search-alp', 1], ['a09-search-clear', 4], ['a10-include-unranked', 5], ['a11-ranked-only', 4]]) gate(domAt(name)?.rowTitles?.length === count, `raw original row postcondition ${name}`)
  const initial = one('driver', 'initial-four-rows')
  const idle = one('driver', 'first-networkidle')
  const quiet = one('driver', 'load-quiet')
  const loadBarrier = events.filter((e) => e.kind === 'barrier' && e.window === 'load')
  gate(initial?.rows === 4 && initial.seq < idle?.seq && idle?.seq < quiet?.seq && equal(quiet?.inflight, []) && /^\d+$/.test(quiet?.lastArtifactHr ?? '') && BigInt(quiet.hr) - BigInt(quiet.lastArtifactHr) >= 3_000_000_000n && BigInt(quiet.hr) - BigInt(idle.hr) <= 30_000_000_000n && loadBarrier.length === 1 && quiet.seq < loadBarrier[0].seq && loadBarrier[0].seq < loaded?.seq && loaded?.seq < closed?.seq, 'actual initial four rows, first idle, bounded quiet and both session barriers')
  const pw = [], cdp = []
  const pwById = new Map(), cdpById = new Map()
  for (const e of events) {
    if (e.source === 'pw') {
      if (e.kind === 'request') {
        gate(!pwById.has(e.pwId), `unique PW attempt ${e.pwId}`)
        const a = { event: e, url: e.url, method: e.method, headers: e.headers, response: null, terminal: null }
        pw.push(a); pwById.set(e.pwId, a)
      } else if (['response', 'requestfinished', 'requestfailed'].includes(e.kind)) {
        const a = pwById.get(e.pwId)
        gate(!!a, `PW event has request ${e.pwId}`)
        if (!a) continue
        if (e.kind === 'response') { gate(!a.response, `single PW response ${e.pwId}`); a.response = e }
        else { gate(!a.terminal, `single PW terminal ${e.pwId}`); a.terminal = e }
      }
    }
    if (e.source === 'cdp') {
      const r = e.raw
      if (e.kind === 'requestWillBeSent') {
        const prev = cdpById.get(r.requestId)
        if (r.redirectResponse) {
          gate(prev && !prev.terminal, `CDP redirect has predecessor ${r.requestId}`)
          if (prev) { prev.cached ||= r.redirectResponse.fromDiskCache === true || r.redirectResponse.fromPrefetchCache === true; prev.response = { status: r.redirectResponse.status, raw: { response: r.redirectResponse } }; prev.terminal = e }
        } else gate(!prev, `CDP id reused without redirect ${r.requestId}`)
        const a = { event: e, url: r.request.url, method: r.request.method, headers: r.request.headers, response: null, terminal: null, cached: false, hop: prev ? prev.hop + 1 : 0 }
        cdp.push(a); cdpById.set(r.requestId, a)
      } else if (['requestServedFromCache', 'responseReceived', 'loadingFinished', 'loadingFailed'].includes(e.kind)) {
        const a = cdpById.get(r.requestId)
        gate(!!a, `CDP event has request ${r.requestId}`)
        if (!a) continue
        if (e.kind === 'requestServedFromCache') a.cached = true
        if (e.kind === 'responseReceived') { gate(!a.response, `single CDP response ${r.requestId}`); a.response = { ...e, status: r.response.status }; a.cached ||= r.response.fromDiskCache === true || r.response.fromPrefetchCache === true }
        if (e.kind === 'loadingFinished' || e.kind === 'loadingFailed') { gate(!a.terminal, `single CDP terminal ${r.requestId}`); a.terminal = e }
      }
    }
    if ((e.source === 'pw' && e.kind === 'requestfailed') || (e.source === 'cdp' && e.kind === 'loadingFailed')) gate(false, `all-URL request failure ${e.source} seq ${e.seq}`)
    if ((e.source === 'pw' && e.kind === 'response' && e.status >= 400) || (e.source === 'cdp' && e.kind === 'responseReceived' && e.raw.response.status >= 400)) gate(false, `all-URL HTTP failure ${e.source} seq ${e.seq}`)
  }
  for (const a of [...pw, ...cdp]) {
    const url = new URL(a.url)
    if (['http:', 'https:'].includes(url.protocol)) gate(url.origin === host?.base, `non-fixture request ${a.url}`)
    if (artifact(a.url)) {
      gate(a.event.seq < closed?.seq, `no late artifact event after context closed ${a.url}`)
      gate(a.event.seq > ready?.seq, `artifact observed only after listeners ${a.url}`)
      const boundary = closings.find((e) => e.window === a.event.window)
      gate(a.terminal && a.terminal.seq <= boundary?.seq, `terminal before window close ${a.url}`)
      gate(a.response && (a.response.status >= 200 && a.response.status < 400), `artifact successful response ${a.url}`)
      if (a.event.seq < loaded?.seq) gate(a.response && a.response.status >= 200 && a.response.status < 300, `load artifact 2xx ${a.url}`)
      if (a.event.source === 'pw') gate(!a.event.serviceWorker && !a.response?.fromServiceWorker, 'no PW service worker response')
      else gate(!a.response?.raw?.response?.fromServiceWorker, 'no CDP service worker response')
    }
  }
  const pa = pw.filter((a) => artifact(a.url)), ca = cdp.filter((a) => artifact(a.url))
  const loadAttempts = [...pa, ...ca].filter((a) => a.event.seq < (loaded?.seq ?? -Infinity))
  const lastRawLoadHr = loadAttempts.reduce((last, a) => BigInt(a.event.hr) > last ? BigInt(a.event.hr) : last, 0n)
  gate(loadAttempts.length > 0 && loadAttempts.every((a) => a.terminal && a.terminal.seq < loaded?.seq) && loadBarrier.length === 1 && BigInt(loadBarrier[0].hrBefore) - lastRawLoadHr >= 3_000_000_000n, 'raw load boundary has no artifact inflight and 3000ms since the last actual request event')
  gate(equal(bag(pa.map(attemptKey)), bag(ca.map(attemptKey))), 'PW/CDP artifact attempt multisets with queries, hops, windows and tags')
  gate(pa.some((a) => a.event.window === 'load') && ca.some((a) => a.event.window === 'load'), 'both observers see real initial artifact load')
  const arrivals = server.filter((e) => e.kind === 'server-arrival')
  gate(arrivals.length > 0 && arrivals.some((e) => loaded && BigInt(e.monotonicNs) < BigInt(loaded.hr)), 'real initial load reached server')
  const available = ca.filter((a) => !a.cached).slice()
  for (const arrival of arrivals) {
    const full = new URL(arrival.url, host.base).href
    const matched = available.findIndex((a) => a.url === full && a.method === arrival.method && tag(a.headers) === tag(Object.fromEntries(Array.from({ length: (arrival.rawHeaders?.length ?? 0) / 2 }, (_, i) => [arrival.rawHeaders[i * 2], arrival.rawHeaders[i * 2 + 1]]))))
    gate(matched >= 0, `server arrival covered by one noncached CDP attempt ${arrival.id} ${full}`)
    if (matched >= 0) available.splice(matched, 1)
    const finishes = server.filter((e) => e.kind === 'server-finish' && e.id === arrival.id)
    gate(finishes.length === 1 && finishes[0].status >= 200 && finishes[0].status < 300, `server arrival completed 2xx ${arrival.id}`)
    if (finishes.length === 1) gate(raw.httpHashes[finishes[0].rawPath] === finishes[0].rawSha256, `actual retained HTTP response bytes ${arrival.id}`)
  }
  gate(available.length === 0, 'each noncached CDP artifact attempt has a server arrival')
  const pc = pa.filter((a) => tag(a.headers) === control?.controlId)
  const cc = ca.filter((a) => tag(a.headers) === control?.controlId)
  gate(typeof control?.controlId === 'string' && control.controlId.length > 0 && control.header === 'X-R3-Positive-Control' && control.window === 'control' && control.seq > loaded?.seq && controlResult?.controlId === control.controlId && controlResult?.url === control.url && controlResult?.status === 200, 'unique explicit direct-fetch control identity/result')
  gate(pc.length === 1 && cc.length === 1 && pc[0].url === control?.url && cc[0].url === control?.url && pc[0].event.window === 'control' && cc[0].event.window === 'control' && pc[0].event.seq > control?.seq && cc[0].event.seq > control?.seq && pc[0].response?.status === 200 && cc[0].response?.status === 200 && cc[0].cached && pc[0].terminal?.seq < closed?.seq && cc[0].terminal?.seq < closed?.seq, 'cached-attempt sensitivity unproved; require PW1/CDP1/200/cache')
  gate(pa.some((a) => a.event.window === 'load' && a.url === control?.url && a.response?.status === 200 && a.terminal) && /^\/data\/objects\/sha256\/[a-f0-9]{64}$/.test(new URL(control?.url ?? 'http://invalid/').pathname), 'control reuses actually loaded immutable object')
  gate(!arrivals.some((e) => (BigInt(e.monotonicNs) >= BigInt(control?.hr ?? '0') && BigInt(e.monotonicNs) <= BigInt(controlResult?.hr ?? '0') && new URL(e.url, host.base).href === control?.url) || tag(Object.fromEntries(Array.from({ length: (e.rawHeaders?.length ?? 0) / 2 }, (_, i) => [e.rawHeaders[i * 2], e.rawHeaders[i * 2 + 1]]))) === control?.controlId), 'tagged cached control has zero server arrivals')
  const measured = (attempts, excluded) => attempts.filter((a) => a.event.seq > (loaded?.seq ?? Infinity) && a.event.seq < (closed?.seq ?? -Infinity) && !(excluded.length === 1 && a === excluded[0]))
  const mp = measured(pa, pc), mc = measured(ca, cc)
  const describe = (a) => {
    const path = new URL(a.url).pathname
    const object = raw.objects.find((item) => item.path === path)
    const logical = raw.mapping.find((item) => item.logicalPath === path)
    return { window: a.event.window, seq: a.event.seq, url: a.url, method: a.method, roles: object?.references ?? (logical ? [{ logicalPath: path, role: 'logical' }] : [{ logicalPath: path, role: path === '/data/ranking-summary.json' ? 'bootstrap' : 'unmapped artifact' }]), terminal: a.terminal?.kind ?? null }
  }
  return { label: raw.synthetic ? 'SYNTHETIC NATIVE COMPARATOR CONTROL. Not an actual ABAB unit.' : u.label, path: raw.path, side: u.side, started: raw.outer?.started, ended: raw.outer?.ended, verdict: blocked.length ? 'BLOCKED' : mp.length || mc.length ? 'FAIL' : 'PASS', blocked, measuredPW: mp.map(describe), measuredCDP: mc.map(describe), loadMultiset: bag(pa.filter((a) => a.event.window === 'load').map((a) => [new URL(a.url).pathname + new URL(a.url).search, a.method])), cross: { hashes: raw.crossHashes, browser: browser && [browser.version, browser.executableSha256], config: [u.viewport, u.cachePolicy, u.config, u.launch], sourcesLock: raw.identities['source-before']?.installedLockSha256, fixtureLock: raw.identities['fixture-source-before']?.installedLockSha256, ownSources: start?.instrumentSources, lockChain: raw.invocation.command }, identities: { root: u.root, out: u.out, commonDir: raw.identities['source-before']?.commonDir }, boundaryDOM: events.filter((e) => e.kind === 'barrier').map((e) => ({ window: e.window, dom: e.dom })) }
}

export function compareFour(rawUnits) {
  const units = rawUnits.map((raw, index) => compareUnit(raw, index))
  const blocked = []
  const gate = (condition, message) => { if (!condition) blocked.push(message) }
  gate(units.length === 4, 'exactly four units')
  gate(new Set(units.map((u) => u.path)).size === 4 && new Set(units.map((u) => u.identities.out)).size === 4, 'distinct actual output directories')
  for (let i = 1; i < units.length; i++) {
    gate(Date.parse(units[i].started) > Date.parse(units[i - 1].ended), 'observed nonoverlapping ABAB execution order')
    for (const key of ['hashes', 'browser', 'config', 'sourcesLock', 'fixtureLock', 'ownSources']) gate(equal(units[0].cross[key], units[i].cross[key]), `cross-unit ${key} equality`)
    gate(units[i].identities.commonDir === units[0].identities.commonDir, 'same common Git heavy lock')
  }
  const initialLoadComparisons = [['baseline', 0, 2], ['head', 1, 3]].map(([side, first, later]) => ({ side, first: units[first]?.loadMultiset, later: units[later]?.loadMultiset, equal: equal(units[first]?.loadMultiset, units[later]?.loadMultiset) }))
  for (const [i, raw] of rawUnits.entries()) {
    const cmd = raw.invocation.command
    gate(Array.isArray(cmd) && cmd.length === 21 && cmd[0] === '/home/codex/.local/bin/heavy-check' && cmd[1] === '--repo' && cmd[2] === raw.unit.root && equal(cmd.slice(3, 13), ['--timeout', '15m', '--lock-timeout', '0', '--', 'flock', '-n', '-E', '76', '/home/codex/.local/state/pstack/mistake-prevention-20261015/browser.lock']) && cmd[13] === 'bash' && cmd[14] === fileURLToPath(new URL('./locked-abab.sh', import.meta.url)) && equal(cmd.slice(15), [raw.unit.root, heads[i % 2], trees[i % 2], raw.unit.out, raw.unit.unit, String(i + 1)]), 'exact shared heavy/browser lock and unchanged bound/argv')
  }
  return { label: rawUnits.some((u) => u.synthetic) ? 'SYNTHETIC NATIVE COMPARATOR CONTROLS. NOT an ABAB measurement.' : 'SYNTHETIC seeded-sample. Additional browser artifact REQUEST ATTEMPTS on the loaded board. No speed claim.', verdict: blocked.length || units.some((u) => u.verdict === 'BLOCKED') ? 'BLOCKED' : units.some((u) => u.verdict === 'FAIL') ? 'FAIL' : 'PASS', blocked, initialLoadComparisons, units }
}

export function readUnit(path) {
  const body = (name) => readFileSync(join(path, name))
  const json = (name) => JSON.parse(body(name))
  const lines = (name) => {
    const text = body(name).toString('utf8')
    if (!text.endsWith('\n')) throw new Error(`incomplete raw log ${name}`)
    return text.trimEnd().split('\n').map(JSON.parse)
  }
  const identities = {}
  for (const prefix of ['source', 'fixture-source']) for (const when of ['before', 'after']) {
    identities[`${prefix}-${when}`] = json(`driver/${prefix}-${when}.json`)
    identities[`host-${prefix}-${when}`] = json(`session/${prefix}-${when}.json`)
  }
  const crossNames = ['fixture-input.json', 'generation-manifest.json', 'object-inventory.json', 'logical-mapping.json', 'bootstrap-body.json']
  const server = lines('session/server-ledger.jsonl')
  const domHashes = Object.fromEntries(lines('driver/events.jsonl').filter((e) => e.kind === 'barrier').map((e) => {
    if (!windows.includes(e.window) || ['teardown'].includes(e.window)) throw new Error('invalid DOM receipt window')
    return [e.window, hash(body(`driver/${e.window}-table.html`))]
  }))
  const httpHashes = {}
  for (const event of server.filter((e) => e.kind === 'server-finish')) {
    if (!/^http\/\d+\.response\.http$/.test(event.rawPath)) throw new Error('unsafe raw HTTP receipt path')
    httpHashes[event.rawPath] = hash(body(`session/${event.rawPath}`))
  }
  return { synthetic: json('driver/unit.json').label?.includes('NATIVE COMPARATOR CONTROL') === true, path: resolve(path), events: lines('driver/events.jsonl'), eventsSha256: hash(body('driver/events.jsonl')), server, unit: json('driver/unit.json'), end: json('driver/end.json'), outer: json('observed-exit.json'), invocation: json('invocation.json'), identities, dependencies: { before: json('driver/dependency-state-before.json'), after: json('driver/dependency-state-after.json') }, caches: { before: json('driver/cache-before-launch.json'), loaded: json('driver/cache-loaded-boundary.json'), after: json('driver/cache-after.json') }, hostCacheAfter: json('session/cache-after.json'), hostIdentity: json('session/server-identity.json'), hostInvocation: json('session/invocation.json'), hostTiming: json('session/host-timing.json'), bootstrapCache: json('session/bootstrap-cache-identity.json'), fixture: json('session/fixture-input.json'), objects: json('session/object-inventory.json'), mapping: json('session/logical-mapping.json'), httpHashes, domHashes, crossHashes: Object.fromEntries(crossNames.map((name) => [name, hash(body(`session/${name}`))])) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [output, ...paths] = process.argv.slice(2)
  if (!output || paths.length !== 4) throw new Error('usage: new-report baseline1 head1 baseline2 head2')
  let result
  try { result = compareFour(paths.map(readUnit)) }
  catch (error) { result = { verdict: 'BLOCKED', blocked: [`missing or malformed raw evidence: ${String(error)}`], paths } }
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  console.log(JSON.stringify(result))
  process.exitCode = result.verdict === 'PASS' ? 0 : result.verdict === 'FAIL' ? 1 : 2
}
