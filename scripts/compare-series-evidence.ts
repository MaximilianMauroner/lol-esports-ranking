import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { compareEvaluationExports, readEvaluationExport } from '../src/lib/rankingEvaluation'

const [manifestArg, baselineArg, outputArg] = process.argv.slice(2)
if (!manifestArg || !baselineArg || !outputArg) throw new Error('Usage: compare-series-evidence <manifest> <baseline> <output-directory>')
const root = process.cwd()
const output = resolve(outputArg)
const manifest = resolve(manifestArg)
const baseline = JSON.parse(await readFile(baselineArg, 'utf8'))
readEvaluationExport(baseline)
await mkdir(output, { recursive: true })
const sandbox = join(output, 'sandbox')
await rm(sandbox, { recursive: true, force: true })
await mkdir(sandbox)
for (const file of ['src', 'scripts', 'package.json', 'tsconfig.app.json', 'tsconfig.node.json', 'tsconfig.json']) await cp(join(root, file), join(sandbox, file), { recursive: true })
await symlink(join(root, 'node_modules'), join(sandbox, 'node_modules'), 'dir')
const engine = await readFile(join(sandbox, 'src/lib/ratingSeriesEngine.ts'), 'utf8')
const config = await readFile(join(sandbox, 'src/lib/modelConfig.ts'), 'utf8')
const report = []
try {
  for (const mode of ['game', 'dependent-score'] as const) {
    const residual = mode === 'game'
      ? '(series.winsA - series.games * seriesExpected.teamAGameWinProbability) / Math.sqrt(series.games)'
      : 'seriesScoreLikelihood(series.winsA, series.winsB, series.matches.map(() => seriesExpected.teamAGameWinProbability), series.bestOf, 1).gradient / Math.sqrt(series.games)'
    const candidate = replaceOnce(replaceOnce(replaceOnce(engine,
      'const seriesResidualA = series.observedOutcomeA - expectedOutcomeA', `const seriesResidualA = series.state === 'completed' ? ${residual} : 0`),
    'const seriesResidualB = series.observedOutcomeB - expectedOutcomeB', 'const seriesResidualB = -seriesResidualA'),
    'eventK * series.strengthSignal * ratingUpdateRecencyWeight * seriesResidualA', 'eventK * ratingUpdateRecencyWeight * seriesResidualA')
    await writeFile(join(sandbox, 'src/lib/ratingSeriesEngine.ts'), `${mode === 'dependent-score' ? "import { seriesScoreLikelihood } from '../../scripts/lib/ranking-experiments'\n" : ''}${candidate}`)
    await writeFile(join(sandbox, 'src/lib/modelConfig.ts'), replaceOnce(config, 'export const transparentGprModelParameters = {',
      `export const transparentGprModelParameters = {\n  offlineSeriesEvidenceExperiment: '${mode}',`))
    const path = join(output, `${mode}.json`)
    await new Promise<void>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', join(sandbox, 'scripts/export-ranking-predictions.ts'), sandbox, manifest, path], { cwd: sandbox, stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', (code) => code === 0 ? done() : reject(new Error(`Series experiment failed: ${code}`)))
    })
    const next = JSON.parse(await readFile(path, 'utf8'))
    report.push({ mode, games: compareEvaluationExports(baseline, next), series: compareEvaluationExports(baseline.seriesExport, next.seriesExport) })
    console.log(`Completed atomic series evidence comparison: ${mode}`)
  }
  await writeFile(join(output, 'report.json'), `${JSON.stringify({ status: 'exploratory; neutral likelihood, atomic completion, fixed dependence; no automatic adoption', report }, null, 2)}\n`)
} finally { await rm(sandbox, { recursive: true, force: true }) }

function replaceOnce(source: string, old: string, next: string) {
  if (source.split(old).length !== 2) throw new Error('Experiment source definition changed')
  return source.replace(old, next)
}
