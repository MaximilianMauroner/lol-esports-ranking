import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { constants as fsConstants } from 'node:fs'
import { copyFile, link, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { getHeapStatistics } from 'node:v8'
import {
  acquireBucketLease,
  bucketConfigFromEnv,
  createBucketClient,
  releaseBucketLease,
} from './railway-bucket.mjs'
import { refreshDataIfChanged } from './refresh-data-if-changed.mjs'
import { createNormalizedOracleChunks } from './normalized-provider-chunks.mjs'
import { startLinuxProcessTreeSampler, type IntegratedProcessTreeUsage } from './process-tree-resource.ts'
import {
  calculateAttemptCost,
  decideIncrementalCostGate,
  medianCostLedger,
  modelVolumeLedgerFromBucket,
  projectMonthlyCost,
  railwayRates,
  type AttemptLedger,
  type PhaseUsage,
  type Workflow,
} from './railway-cost-model.ts'
import { parseOraclesElixirCsvRecords } from '../src/lib/importers/oraclesElixir.ts'
import { transparentGprModelMetadata } from '../src/lib/modelConfig.ts'

type ScenarioName = 'no-change' | 'append' | 'old-correction' | 'context-only' | 'static-player-change' | 'cold-restore' | 'successive-append'
type StoredObject = { bytes: Buffer; etag: string; metadata: Record<string, string> }

type ResourceSample = {
  wallMs: number
  cpuMs: number
  userCpuMs: number
  systemCpuMs: number
  peakRssBytes: number
  vcpuSeconds?: number
  rssByteSeconds?: number
  sampleCount?: number
}

type CorpusManifest = {
  schemaVersion: number
  generatedAt: string
  start: string
  end: string
  files: Record<string, string[]>
  sources?: Record<string, unknown>
  warnings?: unknown[]
}

const header = 'gameid,date,year,league,split,playoffs,patch,position,side,teamname,result,kills,totalgold'
const gameOne = [
  'g1,2026-01-10,2026,LCK,Spring,0,26.1,team,Blue,Gen.G,1,18,65000',
  'g1,2026-01-10,2026,LCK,Spring,0,26.1,team,Red,T1,0,12,59000',
]
const gameTwo = [
  'g2,2026-01-17,2026,LCK,Spring,0,26.1,team,Blue,T1,1,19,66000',
  'g2,2026-01-17,2026,LCK,Spring,0,26.1,team,Red,Gen.G,0,10,58000',
]
const gameThree = [
  'g3,2026-01-24,2026,LCK,Spring,0,26.1,team,Blue,Gen.G,1,20,67000',
  'g3,2026-01-24,2026,LCK,Spring,0,26.1,team,Red,T1,0,11,57000',
]
const gameFour = [
  'g4,2026-01-31,2026,LCK,Spring,0,26.1,team,Blue,T1,1,21,68000',
  'g4,2026-01-31,2026,LCK,Spring,0,26.1,team,Red,Gen.G,0,9,56000',
]
const gameFive = [
  'g5,2026-02-07,2026,LCK,Spring,0,26.2,team,Blue,Gen.G,1,22,69000',
  'g5,2026-02-07,2026,LCK,Spring,0,26.2,team,Red,T1,0,8,55000',
]
const gameSix = [
  'g6,2026-02-14,2026,LCK,Spring,0,26.2,team,Blue,T1,1,23,70000',
  'g6,2026-02-14,2026,LCK,Spring,0,26.2,team,Red,Gen.G,0,7,54000',
]

export const productionMonthlyProjectionAssumptions = {
  attemptsPerMonth: 120,
  outcomeProbability: 1,
  publishProbability: 1,
  explicitBackupsUsdPerMonth: 0,
} as const

export async function runDurableBenchmark() {
  const allScenarios: ScenarioName[] = ['no-change', 'append', 'old-correction', 'context-only', 'static-player-change', 'cold-restore']
  const selected = process.env.RANKING_BENCHMARK_SCENARIO
  const scenarios = selected && allScenarios.includes(selected as ScenarioName) ? [selected as ScenarioName] : allScenarios
  const rows = []
  for (const scenario of scenarios) rows.push(await runScenario(scenario))
  return { schemaVersion: 2, scenarios: rows }
}

export async function runSuccessiveAppendColdRestoreScenario() {
  const root = await mkdtemp(join(tmpdir(), 'ranking-successive-append-'))
  const s3 = await startMemoryS3()
  try {
    const baseEnv = bucketEnv(s3.endpoint)
    for (let step = 1; step <= 3; step += 1) {
      await productionRefresh({
        root, s3, scenario: 'successive-append', phase: 'base', mode: 'incremental-shadow', fence: step,
        bootstrapStep: step, metadata: { generatedAt: `2026-07-${String(10 + step).padStart(2, '0')}T00:00:00.000Z`, runId: `successive-shadow-${step}` },
        baseEnv, force: true,
      })
      await removeContainerState(root)
    }
    const rows = []
    let priorCheckpoint = ''
    for (let step = 4; step <= 6; step += 1) {
      const metadata = { generatedAt: `2026-07-${String(10 + step).padStart(2, '0')}T00:00:00.000Z`, runId: `successive-${step}` }
      const incremental = await productionRefresh({
        root, s3, scenario: 'successive-append', phase: 'base', mode: 'incremental', fence: step,
        bootstrapStep: step, metadata, baseEnv, force: true,
      })
      assert.equal(incremental.receipt.executedMode, 'incremental')
      assert.equal(record(incremental.receipt.checkpoint).fallback, undefined)
      assert.equal(record(incremental.receipt.durable).fallback, undefined)
      const checkpoint = String(record(incremental.receipt.checkpoint).selected ?? '')
      assert.ok(checkpoint > priorCheckpoint, `checkpoint did not advance: ${checkpoint} <= ${priorCheckpoint}`)
      priorCheckpoint = checkpoint
      assert.equal(number(record(incremental.receipt.reducers).teamRows), 1)
      assert.equal(number(record(incremental.receipt.reducers).livePlayerEdgeRows), 1)

      const fullDir = join(root, `successive-full-${step}`)
      const fullRaw = await materializeInputs(root, 'successive-append', 'base', `successive-full-input-${step}`, step)
      await normalizeFixtureManifest(fullRaw.dir, fullRaw.manifest)
      await runBuild([
        '--full', '--manifest', fullRaw.manifest, '--output', join(root, `successive-full-${step}.json`),
        '--public-data-dir', fullDir, '--generated-at', metadata.generatedAt, '--run-id', metadata.runId,
        '--static-player-json', fullRaw.rosters,
      ], { ...baseEnv, RANKING_DURABLE_STATE_ENABLED: 'false' })
      assertPublicTreesEqual(await publicTreeFromBucket(s3.objects, incremental.activeGeneration), await publicTreeFromDirectory(fullDir))
      rows.push({ step, checkpoint, rankingRows: number(record(incremental.receipt.snapshotInputs).rankingRows) })
      await removeContainerState(root)
    }
    assert.ok(rows.every((row) => row.rankingRows <= rows[0]!.rankingRows), 'successive append replay grew beyond the newest delta')
    return rows
  } finally {
    await s3.close()
    await rm(root, { recursive: true, force: true })
  }
}

export async function runIdentityBootstrapScenario() {
  const root = await mkdtemp(join(tmpdir(), 'ranking-durable-identity-bootstrap-'))
  const s3 = await startMemoryS3()
  try {
    const baseEnv = bucketEnv(s3.endpoint)
    const identityA = await productionRefresh({
      root, s3, scenario: 'no-change', phase: 'base', mode: 'incremental-shadow', fence: 1,
      metadata: runMetadata('no-change', 'identity-a'), baseEnv, force: true,
      extraEnv: { RANKING_INCREMENTAL_PIPELINE_VERSION: 'identity-a' },
    })
    await removeContainerState(root)
    const identityB1 = await productionRefresh({
      root, s3, scenario: 'no-change', phase: 'base', mode: 'incremental-shadow', fence: 2,
      metadata: runMetadata('no-change', 'identity-b1'), baseEnv, force: true,
      extraEnv: { RANKING_INCREMENTAL_PIPELINE_VERSION: 'identity-b' },
    })
    assert.equal(requiredCandidate(identityB1).eligibility, 'eligible')
    assert.equal(record(identityB1.active.rollout).consecutiveShadowSuccesses, 1)
    assert.notEqual(record(identityA.active.privateState).identityHash, record(identityB1.active.privateState).identityHash)
    await removeContainerState(root)
    const identityB2 = await productionRefresh({
      root, s3, scenario: 'no-change', phase: 'base', mode: 'incremental-shadow', fence: 3,
      metadata: runMetadata('no-change', 'identity-b2'), baseEnv, force: true,
      extraEnv: { RANKING_INCREMENTAL_PIPELINE_VERSION: 'identity-b' },
    })
    assert.ok(number(record(identityB2.receipt.durable).restoredBytes) > 0)
    assert.equal(record(identityB2.active.rollout).consecutiveShadowSuccesses, 2)
    await removeContainerState(root)
    const identityB3 = await productionRefresh({
      root, s3, scenario: 'no-change', phase: 'base', mode: 'incremental-shadow', fence: 4,
      metadata: runMetadata('no-change', 'identity-b3'), baseEnv, force: true,
      extraEnv: { RANKING_INCREMENTAL_PIPELINE_VERSION: 'identity-b' },
    })
    assert.equal(record(identityB3.active.rollout).consecutiveShadowSuccesses, 3)
    await removeContainerState(root)
    const activated = await productionRefresh({
      root, s3, scenario: 'no-change', phase: 'changed', mode: 'incremental', fence: 5,
      metadata: runMetadata('no-change', 'identity-b-active'), baseEnv, force: false,
      extraEnv: { RANKING_INCREMENTAL_PIPELINE_VERSION: 'identity-b' },
    })
    assert.equal(requiredCandidate(activated).eligibility, 'no-change')
    assert.equal(activated.active.generationId, identityB3.active.generationId)
    assert.deepEqual(activated.active.privateState, identityB3.active.privateState)
    assert.equal(activated.publicUploads, 0)
    assert.equal(activated.bucketWrites, 0)
    return {
      identityChanged: record(identityA.active.privateState).identityHash !== record(identityB1.active.privateState).identityHash,
      firstBSuccesses: number(record(identityB1.active.rollout).consecutiveShadowSuccesses),
      restoredBBytes: number(record(identityB2.receipt.durable).restoredBytes),
      activatedPromotion: record(activated.receipt.durable).promotion,
    }
  } finally {
    await s3.close()
    await rm(root, { recursive: true, force: true })
  }
}

export async function runParityMismatchRolloutScenario() {
  const root = await mkdtemp(join(tmpdir(), 'ranking-durable-parity-mismatch-'))
  const s3 = await startMemoryS3()
  const alerts = await startAlertSink()
  try {
    const baseEnv = bucketEnv(s3.endpoint)
    const prior = await productionRefresh({
      root,
      s3,
      scenario: 'no-change',
      phase: 'base',
      mode: 'incremental-shadow',
      fence: 1,
      bootstrapStep: 3,
      metadata: { generatedAt: '2026-07-10T00:00:00.000Z', runId: 'before-mismatch' },
      baseEnv,
      force: true,
    })
    await removeContainerState(root)
    const mismatchMetadata = { generatedAt: '2026-07-11T00:00:00.000Z', runId: 'mismatch-run' }
    const mismatch = await productionRefresh({
      root,
      s3,
      scenario: 'no-change',
      phase: 'base',
      mode: 'incremental-shadow',
      fence: 2,
      bootstrapStep: 3,
      metadata: mismatchMetadata,
      baseEnv,
      force: true,
      extraEnv: {
        RANKING_TEST_FORCE_PARITY_MISMATCH: 'true',
        RANKING_ALERT_WEBHOOK_URL: alerts.endpoint,
      },
    })
    assert.equal(requiredCandidate(mismatch).eligibility, 'ineligible')
    assert.equal(requiredCandidate(mismatch).outcome, 'parity-mismatch')
    assert.equal(record(mismatch.active.rollout).blockedReason, 'parity-mismatch')
    assert.equal(record(mismatch.active.rollout).consecutiveShadowSuccesses, 0)
    assert.deepEqual(mismatch.active.privateState, prior.active.privateState)
    assert.equal(alerts.requests.length, 1)
    assert.equal(record(alerts.requests[0]).kind, 'incremental-parity-mismatch')
    const mismatchAuditAt = record(mismatch.active.rollout).lastAuditAt

    await removeContainerState(root)
    const retry = await productionRefresh({
      root,
      s3,
      scenario: 'no-change',
      phase: 'base',
      mode: 'incremental-shadow',
      fence: 3,
      bootstrapStep: 3,
      metadata: mismatchMetadata,
      baseEnv,
      force: true,
      extraEnv: {
        RANKING_TEST_FORCE_PARITY_MISMATCH: 'true',
        RANKING_ALERT_WEBHOOK_URL: alerts.endpoint,
      },
    })
    assert.equal(retry.active.rolloutUpdateId, 'mismatch-run')
    assert.equal(record(retry.active.rollout).lastAuditAt, mismatchAuditAt)
    assert.deepEqual(retry.active.privateState, prior.active.privateState)

    await removeContainerState(root)
    const next = await productionRefresh({
      root,
      s3,
      scenario: 'no-change',
      phase: 'base',
      mode: 'incremental',
      fence: 4,
      bootstrapStep: 3,
      metadata: { generatedAt: '2026-07-12T00:00:00.000Z', runId: 'after-mismatch' },
      baseEnv,
      force: true,
      forbidLateWork: false,
    })
    assert.equal(next.receipt.executedMode, 'full')
    assert.equal(record(next.active.rollout).blockedReason, 'parity-mismatch')
    assert.deepEqual(next.active.privateState, prior.active.privateState)
    return {
      alertKind: record(alerts.requests[0]).kind,
      mismatchGeneration: mismatch.activeGeneration,
      priorGeneration: prior.activeGeneration,
      privateStatePreserved: JSON.stringify(next.active.privateState) === JSON.stringify(prior.active.privateState),
      retryAuditAtPreserved: record(retry.active.rollout).lastAuditAt === mismatchAuditAt,
      nextExecutedMode: next.receipt.executedMode,
    }
  } finally {
    await alerts.close()
    await s3.close()
    await rm(root, { recursive: true, force: true })
  }
}

export async function runProductionPerformanceBenchmark({
  samples = 5,
  assertPerformance = false,
  corpusMode = 'representative',
}: {
  samples?: number
  assertPerformance?: boolean
  corpusMode?: 'representative' | 'full'
} = {}) {
  assert.ok(Number.isInteger(samples) && samples > 0 && samples <= 25, '--samples must be an integer from 1 through 25')
  const root = await mkdtemp(join(tmpdir(), 'ranking-incremental-performance-'))
  const s3 = await startFilesystemS3(join(root, 'filesystem-s3'))
  try {
    const corpus = corpusMode === 'full'
      ? await materializeProductionCorpus(root)
      : await materializeRepresentativeCorpus(root)
    const baseEnv = bucketEnv(s3.endpoint)
    for (let run = 1; run <= 3; run += 1) {
      const bootstrap = await productionCorpusRefresh({
        root: join(root, `bootstrap-${run}`), s3, corpusDir: corpus.bootstrapDirs[run - 1] ?? corpus.baseDir,
        mode: 'incremental-shadow', fence: run,
        metadata: { generatedAt: `2026-07-${String(17 + run).padStart(2, '0')}T00:00:00.000Z`, runId: `performance-shadow-${run}` },
        baseEnv,
      })
      const bootstrapCandidate = requiredCandidate(bootstrap)
      assert.equal(bootstrapCandidate.eligibility, 'eligible', JSON.stringify(bootstrapCandidate))
      assert.equal(number(record(bootstrap.active.rollout).consecutiveShadowSuccesses), run)
    }

    const activatedObjects = await s3.snapshot()
    const measured: Array<{ pair: number; order: string[]; incremental: ReturnType<typeof performanceRow>; full: ReturnType<typeof performanceRow> }> = []
    let deterministicIncrementalTree: Record<string, string> | undefined
    for (let pair = -1; pair < samples; pair += 1) {
      const order = pair % 2 === 0 ? ['incremental', 'full'] as const : ['full', 'incremental'] as const
      const pairResults: Partial<Record<(typeof order)[number], Awaited<ReturnType<typeof productionCorpusRefresh>>>> = {}
      for (const mode of order) {
        await s3.restore(activatedObjects)
        const runRoot = join(root, `${pair < 0 ? 'warmup' : `pair-${pair + 1}`}-${mode}`)
        pairResults[mode] = await productionCorpusRefresh({
          root: runRoot,
          s3,
          corpusDir: corpus.changedDir,
          mode,
          fence: 4,
          metadata: { generatedAt: '2026-07-21T12:00:00.000Z', runId: 'performance-changed' },
          baseEnv,
        })
      }
      const incremental = pairResults.incremental
      const full = pairResults.full
      assert.ok(incremental && full)
      assertPublicTreesEqual(incremental.publicTree, full.publicTree)
      assert.equal(incremental.receipt.executedMode, 'incremental')
      assert.equal(record(incremental.receipt.durable).fallback, undefined)
      assert.equal(record(incremental.receipt.checkpoint).fallback, undefined)
      assert.equal(typeof record(incremental.receipt.checkpoint).selected, 'string')
      if (deterministicIncrementalTree) assertPublicTreesEqual(incremental.publicTree, deterministicIncrementalTree)
      else deterministicIncrementalTree = incremental.publicTree
      if (pair >= 0) measured.push({
        pair: pair + 1,
        order: [...order],
        incremental: performanceRow(incremental),
        full: performanceRow(full),
      })
    }

    const summary = performanceSummary(measured)
    const cost = railwayCostReport(measured, corpusMode)
    const gates = {
      wallRatioAtMost: 0.8,
      cpuRatioAtMost: 0.8,
      sourceRatioAtMost: 0.25,
      parsedRatioAtMost: 0.25,
      replayRatioAtMost: 0.25,
      bucketObjectsLower: summary.incremental.bucketObjects < summary.full.bucketObjects,
      bucketBytesLower: summary.incremental.bucketBytes < summary.full.bucketBytes,
      rssRatioAtMost: 1.1,
      rssGate: 'strict-subprocess-peak' as const,
    }
    if (assertPerformance) assert.notEqual(cost.gate.decision, 'insufficient-evidence', 'Production cost decisions require Node 22, full corpus, and at least five measured pairs')
    return {
      schemaVersion: 1,
      environment: {
        node: process.version,
        expectedNode: '>=22 <23',
        runtimeAccepted: /^v22\./.test(process.version),
        nodeOptions: process.env.NODE_OPTIONS ?? null,
        heapLimitBytes: getHeapStatistics().heap_size_limit,
        platform: `${process.platform}-${process.arch}`,
        samples,
        warmups: 1,
        resourceMeasurement: 'Linux /proc process-tree sampling every 20ms; CPU is cumulative process ticks and RAM is trapezoidal integrated RSS; peak RSS, wall time, object counts, and bucket downloads are diagnostics only',
      },
      corpus: corpus.identity,
      model: {
        version: transparentGprModelMetadata.version,
        configHash: transparentGprModelMetadata.configHash,
      },
      assertions: {
        exactPublicArtifactParityPerPair: true,
        deterministicIncrementalRepeat: true,
        activatedIncrementalNoFallback: true,
        ...gates,
      },
      samples: measured,
      summary,
      cost,
    }
  } finally {
    await s3.close()
    await rm(root, { recursive: true, force: true })
  }
}

export async function runDurableFixturePerformanceBenchmark({ samples = 5, assertPerformance = false }: { samples?: number; assertPerformance?: boolean } = {}) {
  assert.ok(Number.isInteger(samples) && samples > 0 && samples <= 25, '--samples must be an integer from 1 through 25')
  const root = await mkdtemp(join(tmpdir(), 'ranking-incremental-fixture-performance-'))
  const s3 = await startMemoryS3()
  try {
    const baseEnv = bucketEnv(s3.endpoint)
    for (let run = 1; run <= 3; run += 1) {
      await productionRefresh({
        root, s3, scenario: 'append', phase: 'base', mode: 'incremental-shadow', fence: run,
        bootstrapStep: run, metadata: runMetadata('append', `shadow-${run}`), baseEnv, force: true,
      })
      await removeContainerState(root)
    }
    const activated = cloneStoredObjects(s3.objects)
    const measured: Array<{ pair: number; order: string[]; incremental: ReturnType<typeof fixturePerformanceRow>; full: ReturnType<typeof fixturePerformanceRow> }> = []
    let deterministicTree: Record<string, string> | undefined
    for (let pair = -1; pair < samples; pair += 1) {
      const order = pair % 2 === 0 ? ['incremental', 'full'] as const : ['full', 'incremental'] as const
      const results: Partial<Record<(typeof order)[number], Awaited<ReturnType<typeof timedProductionRefresh>>>> = {}
      for (const mode of order) {
        restoreStoredObjects(s3, activated)
        await removeContainerState(root)
        results[mode] = await timedProductionRefresh({
          root, s3, scenario: 'append', phase: 'changed', mode, fence: 4,
          bootstrapStep: 3, metadata: { generatedAt: '2026-07-14T00:00:00.000Z', runId: 'append-performance' }, baseEnv, force: true,
        })
      }
      const incremental = results.incremental
      const full = results.full
      assert.ok(incremental && full)
      assertPublicTreesEqual(incremental.publicTree, full.publicTree)
      assert.equal(incremental.receipt.executedMode, 'incremental')
      assert.equal(record(incremental.receipt.durable).fallback, undefined)
      assert.equal(typeof record(incremental.receipt.checkpoint).selected, 'string')
      if (deterministicTree) assertPublicTreesEqual(incremental.publicTree, deterministicTree)
      else deterministicTree = incremental.publicTree
      if (pair >= 0) measured.push({ pair: pair + 1, order: [...order], incremental: fixturePerformanceRow(incremental), full: fixturePerformanceRow(full) })
    }
    const summary = performanceSummary(measured)
    const gates = {
      wallRatioAtMost: 0.8,
      cpuRatioAtMost: 0.8,
      sourceRatioAtMost: 0.25,
      parsedRatioAtMost: 0.25,
      replayRatioAtMost: 0.25,
      bucketObjectsLower: summary.incremental.bucketObjects < summary.full.bucketObjects,
      bucketBytesLower: summary.incremental.bucketBytes < summary.full.bucketBytes,
      rssRatioAtMost: 1.1,
    }
    if (assertPerformance) {
      assert.ok(summary.ratios.wall <= gates.wallRatioAtMost, `incremental median wall ratio ${summary.ratios.wall} exceeded ${gates.wallRatioAtMost}`)
      assert.ok(summary.ratios.cpu <= gates.cpuRatioAtMost, `incremental median CPU ratio ${summary.ratios.cpu} exceeded ${gates.cpuRatioAtMost}`)
      assert.ok(summary.ratios.sourceBytes !== null && summary.ratios.sourceBytes <= gates.sourceRatioAtMost, `incremental source byte ratio ${summary.ratios.sourceBytes ?? 'unavailable'} exceeded ${gates.sourceRatioAtMost}`)
      assert.ok(summary.ratios.parsed !== null && summary.ratios.parsed <= gates.parsedRatioAtMost, `incremental parsed ratio ${summary.ratios.parsed ?? 'unavailable'} exceeded ${gates.parsedRatioAtMost}`)
      assert.ok(summary.ratios.replayed !== null && summary.ratios.replayed <= gates.replayRatioAtMost, `incremental replay ratio ${summary.ratios.replayed ?? 'unavailable'} exceeded ${gates.replayRatioAtMost}`)
      assert.ok(gates.bucketObjectsLower && gates.bucketBytesLower, 'incremental bucket writes were not lower than full')
      assert.ok(summary.ratios.peakRss <= gates.rssRatioAtMost, `incremental peak RSS ratio ${summary.ratios.peakRss} exceeded ${gates.rssRatioAtMost}`)
    }
    return {
      schemaVersion: 1,
      environment: { node: process.version, platform: `${process.platform}-${process.arch}`, samples, warmups: 1, resourceMeasurement: 'GNU time for snapshot subprocess plus parent CPU and end-to-end wall' },
      corpus: { mode: 'activated-durable-fixture', baseGames: 3, appendedGames: 1 },
      model: { version: transparentGprModelMetadata.version, configHash: transparentGprModelMetadata.configHash },
      assertions: { exactPublicArtifactParityPerPair: true, deterministicIncrementalRepeat: true, activatedIncrementalNoFallback: true, ...gates },
      samples: measured,
      summary,
    }
  } finally {
    await s3.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function timedProductionRefresh(options: Parameters<typeof productionRefresh>[0]) {
  const subprocess: ResourceSample[] = []
  const cpuBefore = process.cpuUsage()
  const started = performance.now()
  const beforePuts = options.s3.putKeys.length
  const beforeBytes = options.s3.putBytes.length
  const result = await productionRefresh({ ...options, resources: subprocess })
  const cpu = process.cpuUsage(cpuBefore)
  const child = subprocess.reduce((total, sample) => ({
    userCpuMs: total.userCpuMs + sample.userCpuMs,
    systemCpuMs: total.systemCpuMs + sample.systemCpuMs,
    peakRssBytes: Math.max(total.peakRssBytes, sample.peakRssBytes),
  }), { userCpuMs: 0, systemCpuMs: 0, peakRssBytes: 0 })
  const receipt = result.receipt
  return {
    ...result,
    receipt,
    originMaterialization: { files: 0, bytes: 0, oracleRows: 0 },
    publicTree: await publicTreeFromBucket(options.s3.objects, result.activeGeneration),
    bucketBytes: options.s3.putBytes.slice(beforeBytes).reduce((sum, value) => sum + value, 0),
    bucketBreakdown: bucketWriteBreakdown(
      options.s3.putKeys.slice(beforePuts),
      options.s3.putBytes.slice(beforeBytes),
    ),
    bucketReads: 0,
    bucketReadBytes: 0,
    bucketReadBreakdown: {},
    retainedBytes: retainedBreakdownFromStoredObjects(options.s3.objects),
    resource: {
      wallMs: performance.now() - started,
      userCpuMs: child.userCpuMs + cpu.user / 1_000,
      systemCpuMs: child.systemCpuMs + cpu.system / 1_000,
      cpuMs: child.userCpuMs + child.systemCpuMs + (cpu.user + cpu.system) / 1_000,
      peakRssBytes: child.peakRssBytes,
    },
  }
}

function retainedBreakdownFromStoredObjects(objects: Map<string, StoredObject>) {
  let bucketPrivate = 0
  let bucketAuthoritative = 0
  for (const [key, object] of objects) {
    if (classifyRetainedObjectKey(key) === 'bucketPrivate') bucketPrivate += object.bytes.byteLength
    else bucketAuthoritative += object.bytes.byteLength
  }
  return { bucketAuthoritative, bucketPrivate, volumePrivate: 0 }
}

function fixturePerformanceRow(result: Awaited<ReturnType<typeof timedProductionRefresh>>) {
  const row = performanceRow({
    ...result,
    bucketObjects: result.bucketWrites,
  })
  return row
}

function performanceRow(result: Awaited<ReturnType<typeof productionCorpusRefresh>>) {
  const receipt = result.receipt
  const observations = record(receipt.observations)
  const durable = record(receipt.durable)
  const artifacts = record(receipt.artifacts)
  const sources = record(receipt.sources)
  const bucket = record(receipt.bucket)
  const builderSourceBytes = nullableNumber(sources.bytesScanned) ?? 0
  const builderParsedRows = nullableNumber(observations.parsed) ?? 0
  const origin = result.originMaterialization
  return {
    resource: result.resource,
    executedMode: receipt.executedMode,
    selectedCheckpoint: record(receipt.checkpoint).selected,
    timingsMs: receipt.timingsMs,
    attempts: receipt.attempts,
    sources: {
      files: nullableNumber(sources.filesScanned),
      bytes: nullableNumber(sources.bytesScanned),
    },
    observations: {
      parsed: nullableNumber(observations.parsed),
      normalized: nullableNumber(observations.normalized),
      reused: nullableNumber(observations.reused),
    },
    workflowInput: {
      originDownloadFiles: origin.files,
      originDownloadBytes: origin.bytes,
      fullSourceNormalizationBytes: origin.bytes,
      fullSourceNormalizationRows: origin.oracleRows,
      builderSourceBytes,
      builderParsedRows,
      sourceBytes: origin.bytes * 2 + builderSourceBytes,
      parsedRows: origin.oracleRows + builderParsedRows,
      originDownloadUnchanged: true,
    },
    replayedRows: nullableNumber(durable.replayedUnits),
    snapshotInputs: receipt.snapshotInputs,
    reducers: receipt.reducers,
    privateState: {
      restoredObjects: nullableNumber(durable.restoredObjects),
      restoredBytes: nullableNumber(durable.restoredBytes),
      uploadedObjects: nullableNumber(durable.uploadedObjects),
      uploadedBytes: nullableNumber(durable.uploadedBytes),
      skippedObjects: nullableNumber(durable.skippedObjects),
      skippedBytes: nullableNumber(durable.skippedBytes),
      localBytesRead: nullableNumber(bucket.bytesRead),
      localBytesWritten: nullableNumber(bucket.bytesWritten),
    },
    artifactWrites: nullableNumber(artifacts.regenerated),
    bucketObjects: result.bucketObjects,
    bucketBytes: result.bucketBytes,
    bucketBreakdown: result.bucketBreakdown,
    bucketReads: result.bucketReads,
    bucketReadBytes: result.bucketReadBytes,
    bucketReadBreakdown: result.bucketReadBreakdown,
    retainedBytes: result.retainedBytes,
  }
}

function railwayCostReport(
  rows: Array<{ incremental: ReturnType<typeof performanceRow>; full: ReturnType<typeof performanceRow> }>,
  corpusMode: 'representative' | 'full',
) {
  const fullLedger = medianCostLedger(rows.map((row) => benchmarkLedger('full', row.full)))
  const incrementalBucketLedger = medianCostLedger(rows.map((row) => benchmarkLedger('incremental-bucket', row.incremental)))
  const incrementalVolumeLedger = modelVolumeLedgerFromBucket(incrementalBucketLedger)
  const assumptions = productionMonthlyProjectionAssumptions
  const full = projectMonthlyCost(calculateAttemptCost(fullLedger), assumptions)
  const incrementalBucket = projectMonthlyCost(calculateAttemptCost(incrementalBucketLedger), assumptions)
  const incrementalVolume = projectMonthlyCost(calculateAttemptCost(incrementalVolumeLedger), assumptions)
  return {
    schemaVersion: 1,
    rates: railwayRates,
    assumptions: {
      ...assumptions,
      outcome: 'changed' as const,
      note: 'Changed-generation benchmark projection at the production 0 */6 * * * cadence (four attempts/day over Railway\'s 30-day billing month). No missing publish is inferred to be no-change.',
    },
    provenance: {
      resource: 'measured Linux /proc process tree',
      uploads: 'measured fake-S3 PUT keys and payload bytes',
      retainedStorage: 'measured fake-S3 retained object keys and sizes after each attempt',
      incrementalVolume: 'modeled; no actual Railway volume run exists',
    },
    workflows: {
      full: { ledger: fullLedger, projection: full },
      incrementalBucket: { ledger: incrementalBucketLedger, projection: incrementalBucket },
      incrementalVolume: { ledger: incrementalVolumeLedger, projection: incrementalVolume },
    },
    gate: decideIncrementalCostGate({
      full,
      incremental: incrementalBucket,
      measuredPairs: rows.length,
      nodeMajor: Number(process.versions.node.split('.')[0]),
      fullProductionCorpus: corpusMode === 'full',
    }),
    modeledVolumeComparison: {
      productionDecisionEligible: false,
      reason: 'Modeled volume requires an actual Node 22 full-corpus volume run before it can decide release behavior.',
      changedRunSavingsVsFullUsd: full.variableUsd - incrementalVolume.variableUsd,
      projectedMonthlySavingsVsFullUsd: full.monthlyTotalUsd - incrementalVolume.monthlyTotalUsd,
    },
  }
}

function benchmarkLedger(workflow: Exclude<Workflow, 'incremental-volume'>, row: ReturnType<typeof performanceRow>): AttemptLedger {
  const resource = row.resource as IntegratedProcessTreeUsage & { wallMs: number; cpuMs: number; userCpuMs: number; systemCpuMs: number }
  const phase: PhaseUsage = {
    durationSeconds: resource.durationSeconds,
    vcpuSeconds: resource.vcpuSeconds,
    rssByteSeconds: resource.rssByteSeconds,
    peakRssBytes: resource.peakRssBytes,
    serviceUploadBytes: uploadCategories(row.bucketBreakdown),
    bucketDownloadBytes: row.bucketReadBytes,
  }
  return {
    workflow,
    evidence: 'measured',
    outcome: 'changed',
    phases: { startupTail: phase },
    retainedBytes: workflow === 'full'
      ? { ...row.retainedBytes, bucketPrivate: 0 }
      : row.retainedBytes,
    provenance: 'paired production benchmark; end-to-end attempt is represented as startupTail because finer phase hooks are not yet emitted by the refresh pipeline',
  }
}

function uploadCategories(breakdown: Record<string, { objects: number; bytes: number }>) {
  return {
    privateCache: breakdown['private-content']?.bytes ?? 0,
    publicPayload: breakdown['public-content']?.bytes ?? 0,
    rawAuthority: breakdown['raw-content']?.bytes ?? 0,
    metadata: breakdown['metadata-pointers']?.bytes ?? 0,
  }
}

export function classifyBucketObjectKey(key: string) {
  if (/(?:^|\/)(?:durable|private)(?:\/|$)/.test(key)) return 'private-content' as const
  if (/(?:^|\/)raw(?:\/|$)/.test(key)) return 'raw-content' as const
  if (/(?:^|\/)public\/objects(?:\/|$)/.test(key)
    || /(?:^|\/)generations\/[^/]+\/(?:data\/|public-manifest\.json$)/.test(key)) return 'public-content' as const
  return 'metadata-pointers' as const
}

export function classifyRetainedObjectKey(key: string) {
  return classifyBucketObjectKey(key) === 'private-content' ? 'bucketPrivate' as const : 'bucketAuthoritative' as const
}

function bucketWriteBreakdown(keys: string[], bytes: number[]) {
  assert.equal(keys.length, bytes.length, 'bucket key/byte instrumentation diverged')
  const totals: Record<string, { objects: number; bytes: number }> = {}
  for (const [index, key] of keys.entries()) {
    const category = classifyBucketObjectKey(key)
    const total = totals[category] ?? { objects: 0, bytes: 0 }
    total.objects += 1
    total.bytes += bytes[index] ?? 0
    totals[category] = total
  }
  return totals
}

function performanceSummary(rows: Array<{ incremental: ReturnType<typeof performanceRow>; full: ReturnType<typeof performanceRow> }>) {
  const aggregate = (mode: 'incremental' | 'full') => ({
    wallMs: median(rows.map((row) => row[mode].resource.wallMs)),
    cpuMs: median(rows.map((row) => row[mode].resource.cpuMs)),
    userCpuMs: median(rows.map((row) => row[mode].resource.userCpuMs)),
    systemCpuMs: median(rows.map((row) => row[mode].resource.systemCpuMs)),
    peakRssBytes: median(rows.map((row) => row[mode].resource.peakRssBytes)),
    sourceBytes: median(rows.map((row) => row[mode].workflowInput.sourceBytes)),
    parsed: median(rows.map((row) => row[mode].workflowInput.parsedRows)),
    builderSourceBytes: medianDefined(rows.map((row) => row[mode].sources.bytes)),
    builderParsed: medianDefined(rows.map((row) => row[mode].observations.parsed)),
    normalizationBytes: median(rows.map((row) => row[mode].workflowInput.fullSourceNormalizationBytes)),
    normalizationRows: median(rows.map((row) => row[mode].workflowInput.fullSourceNormalizationRows)),
    normalized: medianDefined(rows.map((row) => row[mode].observations.normalized)),
    reused: medianDefined(rows.map((row) => row[mode].observations.reused)),
    replayed: medianDefined(rows.map((row) => row[mode].replayedRows)),
    artifactWrites: medianDefined(rows.map((row) => row[mode].artifactWrites)),
    bucketObjects: median(rows.map((row) => row[mode].bucketObjects)),
    bucketBytes: median(rows.map((row) => row[mode].bucketBytes)),
    bucketReads: median(rows.map((row) => row[mode].bucketReads)),
    bucketReadBytes: median(rows.map((row) => row[mode].bucketReadBytes)),
  })
  const incremental = aggregate('incremental')
  const full = aggregate('full')
  return {
    incremental,
    full,
    ratios: {
      wall: ratio(incremental.wallMs, full.wallMs),
      cpu: ratio(incremental.cpuMs, full.cpuMs),
      peakRss: ratio(incremental.peakRssBytes, full.peakRssBytes),
      sourceBytes: ratioDefined(incremental.sourceBytes, full.sourceBytes),
      parsed: ratioDefined(incremental.parsed, full.parsed),
      builderSourceBytes: ratioDefined(incremental.builderSourceBytes, full.builderSourceBytes),
      builderParsed: ratioDefined(incremental.builderParsed, full.builderParsed),
      normalized: ratioDefined(incremental.normalized, full.normalized),
      replayed: ratioDefined(incremental.replayed, full.replayed),
      artifactWrites: ratioDefined(incremental.artifactWrites, full.artifactWrites),
      bucketObjects: ratio(incremental.bucketObjects, full.bucketObjects),
      bucketBytes: ratio(incremental.bucketBytes, full.bucketBytes),
      bucketReads: ratio(incremental.bucketReads, full.bucketReads),
      bucketReadBytes: ratio(incremental.bucketReadBytes, full.bucketReadBytes),
    },
  }
}

async function productionCorpusRefresh(options: {
  root: string
  s3: Awaited<ReturnType<typeof startFilesystemS3>>
  corpusDir: string
  mode: 'incremental-shadow' | 'incremental' | 'full'
  fence: number
  metadata: { generatedAt: string; runId: string }
  baseEnv: NodeJS.ProcessEnv
}) {
  const rawDir = join(options.root, 'raw')
  const publicDir = join(options.root, 'public')
  const statePath = join(rawDir, 'refresh-state.json')
  const privateDir = join(options.root, 'private')
  const bucketConfig = bucketConfigFromEnv(options.baseEnv)
  const bucketClient = createBucketClient(bucketConfig)
  assert.ok(bucketClient)
  const processTreeSampler = await startLinuxProcessTreeSampler(process.pid, 20)
  let samplerStopped = false
  const leaseKey = 'ops/refresh-lease.json'
  const lease = await acquireBucketLease(leaseKey, {
    owner: `performance:${options.mode}:${options.fence}`,
    ttlMs: 45 * 60_000,
    fenceActiveKey: 'active-generation.json',
    config: bucketConfig,
    client: bucketClient,
  })
  if (!lease.acquired) throw new Error(`Performance refresh lease was not acquired: ${lease.reason}`)
  const beforePuts = options.s3.putKeys.length
  const beforePutBytes = options.s3.putBytes.length
  const beforeGets = options.s3.getKeys.length
  const beforeGetBytes = options.s3.getBytes.length
  const wallStarted = performance.now()
  let leaseReleased = false
  const env: NodeJS.ProcessEnv = {
    ...options.baseEnv,
    RANKING_CRUNCH_MODE: options.mode,
    RANKING_INCREMENTAL_STATE_DIR: privateDir,
    RANKING_REFRESH_FENCING_TOKEN: String(lease.lease.fencingToken),
    RANKING_REFRESH_LEASE_KEY: leaseKey,
    RANKING_REFRESH_LEASE_OWNER: lease.lease.owner,
    RANKING_REFRESH_LEASE_ETAG: lease.etag,
    RANKING_REFRESH_LEASE_AUTHORITY_KEY: lease.authorityKey,
    RANKING_REFRESH_LEASE_EXPIRES_AT: lease.lease.expiresAt,
    RANKING_BUCKET_RESTORE_RAW: 'true',
  }
  let originMaterialization = { files: 0, bytes: 0, oracleRows: 0 }
  try {
    const refreshResult = await refreshDataIfChanged([
      '--raw-dir', rawDir,
      '--manifest', join(rawDir, 'manifest.json'),
      '--state', statePath,
      '--output', join(options.root, 'snapshot.json'),
      '--public-data-dir', publicDir,
      '--staging-dir', join(options.root, 'staging'),
      '--end', '2026-07-21',
      '--force',
    ], {
      env,
      bucketConfig,
      bucketClient,
      run: async (command: string, args: string[]) => {
        if (args.includes('scripts/download-local-data.mjs')) {
          originMaterialization = await copyProductionCorpus(options.corpusDir, valueAfter(args, '--out-dir'))
          return
        }
        assert.equal(command, 'pnpm')
        const buildArgs = [...args.slice(args.indexOf('scripts/build-static-snapshot.ts') + 1),
          '--generated-at', options.metadata.generatedAt,
          '--run-id', options.metadata.runId,
        ]
        if (options.mode === 'incremental-shadow') {
          const referenceRoot = join(options.root, 'external-shadow-reference')
          const referenceSnapshot = join(referenceRoot, 'snapshot.json')
          const referencePublicDir = join(referenceRoot, 'public')
          await runBuild([
            ...replaceBuildArg(replaceBuildArg(buildArgs, '--output', referenceSnapshot), '--public-data-dir', referencePublicDir),
            '--full',
          ], { ...env, RANKING_DURABLE_STATE_ENABLED: 'false' })
          await runBuild(buildArgs, {
            ...env,
            RANKING_EXTERNAL_SHADOW_REFERENCE_SNAPSHOT: referenceSnapshot,
            RANKING_EXTERNAL_SHADOW_REFERENCE_PUBLIC_DIR: referencePublicDir,
          })
          return
        }
        await runBuild(buildArgs, env)
      },
    })
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    const receipt = record(record(state.crunch).receipt)
    const active = JSON.parse((await options.s3.readObject('bucket/rankings/active-generation.json')).toString('utf8'))
    const generationId = String(active.generationId)
    const bucketKeys = options.s3.putKeys.slice(beforePuts)
    const bucketSizes = options.s3.putBytes.slice(beforePutBytes)
    const bucketReadKeys = options.s3.getKeys.slice(beforeGets)
    const bucketReadSizes = options.s3.getBytes.slice(beforeGetBytes)
    const retainedBytes = options.s3.retainedBreakdown()
    const released = await releaseBucketLease(leaseKey, lease, { config: bucketConfig, client: bucketClient })
    assert.equal(released.released, true)
    leaseReleased = true
    const integrated = await processTreeSampler.stop()
    samplerStopped = true
    return {
      active,
      candidate: refreshResult.durableCandidate,
      receipt,
      originMaterialization,
      publicTree: await options.s3.publicTree(generationId),
      bucketObjects: bucketKeys.length,
      bucketBytes: bucketSizes.reduce((sum, bytes) => sum + bytes, 0),
      bucketBreakdown: bucketWriteBreakdown(bucketKeys, bucketSizes),
      bucketReads: bucketReadKeys.length,
      bucketReadBytes: bucketReadSizes.reduce((sum, bytes) => sum + bytes, 0),
      bucketReadBreakdown: bucketWriteBreakdown(bucketReadKeys, bucketReadSizes),
      resource: {
        ...integrated,
        wallMs: performance.now() - wallStarted,
        cpuMs: integrated.vcpuSeconds * 1_000,
        userCpuMs: integrated.vcpuSeconds * 1_000,
        systemCpuMs: 0,
      },
      retainedBytes,
    }
  } finally {
    if (!leaseReleased) {
      const released = await releaseBucketLease(leaseKey, lease, { config: bucketConfig, client: bucketClient })
      assert.equal(released.released, true)
    }
    if (!samplerStopped) await processTreeSampler.stop()
  }
}

function replaceBuildArg(args: string[], flag: string, value: string) {
  const next = [...args]
  const index = next.indexOf(flag)
  if (index < 0 || index + 1 >= next.length) throw new Error(`Missing builder argument ${flag}`)
  next[index + 1] = value
  return next
}

async function materializeProductionCorpus(root: string) {
  const sourceManifestPath = resolve('data/raw/manifest.json')
  const sourceManifest = JSON.parse(await readFile(sourceManifestPath, 'utf8')) as CorpusManifest
  const baseDir = join(root, 'corpus-base')
  const changedDir = join(root, 'corpus-changed')
  await copyManifestCorpus(sourceManifest, baseDir)
  const changedManifest = await copyManifestCorpus(sourceManifest, changedDir)
  const changedOracle = Object.values(changedManifest.files).flat()
    .find((path) => /2026[^/\\]*\.csv$/i.test(path))
  if (!changedOracle) throw new Error('Production manifest did not contain a 2026 Oracle CSV')
  const appended = await appendLateLckSeries(changedOracle)
  changedManifest.generatedAt = '2026-07-21T11:00:00.000Z'
  changedManifest.end = '2026-07-21'
  await writeFile(join(changedDir, 'manifest.json'), `${JSON.stringify(changedManifest, null, 2)}\n`)
  return {
    baseDir,
    changedDir,
    bootstrapDirs: [baseDir, baseDir, baseDir],
    identity: {
      manifest: relative(process.cwd(), sourceManifestPath),
      start: sourceManifest.start,
      baseEnd: sourceManifest.end,
      changedEnd: changedManifest.end,
      sourceFiles: Object.values(sourceManifest.files).flat().length,
      appendedSeries: appended,
    },
  }
}

async function materializeRepresentativeCorpus(root: string) {
  const sourceManifestPath = resolve('data/raw/manifest.json')
  const sourceManifest = JSON.parse(await readFile(sourceManifestPath, 'utf8')) as CorpusManifest
  const oracle2026 = Object.values(sourceManifest.files).flat()
    .find((path) => /(?:^|[/\\])2026[^/\\]*\.csv$/i.test(path))
  const leaguepedia = sourceManifest.files.leaguepediaJson?.toSorted().at(-1)
  if (!oracle2026) throw new Error('Production manifest did not contain a 2026 Oracle CSV')
  if (!leaguepedia) throw new Error('Production manifest did not contain a Leaguepedia snapshot')
  const representative: CorpusManifest = {
    schemaVersion: sourceManifest.schemaVersion,
    generatedAt: sourceManifest.generatedAt,
    start: '2026-01-01',
    end: sourceManifest.end,
    files: { oracleCsv: [oracle2026], leaguepediaJson: [leaguepedia], lolEsportsJson: [] },
    sources: {
      oracle: { status: 'downloaded', downloadedCount: 1, failedCount: 0 },
      leaguepedia: { status: 'downloaded', downloadedCount: 1, failedCount: 0 },
      lolesports: { status: 'disabled', downloadedCount: 0, failedCount: 0 },
    },
    warnings: [],
  }
  const baseDir = join(root, 'corpus-base')
  const changedDir = join(root, 'corpus-changed')
  const bootstrapOneDir = join(root, 'corpus-bootstrap-1')
  const bootstrapTwoDir = join(root, 'corpus-bootstrap-2')
  await copyManifestCorpus(representative, bootstrapOneDir)
  await copyManifestCorpus(representative, bootstrapTwoDir)
  await copyManifestCorpus(representative, baseDir)
  const changedManifest = await copyManifestCorpus(representative, changedDir)
  const bootstrapOneOracle = (JSON.parse(await readFile(join(bootstrapOneDir, 'manifest.json'), 'utf8')) as CorpusManifest).files.oracleCsv?.[0]
  const bootstrapTwoOracle = (JSON.parse(await readFile(join(bootstrapTwoDir, 'manifest.json'), 'utf8')) as CorpusManifest).files.oracleCsv?.[0]
  const baseOracle = (JSON.parse(await readFile(join(baseDir, 'manifest.json'), 'utf8')) as CorpusManifest).files.oracleCsv?.[0]
  const changedOracle = changedManifest.files.oracleCsv?.[0]
  if (!bootstrapOneOracle || !bootstrapTwoOracle || !baseOracle || !changedOracle) throw new Error('Representative corpus copy did not contain Oracle data')
  await sampleOracleCorpus(bootstrapOneOracle, 98)
  await sampleOracleCorpus(bootstrapTwoOracle, 99)
  const sampled = await sampleOracleCorpus(baseOracle, 100)
  await sampleOracleCorpus(changedOracle, 100)
  const appended = await appendLateLckSeries(changedOracle)
  changedManifest.generatedAt = '2026-07-21T11:00:00.000Z'
  changedManifest.end = '2026-07-21'
  await writeFile(join(changedDir, 'manifest.json'), `${JSON.stringify(changedManifest, null, 2)}\n`)
  const oracleBytes = (await readFile(oracle2026)).byteLength
  const leaguepediaBytes = (await readFile(leaguepedia)).byteLength
  return {
    baseDir,
    changedDir,
    bootstrapDirs: [bootstrapOneDir, bootstrapTwoDir, baseDir],
    identity: {
      mode: 'current-data-representative',
      description: '100 real current Oracle games stratified across available calendar months plus the latest Leaguepedia provider snapshot, with one complete current LCK series appended; bounded after larger cold-shadow runs exceeded safe local resource limits',
      manifest: relative(process.cwd(), sourceManifestPath),
      start: representative.start,
      baseEnd: representative.end,
      changedEnd: changedManifest.end,
      sourceFiles: 2,
      sourceBytes: oracleBytes + leaguepediaBytes,
      providers: { oracle: 1, leaguepedia: 1, lolEsports: 0 },
      sampledGames: sampled.games,
      sampledRows: sampled.rows,
      observedPlayerRows: Math.max(0, sampled.rows - sampled.games * 2),
      appendedSeries: appended,
    },
  }
}

async function sampleOracleCorpus(path: string, gameLimit: number) {
  const input = await readFile(path, 'utf8')
  const newline = input.indexOf('\n')
  const header = input.slice(0, newline).replace(/\r$/, '')
  const lines = input.slice(newline + 1).match(/^.*$/gm)?.filter(Boolean) ?? []
  const gameIds: string[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    const id = line.slice(0, line.indexOf(','))
    if (id && !seen.has(id)) {
      seen.add(id)
      gameIds.push(id)
    }
  }
  const records = parseOraclesElixirCsvRecords(`${header}\n${lines.join('\n')}`)
  const monthByGame = new Map<string, string>()
  for (const row of records) if (row.gameid && !monthByGame.has(row.gameid)) monthByGame.set(row.gameid, row.date.slice(0, 7))
  const gamesByMonth = new Map<string, string[]>()
  for (const id of gameIds) {
    const month = monthByGame.get(id)
    if (!month) continue
    gamesByMonth.set(month, [...(gamesByMonth.get(month) ?? []), id])
  }
  const perMonth = Math.max(1, Math.floor(gameLimit / Math.max(1, gamesByMonth.size)))
  const selected = new Set([...gamesByMonth.values()].flatMap((ids) => ids.slice(-perMonth)))
  for (const id of gameIds.toReversed()) {
    if (selected.size >= gameLimit) break
    selected.add(id)
  }
  const lckLines = lines.filter((line) => /^[^,]*,[^,]*,[^,]*,LCK,/.test(line))
  const lckRecords = parseOraclesElixirCsvRecords(`${header}\n${lckLines.join('\n')}`)
  const latestLckDate = lckRecords.map((row) => row.date.slice(0, 10)).sort().at(-1)
  for (const row of lckRecords) if (row.date.startsWith(latestLckDate ?? '<missing>')) selected.add(row.gameid)
  const sampledLines = lines.filter((line) => selected.has(line.slice(0, line.indexOf(','))))
  await writeFile(path, `${header}\n${sampledLines.join('\n')}\n`)
  return { games: selected.size, rows: sampledLines.length }
}

async function copyManifestCorpus(manifest: CorpusManifest, targetDir: string) {
  const next: CorpusManifest = { ...manifest, files: {} }
  for (const [kind, paths] of Object.entries(manifest.files)) {
    next.files[kind] = []
    for (const [index, source] of paths.entries()) {
      const target = join(targetDir, kind, `${String(index).padStart(2, '0')}-${source.split(/[\\/]/).at(-1)}`)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(source, target)
      next.files[kind].push(target)
    }
  }
  await writeFile(join(targetDir, 'manifest.json'), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

async function copyProductionCorpus(sourceDir: string, outputDir: string) {
  const manifest = JSON.parse(await readFile(join(sourceDir, 'manifest.json'), 'utf8')) as CorpusManifest
  const copied: CorpusManifest = { ...manifest, files: {} }
  let bytes = 0
  let oracleRows = 0
  let files = 0
  for (const [kind, paths] of Object.entries(manifest.files)) {
    copied.files[kind] = []
    for (const [index, source] of paths.entries()) {
      const target = join(outputDir, kind, `${String(index).padStart(2, '0')}-${source.split(/[\\/]/).at(-1)}`)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(source, target)
      const contents = await readFile(source)
      bytes += contents.byteLength
      files += 1
      if (kind === 'oracleCsv') oracleRows += Math.max(0, contents.toString('utf8').split(/\r?\n/).filter(Boolean).length - 1)
      copied.files[kind].push(target)
    }
  }
  await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(copied, null, 2)}\n`)
  return { files, bytes, oracleRows }
}

async function appendLateLckSeries(path: string) {
  const input = await readFile(path, 'utf8')
  const headerLine = input.slice(0, input.indexOf('\n')).replace(/\r$/, '')
  const headers = headerLine.split(',')
  const lckLines = input.match(/^[^,\r\n]*,[^,\r\n]*,[^,\r\n]*,LCK,.*$/gm) ?? []
  const records = parseOraclesElixirCsvRecords(`${headerLine}\n${lckLines.join('\n')}`)
  const games = new Map<string, typeof records>()
  for (const row of records) {
    if (row.league !== 'LCK' || !row.gameid) continue
    games.set(row.gameid, [...(games.get(row.gameid) ?? []), row])
  }
  const grouped = new Map<string, Array<{ id: string; rows: typeof records }>>()
  for (const [id, rows] of games) {
    const first = rows[0]
    if (!first) continue
    const teams = [...new Set(rows.map((row) => row.teamname).filter(Boolean))].sort()
    const key = `${first.date.slice(0, 10)}:${teams.join('|')}`
    grouped.set(key, [...(grouped.get(key) ?? []), { id, rows }])
  }
  const candidates = [...grouped.entries()].sort(([left], [right]) => right.localeCompare(left))
  const selected = candidates.find(([, entries]) => entries.length >= 2)?.[1]
  if (!selected) throw new Error('Could not find a complete LCK series to clone')
  selected.sort((left, right) => (left.rows[0]?.date ?? '').localeCompare(right.rows[0]?.date ?? ''))
  const cloned = selected.flatMap((game, gameIndex) => game.rows.map((row) => ({
    ...row,
    gameid: `PERF_LCK_20260721_${gameIndex + 1}`,
    date: `2026-07-21 ${String(10 + gameIndex).padStart(2, '0')}:00:00`,
    game: String(gameIndex + 1),
    year: '2026',
  })))
  const lines = cloned.map((row) => headers.map((header) => csvCell(row[header.trim().toLowerCase()] ?? '')).join(','))
  await writeFile(path, `${input.replace(/\s*$/, '')}\n${lines.join('\n')}\n`)
  return {
    date: '2026-07-21',
    games: selected.length,
    rows: cloned.length,
    teams: [...new Set(cloned.map((row) => row.teamname).filter(Boolean))].sort(),
  }
}

function csvCell(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

function cloneStoredObjects(objects: Map<string, StoredObject>) {
  return new Map([...objects].map(([key, value]) => [key, { ...value, bytes: Buffer.from(value.bytes), metadata: { ...value.metadata } }]))
}

function restoreStoredObjects(s3: Awaited<ReturnType<typeof startMemoryS3>>, snapshot: Map<string, StoredObject>) {
  s3.objects.clear()
  for (const [key, value] of snapshot) s3.objects.set(key, { ...value, bytes: Buffer.from(value.bytes), metadata: { ...value.metadata } })
  s3.putKeys.length = 0
  s3.putBytes.length = 0
}

function nullableNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0)
}

function medianDefined(values: Array<number | null>) {
  const defined = values.filter((value): value is number => value !== null)
  return defined.length > 0 ? median(defined) : null
}

function ratio(left: number, right: number) {
  return right > 0 ? left / right : left === 0 ? 0 : Number.POSITIVE_INFINITY
}

function ratioDefined(left: number | null, right: number | null) {
  return left === null || right === null ? null : ratio(left, right)
}

async function runScenario(scenario: ScenarioName) {
  const root = await mkdtemp(join(tmpdir(), `ranking-durable-production-${scenario}-`))
  const s3 = await startMemoryS3()
  try {
    const baseEnv = bucketEnv(s3.endpoint)
    let activeGeneration = ''
    for (let run = 1; run <= 3; run += 1) {
      const metadata = runMetadata(scenario, `shadow-${run}`)
      const result = await productionRefresh({ root, s3, scenario, phase: 'base', mode: 'incremental-shadow', fence: run, metadata, baseEnv, force: true })
      if (!result.hasPrivateState) throw new Error(`Shadow bootstrap did not publish private state: ${JSON.stringify(result.candidate)}`)
      activeGeneration = result.activeGeneration
      await removeContainerState(root)
    }
    const finalMetadata = scenario === 'no-change' || scenario === 'cold-restore'
      ? { generatedAt: '2026-07-13T12:00:00.000Z', runId: `${scenario}-final` }
      : runMetadata(scenario, 'final')
    const final = await productionRefresh({
      root,
      s3,
      scenario,
      phase: 'changed',
      mode: 'incremental',
      fence: 4,
      metadata: finalMetadata,
      baseEnv,
      force: scenario === 'no-change' || scenario === 'cold-restore',
    })
    const preservedGeneration = final.activeGeneration === activeGeneration
    const expectedGeneration = final.activeGeneration
    if (scenario === 'no-change' && final.activeGeneration !== activeGeneration) {
      throw new Error(`Semantic no-change promoted unexpectedly: ${JSON.stringify(final.receipt)}`)
    }
    const fullMetadata = preservedGeneration ? runMetadata(scenario, 'shadow-3') : finalMetadata
    const fullDir = join(root, 'full-public')
    const fullRaw = await materializeInputs(root, scenario, 'changed', 'full-input', 3)
    await normalizeFixtureManifest(fullRaw.dir, fullRaw.manifest)
    await runBuild([
      '--full',
      '--manifest', fullRaw.manifest,
      '--output', join(root, 'full.json'),
      '--public-data-dir', fullDir,
      '--generated-at', fullMetadata.generatedAt,
      '--run-id', fullMetadata.runId,
      '--static-player-json', fullRaw.rosters,
    ], { ...baseEnv, RANKING_DURABLE_STATE_ENABLED: 'false' })
    assertPublicTreesEqual(await publicTreeFromBucket(s3.objects, expectedGeneration), await publicTreeFromDirectory(fullDir))
    const receipt = final.receipt
    const durable = record(receipt.durable)
    const snapshotInputs = record(receipt.snapshotInputs)
    const artifacts = record(receipt.artifacts)
    const bucket = record(receipt.bucket)
    if (scenario === 'no-change') {
      assert.equal(durable.promotion, 'no-change')
      assert.equal(number(durable.uploadedObjects), 0)
      assert.equal(number(durable.uploadedBytes), 0)
      assert.equal(number(artifacts.regenerated), 0)
      assert.equal(number(snapshotInputs.rankingReducerRuns), 0)
      assert.equal(number(snapshotInputs.playerReducerRuns), 0)
    }
    return {
      scenario,
      promotion: durable.promotion,
      publicUploads: final.publicUploads,
      privateUploadedObjects: number(durable.uploadedObjects),
      privateUploadedBytes: number(durable.uploadedBytes),
      restoredBytes: number(durable.restoredBytes),
      stateBytesRead: number(bucket.bytesRead),
      stateBytesWritten: number(bucket.bytesWritten),
      rankingRuns: number(snapshotInputs.rankingReducerRuns),
      rankingRows: number(snapshotInputs.rankingRows),
      playerRuns: number(snapshotInputs.playerReducerRuns),
      playerRows: number(snapshotInputs.playerRows),
      cacheHits: number(snapshotInputs.rankingResultCacheHits) + number(snapshotInputs.playerResultCacheHits),
      artifactWrites: number(artifacts.regenerated),
      gc: durable.gc,
    }
  } finally {
    await s3.close()
    await rm(root, { recursive: true, force: true })
  }
}

async function productionRefresh(options: {
  root: string
  s3: Awaited<ReturnType<typeof startMemoryS3>>
  scenario: ScenarioName
  phase: 'base' | 'changed'
  mode: 'incremental-shadow' | 'incremental' | 'full'
  fence: number
  metadata: { generatedAt: string; runId: string }
  baseEnv: NodeJS.ProcessEnv
  force: boolean
  bootstrapStep?: number
  forbidLateWork?: boolean
  extraEnv?: NodeJS.ProcessEnv
  resources?: ResourceSample[]
}) {
  const container = join(options.root, `container-${options.fence}`)
  const rawDir = join(container, 'raw')
  const publicDir = join(container, 'public')
  const stateDir = join(container, 'private')
  const statePath = join(rawDir, 'refresh-state.json')
  const rosterPath = join(container, 'rosters.json')
  const beforePublicPuts = options.s3.putKeys.filter((key) => key.includes('/generations/') && key.includes('/data/')).length
  const bucketConfig = bucketConfigFromEnv(options.baseEnv)
  const bucketClient = createBucketClient(bucketConfig)
  assert.ok(bucketClient)
  const leaseKey = 'ops/refresh-lease.json'
  const lease = await acquireBucketLease(leaseKey, {
    owner: `durable-benchmark:${options.scenario}:${options.fence}`,
    ttlMs: 45 * 60_000,
    fenceActiveKey: 'active-generation.json',
    config: bucketConfig,
    client: bucketClient,
  })
  if (!lease.acquired) throw new Error(`Benchmark refresh lease was not acquired: ${lease.reason}`)
  assert.equal(lease.lease.fencingToken, options.fence)
  const beforeBucketWrites = options.s3.putKeys.length
  const env: NodeJS.ProcessEnv = {
    ...options.baseEnv,
    ...options.extraEnv,
    RANKING_CRUNCH_MODE: options.mode,
    RANKING_INCREMENTAL_STATE_DIR: stateDir,
    RANKING_STATIC_PLAYER_JSON: rosterPath,
    RANKING_REFRESH_FENCING_TOKEN: String(lease.lease.fencingToken),
    RANKING_REFRESH_LEASE_KEY: leaseKey,
    RANKING_REFRESH_LEASE_OWNER: lease.lease.owner,
    RANKING_REFRESH_LEASE_ETAG: lease.etag,
    RANKING_REFRESH_LEASE_AUTHORITY_KEY: lease.authorityKey,
    RANKING_REFRESH_LEASE_EXPIRES_AT: lease.lease.expiresAt,
    RANKING_BUCKET_RESTORE_RAW: 'true',
    ...((options.forbidLateWork ?? true)
      && (options.scenario === 'no-change' || options.scenario === 'cold-restore')
      && options.mode === 'incremental'
      ? { RANKING_TEST_FORBID_LATE_INCREMENTAL_WORK: 'true' }
      : {}),
  }
  try {
    const refreshResult = await refreshDataIfChanged([
      '--raw-dir', rawDir,
      '--manifest', join(rawDir, 'manifest.json'),
      '--state', statePath,
      '--output', join(container, 'snapshot.json'),
      '--public-data-dir', publicDir,
      '--staging-dir', join(container, 'staging'),
      '--end', '2026-07-19',
      ...(options.force ? ['--force'] : []),
    ], {
      env,
      bucketConfig,
      bucketClient,
      run: async (command: string, args: string[]) => {
        if (args.includes('scripts/download-local-data.mjs')) {
          const outputDir = valueAfter(args, '--out-dir')
          const inputs = await materializeInputs(
            options.root,
            options.scenario,
            options.phase,
            relative(options.root, outputDir),
            options.bootstrapStep ?? options.fence,
          )
          await copyInputs(inputs, outputDir, rosterPath)
          return
        }
        assert.equal(command, 'pnpm')
        await runBuild([...args.slice(args.indexOf('scripts/build-static-snapshot.ts') + 1),
          '--generated-at', options.metadata.generatedAt,
          '--run-id', options.metadata.runId,
        ], env, options.resources)
      },
    })
    if (refreshResult.durableCandidate.kind === 'not-produced') {
      assert.equal(refreshResult.changed, false)
      assert.equal(refreshResult.status, 'unchanged')
      assert.equal(refreshResult.durableCandidate.reason, 'unchanged-source-data')
    }
    return await benchmarkRefreshResult({
      options,
      statePath,
      beforePublicPuts,
      beforeBucketWrites,
      refreshResult,
    })
  } finally {
    const released = await releaseBucketLease(leaseKey, lease, { config: bucketConfig, client: bucketClient })
    assert.equal(released.released, true)
  }
}

async function benchmarkRefreshResult({ options, statePath, beforePublicPuts, beforeBucketWrites, refreshResult }: {
  options: Parameters<typeof productionRefresh>[0]
  statePath: string
  beforePublicPuts: number
  beforeBucketWrites: number
  refreshResult: Awaited<ReturnType<typeof refreshDataIfChanged>>
}) {
  const active = JSON.parse(Buffer.from(requiredObject(options.s3.objects, 'bucket/rankings/active-generation.json').bytes).toString('utf8'))
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  return {
    active,
    activeGeneration: String(active.generationId),
    hasPrivateState: Boolean(active.privateState),
    candidate: refreshResult.durableCandidate,
    receipt: record(record(state.crunch).receipt),
    publicUploads: options.s3.putKeys.filter((key) => key.includes('/generations/') && key.includes('/data/')).length - beforePublicPuts,
    bucketWrites: options.s3.putKeys.length - beforeBucketWrites,
  }
}

function requiredCandidate(result: { candidate: Awaited<ReturnType<typeof refreshDataIfChanged>>['durableCandidate'] }) {
  if (result.candidate.kind !== 'produced') throw new Error(`Expected a durable candidate, received ${result.candidate.reason}`)
  return result.candidate.receipt
}

async function materializeInputs(root: string, scenario: ScenarioName, phase: 'base' | 'changed', name: string, bootstrapStep: number) {
  const dir = resolve(root, name)
  const oracleDir = join(dir, 'oracles-elixir')
  const lolDir = join(dir, 'lol-esports')
  await mkdir(oracleDir, { recursive: true })
  await mkdir(lolDir, { recursive: true })
  const oracle = join(oracleDir, '2026.csv')
  const lolesports = join(lolDir, 'schedule.json')
  const rosters = join(dir, 'rosters.json')
  await writeFile(oracle, oracleContents(scenario, phase, bootstrapStep))
  await writeFile(lolesports, `${JSON.stringify(scheduleContents(scenario, phase), null, 2)}\n`)
  await writeFile(rosters, `${JSON.stringify(rosterContents(scenario, phase), null, 2)}\n`)
  const manifest = join(dir, 'manifest.json')
  await writeFile(manifest, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-07-19T00:00:00.000Z',
    start: '2026-01-01',
    end: '2026-07-19',
    files: { oracleCsv: [oracle], leaguepediaJson: [], lolEsportsJson: scenario === 'context-only' && phase === 'changed' ? [lolesports] : [] },
    sources: {
      oracle: { status: 'downloaded', downloadedCount: 1, failedCount: 0 },
      leaguepedia: { status: 'disabled', downloadedCount: 0, failedCount: 0 },
      lolesports: { status: 'downloaded', downloadedCount: 1, failedCount: 0 },
    },
    warnings: [],
  }, null, 2)}\n`)
  return { dir, oracle, lolesports, rosters, manifest }
}

async function copyInputs(inputs: Awaited<ReturnType<typeof materializeInputs>>, outputDir: string, rosterPath: string) {
  const oracle = join(outputDir, 'oracles-elixir', '2026.csv')
  const schedule = join(outputDir, 'lol-esports', 'schedule.json')
  await mkdir(dirname(oracle), { recursive: true })
  await mkdir(dirname(schedule), { recursive: true })
  await writeFile(oracle, await readFile(inputs.oracle))
  await writeFile(schedule, await readFile(inputs.lolesports))
  await mkdir(dirname(rosterPath), { recursive: true })
  await writeFile(rosterPath, await readFile(inputs.rosters))
  const manifest = JSON.parse(await readFile(inputs.manifest, 'utf8'))
  manifest.files.oracleCsv = [oracle]
  manifest.files.lolEsportsJson = manifest.files.lolEsportsJson.length > 0 ? [schedule] : []
  await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

async function normalizeFixtureManifest(rawDir: string, manifestPath: string) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const normalized = await createNormalizedOracleChunks({ manifest, rawDir, stagingDir: rawDir })
  manifest.files.normalizedOracleCsv = normalized.files
  manifest.normalizedProviderChunks = {
    schemaVersion: 1,
    generatedAt: manifest.generatedAt,
    chunks: normalized.chunks,
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function oracleContents(scenario: ScenarioName, phase: 'base' | 'changed', bootstrapStep: number) {
  const sequence = [gameOne, gameTwo, gameThree, gameFour, gameFive, gameSix]
  let rows = scenario === 'successive-append'
    ? sequence.slice(0, bootstrapStep).flat()
    : [...gameOne, ...(bootstrapStep >= 2 ? gameTwo : []), ...(bootstrapStep >= 3 ? gameThree : [])]
  if (phase === 'changed' && scenario === 'append') rows.push(...gameFour)
  if (phase === 'changed' && scenario === 'old-correction') {
    rows = rows.map((row) => row.includes(',Blue,Gen.G,1,') ? row.replace(',Blue,Gen.G,1,', ',Blue,Gen.G,0,') : row.replace(',Red,T1,0,', ',Red,T1,1,'))
  }
  return [header, ...rows].join('\n')
}

function scheduleContents(scenario: ScenarioName, phase: 'base' | 'changed') {
  const completed = scenario === 'context-only' && phase === 'changed'
  return {
    source: 'benchmark',
    fetchedAt: '2026-07-19T00:00:00.000Z',
    events: [{
      startTime: '2026-01-10T12:00:00Z',
      state: completed ? 'completed' : 'unstarted',
      type: 'match',
      league: { name: 'LCK', slug: 'lck' },
      match: {
        id: 'official-g1',
        teams: [
          { name: 'Gen.G', result: { outcome: completed ? 'win' : null, gameWins: completed ? 1 : 0 } },
          { name: 'T1', result: { outcome: completed ? 'loss' : null, gameWins: 0 } },
        ],
        strategy: { type: 'bestOf', count: 1 },
      },
    }],
  }
}

function rosterContents(scenario: ScenarioName, phase: 'base' | 'changed') {
  const changed = scenario === 'static-player-change' && phase === 'changed'
  return {
    'Gen.G': [{ id: 'gen-top', name: changed ? 'Kiin Updated' : 'Kiin', team: 'Gen.G', role: 'Top' }],
    T1: [{ id: 't1-top', name: 'Doran', team: 'T1', role: 'Top' }],
  }
}

function runMetadata(scenario: ScenarioName, phase: string) {
  const index = ['shadow-1', 'shadow-2', 'shadow-3', 'final'].indexOf(phase) + 1
  return { generatedAt: `2026-07-${String(10 + index).padStart(2, '0')}T00:00:00.000Z`, runId: `${scenario}-${phase}` }
}

async function runBuild(args: string[], env: NodeJS.ProcessEnv, resources?: ResourceSample[]) {
  await new Promise<void>((resolvePromise, reject) => {
    const resourceFormat = '__RANKING_RESOURCE__ %e %U %S %M'
    const command = resources ? '/usr/bin/time' : 'pnpm'
    const commandArgs = resources
      ? ['-f', resourceFormat, 'pnpm', 'exec', 'tsx', 'scripts/build-static-snapshot.ts', ...args, '--allow-public-artifact-budget-overage']
      : ['exec', 'tsx', 'scripts/build-static-snapshot.ts', ...args, '--allow-public-artifact-budget-overage']
    const child = spawn(command, commandArgs, {
      cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('exit', (code) => {
      const match = stderr.match(/__RANKING_RESOURCE__ ([\d.]+) ([\d.]+) ([\d.]+) (\d+)/)
      if (resources && match) {
        const wallMs = Number(match[1]) * 1_000
        const userCpuMs = Number(match[2]) * 1_000
        const systemCpuMs = Number(match[3]) * 1_000
        resources.push({
          wallMs,
          userCpuMs,
          systemCpuMs,
          cpuMs: userCpuMs + systemCpuMs,
          peakRssBytes: Number(match[4]) * 1_024,
        })
      }
      if (process.env.RANKING_DEBUG_PARITY === 'true' && stderr) process.stderr.write(stderr)
      if (code === 0 && (!resources || match)) resolvePromise()
      else if (code === 0) reject(new Error(`GNU time resource output was missing: ${stderr}`))
      else reject(new Error(`build-static-snapshot exited ${code}: ${stderr}`))
    })
  })
}

async function removeContainerState(root: string) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('container-')) await rm(join(root, entry.name), { recursive: true, force: true })
  }
}

async function publicTreeFromDirectory(root: string) {
  const result: Record<string, string> = {}
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else result[relative(root, path).split(sep).join('/')] = (await readFile(path)).toString('base64')
    }
  }
  await walk(root)
  return result
}

async function publicTreeFromBucket(objects: Map<string, StoredObject>, generationId: string) {
  const prefix = `bucket/rankings/generations/${generationId}/data/`
  const legacy = Object.fromEntries([...objects.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => [key.slice(prefix.length), value.bytes.toString('base64')])
    .sort(([left], [right]) => left.localeCompare(right)))
  if (Object.keys(legacy).length > 0) return legacy
  const manifestObject = objects.get(`bucket/rankings/generations/${generationId}/public-manifest.json`)
  if (!manifestObject) throw new Error(`Missing public manifest for ${generationId}`)
  const manifest = record(JSON.parse(manifestObject.bytes.toString('utf8')))
  const entries = Array.isArray(manifest.entries) ? manifest.entries : []
  return Object.fromEntries(entries.map(record).map((entry) => {
    const path = String(entry.path)
    const object = objects.get(`bucket/rankings/${String(entry.objectKey)}`)
    if (!object) throw new Error(`Missing public object ${String(entry.objectKey)}`)
    return [path, object.bytes.toString('base64')]
  }).sort(([left], [right]) => left.localeCompare(right)))
}

async function startFilesystemS3(storageRoot: string) {
  type FileObject = { etag: string; metadata: Record<string, string>; bytes: number }
  await mkdir(storageRoot, { recursive: true })
  const objects = new Map<string, FileObject>()
  const putKeys: string[] = []
  const putBytes: number[] = []
  const getKeys: string[] = []
  const getBytes: number[] = []
  const headKeys: string[] = []
  const snapshotDirectories = new Set<string>()
  let revision = 0
  const objectPath = (key: string) => {
    const path = resolve(storageRoot, key)
    if (path !== storageRoot && !path.startsWith(`${storageRoot}${sep}`)) throw new Error(`Unsafe filesystem S3 key: ${key}`)
    return path
  }
  const server = createServer(async (request, response) => {
    let temporaryPath: string | undefined
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const key = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const rawPrefix = url.searchParams.get('prefix') ?? ''
        const prefix = `bucket/${rawPrefix}`
        const contents = [...objects.entries()]
          .filter(([candidate]) => candidate.startsWith(prefix))
          .map(([candidate, object]) => `<Contents><Key>${xml(candidate.slice('bucket/'.length))}</Key><ETag>${xml(object.etag)}</ETag><Size>${object.bytes}</Size></Contents>`)
          .join('')
        response.writeHead(200, { 'content-type': 'application/xml' })
        return response.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>bucket</Name><Prefix>${xml(rawPrefix)}</Prefix><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`)
      }
      if (request.method === 'PUT') {
        const current = objects.get(key)
        if ((request.headers['if-none-match'] === '*' && current) || (request.headers['if-match'] && request.headers['if-match'] !== current?.etag)) {
          for await (const chunk of request) {
            // Drain the streamed request before the fixture returns 412 so the SDK does not see EPIPE.
            void chunk
          }
          return precondition(response)
        }
        const path = objectPath(key)
        await mkdir(dirname(path), { recursive: true })
        temporaryPath = `${path}.${process.pid}-${++revision}.tmp`
        await pipeline(request, createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }))
        await rename(temporaryPath, path)
        temporaryPath = undefined
        const bytes = (await stat(path)).size
        const etag = `"filesystem-${revision}"`
        const metadata = Object.fromEntries(Object.entries(request.headers)
          .filter(([name, value]) => name.startsWith('x-amz-meta-') && typeof value === 'string')
          .map(([name, value]) => [name.slice('x-amz-meta-'.length), String(value)]))
        objects.set(key, { etag, metadata, bytes })
        putKeys.push(key)
        putBytes.push(bytes)
        response.writeHead(200, { etag })
        return response.end()
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        const object = objects.get(key)
        if (!object) return missing(response)
        if (request.method === 'GET') {
          getKeys.push(key)
          getBytes.push(object.bytes)
        } else {
          headKeys.push(key)
        }
        response.writeHead(200, {
          etag: object.etag,
          'content-length': object.bytes,
          ...Object.fromEntries(Object.entries(object.metadata).map(([name, value]) => [`x-amz-meta-${name}`, value])),
        })
        if (request.method === 'HEAD') return response.end()
        return pipeline(createReadStream(objectPath(key)), response)
      }
      if (request.method === 'DELETE') {
        objects.delete(key)
        await rm(objectPath(key), { force: true })
        response.writeHead(204)
        return response.end()
      }
      response.writeHead(400)
      response.end()
    } catch (error) {
      if (temporaryPath) await rm(temporaryPath, { force: true })
      if (!response.headersSent) response.writeHead(500)
      response.end(error instanceof Error ? error.message : String(error))
    }
  })
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    putKeys,
    putBytes,
    getKeys,
    getBytes,
    headKeys,
    retainedBreakdown() {
      let bucketPrivate = 0
      let bucketAuthoritative = 0
      for (const [key, object] of objects) {
        if (classifyRetainedObjectKey(key) === 'bucketPrivate') bucketPrivate += object.bytes
        else bucketAuthoritative += object.bytes
      }
      return { bucketAuthoritative, bucketPrivate, volumePrivate: 0 }
    },
    async readObject(key: string) {
      if (!objects.has(key)) throw new Error(`Missing object ${key}`)
      return readFile(objectPath(key))
    },
    async publicTree(generationId: string) {
      const prefix = `bucket/rankings/generations/${generationId}/data/`
      const rows = await Promise.all([...objects.keys()].filter((key) => key.startsWith(prefix)).map(async (key) => [
        key.slice(prefix.length),
        (await readFile(objectPath(key))).toString('base64'),
      ] as const))
      if (rows.length === 0) {
        const manifest = JSON.parse(await readFile(objectPath(`bucket/rankings/generations/${generationId}/public-manifest.json`), 'utf8')) as { entries: Array<{ path: string; objectKey: string }> }
        const resolved = await Promise.all(manifest.entries.map(async (entry) => [
          entry.path,
          (await readFile(objectPath(`bucket/rankings/${entry.objectKey}`))).toString('base64'),
        ] as const))
        return Object.fromEntries(resolved.sort(([left], [right]) => left.localeCompare(right)))
      }
      return Object.fromEntries(rows.sort(([left], [right]) => left.localeCompare(right)))
    },
    async snapshot() {
      const directory = await mkdtemp(join(tmpdir(), 'ranking-filesystem-s3-snapshot-'))
      snapshotDirectories.add(directory)
      await cloneTreeWithLinks(storageRoot, directory)
      return { directory, objects: new Map([...objects].map(([key, value]) => [key, { ...value, metadata: { ...value.metadata } }])) }
    },
    async restore(snapshot: { directory: string; objects: Map<string, FileObject> }) {
      await rm(storageRoot, { recursive: true, force: true })
      await mkdir(storageRoot, { recursive: true })
      await cloneTreeWithLinks(snapshot.directory, storageRoot)
      objects.clear()
      for (const [key, value] of snapshot.objects) objects.set(key, { ...value, metadata: { ...value.metadata } })
      putKeys.length = 0
      putBytes.length = 0
      getKeys.length = 0
      getBytes.length = 0
      headKeys.length = 0
    },
    async close() {
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
      await Promise.all([...snapshotDirectories].map((directory) => rm(directory, { recursive: true, force: true })))
    },
  }
}

async function cloneTreeWithLinks(source: string, destination: string) {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) await cloneTreeWithLinks(from, to)
    else if (entry.isFile()) {
      try {
        await link(from, to)
      } catch {
        await copyFile(from, to, fsConstants.COPYFILE_FICLONE)
      }
    }
  }
}

async function startMemoryS3() {
  const objects = new Map<string, StoredObject>()
  const putKeys: string[] = []
  const putBytes: number[] = []
  let revision = 0
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const key = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (request.method === 'GET' && url.searchParams.get('list-type') === '2') return listObjects(response, objects, url.searchParams.get('prefix') ?? '')
      if (request.method === 'PUT') {
        const current = objects.get(key)
        if ((request.headers['if-none-match'] === '*' && current) || (request.headers['if-match'] && request.headers['if-match'] !== current?.etag)) return precondition(response)
        const bytes = await requestBytes(request)
        const etag = `"memory-${++revision}"`
        const metadata = Object.fromEntries(Object.entries(request.headers)
          .filter(([name, value]) => name.startsWith('x-amz-meta-') && typeof value === 'string')
          .map(([name, value]) => [name.slice('x-amz-meta-'.length), String(value)]))
        objects.set(key, { bytes, etag, metadata })
        putKeys.push(key)
        putBytes.push(bytes.byteLength)
        response.writeHead(200, { etag })
        return response.end()
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        const object = objects.get(key)
        if (!object) return missing(response)
        response.writeHead(200, { etag: object.etag, 'content-length': object.bytes.byteLength, ...Object.fromEntries(Object.entries(object.metadata).map(([name, value]) => [`x-amz-meta-${name}`, value])) })
        return response.end(request.method === 'HEAD' ? undefined : object.bytes)
      }
      if (request.method === 'DELETE') {
        objects.delete(key)
        response.writeHead(204)
        return response.end()
      }
      response.writeHead(400)
      response.end()
    } catch (error) {
      response.writeHead(500)
      response.end(error instanceof Error ? error.message : String(error))
    }
  })
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    objects,
    putKeys,
    putBytes,
    close: () => new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())),
  }
}

async function startAlertSink() {
  const requests: unknown[] = []
  const server = createServer(async (request, response) => {
    requests.push(JSON.parse((await requestBytes(request)).toString('utf8')))
    response.writeHead(204)
    response.end()
  })
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())),
  }
}

function listObjects(response: ServerResponse, objects: Map<string, StoredObject>, rawPrefix: string) {
  const prefix = `bucket/${rawPrefix}`
  const contents = [...objects.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, object]) => `<Contents><Key>${xml(key.slice('bucket/'.length))}</Key><ETag>${xml(object.etag)}</ETag><Size>${object.bytes.byteLength}</Size></Contents>`).join('')
  response.writeHead(200, { 'content-type': 'application/xml' })
  response.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>bucket</Name><Prefix>${xml(rawPrefix)}</Prefix><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`)
}

function precondition(response: ServerResponse) {
  response.writeHead(412, { 'content-type': 'application/xml' })
  response.end('<Error><Code>PreconditionFailed</Code></Error>')
}

function missing(response: ServerResponse) {
  response.writeHead(404, { 'content-type': 'application/xml' })
  response.end('<Error><Code>NoSuchKey</Code></Error>')
}

async function requestBytes(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function bucketEnv(endpoint: string): NodeJS.ProcessEnv {
  return {
    BUCKET: 'bucket', ENDPOINT: endpoint, REGION: 'us-east-1', ACCESS_KEY_ID: 'test', SECRET_ACCESS_KEY: 'test',
    RANKING_BUCKET_PREFIX: 'rankings', RANKING_BUCKET_FORCE_PATH_STYLE: 'true', RANKING_BUCKET_UPLOAD_ENABLED: 'true',
  }
}

function valueAfter(args: string[], flag: string) {
  const value = args[args.indexOf(flag) + 1]
  if (!value) throw new Error(`Missing ${flag}`)
  return value
}

function requiredObject(objects: Map<string, StoredObject>, key: string) {
  const value = objects.get(key)
  if (!value) throw new Error(`Missing object ${key}`)
  return value
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function number(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function assertPublicTreesEqual(actual: Record<string, string>, expected: Record<string, string>) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort())
  for (const path of Object.keys(expected).sort()) {
    const actualBytes = Buffer.from(actual[path] ?? '', 'base64')
    const expectedBytes = Buffer.from(expected[path] ?? '', 'base64')
    if (actualBytes.equals(expectedBytes)) continue
    const shared = Math.min(actualBytes.byteLength, expectedBytes.byteLength)
    let offset = 0
    while (offset < shared && actualBytes[offset] === expectedBytes[offset]) offset += 1
    throw new Error(`Public tree mismatch ${path} at byte ${offset} (${actualBytes.byteLength} != ${expectedBytes.byteLength}); ${jsonDifference(actualBytes, expectedBytes)}`)
  }
}

function jsonDifference(actual: Buffer, expected: Buffer) {
  try {
    return firstValueDifference(JSON.parse(actual.toString('utf8')), JSON.parse(expected.toString('utf8')), '$') ?? 'JSON values differ'
  } catch {
    return 'non-JSON bytes differ'
  }
}

function firstValueDifference(actual: unknown, expected: unknown, path: string): string | undefined {
  if (Object.is(actual, expected)) return undefined
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) return `${path}.length: ${actual.length} != ${expected.length}`
    for (let index = 0; index < actual.length; index += 1) {
      const difference = firstValueDifference(actual[index], expected[index], `${path}[${index}]`)
      if (difference) return difference
    }
    return undefined
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const actualRecord = actual as Record<string, unknown>
    const expectedRecord = expected as Record<string, unknown>
    const keys = [...new Set([...Object.keys(actualRecord), ...Object.keys(expectedRecord)])].sort()
    for (const key of keys) {
      if (!(key in actualRecord)) return `${path}.${key}: missing from actual`
      if (!(key in expectedRecord)) return `${path}.${key}: missing from expected`
      const difference = firstValueDifference(actualRecord[key], expectedRecord[key], `${path}.${key}`)
      if (difference) return difference
    }
    return undefined
  }
  return `${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`
}

function xml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) console.log(JSON.stringify(await runDurableBenchmark(), null, 2))
