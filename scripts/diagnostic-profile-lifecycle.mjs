import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Keep the first failure. Native messages may contain paths or private values.
export function recordProfileFailure(directory, name, reason, error, exitCode) {
  const message = error === undefined ? undefined : String(error.message ?? error)
  const code = typeof error?.code === 'string' && /^ERR_[A-Z0-9_]{1,76}$/.test(error.code) ? error.code : undefined
  const record = { name, reason, incomplete: true, code, exitCode,
    messageBytes: message === undefined ? undefined : Buffer.byteLength(message),
    messageSha256: message === undefined ? undefined : createHash('sha256').update(message).digest('hex') }
  try { writeFileSync(join(directory, 'profile-failure.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 }) }
  catch (failure) { if (failure.code !== 'EEXIST') throw failure }
}

// The factory boundary includes constructor failures, before a Worker exists.
export async function startDiagnosticWorker(createWorker, { onFailure, readinessTimeoutMs = 5000, onMessage = () => {} }) {
  let readyResolve, readyReject, doneResolve, doneReject
  let readyReceived = false
  let doneReceived = false
  let failed = false
  let worker
  let readinessDeadline
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject })
  // A startup failure must not create a second unobserved rejection.
  done.catch(() => {})
  function fail(reason, error, exitCode) {
    if (failed) return
    failed = true
    clearTimeout(readinessDeadline)
    let failure = new Error(`Diagnostic profile failed: ${reason}`)
    try { onFailure(reason, error, exitCode) }
    catch { failure = new Error('Diagnostic failure record could not be saved') }
    readyReject(failure)
    doneReject(failure)
    if (worker) void worker.terminate().catch(() => {})
  }
  try {
    worker = createWorker()
    readinessDeadline = setTimeout(() => fail('readiness-timeout'), readinessTimeoutMs)
    worker.on('message', (message) => {
      if (failed) return
      if (message.type === 'ready') { readyReceived = true; clearTimeout(readinessDeadline); readyResolve() }
      if (message.type === 'done') {
        if (!readyReceived) { fail('done-before-ready'); return }
        doneReceived = true
        doneResolve()
      }
      if (message.type === 'failed') fail('worker-reported-failure')
      onMessage(message)
    })
    worker.on('error', (error) => fail('worker-error', error))
    worker.on('exit', (code) => {
      clearTimeout(readinessDeadline)
      if (code !== 0 || !doneReceived) fail(readyReceived ? 'exit-before-done' : 'exit-before-ready', undefined, code)
    })
  } catch (error) { fail('worker-constructor', error) }
  await ready
  return { worker, done }
}
