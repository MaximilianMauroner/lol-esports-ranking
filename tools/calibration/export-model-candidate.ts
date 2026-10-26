import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportPregameSeries, type ForecastCandidate } from '../../scripts/rankings/export-pregame-series.ts'
import { rankingSourceProvenance } from '../../scripts/rankings/source-provenance.ts'
import { applySearchValues, readSearchValues, searchParameters, type SearchValues } from './lib/ranking-experiments.ts'

export type ModelCandidate = ForecastCandidate & { modelParameters?: Partial<SearchValues> }
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function parseModelParameters(value: unknown): Partial<SearchValues> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid modelParameters')
  for (const [key, number] of Object.entries(value)) {
    const parameter = searchParameters.find(parameter => parameter.key === key)
    if (!parameter) throw new Error(`Unknown model parameter: ${key}`)
    if (typeof number !== 'number' || !Number.isFinite(number) || number < parameter.low || number > parameter.high) {
      throw new Error(`Parameter outside bounds: ${key}`)
    }
  }
  return value as Partial<SearchValues>
}

export async function exportModelCandidate(manifestPath: string, requestsPath: string, candidatePath: string, outputPath: string) {
  const candidateBytes = await readFile(resolve(candidatePath))
  const candidate: ModelCandidate = JSON.parse(candidateBytes.toString())
  const modelParameters = parseModelParameters(candidate.modelParameters)
  if (!Object.keys(modelParameters).length) return exportPregameSeries(manifestPath, requestsPath, candidatePath, outputPath)

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const sourceRoot = `${resolve(outputPath)}.source`
  const base = await rankingSourceProvenance(root)
  const baseSourceDigests = base.sourceDigests
  const sourcePaths = baseSourceDigests.map(source => source.path)
  const files = new Map(await Promise.all(sourcePaths.map(async path => [path, await readFile(join(root, path), 'utf8')] as const)))
  const dependencyBytes = await readFile(join(root, 'pnpm-lock.yaml'))
  const modelCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const values = { ...readSearchValues(files), ...modelParameters }
  const applied = applySearchValues(files, values)
  const sourceDigests = sourcePaths.map(path => ({ path, sha256: sha256(applied.get(path)!) }))
  const sourceHash = sha256(JSON.stringify(sourceDigests))
  await mkdir(sourceRoot)
  for (const [path, content] of applied) {
    await mkdir(dirname(join(sourceRoot, path)), { recursive: true })
    await writeFile(join(sourceRoot, path), content, { flag: 'wx', mode: 0o444 })
  }
  await writeFile(join(sourceRoot, 'pnpm-lock.yaml'), dependencyBytes, { flag: 'wx', mode: 0o444 })
  await symlink(join(root, 'node_modules'), join(sourceRoot, 'node_modules'), 'dir')

  const verify = async () => {
    if ((await rankingSourceProvenance(root)).sourceHash !== base.sourceHash) throw new Error('Root source changed during export')
    if ((await rankingSourceProvenance(sourceRoot, root)).sourceHash !== sourceHash) throw new Error('Applied source changed during export')
    if (sha256(await readFile(join(root, 'pnpm-lock.yaml'))) !== sha256(dependencyBytes)
      || sha256(await readFile(join(sourceRoot, 'pnpm-lock.yaml'))) !== sha256(dependencyBytes)) throw new Error('Dependency lock changed during export')
    if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== modelCommit) throw new Error('Root commit changed during export')
    if (sha256(await readFile(resolve(candidatePath))) !== sha256(candidateBytes)) throw new Error('Candidate changed during export')
  }
  await verify()
  execFileSync(process.execPath, ['--import', 'tsx', join(sourceRoot, 'scripts/rankings/export-pregame-series.ts'),
    resolve(manifestPath), resolve(requestsPath), resolve(candidatePath), resolve(outputPath)], {
    cwd: sourceRoot, env: { ...process.env, RANKING_REPOSITORY_ROOT: root }, stdio: 'pipe', timeout: 3_600_000,
  })
  await verify()
  const sidecarPath = `${resolve(outputPath)}.manifest.json`
  const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'))
  if (sidecar.sourceHash !== sourceHash || JSON.stringify(sidecar.sourceDigests) !== JSON.stringify(sourceDigests)
    || sidecar.modelCommit !== modelCommit || sidecar.dependencyLockHash !== sha256(dependencyBytes)) throw new Error('Applied export provenance differs')
  await writeFile(sidecarPath, JSON.stringify({ ...sidecar, sourceRoot, baseSourceDigests, modelParameters }, null, 2) + '\n')
  await chmod(sidecarPath, 0o444)
  return (await readFile(resolve(outputPath), 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line)) as Awaited<ReturnType<typeof exportPregameSeries>>
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: export-model-candidate <manifest.json> <requests.json> <candidate.json> <output.jsonl>\nOffline bounded model replay. Candidate modelParameters are partial search-parameter overrides. Applied source is retained beside the output.')
  } else {
    if (args.length !== 4) throw new Error('Usage: export-model-candidate <manifest.json> <requests.json> <candidate.json> <output.jsonl>')
    const receipts = await exportModelCandidate(args[0], args[1], args[2], args[3])
    console.log(JSON.stringify({ exported: receipts.length, eligible: receipts.filter(row => row.eligible).length, output: resolve(args[3]) }))
  }
}
