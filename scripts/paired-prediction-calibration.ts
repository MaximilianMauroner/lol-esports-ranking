import { readFile } from 'node:fs/promises'
import { compareEvaluationExports } from '../src/lib/rankingEvaluation'

const [oldPath, nextPath] = process.argv.slice(2)
if (!oldPath || !nextPath) throw new Error('Usage: paired-prediction-calibration <old-export> <next-export>')
const result = compareEvaluationExports(JSON.parse(await readFile(oldPath, 'utf8')), JSON.parse(await readFile(nextPath, 'utf8')))
console.log(JSON.stringify(result, null, 2))
if (!result.passed) process.exitCode = 1
