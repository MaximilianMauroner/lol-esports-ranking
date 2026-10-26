import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ForecastCandidate, ForecastRequestFile } from '../../scripts/rankings/export-pregame-series.ts'
import type { ExactPregameProbabilityState, PregameForecastReceipt, SimpleEloState } from '../../src/domains/rankings/forecast.ts'

export type FilePin = { path: string; sha256: string }
export type ExportConfiguration = {
  cwd: string; node: string; entry: FilePin; commit: string
  manifest: FilePin; requests: FilePin; candidate: FilePin; output: string; timeoutMs: number
}
export type ParityConfiguration = {
  schema: 'forecast-consumer-parity-v1'
  consumer: { root: string; sourceDigests: FilePin[] }
  exporter: ExportConfiguration
  artifacts: { forecast: FilePin; manifest: FilePin; states: FilePin }
}
type StateRow = { modelStateId: string; modelStateHash: string; state: ExactPregameProbabilityState | SimpleEloState }
type ExportManifest = {
  sourceHash: string; sourceDigests: FilePin[]; sourceRoot?: string; baseSourceDigests?: FilePin[]
  configurationHash: string; dependencyLockHash: string
}
type Consumer = { verifyForecastExport(config: ExportConfiguration): { receipts: PregameForecastReceipt[] } }
const requiredConsumerFiles = ['src/lol/forecast-import.ts', 'src/lol/contracts.ts', 'src/lol/money.ts']
export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export function readRegular(path: string): Buffer {
  if (!isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error(`NONCANONICAL_FILE ${path}`)
  for (let part = path; ; part = dirname(part)) {
    if (lstatSync(part).isSymbolicLink()) throw new Error(`SYMLINK_FILE ${part}`)
    if (part === dirname(part)) break
  }
  const before = lstatSync(path)
  if (!before.isFile() || before.nlink !== 1) throw new Error(`NONREGULAR_OR_ALIASED_FILE ${path}`)
  const bytes = readFileSync(path)
  const after = lstatSync(path)
  if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`FILE_CHANGED ${path}`)
  }
  return bytes
}

export function readPin(pin: FilePin): Buffer {
  const bytes = readRegular(pin.path)
  if (!/^[a-f0-9]{64}$/.test(pin.sha256) || sha256(bytes) !== pin.sha256) throw new Error(`PIN_MISMATCH ${pin.path}`)
  return bytes
}

export function filePin(path: string): FilePin {
  return { path, sha256: sha256(readRegular(path)) }
}

function sourcePath(root: string, path: string): string {
  if (isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('INVALID_RELATIVE_SOURCE_PATH')
  }
  const target = resolve(root, path)
  if (relative(root, target).startsWith('..')) throw new Error('SOURCE_PATH_ESCAPE')
  return target
}

function consumerPins(configuration: ParityConfiguration): FilePin[] {
  const pins = configuration.consumer.sourceDigests
  assert.deepEqual(pins.map(pin => pin.path).sort(), [...requiredConsumerFiles].sort(), 'CONSUMER_CLOSURE_MISMATCH')
  return pins.map(pin => ({ ...pin, path: sourcePath(configuration.consumer.root, pin.path) }))
}

export function loadParityConfiguration(path: string, expectedHash: string): ParityConfiguration {
  const configuration = JSON.parse(readPin({ path, sha256: expectedHash }).toString()) as ParityConfiguration
  if (configuration.schema !== 'forecast-consumer-parity-v1') throw new Error('INVALID_PARITY_CONFIGURATION')
  return configuration
}

export async function verifyForecastParity(configuration: ParityConfiguration) {
  if (configuration.schema !== 'forecast-consumer-parity-v1') throw new Error('INVALID_PARITY_CONFIGURATION')
  const { exporter, artifacts } = configuration
  for (const path of [configuration.consumer.root, exporter.cwd]) {
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error('NONCANONICAL_ROOT')
  }
  assert.equal(artifacts.forecast.path, exporter.output, 'FORECAST_PATH_MISMATCH')
  assert.equal(artifacts.manifest.path, `${exporter.output}.manifest.json`, 'MANIFEST_PATH_MISMATCH')
  assert.equal(artifacts.states.path, `${exporter.output}.states.jsonl`, 'STATES_PATH_MISMATCH')
  const pins = [...consumerPins(configuration), exporter.entry, exporter.manifest, exporter.requests,
    exporter.candidate, ...Object.values(artifacts)]
  for (const pin of pins) readPin(pin)
  const consumer = await import(pathToFileURL(resolve(configuration.consumer.root, 'src/lol/forecast-import.ts')).href) as Consumer
  const imported = consumer.verifyForecastExport(exporter)
  const manifest = JSON.parse(readPin(artifacts.manifest).toString()) as ExportManifest
  const sourceRoot = manifest.sourceRoot ?? exporter.cwd
  const sourcePins = [...manifest.sourceDigests.map(pin => ({ ...pin, path: sourcePath(sourceRoot, pin.path) })),
    ...(manifest.baseSourceDigests ?? []).map(pin => ({ ...pin, path: sourcePath(exporter.cwd, pin.path) })),
    { path: sourcePath(sourceRoot, 'pnpm-lock.yaml'), sha256: manifest.dependencyLockHash }]
  for (const path of ['src/domains/rankings/forecast.ts', 'src/domains/rankings/build.ts']) {
    if (!manifest.sourceDigests.some(pin => pin.path === path)) throw new Error('MISSING_CANONICAL_PUBLIC_SOURCE')
  }
  for (const pin of sourcePins) readPin(pin)
  const api = await import(pathToFileURL(sourcePath(sourceRoot, 'src/domains/rankings/forecast.ts')).href) as typeof import('../../src/domains/rankings/forecast.ts')
  const model = await import(pathToFileURL(sourcePath(sourceRoot, 'src/domains/rankings/build.ts')).href) as typeof import('../../src/domains/rankings/build.ts')
  const candidate = JSON.parse(readPin(exporter.candidate).toString()) as ForecastCandidate
  if (candidate.modelKind !== undefined && !['ranking', 'simple-elo'].includes(candidate.modelKind)) throw new Error('UNSUPPORTED_CANDIDATE_KIND')
  const simpleElo = candidate.modelKind === 'simple-elo'
  if (simpleElo) {
    assert.equal(candidate.candidateId, api.simpleEloPolicy.candidateId, 'CANDIDATE_KIND_MISMATCH')
    assert.equal(candidate.parentCandidateId, null, 'ELO_PARENT_MISMATCH')
    assert.equal(candidate.calibrationFit, null, 'ELO_FIT_MISMATCH')
    assert.deepEqual(candidate.transform, { temperature: 1, calibrationOrder: 'game-before-series', dependence: 0 }, 'ELO_TRANSFORM_MISMATCH')
  } else if (candidate.candidateId === api.simpleEloPolicy.candidateId) throw new Error('RESERVED_ELO_IDENTITY')
  const configurationHash = sha256(JSON.stringify({ candidate, model: simpleElo ? api.simpleEloPolicy : model.transparentGprModelMetadata }))
  assert.equal(manifest.configurationHash, configurationHash, 'CANDIDATE_CONFIGURATION_MISMATCH')
  const requestFile = JSON.parse(readPin(exporter.requests).toString()) as ForecastRequestFile
  const requests = new Map(requestFile.requests.map(request => [request.seriesId, request]))
  assert.equal(requests.size, requestFile.requests.length, 'DUPLICATE_REQUEST')
  assert.equal(imported.receipts.length, requests.size, 'REQUEST_RECEIPT_COUNT_MISMATCH')
  const states = readPin(artifacts.states).toString().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as StateRow)
  assert.equal(states.length, imported.receipts.length, 'STATE_RECEIPT_COUNT_MISMATCH')
  const byState = new Map<string, StateRow['state']>()
  for (const row of states) {
    assert.equal(sha256(JSON.stringify(row.state)), row.modelStateHash, 'EXACT_STATE_HASH_MISMATCH')
    const identity = `${row.modelStateId}:${row.modelStateHash}`
    const prior = byState.get(identity)
    if (prior) assert.deepEqual(row.state, prior, 'CONFLICTING_EXACT_STATE')
    byState.set(identity, row.state)
  }
  const seen = new Set<string>()
  let predictorCalls = 0
  for (const receipt of imported.receipts) {
    const request = requests.get(receipt.seriesId)
    assert.ok(request, 'MISSING_REQUEST')
    assert.ok(!seen.has(receipt.seriesId), 'DUPLICATE_REQUEST_RECEIPT')
    seen.add(receipt.seriesId)
    for (const field of ['eventId', 'homeTeamId', 'awayTeamId', 'bestOf', 'scheduleRevision', 'scheduledStartAt', 'asOf', 'validUntil'] as const) {
      assert.equal(receipt[field], request[field], `REQUEST_IDENTITY_MISMATCH ${field}`)
    }
    assert.equal(receipt.evidenceMode, requestFile.evidenceMode, 'EVIDENCE_MODE_MISMATCH')
    assert.equal(receipt.availability, requestFile.availability, 'AVAILABILITY_MISMATCH')
    assert.ok(receipt.sourceObservedAt.includes(request.scheduleObservedAt), 'SCHEDULE_OBSERVATION_MISMATCH')
    assert.ok(receipt.inputDigests.some(pin => pin.path === exporter.requests.path && pin.sha256 === exporter.requests.sha256), 'REQUEST_INPUT_PIN_MISMATCH')
    assert.equal(receipt.candidateId, candidate.candidateId, 'CANDIDATE_ID_MISMATCH')
    assert.equal(receipt.parentCandidateId, candidate.parentCandidateId, 'CANDIDATE_PARENT_MISMATCH')
    assert.deepEqual(receipt.calibrationFit, candidate.calibrationFit, 'CANDIDATE_FIT_MISMATCH')
    const state = byState.get(`${receipt.modelStateId}:${receipt.modelStateHash}`)
    assert.ok(state, 'MISSING_EXACT_STATE')
    assert.equal(state.home.team, request.homeSourceTeam, 'HOME_STATE_ORIENTATION_MISMATCH')
    assert.equal(state.away.team, request.awaySourceTeam, 'AWAY_STATE_ORIENTATION_MISMATCH')
    const expected = simpleElo ? api.predictSimpleEloSeries(state as SimpleEloState, receipt)
      : api.predictPregameSeries({ state: state as ExactPregameProbabilityState, metadata: receipt, transform: candidate.transform })
    predictorCalls++
    for (const field of ['homeSeriesWinProbability', 'awaySeriesWinProbability', 'componentGameProbabilities',
      'eligible', 'exclusions', 'calibratorVersion', 'seriesConversionVersion'] as const) {
      assert.deepEqual(receipt[field], expected[field], `CANONICAL_PARITY_MISMATCH ${field}`)
    }
    assert.equal((receipt as PregameForecastReceipt & { modelKind?: string }).modelKind,
      simpleElo ? 'simple-elo' : undefined, 'RECEIPT_MODEL_KIND_MISMATCH')
  }
  for (const pin of [...pins, ...sourcePins]) readPin(pin)
  return { status: 'passed', evidenceMode: requestFile.evidenceMode, availability: requestFile.availability,
    candidateId: candidate.candidateId, modelKind: candidate.modelKind ?? 'ranking', receipts: imported.receipts.length,
    eligible: imported.receipts.filter(receipt => receipt.eligible).length, directPredictorCalls: predictorCalls,
    newRankingReplays: 0, sourceRoot, sourceHash: manifest.sourceHash, configurationHash,
    dependencyLockHash: manifest.dependencyLockHash, consumerRoot: configuration.consumer.root,
    bestOf: [...new Set(imported.receipts.map(receipt => receipt.bestOf))].sort(),
    artifacts, modelAdopted: false, promotion: 'closed' }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: forecast-parity --config <config.json> --sha256 <config SHA256>\nCalls the actual Gamba importer and canonical Power Index predictors on saved states. No replay, trading or adoption.')
  } else {
    if (args.length !== 4 || args[0] !== '--config' || args[2] !== '--sha256') throw new Error('Expected --config and explicit --sha256')
    console.log(JSON.stringify(await verifyForecastParity(loadParityConfiguration(resolve(args[1]), args[3]))))
  }
}
