import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { manifestWithResolvedFiles } from '../../scripts/local-data-manifest.js'
import { rankingSourceProvenance } from '../../scripts/rankings/source-provenance.ts'
import type { ForecastCandidate } from '../../scripts/rankings/export-pregame-series.ts'
import { performance } from 'node:perf_hooks'
import { readEvaluationExport } from './lib/rankingEvaluation'
import { applySearchValues, readSearchValues, scoreTrial, searchParameters, searchTrials } from './lib/ranking-experiments'

const [manifestArg, protocolArg, outputArg, forecastRequestsArg] = process.argv.slice(2)
if (!manifestArg || !protocolArg || !outputArg) throw new Error('Usage: search-ranking-model <manifest> <protocol> <output-directory> [forecast-requests.json]')
const root = process.cwd()
const output = resolve(outputArg)
const manifest = resolve(manifestArg)
const protocolBytes = await readFile(resolve(protocolArg), 'utf8')
const protocol: { seed: number; maximumJointFitTrials: number; folds: Array<{ fitThrough: string; validateThrough: string }>;
  maximumRuntimeMs?: number; forecastVariants?: Array<{ trial: number; ratings: 'baseline' | 'trial'; transform: ForecastCandidate['transform']; calibrationFit: ForecastCandidate['calibrationFit'] }> } = JSON.parse(protocolBytes)
const files = new Map(await Promise.all([...new Set(searchParameters.map((parameter) => parameter.file))]
  .map(async (file) => [file, await readFile(join(root, file), 'utf8')] as const)))
const trials = searchTrials(readSearchValues(files), protocol.seed, protocol.maximumJointFitTrials)
const maximumRuntimeMs = protocol.maximumRuntimeMs ?? 12 * 60 * 60 * 1000
if (!Number.isFinite(maximumRuntimeMs) || maximumRuntimeMs <= 0 || maximumRuntimeMs > 12 * 60 * 60 * 1000) throw new Error('Invalid compute ceiling')
const variants = protocol.forecastVariants ?? []
if (variants.length && !forecastRequestsArg) throw new Error('Forecast variants require forecast requests')
if (new Set(variants.map(value => value.trial)).size !== variants.length || variants.some(value => !Number.isInteger(value.trial) || value.trial < 1 || value.trial >= trials.length)) throw new Error('Forecast variants require unique non-baseline trial slots')
for (const variant of variants) if (variant.ratings === 'baseline') trials[variant.trial].parameters = { ...trials[0].parameters }
const hash = createHash('sha256').update(protocolBytes).update(await readFile(manifest))
hash.update((await rankingSourceProvenance(root)).sourceHash).update(process.version)
const manifestData: { files: Record<string, string[]> } = manifestWithResolvedFiles(JSON.parse(await readFile(manifest, 'utf8')), dirname(manifest))
for (const file of Object.values(manifestData.files).flat().sort()) hash.update(await readFile(resolve(dirname(manifest), file)))
hash.update(await readFile(join(root, 'pnpm-lock.yaml')))
if (forecastRequestsArg) hash.update(await readFile(resolve(forecastRequestsArg)))
const identity = hash.digest('hex')
await mkdir(output, { recursive: true })
const sandbox = join(output, 'sandbox')
await rm(sandbox, { recursive: true, force: true })
await mkdir(sandbox)
for (const file of ['src', 'scripts', 'tools', 'package.json', 'pnpm-lock.yaml', ...(await readdir(root)).filter(file => /^tsconfig.*\.json$/.test(file))]) await cp(join(root, file), join(sandbox, file), { recursive: true })
await symlink(join(root, 'node_modules'), join(sandbox, 'node_modules'), 'dir')
const results: Array<{ index: number; label: string; parameters: typeof trials[number]['parameters']; identity: string;
  elapsedMs: number; modelConfigHash: string; forecastHash?: string; forecastManifestHash?: string; forecastStatesHash?: string; scores: ReturnType<typeof scoreTrial> }> = []
try {
  for (const trial of trials) {
    const usedRuntime = results.reduce((sum, result) => sum + result.elapsedMs, 0)
    if (usedRuntime >= maximumRuntimeMs) throw new Error('Search compute ceiling reached')
    const receipt = join(output, `trial-${trial.index}.json`)
    const predictions = join(output, `predictions-${trial.index}.json`)
    let saved: typeof results[number] | undefined
    try { saved = JSON.parse(await readFile(receipt, 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (saved) {
      if (saved.identity !== identity || JSON.stringify(saved.parameters) !== JSON.stringify(trial.parameters)) throw new Error('Resume identity differs; use a new output directory')
      const data = readEvaluationExport(JSON.parse(await readFile(predictions, 'utf8')))
      if (data.modelConfigHash !== saved.modelConfigHash || JSON.stringify(scoreTrial(data, protocol.folds)) !== JSON.stringify(saved.scores)) throw new Error('Saved prediction or scores differ')
      if (forecastRequestsArg) {
        const forecast = join(output, `forecasts-${trial.index}.jsonl`)
        if (saved.forecastHash !== createHash('sha256').update(await readFile(forecast)).digest('hex')) throw new Error('Saved forecast differs')
        if (saved.forecastManifestHash !== createHash('sha256').update(await readFile(`${forecast}.manifest.json`)).digest('hex')
          || saved.forecastStatesHash !== createHash('sha256').update(await readFile(`${forecast}.states.jsonl`)).digest('hex')) throw new Error('Saved forecast evidence differs')
        const sidecar = JSON.parse(await readFile(`${forecast}.manifest.json`, 'utf8'))
        const forecasts = (await readFile(forecast, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        if (forecasts.some(value => value.sourceHash !== sidecar.sourceHash || value.dependencyLockHash !== sidecar.dependencyLockHash)) {
          throw new Error('Saved forecast provenance differs')
        }
        if (sidecar.sourceRoot !== `${forecast}.source`
          || (await rankingSourceProvenance(sidecar.sourceRoot, root)).sourceHash !== sidecar.sourceHash
          || createHash('sha256').update(await readFile(join(sidecar.sourceRoot, 'pnpm-lock.yaml'))).digest('hex') !== sidecar.dependencyLockHash) {
          throw new Error('Saved forecast source differs')
        }
      }
      results.push(saved); continue
    }
    for (const [file, content] of applySearchValues(files, trial.parameters)) await writeFile(join(sandbox, file), content)
    const attempt = join(output, `attempt-${trial.index}.json`)
    let previousAttempt: { identity: string; trial: typeof trial } | undefined
    try { previousAttempt = JSON.parse(await readFile(attempt, 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (previousAttempt) {
      if (previousAttempt.identity !== identity || JSON.stringify(previousAttempt.trial) !== JSON.stringify(trial)) throw new Error('Resume attempt identity differs; use a new output directory')
      const archive = await mkdtemp(join(output, `incomplete-${trial.index}-`))
      const forecast = join(output, `forecasts-${trial.index}.jsonl`)
      for (const path of [predictions, join(output, `candidate-${trial.index}.json`), forecast, `${forecast}.manifest.json`, `${forecast}.states.jsonl`, `${forecast}.source`, `${receipt}.tmp`]) {
        try { await rename(path, join(archive, basename(path))) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
    } else {
      await writeFile(attempt, JSON.stringify({ identity, trial, startedAt: Date.now(), maximumRuntimeMs }) + '\n', { flag: 'wx' })
    }
    const start = performance.now()
    await new Promise<void>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', join(sandbox, 'tools/calibration/export-ranking-predictions.ts'), sandbox, manifest, predictions], { cwd: sandbox, stdio: 'inherit', timeout: Math.max(1, Math.floor(maximumRuntimeMs - usedRuntime)) })
      child.once('error', reject)
      child.once('exit', (code) => code === 0 ? done() : reject(new Error(`Trial ${trial.index} exited ${code}`)))
    })
    if (forecastRequestsArg) {
      const variant = variants.find(value => value.trial === trial.index)
      const candidate: ForecastCandidate = { candidateId: `trial-${trial.index}`, parentCandidateId: trial.index === 0 ? null : 'trial-0',
        transform: variant?.transform ?? { temperature: 1, calibrationOrder: 'game-before-series', dependence: 0 },
        calibrationFit: variant?.calibrationFit ?? null }
      const candidatePath = join(output, `candidate-${trial.index}.json`)
      await writeFile(candidatePath, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' })
      const forecast = join(output, `forecasts-${trial.index}.jsonl`)
      const sourceRoot = `${forecast}.source`
      await mkdir(sourceRoot)
      await cp(sandbox, sourceRoot, { recursive: true, filter: path => path !== join(sandbox, 'node_modules') })
      await symlink(join(root, 'node_modules'), join(sourceRoot, 'node_modules'), 'dir')
      await new Promise<void>((done, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', join(sourceRoot, 'scripts/rankings/export-pregame-series.ts'), manifest,
          resolve(forecastRequestsArg), candidatePath, forecast],
        { cwd: sourceRoot, stdio: 'inherit', env: { ...process.env, RANKING_REPOSITORY_ROOT: root }, timeout: Math.max(1, Math.floor(maximumRuntimeMs - usedRuntime - (performance.now() - start))) })
        child.once('error', reject)
        child.once('exit', code => code === 0 ? done() : reject(new Error(`Forecast trial ${trial.index} exited ${code}`)))
      })
      const sidecar = JSON.parse(await readFile(`${forecast}.manifest.json`, 'utf8'))
      await writeFile(`${forecast}.manifest.json`, JSON.stringify({ ...sidecar, sourceRoot }, null, 2) + '\n')
    }
    const data = readEvaluationExport(JSON.parse(await readFile(predictions, 'utf8')))
    const forecastHash = forecastRequestsArg ? createHash('sha256').update(await readFile(join(output, `forecasts-${trial.index}.jsonl`))).digest('hex') : undefined
    const forecastManifestHash = forecastRequestsArg ? createHash('sha256').update(await readFile(join(output, `forecasts-${trial.index}.jsonl.manifest.json`))).digest('hex') : undefined
    const forecastStatesHash = forecastRequestsArg ? createHash('sha256').update(await readFile(join(output, `forecasts-${trial.index}.jsonl.states.jsonl`))).digest('hex') : undefined
    const result = { ...trial, identity, forecastHash, forecastManifestHash, forecastStatesHash, elapsedMs: performance.now() - start, modelConfigHash: data.modelConfigHash, scores: scoreTrial(data, protocol.folds) }
    await writeFile(`${receipt}.tmp`, `${JSON.stringify(result, null, 2)}\n`)
    await rename(`${receipt}.tmp`, receipt)
    results.push(result)
    console.log(`Completed trial ${trial.index + 1}/${trials.length}: ${trial.label}`)
  }
  const selection = forecastRequestsArg ? [] : protocol.folds.map((fold, index) => {
    const selected = [...results].sort((a, b) => (a.scores[index].fit.logLoss ?? Infinity) - (b.scores[index].fit.logLoss ?? Infinity) || a.index - b.index)[0]
    return { ...fold, selectedTrial: selected.index, selectionUses: 'fit-log-loss-only', validation: selected.scores[index].validation,
      baselineValidation: results[0].scores[index].validation }
  })
  await writeFile(join(output, 'report.json'), `${JSON.stringify({ identity, status: 'exploratory; no fresh holdout; no automatic adoption',
    scoreTarget: 'legacy-game-predictions; does not score series forecast transforms',
    forecastSelection: forecastRequestsArg ? 'not-performed; exported candidates require common-cohort series evaluation' : null,
    parameters: searchParameters, trials: results, selection }, null, 2)}\n`)
} finally { await rm(sandbox, { recursive: true, force: true }) }
