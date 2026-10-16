import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getHeapStatistics } from 'node:v8'
import { sourceIdentity } from './source-identity.mjs'
import { inspector, runtimeRoot, validateAdmission, requireColdHistory, auditPhases, assertOwnedTemp, dependencyState, tempInventory, storeWriters, auditInputBoundaries } from './source-guards.mjs'

const startedNs = process.hrtime.bigint()
const deadline = Date.now() + 13 * 60_000
const prep = dirname(fileURLToPath(import.meta.url))
const [root, out, releasePath] = process.argv.slice(2)
const head = 'd38add5f228e67022a3001e27a820ad76657f37f'
const tree = '10c19882806045f340674c6627b4715929ee020e'
assert.equal(process.argv.length, 5, 'root new-output release-json')
assert.ok([root, out, releasePath].every(isAbsolute))
assert.equal(process.cwd(), root)
assert.equal(realpathSync(root), root)
assert.equal(root, runtimeRoot)
assert.equal(realpathSync(dirname(out)), dirname(out))
assert.ok(!existsSync(out) && !out.startsWith(`${root}/`) && !out.startsWith(`${prep}/`))
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const release = json(releasePath)
assert.equal(release.packageInventorySha256, sha(readFileSync(join(prep, 'inventory-sha256.txt'))))
assert.equal(release.root, root)
assert.equal(release.output, out)
assert.equal(release.head, head)
assert.equal(release.tree, tree)
assert.equal(release.unit, 'lanes78-companion-head-address91')
assert.equal(release.fullIndependentSourceReview, 'APPROVED')
assert.equal(release.rootCountersign, 'APPROVED')
assert.equal(release.runtimeAllocation, 'RELEASED_ONCE')
assert.equal(release.sharedStoreOwnerCheck, 'ROOT_VERIFIED_NO_CONCURRENT_STORE_WRITER')
assert.ok(Date.parse(release.expiresAt) > Date.now())
for (const key of ['review', 'countersign', 'nativeAdmission']) {
  assert.ok(isAbsolute(release[key].path))
  assert.equal(sha(readFileSync(release[key].path)), release[key].sha256)
}
assert.deepEqual(release.nativeAdmission.inspector, inspector)
assert.equal(sha(readFileSync(inspector.path)), inspector.sha256)
assert.ok(isAbsolute(release.nativeAdmission.directory))
assert.equal(release.nativeAdmission.path, join(release.nativeAdmission.directory, 'before-native.json'))
assert.equal(realpathSync(release.nativeAdmission.directory), release.nativeAdmission.directory)
const nativeExit = json(release.nativeAdmission.exitReceipt.path)
assert.equal(sha(readFileSync(release.nativeAdmission.exitReceipt.path)), release.nativeAdmission.exitReceipt.sha256)
assert.equal(nativeExit.exitCode, 0, 'actual numeric canonical before exit required')
assert.equal(nativeExit.signal, null)
assert.equal(nativeExit.spawnError, null)
assert.deepEqual(nativeExit.inspector, inspector)
assert.deepEqual(nativeExit.command, ['python3', inspector.path, release.nativeAdmission.directory, 'before'])
const commonDir = realpathSync(execFileSync('git', ['--no-optional-locks', '-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim())
const heavyLock = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`, 'codex-heavy-check', `${sha(commonDir)}.lock`)
assert.equal(release.heavyLock, heavyLock)
const admission = json(release.nativeAdmission.path)
const admissionState = validateAdmission(admission, { now: Date.now(), head, tree, heavyLock: release.heavyLock, browserLock: '/home/codex/.local/state/pstack/mistake-prevention-20261015/browser.lock' })
const writerAdmission = storeWriters([admission.processSnapshotBefore, admission.processSnapshotAfter])
const ownedTemp = assertOwnedTemp(out, process.env, process.getuid())
assert.equal(tmpdir(), ownedTemp.path)
assert.equal(process.env.TMP, ownedTemp.path)
assert.equal(process.env.TEMP, ownedTemp.path)
assert.equal(process.env.NODE_DISABLE_COMPILE_CACHE, '1')
assert.equal(process.env.NODE_COMPILE_CACHE, join(ownedTemp.path, 'node-compile'))
assert.match(process.version, /^v24\./)
assert.equal(process.env.NODE_OPTIONS, '--max-old-space-size=1536')
assert.ok(!process.execArgv.some((arg) => /^--(?:max[-_]old[-_]space[-_]size|huge[-_]max[-_]old[-_]generation[-_]size)/.test(arg)), 'no competing heap argv override')
assert.deepEqual(Object.keys(process.env).filter((key) => /^npm_config_workspace_dir$/i.test(key)), [])
assert.deepEqual(Object.keys(process.env).filter((key) => key.startsWith('VITE_') || key.startsWith('PLAYWRIGHT_')), [])
assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('.env')), [])
process.env.GIT_OPTIONAL_LOCKS = '0'
mkdirSync(out, { mode: 0o700 })
for (const name of ['objects', 'logical', 'http', 'browser-bodies', 'receipts', 'video']) mkdirSync(join(out, name), { mode: 0o700 })
const save = (name, value) => writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
const raw = (name, value) => writeFileSync(join(out, name), value, { flag: 'wx', mode: 0o600 })
let phase = 'setup', seq = 0, ledgerError = null, fault = null
const emit = (source, kind, value = {}) => {
  try { appendFileSync(join(out, 'events.jsonl'), `${JSON.stringify({ seq: ++seq, hr: String(process.hrtime.bigint()), wall: new Date().toISOString(), phase, source, kind, ...value })}\n`, { mode: 0o600 }); return seq }
  catch (error) { ledgerError ??= String(error); process.exitCode = 1; console.error(error) }
}
const block = (reason) => { fault ??= reason; emit('driver', 'coverage-block', { reason }); process.exitCode = 1 }
const check = () => { assert.ok(!ledgerError && !fault, fault ?? ledgerError); assert.ok(Date.now() < deadline, 'own deadline'); }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const artifact = (url) => { try { return /^\/(data|tournament-data)\//.test(new URL(url).pathname) } catch { return false } }
const pins = json(join(prep, 'head-dependency-pins.json')).expected
const toolPins = json(join(prep, 'runtime-tool-pins.json')).expected
const toolState = () => Object.fromEntries(Object.keys(toolPins).map((path) => [path, sha(readFileSync(join(root, path)))]))
const instrumentState = () => {
  const files = {}
  const walk = (dir) => { for (const name of readdirSync(dir).sort()) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else files[path.slice(prep.length + 1)] = sha(readFileSync(path)) } }
  walk(prep)
  return files
}
const deps = () => Object.fromEntries(Object.keys(pins).map((path) => [path, sha(readFileSync(join(root, path)))]))
const cache = () => {
  const path = join(root, 'node_modules/.vite')
  const files = []
  const walk = (dir) => { for (const name of readdirSync(dir).sort()) { const file = join(dir, name); if (realpathSync(file) !== file) throw new Error(`optimizer symlink ${file}`); if (statSync(file).isDirectory()) walk(file); else files.push({ path: file, sha256: sha(readFileSync(file)) }) } }
  if (existsSync(path)) walk(path)
  return { path, exists: existsSync(path), files, warmth: 'Not inferred from optimizer files.' }
}
function resources() {
  const memory = readFileSync('/proc/meminfo', 'utf8')
  const pressure = readFileSync('/proc/pressure/memory', 'utf8')
  const availableMiB = Number(/^MemAvailable:\s+(\d+)/m.exec(memory)?.[1]) / 1024
  const fullAvg60 = Number(/^full .*?avg60=([\d.]+)/m.exec(pressure)?.[1])
  const fs = statfsSync(out)
  const availableBytes = fs.bavail * fs.bsize
  emit('native', 'resources', { availableMiB, fullAvg60, availableBytes })
  assert.ok(availableMiB >= 1536 && fullAvg60 <= 5 && availableBytes >= 4 * 1024 ** 3, 'resource gate')
}
let server, browser, context, page, cdp, browserCdp, resourceTimer, base, plan, manifest, ownedPageTargetId
const cleanup = []
const objects = new Map(), logical = new Map(), references = new Map()
const phasePlans = new Map()
const forbiddenPaths = new Set(), observedBodies = new Map()
let lane7HistoryStarted = false, playersStarted = false, firstDocumentLoader = null, mainNavigationRequests = 0
const ownedProcesses = new Map()
let dependencyBefore, optimizerBefore
const pixelPredicates = [], inputBoundaries = {}
const serverRecords = []
const records = [], inflight = new Set(), completeObjects = new Set(), bodyJobs = new Set()
let lastArtifact = process.hrtime.bigint(), pwSeq = 0, serverSeq = 0, serverId = 0
const pwIds = new WeakMap(), responses = new Map()
const pwId = (request) => { if (!pwIds.has(request)) pwIds.set(request, ++pwSeq); return pwIds.get(request) }
function event(source, kind, value) {
  const row = { phase, source, kind, ...value }
  row.seq = emit(source, kind, value)
  records.push(row)
  if (plan && (source === 'pw' && kind === 'request' || source === 'cdp' && kind === 'requestWillBeSent')) {
    const url = source === 'pw' ? value.url : value.raw.request.url
    if (artifact(url)) {
      try { assertNoPriorDemand('continuous-request-observation') }
      catch (error) { block(String(error)) }
    }
  }
  return row
}
function serverEvent(kind, value) {
  serverRecords.push({ phase, kind, ...value })
  emit('server', kind, { serverSeq: ++serverSeq, ...value })
}
function closure(logicalPath, selected = {}) {
  const rootPath = logical.get(new URL(logicalPath, 'http://fixture.invalid').pathname)?.objectPath
  assert.ok(rootPath, `mapped logical path ${logicalPath}`)
  const paths = new Set()
  function content(path, ancestors = new Set()) {
    assert.ok(!ancestors.has(path), 'archive cycle')
    paths.add(path)
    const envelope = JSON.parse(objects.get(path).toString())
    const value = envelope.content
    if (!['public-artifact-archive', 'public-archive-node'].includes(value.artifactKind)) return
    function visit(node) {
      if (node.kind === 'inline') return
      if (node.kind === 'record') { for (const [, child] of node.entries) visit(child); return }
      assert.ok(['map', 'list'].includes(node.kind), 'known archive tree kind')
      for (const ref of node.parts) {
        const keys = selected[ref.path]
        if (keys && ref.keyStart && !keys.some((key) => key >= ref.keyStart && key <= ref.keyEnd)) continue
        content(`/data/objects/sha256/${ref.sha256}`, new Set([...ancestors, path]))
      }
    }
    visit(value.tree)
  }
  content(rootPath)
  return [...paths].sort()
}
function expectedDemand(kind, ids = []) {
  assert.ok(completeObjects.size <= 128 && [...completeObjects].reduce((n, path) => n + objects.get(path).length, 0) <= 8 * 1024 ** 2, 'cache capacity remains source-provable')
  let required = []
  if (kind === 'history') {
    const indexWrite = logical.get(new URL(plan.manifest.teamHistoryIndexUrl, 'http://fixture.invalid').pathname)
    assert.ok(indexWrite?.value?.scopeIndex?.All__All__All, 'all-scope history mapping')
    required = [...new Set([...closure(plan.manifest.teamHistoryIndexUrl), ...closure(indexWrite.value.scopeIndex.All__All__All.url, { '/series': ids })])].sort()
  } else if (kind === 'players') required = closure(plan.manifest.playerDirectoryUrl ?? '/data/entities/players.json')
  else assert.equal(kind, 'zero')
  return { kind, ids, required, closureMembers: required.map((path) => ({ objectPath: path, url: `${base}${path}`, digest: sha(objects.get(path)), bytes: objects.get(path).length, storage: ['public-artifact-archive', 'public-archive-node'].includes(JSON.parse(objects.get(path)).content.artifactKind) ? 'archive' : 'inline', logicalReferences: references.get(path), rawEmittedBody: `objects/${sha(objects.get(path))}.json` })), semanticCacheBefore: [...completeObjects].sort(), expectedAttemptBag: required.filter((path) => !completeObjects.has(path)).map((path) => `${base}${path}`).sort() }
}
function assertNoPriorDemand(name) {
  const historyPaths = new Set([...logical.values()].filter((entry) => /^team-history/.test(entry.value?.artifactKind ?? '')).flatMap((entry) => closure(entry.logicalPath)))
  const playerPaths = new Set(closure(plan.manifest.playerDirectoryUrl ?? '/data/entities/players.json'))
  const attempts = records.filter((row) => row.source === 'pw' && row.kind === 'request' || row.source === 'cdp' && row.kind === 'requestWillBeSent')
  for (const row of attempts) {
    const path = new URL(row.source === 'pw' ? row.url : row.raw.request.url).pathname
    if (!lane7HistoryStarted) assert.ok(!historyPaths.has(path), `initial history absence ${name} ${row.source} seq ${row.seq}`)
    if (!playersStarted) assert.ok(!playerPaths.has(path), `initial player absence ${name} ${row.source} seq ${row.seq}`)
  }
  emit('driver', 'prior-demand-absence', { name, throughSeq: seq, historyRequired: !lane7HistoryStarted, playersRequired: !playersStarted, observers: ['pw', 'cdp'] })
}
function readObservedLogical(logicalPath, selectedIds) {
  const mapping = logical.get(new URL(logicalPath, 'http://fixture.invalid').pathname)
  const receipts = [], selectedKeySources = [], seen = new Set()
  const content = (path, ancestors = new Set()) => {
    assert.ok(!ancestors.has(path), 'raw browser archive cycle')
    const receipt = observedBodies.get(path)?.find((item) => item.unit === release.unit && item.output === out && item.bodySeq <= seq)
    assert.ok(receipt, `current-unit saved raw browser body required ${path}`)
    const body = readFileSync(join(out, receipt.rawBodyPath))
    assert.equal(sha(body), receipt.sha256)
    assert.equal(path, `/data/objects/sha256/${sha(body)}`)
    assert.ok(Number.isInteger(receipt.requestSeq) && receipt.requestSeq < receipt.responseSeq && receipt.responseSeq < receipt.bodySeq)
    const parsed = JSON.parse(body)
    if (!seen.has(path)) {
      receipts.push(receipt); seen.add(path)
      const walk = (value, pointer = '') => {
        if (!value || typeof value !== 'object') return
        for (const [key, child] of Object.entries(value)) {
          const childPointer = `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`
          if (selectedIds.includes(key) && Array.isArray(child?.points)) selectedKeySources.push({ selectedId: key, jsonPointer: childPointer, objectPath: path, rawBodyPath: receipt.rawBodyPath, bodySha256: receipt.sha256, requestSeq: receipt.requestSeq, responseSeq: receipt.responseSeq, bodySeq: receipt.bodySeq, pointsSha256: sha(JSON.stringify(child.points)) })
          walk(child, childPointer)
        }
      }
      walk(parsed)
    }
    const value = parsed.content
    if (!['public-artifact-archive', 'public-archive-node'].includes(value.artifactKind)) return value
    const visit = (node) => {
      if (node.kind === 'inline') return node.value
      if (node.kind === 'record') return Object.fromEntries(node.entries.map(([key, child]) => [key, visit(child)]))
      assert.ok(['map', 'list'].includes(node.kind))
      const children = node.parts.filter((ref) => !(ref.path === '/series' && ref.keyStart && !selectedIds.some((id) => id >= ref.keyStart && id <= ref.keyEnd))).map((ref) => content(`/data/objects/sha256/${ref.sha256}`, new Set([...ancestors, path])))
      return node.kind === 'list' ? children.flat() : Object.assign({}, ...children)
    }
    return visit(value.tree)
  }
  return { value: content(mapping.objectPath), receipts, selectedKeySources }
}
async function inventory(name) {
  const processes = await browserCdp.send('SystemInfo.getProcessInfo')
  for (const item of processes.processInfo) {
    const path = `/proc/${item.id}/stat`
    if (!existsSync(path)) { block(`browser process vanished during inventory ${item.id}`); continue }
    const stat = readFileSync(path, 'utf8')
    ownedProcesses.set(item.id, { pid: item.id, type: item.type, startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] })
  }
  emit('driver', 'owned-process-inventory', { name, processes: [...ownedProcesses.values()] })
  const targets = await browserCdp.send('Target.getTargets')
  const frames = page.frames().map((frame) => ({ url: frame.url(), main: frame === page.mainFrame() }))
  const workers = page.workers().map((worker) => worker.url())
  const serviceWorkers = context.serviceWorkers().map((worker) => worker.url())
  emit('driver', 'inventory', { name, targets: targets.targetInfos, frames, workers, serviceWorkers, pages: context.pages().map((p) => p.url()) })
  const pageTargets = targets.targetInfos.filter((t) => t.type === 'page')
  if (frames.length !== 1 || workers.length || serviceWorkers.length || context.pages().length !== 1 || pageTargets.length !== 1 || pageTargets[0].targetId !== ownedPageTargetId || targets.targetInfos.some((t) => !['page', 'browser'].includes(t.type))) block('Uncovered worker, frame, or extra target. Page CDP coverage is insufficient.')
  check()
}
async function geometry(name) {
  const value = await page.getByRole('heading', { name: 'Power over time', exact: true, includeHidden: true }).evaluate((heading) => {
    const panel = heading.closest('[data-slot="card"]')
    if (!panel) return null
    return { rect: panel.getBoundingClientRect().toJSON(), viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, scroll: { x: scrollX, y: scrollY }, activeElement: document.activeElement?.outerHTML, trajectoryHasFocus: panel.contains(document.activeElement), pointerCondition: 'No hover or focus on the trajectory is requested by this driver.', pointer: window.__r3Lanes78Pointer ?? null, hash: location.hash }
  })
  emit('driver', 'geometry', { name, value, rootMargin: '420px 0px' })
  assert.equal(value?.trajectoryHasFocus, false, 'trajectory must not have keyboard focus')
  assert.ok(value?.rect.height > 0, 'trajectory rectangle available')
  assert.ok(value.rect.top > value.viewport.height + 420 || value.rect.bottom < -420, 'BLOCKED natural trajectory geometry intersects 420px rootMargin')
  return value
}
async function quiet() {
  const until = Date.now() + 30_000
  while (inflight.size || process.hrtime.bigint() - lastArtifact < 3_000_000_000n || bodyJobs.size) {
    check(); assert.ok(Date.now() < until, 'artifact quiet deadline'); await pause(50)
  }
}
async function boundary(name) {
  await quiet()
  const hrBefore = String(process.hrtime.bigint())
  const pw = await page.evaluate(() => ({ now: performance.now(), origin: performance.timeOrigin, hash: location.hash, scrollX, scrollY, visibility: document.visibilityState }))
  const reply = await cdp.send('Runtime.evaluate', { expression: 'performance.now()', returnByValue: true })
  assert.ok(!reply.exceptionDetails && Number.isFinite(reply.result.value), 'CDP boundary reply')
  emit('driver', 'boundary', { name, hrBefore, hrAfter: String(process.hrtime.bigint()), pw, cdp: reply.result.value, inflight: [...inflight], lastArtifactHr: String(lastArtifact) })
  await inventory(name)
  check()
}
async function step(name, demand, action, postcondition) {
  await boundary(`${name}-before`)
  phase = name
  const expected = typeof demand === 'function' ? demand() : expectedDemand(demand)
  if (name === 'lane7-open-comparison') requireColdHistory(expected.required, expected.semanticCacheBefore, expected.expectedAttemptBag, base)
  if (name === 'lane8-players-open') {
    assertNoPriorDemand('players-before-open')
    playersStarted = true
  }
  phasePlans.set(name, expected)
  emit('driver', 'phase-open', { expected })
  const start = records.length
  if (expected.kind === 'history') await geometry(`${name}-before-history`)
  await action()
  if (postcondition) await postcondition()
  emit('driver', 'postcondition-met')
  await boundary(`${name}-after`)
  const cdpAttempts = records.slice(start).filter((row) => row.source === 'cdp' && row.kind === 'requestWillBeSent' && artifact(row.raw.request.url)).map((row) => row.raw.request.url).sort()
  const attempts = records.slice(start).filter((row) => row.source === 'pw' && row.kind === 'request' && artifact(row.url)).map((row) => row.url).sort()
  emit('driver', 'phase-attempt-bag', { expected, actualPwBag: attempts, actualCdpBag: cdpAttempts })
  assert.deepEqual(attempts, expected.expectedAttemptBag, 'literal PW demand attempt bag, no retry or failure allowance')
  assert.deepEqual(cdpAttempts, expected.expectedAttemptBag, 'literal CDP demand attempt bag, no retry or failure allowance')
  emit('driver', 'action-cache-provenance', { name, selectedIds: expected.ids ?? [], semanticCacheBefore: expected.semanticCacheBefore ?? [], required: expected.required ?? [], actualPwRequests: attempts.length, actualCdpRequests: cdpAttempts.length, applicationCacheReuse: expected.kind === 'history' && attempts.length === 0, newHttpResponseClaim: false })
  raw(`${name}.html`, await page.content())
  emit('driver', 'phase-close')
}
async function chart(locator, picks, name, yLabel = 'Power score') {
  const labels = picks.map((pick) => pick.code)
  const img = locator.getByRole('img', { name: `${yLabel} over time for ${labels.join(', ')}`, exact: true })
  await img.waitFor()
  await img.locator('.recharts-surface').waitFor()
  await quiet()
  const actual = await img.evaluate((node) => {
    const key = Object.keys(node).find((key) => key.startsWith('__reactFiber$'))
    let fiber = key ? node[key] : null
    const chain = []
    while (fiber && chain.length < 80) {
      const props = fiber.memoizedProps
      if (Array.isArray(props?.series) && props.series.every((s) => typeof s.id === 'string' && typeof s.label === 'string' && Array.isArray(s.points))) {
        const geometry = [...node.querySelectorAll('.recharts-line')].map((line) => ({
          className: line.getAttribute('class'),
          paths: [...line.querySelectorAll('path')].map((path) => ({
            d: path.getAttribute('d'), stroke: path.getAttribute('stroke'), strokeWidth: path.getAttribute('stroke-width'),
            opacity: getComputedStyle(path).opacity, rect: path.getBoundingClientRect().toJSON(),
            totalLength: path.getTotalLength(), transform: path.getAttribute('transform'),
          })),
          dots: [...line.querySelectorAll('circle')].map((dot) => ({
            cx: dot.getAttribute('cx'), cy: dot.getAttribute('cy'), r: dot.getAttribute('r'),
            stroke: dot.getAttribute('stroke'), fill: dot.getAttribute('fill'), rect: dot.getBoundingClientRect().toJSON(),
          })),
          labels: [...line.querySelectorAll('text')].map((label) => ({
            text: label.textContent, x: label.getAttribute('x'), y: label.getAttribute('y'), rect: label.getBoundingClientRect().toJSON(),
          })),
        }))
        return {
          series: props.series.map((entry) => ({ id: entry.id, label: entry.label, color: entry.color, points: entry.points.map((point) => ({ t: point.t, y: point.y })) })),
          ariaLabel: node.getAttribute('aria-label'), summary: document.getElementById(node.getAttribute('aria-describedby'))?.textContent,
          svg: node.innerHTML, geometry,
          visibleLabels: [...node.closest('.chart-shell').querySelectorAll('span,button')].map((element) => ({ text: element.textContent, rect: element.getBoundingClientRect().toJSON() })),
          chain,
        }
      }
      chain.push(typeof fiber.type === 'function' ? fiber.type.name : String(fiber.type))
      fiber = fiber.return
    }
    return { missingSeries: true, chain, ariaLabel: node.getAttribute('aria-label'), svg: node.innerHTML }
  })
  save(`${name}-actual-chart.json`, actual)
  assert.ok(!actual.missingSeries, 'BLOCKED passive chart series observation unavailable')
  const source = [...logical.values()].find((entry) => entry.value?.artifactKind === 'team-history-scope' && entry.value.filter?.season === 'All' && entry.value.filter?.event === 'All' && entry.value.filter?.region === 'All')
  assert.ok(source?.value?.series, 'raw all-scope history oracle')
  const rawIndex = readObservedLogical(plan.manifest.teamHistoryIndexUrl, [])
  assert.equal(new URL(rawIndex.value.scopeIndex.All__All__All.url, 'http://fixture.invalid').pathname, source.logicalPath)
  const rawSource = readObservedLogical(source.logicalPath, picks.map((pick) => pick.id))
  const expected = picks.map((pick) => {
    const series = rawSource.value.series[pick.id]
    assert.ok(series?.points?.length >= 2, 'selected raw series has points')
    const days = new Map()
    for (const point of series.points) if (Number.isFinite(point[1])) days.set(point[0], point[1])
    return { id: pick.id, label: pick.code, rawPoints: series.points, rawKeyMapping: rawSource.selectedKeySources.filter((entry) => entry.selectedId === pick.id && entry.pointsSha256 === sha(JSON.stringify(series.points))), points: [...days].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([date, y]) => ({ t: Date.parse(date), y })) }
  })
  save(`${name}-point-map.json`, {
    unit: release.unit, output: out, actionPhase: phase, logicalPath: source.logicalPath, objectPath: source.objectPath,
    actualSelectedKeys: picks.map((pick) => pick.id), returnedRawKeys: Object.keys(rawSource.value.series),
    responseProvenance: [...rawIndex.receipts, ...rawSource.receipts], expected, actualSeries: actual.series, actualMountedGeometry: actual.geometry,
    selectedKeyMappingStatus: expected.every((entry) => entry.rawKeyMapping.length > 0) ? 'RAW_KEY_LOCATIONS_RETAINED_INDEPENDENT_SELECTION_PROOF_PENDING' : 'PENDING_EXACT_KEY_LOCATION_PROOF',
    pixelMappingStatus: 'PENDING_INDEPENDENT_GEOMETRY_TO_RAW_VALUE_PROOF',
    lane8OracleClaim: phase.startsWith('lane8') ? 'Same actual unit newly captured full bodies. Earlier lane7 sequence reuse is explicit. No new HTTP response is claimed for app cache reuse. Exact literal wording remains BLOCKED until independent review and root countersign.' : null,
    basis: 'Expected tuples decoded from saved current-unit browser bodies. Generated logical values only locate the immutable digest. Props equality alone grants no rendered-point or selection credit.',
  })
  pixelPredicates.push({ name, status: 'PENDING', reason: 'Mounted SVG stroke and dot geometry retained. Exact pixel mapping to raw values requires independent proof.' })
  assert.deepEqual(actual.series.map(({ id, label, points }) => ({ id, label, points })), expected.map(({ id, label, points }) => ({ id, label, points })))
}
try {
  emit('driver', 'start', { ownedTemp, admissionState, writerAdmission, tmpdir: process.env.TMPDIR, osTmpdir: tmpdir(), nodeCompileCache: process.env.NODE_COMPILE_CACHE, nodeDisableCompileCache: process.env.NODE_DISABLE_COMPILE_CACHE, tsxDisableCache: process.env.TSX_DISABLE_CACHE, root, head, tree, argv: process.argv, execArgv: process.execArgv, heapSizeLimitBytes: getHeapStatistics().heap_size_limit, nodeOptions: process.env.NODE_OPTIONS, releasePath, release, provenance: 'Separate named Playwright+CDP companion. Not a T3 tab or the T3 live run.', label: 'SYNTHETIC seeded-sample. Not official LoL Esports data.' })
  resources()
  resourceTimer = setInterval(() => { try { resources() } catch (error) { block(String(error)) } }, 5000)
  save('release.json', release)
  save('source-before.json', sourceIdentity(root, head, tree))
  save('dependencies-before.json', deps()); assert.deepEqual(deps(), pins)
  save('runtime-tools-before.json', toolState()); assert.deepEqual(toolState(), toolPins)
  save('instrument-before.json', instrumentState())
  emit('native', 'actual-node-argv', { argv: readFileSync('/proc/self/cmdline', 'utf8').split('\0').filter(Boolean) })
  optimizerBefore = cache()
  save('optimizer-before.json', optimizerBefore)
  assert.deepEqual(optimizerBefore, json(join(prep, 'optimizer-pins.json')), 'reviewed frozen optimizer identity')
  const dependencyPins = json(join(prep, 'loaded-dependency-pins.json'))
  dependencyBefore = dependencyState(root, dependencyPins)
  save('loaded-dependencies-before.json', dependencyBefore)
  assert.deepEqual(dependencyBefore, { sharedStore: dependencyPins.sharedStore, packages: dependencyPins.packages })
  assert.deepEqual(json(join(ownedTemp.path, 'dependencies-preloader.json')), dependencyBefore)
  const load = (path) => import(pathToFileURL(join(root, path)).href)
  const recipe = readFileSync(join(prep, 'address91-recipe.mts'), 'utf8').replace("'RUNTIME_TYPES_PATH'", JSON.stringify(join(root, 'src/types.ts')))
  raw('fixture-from-test.mts', recipe)
  const fixture = await import(pathToFileURL(join(out, 'fixture-from-test.mts')).href)
  const { matches, teams, rosters } = fixture
  assert.equal(matches.length, 91); assert.equal(Object.keys(teams).length, 20)
  save('fixture-input.json', { label: 'SYNTHETIC seeded-sample', generatedAt: '2026-07-01T00:00:00.000Z', matches, teams, rosters })
  const { createStaticRankingData } = await load('src/lib/snapshot.ts')
  const { createPublicArtifactWritePlan } = await load('src/lib/publicArtifacts/writePlan.ts')
  const { createGenerationManifest, prepareSemanticArtifact, canonicalJsonFor } = await load('scripts/public-artifact-storage.mjs')
  const data = createStaticRankingData({ matches, teams, rosters, generatedAt: '2026-07-01T00:00:00.000Z', dataMode: 'seeded-sample' })
  plan = createPublicArtifactWritePlan(data)
  save('write-plan.json', plan)
  const entries = []
  for (const write of plan.writes) {
    const logicalPath = `/data/${write.relativePath}`
    const prepared = prepareSemanticArtifact(write.value)
    const objectPath = `/data/objects/sha256/${prepared.digest}`
    entries.push({ logicalPath, digest: prepared.digest, bytes: prepared.bytes })
    logical.set(logicalPath, { logicalPath, objectPath, value: write.value, childDigests: (prepared.children ?? []).map((child) => child.digest) })
    raw(`logical/${sha(logicalPath)}.json`, write.contents)
    for (const item of [...(prepared.children ?? []), prepared]) {
      const path = `/data/objects/sha256/${item.digest}`, bytes = Buffer.from(item.canonicalJson)
      assert.equal(sha(bytes), item.digest)
      if (!objects.has(path)) raw(`objects/${item.digest}.json`, bytes)
      else assert.ok(objects.get(path).equals(bytes))
      objects.set(path, bytes)
      references.set(path, [...(references.get(path) ?? []), { logicalPath, role: item === prepared ? 'root' : 'archive-child' }])
    }
  }
  manifest = createGenerationManifest({ generationId: plan.manifest.artifactMeta.runId, rootManifest: { ...plan.manifest }, entries })
  const bootstrap = Buffer.from(canonicalJsonFor(manifest) + '\n')
  save('generation-manifest.json', manifest); raw('bootstrap-body.json', bootstrap)
  save('logical-mapping.json', [...logical.values()].map(({ value, ...rest }) => rest))
  save('object-inventory.json', [...objects].map(([path, bytes]) => ({ path, sha256: sha(bytes), bytes: bytes.length, references: references.get(path) })))
  for (const entry of logical.values()) if (/^team-history/.test(entry.value?.artifactKind ?? '')) for (const path of closure(entry.logicalPath)) forbiddenPaths.add(path)
  for (const path of closure(plan.manifest.playerDirectoryUrl ?? '/data/entities/players.json')) forbiddenPaths.add(path)
  const { HOMEPAGE_PRERENDER_MARKER, injectHomepagePrerender, loadHomepagePrerenderSnapshot, renderHomepagePrerenderSnapshot } = await load('scripts/seo-prerender.ts')
  const homepage = renderHomepagePrerenderSnapshot(await loadHomepagePrerenderSnapshot(async (url) => {
    const entry = logical.get(new URL(url, 'http://fixture.invalid').pathname)
    assert.ok(entry, 'prerender uses generated fixture only'); return entry.value
  }))
  raw('homepage-prerender.html', homepage)
  const plugin = { name: 'lanes78-address91', enforce: 'pre', transformIndexHtml: { order: 'pre', handler(html) {
    assert.ok(html.includes(HOMEPAGE_PRERENDER_MARKER)); return injectHomepagePrerender(html.replace(HOMEPAGE_PRERENDER_MARKER, ''), homepage)
  } }, configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? '/', 'http://fixture.invalid')
      if (!/^\/(data|tournament-data)\//.test(url.pathname)) return next()
      const id = ++serverId
      const arrivalPhase = phase
      serverEvent('arrival', { id, method: request.method, url: request.url, rawHeaders: request.rawHeaders, references: references.get(url.pathname) ?? [] })
      const body = url.pathname === '/data/ranking-summary.json' ? bootstrap : objects.get(url.pathname)
      const status = !['GET', 'HEAD'].includes(request.method) ? 405 : body ? 200 : 404
      const bytes = request.method === 'HEAD' ? Buffer.alloc(0) : body ?? Buffer.from('{}')
      response.statusCode = status; response.sendDate = false
      response.setHeader('content-type', 'application/json')
      response.setHeader('content-length', request.method === 'HEAD' && body ? body.length : bytes.length)
      response.setHeader('cache-control', objects.has(url.pathname) ? 'public, max-age=31536000, immutable' : 'no-store')
      response.once('finish', () => {
        try {
          assert.equal(typeof response._header, 'string')
          const wire = Buffer.concat([Buffer.from(response._header, 'latin1'), bytes])
          raw(`http/${id}.response.http`, wire)
          serverEvent('finish', { id, arrivalPhase, status, headers: response.getHeaders(), bodySha256: sha(bytes), rawSha256: sha(wire), rawPath: `http/${id}.response.http` })
        } catch (error) { block(`server receipt ${error}`) }
      })
      response.once('close', () => serverEvent('close', { id, arrivalPhase, finished: response.writableFinished }))
      response.once('error', (error) => block(`server response ${error}`))
      serverEvent('send', { id, arrivalPhase, status, bodySha256: sha(bytes) })
      response.end(bytes)
    })
  } }
  const { createServer } = await load('node_modules/vite/dist/node/index.js')
  server = await createServer({ root, configLoader: 'runner', logLevel: 'info', plugins: [plugin], server: { host: '127.0.0.1', port: 0 } })
  assert.equal(server.config.root, root); assert.equal(server.config.configFile, join(root, 'vite.config.ts'))
  assert.equal(server.config.cacheDir, join(root, 'node_modules/.vite'))
  assert.ok(!server.config.env.VITE_RANKING_DATA_URL)
  check(); await server.listen()
  const address = server.httpServer.address()
  assert.ok(address && typeof address !== 'string' && address.address === '127.0.0.1')
  base = `http://127.0.0.1:${address.port}`
  const allHistoryIds = Object.keys([...logical.values()].find((entry) => entry.value?.artifactKind === 'team-history-scope' && entry.value.filter?.season === 'All' && entry.value.filter?.event === 'All' && entry.value.filter?.region === 'All').value.series)
  save('emitted-demand-closure-before-browser.json', { indexAndAllScope: expectedDemand('history', allHistoryIds).closureMembers, allHistoryIds, players: expectedDemand('players').closureMembers, requestAllowance: false, onlySelectedBytesClaim: false, runtimeReleaseMustHaveReviewedThisSourceTrace: 'demand-source-trace.md' })
  save('server-identity.json', { pid: process.pid, address, base, root, head, tree, variant: 'address91', configFile: server.config.configFile, cacheDir: server.config.cacheDir, plugins: server.config.plugins.map((p) => p.name), bootstrapPolicy: 'no-store, no ETag, not production revalidation equivalent' })
  const pkg = json(join(root, 'node_modules/playwright-core/package.json'))
  const catalog = json(join(root, 'node_modules/playwright-core/browsers.json')).browsers.find((b) => b.name === 'chromium-headless-shell')
  assert.equal(pkg.version, '1.63.0'); assert.equal(catalog.revision, '1243'); assert.equal(catalog.browserVersion, '153.0.8010.12')
  const { chromium } = await load('node_modules/playwright-core/index.mjs')
  browser = await chromium.launch({ headless: true, timeout: 30_000 })
  browserCdp = await browser.newBrowserCDPSession()
  for (const name of ['targetCreated', 'targetInfoChanged', 'targetDestroyed', 'attachedToTarget', 'detachedFromTarget']) browserCdp.on(`Target.${name}`, (raw) => {
    emit('cdp-browser', name, { raw })
    if (raw.targetInfo && !['page', 'browser'].includes(raw.targetInfo.type)) block(`uncovered target ${raw.targetInfo.type}`)
    if (ownedPageTargetId && raw.targetInfo?.type === 'page' && raw.targetInfo.targetId !== ownedPageTargetId) block('extra page target has no armed CDP session')
  })
  await browserCdp.send('Target.setDiscoverTargets', { discover: true })
  const info = await browserCdp.send('SystemInfo.getProcessInfo')
  const pid = info.processInfo.find((item) => item.type === 'browser')?.id
  assert.ok(Number.isInteger(pid)); const executable = readlinkSync(`/proc/${pid}/exe`)
  assert.ok(executable.includes('chromium_headless_shell-1243/')); assert.equal(browser.version(), catalog.browserVersion)
  emit('driver', 'browser-identity', { pid, executable, executableSha256: sha(readFileSync(executable)), version: browser.version(), catalog, playwrightCore: pkg.version })
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, recordVideo: { dir: join(out, 'video'), size: { width: 1280, height: 900 } } })
  await context.addInitScript(() => {
    window.__r3Lanes78Pointer = { x: null, y: null, type: 'no observed pointer event', target: null }
    window.__r3Lanes78Inputs = []
    document.addEventListener('click', (event) => {
      const button = event.target.closest?.('button')
      const summary = event.target.closest?.('summary')
      const label = button?.getAttribute('aria-label') ?? button?.textContent?.trim()
      const kind = label === 'Open comparison' ? 'history' : /^Players$/.test(summary?.textContent?.trim() ?? '') ? 'players' : null
      if (kind) window.__r3Lanes78Inputs.push({ kind, trusted: event.isTrusted, wallEpochMs: performance.timeOrigin + performance.now(), performanceNow: performance.now(), x: event.clientX, y: event.clientY, target: event.target.outerHTML.slice(0, 1024) })
    }, { passive: true, capture: true })
    for (const name of ['pointermove', 'pointerdown', 'pointerup']) document.addEventListener(name, (event) => {
      window.__r3Lanes78Pointer = { x: event.clientX, y: event.clientY, type: name, target: event.target?.outerHTML?.slice(0, 1024), at: performance.now() }
    }, { passive: true, capture: true })
  })
  context.setDefaultTimeout(30_000); context.setDefaultNavigationTimeout(30_000)
  context.on('request', (request) => {
    const id = pwId(request), url = request.url()
    if (artifact(url)) { inflight.add(`pw:${id}`); lastArtifact = process.hrtime.bigint() }
    let frameUrl = null
    try { frameUrl = request.frame().url() } catch (error) { emit('pw', 'frame-unavailable', { id, error: String(error) }) }
    event('pw', 'request', { pwId: id, url, method: request.method(), headers: request.headers(), resourceType: request.resourceType(), navigation: request.isNavigationRequest(), redirectedFromPwId: request.redirectedFrom() ? pwId(request.redirectedFrom()) : null, frameUrl, serviceWorker: !!request.serviceWorker() })
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      mainNavigationRequests += 1
      if (mainNavigationRequests !== 1 || phase !== 'initial-navigation') block('unexpected main-frame navigation request after first goto')
    }
    if (/^https?:/.test(url) && new URL(url).origin !== base) block(`nonfixture HTTP origin ${url}`)
  })
  context.on('response', (response) => {
    responses.set(pwId(response.request()), response)
    event('pw', 'response', { pwId: pwId(response.request()), url: response.url(), status: response.status(), headers: response.headers(), fromServiceWorker: response.fromServiceWorker() })
    if (response.status() >= 400) block(`HTTP ${response.status()} ${response.url()}`)
  })
  context.on('requestfinished', (request) => {
    const id = pwId(request)
    inflight.delete(`pw:${id}`); event('pw', 'requestfinished', { pwId: id, url: request.url(), timing: request.timing() })
    if (!artifact(request.url())) return
    const job = (async () => {
      const response = responses.get(id); assert.ok(response, 'response for finished artifact')
      const body = await response.body(), path = new URL(request.url()).pathname
      raw(`browser-bodies/${id}.body`, body)
      const bodyEvent = event('pw', 'body', { pwId: id, url: request.url(), sha256: sha(body), bytes: body.length, path: `browser-bodies/${id}.body` })
      if (objects.has(path)) {
        assert.ok(body.equals(objects.get(path)), 'browser raw immutable bytes match generated object')
        if (response.status() === 200) {
          completeObjects.add(path)
          const requestEvent = records.find((row) => row.source === 'pw' && row.kind === 'request' && row.pwId === id)
          const responseEvent = records.find((row) => row.source === 'pw' && row.kind === 'response' && row.pwId === id)
          const receipt = { unit: release.unit, output: out, objectPath: path, url: request.url(), pwId: id, requestSeq: requestEvent?.seq, responseSeq: responseEvent?.seq, bodySeq: bodyEvent.seq, requestPhase: requestEvent?.phase, bodyPhase: bodyEvent.phase, sha256: sha(body), bytes: body.length, rawBodyPath: `browser-bodies/${id}.body` }
          observedBodies.set(path, [...(observedBodies.get(path) ?? []), receipt])
        }
      }
    })().catch((error) => block(`body receipt ${error}`)).finally(() => bodyJobs.delete(job))
    bodyJobs.add(job)
  })
  context.on('requestfailed', (request) => { const id = pwId(request); inflight.delete(`pw:${id}`); event('pw', 'requestfailed', { pwId: id, url: request.url(), failure: request.failure() }); block(`failed request ${request.url()}`) })
  context.on('serviceworker', (worker) => { emit('ctx', 'serviceworker', { url: worker.url() }); block('service worker has no complete CDP coverage') })
  context.on('page', (p) => { emit('ctx', 'page', { url: p.url() }); if (page && p !== page) block('extra page has no armed CDP session') })
  context.on('console', (message) => { emit('ctx', 'console', { type: message.type(), text: message.text(), location: message.location() }); if (message.type() === 'error') block(`console error ${message.text()}`) })
  context.on('weberror', (error) => { emit('ctx', 'weberror', { error: String(error.error()), stack: error.error()?.stack }); block('context web error') })
  context.on('close', () => emit('ctx', 'close'))
  page = await context.newPage()
  page.on('worker', (worker) => { emit('page', 'worker', { url: worker.url() }); block('dedicated worker has no complete CDP coverage') })
  page.on('frameattached', (frame) => { emit('page', 'frameattached', { url: frame.url() }); block('child frame has no complete CDP coverage') })
  page.on('framedetached', (frame) => emit('page', 'framedetached', { url: frame.url() }))
  page.on('framenavigated', (frame) => {
    emit('page', 'framenavigated', { url: frame.url(), main: frame === page.mainFrame() })
  })
  for (const name of ['domcontentloaded', 'load', 'crash', 'close']) page.on(name, () => emit('page', name, { url: page.url() }))
  page.on('pageerror', (error) => { emit('page', 'pageerror', { error: String(error), stack: error.stack }); block('page error') })
  cdp = await context.newCDPSession(page)
  const ownTarget = await cdp.send('Target.getTargetInfo')
  ownedPageTargetId = ownTarget.targetInfo.targetId
  emit('driver', 'owned-page-target', ownTarget)
  cdp.on('Inspector.detached', (raw) => { emit('cdp', 'Inspector.detached', { raw }); if (phase !== 'teardown') block('CDP detached before teardown') })
  browser.on('disconnected', () => { emit('driver', 'browser-disconnected'); if (phase !== 'teardown') block('unexpected browser disconnect') })
  for (const name of ['requestWillBeSent', 'requestWillBeSentExtraInfo', 'requestServedFromCache', 'responseReceived', 'responseReceivedExtraInfo', 'loadingFinished', 'loadingFailed', 'webSocketCreated', 'webSocketClosed', 'webSocketFrameError']) cdp.on(`Network.${name}`, (raw) => {
    if (name === 'requestWillBeSent') {
      inflight.delete(`cdp:${raw.requestId}`)
      if (artifact(raw.request.url)) { inflight.add(`cdp:${raw.requestId}`); lastArtifact = process.hrtime.bigint() }
    }
    if (name === 'loadingFinished' || name === 'loadingFailed') inflight.delete(`cdp:${raw.requestId}`)
    event('cdp', name, { raw })
    if (name === 'loadingFailed' || name === 'webSocketFrameError') block(`CDP ${name}`)
  })
  cdp.on('Page.frameNavigated', ({ frame }) => {
    emit('cdp', 'document-navigation', { frame })
    if (frame.parentId) return
    if (phase !== 'initial-navigation' || firstDocumentLoader !== null) block('unexpected main-frame document navigation after first goto')
    else firstDocumentLoader = frame.loaderId
  })
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')
  await inventory('listeners-ready')
  emit('driver', 'listeners-ready', { viewport: page.viewportSize(), coverage: 'PW context plus page CDP. Source-proved no worker or child-frame use on this ranking path, enforced with continuous events and inventories. No routing, fetch wrapping, cache disabling, IO override, or viewport changes.' })
  phase = 'initial-navigation'
  emit('driver', 'goto', { url: `${base}/#rankings?scope=all&eligibility=all&sort=rating` })
  await page.goto(`${base}/#rankings?scope=all&eligibility=all&sort=rating`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 20)
  await geometry('before-any-row-action-or-scroll')
  await boundary('initial-loaded')
  raw('initial.html', await page.content())
  const names = await page.locator('table tbody tr td:nth-child(2) b').allTextContents()
  assert.equal(names.length, 20); assert.equal(new Set(names).size, 20)
  const allScope = [...logical.values()].find((entry) => entry.value?.artifactKind === 'public-snapshot-shard' && entry.value.filter?.season === 'All' && entry.value.filter?.event === 'All' && entry.value.filter?.region === 'All')
  assert.ok(allScope?.value?.standings, 'raw all-scope standings')
  const rows = names.map((name, index) => {
    const standing = allScope.value.standings.find((s) => s.team === name)
    assert.ok(standing?.teamId && teams[name], 'actual row identity has raw team ID and fixture profile')
    return { index, name, id: standing.teamId, code: teams[name].code ?? name }
  })
  save('row-identities.json', { rows, initialFive: rows.slice(0, 5), selected7: rows.slice(5, 8), selected8: rows.slice(8, 10) })
  assertNoPriorDemand('initial-loaded-both-observers')
  const selected7 = rows.slice(5, 8)
  assert.ok(selected7.every((pick) => !rows.slice(0, 5).some((first) => first.id === pick.id)))
  for (const pick of selected7) await step(`lane7-pick-${pick.index}`, 'zero', async () => {
    await geometry(`before-pick-${pick.index}`)
    await page.locator('table tbody tr').nth(pick.index).locator('input[type="checkbox"]').check()
    await geometry(`after-pick-${pick.index}`)
  })
  const comparison = page.getByRole('dialog', { name: 'Team comparison', exact: true })
  await step('lane7-open-comparison', () => expectedDemand('history', selected7.map((p) => p.id)), async () => {
    await geometry('before-open-comparison')
    assertNoPriorDemand('immediately-before-comparison-input')
    lane7HistoryStarted = true
    emit('driver', 'lane7-first-history-input', { beforeInputSeq: seq })
    await page.getByRole('button', { name: 'Open comparison', exact: true }).click()
    const inputs = await page.evaluate(() => window.__r3Lanes78Inputs.filter((row) => row.kind === 'history'))
    assert.equal(inputs.length, 1)
    inputBoundaries.history = inputs[0]
    emit('driver', 'actual-input-boundary', inputs[0])
  }, () => chart(comparison, selected7, 'lane7-three'))
  await step('lane7-remove-first', () => expectedDemand('history', selected7.slice(1).map((p) => p.id)), () => comparison.getByRole('button', { name: `Remove ${selected7[0].name} from comparison`, exact: true }).click(), () => chart(comparison, selected7.slice(1), 'lane7-two'))
  await page.screenshot({ path: join(out, 'receipts/r3-lane-7.png') })
  await step('lane7-close-and-clear', 'zero', async () => {
    await comparison.getByRole('button', { name: 'Close', exact: true }).click()
    await geometry('immediately-after-lane7-comparison-close')
    await page.getByRole('region', { name: 'Compare teams: 2 selected', exact: true }).getByRole('button', { name: 'Clear', exact: true }).click()
    await geometry('after-lane7-close-and-clear')
  })
  const old = rows[0]
  await step('lane8-detail-players-closed', () => expectedDemand('history', [old.id]), async () => {
    await page.locator('table tbody tr').first().getByRole('button').first().click()
  }, async () => {
    const detail = page.getByRole('dialog')
    await chart(detail, [old], 'lane8-old-detail', 'Power')
    assert.equal(await detail.locator('summary').filter({ hasText: /^Players$/ }).evaluate((s) => s.parentElement.open), false)
  })
  assertNoPriorDemand('closed-players-both-observers')
  await step('lane8-players-open', 'players', async () => {
    await page.getByRole('dialog').locator('summary').filter({ hasText: /^Players$/ }).click()
    const inputs = await page.evaluate(() => window.__r3Lanes78Inputs.filter((row) => row.kind === 'players'))
    assert.equal(inputs.length, 1)
    inputBoundaries.players = inputs[0]
    emit('driver', 'actual-input-boundary', inputs[0])
  }, async () => {
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] details')].some((d) => d.open && /^Players/.test(d.textContent)))
  })
  await step('lane8-close-detail', 'zero', async () => {
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    emit('driver', 'old-detail-closed', { old, hash: await page.evaluate(() => location.hash) })
    await geometry('after-lane8-close-detail')
  })
  const selected8 = rows.slice(8, 10)
  assert.ok(selected8.every((pick) => pick.id !== old.id))
  for (const pick of selected8) await step(`lane8-pick-${pick.index}`, 'zero', async () => {
    await geometry(`before-pick-${pick.index}`)
    await page.locator('table tbody tr').nth(pick.index).locator('input[type="checkbox"]').check()
    await geometry(`after-pick-${pick.index}`)
  })
  await step('lane8-open-comparison', () => expectedDemand('history', selected8.map((p) => p.id)), () => page.getByRole('button', { name: 'Open comparison', exact: true }).click(), () => chart(comparison, selected8, 'lane8-new-picks'))
  emit('driver', 'no-old-detail-replacement', { old, selected8 })
  await page.screenshot({ path: join(out, 'receipts/r3-lane-8.png') })
  await step('lane8-close-comparison', 'zero', async () => { await comparison.getByRole('button', { name: 'Close', exact: true }).click(); await geometry('after-lane8-close-comparison') })
  await step('data-and-sources', 'zero', () => page.locator('summary').filter({ hasText: /^Data and sources/ }).click(), async () => {
    assert.equal(await page.locator('summary').filter({ hasText: /^Data and sources/ }).evaluate((s) => s.parentElement.open), true)
  })
  await boundary('postloaded-end')
  const candidate = records.find((row) => row.source === 'pw' && row.kind === 'body' && row.phase === 'initial-navigation' && objects.has(new URL(row.url).pathname) && !forbiddenPaths.has(new URL(row.url).pathname))
  assert.ok(candidate, 'sensitivity control requires actual initial immutable body')
  phase = 'sensitivity-control'
  phasePlans.set(phase, { expectedAttemptBag: [candidate.url] })
  const tag = randomUUID()
  emit('driver', 'control-start', { tag, header: 'X-R3-Lanes78-Control', url: candidate.url, expectedPwAttempts: 1, expectedCdpAttempts: 1, expectedServerArrivals: 0, requiredCache: true, excludedFromAppPredicateOnly: true })
  const status = await page.evaluate(async ({ url, tag }) => { const r = await fetch(url, { headers: { 'X-R3-Lanes78-Control': tag } }); await r.arrayBuffer(); return r.status }, { url: candidate.url, tag })
  emit('driver', 'control-result', { tag, status })
  assert.equal(status, 200)
  await boundary('control-end')
  const header = (headers) => Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-r3-lanes78-control')?.[1]
  const controlRows = records.filter((row) => row.phase === 'sensitivity-control')
  const pwControl = controlRows.filter((row) => row.source === 'pw' && row.kind === 'request' && header(row.headers) === tag)
  const cdpControl = controlRows.filter((row) => row.source === 'cdp' && row.kind === 'requestWillBeSent' && header(row.raw.request.headers) === tag)
  assert.equal(pwControl.length, 1); assert.equal(cdpControl.length, 1)
  assert.equal(pwControl[0].url, candidate.url); assert.equal(cdpControl[0].raw.request.url, candidate.url)
  const id = cdpControl[0].raw.requestId
  const cdpRows = controlRows.filter((row) => row.source === 'cdp' && row.raw.requestId === id)
  assert.ok(cdpRows.some((row) => row.kind === 'requestServedFromCache' || row.kind === 'responseReceived' && row.raw.response.fromDiskCache === true), 'actual CDP cache indicator required')
  assert.ok(cdpRows.some((row) => row.kind === 'responseReceived' && row.raw.response.status === 200))
  assert.ok(cdpRows.some((row) => row.kind === 'loadingFinished'))
  assert.ok(controlRows.some((row) => row.source === 'pw' && row.kind === 'requestfinished' && row.pwId === pwControl[0].pwId))
  assert.ok(controlRows.some((row) => row.source === 'pw' && row.kind === 'body' && row.pwId === pwControl[0].pwId && row.sha256 === candidate.sha256))
  const taggedArrivals = serverRecords.filter((row) => row.kind === 'arrival' && row.rawHeaders.some((value, index) => index % 2 === 0 && value.toLowerCase() === 'x-r3-lanes78-control' && row.rawHeaders[index + 1] === tag))
  assert.deepEqual(taggedArrivals, [], 'cache control has zero tagged server arrivals')
  assert.equal(controlRows.filter((row) => row.source === 'pw' && row.kind === 'request' && artifact(row.url)).length, 1, 'extra app attempts remain counted during control')
  assert.equal(controlRows.filter((row) => row.source === 'cdp' && row.kind === 'requestWillBeSent' && artifact(row.raw.request.url)).length, 1)
  emit('driver', 'control-agreement', { tag, pwId: pwControl[0].pwId, cdpRequestId: id, bodySha256: candidate.sha256, taggedServerArrivals: 0, totalControlPwArtifactAttempts: 1, totalControlCdpArtifactAttempts: 1, independentRawVerdict: 'PENDING' })
} catch (error) {
  process.exitCode = 1
  emit('driver', 'error', { error: String(error), stack: error.stack })
  console.error(error)
} finally {
  save('owned-processes.json', { driverPid: process.pid, temp: ownedTemp.path, processes: [...ownedProcesses.values()] });
  phase = 'teardown'; phasePlans.set(phase, { expectedAttemptBag: [] }); emit('driver', 'phase-open')
  if (resourceTimer) clearInterval(resourceTimer)
  let video
  for (const [name, close] of [
    ['context', async () => { if (context) { video = page?.video(); await context.close(); emit('driver', 'context-closed'); await Promise.allSettled([...bodyJobs]); if (video) { const path = await video.path(); emit('driver', 'video-finalized', { path, sha256: sha(readFileSync(path)) }) } } }],
    ['browser', async () => { if (browser) { await browser.close(); emit('driver', 'browser-closed', { connected: browser.isConnected() }) } }],
    ['server', async () => { if (server) { const closing = server.close(); server.httpServer?.closeAllConnections(); await closing; assert.equal(server.httpServer?.listening ?? false, false); emit('driver', 'server-closed', { listening: server.httpServer?.listening ?? null }) } }],
    ['source-after', async () => {
      save('source-after.json', sourceIdentity(root, head, tree))
      save('dependencies-after.json', deps()); assert.deepEqual(deps(), pins)
      save('optimizer-after.json', cache()); assert.deepEqual(cache(), optimizerBefore, 'frozen optimizer')
      save('loaded-dependencies-after.json', dependencyState(root, json(join(prep, 'loaded-dependency-pins.json'))))
      assert.deepEqual(json(join(out, 'loaded-dependencies-after.json')), dependencyBefore)
      save('runtime-tools-after.json', toolState()); assert.deepEqual(toolState(), toolPins)
      const instruments = instrumentState()
      save('instrument-after.json', instruments)
      assert.deepEqual(instruments, json(join(out, 'instrument-before.json')))
    }],
  ]) {
    try { await close(); cleanup.push({ name, code: 0 }) }
    catch (error) { cleanup.push({ name, code: 1, error: String(error) }); process.exitCode = 1; emit('driver', 'cleanup-error', { name, error: String(error) }) }
  }
  for (const name of ['r3-lane-7.png', 'r3-lane-8.png']) {
    const path = join(out, 'receipts', name)
    if (existsSync(path)) emit('driver', 'media-sha256', { path, sha256: sha(readFileSync(path)) })
  }
  const historyPaths = new Set([...logical.values()].filter((entry) => /^team-history/.test(entry.value?.artifactKind ?? '')).flatMap((entry) => closure(entry.logicalPath)))
  const playerPaths = plan ? new Set(closure(plan.manifest.playerDirectoryUrl ?? '/data/entities/players.json')) : new Set()
  const inputAudit = auditInputBoundaries(records, inputBoundaries, historyPaths, playerPaths)
  save('actual-input-boundary-audit.json', inputAudit)
  for (const failure of inputAudit.failures) block(`actual input boundary ${failure.kind} ${failure.source} ${failure.error}`)
  const fullAudit = auditPhases(records, phasePlans, forbiddenPaths)
  save('all-phase-audit.json', fullAudit)
  for (const failure of fullAudit.failures) block(`all-phase demand ${failure.phase} ${failure.error}`)
  save('owned-temp-before-driver-exit.json', tempInventory(ownedTemp.path))
  save('pixel-predicates.json', pixelPredicates)
  for (const [name, expected] of phasePlans) {
    const rows = records.filter((row) => row.phase === name)
    const pwBag = rows.filter((row) => row.source === 'pw' && row.kind === 'request' && artifact(row.url)).map((row) => row.url).sort()
    const cdpBag = rows.filter((row) => row.source === 'cdp' && row.kind === 'requestWillBeSent' && artifact(row.raw.request.url)).map((row) => row.raw.request.url).sort()
    emit('driver', 'final-phase-attempt-bag', { name, expected, pwBag, cdpBag, includesLateEventsAfterPhaseClose: true })
    try { assert.deepEqual(pwBag, expected.expectedAttemptBag); assert.deepEqual(cdpBag, expected.expectedAttemptBag) }
    catch (error) { block(`final literal demand ${name} ${error}`) }
  }
  emit('driver', 'raw-artifact-totals', {
    pw: records.filter((row) => row.source === 'pw' && row.kind === 'request' && artifact(row.url)).length,
    cdp: records.filter((row) => row.source === 'cdp' && row.kind === 'requestWillBeSent' && artifact(row.raw.request.url)).length,
    server: serverRecords.filter((row) => row.kind === 'arrival').length,
    controlIncluded: true,
    basis: 'Every initial, navigation, postloaded, control, and teardown event. Independent raw reconstruction is mandatory.',
  })
  emit('driver', 'end', { fault, ledgerError, cleanup, elapsedMs: Number(process.hrtime.bigint() - startedNs) / 1e6, ownBudgetMs: 13 * 60_000, verdict: 'NONE. Independent raw-evidence verdict required.' })
  save('end.json', { fault, ledgerError, cleanup, actualInnerExitCode: process.exitCode ?? 0, eventsSha256: sha(readFileSync(join(out, 'events.jsonl'))), runtimeCredit: 'PENDING independent raw evidence review', outerExit: 'Required separately from observer and actual caller.' })
  if (fault || ledgerError || cleanup.some((item) => item.code !== 0)) process.exitCode = 1
}
