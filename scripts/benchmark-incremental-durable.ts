import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  acquireBucketLease,
  bucketConfigFromEnv,
  createBucketClient,
  releaseBucketLease,
} from './railway-bucket.mjs'
import { refreshDataIfChanged } from './refresh-data-if-changed.mjs'

type ScenarioName = 'no-change' | 'append' | 'old-correction' | 'context-only' | 'static-player-change' | 'cold-restore'
type StoredObject = { bytes: Buffer; etag: string; metadata: Record<string, string> }

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

export async function runDurableBenchmark() {
  const allScenarios: ScenarioName[] = ['no-change', 'append', 'old-correction', 'context-only', 'static-player-change', 'cold-restore']
  const selected = process.env.RANKING_BENCHMARK_SCENARIO
  const scenarios = selected && allScenarios.includes(selected as ScenarioName) ? [selected as ScenarioName] : allScenarios
  const rows = []
  for (const scenario of scenarios) rows.push(await runScenario(scenario))
  return { schemaVersion: 2, scenarios: rows }
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
    assert.deepEqual(activated.candidate, { kind: 'not-produced', reason: 'unchanged-source-data' })
    assert.equal(activated.active.generationId, identityB3.active.generationId)
    assert.deepEqual(activated.active.privateState, identityB3.active.privateState)
    assert.equal(activated.publicUploads, 0)
    assert.equal(activated.bucketWrites, 0)
    return {
      identityChanged: record(identityA.active.privateState).identityHash !== record(identityB1.active.privateState).identityHash,
      firstBSuccesses: number(record(identityB1.active.rollout).consecutiveShadowSuccesses),
      restoredBBytes: number(record(identityB2.receipt.durable).restoredBytes),
      activatedPromotion: 'not-produced',
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
  mode: 'incremental-shadow' | 'incremental'
  fence: number
  metadata: { generatedAt: string; runId: string }
  baseEnv: NodeJS.ProcessEnv
  force: boolean
  bootstrapStep?: number
  forbidLateWork?: boolean
  extraEnv?: NodeJS.ProcessEnv
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
    RANKING_DURABLE_GC_DRY_RUN: 'false',
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
        ], env)
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

function oracleContents(scenario: ScenarioName, phase: 'base' | 'changed', bootstrapStep: number) {
  let rows = [...gameOne, ...(bootstrapStep >= 2 ? gameTwo : []), ...(bootstrapStep >= 3 ? gameThree : [])]
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

async function runBuild(args: string[], env: NodeJS.ProcessEnv) {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'scripts/build-static-snapshot.ts', ...args], {
      cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (process.env.RANKING_DEBUG_PARITY === 'true' && stderr) process.stderr.write(stderr)
      if (code === 0) resolvePromise()
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
  return Object.fromEntries([...objects.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => [key.slice(prefix.length), value.bytes.toString('base64')])
    .sort(([left], [right]) => left.localeCompare(right)))
}

async function startMemoryS3() {
  const objects = new Map<string, StoredObject>()
  const putKeys: string[] = []
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
    throw new Error(`Public tree mismatch ${path} at byte ${offset} (${actualBytes.byteLength} != ${expectedBytes.byteLength})`)
  }
}

function xml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) console.log(JSON.stringify(await runDurableBenchmark(), null, 2))
