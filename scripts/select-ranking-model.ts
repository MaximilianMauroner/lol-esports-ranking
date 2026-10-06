import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compareEvaluationExports, readEvaluationExport } from '../src/lib/rankingEvaluation'
import type { scoreTrial } from './lib/ranking-experiments'

const [baselinePath, directory, outputPath] = process.argv.slice(2)
if (!baselinePath || !directory || !outputPath) throw new Error('Usage: select-ranking-model <baseline-export> <search-directory> <output>')
const baseline = readEvaluationExport(JSON.parse(await readFile(baselinePath, 'utf8')))
const report: { identity: string; trials: Array<{ index: number; modelConfigHash: string; scores: ReturnType<typeof scoreTrial> }> } = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'))
if (!report.trials.length || report.trials.length > 24 || new Set(report.trials.map((trial) => trial.index)).size !== report.trials.length) throw new Error('Invalid completed search inventory')
const results = []
for (const trial of report.trials) {
  const next = readEvaluationExport(JSON.parse(await readFile(join(directory, `predictions-${trial.index}.json`), 'utf8')))
  if (next.modelConfigHash !== trial.modelConfigHash) throw new Error('Search prediction identity differs from receipt')
  const comparison = compareEvaluationExports(baseline, next)
  const fitLogLoss = trial.scores.at(-1)?.fit.logLoss
  if (fitLogLoss === null || fitLogLoss === undefined || !Number.isFinite(fitLogLoss)) throw new Error('Missing final chronological fit score')
  results.push({ index: trial.index, fitLogLoss, comparison })
  console.log(`Trial ${trial.index}: ${comparison.passed ? 'passed historical gate' : comparison.failures.join('; ')}`)
}
const eligible = results.filter((result) => result.comparison.passed).sort((a, b) => a.fitLogLoss - b.fitLogLoss || a.index - b.index)
await writeFile(outputPath, `${JSON.stringify({ searchIdentity: report.identity,
  criterion: 'minimum-final-fit-log-loss-among-historical-gate-passers', selected: eligible[0]?.index ?? null,
  accuracyClaim: false, selectionAdjustedIntervals: false, status: 'exploratory; fresh evaluation required; no automatic adoption', results }, null, 2)}\n`)
