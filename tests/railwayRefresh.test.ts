import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import {
  ORACLE_GAME_INVENTORY_DIGEST_SCHEME,
  oracleGameInventory,
  prepareOracleBaseline,
  prepareRawSourceReceipt,
  rawObjectReferenceFor,
  type PreparedRawObject,
} from '../scripts/raw-source-storage.mjs'

type RefreshRun = (command: string, commandArgs: string[]) => Promise<void>
type RefreshResult = {
  changed: boolean
  fingerprint?: string
  healthFingerprint?: string
  previousFingerprint?: string
  status?: string
  reason?: string
  incrementalAction?: 'no-change' | 'publish-incremental' | 'publish-full'
  incrementalMetrics?: {
    classification: string
    fullSnapshotWritten: boolean
    parity: boolean | null
    stateParity: boolean | null
    stateParityReport?: { checkpointEqual: boolean }
    fallbackReason?: string
  }
}
type RefreshWindow = {
  start: string
  end: string
  lookbackDays: number | null
  bootstrapStart: string
  mode: string
}
type RefreshModule = {
  createSourceFingerprint: (manifest: unknown) => Promise<{ fingerprint: string; healthFingerprint: string }>
  invokeFullAuditReceiptIfEligible: (
    input: Record<string, unknown>,
    invoke: () => Promise<unknown>,
  ) => Promise<unknown | undefined>
  invokeFullAuditStageIfEligible: (
    input: Record<string, unknown>,
    invoke: () => Promise<unknown>,
  ) => Promise<unknown | undefined>
  manifestHasBootstrapCoverage: (manifest: unknown, bootstrapStart: string) => boolean
  refreshDataIfChanged: (rawArgs?: string[], options?: {
    run?: RefreshRun
    bucketClient?: BucketClient
    bucketConfig?: BucketConfig
    env?: Record<string, string | undefined>
    readActiveRawSourceAuthority?: () => Promise<unknown>
  }) => Promise<RefreshResult>
  refreshDateWindow: (options?: {
    args?: Record<string, string | undefined>
    env?: Record<string, string | undefined>
    end?: string
    hasExistingRawBaseline?: boolean
  }) => RefreshWindow
  sourceProviderResult: (
    manifest: Record<string, unknown>,
    forcedStatus?: 'available' | 'unavailable' | 'no-data',
  ) => { status: 'available' | 'unavailable' | 'no-data'; sources: Record<string, unknown>; warnings: string[] }
}
type BucketConfig = ReturnType<typeof bucketConfig>
type BucketClient = {
  send(command: { input: Record<string, unknown> }): Promise<unknown>
}
type BucketUploadResult = {
  enabled: boolean
  bucket?: string
  prefix?: string
  uploaded: Array<{ key: string; bytes?: number; contentType?: string }>
  unchanged: Array<{ key: string; bytes?: number; contentType?: string; digest?: string }>
  skipped: Array<{ key: string; reason: string }>
  artifactCount: number
  uploadedCount: number
  uploadedBytes: number
  unchangedCount: number
  unchangedBytes: number
}
type BucketModule = {
  bucketKey: (config: BucketConfig, path: string) => string
  getBucketObject: (path: string, options: { config: BucketConfig; client: BucketClient }) => Promise<{ found: boolean }>
  safeObjectPath: (path: string) => string
  safeRequestedObjectPath: (path: string) => string
  uploadRankingArtifacts: (options: {
    publicDataDir: string
    rawDir?: string
    fullSnapshotPath?: string
    manifestPath?: string
    statePath?: string
    config: BucketConfig
    client: BucketClient
    uploadFullSnapshot?: boolean
    refreshTelemetry?: unknown
  }) => Promise<BucketUploadResult>
}

const refreshScriptPath: string = '../scripts/refresh-data-if-changed.mjs'
const bucketScriptPath: string = '../scripts/railway-bucket.mjs'
const {
  createSourceFingerprint,
  invokeFullAuditReceiptIfEligible,
  invokeFullAuditStageIfEligible,
  manifestHasBootstrapCoverage,
  refreshDataIfChanged,
  refreshDateWindow,
  sourceProviderResult,
} = await import(refreshScriptPath) as unknown as RefreshModule
const { bucketKey, getBucketObject, safeObjectPath, safeRequestedObjectPath, uploadRankingArtifacts } = await import(bucketScriptPath) as unknown as BucketModule
const isolatedRefreshEnv = {
  RANKING_BUCKET_RESTORE_RAW: 'false',
  RANKING_BUCKET_UPLOAD_ENABLED: 'false',
}

test('full-audit injected functions run only for eligible daily and manual full refreshes', async () => {
  const common = {
    fullSnapshotPath: '/tmp/ranking-full.json',
    fullSnapshotDescriptor: {
      artifactKind: 'full-ranking-artifact', schemaVersion: 23, generatedAt: '2026-07-23T00:00:00.000Z',
      source: 'test', sources: [{ name: 'test' }], model: { version: 'model-v1', configHash: 'config-v1' },
      sha256: 'b'.repeat(64), bytes: 100,
    },
    generationId: 'generation-1',
    fencingToken: 7,
    stateManifestAuthority: { key: 'state/manifests/manifest.json', digest: 'a'.repeat(64) },
    rawReceiptAuthority: { receiptReference: { key: 'raw/receipts/receipt.json' }, receipt: {} },
    promotion: {
      completed: true,
      etag: 'promotion-etag',
      generationId: 'generation-1',
      fencingToken: 7,
    },
  }
  const cases = [
    { cause: 'daily-audit', result: 'publish-full', eligible: true },
    { cause: 'manual-force', result: 'publish-full', eligible: true },
    { cause: 'pending-match', result: 'publish-full', eligible: false },
    { cause: 'daily-audit', result: 'publish-incremental', eligible: false },
    { cause: 'daily-audit', result: 'no-change', eligible: false },
    { cause: 'daily-audit', result: 'failed', eligible: false },
  ] as const

  for (const refreshCase of cases) {
    let stageCalls = 0
    let receiptCalls = 0
    const input = { ...common, ...refreshCase }
    const stagedAudit = await invokeFullAuditStageIfEligible(input, async () => {
      stageCalls += 1
      return { reference: { key: 'audit/objects/snapshot.json.gz' } }
    })
    await invokeFullAuditReceiptIfEligible({
      ...input,
      stagedAudit: stagedAudit ?? { reference: { key: 'audit/objects/snapshot.json.gz' } },
    }, async () => {
      receiptCalls += 1
    })

    assert.equal(stageCalls, refreshCase.eligible ? 1 : 0, `${refreshCase.cause}/${refreshCase.result} stage`)
    assert.equal(receiptCalls, refreshCase.eligible ? 1 : 0, `${refreshCase.cause}/${refreshCase.result} receipt`)
  }
})

test('source fingerprint ignores volatile fetch timestamps', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-fingerprint-'))
  const firstDir = join(tempDir, 'first')
  const secondDir = join(tempDir, 'second')
  const firstPath = join(firstDir, 'leaguepedia.json')
  const secondPath = join(secondDir, 'leaguepedia.json')

  try {
    await mkdir(firstDir, { recursive: true })
    await mkdir(secondDir, { recursive: true })
    await writeFile(firstPath, JSON.stringify({
      source: 'Leaguepedia Cargo ScoreboardGames',
      fetchedAt: '2026-06-29T00:00:00.000Z',
      matches: [{ id: 'game-1', winner: 'Blue' }],
    }))
    await writeFile(secondPath, JSON.stringify({
      source: 'Leaguepedia Cargo ScoreboardGames',
      fetchedAt: '2026-06-29T01:00:00.000Z',
      matches: [{ id: 'game-1', winner: 'Blue' }],
    }))

    const first = await createSourceFingerprint(manifest(firstPath, '2026-06-29T00:00:00.000Z'))
    const second = await createSourceFingerprint(manifest(secondPath, '2026-06-29T01:00:00.000Z'))

    assert.equal(first.fingerprint, second.fingerprint)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('rolling refresh requires a Leaguepedia file covering the bootstrap start', () => {
  const source = { sources: { leaguepedia: { status: 'downloaded' } } }
  assert.equal(manifestHasBootstrapCoverage({
    ...source,
    files: { leaguepediaJson: ['leaguepedia/scoreboard-games-2026-07-04_to_2026-07-11.json'] },
  }, '2025-01-01'), false)
  assert.equal(manifestHasBootstrapCoverage({
    ...source,
    files: { leaguepediaJson: ['leaguepedia/scoreboard-games-2025-01-01_to_2026-07-11.json'] },
  }, '2025-01-01'), true)
  assert.equal(manifestHasBootstrapCoverage({
    sources: { leaguepedia: { status: 'skipped' } },
    files: { leaguepediaJson: [] },
  }, '2025-01-01'), true)
})

test('source fingerprint separates provider health noise from ranking content', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-health-fingerprint-'))
  const sourcePath = join(tempDir, 'leaguepedia.json')

  try {
    await writeFile(sourcePath, JSON.stringify({ matches: [{ id: 'game-1', winner: 'Blue' }] }))
    const healthyManifest = manifest(sourcePath)
    const degradedManifest = {
      ...healthyManifest,
      sources: {
        ...healthyManifest.sources,
        oracle: { ...healthyManifest.sources.oracle, status: 'failed', failedCount: 1 },
      },
      warnings: ['Oracle download returned HTML (Google Drive - Quota exceeded).'],
    }

    const healthy = await createSourceFingerprint(healthyManifest)
    const degraded = await createSourceFingerprint(degradedManifest)

    assert.equal(healthy.fingerprint, degraded.fingerprint)
    assert.notEqual(healthy.healthFingerprint, degraded.healthFingerprint)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('provider status uses explicit provider outcomes rather than warnings', () => {
  assert.equal(sourceProviderResult({
    sources: { oracle: { status: 'skipped' }, leaguepedia: { status: 'no-data', failedThisRun: 0 } },
    warnings: ['Informational warning: optional provider was skipped'],
  }).status, 'no-data')
  assert.equal(sourceProviderResult({
    sources: { oracle: { status: 'downloaded', failedThisRun: 0 } },
    warnings: ['Informational warning about partial schedule metadata'],
  }, 'available').status, 'available')
  assert.equal(sourceProviderResult({
    sources: { oracle: { status: 'downloaded', failedThisRun: 1 } },
    warnings: [],
  }).status, 'unavailable')
})

test('non-zero provider output must satisfy the complete outage manifest contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lol-ranking-invalid-outage-manifest-'))
  const mutations: Array<[string, (manifest: Record<string, unknown>) => void]> = [
    ['coverage date', (manifest) => { manifest.start = 'not-a-date' }],
    ['file group', (manifest) => {
      const files = manifest.files as Record<string, unknown>
      files.oracleCsv = 'not-an-array'
    }],
    ['escaping path', (manifest) => {
      const files = manifest.files as Record<string, unknown>
      files.lolEsportsJson = ['../outside.json']
    }],
    ['missing source record', (manifest) => {
      const sources = manifest.sources as Record<string, unknown>
      delete sources.lolesports
    }],
    ['failure count', (manifest) => {
      const sources = manifest.sources as Record<string, Record<string, unknown>>
      sources.oracle.failedThisRun = -1
    }],
    ['status consistency', (manifest) => {
      const sources = manifest.sources as Record<string, Record<string, unknown>>
      sources.oracle.status = 'downloaded'
    }],
    ['warnings', (manifest) => { manifest.warnings = [42] }],
    ['fetch telemetry retries', (manifest) => {
      const telemetry = manifest.fetchTelemetry as Record<string, unknown>
      telemetry.retries = 'not-an-array'
    }],
    ['fetch telemetry attempts', (manifest) => {
      const telemetry = manifest.fetchTelemetry as Record<string, unknown>
      telemetry.attempts = 'not-an-array'
    }],
    ['fetch telemetry retry count', (manifest) => {
      const telemetry = manifest.fetchTelemetry as Record<string, unknown>
      telemetry.retries = []
      telemetry.retryCount = 1
    }],
  ]
  try {
    for (const [name, mutate] of mutations) {
      const caseRoot = join(root, name.replaceAll(' ', '-'))
      await assert.rejects(refreshDataIfChanged([
        '--raw-dir', join(caseRoot, 'raw'),
        '--manifest', join(caseRoot, 'raw', 'manifest.json'),
        '--state', join(caseRoot, 'state.json'),
        '--staging-dir', join(caseRoot, 'staging'),
        '--start', '2026-07-02',
        '--end', '2026-07-09',
        '--skip-crunch',
        '--skip-bucket-upload',
      ], {
        env: isolatedRefreshEnv,
        run: async (_command, args) => {
          const outputManifest = valueAfter(args, '--manifest')
          const manifest = strictDownloaderOutageManifest('2026-07-02', '2026-07-09')
          mutate(manifest)
          await writeFile(outputManifest, JSON.stringify(manifest))
          throw new Error(`provider-command-failure:${name}`)
        },
      }), new RegExp(`provider-command-failure:${name}`))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('refresh wrapper skips crunch when staged source digest is unchanged', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-refresh-'))
  const rawDir = join(tempDir, 'raw')
  const manifestPath = join(rawDir, 'manifest.json')
  const statePath = join(rawDir, 'refresh-state.json')
  const stagingDir = join(tempDir, 'staging')
  let downloadCount = 0
  let crunchCount = 0

  async function fakeRun(command: string, commandArgs: string[]) {
    if (commandArgs.includes('scripts/download-local-data.mjs')) {
      downloadCount += 1
      const outDir = valueAfter(commandArgs, '--out-dir')
      const nextManifestPath = valueAfter(commandArgs, '--manifest')
      if (downloadCount === 4) {
        await writeFile(nextManifestPath, `${JSON.stringify({
          schemaVersion: 1,
          start: '2026-01-01',
          end: '2026-06-29',
          files: { leaguepediaJson: [], oracleCsv: [], lolEsportsJson: [] },
          sources: {
            leaguepedia: { role: 'backup-gap-fill', status: 'failed', failedCount: 1 },
            oracle: { role: 'primary', status: 'failed', failedCount: 1 },
          },
          warnings: ['All current match providers are unavailable.'],
        })}\n`)
        return
      }
      const leaguepediaPath = join(outDir, 'leaguepedia', 'scoreboard-games.json')
      await mkdir(join(outDir, 'leaguepedia'), { recursive: true })
      await writeFile(leaguepediaPath, JSON.stringify({
        source: 'Leaguepedia Cargo ScoreboardGames',
        fetchedAt: `2026-06-29T0${downloadCount}:00:00.000Z`,
        matches: [{ id: 'game-1', winner: downloadCount >= 3 ? 'Red' : 'Blue' }],
      }))
      const nextManifest = {
        ...manifest(leaguepediaPath),
        warnings: [] as string[],
      }
      if (downloadCount === 2) {
        nextManifest.sources.oracle = {
          ...nextManifest.sources.oracle,
          status: 'failed',
          downloadedCount: 0,
        }
        nextManifest.warnings = ['Oracle provider health changed without changing ranking content.']
      }
      await writeFile(nextManifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`)
      return
    }

    if (command === 'pnpm' && commandArgs.includes('scripts/build-static-snapshot.ts')) {
      crunchCount += 1
      return
    }

    throw new Error(`Unexpected command: ${command} ${commandArgs.join(' ')}`)
  }

  try {
    const first = await refreshDataIfChanged([
      '--raw-dir',
      rawDir,
      '--manifest',
      manifestPath,
      '--state',
      statePath,
      '--staging-dir',
      stagingDir,
      '--output',
      join(tempDir, 'derived.json'),
      '--public-data-dir',
      join(tempDir, 'public-data'),
      '--end',
      '2026-06-29',
    ], { run: fakeRun, env: isolatedRefreshEnv })
    const second = await refreshDataIfChanged([
      '--raw-dir',
      rawDir,
      '--manifest',
      manifestPath,
      '--state',
      statePath,
      '--staging-dir',
      stagingDir,
      '--output',
      join(tempDir, 'derived.json'),
      '--public-data-dir',
      join(tempDir, 'public-data'),
      '--end',
      '2026-06-29',
    ], { run: fakeRun, env: isolatedRefreshEnv })
    const unchangedState = JSON.parse(await readFile(statePath, 'utf8'))
    const third = await refreshDataIfChanged([
      '--raw-dir',
      rawDir,
      '--manifest',
      manifestPath,
      '--state',
      statePath,
      '--staging-dir',
      stagingDir,
      '--output',
      join(tempDir, 'derived.json'),
      '--public-data-dir',
      join(tempDir, 'public-data'),
      '--end',
      '2026-06-29',
    ], { run: fakeRun, env: isolatedRefreshEnv })
    const fourth = await refreshDataIfChanged([
      '--raw-dir', rawDir,
      '--manifest', manifestPath,
      '--state', statePath,
      '--staging-dir', stagingDir,
      '--output', join(tempDir, 'derived.json'),
      '--public-data-dir', join(tempDir, 'public-data'),
      '--end', '2026-06-29',
    ], { run: fakeRun, env: isolatedRefreshEnv })
    const outageState = JSON.parse(await readFile(statePath, 'utf8'))
    const fifth = await refreshDataIfChanged([
      '--raw-dir', rawDir,
      '--manifest', manifestPath,
      '--state', statePath,
      '--staging-dir', stagingDir,
      '--output', join(tempDir, 'derived.json'),
      '--public-data-dir', join(tempDir, 'public-data'),
      '--end', '2026-06-29',
    ], { run: fakeRun, env: isolatedRefreshEnv })

    assert.equal(first.changed, true)
    assert.equal(second.changed, false)
    assert.equal(third.changed, true)
    assert.equal(fourth.status, 'stale-source')
    assert.equal(fifth.changed, false)
    assert.equal(typeof first.healthFingerprint, 'string')
    assert.equal(typeof second.healthFingerprint, 'string')
    assert.notEqual(first.healthFingerprint, second.healthFingerprint)
    assert.notEqual(second.fingerprint, third.fingerprint)
    assert.equal(crunchCount, 2)
    assert.equal(outageState.fingerprint, third.fingerprint)
    assert.equal(unchangedState.status, 'unchanged')
    assert.equal(unchangedState.lastRun.result, 'unchanged')
    assert.equal(unchangedState.lastRun.freshness.publishedAt, null)
    assert.equal(outageState.lastRun.result, 'stale-source')
    assert.equal(outageState.lastRun.freshness.publishedAt, null)
    assert.deepEqual(unchangedState.warnings, ['Oracle provider health changed without changing ranking content.'])
    assert.deepEqual(unchangedState.publish, { skipped: true, reason: 'unchanged-source-data' })
    assert.match(await readFile(manifestPath, 'utf8'), new RegExp(escapeRegExp(rawDir)))
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    assert.equal(state.status, 'unchanged')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('refresh date window bootstraps without raw baseline and then uses rolling lookback', () => {
  assert.deepEqual(refreshDateWindow({
    args: { lookbackDays: '7' },
    env: { RANKING_REFRESH_BOOTSTRAP_START: '2025-01-01' },
    end: '2026-06-29',
    hasExistingRawBaseline: false,
  }), {
    start: '2025-01-01',
    end: '2026-06-29',
    lookbackDays: 7,
    bootstrapStart: '2025-01-01',
    mode: 'bootstrap',
  })

  assert.deepEqual(refreshDateWindow({
    args: { lookbackDays: '7' },
    env: { RANKING_REFRESH_BOOTSTRAP_START: '2025-01-01' },
    end: '2026-06-29',
    hasExistingRawBaseline: true,
  }), {
    start: '2026-06-22',
    end: '2026-06-29',
    lookbackDays: 7,
    bootstrapStart: '2025-01-01',
    mode: 'lookback',
  })
})

test('refresh wrapper ignores legacy unverified bucket raw files when bootstrapping', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-injected-restore-'))
  const rawDir = join(tempDir, 'raw')
  const manifestPath = join(rawDir, 'manifest.json')
  const statePath = join(rawDir, 'refresh-state.json')
  const stagingDir = join(tempDir, 'staging')
  const restoredOracle = 'gameid,result\nrestored,1\n'
  const restoredLeaguepedia = '{"matches":[]}\n'
  const restoredManifest = JSON.stringify({
    ...manifest('oracles-elixir/2025.csv'),
    start: '2025-01-01',
    end: '2026-06-21',
    files: {
      leaguepediaJson: ['leaguepedia/scoreboard-games-2025-01-01_to_2026-06-21.json'],
      oracleCsv: ['oracles-elixir/2025.csv'],
    },
  })
  const calls: Array<Record<string, unknown>> = []
  const client = {
    async send(command: { input: Record<string, unknown> }) {
      calls.push(command.input)
      if (command.input.Key === 'rankings/active-generation.json') {
        const error = new Error('NoSuchKey')
        error.name = 'NoSuchKey'
        throw error
      }
      if (command.input.Prefix === 'rankings/raw/files/') {
        return {
          Contents: [
            {
              Key: 'rankings/raw/files/oracles-elixir/2025.csv',
              Size: Buffer.byteLength(restoredOracle),
            },
            {
              Key: 'rankings/raw/files/leaguepedia/scoreboard-games-2025-01-01_to_2026-06-21.json',
              Size: Buffer.byteLength(restoredLeaguepedia),
            },
          ],
        }
      }
      if (command.input.Key === 'rankings/raw/files/oracles-elixir/2025.csv') {
        return { Body: Readable.from([restoredOracle]) }
      }
      if (command.input.Key === 'rankings/raw/files/leaguepedia/scoreboard-games-2025-01-01_to_2026-06-21.json') {
        return { Body: Readable.from([restoredLeaguepedia]) }
      }
      if (command.input.Key === 'rankings/raw/manifest.json') {
        return { Body: Readable.from([restoredManifest]), ContentLength: Buffer.byteLength(restoredManifest) }
      }
      if (command.input.Key === 'rankings/raw/refresh-state.json') {
        return { Body: Readable.from(['{"fingerprint":"restored"}']), ContentLength: 26 }
      }
      throw new Error(`Unexpected bucket command: ${JSON.stringify(command.input)}`)
    },
  }
  let downloadStart = ''

  async function fakeRun(command: string, commandArgs: string[]) {
    if (!commandArgs.includes('scripts/download-local-data.mjs')) {
      throw new Error(`Unexpected command: ${command} ${commandArgs.join(' ')}`)
    }
    downloadStart = valueAfter(commandArgs, '--start')
    const outDir = valueAfter(commandArgs, '--out-dir')
    const nextManifestPath = valueAfter(commandArgs, '--manifest')
    const nextOraclePath = join(outDir, 'oracles-elixir', '2026.csv')
    await mkdir(join(outDir, 'oracles-elixir'), { recursive: true })
    await writeFile(nextOraclePath, 'gameid,result\ncurrent,1\n')
    await writeFile(nextManifestPath, `${JSON.stringify({
      ...manifest(nextOraclePath),
      start: '2026-06-22',
      end: '2026-06-29',
      files: { leaguepediaJson: [], oracleCsv: [nextOraclePath] },
    })}\n`)
  }

  try {
    await refreshDataIfChanged([
      '--raw-dir', rawDir,
      '--manifest', manifestPath,
      '--state', statePath,
      '--staging-dir', stagingDir,
      '--lookback-days', '7',
      '--end', '2026-06-29',
      '--skip-crunch',
    ], {
      run: fakeRun,
      bucketClient: client,
      bucketConfig: bucketConfig(),
      env: {
        RANKING_BUCKET_RESTORE_RAW: 'true',
        RANKING_REFRESH_BOOTSTRAP_START: '2025-01-01',
      },
    })

    assert.equal(downloadStart, '2025-01-01')
    await assert.rejects(readFile(join(rawDir, 'oracles-elixir', '2025.csv')), { code: 'ENOENT' })
    assert.equal(calls.some((input) => input.Prefix === 'rankings/raw/files/'), false)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('verified startup restore honors a custom manifest path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lol-ranking-custom-manifest-restore-'))
  const rawDir = join(root, 'raw')
  const manifestPath = join(root, 'authority', 'custom-manifest.json')
  const statePath = join(root, 'state.json')
  const stagingDir = join(root, 'staging')
  const baseline = prepareOracleBaseline({
    csv: 'gameid,date,league,side\nrestored,2026-06-20,LCK,Blue\nrestored,2026-06-20,LCK,Red\n',
    sourceFileName: '2026.csv',
    importerVersion: 'community-source-import-v1',
  })
  const preparedReceipt = prepareRawSourceReceipt({
    generationId: 'raw_custom_manifest_restore',
    importerVersion: 'community-source-import-v1',
    coverage: { start: '2025-01-01', end: '2026-06-21' },
    sourceReceiptInputs: { sources: { oracle: { status: 'downloaded' } } },
    oracle: [{
      sourceFileName: baseline.source.sourceFileName,
      headerDigest: baseline.source.headerDigest,
      digestScheme: ORACLE_GAME_INVENTORY_DIGEST_SCHEME,
      effectiveOracleDigest: baseline.source.digest,
      gameInventory: oracleGameInventory(baseline.source),
      baseline: baseline.reference,
      deltas: [],
    }],
  })
  const receiptReference = rawObjectReferenceFor(preparedReceipt.prepared)
  const objects = new Map<string, Pick<PreparedRawObject, 'compressed' | 'compressedBytes' | 'digest' | 'bytes'>>()
  objects.set(baseline.reference.key, baseline.prepared)
  objects.set(receiptReference.key, preparedReceipt.prepared)
  let parentObjectResolutions = 0
  const readRawAuthority = async () => ({
    found: true,
    receipt: preparedReceipt.receipt,
    receiptReference,
    objectResolver: async () => {
      parentObjectResolutions += 1
      throw new Error('Parent must not reconstruct raw authority objects')
    },
    streamObjectToFile: async (reference: { key: string }, destinationPath: string) => {
      const prepared = objects.get(reference.key)
      if (!prepared) throw new Error(`Missing fixture object ${reference.key}`)
      await writeFile(destinationPath, prepared.compressed)
    },
  })
  const client = {
    async send(command: { input: Record<string, unknown> }) {
      const key = String(command.input.Key)
      if (key === 'rankings/active-generation.json') {
        return { Body: Readable.from([JSON.stringify({
          generationId: preparedReceipt.receipt.generationId,
          storageMode: 'raw-authority-test',
          rawReceiptKey: `rankings/${receiptReference.key}`,
          rawReceiptDigest: receiptReference.sha256,
          rawReceiptBytes: receiptReference.bytes,
          rawReceiptCompressedBytes: receiptReference.compressedBytes,
          sourceReceiptDigest: preparedReceipt.receipt.sourceReceiptDigest,
          rawIdentityDigest: preparedReceipt.receipt.rawIdentityDigest,
        })]) }
      }
      const prepared = objects.get(key.replace(/^rankings\//, ''))
      if (prepared) {
        return {
          Body: Readable.from([prepared.compressed]),
          ContentLength: prepared.compressedBytes,
          ContentEncoding: 'gzip',
          Metadata: { sha256: prepared.digest, 'semantic-bytes': String(prepared.bytes), encoding: 'gzip' },
        }
      }
      const error = new Error('NoSuchKey')
      error.name = 'NoSuchKey'
      throw error
    },
  }
  let downloadStart = ''
  try {
    await refreshDataIfChanged([
      '--raw-dir', rawDir,
      '--manifest', manifestPath,
      '--state', statePath,
      '--staging-dir', stagingDir,
      '--lookback-days', '7',
      '--end', '2026-06-29',
      '--skip-crunch',
    ], {
      bucketClient: client,
      bucketConfig: bucketConfig(),
      env: { RANKING_BUCKET_RESTORE_RAW: 'true', RANKING_BUCKET_UPLOAD_ENABLED: 'false' },
      readActiveRawSourceAuthority: readRawAuthority,
      run: async (_command, args) => {
        downloadStart = valueAfter(args, '--start')
        const outDir = valueAfter(args, '--out-dir')
        const outputManifest = valueAfter(args, '--manifest')
        const sourcePath = join(outDir, 'oracles-elixir', 'current.csv')
        await mkdir(join(outDir, 'oracles-elixir'), { recursive: true })
        await writeFile(sourcePath, 'gameid,date,league,side\ncurrent,2026-06-29,LCK,Blue\ncurrent,2026-06-29,LCK,Red\n')
        await writeFile(outputManifest, JSON.stringify({
          schemaVersion: 1,
          generatedAt: '2026-06-29T00:00:00.000Z',
          start: '2026-06-22',
          end: '2026-06-29',
          files: { oracleCsv: [sourcePath], leaguepediaJson: [], lolEsportsJson: [] },
          sources: { oracle: { status: 'downloaded', downloadedCount: 1 } },
          warnings: [],
        }))
      },
    })
    assert.equal(downloadStart, '2026-06-22')
    assert.equal(parentObjectResolutions, 0)
    const restoredState = JSON.parse(await readFile(statePath, 'utf8'))
    const restoreStage = restoredState.lastRun.stages.find((stage: { name: string }) => stage.name === 'restore')
    assert.equal(restoreStage.result, 'completed')
    assert.equal(restoreStage.output.objectCount, 1)
    assert.equal(restoreStage.output.sourceReceiptDigest, preparedReceipt.receipt.sourceReceiptDigest)
    const customManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.equal(customManifest.start, '2025-01-01')
    assert.equal(customManifest.files.oracleCsv.some((path: string) => path.endsWith('/2026.csv')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('refresh wrapper merges rolling downloads into existing raw baseline', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-rolling-refresh-'))
  const rawDir = join(tempDir, 'raw')
  const manifestPath = join(rawDir, 'manifest.json')
  const statePath = join(rawDir, 'refresh-state.json')
  const stagingDir = join(tempDir, 'staging')
  const previousOraclePath = join(rawDir, 'oracles-elixir', '2025.csv')
  let downloadStart = ''
  let crunchCount = 0

  async function fakeRun(command: string, commandArgs: string[]) {
    if (commandArgs.includes('scripts/download-local-data.mjs')) {
      downloadStart = valueAfter(commandArgs, '--start')
      const outDir = valueAfter(commandArgs, '--out-dir')
      const nextManifestPath = valueAfter(commandArgs, '--manifest')
      const nextOraclePath = join(outDir, 'oracles-elixir', '2026.csv')
      await mkdir(join(outDir, 'oracles-elixir'), { recursive: true })
      await writeFile(nextOraclePath, 'gameid,result\nnew,1\n')
      await writeFile(nextManifestPath, `${JSON.stringify({
        ...manifest(nextOraclePath),
        start: '2026-06-22',
        end: '2026-06-29',
        files: {
          leaguepediaJson: [],
          oracleCsv: [nextOraclePath],
        },
        sources: {
          oracle: {
            role: 'primary',
            status: 'downloaded',
            downloadedCount: 1,
          },
        },
      }, null, 2)}\n`)
      return
    }

    if (command === 'pnpm' && commandArgs.includes('scripts/build-static-snapshot.ts')) {
      crunchCount += 1
      return
    }

    throw new Error(`Unexpected command: ${command} ${commandArgs.join(' ')}`)
  }

  try {
    await mkdir(join(rawDir, 'oracles-elixir'), { recursive: true })
    await writeFile(previousOraclePath, 'gameid,result\nold,1\n')
    await writeFile(manifestPath, `${JSON.stringify({
      ...manifest(previousOraclePath),
      start: '2025-01-01',
      end: '2026-06-21',
      files: {
        leaguepediaJson: [],
        oracleCsv: [previousOraclePath],
      },
      sources: {
        oracle: {
          role: 'primary',
          status: 'failed',
          failedCount: 1,
        },
      },
      warnings: ['Oracle source 2026.csv failed during the previous refresh.'],
    }, null, 2)}\n`)

    const result = await refreshDataIfChanged([
      '--raw-dir',
      rawDir,
      '--manifest',
      manifestPath,
      '--state',
      statePath,
      '--staging-dir',
      stagingDir,
      '--output',
      join(tempDir, 'derived.json'),
      '--public-data-dir',
      join(tempDir, 'public-data'),
      '--lookback-days',
      '7',
      '--end',
      '2026-06-29',
      '--skip-bucket-upload',
    ], { run: fakeRun, env: isolatedRefreshEnv })
    const finalManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const state = JSON.parse(await readFile(statePath, 'utf8'))

    assert.equal(result.changed, true)
    assert.equal(downloadStart, '2026-06-22')
    assert.equal(crunchCount, 1)
    assert.equal(finalManifest.start, '2025-01-01')
    assert.equal(finalManifest.end, '2026-06-29')
    assert.deepEqual(finalManifest.warnings, [])
    assert.equal(finalManifest.sources.oracle.failedCount, undefined)
    assert.equal(finalManifest.sources.oracle.previousStatus, 'failed')
    assert.equal(finalManifest.sources.oracle.latestStatus, 'downloaded')
    assert.deepEqual(finalManifest.files.oracleCsv.sort(), [
      join(rawDir, 'oracles-elixir', '2025.csv'),
      join(rawDir, 'oracles-elixir', '2026.csv'),
    ].sort())
    assert.equal(await readFile(previousOraclePath, 'utf8'), 'gameid,result\nold,1\n')
    assert.equal(state.downloadStart, '2026-06-22')
    assert.equal(state.coverageStart, '2025-01-01')
    assert.equal(state.mergeExistingRaw, true)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('refresh wrapper preserves artifacts when current match sources are unavailable', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-stale-refresh-'))
  const rawDir = join(tempDir, 'raw')
  const manifestPath = join(rawDir, 'manifest.json')
  const statePath = join(rawDir, 'refresh-state.json')
  const stagingDir = join(tempDir, 'staging')
  const previousOraclePath = join(rawDir, 'oracles-elixir', '2026.csv')
  const previousOracleCsv = [
    'gameid,date,year,league,split,playoffs,patch,position,side,teamname,result,kills,totalgold',
    'recovery-game,2026-07-08,2026,LCK,Summer,0,26.13,team,Blue,Gen.G,1,18,65000',
    'recovery-game,2026-07-08,2026,LCK,Summer,0,26.13,team,Red,T1,0,10,58000',
  ].join('\n')
  let crunchCount = 0
  let failAfterManifest = true

  async function fakeRun(command: string, commandArgs: string[]) {
    if (commandArgs.includes('scripts/download-local-data.mjs')) {
      const nextManifestPath = valueAfter(commandArgs, '--manifest')
      await writeFile(nextManifestPath, `${JSON.stringify({
        ...strictDownloaderOutageManifest('2026-07-02', '2026-07-09'),
        warnings: [
          'Oracle source 2026.csv was not downloaded: download returned HTML (Google Drive - Quota exceeded)',
          'Leaguepedia backup download was not completed: HTTP 503 from Leaguepedia Cargo',
        ],
      }, null, 2)}\n`)
      if (failAfterManifest) throw new Error('provider downloader exited non-zero after writing outage manifest')
      return
    }

    if (command === 'pnpm' && commandArgs.includes('scripts/build-static-snapshot.ts')) {
      crunchCount += 1
      return
    }

    throw new Error(`Unexpected command: ${command} ${commandArgs.join(' ')}`)
  }

  try {
    await mkdir(join(rawDir, 'oracles-elixir'), { recursive: true })
    await writeFile(previousOraclePath, previousOracleCsv)
    await writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-07-08T00:00:00.000Z',
      start: '2026-01-01',
      end: '2026-07-08',
      files: {
        leaguepediaJson: [],
        oracleCsv: [previousOraclePath],
      },
      sources: {
        oracle: {
          role: 'primary',
          status: 'downloaded',
          downloadedCount: 1,
        },
      },
      warnings: [],
    }, null, 2)}\n`)
    await writeFile(statePath, `${JSON.stringify({
      schemaVersion: 1,
      fingerprint: 'previous-fingerprint',
      coverageStart: '2026-01-01',
      coverageEnd: '2026-07-08',
    }, null, 2)}\n`)

    const unavailableArgs = [
      '--raw-dir',
      rawDir,
      '--manifest',
      manifestPath,
      '--state',
      statePath,
      '--staging-dir',
      stagingDir,
      '--output',
      join(tempDir, 'derived.json'),
      '--public-data-dir',
      join(tempDir, 'public-data'),
      '--lookback-days',
      '7',
      '--end',
      '2026-07-09',
      '--skip-bucket-upload',
    ]
    const runUnavailable = (force: boolean, recoveryAuthorized: boolean) => refreshDataIfChanged([
      ...unavailableArgs,
      ...(force ? ['--force'] : []),
    ], {
      run: fakeRun,
      env: {
        ...isolatedRefreshEnv,
        ...(recoveryAuthorized ? { RANKING_REUSE_RAW_ON_SOURCE_FAILURE: 'true' } : {}),
      },
    })

    const result = await runUnavailable(false, false)
    failAfterManifest = false
    const finalManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const state = JSON.parse(await readFile(statePath, 'utf8'))

    assert.equal(result.changed, false)
    assert.equal(result.status, 'stale-source')
    assert.equal(result.reason, 'provider-command-failed')
    assert.equal(typeof result.healthFingerprint, 'string')
    assert.equal(crunchCount, 0)
    assert.deepEqual(finalManifest.files.oracleCsv, [previousOraclePath])
    assert.equal(state.status, 'stale-source')
    assert.equal(state.reason, 'provider-command-failed')
    assert.equal(state.coverageEnd, '2026-07-08')
    assert.deepEqual(state.crunch, {
      skipped: true,
      reason: 'provider-command-failed',
    })
    assert.deepEqual(state.publish, {
      skipped: true,
      reason: 'provider-command-failed',
    })
    assert.equal(state.sourceAuthorityEvidence.evidence.outage.reason, 'provider-command-failed')

    for (const [force, recoveryAuthorized] of [[true, false], [false, true]] as const) {
      const rejectedRecovery = await runUnavailable(force, recoveryAuthorized)
      assert.equal(rejectedRecovery.changed, false)
      assert.equal(rejectedRecovery.status, 'stale-source')
      assert.equal(crunchCount, 0)
      const preservedManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      assert.deepEqual(preservedManifest.files.oracleCsv, [previousOraclePath])
      assert.equal(preservedManifest.refreshAttempt, undefined)
    }

    const baseline = prepareOracleBaseline({
      csv: previousOracleCsv,
      sourceFileName: '2026.csv',
      importerVersion: 'community-source-import-v1',
    })
    const preparedReceipt = prepareRawSourceReceipt({
      generationId: 'raw_recovery_generation',
      importerVersion: 'community-source-import-v1',
      coverage: { start: '2026-01-01', end: '2026-07-08' },
      sourceReceiptInputs: { sources: { oracle: { status: 'downloaded' } } },
      oracle: [{
        sourceFileName: baseline.source.sourceFileName,
        headerDigest: baseline.source.headerDigest,
        digestScheme: ORACLE_GAME_INVENTORY_DIGEST_SCHEME,
        effectiveOracleDigest: baseline.source.digest,
        gameInventory: oracleGameInventory(baseline.source),
        baseline: baseline.reference,
        deltas: [],
      }],
    })
    const receiptReference = rawObjectReferenceFor(preparedReceipt.prepared)
    type StoredRawObject = Pick<PreparedRawObject, 'compressed' | 'compressedBytes' | 'digest' | 'bytes'>
    const rawObjects = new Map<string, StoredRawObject>()
    rawObjects.set(baseline.reference.key, baseline.prepared)
    rawObjects.set(receiptReference.key, preparedReceipt.prepared)
    let parentObjectResolutions = 0
    const readRawAuthority = async () => ({
      found: true,
      receipt: preparedReceipt.receipt,
      receiptReference,
      objectResolver: async () => {
        parentObjectResolutions += 1
        throw new Error('Parent must not reconstruct raw authority objects')
      },
      streamObjectToFile: async (reference: { key: string }, destinationPath: string) => {
        const prepared = rawObjects.get(reference.key)
        if (!prepared) throw new Error(`Missing fixture object ${reference.key}`)
        await writeFile(destinationPath, prepared.compressed)
      },
    })
    const verifiedBucketClient = {
      async send(command: { input: Record<string, unknown> }) {
        const key = String(command.input.Key)
        if (key === 'rankings/active-generation.json') {
          const active = {
            generationId: preparedReceipt.receipt.generationId,
            storageMode: 'raw-authority-test',
            rawReceiptKey: `rankings/${receiptReference.key}`,
            rawReceiptDigest: receiptReference.sha256,
            rawReceiptBytes: receiptReference.bytes,
            rawReceiptCompressedBytes: receiptReference.compressedBytes,
            sourceReceiptDigest: preparedReceipt.receipt.sourceReceiptDigest,
            rawIdentityDigest: preparedReceipt.receipt.rawIdentityDigest,
          }
          return { Body: Readable.from([JSON.stringify(active)]) }
        }
        const relativeKey = key.replace(/^rankings\//, '')
        const prepared = rawObjects.get(relativeKey)
        if (prepared) {
          return {
            Body: Readable.from([prepared.compressed]),
            ContentLength: prepared.compressedBytes,
            ContentEncoding: 'gzip',
            Metadata: {
              sha256: prepared.digest,
              'semantic-bytes': String(prepared.bytes),
              encoding: 'gzip',
            },
          }
        }
        const error = new Error('NoSuchKey')
        error.name = 'NoSuchKey'
        throw error
      },
    }
    const verifiedRecovery = await refreshDataIfChanged([
      ...unavailableArgs,
      '--force',
    ], {
      run: fakeRun,
      bucketClient: verifiedBucketClient,
      bucketConfig: bucketConfig(),
      readActiveRawSourceAuthority: readRawAuthority,
      env: {
        ...isolatedRefreshEnv,
        RANKING_REUSE_RAW_ON_SOURCE_FAILURE: 'true',
        RANKING_FORCE_REFRESH: 'true',
        RANKING_REFRESH_FENCING_TOKEN: '7',
      },
    })
    const rebuiltManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const rebuiltState = JSON.parse(await readFile(statePath, 'utf8'))

    assert.equal(verifiedRecovery.changed, true)
    assert.equal(rebuiltManifest.refreshAttempt.forcedVerifiedRawRecovery, true)
    assert.equal(rebuiltManifest.refreshAttempt.restoredGenerationId, preparedReceipt.receipt.generationId)
    assert.equal(rebuiltManifest.sourceAuthorityEvidence.evidence.mode, 'forced-verified-raw-recovery')
    assert.equal(
      rebuiltManifest.sourceAuthorityEvidence.evidence.authority.sourceReceiptDigest,
      preparedReceipt.receipt.sourceReceiptDigest,
    )
    assert.equal(rebuiltState.status, 'refreshed')
    assert.equal(rebuiltState.coverageEnd, '2026-07-08')
    assert.equal(verifiedRecovery.incrementalAction, 'publish-full')
    assert.equal(verifiedRecovery.incrementalMetrics?.classification, 'full-invalidation')
    assert.equal(verifiedRecovery.incrementalMetrics?.fullSnapshotWritten, true)
    assert.equal(parentObjectResolutions, 0)
    const recoveryValidation = rebuiltState.lastRun.stages.find(
      (stage: { name: string }) => stage.name === 'raw-recovery-validation',
    )
    assert.equal(recoveryValidation.result, 'completed')
    assert.equal(recoveryValidation.output.generationId, preparedReceipt.receipt.generationId)
    assert.equal(recoveryValidation.output.sourceReceiptDigest, preparedReceipt.receipt.sourceReceiptDigest)
    assert.equal(recoveryValidation.output.rawIdentityDigest, preparedReceipt.receipt.rawIdentityDigest)
    assert.equal(recoveryValidation.output.receiptDigest, receiptReference.sha256)
    assert.equal(recoveryValidation.output.objectCount, 1)
    assert.ok(recoveryValidation.output.childMaxRssBytes > 0)

    await rm(previousOraclePath)
    const missingPriorRaw = await runUnavailable(true, true)
    assert.equal(missingPriorRaw.changed, false)
    assert.equal(missingPriorRaw.status, 'stale-source')
    assert.equal(missingPriorRaw.incrementalAction, undefined)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('refresh wrapper warns when previous Oracle raw data is preserved for a fallback-only refresh', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-preserved-refresh-'))
  const rawDir = join(tempDir, 'raw')
  const manifestPath = join(rawDir, 'manifest.json')
  const statePath = join(rawDir, 'refresh-state.json')
  const stagingDir = join(tempDir, 'staging')
  const previousOraclePath = join(rawDir, 'oracles-elixir', '2025.csv')
  let crunchCount = 0

  async function fakeRun(command: string, commandArgs: string[]) {
    if (commandArgs.includes('scripts/download-local-data.mjs')) {
      const outDir = valueAfter(commandArgs, '--out-dir')
      const nextManifestPath = valueAfter(commandArgs, '--manifest')
      const leaguepediaPath = join(outDir, 'leaguepedia', 'scoreboard-games.json')
      await mkdir(join(outDir, 'leaguepedia'), { recursive: true })
      await writeFile(leaguepediaPath, JSON.stringify({
        source: 'Leaguepedia Cargo ScoreboardGames',
        fetchedAt: '2026-07-09T00:00:00.000Z',
        matches: [{ id: 'leaguepedia-game-1', winner: 'Blue' }],
      }))
      await writeFile(nextManifestPath, `${JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-07-09T00:00:00.000Z',
        start: '2026-07-02',
        end: '2026-07-09',
        files: {
          leaguepediaJson: [leaguepediaPath],
          oracleCsv: [],
        },
        sources: {
          leaguepedia: {
            role: 'backup-gap-fill',
            status: 'downloaded',
            downloadedCount: 1,
          },
          oracle: {
            role: 'primary',
            status: 'failed',
            downloadedCount: 0,
            failedCount: 1,
          },
        },
        warnings: [
          'Oracle source 2026.csv was not downloaded: download returned HTML (Google Drive - Quota exceeded)',
        ],
      }, null, 2)}\n`)
      return
    }

    if (command === 'pnpm' && commandArgs.includes('scripts/build-static-snapshot.ts')) {
      crunchCount += 1
      return
    }

    throw new Error(`Unexpected command: ${command} ${commandArgs.join(' ')}`)
  }

  try {
    await mkdir(join(rawDir, 'oracles-elixir'), { recursive: true })
    await writeFile(previousOraclePath, 'gameid,result\nold,1\n')
    await writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-07-01T00:00:00.000Z',
      start: '2025-01-01',
      end: '2026-07-01',
      files: {
        leaguepediaJson: [],
        oracleCsv: [previousOraclePath],
      },
      sources: {
        oracle: {
          role: 'primary',
          status: 'downloaded',
          downloadedCount: 1,
        },
      },
      warnings: [],
    }, null, 2)}\n`)

    const result = await refreshDataIfChanged([
      '--raw-dir',
      rawDir,
      '--manifest',
      manifestPath,
      '--state',
      statePath,
      '--staging-dir',
      stagingDir,
      '--output',
      join(tempDir, 'derived.json'),
      '--public-data-dir',
      join(tempDir, 'public-data'),
      '--lookback-days',
      '7',
      '--end',
      '2026-07-09',
      '--skip-bucket-upload',
    ], { run: fakeRun, env: isolatedRefreshEnv })
    const finalManifest = JSON.parse(await readFile(manifestPath, 'utf8'))

    assert.equal(result.changed, true)
    assert.equal(crunchCount, 1)
    assert.deepEqual(finalManifest.files.oracleCsv, [previousOraclePath])
    assert.match(finalManifest.warnings.join('\n'), /Oracle source preserved from previous raw baseline/)
    assert.match(finalManifest.warnings.join('\n'), /download returned HTML \(Google Drive - Quota exceeded\)/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('refresh wrapper bootstraps when manifest exists but raw files are missing', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-missing-raw-refresh-'))
  const rawDir = join(tempDir, 'raw')
  const manifestPath = join(rawDir, 'manifest.json')
  const statePath = join(rawDir, 'refresh-state.json')
  const stagingDir = join(tempDir, 'staging')
  const missingOraclePath = join(rawDir, 'oracles-elixir', '2025.csv')
  let downloadStart = ''

  async function fakeRun(command: string, commandArgs: string[]) {
    if (commandArgs.includes('scripts/download-local-data.mjs')) {
      downloadStart = valueAfter(commandArgs, '--start')
      const outDir = valueAfter(commandArgs, '--out-dir')
      const nextManifestPath = valueAfter(commandArgs, '--manifest')
      const nextOraclePath = join(outDir, 'oracles-elixir', '2026.csv')
      await mkdir(join(outDir, 'oracles-elixir'), { recursive: true })
      await writeFile(nextOraclePath, 'gameid,result\nnew,1\n')
      await writeFile(nextManifestPath, `${JSON.stringify({
        ...manifest(nextOraclePath),
        start: '2025-01-01',
        end: '2026-06-29',
        files: {
          leaguepediaJson: [],
          oracleCsv: [nextOraclePath],
        },
      }, null, 2)}\n`)
      return
    }

    if (command === 'pnpm' && commandArgs.includes('scripts/build-static-snapshot.ts')) return
    throw new Error(`Unexpected command: ${command} ${commandArgs.join(' ')}`)
  }

  try {
    await mkdir(rawDir, { recursive: true })
    await writeFile(manifestPath, `${JSON.stringify({
      ...manifest(missingOraclePath),
      start: '2025-01-01',
      end: '2026-06-21',
      files: {
        leaguepediaJson: [],
        oracleCsv: [missingOraclePath],
      },
    }, null, 2)}\n`)

    await refreshDataIfChanged([
      '--raw-dir',
      rawDir,
      '--manifest',
      manifestPath,
      '--state',
      statePath,
      '--staging-dir',
      stagingDir,
      '--output',
      join(tempDir, 'derived.json'),
      '--public-data-dir',
      join(tempDir, 'public-data'),
      '--lookback-days',
      '7',
      '--end',
      '2026-06-29',
      '--skip-bucket-upload',
    ], {
      run: fakeRun,
      env: {
        ...isolatedRefreshEnv,
        RANKING_REFRESH_BOOTSTRAP_START: '2025-01-01',
      },
    })
    const state = JSON.parse(await readFile(statePath, 'utf8'))

    assert.equal(downloadStart, '2025-01-01')
    assert.equal(state.mergeExistingRaw, false)
    assert.equal(state.coverageStart, '2025-01-01')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('refresh wrapper uploads refresh state after bucket publish metadata is attached', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-state-upload-'))
  const rawDir = join(tempDir, 'raw')
  const manifestPath = join(rawDir, 'manifest.json')
  const statePath = join(rawDir, 'refresh-state.json')
  const stagingDir = join(tempDir, 'staging')
  const publicDataDir = join(tempDir, 'public-data')
  const output = join(tempDir, 'derived', 'ranking-snapshot.full.json')
  const sent: Array<{ input: { Key: string; Bucket: string; Body?: unknown; ContentType?: string } }> = []
  const client = {
    async send(command: { input: { Key: string; Bucket: string; Body?: unknown; ContentType?: string } }) {
      sent.push({ input: command.input })
      return {}
    },
  }

  async function fakeRun(command: string, commandArgs: string[]) {
    if (commandArgs.includes('scripts/download-local-data.mjs')) {
      const outDir = valueAfter(commandArgs, '--out-dir')
      const nextManifestPath = valueAfter(commandArgs, '--manifest')
      const oraclePath = join(outDir, 'oracles-elixir', '2026.csv')
      await mkdir(join(outDir, 'oracles-elixir'), { recursive: true })
      await writeFile(oraclePath, 'gameid,result\nnew,1\n')
      await writeFile(nextManifestPath, `${JSON.stringify({
        ...manifest(oraclePath),
        files: {
          leaguepediaJson: [],
          oracleCsv: [oraclePath],
        },
      }, null, 2)}\n`)
      return
    }

    if (command === 'pnpm' && commandArgs.includes('scripts/build-static-snapshot.ts')) {
      await mkdir(join(publicDataDir, 'scopes'), { recursive: true })
      await mkdir(join(tempDir, 'derived'), { recursive: true })
      await writeFile(join(publicDataDir, 'ranking-summary.json'), '{}\n')
      await writeFile(join(publicDataDir, 'scopes', 'all.json'), '{}\n')
      await writeFile(output, '{}\n')
      return
    }

    throw new Error(`Unexpected command: ${command} ${commandArgs.join(' ')}`)
  }

  try {
    await refreshDataIfChanged([
      '--raw-dir',
      rawDir,
      '--manifest',
      manifestPath,
      '--state',
      statePath,
      '--staging-dir',
      stagingDir,
      '--output',
      output,
      '--public-data-dir',
      publicDataDir,
      '--end',
      '2026-06-29',
    ], {
      run: fakeRun,
      bucketClient: client,
      env: {
        RANKING_BUCKET_NAME: 'bucket-123',
        RANKING_BUCKET_ENDPOINT: 'https://storage.railway.app',
        RANKING_BUCKET_ACCESS_KEY_ID: 'access-key',
        RANKING_BUCKET_SECRET_ACCESS_KEY: 'secret-key',
        RANKING_BUCKET_PREFIX: 'rankings',
        RANKING_BUCKET_RESTORE_RAW: 'false',
      },
    })

    const uploadedStateBody = sent.find((entry) => entry.input.Key === 'rankings/raw/refresh-state.json')?.input.Body
    assert.equal(typeof uploadedStateBody, 'string')
    const uploadedState = JSON.parse(uploadedStateBody as string)
    const localState = JSON.parse(await readFile(statePath, 'utf8'))

    const { uploadedBytes, ...uploadedBucketWithoutBytes } = uploadedState.bucket
    assert.deepEqual(uploadedBucketWithoutBytes, {
      enabled: true,
      bucket: 'bucket-123',
      prefix: 'rankings',
      artifactCount: 5,
      uploadedCount: 5,
      unchangedCount: 0,
      unchangedBytes: 0,
      skipped: [{
        key: 'rankings/artifacts/latest-full.json',
        reason: 'full-snapshot-upload-disabled',
      }],
    })
    assert.equal(typeof uploadedBytes, 'number')
    assert.equal(uploadedBytes > 0, true)
    assert.deepEqual(localState.bucket, uploadedState.bucket)

    const publishBody = sent.find((entry) => entry.input.Key === 'rankings/latest-publish.json')?.input.Body
    assert.equal(typeof publishBody, 'string')
    assert.equal(JSON.parse(publishBody as string).artifactCount, uploadedState.bucket.uploadedCount)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('bucket publisher skips full audit artifact upload by default', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-bucket-'))
  const publicDataDir = join(tempDir, 'public-data')
  const fullSnapshotPath = join(tempDir, 'derived', 'ranking-snapshot.full.json')
  const manifestPath = join(tempDir, 'raw', 'manifest.json')
  const statePath = join(tempDir, 'raw', 'refresh-state.json')
  const rawOraclePath = join(tempDir, 'raw', 'oracles-elixir', '2026.csv')
  const sent: Array<{ input: { Key: string; Bucket: string; Body?: unknown; ContentType?: string } }> = []
  const client = {
    async send(command: { input: { Key: string; Bucket: string; Body?: unknown; ContentType?: string } }) {
      sent.push({ input: command.input })
      return {}
    },
  }
  const config = bucketConfig()

  try {
    await mkdir(join(publicDataDir, 'scopes'), { recursive: true })
    await mkdir(join(tempDir, 'derived'), { recursive: true })
    await mkdir(join(tempDir, 'raw', 'oracles-elixir'), { recursive: true })
    await writeFile(join(publicDataDir, 'ranking-summary.json'), '{}\n')
    await writeFile(join(publicDataDir, 'scopes', 'all.json'), '{}\n')
    await writeFile(fullSnapshotPath, '{}\n')
    await writeFile(rawOraclePath, 'gameid,result\nnew,1\n')
    await writeFile(manifestPath, `${JSON.stringify({
      files: {
        oracleCsv: [rawOraclePath],
        leaguepediaJson: [],
      },
    })}\n`)
    await writeFile(statePath, '{}\n')

    const result = await uploadRankingArtifacts({
      publicDataDir,
      rawDir: join(tempDir, 'raw'),
      fullSnapshotPath,
      manifestPath,
      statePath,
      config,
      client,
    })
    const keys = sent.filter((entry) => entry.input.Body !== undefined).map((entry) => entry.input.Key).sort()

    assert.equal(result.enabled, true)
    assert.equal(result.uploaded.length, 5)
    assert.equal(result.uploadedCount, result.uploaded.length)
    assert.equal(result.uploadedBytes, result.uploaded.reduce((total, entry) => total + (entry.bytes ?? 0), 0))
    assert.deepEqual(result.skipped, [{
      key: 'rankings/artifacts/latest-full.json',
      reason: 'full-snapshot-upload-disabled',
    }])
    const publicKeys = sent
      .filter((entry) => entry.input.Key.startsWith('rankings/data/'))
      .map((entry) => entry.input.Key)
    assert.deepEqual(publicKeys, [
      'rankings/data/scopes/all.json',
      'rankings/data/ranking-summary.json',
    ])
    assert.deepEqual(keys, [
      'rankings/data/ranking-summary.json',
      'rankings/data/scopes/all.json',
      'rankings/latest-publish.json',
      'rankings/raw/files/oracles-elixir/2026.csv',
      'rankings/raw/manifest.json',
      'rankings/raw/refresh-state.json',
    ])
    assert.equal(sent.every((entry) => entry.input.Bucket === 'bucket-123'), true)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('bucket publish receipt carries refresh telemetry without changing public artifacts', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-receipt-metrics-'))
  const publicDataDir = join(tempDir, 'public-data')
  const sent: Array<{ input: { Key: string; Body?: unknown } }> = []
  const client = {
    async send(command: { input: { Key: string; Body?: unknown } }) {
      sent.push({ input: command.input })
      return {}
    },
  }
  const refreshTelemetry = { schemaVersion: 1, runId: 'refresh-run', stages: [{ name: 'probe', durationMs: 4 }] }
  try {
    await mkdir(publicDataDir, { recursive: true })
    await writeFile(join(publicDataDir, 'ranking-summary.json'), '{}\n')
    await uploadRankingArtifacts({ publicDataDir, config: bucketConfig(), client, refreshTelemetry })
    const publicBody = sent.find((entry) => entry.input.Key === 'rankings/data/ranking-summary.json')?.input.Body
    const receiptBody = sent.find((entry) => entry.input.Key === 'rankings/latest-publish.json')?.input.Body
    assert.equal(await bodyText(publicBody), '{}\n')
    assert.deepEqual(JSON.parse(String(receiptBody)).refreshTelemetry, refreshTelemetry)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('bucket publisher can opt in to full audit artifact upload', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-full-bucket-'))
  const publicDataDir = join(tempDir, 'public-data')
  const fullSnapshotPath = join(tempDir, 'derived', 'ranking-snapshot.full.json')
  const manifestPath = join(tempDir, 'raw', 'manifest.json')
  const statePath = join(tempDir, 'raw', 'refresh-state.json')
  const sent: Array<{ input: { Key: string; Bucket: string; ContentType?: string } }> = []
  const client = {
    async send(command: { input: { Key: string; Bucket: string; ContentType?: string } }) {
      sent.push({ input: command.input })
      return {}
    },
  }

  try {
    await mkdir(publicDataDir, { recursive: true })
    await mkdir(join(tempDir, 'derived'), { recursive: true })
    await mkdir(join(tempDir, 'raw'), { recursive: true })
    await writeFile(join(publicDataDir, 'ranking-summary.json'), '{}\n')
    await writeFile(fullSnapshotPath, '{}\n')
    await writeFile(manifestPath, '{"files":{}}\n')
    await writeFile(statePath, '{}\n')

    const result = await uploadRankingArtifacts({
      publicDataDir,
      fullSnapshotPath,
      manifestPath,
      statePath,
      config: bucketConfig(),
      client,
      uploadFullSnapshot: true,
    })

    assert.equal(result.uploaded.some((entry) => entry.key === 'rankings/artifacts/latest-full.json'), true)
    assert.deepEqual(result.skipped, [])
    assert.equal(sent.some((entry) => entry.input.Key === 'rankings/artifacts/latest-full.json'), true)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('bucket publisher reuses a raw object when SHA-256 metadata and size match', async () => {
  const sync = await runRawSyncCase('matching')

  assert.equal(sync.result.unchanged.length, 1)
  assert.equal(sync.result.unchangedCount, 1)
  assert.equal(sync.result.unchangedBytes, sync.rawBytes)
  assert.equal(sync.rawPut, undefined)
  assert.equal(sync.result.unchanged[0]?.digest, sync.digest)
})

test('bucket publisher uploads same-size raw content when SHA-256 metadata differs', async () => {
  const sync = await runRawSyncCase('mismatch')

  assert.equal(sync.result.unchanged.length, 0)
  assert.ok(sync.rawPut)
  assert.equal(sync.rawPut.Metadata?.sha256, sync.digest)
  assert.equal(sync.rawPut.ContentLength, sync.rawBytes)
})

test('bucket publisher uploads raw content when metadata cannot be verified', async () => {
  const [legacy, failedHead] = await Promise.all([
    runRawSyncCase('legacy'),
    runRawSyncCase('error'),
  ])

  assert.ok(legacy.rawPut)
  assert.ok(failedHead.rawPut)
  assert.equal(legacy.rawPut.Metadata?.sha256, legacy.digest)
  assert.equal(failedHead.rawPut.Metadata?.sha256, failedHead.digest)
})

test('bucket publisher uploads an immutable snapshot when the source changes during PUT', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-raw-mutation-'))
  const publicDataDir = join(tempDir, 'public-data')
  const rawDir = join(tempDir, 'raw')
  const rawOraclePath = join(rawDir, 'oracles-elixir', '2026.csv')
  const manifestPath = join(rawDir, 'manifest.json')
  const rawKey = 'rankings/raw/files/oracles-elixir/2026.csv'
  const originalContent = 'gameid,result\nnew,1\n'
  let uploadedBody: Buffer | undefined
  let uploadedDigest: string | undefined
  const client = {
    async send(command: { input: { Key: string; Body?: unknown; Metadata?: Record<string, string> } }) {
      if (command.input.Key === rawKey && command.input.Body === undefined) {
        return { ContentLength: 0, Metadata: {} }
      }
      if (command.input.Key === rawKey && command.input.Body) {
        await writeFile(rawOraclePath, 'gameid,result\nmutated-record,1\n')
        await new Promise((resolve) => setTimeout(resolve, 25))
        const chunks: Buffer[] = []
        for await (const chunk of command.input.Body as AsyncIterable<Buffer | string>) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }
        uploadedBody = Buffer.concat(chunks)
        uploadedDigest = command.input.Metadata?.sha256
      }
      return {}
    },
  }

  try {
    await mkdir(publicDataDir, { recursive: true })
    await mkdir(join(rawDir, 'oracles-elixir'), { recursive: true })
    await writeFile(join(publicDataDir, 'ranking-summary.json'), '{}\n')
    await writeFile(rawOraclePath, originalContent)
    await writeFile(manifestPath, `${JSON.stringify({ files: { oracleCsv: [rawOraclePath] } })}\n`)

    await uploadRankingArtifacts({
      publicDataDir,
      rawDir,
      manifestPath,
      config: bucketConfig(),
      client,
    })

    assert.equal(uploadedBody?.toString('utf8'), originalContent)
    assert.equal(uploadedDigest, createHash('sha256').update(originalContent).digest('hex'))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('bucket object lookup maps /data paths to the configured prefix', async () => {
  let requestedKey = ''
  const client = {
    async send(command: { input: { Key: string } }) {
      requestedKey = command.input.Key
      return {
        Body: Buffer.from('{}'),
        ContentLength: 2,
        ContentType: 'application/json; charset=utf-8',
      }
    },
  }

  const object = await getBucketObject('ranking-summary.json', {
    config: bucketConfig(),
    client,
  })

  assert.equal(object.found, true)
  assert.equal(requestedKey, 'rankings/data/ranking-summary.json')
  assert.equal(bucketKey(bucketConfig(), '/data//scopes/../ranking-summary.json'), 'rankings/data/ranking-summary.json')
  assert.equal(safeObjectPath('../../data/ranking-summary.json'), 'data/ranking-summary.json')
  assert.equal(safeRequestedObjectPath('scopes/All__%C3%81hugamannadeildin%202025__All.json'), 'scopes/All__%C3%81hugamannadeildin%202025__All.json')
  assert.throws(() => safeRequestedObjectPath('../ranking-summary.json'), /Invalid bucket object path/)
  assert.throws(() => safeRequestedObjectPath('scopes//all.json'), /Invalid bucket object path/)
  assert.throws(() => safeRequestedObjectPath('scopes%2Fall.json'), /Invalid bucket object path/)
})

async function runRawSyncCase(head: 'matching' | 'mismatch' | 'legacy' | 'error') {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-raw-sync-'))
  const publicDataDir = join(tempDir, 'public-data')
  const rawDir = join(tempDir, 'raw')
  const rawOraclePath = join(rawDir, 'oracles-elixir', '2026.csv')
  const manifestPath = join(rawDir, 'manifest.json')
  const rawContent = 'gameid,result\nnew,1\n'
  const rawBytes = Buffer.byteLength(rawContent)
  const digest = createHash('sha256').update(rawContent).digest('hex')
  const sent: Array<{ input: { Key: string; Body?: unknown; ContentLength?: number; Metadata?: Record<string, string> } }> = []
  const rawKey = 'rankings/raw/files/oracles-elixir/2026.csv'
  const client = {
    async send(command: { input: { Key: string; Body?: unknown; ContentLength?: number; Metadata?: Record<string, string> } }) {
      const input = command.input
      sent.push({ input })
      if (input.Key !== rawKey || input.Body !== undefined) return {}
      if (head === 'error') throw new Error('HEAD unavailable')
      if (head === 'legacy') return { ContentLength: rawBytes, Metadata: {} }
      return {
        ContentLength: rawBytes,
        Metadata: { sha256: head === 'matching' ? digest : '0'.repeat(64) },
      }
    },
  }

  try {
    await mkdir(publicDataDir, { recursive: true })
    await mkdir(join(rawDir, 'oracles-elixir'), { recursive: true })
    await writeFile(join(publicDataDir, 'ranking-summary.json'), '{}\n')
    await writeFile(rawOraclePath, rawContent)
    await writeFile(manifestPath, `${JSON.stringify({
      files: {
        oracleCsv: [rawOraclePath],
        leaguepediaJson: [],
      },
    })}\n`)

    const result = await uploadRankingArtifacts({
      publicDataDir,
      rawDir,
      manifestPath,
      config: bucketConfig(),
      client,
    })
    const rawPut = sent.find((entry) => entry.input.Key === rawKey && entry.input.Body !== undefined)?.input
    return { result, rawPut, rawBytes, digest }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

function manifest(leaguepediaPath: string, generatedAt = '2026-06-29T00:00:00.000Z') {
  return {
    schemaVersion: 1,
    generatedAt,
    start: '2026-01-01',
    end: '2026-06-29',
    files: {
      leaguepediaJson: [leaguepediaPath],
      oracleCsv: [],
    },
    sources: {
      leaguepedia: {
        role: 'backup-gap-fill',
        status: 'downloaded',
        downloadedCount: 1,
      },
      oracle: {
        role: 'primary',
        status: 'skipped',
        downloadedCount: 0,
      },
    },
    warnings: [],
  }
}

function valueAfter(args: string[], flag: string) {
  const index = args.indexOf(flag)
  assert.notEqual(index, -1)
  return args[index + 1]
}

function escapeRegExp(value: string) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function bucketConfig() {
  return {
    enabled: true,
    bucket: 'bucket-123',
    endpoint: 'https://storage.railway.app',
    region: 'auto',
    accessKeyId: 'access-key',
    secretAccessKey: 'secret-key',
    prefix: 'rankings',
    forcePathStyle: false,
  }
}

function strictDownloaderOutageManifest(start: string, end: string) {
  const source = (
    role: 'primary' | 'backup-gap-fill' | 'schedule-results-reference',
    failed: boolean,
  ) => ({
    role,
    status: failed ? 'failed' : 'unavailable',
    downloadedCount: 0,
    downloadedThisRun: 0,
    failedCount: failed ? 1 : 0,
    failedThisRun: failed ? 1 : 0,
    failures: failed ? [{ source: `${role} fixture`, error: 'provider unavailable' }] : [],
    skipped: false,
    required: failed,
  })
  return {
    schemaVersion: 1,
    generatedAt: `${end}T00:00:00.000Z`,
    status: 'failed',
    start,
    end,
    files: { leaguepediaJson: [], oracleCsv: [], lolEsportsJson: [] },
    sources: {
      oracle: source('primary', true),
      leaguepedia: source('backup-gap-fill', true),
      lolesports: {
        ...source('schedule-results-reference', false),
        unsupportedApi: true,
      },
    },
    warnings: ['provider unavailable'],
    // This is the aggregate shape emitted by download-local-data.mjs mergeFetchTelemetry.
    fetchTelemetry: { requests: 2, retryCount: 0 },
  }
}

async function bodyText(value: unknown) {
  if (typeof value === 'string') return value
  const chunks: Buffer[] = []
  for await (const chunk of value as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}
