import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateAdmission, requireColdHistory, auditPhases, assertOwnedTemp, storeWriters, auditInputBoundaries, dependencyState, runtimeRoot, sha } from './source-guards.mjs'
const prep = dirname(fileURLToPath(import.meta.url))
const controlOut = process.argv[2]
assert.ok(controlOut?.startsWith(`${prep}/receipts/`), 'one new owned source-control output directory is required')
mkdirSync(controlOut, { mode: 0o700 })
const results = []
function control(name, body) {
  body()
  results.push({ name, status: 'PASSED', scope: 'DETERMINISTIC_SOURCE_CONTROL_ONLY', syntheticInputs: true })
}
const base = 'http://source-control.invalid'
const history = '/data/objects/sha256/history', player = '/data/objects/sha256/player'
const forbidden = new Set([history, player])
const request = (source, phase, path, extra = {}) => source === 'pw'
  ? { source, phase, kind: 'request', url: `${base}${path}`, ...extra }
  : { source, phase, kind: 'requestWillBeSent', raw: { request: { url: `${base}${path}` } }, ...extra }
control('B2 cold history requires the full nonempty bag', () => {
  requireColdHistory([history], [], [`${base}${history}`], base)
  assert.throws(() => requireColdHistory([], [], [], base))
  assert.throws(() => requireColdHistory([history], [history], [], base))
  assert.throws(() => requireColdHistory([history], [], [], base))
})
for (const source of ['pw', 'cdp']) for (const phase of ['setup', 'initial-navigation', 'sensitivity-control', 'late-unplanned', 'teardown']) for (const path of [history, player]) {
  control(`B2 rejects ${source} ${phase} ${path.endsWith('history') ? 'history' : 'player'} including failed cleanup`, () => {
    const audit = auditPhases([request(source, phase, path), { source, phase, kind: 'requestfailed', failure: 'synthetic abort' }], new Map(), forbidden)
    assert.equal(audit.failures.length, 1)
    assert.equal(audit.failures[0].phase, phase)
  })
}
control('B2 retains duplicate and aborted attempts in a planned bag', () => {
  const plan = new Map([['lane7-open-comparison', { expectedAttemptBag: [`${base}${history}`] }]])
  for (const source of ['pw', 'cdp']) {
    const rows = [request('pw', 'lane7-open-comparison', history), request('cdp', 'lane7-open-comparison', history), request(source, 'lane7-open-comparison', history, { failure: 'synthetic abort' })]
    assert.equal(auditPhases(rows, plan, forbidden).failures.length, 1)
  }
})
control('B2 sees a late initial request despite a correct later comparison bag', () => {
  const phase = 'lane7-open-comparison'
  const rows = [request('cdp', 'initial-navigation', history), request('pw', phase, history), request('cdp', phase, history)]
  const audit = auditPhases(rows, new Map([[phase, { expectedAttemptBag: [`${base}${history}`] }]]), forbidden)
  assert.equal(audit.failures.length, 1)
  assert.equal(audit.failures[0].phase, 'initial-navigation')
})
control('B2 no unrelated postloaded artifact can disappear', () => {
  for (const source of ['pw', 'cdp']) assert.equal(auditPhases([request(source, 'late-unplanned', '/data/objects/sha256/other')], new Map(), forbidden).failures.length, 1)
})
control('B2 rejects a pre-click request even when host delivery occurs in comparison', () => {
  const marker = { trusted: true, wallEpochMs: 2000 }
  const rows = [request('cdp', 'lane7-open-comparison', history), { ...request('pw', 'lane7-open-comparison', history), pwId: 1 }, { source: 'pw', phase: 'lane7-open-comparison', kind: 'requestfinished', pwId: 1, timing: { startTime: 1999 } }]
  rows[0].raw.wallTime = 1.999
  assert.equal(auditInputBoundaries(rows, { history: marker }, new Set([history]), new Set()).failures.length, 2)
  rows[0].raw.wallTime = 2.001
  rows[2].timing.startTime = 2001
  assert.equal(auditInputBoundaries(rows, { history: marker }, new Set([history]), new Set()).failures.length, 0)
  assert.equal(auditInputBoundaries(rows, {}, new Set([history]), new Set()).failures.length, 2)
})
const now = Date.parse('2026-10-16T23:00:00Z')
const settings = { now, head: 'h', tree: 't', heavyLock: '/synthetic/heavy.lock', browserLock: '/synthetic/browser.lock' }
const admission = {
  phase: 'before', ready: true, errors: [], head: 'h', tree: 't', status: '', trackedBlobCount: 680,
  at: new Date(now - 1000).toISOString(), memoryFullAvg60: 5, memAvailableKiB: 1536 * 1024, diskFreeGiB: 4,
  processMatches: [], processSnapshotBefore: [{ pid: 1 }], processSnapshotAfter: [{ pid: 1 }], processInspectionErrors: { before: [], after: [] },
  locks: [settings.heavyLock, settings.browserLock].map((path) => ({ path, acquiredNonblocking: true, released: true })),
}
control('B4 accepts only the canonical JSON data shape in this synthetic control', () => validateAdmission(admission, settings))
const badAdmissions = [
  ['typed approved and observedAt', { approved: true, observedAt: new Date(now).toISOString() }],
  ['stale at', { ...admission, at: new Date(now - 30_001).toISOString() }],
  ['future at', { ...admission, at: new Date(now + 1).toISOString() }],
  ['invalid at', { ...admission, at: 'invalid' }],
  ['wrong phase', { ...admission, phase: 'after' }],
  ['wrong head', { ...admission, head: 'other' }],
  ['wrong tree', { ...admission, tree: 'other' }],
  ['ready string', { ...admission, ready: 'true' }],
  ['nonempty errors', { ...admission, errors: ['synthetic error'] }],
  ['lock not acquired', { ...admission, locks: admission.locks.map((lock) => ({ ...lock, acquiredNonblocking: false })) }],
  ['wrong lock path', { ...admission, locks: [] }],
  ['PSI too high', { ...admission, memoryFullAvg60: 5.01 }],
  ['memory too low', { ...admission, memAvailableKiB: 1536 * 1024 - 1 }],
  ['disk too low', { ...admission, diskFreeGiB: 3.99 }],
  ['unknown process sample', { ...admission, processInspectionErrors: { before: ['synthetic gap'], after: [] } }],
]
for (const [name, value] of badAdmissions) control(`B4 rejects ${name}`, () => assert.throws(() => validateAdmission(value, settings)))
control('B3 rejects a shared store writer in either canonical sample', () => {
  storeWriters([[{ executable: '/usr/bin/node', argv: ['node', 'source-controls.mjs'] }]])
  assert.throws(() => storeWriters([[{ executable: '/usr/bin/node', argv: ['node', '/tools/pnpm.cjs', 'install'] }]]))
})
const tempOut = join(controlOut, 'synthetic-temp-output')
mkdirSync(`${tempOut}.tmp`, { mode: 0o700 })
const env = { TMPDIR: `${tempOut}.tmp`, TSX_DISABLE_CACHE: '1' }
control('B1 accepts the owned mode 0700 sibling only', () => {
  assertOwnedTemp(tempOut, env, process.getuid())
  assert.throws(() => assertOwnedTemp(tempOut, { ...env, TSX_DISABLE_CACHE: '0' }, process.getuid()))
  assert.throws(() => assertOwnedTemp(tempOut, { ...env, TMPDIR: '/tmp' }, process.getuid()))
  assert.throws(() => assertOwnedTemp(tempOut, env, process.getuid() + 1))
  chmodSync(env.TMPDIR, 0o755)
  assert.throws(() => assertOwnedTemp(tempOut, env, process.getuid()))
  chmodSync(env.TMPDIR, 0o700)
})
control('B3 rejects changed code, realpaths, and added files without loading a package', () => {
  const path = join(controlOut, 'synthetic-package')
  mkdirSync(path, { mode: 0o700 })
  const body = 'export const syntheticSourceOnly = true\n'
  writeFileSync(join(path, 'entry.mjs'), body, { flag: 'wx', mode: 0o600 })
  const pkg = { name: 'synthetic-source-control', version: '0', path, realpath: path, files: [{ relativePath: 'entry.mjs', sha256: sha(body) }] }
  dependencyState(runtimeRoot, { packages: [pkg] })
  assert.throws(() => dependencyState(runtimeRoot, { packages: [{ ...pkg, realpath: path + '-wrong' }] }))
  writeFileSync(join(path, 'entry.mjs'), body + 'export const changed = true\n')
  assert.throws(() => dependencyState(runtimeRoot, { packages: [pkg] }))
  writeFileSync(join(path, 'added.mjs'), 'export {}\n', { flag: 'wx', mode: 0o600 })
  assert.throws(() => dependencyState(runtimeRoot, { packages: [pkg] }))
})
const value = { status: 'SOURCE_CONTROLS_PASSED', runtime: 'UNRUN', nativeInspector: 'NOT_CALLED', fakeActualExitReceipts: 'NONE', results }
writeFileSync(join(controlOut, 'source-controls.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ sourceControlsPassed: results.length, runtime: 'UNRUN', nativeInspector: 'NOT_CALLED' }))
