import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { readEvaluationExport } from '../src/lib/rankingEvaluation'
import { applySearchValues, readSearchValues, scoreTrial, searchParameters, searchTrials } from './lib/ranking-experiments'

const [manifestArg, protocolArg, outputArg] = process.argv.slice(2)
if (!manifestArg || !protocolArg || !outputArg) throw new Error('Usage: search-ranking-model <manifest> <protocol> <output-directory>')
const root = process.cwd()
const output = resolve(outputArg)
const manifest = resolve(manifestArg)
const protocolBytes = await readFile(resolve(protocolArg), 'utf8')
const protocol: { seed: number; maximumJointFitTrials: number; folds: Array<{ fitThrough: string; validateThrough: string }> } = JSON.parse(protocolBytes)
const files = new Map(await Promise.all([...new Set(searchParameters.map((parameter) => parameter.file))]
  .map(async (file) => [file, await readFile(join(root, file), 'utf8')] as const)))
const trials = searchTrials(readSearchValues(files), protocol.seed, protocol.maximumJointFitTrials)
const hash = createHash('sha256').update(protocolBytes).update(await readFile(manifest))
for (const directory of ['src', 'scripts']) for (const file of (await readdir(directory, { recursive: true })).sort()) {
  if (/\.(?:ts|tsx|mjs|json)$/.test(file)) hash.update(file).update(await readFile(join(directory, file)))
}
// Include real inputs, not just manifest text, in the resume identity.
const manifestData: { files: Record<string, string[]> } = JSON.parse(await readFile(manifest, 'utf8'))
for (const file of Object.values(manifestData.files).flat().sort()) hash.update(await readFile(resolve(dirname(manifest), file)))
const identity = hash.digest('hex')
await mkdir(output, { recursive: true })
const sandbox = join(output, 'sandbox')
await rm(sandbox, { recursive: true, force: true })
await mkdir(sandbox)
for (const file of ['src', 'scripts', 'package.json', 'tsconfig.app.json', 'tsconfig.node.json', 'tsconfig.json']) await cp(join(root, file), join(sandbox, file), { recursive: true })
await symlink(join(root, 'node_modules'), join(sandbox, 'node_modules'), 'dir')
const results: Array<{ index: number; label: string; parameters: typeof trials[number]['parameters']; identity: string;
  elapsedMs: number; modelConfigHash: string; scores: ReturnType<typeof scoreTrial> }> = []
try {
  for (const trial of trials) {
    const receipt = join(output, `trial-${trial.index}.json`)
    const predictions = join(output, `predictions-${trial.index}.json`)
    let saved: typeof results[number] | undefined
    try { saved = JSON.parse(await readFile(receipt, 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (saved) {
      if (saved.identity !== identity || JSON.stringify(saved.parameters) !== JSON.stringify(trial.parameters)) throw new Error('Resume identity differs; use a new output directory')
      const data = readEvaluationExport(JSON.parse(await readFile(predictions, 'utf8')))
      if (data.modelConfigHash !== saved.modelConfigHash || JSON.stringify(scoreTrial(data, protocol.folds)) !== JSON.stringify(saved.scores)) throw new Error('Saved prediction or scores differ')
      results.push(saved); continue
    }
    for (const [file, content] of applySearchValues(files, trial.parameters)) await writeFile(join(sandbox, file), content)
    const start = performance.now()
    await new Promise<void>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', join(sandbox, 'scripts/export-ranking-predictions.ts'), sandbox, manifest, predictions], { cwd: sandbox, stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', (code) => code === 0 ? done() : reject(new Error(`Trial ${trial.index} exited ${code}`)))
    })
    const data = readEvaluationExport(JSON.parse(await readFile(predictions, 'utf8')))
    const result = { ...trial, identity, elapsedMs: performance.now() - start, modelConfigHash: data.modelConfigHash, scores: scoreTrial(data, protocol.folds) }
    await writeFile(`${receipt}.tmp`, `${JSON.stringify(result, null, 2)}\n`)
    await rename(`${receipt}.tmp`, receipt)
    results.push(result)
    console.log(`Completed trial ${trial.index + 1}/${trials.length}: ${trial.label}`)
  }
  const selection = protocol.folds.map((fold, index) => {
    const selected = [...results].sort((a, b) => (a.scores[index].fit.logLoss ?? Infinity) - (b.scores[index].fit.logLoss ?? Infinity) || a.index - b.index)[0]
    return { ...fold, selectedTrial: selected.index, selectionUses: 'fit-log-loss-only', validation: selected.scores[index].validation,
      baselineValidation: results[0].scores[index].validation }
  })
  await writeFile(join(output, 'report.json'), `${JSON.stringify({ identity, status: 'exploratory; no fresh holdout; no automatic adoption',
    parameters: searchParameters, trials: results, selection }, null, 2)}\n`)
} finally { await rm(sandbox, { recursive: true, force: true }) }
