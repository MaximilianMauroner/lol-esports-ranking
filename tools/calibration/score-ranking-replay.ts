import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareStoredReplayPolicy } from './lib/rankingEvaluation.ts'
import { readReplayEvidenceFiles, type ReplayEvidenceInput } from './lib/replayEvidenceFiles.ts'

export async function scoreRankingReplay(args: string[]) {
  const values = new Map<string, string>()
  const allowed = new Set(['--generation', '--objects', '--public-data-dir', '--export', '--score-start', '--recent-start', '--output'])
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1]
    if (!allowed.has(key) || values.has(key) || !value || value.startsWith('--')) throw new Error('Invalid replay scoring arguments')
    values.set(key, value)
  }
  const generation = values.get('--generation'); const objects = values.get('--objects')
  const local = values.get('--public-data-dir'); const exported = values.get('--export')
  const outputArg = values.get('--output'); const recentStart = values.get('--recent-start')
  if (Number(Boolean(generation)) + Number(Boolean(local)) + Number(Boolean(exported)) !== 1
    || Boolean(generation) !== Boolean(objects) || !outputArg || !recentStart) {
    throw new Error('Usage: score-ranking-replay (--generation <manifest> --objects <directory> | --public-data-dir <directory> | --export <file>) --score-start <UTC-date> --recent-start <UTC-date> --output <file>')
  }
  const output = resolve(outputArg)
  const inputs = [generation, exported, ...(local ? [resolve(local, 'ranking-summary.json'), resolve(local, 'evaluation/replay-predictions.json')] : [])].filter((path): path is string => Boolean(path)).map((path) => resolve(path))
  if (inputs.includes(output) || (objects && !relative(resolve(objects), output).startsWith('..'))) throw new Error('Replay output must not overwrite input authority')
  const input: ReplayEvidenceInput = generation && objects ? { kind: 'published-generation', generationManifestPath: resolve(generation), objectsDirectory: resolve(objects) }
    : local ? { kind: 'local-build', publicDataDirectory: resolve(local) } : { kind: 'retained-local-replay', exportPath: resolve(exported!) }
  const saved = await readReplayEvidenceFiles(input)
  const scoreStart = values.get('--score-start') ?? saved.scoreStart
  if (!scoreStart || (saved.scoreStart !== undefined && scoreStart !== saved.scoreStart)) throw new Error('Explicit score-start must match the saved export window')
  const report = { authority: saved.authority, ...compareStoredReplayPolicy(saved.evidence, { scoreStart, recentStart }) }
  await mkdir(dirname(output), { recursive: true })
  const temporaryDirectory = await mkdtemp(join(dirname(output), '.replay-score-'))
  const temporary = join(temporaryDirectory, 'report.json')
  try {
    await writeFile(temporary, `${JSON.stringify(report)}\n`, { flag: 'wx' })
    await rename(temporary, output)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  scoreRankingReplay(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = error && typeof error === 'object' && 'code' in error ? 1 : 2
  })
}
