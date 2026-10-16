import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const inspector = Object.freeze({ path: '/home/codex/.local/state/pstack/mistake-prevention-20261015/max-update/r3-native-admission-fix-v2/inspect.py', sha256: 'ea94e43a4ab50b7b9db16657cba1fde6e9f988a0a922dfe7077f0e80dcaffb4b' })
export const runtimeRoot = '/home/codex/.t3/worktrees/lol-esports-ranking/t3-14557610'
export const sharedStore = '/home/codex/work/lol-esports-ranking/node_modules/.pnpm'
export const sha = (body) => createHash('sha256').update(body).digest('hex')

export function validateAdmission(value, { now, head, tree, heavyLock, browserLock }) {
  assert.equal(value.phase, 'before')
  assert.equal(value.ready, true)
  assert.deepEqual(value.errors, [])
  assert.equal(value.head, head)
  assert.equal(value.tree, tree)
  assert.equal(value.status, '')
  assert.equal(value.trackedBlobCount, 680)
  const age = now - Date.parse(value.at)
  assert.ok(Number.isFinite(age) && age >= 0 && age <= 30_000, 'actual inspector at must be fresh')
  assert.ok(Number.isFinite(value.memoryFullAvg60) && value.memoryFullAvg60 <= 5)
  assert.ok(Number.isFinite(value.memAvailableKiB) && value.memAvailableKiB >= 1536 * 1024)
  assert.ok(Number.isFinite(value.diskFreeGiB) && value.diskFreeGiB >= 4)
  assert.deepEqual(value.processMatches, [])
  assert.ok(Array.isArray(value.processSnapshotBefore) && value.processSnapshotBefore.length > 0)
  assert.ok(Array.isArray(value.processSnapshotAfter) && value.processSnapshotAfter.length > 0)
  assert.deepEqual(value.processInspectionErrors, { before: [], after: [] })
  assert.deepEqual(value.locks, [heavyLock, browserLock].map((path) => ({ path, acquiredNonblocking: true, released: true })))
  return { at: value.at, ageMs: age, locks: value.locks, resourcesVerified: true }
}

export function requireColdHistory(required, semanticCacheBefore, expectedAttemptBag, base) {
  assert.ok(required.length > 0, 'lane 7 full history closure must be nonempty')
  assert.deepEqual(required.filter((path) => semanticCacheBefore.includes(path)), [], 'no prior complete history body')
  assert.deepEqual(expectedAttemptBag, required.map((path) => `${base}${path}`).sort(), 'full required bag, no cache subtraction')
}

export function attemptBags(records, phase) {
  const rows = records.filter((row) => row.phase === phase)
  return {
    pw: rows.filter((row) => row.source === 'pw' && row.kind === 'request' && /^\/(data|tournament-data)\//.test(new URL(row.url).pathname)).map((row) => row.url).sort(),
    cdp: rows.filter((row) => row.source === 'cdp' && row.kind === 'requestWillBeSent' && /^\/(data|tournament-data)\//.test(new URL(row.raw.request.url).pathname)).map((row) => row.raw.request.url).sort(),
  }
}

export function auditPhases(records, plans, forbiddenPaths) {
  const phases = new Set(['setup', 'initial-navigation', 'sensitivity-control', 'teardown', ...plans.keys(), ...records.map((row) => row.phase)])
  const failures = [], results = []
  for (const phase of phases) {
    const bags = attemptBags(records, phase)
    const expected = plans.get(phase)
    const forbidden = (bag) => bag.filter((url) => forbiddenPaths.has(new URL(url).pathname))
    try {
      if (expected) {
        assert.deepEqual(bags.pw, expected.expectedAttemptBag)
        assert.deepEqual(bags.cdp, expected.expectedAttemptBag)
      } else {
        assert.deepEqual(forbidden(bags.pw), [], `unplanned PW history or player closure in ${phase}`)
        assert.deepEqual(forbidden(bags.cdp), [], `unplanned CDP history or player closure in ${phase}`)
        if (!['setup', 'initial-navigation'].includes(phase)) {
          assert.deepEqual(bags.pw, [])
          assert.deepEqual(bags.cdp, [])
        }
      }
      results.push({ phase, bags, expected: expected ?? null, status: 'PASSED_SOURCE_RULE' })
    } catch (error) {
      failures.push({ phase, error: String(error), bags, expected: expected ?? null })
    }
  }
  return { results, failures }
}

export function assertOwnedTemp(out, env, uid) {
  assert.equal(env.TSX_DISABLE_CACHE, '1')
  assert.equal(env.TMPDIR, `${out}.tmp`)
  const info = lstatSync(env.TMPDIR)
  assert.ok(info.isDirectory() && !info.isSymbolicLink())
  assert.equal(realpathSync(env.TMPDIR), env.TMPDIR)
  assert.equal(info.uid, uid)
  assert.equal(info.mode & 0o777, 0o700)
  return { path: env.TMPDIR, uid: info.uid, mode: info.mode & 0o777, tsxDisableCache: env.TSX_DISABLE_CACHE }
}

export function dependencyState(root, pins) {
  assert.equal(root, runtimeRoot)
  assert.equal(realpathSync(join(root, 'node_modules/.pnpm')), sharedStore)
  return { sharedStore, packages: pins.packages.map((pkg) => {
    assert.equal(realpathSync(pkg.path), pkg.realpath, `dependency realpath ${pkg.name}`)
    const actualPaths = []
    const walk = (dir) => { for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules') continue
      const file = join(dir, name), info = lstatSync(file)
      assert.ok(!info.isSymbolicLink(), `unexpected dependency symlink ${file}`)
      if (info.isDirectory()) walk(file)
      else if (info.isFile()) actualPaths.push(file.slice(pkg.realpath.length + 1))
      else assert.fail(`nonregular dependency file ${file}`)
    } }
    walk(pkg.realpath)
    assert.deepEqual(actualPaths.sort(), pkg.files.map((file) => file.relativePath).sort(), `exact package file inventory ${pkg.name}`)
    const files = pkg.files.map(({ relativePath, sha256 }) => {
      const path = join(pkg.realpath, relativePath)
      const realpath = realpathSync(path)
      assert.equal(realpath, path, `dependency file symlink ${path}`)
      assert.ok(lstatSync(path).isFile())
      const actual = sha(readFileSync(path))
      assert.equal(actual, sha256, `dependency code hash ${path}`)
      return { relativePath, sha256: actual }
    })
    return { ...pkg, files }
  }) }
}

export function tempInventory(path) {
  const entries = []
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name), info = lstatSync(file)
      entries.push({ path: file, mode: info.mode & 0o777, uid: info.uid, type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : info.isSymbolicLink() ? 'symlink' : info.isSocket() ? 'socket' : info.isFIFO() ? 'fifo' : 'other', bytes: info.size })
      if (info.isDirectory() && !info.isSymbolicLink()) walk(file)
    }
  }
  walk(path)
  return { path, parent: dirname(path), entries }
}

export function storeWriters(snapshots) {
  const rows = snapshots.flat().filter((row) => {
    const command = [row.executable ?? '', ...(row.argv ?? [])].join(' ')
    return /(?:^|[ /])(pnpm(?:\.cjs)?|npm(?:-cli\.js)?|yarn(?:\.js)?)(?: |$)/.test(command)
  })
  assert.deepEqual(rows, [], 'no package manager process while the shared store is in use')
  return { matchedWriters: rows, sharedStore, basis: 'All package manager processes are rejected. Root also checks store ownership before allocation.' }
}

export function auditInputBoundaries(records, boundaries, historyPaths, playerPaths) {
  const failures = [], results = []
  for (const [kind, paths] of [['history', historyPaths], ['players', playerPaths]]) {
    const attempts = records.filter((row) => row.source === 'pw' && row.kind === 'request' || row.source === 'cdp' && row.kind === 'requestWillBeSent').filter((row) => paths.has(new URL(row.source === 'pw' ? row.url : row.raw.request.url).pathname))
    for (const row of attempts) {
      const marker = boundaries[kind]
      const terminal = row.source === 'pw' ? records.find((end) => end.source === 'pw' && end.kind === 'requestfinished' && end.pwId === row.pwId) : null
      const startedAt = row.source === 'cdp' ? row.raw.wallTime * 1000 : terminal?.timing?.startTime
      try {
        assert.ok(marker?.trusted === true && Number.isFinite(marker.wallEpochMs), `actual trusted ${kind} input required`)
        assert.ok(Number.isFinite(startedAt) && startedAt >= marker.wallEpochMs, `${row.source} ${kind} started before actual input or has missing start time`)
        results.push({ kind, source: row.source, seq: row.seq, startedAt, input: marker })
      } catch (error) { failures.push({ kind, source: row.source, seq: row.seq, startedAt: startedAt ?? null, input: marker ?? null, error: String(error) }) }
    }
  }
  return { results, failures, basis: 'Actual browser request start times and trusted DOM capture click epoch times. Host delivery order grants no exception.' }
}
