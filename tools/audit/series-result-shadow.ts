import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { transparentGprModelMetadata, type SeriesResultDateBatch } from '../../src/domains/rankings/build.ts'

export const MAX_BATCH_BYTES = 64 << 20
const model = { version: transparentGprModelMetadata.version, configHash: transparentGprModelMetadata.configHash }

export function sha256(bytes: string | Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function numberBits(value: number) {
  assert(Number.isFinite(value), 'Nonfinite calculation value')
  const buffer = Buffer.allocUnsafe(8)
  buffer.writeDoubleBE(value)
  return buffer.toString('hex')
}

export function encodeSeriesResultRequest(dates: readonly SeriesResultDateBatch[]) {
  const request = {
    schema: 'series-result-batch-v1', model,
    dates: dates.map((date) => ({
      utcDate: date.utcDate, authoritativeMatchIds: date.authoritativeMatchIds,
      series: date.series.map(({ seriesId, matchIds, input }) => ({
        seriesId, matchIds,
        input: {
          teams: input.teams.map((team) => ({ ...team,
            currentPowerRating: numberBits(team.currentPowerRating), uncertainty: numberBits(team.uncertainty),
            rosterContinuity: team.rosterContinuity === undefined ? null : numberBits(team.rosterContinuity),
          })),
          bestOf: input.bestOf, observedOutcomeA: numberBits(input.observedOutcomeA), observedOutcomeB: numberBits(input.observedOutcomeB),
          strengthSignal: numberBits(input.strengthSignal), eventK: numberBits(input.eventK), international: input.international,
        },
      })),
    })),
  }
  for (const date of request.dates) assert(Buffer.byteLength(JSON.stringify(date)) <= 8 << 20, 'Complete date exceeds 8 MiB')
  const bytes = Buffer.from(JSON.stringify(request))
  assert(bytes.length <= MAX_BATCH_BYTES, 'Request exceeds 64 MiB')
  return bytes
}

function record(value: unknown): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object')
}
function keys(value: Record<string, unknown>, expected: readonly string[]) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'Native output fields differ')
}

export function compareSeriesResultResponse(value: unknown, dates: readonly SeriesResultDateBatch[], request: Uint8Array) {
  record(value)
  keys(value, ['schema', 'requestSha256', 'model', 'dates'])
  assert.equal(value.schema, 'series-result-response-v1')
  assert.equal(value.requestSha256, sha256(request), 'Native input hash mismatch')
  assert.deepEqual(value.model, model, 'Native model mismatch')
  assert(Array.isArray(value.dates), 'Missing native dates')
  assert.equal(value.dates.length, dates.length, 'Native date count differs')
  let seriesCount = 0
  let fieldsCompared = 0
  for (const [dateIndex, expectedDate] of dates.entries()) {
    const date: unknown = value.dates[dateIndex]
    record(date)
    keys(date, ['utcDate', 'authoritativeMatchIds', 'series'])
    assert.equal(date.utcDate, expectedDate.utcDate, 'Native date order differs')
    assert.deepEqual(date.authoritativeMatchIds, expectedDate.authoritativeMatchIds, 'Native date membership differs')
    assert(Array.isArray(date.series), 'Missing native series')
    assert.equal(date.series.length, expectedDate.series.length, 'Native series count differs')
    for (const [index, expected] of expectedDate.series.entries()) {
      const series: unknown = date.series[index]
      record(series)
      keys(series, ['seriesId', 'matchIds', 'result'])
      assert.equal(series.seriesId, expected.seriesId, 'Native series order differs')
      assert.deepEqual(series.matchIds, expected.matchIds, 'Native series membership differs')
      record(series.result)
      const entries = Object.entries(expected.nodeResult)
      assert.equal(entries.length, 24, 'Node series result contract changed')
      keys(series.result, entries.map(([name]) => name))
      for (const [name, expectedValue] of entries) {
        const bits: unknown = series.result[name]
        assert(typeof bits === 'string' && /^[\da-f]{16}$/.test(bits), 'Malformed native result bits')
        assert.equal(bits, numberBits(expectedValue), `${expectedDate.utcDate} ${expected.seriesId} ${name}`)
        fieldsCompared++
      }
      seriesCount++
    }
  }
  return { dates: dates.length, series: seriesCount, fieldsCompared, mismatches: 0 }
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

export async function runSeriesResultShadow({ dates, binaryPath, outputDir, deadlineMs = 120_000 }: {
  dates: readonly SeriesResultDateBatch[]
  binaryPath: string
  outputDir: string
  deadlineMs?: number
}) {
  const binary = await realpath(binaryPath)
  const binarySha256 = sha256(await readFile(binary))
  const request = encodeSeriesResultRequest(dates)
  await mkdir(outputDir, { recursive: true })
  const inputPath = join(outputDir, 'request.json')
  const outputPath = join(outputDir, 'response.json')
  await writeFile(inputPath, request, { flag: 'wx' })
  const reserved = await open(outputPath, 'wx')
  await reserved.close()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ['series-result', inputPath, outputPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdoutBytes = 0
    let stderrBytes = 0
    let stderr = ''
    let failure: Error | undefined
    const stop = (message: string) => {
      failure ??= new Error(message)
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => stop('Native series-result deadline exceeded'), deadlineMs)
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
      else if (code !== 0) reject(new Error(`Native series-result exited ${code ?? signal}: ${stderr}`))
      else resolve()
    })
  })
  assert.equal(sha256(await readFile(binary)), binarySha256, 'Native executable changed during run')
  const response = await readBounded(outputPath, MAX_BATCH_BYTES)
  const counts = compareSeriesResultResponse(JSON.parse(response.toString('utf8')), dates, request)
  return { ...counts, requestSha256: sha256(request), responseSha256: sha256(response), binary, binarySha256 }
}
