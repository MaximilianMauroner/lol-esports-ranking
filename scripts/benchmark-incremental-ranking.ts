import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { buildRankingIncrementally, persistIncrementalStateBuild, type IncrementalRankingBuildResult, type RestoredIncrementalAuthority } from './incremental-ranking-orchestrator.ts'
import { importRankingSourceData, type RankingSourceImport } from './ranking-source-import.ts'
import { readActiveIncrementalState } from './incremental-state-storage.mjs'
import { readActiveContentAddressedGeneration, uploadRankingArtifacts } from './railway-bucket.mjs'
import { prepareSemanticArtifact } from './public-artifact-storage.mjs'

const targets = { computeMs: 15_000, peakRssBytes: 750 * 1024 * 1024, uploadedBytes: 2 * 1024 * 1024, fullSnapshotWritten: false }
const config = { enabled: true, bucket: 'benchmark', endpoint: 'https://example.invalid', region: 'auto', accessKeyId: 'x', secretAccessKey: 'y', prefix: 'rankings' }
const root = await mkdtemp(join(tmpdir(), 'incremental-ranking-benchmark-'))

try {
  const currentShape = await currentCorpusShape()
  const benchmarkMatchCount = positiveInteger(process.env.RANKING_BENCHMARK_MATCH_COUNT) ?? currentShape.matchCount
  const teamPools = await currentTeamPools()
  const baselineCsv = join(root, 'oracle-baseline.csv')
  const deltaCsv = join(root, 'oracle-delta.csv')
  const baselineManifest = join(root, 'baseline-manifest.json')
  const nextManifest = join(root, 'next-manifest.json')
  await writeFile(baselineCsv, oracleCsv(benchmarkMatchCount, teamPools, 0, benchmarkMatchCount))
  await writeFile(deltaCsv, oracleCsv(1, teamPools, benchmarkMatchCount, benchmarkMatchCount))
  await writeManifest(baselineManifest, ['oracle-baseline.csv'], '2026-07-21T00:00:00.000Z')
  await writeManifest(nextManifest, ['oracle-baseline.csv', 'oracle-delta.csv'], '2026-07-22T00:00:00.000Z')

  const client = memoryS3()
  const baselineSource = await importRankingSourceData({ manifestPath: baselineManifest })
  const baseline = await run('baseline', baselineSource, '2026-07-21T00:00:00.000Z', { mode: 'gated', cause: 'daily-audit', enabled: true })
  if (baseline.action === 'no-change' || !baseline.build) throw new Error('Benchmark baseline did not materialize')
  const baselineGenerationId = generationIdFor(baseline)
  const baselineState = await persistIncrementalStateBuild({ state: baseline.state, generationId: baselineGenerationId, client, config })
  await uploadRankingArtifacts({
    publicDataDir: baseline.build.publicDataDir, rawDir: root, manifestPath: baselineManifest,
    generationId: baselineGenerationId, fencingToken: 1, contentAddressed: true,
    stateManifestAuthority: baselineState.authority, config, client,
  })

  client.resetIo()
  globalThis.gc?.()
  const startingRssBytes = process.memoryUsage().rss
  const started = performance.now()
  let stageStarted = started
  const nextSource = await importRankingSourceData({ manifestPath: nextManifest })
  const sourceImportMs = performance.now() - stageStarted
  stageStarted = performance.now()
  const restored = await restoreFromStorage(client)
  const restoreMs = performance.now() - stageStarted
  stageStarted = performance.now()
  const incremental = await run('incremental', nextSource, '2026-07-22T00:00:00.000Z', {
    mode: 'gated', cause: 'pending-match', enabled: true, restored,
  })
  if (incremental.action !== 'publish-incremental') {
    throw new Error(`Benchmark did not exercise the incremental fast path: ${incremental.metrics.fallbackReason ?? incremental.action}`)
  }
  const incrementalBuildMs = performance.now() - stageStarted
  stageStarted = performance.now()
  const generationId = generationIdFor(incremental)
  const incrementalState = await persistIncrementalStateBuild({
    state: incremental.state, generationId, baseGenerationId: baselineGenerationId,
    baseRunId: baselineGenerationId, client, config,
  })
  const statePersistMs = performance.now() - stageStarted
  stageStarted = performance.now()
  await uploadRankingArtifacts({
    publicDataDir: incremental.build?.publicDataDir, rawDir: root, manifestPath: nextManifest,
    generationId, fencingToken: 2, contentAddressed: true,
    stateManifestAuthority: incrementalState.authority, publicArtifactPatch: incremental.patch,
    config, client,
  })
  const artifactPublishMs = performance.now() - stageStarted
  const computeMs = performance.now() - started
  const peakRssBytes = Math.max(startingRssBytes, process.memoryUsage().rss)

  const full = await run('full', nextSource, '2026-07-22T00:00:00.000Z', { mode: 'legacy', cause: 'daily-audit', enabled: false })
  if (full.action === 'no-change') throw new Error('Benchmark clean full build did not materialize')
  const incrementalSemantic = semanticMap(incremental)
  const fullSemantic = semanticMap(full)
  const differingPaths = semanticDiff(incrementalSemantic, fullSemantic)
  const incrementalValues = {
    ...restored.artifacts,
    ...Object.fromEntries(incremental.patch.changedArtifacts.map((artifact) => [artifact.logicalPath, artifact.value])),
  }
  const fullValues = Object.fromEntries(full.build!.publicPlan.writes.map((write) => [`/data/${write.relativePath}`, write.value]))
  const differenceDetails = Object.fromEntries(differingPaths.map((path) => [path, firstValueDifference(
    semanticContent(incrementalValues[path]),
    semanticContent(fullValues[path]),
  )]))
  const parity = differingPaths.length === 0
  const uploadedBytes = client.puts.reduce((sum, put) => sum + put.bytes, 0)
  const bytesBySurface = byteTotals(client.puts)
  const pass = computeMs < targets.computeMs
    && peakRssBytes < targets.peakRssBytes
    && uploadedBytes < targets.uploadedBytes
    && incremental.metrics.fullSnapshotWritten === targets.fullSnapshotWritten
    && parity
  const output = {
    corpus: {
      referenceMatchCount: currentShape.matchCount,
      benchmarkMatchCount,
      referenceTeamCount: currentShape.teamCount,
      importedMatchCount: nextSource.matches.length,
      importedTeamCount: Object.keys(nextSource.teams).length,
      sourceBytes: (await readFile(baselineCsv)).byteLength + (await readFile(deltaCsv)).byteLength,
      appendedMatches: nextSource.matches.length - baselineSource.matches.length,
    },
    computeMs: Math.round(computeMs), peakRssBytes, uploadedBytes,
    stageMs: {
      sourceImport: Math.round(sourceImportMs), restore: Math.round(restoreMs), incrementalBuild: Math.round(incrementalBuildMs),
      statePersist: Math.round(statePersistMs), artifactPublish: Math.round(artifactPublishMs),
    },
    uploadedBytesBySurface: bytesBySurface,
    storageCommands: client.io,
    storagePutCount: client.puts.length,
    stateCheckpointCount: incremental.state.checkpoints.length,
    fullSnapshotWritten: incremental.metrics.fullSnapshotWritten,
    materializedScopeCount: incremental.metrics.materializedScopeCount,
    replayedMatchCount: incremental.metrics.replayedMatchCount,
    replayFromUtcDate: incremental.metrics.replayFromUtcDate,
    selectedBoundary: incremental.metrics.selectedBoundary,
    changedPaths: incremental.metrics.changedPaths.length,
    reusedPaths: incremental.metrics.reusedPaths.length,
    parity,
    differingPaths,
    differenceDetails,
    target: { computeMs: '<15000', peakRssBytes: '<786432000', uploadedBytes: '<2097152', fullSnapshotWritten: false, parity: true },
    pass,
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)
  if (process.argv.includes('--enforce-targets') && !pass) process.exitCode = 1
} finally {
  await rm(root, { recursive: true, force: true })
}

function run(
  name: string,
  sourceData: RankingSourceImport,
  generatedAt: string,
  options: { mode: 'legacy' | 'shadow' | 'gated'; cause: string; enabled: boolean; restored?: RestoredIncrementalAuthority },
) {
  return buildRankingIncrementally({
    ...options, sourceData, silent: true, generatedAt,
    manifestPath: join(root, `${name}-unused.json`), output: join(root, `${name}.full.json`), publicDataDir: join(root, `${name}-public`),
  })
}

async function restoreFromStorage(client: ReturnType<typeof memoryS3>): Promise<RestoredIncrementalAuthority> {
  const [state, publicGeneration] = await Promise.all([
    readActiveIncrementalState({ config, client }),
    readActiveContentAddressedGeneration({ config, client }),
  ])
  if (!state.found || !publicGeneration.found) throw new Error('Benchmark active authority did not restore')
  return {
    stateManifest: state.manifest,
    canonicalLedger: state.canonicalLedger,
    checkpoints: state.checkpoints,
    publicManifest: publicGeneration.manifest,
    rootArtifact: publicGeneration.rootArtifact,
    artifacts: publicGeneration.artifacts,
  }
}

function generationIdFor(result: Exclude<IncrementalRankingBuildResult, { action: 'no-change' }>) {
  const rootManifest = result.action === 'publish-incremental'
    ? result.patch.changedArtifacts.find((artifact) => artifact.logicalPath === '/data/ranking-summary.json')?.value
    : result.build?.publicPlan.manifest
  if (!rootManifest || typeof rootManifest !== 'object' || Array.isArray(rootManifest)) throw new Error('Benchmark root manifest is missing')
  const meta = (rootManifest as Record<string, unknown>).artifactMeta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || typeof (meta as Record<string, unknown>).runId !== 'string') {
    throw new Error('Benchmark generation id is missing')
  }
  return (meta as Record<string, unknown>).runId as string
}

function semanticMap(result: Exclude<IncrementalRankingBuildResult, { action: 'no-change' }>) {
  if (result.action === 'publish-incremental') {
    const mapped = Object.fromEntries(Object.entries(result.patch.previousManifest.artifacts as Record<string, { sha256: string }>)
      .map(([path, identity]) => [path, identity.sha256]))
    for (const path of result.patch.removedLogicalPaths) delete mapped[path]
    for (const artifact of result.patch.changedArtifacts) mapped[artifact.logicalPath] = prepareSemanticArtifact(artifact.value).digest
    return mapped
  }
  if (!result.build) throw new Error('Benchmark build is missing')
  return Object.fromEntries(result.build.publicPlan.writes.map((write) => [`/data/${write.relativePath}`, prepareSemanticArtifact(write.value).digest]))
}

function semanticDiff(left: Record<string, string>, right: Record<string, string>) {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((path) => left[path] !== right[path])
    .sort()
}

function firstValueDifference(left: unknown, right: unknown, path = '$'): { path: string; left: unknown; right: unknown } | undefined {
  if (Object.is(left, right)) return undefined
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return { path, left, right }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return { path, left, right }
    const length = Math.max(left.length, right.length)
    for (let index = 0; index < length; index += 1) {
      const difference = firstValueDifference(left[index], right[index], `${path}[${index}]`)
      if (difference) return difference
    }
    return undefined
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  for (const key of [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort()) {
    const difference = firstValueDifference(leftRecord[key], rightRecord[key], `${path}.${key}`)
    if (difference) return difference
  }
  return undefined
}

function semanticContent(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? prepareSemanticArtifact(value).semantic.content
    : value
}

async function currentCorpusShape() {
  const summary = JSON.parse(await readFile(resolve('public/data/ranking-summary.json'), 'utf8')) as Record<string, unknown>
  const directory = JSON.parse(await readFile(resolve('public/data/entities/teams.json'), 'utf8')) as { teams?: unknown[] }
  const coverage = summary.coverage as { matchCount?: number } | undefined
  return { matchCount: coverage?.matchCount ?? 4_477, teamCount: directory.teams?.length ?? 102 }
}

async function currentTeamPools() {
  const directory = JSON.parse(await readFile(resolve('public/data/entities/teams.json'), 'utf8')) as {
    teams?: Array<{ name?: string; league?: string }>
  }
  const pools = new Map<string, string[]>()
  for (const team of directory.teams ?? []) {
    if (!team.name || !team.league || !['LCK', 'LPL', 'LEC', 'LCS'].includes(team.league)) continue
    const names = pools.get(team.league) ?? []
    if (names.length < 6) names.push(team.name)
    pools.set(team.league, names)
  }
  const complete = [...pools.entries()].filter(([, names]) => names.length >= 2)
  if (complete.length < 4) throw new Error('Checked-in team directory cannot shape the benchmark corpus')
  return complete
}

function oracleCsv(count: number, pools: Array<[string, string[]]>, offset: number, corpusMatchCount: number) {
  const includeHeader = true
  const lines = includeHeader ? ['gameid,date,year,league,split,playoffs,patch,position,side,teamname,result,kills,totalgold'] : []
  for (let local = 0; local < count; local += 1) {
    const index = offset + local
    const [league, names] = pools[index % pools.length]!
    const leftIndex = Math.floor(index / pools.length) % names.length
    const teamA = names[leftIndex]!
    const opponentShift = 1 + (Math.floor(index / (pools.length * names.length)) % (names.length - 1))
    const teamB = names[(leftIndex + opponentShift) % names.length]!
    const date = benchmarkDate(index, corpusMatchCount)
    const year = date.slice(0, 4)
    const winnerA = index % 3 !== 0
    const common = [`benchmark-${index + 1}`, date, year, league, 'Season', '0', '26.1', 'team']
    lines.push([...common, 'Blue', teamA, winnerA ? '1' : '0', winnerA ? '10' : '5', winnerA ? '60000' : '55000'].map(csvCell).join(','))
    lines.push([...common, 'Red', teamB, winnerA ? '0' : '1', winnerA ? '5' : '10', winnerA ? '55000' : '60000'].map(csvCell).join(','))
  }
  return `${lines.join('\n')}\n`
}

function benchmarkDate(index: number, corpusMatchCount: number) {
  const start = Date.UTC(2025, 0, 12)
  const spanDays = Math.floor((Date.UTC(2026, 6, 16) - start) / 86_400_000)
  return new Date(start + Math.floor(index * spanDays / corpusMatchCount) * 86_400_000).toISOString().slice(0, 10)
}

function positiveInteger(value: string | undefined) {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function csvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

async function writeManifest(path: string, files: string[], generatedAt: string) {
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1, generatedAt, start: '2025-01-12', end: '2026-07-16',
    files: { oracleCsv: files }, sources: { oracle: { status: 'downloaded', downloadedCount: files.length, reusedCount: 0, failedCount: 0 } },
  })}\n`)
}

type StoredObject = {
  bytes: Buffer
  etag: string
  contentType?: string
  contentEncoding?: string
  metadata?: Record<string, string>
}
type PutLog = { key: string; bytes: number }

function memoryS3() {
  const objects = new Map<string, StoredObject>()
  const puts: PutLog[] = []
  const io = { get: 0, head: 0, put: 0 }
  let version = 0
  return {
    objects, puts, io,
    resetIo() { puts.length = 0; io.get = 0; io.head = 0; io.put = 0 },
    async send(command: unknown) {
      const details = command as { constructor: { name: string }; input: Record<string, unknown> }
      const name = details.constructor.name
      const input = details.input
      const key = String(input.Key)
      if (name === 'GetObjectCommand' || name === 'HeadObjectCommand') {
        if (name === 'GetObjectCommand') io.get += 1
        else io.head += 1
        const stored = objects.get(key)
        if (!stored) throw Object.assign(new Error('missing'), { name: name === 'GetObjectCommand' ? 'NoSuchKey' : 'NotFound' })
        return {
          ...(name === 'GetObjectCommand' ? { Body: Readable.from([stored.bytes]) } : {}),
          ETag: stored.etag, ContentLength: stored.bytes.byteLength,
          ContentType: stored.contentType, ContentEncoding: stored.contentEncoding, Metadata: stored.metadata,
        }
      }
      if (name === 'PutObjectCommand') {
        io.put += 1
        const current = objects.get(key)
        if (input.IfNoneMatch === '*' && current) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        if (input.IfMatch && input.IfMatch !== current?.etag) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        const bytes = await bodyBytes(input.Body)
        const etag = `"${++version}"`
        objects.set(key, {
          bytes, etag,
          contentType: typeof input.ContentType === 'string' ? input.ContentType : undefined,
          contentEncoding: typeof input.ContentEncoding === 'string' ? input.ContentEncoding : undefined,
          metadata: isStringRecord(input.Metadata) ? input.Metadata : undefined,
        })
        puts.push({ key, bytes: bytes.byteLength })
        return { ETag: etag }
      }
      throw new Error(`Unsupported benchmark storage command: ${name}`)
    },
  }
}

async function bodyBytes(value: unknown) {
  if (typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value)
  const chunks: Buffer[] = []
  for await (const chunk of value as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === 'string'))
}

function byteTotals(puts: PutLog[]) {
  const totals = { raw: 0, state: 0, publicObjects: 0, generationManifests: 0, activePointer: 0, other: 0 }
  for (const put of puts) {
    if (put.key.includes('/raw/')) totals.raw += put.bytes
    else if (put.key.includes('/state/')) totals.state += put.bytes
    else if (put.key.includes('/objects/sha256/')) totals.publicObjects += put.bytes
    else if (put.key.includes('/generations/')) totals.generationManifests += put.bytes
    else if (put.key.endsWith('/active-generation.json')) totals.activePointer += put.bytes
    else totals.other += put.bytes
  }
  return totals
}
