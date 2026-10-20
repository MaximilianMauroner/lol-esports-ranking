import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transparentGprModelMetadata, type SeriesPassCapture, type SeriesPassFrame } from '../../src/domains/rankings/build.ts'

export const MAX_BATCH_BYTES = 64 << 20
export const MAX_DATE_BYTES = 8 << 20
const BATCH_INPUT_BUDGET = 16 << 20
const model = { version: transparentGprModelMetadata.version, configHash: transparentGprModelMetadata.configHash }
const RESPONSE_ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({
  schema: 'series-pass-response-v1', requestSha256: '0'.repeat(64), model, dates: [],
}))

type SizedDate = Readonly<{ capture: SeriesPassCapture; requestBytes: number; responseBytes: number }>

export function sha256(bytes: string | Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}
export function numberBits(value: number) {
  assert(Number.isFinite(value), 'Nonfinite calculation value')
  const buffer = Buffer.allocUnsafe(8)
  buffer.writeDoubleBE(value)
  return buffer.toString('hex')
}

type WireNumbers<T> = T extends number ? string : T extends readonly unknown[] ? { [K in keyof T]: WireNumbers<T[K]> }
  : T extends object ? { [K in keyof T]: WireNumbers<T[K]> } : T
function wireNumbers<T>(value: T): WireNumbers<T> {
  if (typeof value === 'number') return numberBits(value) as WireNumbers<T>
  if (Array.isArray(value)) return value.map(wireNumbers) as WireNumbers<T>
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, wireNumbers(child)])) as WireNumbers<T>
  }
  return value as WireNumbers<T>
}

function wireFrame(frame: SeriesPassFrame) {
  return {
    ...wireNumbers(frame),
    series: frame.series.map((series) => ({
      seriesId: series.seriesId, teams: series.teams, leagues: series.leagues, bestOf: series.bestOf, wins: series.wins,
      members: series.members.map((member) => ({
        ...wireNumbers(member), winner: member.winner,
        sides: member.sides.map((side) => ({ ...wireNumbers(side), team: side.team, league: side.league })),
      })),
    })),
  }
}
export function encodeSeriesPassRequest(frames: readonly SeriesPassFrame[]) {
  const dates = frames.map(wireFrame)
  for (const date of dates) assert(Buffer.byteLength(JSON.stringify(date)) <= MAX_DATE_BYTES, 'Complete date exceeds 8 MiB')
  const bytes = Buffer.from(JSON.stringify({ schema: 'series-pass-batch-v1', model, dates }))
  assert(bytes.length <= MAX_BATCH_BYTES, 'Request exceeds 64 MiB')
  return bytes
}

export function seriesPassDateResponseBytes(expected: SeriesPassCapture['expected']) {
  const size = (value: unknown, indexes = false): number => {
    if (typeof value === 'number') return Buffer.byteLength(indexes ? JSON.stringify(value) : JSON.stringify(numberBits(value)))
    if (Array.isArray(value)) return 2 + Math.max(0, value.length - 1) + value.reduce((sum, child) => sum + size(child, indexes), 0)
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value)
      const source = entries.length === 1 && entries[0][0] === 'member'
      return 2 + Math.max(0, entries.length - 1) + entries.reduce((sum, [key, child]) =>
        sum + Buffer.byteLength(JSON.stringify(key)) + 1 + size(child, indexes || source || key === 'inserted'), 0)
    }
    return Buffer.byteLength(JSON.stringify(value))
  }
  return size(expected)
}

function record(value: unknown): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object')
}
function keys(value: Record<string, unknown>, expected: readonly string[], path: string) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${path} fields differ`)
}
export function compareSeriesPassResponse(value: unknown, captures: readonly SeriesPassCapture[], request: Uint8Array) {
  record(value)
  keys(value, ['schema', 'requestSha256', 'model', 'dates'], 'Native envelope')
  assert.equal(value.schema, 'series-pass-response-v1')
  assert.equal(value.requestSha256, sha256(request), 'Native input hash mismatch')
  assert.deepEqual(value.model, model, 'Native model mismatch')
  assert(Array.isArray(value.dates), 'Missing native dates')
  assert.equal(value.dates.length, captures.length, 'Native date count differs')
  const counts = {
    dates: captures.length, series: 0, members: 0, fieldsCompared: 0, numericFieldsCompared: 0,
    seriesResultFields: 0, memberFields: 0, memberNumericFields: 0, stateFields: 0, stateNumericFields: 0,
    mismatches: 0,
  }
  const compare = (actual: unknown, expected: unknown, path: string, section: 'series' | 'member' | 'state', indexes = false): void => {
    if (Array.isArray(expected)) {
      assert(Array.isArray(actual), `${path} must be an array`)
      assert.equal(actual.length, expected.length, `${path} length differs`)
      expected.forEach((child, index) => compare(actual[index], child, `${path}[${index}]`, section, indexes))
      return
    }
    if (expected !== null && typeof expected === 'object') {
      record(actual)
      const entries = Object.entries(expected)
      keys(actual, entries.map(([key]) => key), path)
      const source = entries.length === 1 && entries[0][0] === 'member'
      for (const [key, child] of entries) compare(actual[key], child, `${path}.${key}`, section, indexes || source || key === 'inserted')
      return
    }
    counts.fieldsCompared++
    if (section === 'member') counts.memberFields++
    if (section === 'state') counts.stateFields++
    if (typeof expected === 'number' && !indexes) {
      assert.equal(actual, numberBits(expected), path)
      counts.numericFieldsCompared++
      if (section === 'member') counts.memberNumericFields++
      if (section === 'state') counts.stateNumericFields++
    } else assert.deepEqual(actual, expected, path)
  }
  for (const [index, capture] of captures.entries()) {
    const actual: unknown = value.dates[index]
    record(actual)
    const { series, ...state } = capture.expected
    keys(actual, [...Object.keys(state), 'series'], capture.frame.utcDate)
    const { series: actualSeries, ...actualState } = actual
    compare(actualState, state, `${capture.frame.utcDate}.state`, 'state')
    assert(Array.isArray(actualSeries), 'Missing native series')
    assert.equal(actualSeries.length, series.length, 'Native series count differs')
    for (const [position, expected] of series.entries()) {
      const trail: unknown = actualSeries[position]
      record(trail)
      const { members, ...calculation } = expected
      keys(trail, [...Object.keys(calculation), 'members'], 'Series trail')
      const { members: actualMembers, ...actualCalculation } = trail
      const path = `${capture.frame.utcDate}.series[${position}]`
      compare(actualCalculation, calculation, path, 'series')
      assert.equal(Object.keys(expected.result).length, 24, 'Series result contract changed')
      counts.seriesResultFields += 24
      compare(actualMembers, members, `${path}.members`, 'member')
      counts.members += members.length
      counts.series++
    }
  }
  return counts
}

export async function readBounded(path: string, limit: number) {
  const file = await open(path, 'r')
  try {
    assert((await file.stat()).size <= limit, 'Output file exceeds byte limit')
    const buffer = Buffer.alloc(limit + 1)
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used)
      if (!bytesRead) break
      used += bytesRead
    }
    assert(used <= limit, 'Output file exceeds byte limit')
    return buffer.subarray(0, used)
  } finally {
    await file.close()
  }
}


async function runBatch({ captures, binary, outputDir, deadlineMs }: {
  captures: readonly SeriesPassCapture[]; binary: string; outputDir: string; deadlineMs: number
}) {
  const request = encodeSeriesPassRequest(captures.map((capture) => capture.frame))
  await mkdir(outputDir, { recursive: true })
  const inputPath = join(outputDir, 'request.json')
  const outputPath = join(outputDir, 'response.json')
  await writeFile(inputPath, request, { flag: 'wx' })
  const reserved = await open(outputPath, 'wx')
  await reserved.close()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ['series-pass', inputPath, outputPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdoutBytes = 0
    let stderrBytes = 0
    let stderr = ''
    let failure: Error | undefined
    const stop = (message: string) => {
      failure ??= new Error(message)
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => stop('Native series-pass deadline exceeded'), deadlineMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > 64 << 10) stop('Native stdout exceeds byte limit')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > 64 << 10) stop('Native stderr exceeds byte limit')
      else stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => { failure = error })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`Native series-pass exited ${code ?? signal}: ${stderr}`))
      else resolve()
    })
  })
  const response = await readBounded(outputPath, MAX_BATCH_BYTES)
  const counts = compareSeriesPassResponse(JSON.parse(response.toString('utf8')), captures, request)
  return { ...counts, requestSha256: sha256(request), responseSha256: sha256(response), inputPath, outputPath }
}

export async function runSeriesPassShadow({ captures, binaryPath, outputDir, deadlineMs = 120_000 }: {
  captures: readonly SeriesPassCapture[]
  binaryPath: string
  outputDir: string
  deadlineMs?: number
}) {
  assert(captures.length > 0, 'No complete dates to compare')
  assert(Number.isFinite(deadlineMs) && deadlineMs > 0, 'Invalid process deadline')
  const binary = await realpath(binaryPath)
  const binarySha256 = sha256(await readFile(binary))
  const chunks: SeriesPassCapture[][] = []
  let chunk: SeriesPassCapture[] = []
  let requestBytes = 0
  let responseBytes = RESPONSE_ENVELOPE_BYTES
  for (const capture of captures) {
    const date: SizedDate = {
      capture,
      requestBytes: Buffer.byteLength(JSON.stringify(wireFrame(capture.frame))),
      responseBytes: seriesPassDateResponseBytes(capture.expected),
    }
    assert(date.requestBytes <= MAX_DATE_BYTES, 'Complete date exceeds 8 MiB')
    assert(RESPONSE_ENVELOPE_BYTES + date.responseBytes <= MAX_BATCH_BYTES,
      `Complete date ${capture.frame.utcDate} response exceeds 64 MiB`)
    const commaBytes = chunk.length ? 1 : 0
    if (chunk.length && (requestBytes + date.requestBytes > BATCH_INPUT_BUDGET
      || responseBytes + commaBytes + date.responseBytes > MAX_BATCH_BYTES)) {
      chunks.push(chunk)
      chunk = []
      requestBytes = 0
      responseBytes = RESPONSE_ENVELOPE_BYTES
    }
    responseBytes += (chunk.length ? 1 : 0) + date.responseBytes
    chunk.push(date.capture)
    requestBytes += date.requestBytes
  }
  if (chunk.length) chunks.push(chunk)
  const batches: Awaited<ReturnType<typeof runBatch>>[] = []
  for (const [index, dates] of chunks.entries()) {
    batches.push(await runBatch({ captures: dates, binary, outputDir: join(outputDir, `batch-${index}`), deadlineMs }))
    assert.equal(sha256(await readFile(binary)), binarySha256, 'Native executable changed during run')
  }
  const total = (key: keyof ReturnType<typeof compareSeriesPassResponse>) => batches.reduce((sum, batch) => sum + batch[key], 0)
  return {
    dates: total('dates'), series: total('series'), members: total('members'), fieldsCompared: total('fieldsCompared'),
    numericFieldsCompared: total('numericFieldsCompared'), seriesResultFields: total('seriesResultFields'),
    memberFields: total('memberFields'), memberNumericFields: total('memberNumericFields'),
    stateFields: total('stateFields'), stateNumericFields: total('stateNumericFields'), mismatches: 0,
    batches, binary, binarySha256,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  assert.equal(args.length, 6, 'Usage: --captures <file> --binary <executable> --output-dir <new-directory>')
  const options = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    assert(['--captures', '--binary', '--output-dir'].includes(args[index]) && !options.has(args[index]), 'Invalid shadow option')
    options.set(args[index], args[index + 1])
  }
  const bytes = await readBounded(options.get('--captures')!, MAX_BATCH_BYTES)
  const captures: unknown = JSON.parse(bytes.toString('utf8'), (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'binary64' in value) {
      assert.deepEqual(Object.keys(value), ['binary64'])
      assert(typeof value.binary64 === 'string' && /^[\da-f]{16}$/.test(value.binary64), 'Malformed capture bits')
      const number = Buffer.from(value.binary64, 'hex').readDoubleBE()
      assert(Number.isFinite(number), 'Nonfinite capture bits')
      return number
    }
    return value
  })
  assert(Array.isArray(captures), 'Expected captured dates')
  for (const capture of captures) {
    record(capture)
    keys(capture, ['frame', 'expected'], 'Capture')
    record(capture.frame)
    record(capture.expected)
  }
  console.log(JSON.stringify(await runSeriesPassShadow({
    captures: captures as SeriesPassCapture[], binaryPath: options.get('--binary')!, outputDir: options.get('--output-dir')!,
  }), null, 2))
}
