import { createHash } from 'node:crypto'
import { fork } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { buildRankingIncrementally, persistIncrementalStateBuild, type IncrementalRankingBuildResult, type RestoredIncrementalAuthority } from './incremental-ranking-orchestrator.ts'
import { importRankingSourceData, type RankingSourceImport } from './ranking-source-import.ts'
import { readActiveIncrementalState } from './incremental-state-storage.mjs'
import { acquireBucketLease, readActiveContentAddressedGeneration, readActiveRawSourceAuthority, uploadContentAddressedRawSourceGeneration, uploadRankingArtifacts } from './railway-bucket.mjs'
import { prepareSemanticArtifact } from './public-artifact-storage.mjs'
import { finalizeRawSourceGeneration, prepareRawSourceGeneration, type ActiveRawSourceAuthority } from './raw-source-generation.mjs'
import { parseRawSourceReceipt } from './raw-source-storage.mjs'
import { buildPlayerModel } from '../src/lib/model.ts'
import { refreshWorkerExecArgv } from './refresh-worker-memory.mjs'
import {
  aggregateBenchmarkMetrics,
  INCREMENTAL_SAFETY_PEAK_RSS_BYTES,
  oracleBaselineRewriteEvidence,
  passesIncrementalSafetyPeak,
} from './incremental-benchmark-assertions.ts'

type RefreshDataIfChanged = (args?: string[], options?: Record<string, unknown>) => Promise<Record<string, unknown>>
const refreshModulePath: string = './refresh-data-if-changed.mjs'
const { refreshDataIfChanged } = await import(refreshModulePath) as { refreshDataIfChanged: RefreshDataIfChanged }

const corpusMinimums = { matches: 4_477, teams: 102, players: 356 }
const targets = {
  computeMs: 15_000,
  safetyPeakRssBytes: INCREMENTAL_SAFETY_PEAK_RSS_BYTES,
  functionalPeakRssBytes: 750 * 1024 * 1024,
  uploadedBytes: 2 * 1024 * 1024,
  fullSnapshotWritten: false,
}
const config = { enabled: true, bucket: 'benchmark', endpoint: 'https://example.invalid', region: 'auto', accessKeyId: 'x', secretAccessKey: 'y', prefix: 'rankings' }
let root = process.env.RANKING_BENCHMARK_ROOT ?? ''

if (process.argv.includes('--raw-profile-baseline')) {
  if (!root) throw new Error('Raw profile baseline requires RANKING_BENCHMARK_ROOT')
  await runRawProfileBaseline()
} else if (process.argv.includes('--raw-profile-next')) {
  if (!root) throw new Error('Raw profile next requires RANKING_BENCHMARK_ROOT')
  await runRawProfileNext()
} else if (process.argv.includes('--benchmark-worker')) {
  if (!root) throw new Error('Benchmark worker requires RANKING_BENCHMARK_ROOT')
  await runBenchmarkWorker()
} else if (process.argv.includes('--benchmark-verifier')) {
  if (!root) throw new Error('Benchmark verifier requires RANKING_BENCHMARK_ROOT')
  await runBenchmarkVerifier()
} else if (process.argv.includes('--player-profile-worker')) {
  if (!root) throw new Error('Player profile worker requires RANKING_BENCHMARK_ROOT')
  await runPlayerProfileWorker()
} else {
  root = await mkdtemp(join(tmpdir(), 'incremental-ranking-benchmark-'))
  try {
    if (process.argv.includes('--raw-prepare-profile')) await runRawPrepareProfileParent()
    else if (process.argv.includes('--player-memory-profile')) await runPlayerMemoryProfileParent()
    else await runBenchmarkParent()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function runPlayerMemoryProfileParent() {
  const matches = await currentMatches()
  const teams = await currentTeams()
  const players = await currentPlayers()
  const csvPath = join(root, 'player-profile.csv')
  const manifestPath = join(root, 'player-profile-manifest.json')
  const leaguepediaPath = join(root, 'player-profile-leaguepedia.json')
  const lolEsportsPath = join(root, 'player-profile-lolesports.json')
  await writeFile(csvPath, oracleCsv(matches, teams, players))
  await writeFile(leaguepediaPath, `${JSON.stringify(leaguepediaFixture(matches[0]!))}\n`)
  await writeFile(lolEsportsPath, `${JSON.stringify(lolEsportsFixture(matches[0]!))}\n`)
  await writeManifest(
    manifestPath,
    [csvPath],
    '2026-07-22T00:00:00.000Z',
    leaguepediaPath,
    lolEsportsPath,
    matches[0]!.date,
    matches.at(-1)!.date,
  )
  const measured = await measureForkedChild(fork(fileURLToPath(import.meta.url), ['--player-profile-worker'], {
    cwd: process.cwd(),
    env: { ...process.env, RANKING_BENCHMARK_ROOT: root },
    execArgv: refreshWorkerExecArgv(process.execArgv),
    silent: true,
  }), 'Player memory profile worker')
  process.stdout.write(`${JSON.stringify({
    corpus: { matches: matches.length, teams: Object.keys(teams).length, players: Object.keys(players).length },
    ...measured.output,
    sampledPeakRssBytes: measured.sampledPeakRssBytes,
    sampledPeakAtMs: measured.sampledPeakAtMs,
    sampleCount: measured.sampleCount,
  })}\n`)
}

async function runPlayerProfileWorker() {
  const source = await importRankingSourceData({ manifestPath: join(root, 'player-profile-manifest.json') })
  globalThis.gc?.()
  const startingRssBytes = process.memoryUsage().rss
  process.send?.({ type: 'measurement-start' })
  const started = performance.now()
  const players = buildPlayerModel(source.matches, {}, { teams: source.teams })
  const durationMs = Math.round(performance.now() - started)
  const rssBytes = process.memoryUsage().rss
  const maxRssBytes = Math.round(process.resourceUsage().maxRSS * 1024)
  process.send?.({ type: 'measurement-stop' })
  process.stdout.write(`${JSON.stringify({
    importedMatchCount: source.matches.length,
    playerCount: players.length,
    historyEntryCount: players.reduce((total, player) => total + player.history.length, 0),
    durationMs,
    startingRssBytes,
    rssBytes,
    maxRssBytes,
    semanticDigest: prepareSemanticArtifact({ artifactKind: 'player-model-profile', players }).digest,
  })}\n`)
}

async function runRawPrepareProfileParent() {
  const matches = await currentMatches()
  const teams = await currentTeams()
  const players = await currentPlayers()
  const added = appendedMatch(matches)
  const baselineCsv = join(root, 'raw-profile-baseline.csv')
  const nextCsv = join(root, 'raw-profile-next.csv')
  const baselineManifest = join(root, 'raw-profile-baseline-manifest.json')
  const nextManifest = join(root, 'raw-profile-next-manifest.json')
  const leaguepediaPath = join(root, 'raw-profile-leaguepedia.json')
  const lolEsportsPath = join(root, 'raw-profile-lolesports.json')
  await writeFile(baselineCsv, oracleCsv(matches, teams, players))
  await writeFile(nextCsv, oracleCsv([...matches, added], teams, players))
  await writeFile(leaguepediaPath, `${JSON.stringify(leaguepediaFixture(matches[0]!))}\n`)
  await writeFile(lolEsportsPath, `${JSON.stringify(lolEsportsFixture(matches[0]!))}\n`)
  await writeManifest(baselineManifest, [baselineCsv], '2026-07-22T00:00:00.000Z', leaguepediaPath, lolEsportsPath, matches[0]!.date, added.date)
  await writeManifest(nextManifest, [nextCsv], '2026-07-22T00:00:00.000Z', leaguepediaPath, lolEsportsPath, matches[0]!.date, added.date)
  await runPlainChild('--raw-profile-baseline')
  const measured = await runMeasuredRawProfileChild()
  process.stdout.write(`${JSON.stringify({
    corpus: { matches: matches.length, teams: Object.keys(teams).length, players: Object.keys(players).length },
    ...measured.output,
    sampledPeakRssBytes: measured.sampledPeakRssBytes,
    sampledPeakAtMs: measured.sampledPeakAtMs,
    sampleCount: measured.sampleCount,
  })}\n`)
}

async function runRawProfileBaseline() {
  const generation = await prepareRawSourceGeneration({
    manifestPath: join(root, 'raw-profile-baseline-manifest.json'),
    importerVersion: 'community-source-import-v1',
  })
  await writeFile(join(root, 'raw-profile-receipt.json'), JSON.stringify(generation.receipt))
}

async function runRawProfileNext() {
  const receipt = parseRawSourceReceipt(JSON.parse(await readFile(join(root, 'raw-profile-receipt.json'), 'utf8')))
  const previousAuthority: ActiveRawSourceAuthority = {
    receipt,
    objectResolver: async () => { throw new Error('Inventory raw prepare unexpectedly resolved a previous raw object') },
  }
  process.send?.({ type: 'measurement-start' })
  const started = performance.now()
  const generation = await prepareRawSourceGeneration({
    manifestPath: join(root, 'raw-profile-next-manifest.json'),
    importerVersion: 'community-source-import-v1',
    previousAuthority,
  })
  const durationMs = Math.round(performance.now() - started)
  const rssBytes = process.memoryUsage().rss
  const maxRssBytes = Math.round(process.resourceUsage().maxRSS * 1024)
  process.send?.({ type: 'measurement-stop' })
  process.stdout.write(`${JSON.stringify({
    durationMs,
    rssBytes,
    maxRssBytes,
    objectCount: generation.objects.length,
    inventoryCount: generation.oracle.reduce((sum, source) => sum + source.gameInventory.length, 0),
  })}\n`)
}

async function runPlainChild(mode: string) {
  const child = fork(fileURLToPath(import.meta.url), [mode], {
    cwd: process.cwd(), env: { ...process.env, RANKING_BENCHMARK_ROOT: root }, execArgv: process.execArgv, silent: true,
  })
  const stderr: Buffer[] = []
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
  const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('close', resolveExit)
  })
  if (exitCode !== 0) throw new Error(`Raw profile setup failed: ${Buffer.concat(stderr).toString('utf8')}`)
}

async function runMeasuredRawProfileChild() {
  const child = fork(fileURLToPath(import.meta.url), ['--raw-profile-next'], {
    cwd: process.cwd(), env: { ...process.env, RANKING_BENCHMARK_ROOT: root }, execArgv: process.execArgv, silent: true,
  })
  return measureForkedChild(child, 'Raw prepare profile worker')
}

async function measureForkedChild(child: ReturnType<typeof fork>, label: string) {
  let measuring = false
  let sampledPeakRssBytes = 0
  let sampledPeakAtMs = 0
  let measurementStartedAt = 0
  let sampleCount = 0
  const sample = () => {
    if (!measuring || !child.pid) return
    try {
      const rssBytes = recursiveProcessTreeRssBytes(child.pid)
      if (rssBytes <= 0) return
      if (rssBytes > sampledPeakRssBytes) {
        sampledPeakRssBytes = rssBytes
        sampledPeakAtMs = Date.now() - measurementStartedAt
      }
      sampleCount += 1
    } catch {
      // The child may exit between the timer tick and the procfs read.
    }
  }
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return
    const type = (message as { type?: unknown }).type
    if (type === 'measurement-start') {
      measuring = true
      measurementStartedAt = Date.now()
      sample()
    } else if (type === 'measurement-stop') {
      sample()
      measuring = false
    }
  })
  const timer = setInterval(sample, 10)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
  const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('close', resolveExit)
  })
  clearInterval(timer)
  if (exitCode !== 0) throw new Error(`${label} failed: ${Buffer.concat(stderr).toString('utf8')}`)
  const line = Buffer.concat(stdout).toString('utf8').trim().split('\n').filter(Boolean).at(-1)
  if (!line) throw new Error(`${label} produced no output`)
  return { output: JSON.parse(line) as Record<string, unknown>, sampledPeakRssBytes, sampledPeakAtMs, sampleCount }
}

type BenchmarkSetup = {
  currentShape: { matchCount: number; teamCount: number; playerCount: number }
  benchmarkMatchCount: number
  baselineGenerationId: string
  baselineMatchCount: number
  baselineRawDeltaCount: number
  nextEnd: string
  fixtureShape: FixtureShape
}

type FixtureShape = {
  importedMatchCount: number
  importedTeamCount: number
  sourceMatchCount: number
  sourceTeamCount: number
  sourcePlayerCount: number
  retainedJsonBytes: {
    importedMatches: number
    ratedMatches: number
    teams: number
    mergedTeams: number
  }
}

async function runBenchmarkParent() {
  const parentRoot = root
  const currentShape = await currentCorpusShape()
  const benchmarkMatchCount = positiveInteger(process.env.RANKING_BENCHMARK_MATCH_COUNT) ?? currentShape.matchCount
  const requestedRepeats = positiveInteger(process.env.RANKING_BENCHMARK_REPEATS)
  const repeats = requestedRepeats ?? (process.argv.includes('--smoke') ? 1 : 3)
  if (process.argv.includes('--enforce-targets')) {
    assertGateScale('matches', benchmarkMatchCount, corpusMinimums.matches)
    assertGateScale('teams', currentShape.teamCount, corpusMinimums.teams)
    assertGateScale('players', currentShape.playerCount, corpusMinimums.players)
    assertGateScale('isolated repeats', repeats, 3)
  }
  const teams = await currentTeams()
  const players = await currentPlayers()
  const checkedInMatches = await currentMatches()
  if (benchmarkMatchCount > checkedInMatches.length) {
    throw new Error(`Checked-in match corpus is undersized: ${checkedInMatches.length} < ${benchmarkMatchCount}`)
  }
  const measurements: Array<Awaited<ReturnType<typeof runMeasuredWorker>> & {
    verifierSampledPeakRssBytes: number
    verifierSampleCount: number
  }> = []
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    root = join(parentRoot, `isolated-${repeat + 1}`)
    await mkdir(root, { recursive: true })
    const baselineCsv = join(root, 'provider-baseline', 'oracle-current.csv')
    const nextCsv = join(root, 'provider-next', 'oracle-current.csv')
    const baselineManifest = join(root, 'baseline-manifest.json')
    const nextManifest = join(root, 'next-manifest.json')
    const leaguepediaPath = join(root, 'leaguepedia-narrow.json')
    const lolEsportsPath = join(root, 'lolesports-schedule.json')
    await mkdir(dirname(baselineCsv), { recursive: true })
    await mkdir(dirname(nextCsv), { recursive: true })
    const baselineMatches = checkedInMatches.slice(0, benchmarkMatchCount)
    const addedMatch = appendedMatch(baselineMatches)
    await writeFile(baselineCsv, oracleCsv(baselineMatches, teams, players))
    await writeFile(nextCsv, oracleCsv([...baselineMatches, addedMatch], teams, players))
    await writeFile(leaguepediaPath, `${JSON.stringify(leaguepediaFixture(baselineMatches[0]!))}\n`)
    await writeFile(lolEsportsPath, `${JSON.stringify(lolEsportsFixture(addedMatch))}\n`)
    const coverageStart = baselineMatches[0]!.date
    await writeManifest(baselineManifest, [baselineCsv], '2026-07-22T00:00:00.000Z', leaguepediaPath, lolEsportsPath, coverageStart, addedMatch.date)
    await writeManifest(nextManifest, [nextCsv], '2026-07-22T00:00:00.000Z', leaguepediaPath, lolEsportsPath, coverageStart, addedMatch.date)
    const rawHistoryManifests = []
    for (let depth = 4; depth >= 1; depth -= 1) {
      const historyCsv = join(root, `provider-history-${depth}`, 'oracle-current.csv')
      const historyManifest = join(root, `history-${depth}-manifest.json`)
      await mkdir(dirname(historyCsv), { recursive: true })
      await writeFile(historyCsv, oracleCsv(baselineMatches.slice(0, -depth), teams, players))
      await writeManifest(historyManifest, [historyCsv], '2026-07-22T00:00:00.000Z', leaguepediaPath, lolEsportsPath, coverageStart, addedMatch.date)
      rawHistoryManifests.push(historyManifest)
    }
    const fixtureShape = await assertSingleImportedAppend(baselineManifest, nextManifest)

    const client = await fileBackedS3()
    const { generationId: baselineGenerationId, matchCount: baselineMatchCount, rawDeltaCount: baselineRawDeltaCount } = await seedBaseline(client, baselineManifest, rawHistoryManifests)
    await client.save()
    await writeFile(join(root, 'benchmark-setup.json'), JSON.stringify({
      currentShape, benchmarkMatchCount, baselineGenerationId, baselineMatchCount, baselineRawDeltaCount, nextEnd: addedMatch.date, fixtureShape,
    } satisfies BenchmarkSetup))
    const measurement = await runMeasuredWorker()
    const verification = await runBenchmarkVerifierProcess()
    measurements.push({
      ...measurement,
      output: { ...measurement.output, ...verification.output },
      verifierSampledPeakRssBytes: verification.sampledPeakRssBytes,
      verifierSampleCount: verification.sampleCount,
    })
  }
  root = parentRoot

  const effectivePeakRssBytes = Math.max(...measurements.map((measurement) => Math.max(
    measurement.sampledPeakRssBytes,
    measurement.output.maxRssBytes,
  )))
  const allFunctional = measurements.every(({ output, sampledPeakRssBytes, sampleCount }) => {
    const peakRssBytes = Math.max(sampledPeakRssBytes, output.maxRssBytes)
    const restoreDurationMs = refreshStageDuration(output.refreshStages, 'restore')
    return output.computeMs < targets.computeMs
      && peakRssBytes < targets.functionalPeakRssBytes
      && output.uploadedBytes < targets.uploadedBytes
      && output.fullSnapshotWritten === targets.fullSnapshotWritten
      && output.parity
      && output.corpusValid
      && output.appendedMatches === 1
      && output.replayedMatchCount === 1
      && output.materializedScopeCount === 2
      && output.fullRawRewrite === false
      && Number(output.baselineRawDeltaCount) >= 4
      && Number(output.reconciliationMatchCount) > 0
      && output.appendedReconciliationStatus === 'exact'
      && sampleCount > 0
      && sampledPeakRssBytes > 0
      && output.maxRssBytes > 0
      && Number(output.mainMaxRssBytes) > 0
      && Number(output.rawChildMaxRssBytes) > 0
      && typeof restoreDurationMs === 'number'
      && restoreDurationMs > 0
  })
  const pass = allFunctional && passesIncrementalSafetyPeak(effectivePeakRssBytes)
  const repetitions = measurements.map(({ output, sampledPeakRssBytes, sampledPeakAtMs, sampleCount }, index) => ({
      repeat: index + 1,
      computeMs: Number(output.computeMs),
      uploadedBytes: Number(output.uploadedBytes),
      sampledPeakRssBytes,
      sampledPeakAtMs,
      maxRssBytes: Number(output.maxRssBytes),
      mainMaxRssBytes: Number(output.mainMaxRssBytes),
      rawChildMaxRssBytes: Number(output.rawChildMaxRssBytes),
      sampleCount,
      parity: Boolean(output.parity),
      replayedMatchCount: Number(output.replayedMatchCount),
      materializedScopeCount: Number(output.materializedScopeCount),
      fullSnapshotWritten: Boolean(output.fullSnapshotWritten),
      fullRawRewrite: Boolean(output.fullRawRewrite),
      rawRewriteEvidence: output.rawRewriteEvidence,
      baselineRawDeltaCount: Number(output.baselineRawDeltaCount),
      reconciliationMatchCount: Number(output.reconciliationMatchCount),
      appendedReconciliationStatus: output.appendedReconciliationStatus,
      restoreDurationMs: refreshStageDuration(output.refreshStages, 'restore') ?? Number.NaN,
      verifierMs: Number(output.verifierMs),
      verifierMaxRssBytes: Number(output.verifierMaxRssBytes),
    }))
  const aggregate = aggregateBenchmarkMetrics(repetitions)
  const reference = measurements[0]!.output
  const result = {
    label: 'production-shaped-local',
    corpus: reference.corpus,
    target: reference.target,
    repeatCount: repeats,
    aggregate,
    computeMs: aggregate.max.computeMs,
    uploadedBytes: aggregate.max.uploadedBytes,
    peakRssBytes: effectivePeakRssBytes,
    maxRssBytes: aggregate.max.mainMaxRssBytes,
    mainMaxRssBytes: aggregate.max.mainMaxRssBytes,
    rawChildMaxRssBytes: aggregate.max.rawChildMaxRssBytes,
    appendedMatches: Math.max(...measurements.map(({ output }) => Number(output.appendedMatches))),
    corpusValid: measurements.every(({ output }) => Boolean(output.corpusValid)),
    fullSnapshotWritten: repetitions.some((entry) => entry.fullSnapshotWritten),
    fullRawRewrite: repetitions.some((entry) => entry.fullRawRewrite),
    parity: repetitions.every((entry) => entry.parity),
    replayedMatchCount: Math.max(...repetitions.map((entry) => entry.replayedMatchCount)),
    materializedScopeCount: Math.max(...repetitions.map((entry) => entry.materializedScopeCount)),
    baselineRawDeltaCount: Math.min(...repetitions.map((entry) => entry.baselineRawDeltaCount)),
    reconciliationMatchCount: Math.min(...repetitions.map((entry) => entry.reconciliationMatchCount)),
    appendedReconciliationStatus: repetitions.every((entry) => entry.appendedReconciliationStatus === 'exact') ? 'exact' : 'mixed',
    differingPaths: [...new Set(measurements.flatMap(({ output }) => Array.isArray(output.differingPaths) ? output.differingPaths : []))].sort(),
    differingIdentities: [...new Set(measurements.flatMap(({ output }) => Object.keys(output.differingIdentities ?? {})))].sort(),
    rssSampling: {
      intervalMs: 10,
      sampleCount: measurements.reduce((sum, measurement) => sum + measurement.sampleCount, 0),
      sampledPeakRssBytes: aggregate.max.sampledPeakRssBytes,
      mainProcessMaxRssBytes: aggregate.max.mainMaxRssBytes,
      rawChildMaxRssBytes: aggregate.max.rawChildMaxRssBytes,
      effective: 'max(recursiveSampledPeakRssBytes, mainProcessMaxRssBytes, rawChildMaxRssBytes)',
    },
    verifierRssSampling: {
      sampleCount: measurements.reduce((sum, measurement) => sum + measurement.verifierSampleCount, 0),
      sampledPeakRssBytes: Math.max(...measurements.map((measurement) => measurement.verifierSampledPeakRssBytes)),
      processMaxRssBytes: Math.max(...measurements.map((measurement) => Number(measurement.output.verifierMaxRssBytes))),
      excludedFromProductionGate: true,
    },
    repetitions,
    pass,
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (process.argv.includes('--enforce-targets') && !pass) process.exitCode = 1
}

function refreshStageDuration(stages: unknown, name: string) {
  if (!Array.isArray(stages)) return undefined
  const stage = stages.find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && (entry as Record<string, unknown>).name === name) as Record<string, unknown> | undefined
  return typeof stage?.durationMs === 'number' ? stage.durationMs : undefined
}

async function assertSingleImportedAppend(baselineManifest: string, nextManifest: string) {
  const [baseline, next] = await Promise.all([
    importRankingSourceData({ manifestPath: baselineManifest }),
    importRankingSourceData({ manifestPath: nextManifest }),
  ])
  const before = new Set(baseline.matches.map((match) => match.sourceGameId ?? match.id))
  const after = new Set(next.matches.map((match) => match.sourceGameId ?? match.id))
  const added = [...after].filter((key) => !before.has(key))
  const removed = [...before].filter((key) => !after.has(key))
  if (added.length !== 1 || removed.length !== 0) {
    throw new Error(`Benchmark fixture is not one imported append: ${JSON.stringify({ added, removed })}`)
  }
  return {
    importedMatchCount: next.matches.length,
    importedTeamCount: Object.keys(next.teams).length,
    sourceMatchCount: next.importedMatches.length,
    sourceTeamCount: new Set(next.importedMatches.flatMap((match) => [match.teamA, match.teamB])).size,
    sourcePlayerCount: new Set(next.importedMatches.flatMap((match) => [
      ...(match.teamARoster?.players ?? []),
      ...(match.teamBRoster?.players ?? []),
    ].map((player) => player.id))).size,
    retainedJsonBytes: {
      importedMatches: Buffer.byteLength(JSON.stringify(next.importedMatches)),
      ratedMatches: Buffer.byteLength(JSON.stringify(next.matches)),
      teams: Buffer.byteLength(JSON.stringify(next.teams)),
      mergedTeams: Buffer.byteLength(JSON.stringify(next.mergedTeams)),
    },
  }
}

async function runBenchmarkWorker() {
  const setup = JSON.parse(await readFile(join(root, 'benchmark-setup.json'), 'utf8')) as BenchmarkSetup
  const { currentShape, benchmarkMatchCount, baselineMatchCount, nextEnd } = setup
  const nextCsv = join(root, 'provider-next', 'oracle-current.csv')
  const nextManifest = join(root, 'next-manifest.json')
  const client = await fileBackedS3()
  const priorRawAuthority = await readActiveRawSourceAuthority({ config, client })
  if (!priorRawAuthority.found) throw new Error(`Benchmark prior raw authority did not restore: ${priorRawAuthority.reason}`)
  const priorOracleBaselineKeys = priorRawAuthority.receipt.oracle.map((entry) => entry.baseline.key)
  const refreshRoot = join(root, 'production-refresh')
  const rawDir = join(refreshRoot, 'raw')
  const materializedManifest = join(rawDir, 'manifest.json')
  const lease = await acquireBucketLease('ops/refresh-lease.json', {
    owner: 'benchmark-worker',
    now: new Date(),
    config,
    client,
  })
  if (!lease.acquired) throw new Error(`Benchmark could not acquire production-shaped lease: ${lease.reason}`)

  client.resetIo()
  globalThis.gc?.()
  process.send?.({ type: 'measurement-start' })
  const started = performance.now()
  const refreshResult = await refreshDataIfChanged([
    '--raw-dir', rawDir,
    '--manifest', materializedManifest,
    '--state', join(rawDir, 'refresh-state.json'),
    '--staging-dir', join(refreshRoot, 'staging'),
    '--output', join(refreshRoot, 'ranking-snapshot.full.json'),
    '--public-data-dir', join(refreshRoot, 'public'),
    '--reconciliation-output', join(rawDir, 'reconciliation.json'),
    '--end', nextEnd,
    '--force',
  ], {
    env: {
      RANKING_INCREMENTAL_ENABLED: 'true',
      RANKING_REFRESH_MODE: 'gated',
      RANKING_REFRESH_CAUSE: 'pending-match',
      RANKING_REFRESH_RUN_ID: 'production-shaped-local',
      RANKING_BUCKET_RESTORE_RAW: 'true',
      RANKING_BUCKET_UPLOAD_ENABLED: 'true',
      RANKING_BUCKET_CONTENT_ADDRESSED: 'true',
      RANKING_REFRESH_LEASE_OWNER: lease.lease.owner,
      RANKING_REFRESH_FENCING_TOKEN: String(lease.lease.fencingToken),
      RANKING_REFRESH_LEASE_KEY: 'ops/refresh-lease.json',
      RANKING_REFRESH_PROMOTION_ETAG: lease.promotionEtag ?? '',
    },
    bucketConfig: config,
    bucketClient: client,
    now: Date.now,
    monotonicNow: () => performance.now(),
    run: async (_command: string, args: string[]) => stageProviderManifest(nextManifest, args),
  })
  const computeMs = performance.now() - started
  const productionRss = process.memoryUsage().rss
  const mainMaxRssBytes = Math.round(process.resourceUsage().maxRSS * 1024)
  process.send?.({ type: 'measurement-stop' })
  const measuredStorageCommands = { ...client.io }
  const incrementalMetrics = refreshResult.incrementalMetrics
  if (!isIncrementalMetrics(incrementalMetrics) || incrementalMetrics.fullSnapshotWritten
    || incrementalMetrics.replayedMatchCount !== 1) {
    let diagnostic: unknown
    try {
      diagnostic = JSON.parse(await readFile(join(rawDir, 'incremental-diagnostic.json'), 'utf8'))
    } catch {
      diagnostic = undefined
    }
    throw new Error(`Benchmark production refresh did not exercise exactly one incremental append replay: ${JSON.stringify({ incrementalMetrics, diagnostic })}`)
  }
  const generationId = String(refreshResult.generationId)
  if (!generationId || generationId === 'undefined') throw new Error('Benchmark production refresh did not publish a generation')
  const uploadedBytes = client.puts.reduce((sum, put) => sum + put.bytes, 0)
  const bytesBySurface = byteTotals(client.puts)
  const activeRawAuthority = await readActiveRawSourceAuthority({ config, client })
  if (!activeRawAuthority.found) throw new Error(`Benchmark active raw authority did not restore after promotion: ${activeRawAuthority.reason}`)
  const activeOracleBaselineKeys = activeRawAuthority.receipt.oracle.map((entry) => entry.baseline.key)
  const bucketPrefix = `${config.prefix}/`
  const rawRewriteEvidence = oracleBaselineRewriteEvidence({
    priorBaselineKeys: priorOracleBaselineKeys,
    activeBaselineKeys: activeOracleBaselineKeys,
    uploadedObjectKeys: client.puts.map((put) => put.key.startsWith(bucketPrefix) ? put.key.slice(bucketPrefix.length) : put.key),
  })
  await client.save()
  const refreshState = JSON.parse(await readFile(join(rawDir, 'refresh-state.json'), 'utf8')) as {
    lastRun?: {
      stages?: Array<{
        durationMs?: unknown
        name?: unknown
        output?: { childMaxRssBytes?: unknown; maxRssBytes?: unknown; peakRssBytes?: unknown; maxPlayerCount?: unknown; rssBytes?: unknown }
        result?: unknown
      }>
    }
  }
  const refreshStages = (refreshState.lastRun?.stages ?? []).map((stage) => ({
    name: stage.name,
    durationMs: stage.durationMs,
    result: stage.result,
    rssBytes: stage.output?.rssBytes,
    maxRssBytes: stage.output?.maxRssBytes,
    peakRssBytes: stage.output?.peakRssBytes,
    maxPlayerCount: stage.output?.maxPlayerCount,
    childMaxRssBytes: stage.output?.childMaxRssBytes,
  }))
  const rawChildMaxRssBytes = Math.max(0, ...refreshStages.map((stage) => Number(stage.childMaxRssBytes) || 0))
  const maxRssBytes = Math.max(mainMaxRssBytes, rawChildMaxRssBytes)
  const reconciliation = JSON.parse(await readFile(join(rawDir, 'reconciliation.json'), 'utf8')) as {
    matches?: Array<{ matchId?: unknown; status?: unknown }>
  }
  const reconciliationMatches = reconciliation.matches ?? []
  const appendedReconciliation = reconciliationMatches.find((entry) => entry.matchId === 'benchmark-added-series')
  const { fixtureShape } = setup
  const output = {
    corpus: {
      fixtureSource: 'checked-in-sanitized-public-corpus',
      fixtureReason: 'raw provider files are ignored and unavailable in isolated CI; checked-in canonical pages preserve production match distributions',
      referenceMatchCount: currentShape.matchCount,
      benchmarkMatchCount,
      referenceTeamCount: currentShape.teamCount,
      referencePlayerCount: currentShape.playerCount,
      ...fixtureShape,
      sourceBytes: (await readFile(nextCsv)).byteLength,
      appendedMatches: fixtureShape.importedMatchCount - baselineMatchCount,
    },
    appendedMatches: fixtureShape.importedMatchCount - baselineMatchCount,
    corpusValid: benchmarkMatchCount >= corpusMinimums.matches
      && fixtureShape.sourceTeamCount >= corpusMinimums.teams
      && fixtureShape.sourcePlayerCount >= corpusMinimums.players,
    computeMs: Math.round(computeMs), uploadedBytes,
    maxRssBytes,
    mainMaxRssBytes,
    rawChildMaxRssBytes,
    stageMs: { productionRefresh: Math.round(computeMs) },
    stageRssBytes: { productionRefresh: productionRss },
    refreshStages,
    uploadedBytesBySurface: bytesBySurface,
    storageCommands: measuredStorageCommands,
    storagePutCount: client.puts.length,
    fullSnapshotWritten: incrementalMetrics.fullSnapshotWritten,
    materializedScopeCount: incrementalMetrics.materializedScopeCount,
    replayedMatchCount: incrementalMetrics.replayedMatchCount,
    replayFromUtcDate: incrementalMetrics.replayFromUtcDate,
    selectedBoundary: incrementalMetrics.selectedBoundary,
    changedPaths: incrementalMetrics.changedPaths.length,
    reusedPaths: incrementalMetrics.reusedPaths.length,
    removedPaths: incrementalMetrics.removedPaths,
    memoryCollections: incrementalMetrics.memoryCollections,
    fullRawRewrite: rawRewriteEvidence.fullRawRewrite,
    rawRewriteEvidence,
    baselineRawDeltaCount: setup.baselineRawDeltaCount,
    reconciliationMatchCount: reconciliationMatches.length,
    appendedReconciliationStatus: appendedReconciliation?.status,
    target: {
      computeMs: '<15000', safetyPeakRssBytes: '<734003200', functionalPeakRssBytes: '<786432000',
      uploadedBytes: '<2097152', fullSnapshotWritten: false, parity: true, appendedMatches: 1,
      minimumCorpus: corpusMinimums,
    },
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

async function runBenchmarkVerifier() {
  globalThis.gc?.()
  const started = performance.now()
  const client = await fileBackedS3()
  const materializedManifest = join(root, 'production-refresh', 'raw', 'manifest.json')
  const [restored, nextSource] = await Promise.all([
    restoreFromStorage(client),
    importRankingSourceData({ manifestPath: materializedManifest }),
  ])
  const activeArtifactReferences = restored.publicManifest.artifacts
  if (!restored.loadArtifacts || !activeArtifactReferences || typeof activeArtifactReferences !== 'object'
    || Array.isArray(activeArtifactReferences)) {
    throw new Error('Benchmark verifier restored authority is missing lazy public artifacts')
  }
  const incrementalValues = await restored.loadArtifacts(Object.keys(activeArtifactReferences))
  const incrementalSemantic = semanticMapFromValues(incrementalValues)
  const generatedAt = typeof restored.publicManifest.generatedAt === 'string'
    ? restored.publicManifest.generatedAt
    : '2026-07-22T00:00:00.000Z'
  if (Array.isArray(restored.rootArtifact?.sources)) {
    const activeSources = restored.rootArtifact.sources as RankingSourceImport['externalSources']
    nextSource.externalSources = nextSource.externalSources.map((source) => {
      const activeSource = activeSources.find((candidate) => candidate.name === source.name)
      return activeSource?.retrievedAt ? { ...source, retrievedAt: activeSource.retrievedAt } : source
    })
  }
  const full = await run('full', nextSource, generatedAt, {
    mode: 'legacy', cause: 'daily-audit', enabled: false,
    sourceReceiptDigest: restored.stateManifest.sourceReceiptDigest,
  })
  if (full.action === 'no-change') throw new Error('Benchmark clean full build did not materialize')
  const fullSemantic = semanticMap(full)
  const differingPaths = semanticDiff(incrementalSemantic, fullSemantic)
  const fullValues = Object.fromEntries(full.build!.publicPlan.writes.map((write) => [`/data/${write.relativePath}`, write.value]))
  const differenceDetails = Object.fromEntries(differingPaths.map((path) => [path, firstValueDifference(
    semanticContent(incrementalValues[path]),
    semanticContent(fullValues[path]),
  )]))
  const differingIdentities = Object.fromEntries(differingPaths.map((path) => [path, {
    incremental: incrementalSemantic[path],
    full: fullSemantic[path],
    incrementalRecomputed: incrementalValues[path] ? prepareSemanticArtifact(incrementalValues[path]).digest : undefined,
    fullRecomputed: fullValues[path] ? prepareSemanticArtifact(fullValues[path]).digest : undefined,
  }]))
  process.stdout.write(`${JSON.stringify({
    parity: differingPaths.length === 0,
    stateCheckpointCount: restored.stateManifest.checkpoints.length,
    activeLogicalPathCount: Object.keys(incrementalValues).length,
    fullLogicalPathCount: Object.keys(fullValues).length,
    differingPaths,
    differenceDetails,
    differingIdentities,
    verifierMs: Math.round(performance.now() - started),
    verifierMaxRssBytes: Math.round(process.resourceUsage().maxRSS * 1024),
  })}\n`)
}

async function runMeasuredWorker() {
  const child = fork(fileURLToPath(import.meta.url), ['--benchmark-worker'], {
    cwd: process.cwd(),
    env: { ...process.env, RANKING_BENCHMARK_ROOT: root },
    execArgv: refreshWorkerExecArgv(process.execArgv),
    silent: true,
  })
  let measuring = false
  let sampledPeakRssBytes = 0
  let sampleCount = 0
  let measurementStartedAt = 0
  let sampledPeakAtMs = 0
  const sample = () => {
    if (!measuring || !child.pid) return
    try {
      const rssBytes = recursiveProcessTreeRssBytes(child.pid)
      if (rssBytes <= 0) return
      if (rssBytes > sampledPeakRssBytes) {
        sampledPeakRssBytes = rssBytes
        sampledPeakAtMs = Date.now() - measurementStartedAt
      }
      sampleCount += 1
    } catch {
      // The child may exit between the timer tick and the procfs read.
    }
  }
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return
    const type = (message as { type?: unknown }).type
    if (type === 'measurement-start') {
      measuring = true
      measurementStartedAt = Date.now()
      sample()
    } else if (type === 'measurement-stop') {
      sample()
      measuring = false
    }
  })
  const timer = setInterval(sample, 10)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
  const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('close', resolveExit)
  })
  clearInterval(timer)
  if (exitCode !== 0) {
    throw new Error(`Benchmark worker failed with exit code ${exitCode}: ${Buffer.concat(stderr).toString('utf8')}`)
  }
  const lines = Buffer.concat(stdout).toString('utf8').trim().split('\n').filter(Boolean)
  const lastLine = lines.at(-1)
  if (!lastLine) throw new Error('Benchmark worker produced no result')
  return {
    output: JSON.parse(lastLine) as {
      computeMs: number
      uploadedBytes: number
      maxRssBytes: number
      fullSnapshotWritten: boolean
      parity: boolean
      corpusValid: boolean
      appendedMatches: number
      replayedMatchCount: number
      materializedScopeCount: number
      fullRawRewrite: boolean
      [key: string]: unknown
    },
    sampledPeakRssBytes,
    sampledPeakAtMs,
    sampleCount,
  }
}

async function runBenchmarkVerifierProcess() {
  const child = fork(fileURLToPath(import.meta.url), ['--benchmark-verifier'], {
    cwd: process.cwd(),
    env: { ...process.env, RANKING_BENCHMARK_ROOT: root },
    execArgv: process.execArgv,
    silent: true,
  })
  let sampledPeakRssBytes = 0
  let sampleCount = 0
  const sample = () => {
    if (!child.pid) return
    try {
      const rssBytes = recursiveProcessTreeRssBytes(child.pid)
      if (rssBytes <= 0) return
      sampledPeakRssBytes = Math.max(sampledPeakRssBytes, rssBytes)
      sampleCount += 1
    } catch {
      // The verifier may exit between the timer tick and the procfs read.
    }
  }
  sample()
  const timer = setInterval(sample, 10)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
  const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('close', resolveExit)
  })
  clearInterval(timer)
  if (exitCode !== 0) {
    throw new Error(`Benchmark verifier failed with exit code ${exitCode}: ${Buffer.concat(stderr).toString('utf8')}`)
  }
  const lastLine = Buffer.concat(stdout).toString('utf8').trim().split('\n').filter(Boolean).at(-1)
  if (!lastLine) throw new Error('Benchmark verifier produced no result')
  return {
    output: JSON.parse(lastLine) as {
      parity: boolean
      verifierMs: number
      verifierMaxRssBytes: number
      [key: string]: unknown
    },
    sampledPeakRssBytes,
    sampleCount,
  }
}

type ProductionIncrementalMetrics = {
  fullSnapshotWritten: boolean
  replayedMatchCount: number
  materializedScopeCount: number
  replayFromUtcDate?: string
  selectedBoundary?: string
  changedPaths: string[]
  reusedPaths: string[]
  removedPaths: string[]
  memoryCollections?: {
    afterInputRelease?: { heapUsedBytes: number; heapTotalBytes: number; rssBytes: number }
    afterReplayState?: { heapUsedBytes: number; heapTotalBytes: number; rssBytes: number }
  }
}

function isIncrementalMetrics(value: unknown): value is ProductionIncrementalMetrics {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const metrics = value as Record<string, unknown>
  return typeof metrics.fullSnapshotWritten === 'boolean'
    && typeof metrics.replayedMatchCount === 'number'
    && typeof metrics.materializedScopeCount === 'number'
    && Array.isArray(metrics.changedPaths)
    && metrics.changedPaths.every((path) => typeof path === 'string')
    && Array.isArray(metrics.reusedPaths)
    && metrics.reusedPaths.every((path) => typeof path === 'string')
    && Array.isArray(metrics.removedPaths)
    && metrics.removedPaths.every((path) => typeof path === 'string')
}

async function stageProviderManifest(sourceManifestPath: string, args: string[]) {
  if (!args.includes('scripts/download-local-data.mjs')) {
    throw new Error(`Benchmark refresh invoked an unexpected child command: ${args.join(' ')}`)
  }
  const outDir = requiredArg(args, '--out-dir')
  const outputManifestPath = requiredArg(args, '--manifest')
  const source = JSON.parse(await readFile(sourceManifestPath, 'utf8')) as Record<string, unknown> & {
    files?: Record<string, unknown>
  }
  const files: Record<string, string[]> = {}
  for (const [kind, paths] of Object.entries(source.files ?? {})) {
    if (!Array.isArray(paths)) continue
    const directory = kind === 'oracleCsv' ? 'oracles-elixir' : kind === 'leaguepediaJson' ? 'leaguepedia' : 'lolesports'
    files[kind] = []
    await mkdir(join(outDir, directory), { recursive: true })
    for (const path of paths) {
      if (typeof path !== 'string') continue
      const destination = join(outDir, directory, basename(path))
      await copyFile(path, destination)
      files[kind].push(destination)
    }
  }
  await mkdir(dirname(outputManifestPath), { recursive: true })
  await writeFile(outputManifestPath, `${JSON.stringify({ ...source, files }, null, 2)}\n`)
}

function requiredArg(args: string[], name: string) {
  const index = args.indexOf(name)
  const value = args[index + 1]
  if (index < 0 || !value) throw new Error(`Benchmark refresh is missing ${name}`)
  return value
}

async function seedBaseline(
  client: Awaited<ReturnType<typeof fileBackedS3>>,
  manifestPath: string,
  historyManifestPaths: string[],
) {
  let previousAuthority: ActiveRawSourceAuthority | undefined
  for (const [index, historyManifestPath] of historyManifestPaths.entries()) {
    const history = finalizeRawSourceGeneration(await prepareRawSourceGeneration({
      manifestPath: historyManifestPath,
      importerVersion: 'community-source-import-v1',
      previousAuthority,
    }), `raw_history_${index}`)
    await uploadContentAddressedRawSourceGeneration(client, config, history)
    previousAuthority = {
      receipt: history.receipt,
      objectResolver: async (reference) => {
        const stored = client.objects.get(`${config.prefix}/${reference.key}`)
        return stored ? readFile(stored.filePath) : undefined
      },
    }
  }
  const rawGeneration = await prepareRawSourceGeneration({
    manifestPath,
    importerVersion: 'community-source-import-v1',
    previousAuthority,
  })
  const source = await importRankingSourceData({ manifestPath })
  const baseline = await run('baseline', source, '2026-07-21T00:00:00.000Z', {
    mode: 'gated', cause: 'daily-audit', enabled: true, sourceReceiptDigest: rawGeneration.sourceReceiptDigest,
  })
  if (baseline.action === 'no-change' || !baseline.build) throw new Error('Benchmark baseline did not materialize')
  const generationId = generationIdFor(baseline)
  const finalizedRaw = finalizeRawSourceGeneration(rawGeneration, generationId)
  const state = await persistIncrementalStateBuild({ state: baseline.state, generationId, client, config })
  const lease = await acquireBucketLease('ops/refresh-lease.json', {
    owner: 'benchmark-baseline', now: '2026-07-21T00:00:00.000Z', ttlMs: 10 * 60_000, config, client,
  })
  if (!lease.acquired) throw new Error(`Benchmark baseline lease acquisition failed: ${lease.reason}`)
  await uploadRankingArtifacts({
    publicDataDir: baseline.build.publicDataDir,
    generationId, fencingToken: lease.lease.fencingToken, contentAddressed: true,
    leaseAuthority: { key: 'ops/refresh-lease.json', lease: lease.lease, promotionEtag: lease.promotionEtag },
    now: () => new Date('2026-07-21T00:00:01.000Z'),
    stateManifestAuthority: state.authority, rawSourceGeneration: finalizedRaw, config, client,
  })
  return { generationId, matchCount: source.matches.length, rawDeltaCount: finalizedRaw.receipt.oracle.reduce((sum, entry) => sum + entry.deltas.length, 0) }
}

function run(
  name: string,
  sourceData: RankingSourceImport,
  generatedAt: string,
  options: {
    mode: 'legacy' | 'shadow' | 'gated'
    cause: string
    enabled: boolean
    restored?: RestoredIncrementalAuthority
    sourceReceiptDigest?: string
  },
) {
  return buildRankingIncrementally({
    ...options, sourceData, silent: true, generatedAt,
    manifestPath: join(root, `${name}-unused.json`), output: join(root, `${name}.full.json`), publicDataDir: join(root, `${name}-public`),
  })
}

async function restoreFromStorage(client: Awaited<ReturnType<typeof fileBackedS3>>): Promise<RestoredIncrementalAuthority> {
  const [state, publicGeneration] = await Promise.all([
    readActiveIncrementalState({ config, client, checkpointLimit: 1 }),
    readActiveContentAddressedGeneration({ config, client, verifyArtifacts: false }),
  ])
  if (!state.found || !publicGeneration.found) throw new Error('Benchmark active authority did not restore')
  return {
    stateManifest: state.manifest,
    canonicalLedger: state.canonicalLedger,
    checkpoints: state.checkpoints,
    publicManifest: publicGeneration.manifest,
    rootArtifact: publicGeneration.rootArtifact,
    artifacts: publicGeneration.artifacts,
    loadArtifacts: publicGeneration.loadArtifacts,
    loadCheckpoints: state.loadCheckpoints,
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

function semanticMapFromValues(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).map(([path, value]) => [path, prepareSemanticArtifact(value).digest]))
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
  const players = JSON.parse(await readFile(resolve('public/data/entities/players.json'), 'utf8')) as { players?: unknown[] }
  const coverage = summary.coverage as { matchCount?: number } | undefined
  return {
    matchCount: coverage?.matchCount ?? 4_477,
    teamCount: directory.teams?.length ?? 102,
    playerCount: players.players?.length ?? 356,
  }
}

type BenchmarkTeam = { id: string; name: string; league: string }
type BenchmarkPlayer = { id: string; name: string; team: string; role: BenchmarkPlayerRole }
type BenchmarkPlayerRole = 'Top' | 'Jungle' | 'Mid' | 'Bot' | 'Support'
type BenchmarkMatch = {
  id: string
  date: string
  datetimeUtc?: string
  event: string
  phase?: string
  league: string
  patch?: string
  bestOf?: number
  gameNumber?: number
  seriesId?: string
  teamA: { id: string; name: string }
  teamB: { id: string; name: string }
  winnerId: string
}

async function currentTeams(): Promise<BenchmarkTeam[]> {
  const directory = JSON.parse(await readFile(resolve('public/data/entities/teams.json'), 'utf8')) as {
    teams?: Array<{ id?: string; teamId?: string; name?: string; league?: string }>
  }
  const teams = (directory.teams ?? []).flatMap((team) => {
    const id = team.teamId ?? team.id
    return id && team.name && team.league ? [{ id, name: team.name, league: team.league }] : []
  })
  if (teams.length < 102) throw new Error(`Checked-in team directory is undersized: ${teams.length} < 102`)
  return teams
}

async function currentPlayers(): Promise<BenchmarkPlayer[]> {
  const directory = JSON.parse(await readFile(resolve('public/data/entities/players.json'), 'utf8')) as {
    players?: Array<{ id?: string; playerId?: string; name?: string; team?: string; role?: string }>
  }
  const players = (directory.players ?? []).flatMap((player) => {
    const id = player.playerId ?? player.id
    return id && player.name && player.team && isBenchmarkPlayerRole(player.role)
      ? [{ id, name: player.name, team: player.team, role: player.role }]
      : []
  })
  if (players.length < 356) throw new Error(`Checked-in player directory is undersized: ${players.length} < 356`)
  return players
}

async function currentMatches(): Promise<BenchmarkMatch[]> {
  const catalog = JSON.parse(await readFile(resolve('public/data/matches/all.json'), 'utf8')) as {
    pages?: Array<{ url?: string }>
  }
  const pages = await Promise.all((catalog.pages ?? []).map(async ({ url }) => {
    if (typeof url !== 'string') return []
    const logicalPath = url.replace(/^\/data\//, '').replace(/\?.*$/, '')
    const page = JSON.parse(await readFile(resolve('public/data', logicalPath), 'utf8')) as { matches?: BenchmarkMatch[] }
    return page.matches ?? []
  }))
  return pages.flat().sort((left, right) => (
    left.date.localeCompare(right.date)
    || (left.datetimeUtc ?? '').localeCompare(right.datetimeUtc ?? '')
    || left.id.localeCompare(right.id)
  ))
}

function oracleCsv(matches: BenchmarkMatch[], teams: BenchmarkTeam[], players: BenchmarkPlayer[]) {
  const lines = [
    'gameid,date,year,league,split,playoffs,patch,position,side,teamname,teamid,playername,playerid,result,kills,deaths,assists,totalgold,earnedgold,damageshare,earnedgoldshare,visionscore,vspm,gpr',
  ]
  const roles = ['top', 'jng', 'mid', 'bot', 'sup'] as const
  const pools = rosterPools(players)
  const teamAppearances = new Map<string, number>()
  for (const match of matches) {
    const teamA = match.teamA
    const teamB = match.teamB
    const year = match.date.slice(0, 4)
    const playoffs = /playoff|bracket|knockout|final/i.test(`${match.phase ?? ''} ${match.event}`) ? '1' : '0'
    const shared = [match.id, match.date, year, match.league, match.phase ?? 'Season', playoffs, match.patch ?? 'unknown']
    const sides = [
      { side: 'Blue', team: teamA, won: match.winnerId === teamA.id },
      { side: 'Red', team: teamB, won: match.winnerId === teamB.id },
    ]
    for (const { side, team, won } of sides) {
      const appearance = teamAppearances.get(team.name) ?? 0
      teamAppearances.set(team.name, appearance + 1)
      const kills = won ? 10 : 5
      const totalGold = won ? 60_000 : 55_000
      lines.push([...shared, 'team', side, team.name, team.id, '', '', won ? '1' : '0', String(kills), '', '', String(totalGold), '', '', '', '', '', ''].map(csvCell).join(','))
      for (let roleIndex = 0; roleIndex < roles.length; roleIndex += 1) {
        const role = roles[roleIndex]!
        const roleName = benchmarkPlayerRole(role)
        const teamPool = pools.byTeam.get(team.name)?.get(roleName)
        const globalPool = pools.global.get(roleName)!
        const teamIndex = Math.max(0, teams.findIndex((candidate) => candidate.name === team.name))
        const player = teamPool?.[appearance % teamPool.length]
          ?? globalPool[(teamIndex + roleIndex) % globalPool.length]!
        lines.push([
          ...shared, role, side, team.name, team.id,
          player.name, player.id, won ? '1' : '0', String(roleIndex === 2 ? 3 : 1), won ? '1' : '2',
          String(roleIndex + 2), String(Math.floor(totalGold / 5)), String(Math.floor(totalGold / 5) - 500),
          '0.2', '0.2', String(20 + roleIndex), '1.5', '0.5',
        ].map(csvCell).join(','))
      }
    }
  }
  return `${lines.join('\n')}\n`
}

function appendedMatch(matches: BenchmarkMatch[]): BenchmarkMatch {
  const template = matches.toReversed().find((match) => (
    /regular|season/i.test(match.phase ?? '')
    && ['LCK', 'LPL', 'LEC', 'LCS', 'LTA', 'LTA North', 'LTA South'].includes(match.league)
    && !/MSI|Worlds?|EWC|Esports World Cup|First Stand|international/i.test(match.event)
  ))
  if (!template) throw new Error('Benchmark append requires an observed domestic regular-season matchup outside tournament lifecycle')
  const priorDate = matches.at(-1)!.date
  const date = new Date(`${priorDate}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return {
    id: `benchmark-added-game-${matches.length + 1}`,
    date: date.toISOString().slice(0, 10),
    datetimeUtc: date.toISOString(),
    event: template.event,
    phase: template.phase,
    league: template.league,
    patch: template.patch,
    bestOf: 1,
    gameNumber: 1,
    seriesId: 'benchmark-added-series',
    teamA: { ...template.teamA },
    teamB: { ...template.teamB },
    winnerId: template.winnerId,
  }
}

function rosterPools(players: BenchmarkPlayer[]) {
  const global = new Map<BenchmarkPlayerRole, BenchmarkPlayer[]>()
  const byTeam = new Map<string, Map<BenchmarkPlayerRole, BenchmarkPlayer[]>>()
  for (const player of players) {
    const globalRole = global.get(player.role) ?? []
    globalRole.push(player)
    global.set(player.role, globalRole)
    const team = byTeam.get(player.team) ?? new Map<BenchmarkPlayerRole, BenchmarkPlayer[]>()
    const teamRole = team.get(player.role) ?? []
    teamRole.push(player)
    team.set(player.role, teamRole)
    byTeam.set(player.team, team)
  }
  return { global, byTeam }
}

function benchmarkPlayerRole(role: 'top' | 'jng' | 'mid' | 'bot' | 'sup'): BenchmarkPlayerRole {
  return role === 'top' ? 'Top' : role === 'jng' ? 'Jungle' : role === 'mid' ? 'Mid' : role === 'bot' ? 'Bot' : 'Support'
}

function isBenchmarkPlayerRole(value: string | undefined): value is BenchmarkPlayerRole {
  return value === 'Top' || value === 'Jungle' || value === 'Mid' || value === 'Bot' || value === 'Support'
}

function positiveInteger(value: string | undefined) {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function recursiveProcessTreeRssBytes(rootPid: number) {
  const pending = [rootPid]
  const seen = new Set<number>()
  let total = 0
  while (pending.length > 0) {
    const pid = pending.pop()!
    if (seen.has(pid)) continue
    seen.add(pid)
    try {
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
      if (match) total += Number(match[1]) * 1024
      const children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim()
      if (children) pending.push(...children.split(/\s+/).map(Number).filter(Number.isSafeInteger))
    } catch {
      // A process may exit while its tree is sampled.
    }
  }
  return total
}

function assertGateScale(label: string, actual: number, minimum: number) {
  if (actual < minimum) throw new Error(`Incremental gate refuses undersized ${label}: ${actual} < ${minimum}`)
}

function csvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

async function writeManifest(
  path: string,
  files: string[],
  generatedAt: string,
  leaguepediaPath: string,
  lolEsportsPath: string,
  start: string,
  end: string,
) {
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1, generatedAt, start, end,
    files: { oracleCsv: files, leaguepediaJson: [leaguepediaPath], lolEsportsJson: [lolEsportsPath] },
    sources: {
      oracle: { status: 'downloaded', downloadedCount: files.length, reusedCount: 0, failedCount: 0 },
      leaguepedia: { status: 'downloaded', downloadedCount: 1, reusedCount: 0, failedCount: 0 },
      lolesports: { status: 'downloaded', downloadedCount: 1, reusedCount: 0, failedCount: 0 },
    },
  })}\n`)
}

function leaguepediaFixture(match: BenchmarkMatch) {
  const winnerA = match.winnerId === match.teamA.id
  return {
    source: 'sanitized-production-shaped-local',
    fetchedAt: '2026-07-21T00:00:00.000Z',
    start: match.date,
    end: match.date,
    matches: [{
      id: match.id,
      date: match.date,
      datetimeUtc: match.datetimeUtc ?? `${match.date}T12:00:00.000Z`,
      event: match.event,
      patch: match.patch,
      teamA: match.teamA.name,
      teamB: match.teamB.name,
      bestOf: match.bestOf ?? 3,
      winner: winnerA ? match.teamA.name : match.teamB.name,
      loser: winnerA ? match.teamB.name : match.teamA.name,
      teamAKills: winnerA ? 10 : 5,
      teamBKills: winnerA ? 5 : 10,
      teamAGold: winnerA ? 60_000 : 55_000,
      teamBGold: winnerA ? 55_000 : 60_000,
    }],
  }
}

function lolEsportsFixture(match: BenchmarkMatch) {
  const winnerA = match.winnerId === match.teamA.id
  const eventId = match.seriesId ?? `benchmark-series-${match.id}`
  return {
    source: 'sanitized-production-shaped-local',
    fetchedAt: '2026-07-21T00:00:00.000Z',
    start: match.date,
    end: match.date,
    unsupportedApi: true,
    events: [{
      id: eventId,
      type: 'match',
      state: 'completed',
      startTime: match.datetimeUtc ?? `${match.date}T12:00:00.000Z`,
      blockName: match.phase ?? 'Regular season',
      league: { id: `benchmark-${match.league}`, name: match.league, slug: match.league.toLowerCase() },
      match: {
        id: eventId,
        strategy: { type: 'bestOf', count: match.bestOf ?? 3 },
        teams: [
          { id: match.teamA.id, name: match.teamA.name, code: 'T0', result: { gameWins: winnerA ? 1 : 0, outcome: winnerA ? 'win' : 'loss' } },
          { id: match.teamB.id, name: match.teamB.name, code: 'T1', result: { gameWins: winnerA ? 0 : 1, outcome: winnerA ? 'loss' : 'win' } },
        ],
      },
    }],
    eventDetails: [{
      event: {
        id: eventId,
        league: { id: `benchmark-${match.league}`, name: match.league, slug: match.league.toLowerCase() },
        tournament: { id: `benchmark-${match.event}` },
        match: {
          id: eventId,
          games: [{
            id: match.id,
            number: match.gameNumber ?? 1,
            state: 'completed',
            teams: [{ id: match.teamA.id, side: 'blue' }, { id: match.teamB.id, side: 'red' }],
          }],
        },
      },
    }],
  }
}

type StoredObject = {
  filePath: string
  bytes: number
  etag: string
  contentType?: string
  contentEncoding?: string
  metadata?: Record<string, string>
}
type PutLog = { key: string; bytes: number }

async function fileBackedS3() {
  const indexPath = join(root, 'bucket-index.json')
  let persisted: { version: number; objects: Array<[string, StoredObject]> } = { version: 0, objects: [] }
  try {
    persisted = JSON.parse(await readFile(indexPath, 'utf8')) as typeof persisted
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const objects = new Map<string, StoredObject>(persisted.objects)
  const puts: PutLog[] = []
  const io = { get: 0, head: 0, put: 0 }
  let version = persisted.version
  return {
    objects, puts, io,
    async save() {
      await writeFile(indexPath, JSON.stringify({ version, objects: [...objects.entries()] }))
    },
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
          ...(name === 'GetObjectCommand' ? { Body: Readable.from([await readFile(stored.filePath)]) } : {}),
          ETag: stored.etag, ContentLength: stored.bytes,
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
        const filePath = join(root, `bucket-${createHash('sha256').update(key).digest('hex')}`)
        await writeFile(filePath, bytes)
        objects.set(key, {
          filePath, bytes: bytes.byteLength, etag,
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
