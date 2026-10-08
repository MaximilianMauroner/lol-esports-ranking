import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import { recordProfileFailure, startDiagnosticWorker } from '../scripts/diagnostic-profile-lifecycle.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'diagnostic-lifecycle-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return {
    directory,
    options: { readinessTimeoutMs: 100, onFailure: (reason, error, code) => recordProfileFailure(directory, 'parent-full', reason, error, code) },
    receipt: () => JSON.parse(readFileSync(join(directory, 'profile-failure.json'), 'utf8')),
  }
}

test('constructor failure saves only bounded code and message identity, preserving first failure', async (t) => {
  const { directory, options, receipt } = fixture(t)
  const error = Object.assign(new Error('private token/path'), { code: 'ERR_WORKER_INVALID_EXEC_ARGV' })
  await assert.rejects(startDiagnosticWorker(() => { throw error }, options), /worker-constructor/)
  assert.equal(receipt().code, error.code)
  assert.equal(receipt().messageBytes, 18)
  assert.equal(receipt().messageSha256.length, 64)
  assert.equal(readFileSync(join(directory, 'profile-failure.json'), 'utf8').includes('private'), false)
  assert.equal(statSync(join(directory, 'profile-failure.json')).mode & 0o777, 0o600)
  recordProfileFailure(directory, 'parent-full', 'later-failure')
  assert.equal(receipt().reason, 'worker-constructor')
})

test('real clean worker exit before readiness rejects instead of hanging', { timeout: 2000 }, async (t) => {
  const { options, receipt } = fixture(t)
  options.readinessTimeoutMs = 1500
  await assert.rejects(startDiagnosticWorker(() => new Worker('', { eval: true }), options), /exit-before-ready/)
  assert.equal(receipt().exitCode, 0)
})

test('real startup error saves a sanitized native code', { timeout: 2000 }, async (t) => {
  const { options, receipt } = fixture(t)
  options.readinessTimeoutMs = 1500
  await assert.rejects(startDiagnosticWorker(() => new Worker('throw Object.assign(new Error("secret"), {code: "ERR_INSPECTOR_TEST"})', { eval: true }), options), /worker-error/)
  assert.equal(receipt().code, 'ERR_INSPECTOR_TEST')
  assert.equal(receipt().messageBytes, 6)
})

test('ready worker exiting before completion rejects its completion promise', async (t) => {
  const { options, receipt } = fixture(t)
  const worker = new EventEmitter()
  worker.terminate = async () => 0
  const pending = startDiagnosticWorker(() => worker, options)
  worker.emit('message', { type: 'ready' })
  const profile = await pending
  worker.emit('exit', 0)
  await assert.rejects(profile.done, /exit-before-done/)
  assert.equal(receipt().reason, 'exit-before-done')
})

test('readiness deadline terminates its worker and records an incomplete capture', async (t) => {
  const { options, receipt } = fixture(t)
  const worker = new EventEmitter()
  let terminated = false
  worker.terminate = async () => { terminated = true; return 0 }
  options.readinessTimeoutMs = 10
  await assert.rejects(startDiagnosticWorker(() => worker, options), /readiness-timeout/)
  assert.equal(terminated, true)
  assert.equal(receipt().incomplete, true)
})

test('ready/done/clean exit succeeds without a failure record', async (t) => {
  const { directory, options } = fixture(t)
  const worker = new EventEmitter()
  worker.terminate = async () => { throw new Error('must not terminate a completed worker') }
  const pending = startDiagnosticWorker(() => worker, options)
  worker.emit('message', { type: 'ready' })
  const profile = await pending
  worker.emit('message', { type: 'done' })
  worker.emit('exit', 0)
  await profile.done
  assert.throws(() => readFileSync(join(directory, 'profile-failure.json')), { code: 'ENOENT' })
})

test('delayed asynchronous startup stays alive when the control port is referenced first', { timeout: 3000 }, async (t) => {
  const { directory, options, receipt } = fixture(t)
  options.readinessTimeoutMs = 2000
  const source = `import { parentPort } from 'node:worker_threads'
await new Promise(() => {})
parentPort.postMessage({ type: 'ready' })
parentPort.postMessage({ type: 'done' })
parentPort.close()
`
  const path = join(directory, 'startup.mjs')
  writeFileSync(path, source)
  // The synthetic fixture has no corpus or private inputs and records no profile.
  await assert.rejects(startDiagnosticWorker(() => new Worker(path, { stderr: true }), options), /exit-before-ready/)
  assert.equal(receipt().exitCode, 13)
  writeFileSync(path, source.replace('await new Promise(() => {})', "await new Promise(resolve => parentPort.once('message', resolve))"))
  const profile = await startDiagnosticWorker(() => {
    const worker = new Worker(path, { stderr: true })
    worker.postMessage('initialize')
    return worker
  }, options)
  await profile.done
})
