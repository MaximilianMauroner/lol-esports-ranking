// Unpublished, opt-in causal capture. Never use its timings as a gate receipt.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { cpus, platform } from 'node:os'
import { getHeapStatistics } from 'node:v8'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { Session } from 'node:inspector'
import { recordProfileFailure, startDiagnosticWorker } from './diagnostic-profile-lifecycle.mjs'

const output = process.env.RANKING_BENCHMARK_DIAGNOSTICS
export const diagnosticsEnabled = Boolean(output && process.argv.some((arg) => arg.endsWith('/benchmark-incremental-ranking.ts') || arg === 'scripts/benchmark-incremental-ranking.ts'))
const mode = process.argv.find((arg) => ['--benchmark-worker', '--benchmark-verifier', '--calibration-worker'].includes(arg)) ?? 'parent'
const eventLimit = 512 * 1024
const profileLimit = 4 * 1024 * 1024
let eventBytes = 0
let eventCapped = false
let sequence = 0
const spans = []
const trackedChildren = new Set()
const environmentKeys = ['RANKING_BENCHMARK_REPEATS', 'RANKING_BENCHMARK_MATCH_COUNT', 'RANKING_RAW_SOURCE_WORKER', 'RANKING_PROVIDER_FETCH_WORKER', 'RANKING_REFRESH_WORKER', 'RANKING_REFRESH_BINARY']
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function stamp(pid) {
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').slice(1).join(')').trim().split(/\s+/)
  return { pid, ppid: Number(fields[1]), startStamp: fields[19], state: fields[0] }
}

// Keep only argument identity, never arbitrary values, URLs or environment.
function argumentIdentity(args) {
  const safe = new Set(['--expose-gc', '--import', 'tsx', '--enforce-targets', '--benchmark-worker', '--benchmark-verifier', '--calibration-worker'])
  return args.map((arg) => safe.has(arg) || arg === 'scripts/benchmark-incremental-ranking.ts' ? arg : { sha256: sha256(arg), bytes: Buffer.byteLength(arg) })
}

function event(value) {
  if (!diagnosticsEnabled || !isMainThread || eventCapped) return
  const line = `${JSON.stringify({ pid: process.pid, mode, monotonicMs: performance.now(), ...value })}\n`
  if (eventBytes + Buffer.byteLength(line) > eventLimit - 256) {
    eventCapped = true
    appendFileSync(join(output, `events-${process.pid}.jsonl`), `${JSON.stringify({ pid: process.pid, type: 'event-cap', incomplete: true })}\n`)
    return
  }
  appendFileSync(join(output, `events-${process.pid}.jsonl`), line)
  eventBytes += Buffer.byteLength(line)
}

function memory() {
  return { ...process.memoryUsage(), cpu: process.cpuUsage() }
}

if (diagnosticsEnabled && isMainThread) {
  mkdirSync(output, { recursive: true, mode: 0o700 })
  // 24 logs * 512 KiB + three profiles * 4 MiB + owned/terminal/manifest
  // caps of 1 MiB each leave at least 5 MiB below the total 32 MiB ceiling.
  let claimed = false
  for (let slot = 0; slot < 24; slot += 1) {
    try { mkdirSync(join(output, `process-slot-${slot}`), { mode: 0o700 }); claimed = true; break }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  if (!claimed) throw new Error('Diagnostic process log cap reached')
  writeFileSync(join(output, `events-${process.pid}.jsonl`), '', { flag: 'wx', mode: 0o600 })
  event({ type: 'identity', ...stamp(process.pid), executable: process.execPath, argv: argumentIdentity(process.argv), execArgv: argumentIdentity(process.execArgv), node: process.version, platform: platform(), cpuModel: cpus()[0]?.model, heapSizeLimit: getHeapStatistics().heap_size_limit,
    environment: Object.fromEntries(environmentKeys.map((key) => [key, process.env[key] === undefined ? null : { sha256: sha256(process.env[key]), bytes: Buffer.byteLength(process.env[key]) }])),
    nodeOptions: process.env.NODE_OPTIONS === undefined ? null : { sha256: sha256(process.env.NODE_OPTIONS), bytes: Buffer.byteLength(process.env.NODE_OPTIONS) },
    repetition: basename(process.env.RANKING_BENCHMARK_ROOT ?? '') })
  // Calibration has no diagnostic timer during its fixed timed workload.
  if (mode !== '--calibration-worker') {
    const timer = setInterval(() => event({ type: 'sample', activeSpans: spans.map(({ id, name }) => ({ id, name })), memory: memory() }), 250)
    timer.unref()
    process.once('exit', () => clearInterval(timer))
  }
  process.once('exit', (code) => event({ type: 'exit', code, activeSpans: spans.map(({ id, name }) => ({ id, name })) }))
}

export function diagnosticBegin(name, counts = {}) {
  if (!diagnosticsEnabled) return undefined
  const span = { id: ++sequence, name, started: performance.now(), cpu: process.cpuUsage() }
  const overlappingActiveIds = spans.map(({ id }) => id)
  spans.push(span)
  event({ type: 'begin', id: span.id, overlappingActiveIds, name, counts, memory: memory() })
  return span
}

export function diagnosticEnd(span, counts = {}) {
  if (!span) return
  event({ type: 'end', id: span.id, name: span.name, wallMs: performance.now() - span.started, cpu: process.cpuUsage(span.cpu), counts, memory: memory() })
  const index = spans.indexOf(span)
  if (index >= 0) spans.splice(index, 1)
}

export function diagnosticChild(child) {
  if (!diagnosticsEnabled || !child.pid || trackedChildren.has(child.pid)) return
  trackedChildren.add(child.pid)
  try { event({ type: 'spawn', ...stamp(child.pid), argv: argumentIdentity(child.spawnargs ?? []) }) }
  catch { event({ type: 'spawn-identity-missing', incomplete: true }) }
}

export function diagnosticFiles(paths, root) {
  if (!diagnosticsEnabled) return
  for (const path of [...new Set(paths)].sort()) {
    const bytes = readFileSync(path)
    event({ type: 'corpus', logicalPath: relative(root, path), bytes: bytes.byteLength, sha256: sha256(bytes) })
  }
}

export function firstDiagnosticRepetition(root) {
  return diagnosticsEnabled && basename(root) === 'isolated-1'
}

// Main-thread Inspector work happens from a separate thread so profile deadlines
// and 15-second checkpoints do not depend on the model event loop being free.
export async function diagnosticProfile(kind, name) {
  if (!diagnosticsEnabled) return undefined
  const allowed = { 'parent-full': ['allocation', 180_000], 'verifier-full': ['allocation', 180_000], 'refresh-cpu': ['cpu', 30_000] }
  if (allowed[name]?.[0] !== kind) throw new Error('Unapproved diagnostic profile')
  return startDiagnosticWorker(() => new Worker(new URL(import.meta.url), {
    workerData: { kind, name, output, durationMs: allowed[name][1], repository: process.cwd() },
  }), {
    onFailure: (reason, error, exitCode) => recordProfileFailure(output, name, reason, error, exitCode),
    onMessage: (message) => event({ type: 'profiler', name, ...message }),
  })
}

export async function diagnosticStopProfile(profile) {
  if (!profile) return
  profile.worker.postMessage('stop')
  await profile.done
}

if (!isMainThread && workerData?.name) await profileWorker()
if (isMainThread && process.argv[2] === '--capture-run') process.exitCode = await captureRun(process.argv[3])
if (isMainThread && process.argv[2] === '--prepare-dependencies') process.exitCode = await captureRun(process.argv[3], true)

async function captureRun(directory, preparation = false) {
  if (!directory || readdirSync(directory).length !== 1 || !readdirSync(directory).includes('manifest.json')) throw new Error('Capture requires a fresh manifest-only directory')
  const cgroup = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((line) => line.startsWith('0::/'))?.slice(3)
  if (!cgroup?.endsWith('/fleet-build.service')) throw new Error('Capture is outside the build guard')
  const group = join('/sys/fs/cgroup', cgroup)
  const controls = Object.fromEntries(['memory.max', 'memory.swap.max', 'memory.oom.group'].map((key) => [key, readFileSync(join(group, key), 'utf8').trim()]))
  if (controls['memory.max'] !== '3221225472' || controls['memory.swap.max'] !== '0' || controls['memory.oom.group'] !== '1') throw new Error('Capture guard controls differ')
  const args = preparation ? ['install', '--frozen-lockfile'] : ['run', 'benchmark:incremental:gate']
  const child = spawn('pnpm', args, { cwd: process.cwd(), env: preparation ? process.env : { ...process.env, RANKING_BENCHMARK_DIAGNOSTICS: directory }, stdio: ['ignore', 'pipe', 'pipe'] })
  const identities = new Map([[process.pid, stamp(process.pid)]])
  const ownedFile = join(directory, 'owned.jsonl')
  const logFile = join(directory, 'terminal.log')
  let ownedBytes = 0
  let stdoutBytes = 0
  let stderrBytes = 0
  const stdout = []
  const stderrHash = createHash('sha256')
  const startupErrorCodes = new Set()
  const errorTails = { stdout: '', stderr: '' }
  let incomplete = false
  let timedOut = false
  let peak = 0
  let swapPeak = 0
  const started = performance.now()
  function record(value) {
    const line = `${JSON.stringify(value)}\n`
    if (ownedBytes + Buffer.byteLength(line) > 1024 * 1024) { incomplete = true; return }
    appendFileSync(ownedFile, line, { mode: 0o600 })
    ownedBytes += Buffer.byteLength(line)
  }
  function errorCodes(chunk, stream) {
    const text = errorTails[stream] + chunk.toString('utf8')
    errorTails[stream] = text.slice(-96)
    // A chunk ending is not an observed delimiter. Wait for the next chunk or
    // stream end so partial tokens cannot consume the eight-code budget.
    for (const code of text.match(/\bERR_PNPM_[A-Z0-9_]{1,71}(?=[^A-Za-z0-9_])/g) ?? []) {
      if (startupErrorCodes.size >= 8 || startupErrorCodes.has(code)) continue
      startupErrorCodes.add(code)
      record({ type: 'pnpm-error-code', code })
    }
  }
  function discover(identity) {
    try {
      if (stamp(identity.pid).startStamp !== identity.startStamp) return
      const children = readFileSync(`/proc/${identity.pid}/task/${identity.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean)
      for (const value of children) {
        const pid = Number(value)
        if (identities.has(pid) || identities.size >= 64) continue
        const next = stamp(pid)
        if (next.ppid !== identity.pid) continue
        const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
        identities.set(pid, next)
        record({ type: 'owned-first-seen', ...next, argv: argumentIdentity(argv), evidence: 'observed-parent-link; short-lived descendants may be missed' })
      }
    } catch { /* An owned process may exit between reads. */ }
  }
  function sample() {
    if (readdirSync(directory).includes('profile-failure.json')) {
      record({ type: 'profile-watchdog-failure', incomplete: true })
      process.exit(125)
    }
    for (const identity of identities.values()) discover(identity)
    try {
      const current = Number(readFileSync(join(group, 'memory.current'), 'utf8'))
      const swap = Number(readFileSync(join(group, 'memory.swap.current'), 'utf8'))
      peak = Math.max(peak, current); swapPeak = Math.max(swapPeak, swap)
      record({ type: 'group-sample', elapsedMs: performance.now() - started, bytes: current, swap })
    } catch { incomplete = true }
  }
  child.stdout.on('data', (chunk) => {
    errorCodes(chunk, 'stdout')
    const remaining = 1024 * 1024 - stdoutBytes
    if (chunk.length > remaining) incomplete = true
    if (remaining > 0) stdout.push(chunk.subarray(0, remaining))
    stdoutBytes += Math.min(chunk.length, remaining)
  })
  child.stderr.on('data', (chunk) => {
    errorCodes(chunk, 'stderr')
    stderrBytes += chunk.length
    stderrHash.update(chunk)
    // Save only numeric GC evidence and the known fatal classification.
    const text = chunk.toString('utf8')
    const gc = text.match(/\[(\d+):0x[a-f0-9]+\]\s+(\d+) ms:\s+(Mark-Compact|Scavenge)/)
    if (gc) record({ type: 'gc-observed', pid: Number(gc[1]), v8ElapsedMs: Number(gc[2]), collector: gc[3], evidence: 'chunk-matched; incomplete GC stream' })
    if (text.includes('FATAL ERROR: Reached heap limit')) record({ type: 'v8-heap-limit', evidence: 'fatal string; process attribution requires matching owned identity' })
  })
  record({ type: 'launcher', ...stamp(process.pid), controls, command: ['pnpm', ...args], preparation })
  if (child.pid) { const identity = stamp(child.pid); identities.set(child.pid, identity); record({ type: 'spawn', ...identity, argv: argumentIdentity(child.spawnargs) }) }
  sample()
  const sampler = setInterval(sample, 250)
  const timeout = setTimeout(() => {
    timedOut = true
    record({ type: 'timeout', elapsedMs: performance.now() - started })
    // Exiting the guarded command makes the service owner end; systemd then
    // kills the entire owned group. No signal is sent to an unrelated PID.
    process.exit(124)
  }, 20 * 60_000)
  const status = await new Promise((resolveStatus) => {
    child.once('error', () => resolveStatus(125))
    child.once('close', (code, signal) => resolveStatus(code ?? (signal === 'SIGABRT' ? 134 : 128)))
  })
  clearTimeout(timeout)
  clearInterval(sampler)
  for (const stream of ['stdout', 'stderr']) errorCodes(Buffer.from(' '), stream)
  sample()
  const text = Buffer.concat(stdout).toString('utf8')
  let receipt
  if (!preparation) {
    try { receipt = JSON.parse(text.slice(text.indexOf('{'))) } catch { incomplete = true }
  }
  const sanitized = scalarReceipt(receipt)
  writeFileSync(logFile, `${JSON.stringify({ diagnosticOnly: true, preparation, startupErrorCodes: [...startupErrorCodes], stdoutSha256: sha256(text), stdoutRetainedBytes: stdoutBytes, stderrSha256: stderrHash.digest('hex'), stderrBytes, receipt: sanitized })}\n`, { mode: 0o600 })
  record({ type: 'terminal', status, timedOut, incomplete, elapsedMs: performance.now() - started, peakSampledGroupBytes: peak, peakSampledSwapBytes: swapPeak, identities: [...identities.values()] })
  process.stdout.write(`${JSON.stringify({ diagnosticOnly: true, status, incomplete, elapsedMs: performance.now() - started, peakSampledGroupBytes: peak, peakSampledSwapBytes: swapPeak })}\n`)
  return status
}

function scalarReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return undefined
  const keys = ['repeat', 'repeatCount', 'computeMs', 'normalizedCompute', 'calibrationMs', 'mainCpuMs', 'peakRssBytes', 'maxRssBytes', 'mainMaxRssBytes', 'rawChildMaxRssBytes', 'sampledPeakRssBytes', 'verifierMs', 'verifierMaxRssBytes', 'uploadedBytes', 'storagePutCount', 'changedPaths', 'reusedPaths', 'sampleCount', 'parity', 'corpusValid', 'replayedMatchCount', 'fullSnapshotWritten', 'fullRawRewrite', 'baselineRawDeltaCount', 'reconciliationMatchCount', 'materializedScopeCount']
  const result = Object.fromEntries(keys.filter((key) => typeof receipt[key] === 'number' || typeof receipt[key] === 'boolean').map((key) => [key, receipt[key]]))
  if (receipt.calibration) result.calibration = { medianMs: receipt.calibration.medianMs, runsMs: receipt.calibration.runsMs?.filter((value) => typeof value === 'number') }
  if (Array.isArray(receipt.repetitions)) result.repetitions = receipt.repetitions.slice(0, 3).map(scalarReceipt)
  if (Array.isArray(receipt.refreshStages)) result.refreshStages = receipt.refreshStages.slice(0, 32).map((stage) => ({
    name: ['restore', 'fetch', 'replay', 'crunch', 'upload', 'publish', 'player-model', 'raw-prepare', 'raw-import', 'raw-download'].includes(stage.name) ? stage.name : { sha256: sha256(String(stage.name)) },
    durationMs: typeof stage.durationMs === 'number' ? stage.durationMs : undefined,
  }))
  return result
}

async function profileWorker() {
  const { kind, name, output: directory, durationMs, repository } = workerData
  // Pending Inspector promises alone do not keep the thread alive. Reference
  // its control port before the first RPC, including delayed initialization.
  let requestStop
  let stopRequested = false
  parentPort.on('message', () => {
    stopRequested = true
    requestStop?.()
  })
  const session = new Session()
  session.connectToMainThread()
  const post = (method, params = {}) => new Promise((resolveResult, rejectResult) => session.post(method, params, (error, result) => error ? rejectResult(error) : resolveResult(result)))
  const domain = kind === 'cpu' ? 'Profiler' : 'HeapProfiler'
  await post(`${domain}.enable`)
  if (kind === 'cpu') {
    await post('Profiler.setSamplingInterval', { interval: 1000 })
    await post('Profiler.start')
  } else await post('HeapProfiler.startSampling', { samplingInterval: 512 * 1024 })
  const started = performance.now()
  let stopped = false
  let completed = false
  let queue = Promise.resolve()
  function save(profile, final) {
    const sanitized = sanitizeProfile(profile, repository)
    let bytes = Buffer.from(JSON.stringify({ kind, name, final, elapsedMs: performance.now() - started, ...sanitized }))
    if (bytes.length > profileLimit) bytes = Buffer.from(JSON.stringify({ kind, name, incomplete: true, reason: 'profile-byte-cap' }))
    const path = join(directory, `${name}.json`)
    // No second full profile file: keep the total disk cap even during saves.
    // A crash during this overwrite makes that checkpoint incomplete evidence.
    writeFileSync(path, bytes, { mode: 0o600 })
  }
  function stop(reason) {
    if (stopped) return
    stopped = true
    clearInterval(checkpoint)
    clearTimeout(deadline)
    queue = queue.then(async () => {
      const { profile } = await post(kind === 'cpu' ? 'Profiler.stop' : 'HeapProfiler.stopSampling')
      save(profile, true)
      session.disconnect()
      completed = true
      clearTimeout(hardDeadline)
      parentPort.postMessage({ type: 'done', reason, elapsedMs: performance.now() - started })
      parentPort.close()
    })
    queue.catch(() => fail('inspector-stop-error'))
  }
  const checkpoint = setInterval(() => {
    if (stopped || kind === 'cpu') return
    queue = queue.then(async () => { const { profile } = await post('HeapProfiler.getSamplingProfile'); save(profile, false) })
    queue.catch(() => stop('checkpoint-error'))
  }, 15_000)
  // Leave one second for the stop RPC. The independent hard watchdog never
  // queues behind an inspector request and ends the capture if closure is unproved.
  const deadline = setTimeout(() => stop('deadline'), durationMs - 1000)
  const hardDeadline = setTimeout(() => { if (!completed) fail('profile-hard-deadline') }, durationMs)
  function fail(reason) {
    recordProfileFailure(directory, name, reason)
    parentPort.postMessage({ type: 'failed', reason, incomplete: true })
    process.exit(1) // Worker thread only; launcher then ends the owned group.
  }
  requestStop = () => stop('phase-end')
  parentPort.postMessage({ type: 'ready', samplingInterval: kind === 'cpu' ? 1000 : 512 * 1024, maxDurationMs: durationMs })
  if (stopRequested) requestStop()
}

function sanitizeProfile(profile, repository) {
  let count = 0
  let incomplete = false
  const frame = (value) => {
    const url = value?.url ?? ''
    const source = url.replace(/^file:\/\//, '')
    return { functionName: String(value?.functionName ?? '').replace(/[^\w .<>:$/-]/g, '?').slice(0, 128),
      url: source.startsWith(`${repository}/`) ? relative(repository, source) : url.startsWith('node:') ? url.slice(0, 256) : url ? `<external:${sha256(url)}>` : '',
      lineNumber: value?.lineNumber, columnNumber: value?.columnNumber }
  }
  const node = (value) => {
    if (++count > 20_000) { incomplete = true; return { omitted: true } }
    return { id: value.id, callFrame: frame(value.callFrame), selfSize: value.selfSize, hitCount: value.hitCount,
      children: value.children?.map((child) => typeof child === 'number' ? child : node(child)) }
  }
  const nodes = profile.nodes?.slice(0, 20_000).map(node)
  if (profile.nodes?.length > 20_000) incomplete = true
  if (profile.samples?.length > 40_000 || profile.timeDeltas?.length > 40_000) incomplete = true
  return { incomplete, profile: { head: profile.head ? node(profile.head) : undefined, nodes,
    samples: profile.samples?.slice(0, 40_000), timeDeltas: profile.timeDeltas?.slice(0, 40_000), startTime: profile.startTime, endTime: profile.endTime } }
}
