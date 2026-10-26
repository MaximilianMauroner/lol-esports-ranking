import assert from 'node:assert/strict'
import ts from 'typescript'
import { after, before, test } from 'node:test'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { exportModelCandidate } from '../tools/calibration/export-model-candidate.ts'
import { createSyntheticParity } from '../tools/research/synthetic-parity.ts'
import { filePin, sha256, loadParityConfiguration, verifyForecastParity, type ParityConfiguration } from '../tools/research/forecast-parity.ts'

const consumerRoot = resolve(process.env.GAMBA_CONSUMER_ROOT ?? '../gamba')
const available = existsSync(join(consumerRoot, 'src/lol/forecast-import.ts'))
let directory: string
let configurations: ParityConfiguration[]
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const lines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'

before(async () => {
  if (!available) return
  directory = await mkdtemp(join(tmpdir(), 'forecast-consumer-parity-'))
  const created = await createSyntheticParity(directory, consumerRoot)
  configurations = created.configurations.map(row => row.configuration)
  console.log(JSON.stringify({ check: 'actual-synthetic-export-and-parity', ...created.result }))
})
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

async function derived(label: string, baseline = configurations[0]) {
  const configuration = structuredClone(baseline)
  const output = join(directory, `${label}.jsonl`)
  for (const suffix of ['', '.manifest.json', '.states.jsonl']) await copyFile(`${baseline.exporter.output}${suffix}`, `${output}${suffix}`)
  configuration.exporter.output = output
  configuration.artifacts = { forecast: filePin(output), manifest: filePin(`${output}.manifest.json`), states: filePin(`${output}.states.jsonl`) }
  return configuration
}
async function changeForecast(configuration: ParityConfiguration, edit: (row: Record<string, unknown>) => void) {
  const rows = (await readFile(configuration.exporter.output, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  edit(rows[0])
  await writeFile(configuration.exporter.output, lines(rows))
  configuration.artifacts.forecast = filePin(configuration.exporter.output)
}
async function actualImport(configuration: ParityConfiguration) {
  const consumer = await import(pathToFileURL(join(consumerRoot, 'src/lol/forecast-import.ts')).href) as {
    verifyForecastExport(config: ParityConfiguration['exporter']): { receipts: unknown[] }
  }
  return consumer.verifyForecastExport(configuration.exporter)
}
const skip = available ? false : 'Set GAMBA_CONSUMER_ROOT to a real Gamba checkout. No consumer stub is used.'

test('real exporter and Gamba importer agree with canonical rich and Elo on BO1, BO3, BO5 and both orientations', { skip }, async () => {
  for (const configuration of configurations) {
    const result = await verifyForecastParity(configuration)
    assert.equal(result.receipts, 6)
    assert.equal(result.eligible, 6)
    assert.deepEqual(result.bestOf, [1, 3, 5])
    const receipts = (await readFile(configuration.exporter.output, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    for (let index = 0; index < receipts.length; index += 2) {
      assert.ok(Math.abs(receipts[index].homeSeriesWinProbability + receipts[index + 1].homeSeriesWinProbability - 1) < 1e-14)
      assert.notEqual(receipts[index].homeSeriesWinProbability, 0.5)
    }
    console.log(JSON.stringify({ check: 'saved-state-success', ...result }))
  }
})

test('parity rejects plausible probability and component tampering that the real importer accepts', { skip }, async () => {
  for (const [index, baseline] of configurations.entries()) {
    for (const kind of ['series', 'component', 'eligibility']) {
      const configuration = await derived(`tampered-${index}-${kind}`, baseline)
      await changeForecast(configuration, row => {
        if (kind === 'series') {
          row.homeSeriesWinProbability = Number(row.homeSeriesWinProbability) + 0.001
          row.awaySeriesWinProbability = Number(row.awaySeriesWinProbability) - 0.001
        } else if (kind === 'component') (row.componentGameProbabilities as number[])[0] += 0.001
        else { row.eligible = false; row.exclusions = ['unsupported-exclusion'] }
      })
      assert.equal((await actualImport(configuration)).receipts.length, 6)
      await assert.rejects(verifyForecastParity(configuration), /CANONICAL_PARITY_MISMATCH/)
    }
  }
  console.log(JSON.stringify({ check: 'probability-component-eligibility-tamper', importerAccepts: 6, parityRejects: 6, directPredictorCalls: 6 }))
})

test('state, candidate transform, source, dependency lock, request orientation and config anchors are bound', { skip }, async () => {
  const state = await derived('changed-state')
  const rows = (await readFile(state.artifacts.states.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  rows[0].state.home.rating += 1
  await writeFile(state.artifacts.states.path, lines(rows))
  state.artifacts.states = filePin(state.artifacts.states.path)
  await assert.rejects(verifyForecastParity(state), /EXACT_STATE_HASH_MISMATCH/)

  for (const kind of ['candidate', 'kind', 'source', 'lock', 'orientation']) {
    const configuration = await derived(`changed-${kind}`)
    if (kind === 'candidate' || kind === 'kind') {
      const candidate = await read(configuration.exporter.candidate.path)
      if (kind === 'candidate') candidate.transform.calibrationOrder = 'series-after-conversion'
      else candidate.modelKind = 'simple-elo'
      const path = join(directory, `changed-${kind}-candidate.json`)
      await writeFile(path, JSON.stringify(candidate))
      const oldHash = configuration.exporter.candidate.sha256
      configuration.exporter.candidate = filePin(path)
      const receipts = (await readFile(configuration.exporter.output, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      for (const receipt of receipts) receipt.inputDigests = receipt.inputDigests.map((pin: { sha256: string }) => pin.sha256 === oldHash ? configuration.exporter.candidate : pin)
      await writeFile(configuration.exporter.output, lines(receipts))
      configuration.artifacts.forecast = filePin(configuration.exporter.output)
      assert.equal((await actualImport(configuration)).receipts.length, 6)
    } else if (kind === 'orientation') {
      const requestFile = await read(configuration.exporter.requests.path)
      const first = requestFile.requests[0]
      const home = first.homeSourceTeam
      first.homeSourceTeam = first.awaySourceTeam
      first.awaySourceTeam = home
      const path = join(directory, 'changed-requests.json')
      await writeFile(path, JSON.stringify(requestFile))
      const oldHash = configuration.exporter.requests.sha256
      configuration.exporter.requests = filePin(path)
      const receipts = (await readFile(configuration.exporter.output, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      for (const receipt of receipts) receipt.inputDigests = receipt.inputDigests.map((pin: { sha256: string }) => pin.sha256 === oldHash ? configuration.exporter.requests : pin)
      await writeFile(configuration.exporter.output, lines(receipts))
      configuration.artifacts.forecast = filePin(configuration.exporter.output)
    } else {
      const manifest = await read(configuration.artifacts.manifest.path)
      if (kind === 'lock') manifest.dependencyLockHash = '0'.repeat(64)
      else manifest.sourceDigests[0].sha256 = '0'.repeat(64)
      await writeFile(configuration.artifacts.manifest.path, JSON.stringify(manifest))
      configuration.artifacts.manifest = filePin(configuration.artifacts.manifest.path)
    }
    await assert.rejects(verifyForecastParity(configuration), /MISMATCH|INVALID_EXPORT_SOURCE_MANIFEST/)
  }
  const path = join(directory, 'pinned-config.json')
  await writeFile(path, JSON.stringify(configurations[0]))
  assert.throws(() => loadParityConfiguration(path, '0'.repeat(64)), /PIN_MISMATCH/)
  console.log(JSON.stringify({ check: 'provenance-negative-cases', rejected: 7, directPredictorCalls: 0 }))
})

test('applied candidate source uses its canonical public predictor and exact saved state', { skip }, async () => {
  const configuration = structuredClone(configurations[0])
  const candidate = { ...await read(configuration.exporter.candidate.path), candidateId: 'synthetic-applied-v1',
    modelParameters: { winProbabilityUncertaintyScale: 400 } }
  const candidatePath = join(directory, 'applied-candidate.json')
  await writeFile(candidatePath, JSON.stringify(candidate))
  configuration.exporter.candidate = filePin(candidatePath)
  configuration.exporter.entry = filePin(resolve('tools/calibration/export-model-candidate.ts'))
  const output = join(directory, 'applied.jsonl')
  const receipts = await exportModelCandidate(configuration.exporter.manifest.path, configuration.exporter.requests.path, candidatePath, output)
  configuration.exporter.output = output
  configuration.artifacts = { forecast: filePin(output), manifest: filePin(`${output}.manifest.json`), states: filePin(`${output}.states.jsonl`) }
  const result = await verifyForecastParity(configuration)
  assert.equal(result.sourceRoot, `${output}.source`)
  assert.equal(result.receipts, 6)
  const manifest = await read(`${output}.manifest.json`)
  console.log(JSON.stringify({ check: 'applied-synthetic-source', exportPredictorCalls: receipts.length,
    syntheticReplays: manifest.replayCount, syntheticReplayedGames: manifest.replayedGames, ...result }))
})

test('actual retained acquired receipt remains NONCAUSAL_FORECAST without timestamp repair', { skip }, async () => {
  const configuration = await derived('historical-noncausal')
  const bytes = await readFile(new URL('./fixtures/research-intake/acquired-noncausal-receipt.json', import.meta.url))
  const origin = JSON.parse(await readFile(new URL('./fixtures/research-intake/acquired-noncausal-origin.json', import.meta.url), 'utf8'))
  assert.equal(sha256(bytes), origin.receiptSha256)
  const receipt = JSON.parse(bytes.toString())
  assert.ok(receipt.sourceObservedAt.some((time: number) => time > receipt.asOf))
  await writeFile(configuration.exporter.output, bytes)
  configuration.artifacts.forecast = filePin(configuration.exporter.output)
  await assert.rejects(verifyForecastParity(configuration), /NONCAUSAL_FORECAST/)
  console.log(JSON.stringify({ check: 'actual-acquired-chronology-rejection', receiptSha256: origin.receiptSha256,
    error: 'NONCAUSAL_FORECAST', directPredictorCalls: 0, newRankingReplays: 0,
    scope: 'Chronology rejection precedes source and state verification. This test does not claim historical parity.' }))
})


test('unproven runtime source rejects before execution under the same configuration', { skip }, async () => {
  const cases = [
    { mode: 'missing-pin', pinned: null, executable: 'pregameForecast.ts', specifier: 'pregameForecast.ts',
      pinnedContent: 'typescript', runtimeContent: 'typescript', expected: /UNPINNED_SOURCE_DEPENDENCY/ },
    { mode: 'extensionless-declaration', pinned: 'pregameForecast.d.ts', executable: 'pregameForecast.js', specifier: 'pregameForecast',
      pinnedContent: 'declaration', runtimeContent: 'javascript', expected: /UNSUPPORTED_SOURCE_DEPENDENCY/ },
    { mode: 'mjs-typescript-sibling', pinned: 'pregameForecast.mjs', executable: 'pregameForecast.mts', specifier: 'pregameForecast.mjs',
      pinnedContent: 'javascript', runtimeContent: 'typescript', expected: /AMBIGUOUS_SOURCE_DEPENDENCY/ },
    { mode: 'percent-encoded', pinned: 'pregameForecas%74.ts', executable: 'pregameForecast.ts', specifier: 'pregameForecas%74.ts',
      pinnedContent: 'typescript', runtimeContent: 'typescript', expected: /INVALID_RELATIVE_SOURCE_PATH/ },
    { mode: 'percent-encoded-import', pinned: 'pregameForecast.d.ts', executable: 'pregameForecast.ts', specifier: 'pregameForecas%74.ts',
      pinnedContent: 'declaration', runtimeContent: 'typescript', expected: /UNSUPPORTED_SOURCE_DEPENDENCY/ },
  ] as const
  for (const route of cases) {
    const configuration = await derived(`incomplete-source-${route.mode}`)
    const sourceRoot = join(directory, `incomplete-source-root-${route.mode}`)
    const manifest = await read(configuration.artifacts.manifest.path)
    for (const pin of manifest.sourceDigests as Array<{ path: string; sha256: string }>) {
      const target = join(sourceRoot, pin.path)
      await mkdir(resolve(target, '..'), { recursive: true })
      await copyFile(join(configuration.exporter.cwd, pin.path), target)
    }
    await copyFile(join(configuration.exporter.cwd, 'pnpm-lock.yaml'), join(sourceRoot, 'pnpm-lock.yaml'))
    const projection = 'src/domains/rankings/internal/projections/'
    const omitted = `${projection}pregameForecast.ts`
    const executable = projection + route.executable
    manifest.sourceDigests = manifest.sourceDigests.filter((pin: { path: string }) => pin.path !== omitted)
    if (route.pinned) {
      const predictor = await readFile(join(sourceRoot, omitted), 'utf8')
      const contents = {
        typescript: predictor,
        javascript: ts.transpileModule(predictor, { compilerOptions: {
          module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023,
        } }).outputText,
        declaration: 'export declare function predictPregameSeries(input: unknown): unknown;\n',
      }
      const selected = projection + route.pinned
      await writeFile(join(sourceRoot, selected), contents[route.pinnedContent])
      await writeFile(join(sourceRoot, executable), contents[route.runtimeContent])
      if (omitted !== selected && omitted !== executable) await rm(join(sourceRoot, omitted))
      for (const path of ['src/domains/rankings/forecast.ts', 'src/domains/rankings/internal/replay/simpleEloReplay.ts']) {
        const bytes = await readFile(join(sourceRoot, path), 'utf8')
        await writeFile(join(sourceRoot, path), bytes.replace('projections/pregameForecast.ts', `projections/${route.specifier}`))
      }
      manifest.sourceDigests.push({ path: selected, sha256: filePin(join(sourceRoot, selected)).sha256 })
      manifest.sourceDigests = manifest.sourceDigests.map((pin: { path: string }) => ({
        path: pin.path, sha256: filePin(join(sourceRoot, pin.path)).sha256,
      }))
    }
    configuration.exporter.cwd = sourceRoot
    configuration.exporter.entry = filePin(join(sourceRoot, 'scripts/rankings/export-pregame-series.ts'))
    manifest.sourceHash = sha256(JSON.stringify(manifest.sourceDigests))
    await writeFile(configuration.artifacts.manifest.path, JSON.stringify(manifest))
    configuration.artifacts.manifest = filePin(configuration.artifacts.manifest.path)
    const receipts = (await readFile(configuration.exporter.output, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    for (const receipt of receipts) receipt.sourceHash = manifest.sourceHash
    receipts[0].homeSeriesWinProbability += 0.001
    receipts[0].awaySeriesWinProbability -= 0.001
    await writeFile(configuration.exporter.output, lines(receipts))
    configuration.artifacts.forecast = filePin(configuration.exporter.output)
    const configPath = join(directory, `incomplete-source-config-${route.mode}.json`)
    await writeFile(configPath, JSON.stringify(configuration))
    const configPin = filePin(configPath)
    const manifestPin = filePin(configuration.artifacts.manifest.path)
    const argv = ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('tools/research/forecast-parity.ts'),
      '--config', configPath, '--sha256', configPin.sha256]
    const control = spawnSync(process.execPath, argv, { encoding: 'utf8' })
    const marker = join(directory, `unpinned-predictor-executed-${route.mode}`)
    await writeFile(join(sourceRoot, executable), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'executed')\nexport const predictPregameSeries = ({ metadata }) => metadata\n`)
    const bypass = spawnSync(process.execPath, argv, { encoding: 'utf8' })
    for (const result of [control, bypass]) {
      assert.equal(result.status, 1, result.stdout + result.stderr)
      assert.match(result.stderr, route.expected, result.stdout + result.stderr)
    }
    assert.deepEqual(filePin(configPath), configPin)
    assert.deepEqual(filePin(configuration.artifacts.manifest.path), manifestPin)
    assert.equal(existsSync(marker), false)
  }
  console.log(JSON.stringify({ check: 'runtime-source-closure', controls: cases.length * 2, sameConfigurations: true,
    unpinnedPredictorExecuted: false, directPredictorCalls: 0 }))
})
