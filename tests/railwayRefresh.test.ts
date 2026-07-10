import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

type RefreshRun = (command: string, commandArgs: string[]) => Promise<void>
type RefreshResult = {
  changed: boolean
  fingerprint?: string
  previousFingerprint?: string
  status?: string
  reason?: string
}
type RefreshWindow = {
  start: string
  end: string
  lookbackDays: number | null
  bootstrapStart: string
  mode: string
}
type RefreshModule = {
  createSourceFingerprint: (manifest: unknown) => Promise<{ fingerprint: string }>
  refreshDataIfChanged: (rawArgs?: string[], options?: {
    run?: RefreshRun
    bucketClient?: BucketClient
  }) => Promise<RefreshResult>
  refreshDateWindow: (options?: {
    args?: Record<string, string | undefined>
    env?: Record<string, string | undefined>
    end?: string
    hasExistingRawBaseline?: boolean
  }) => RefreshWindow
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
  skipped: Array<{ key: string; reason: string }>
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
  }) => Promise<BucketUploadResult>
}

const refreshScriptPath: string = '../scripts/refresh-data-if-changed.mjs'
const bucketScriptPath: string = '../scripts/railway-bucket.mjs'
const { createSourceFingerprint, refreshDataIfChanged, refreshDateWindow } = await import(refreshScriptPath) as unknown as RefreshModule
const { bucketKey, getBucketObject, safeObjectPath, safeRequestedObjectPath, uploadRankingArtifacts } = await import(bucketScriptPath) as unknown as BucketModule

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
      const leaguepediaPath = join(outDir, 'leaguepedia', 'scoreboard-games.json')
      await mkdir(join(outDir, 'leaguepedia'), { recursive: true })
      await writeFile(leaguepediaPath, JSON.stringify({
        source: 'Leaguepedia Cargo ScoreboardGames',
        fetchedAt: `2026-06-29T0${downloadCount}:00:00.000Z`,
        matches: [{ id: 'game-1', winner: 'Blue' }],
      }))
      await writeFile(nextManifestPath, `${JSON.stringify(manifest(leaguepediaPath), null, 2)}\n`)
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
    ], { run: fakeRun })
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
    ], { run: fakeRun })

    assert.equal(first.changed, true)
    assert.equal(second.changed, false)
    assert.equal(crunchCount, 1)
    assert.match(await readFile(manifestPath, 'utf8'), new RegExp(escapeRegExp(rawDir)))
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
    ], { run: fakeRun })
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
  let crunchCount = 0

  async function fakeRun(command: string, commandArgs: string[]) {
    if (commandArgs.includes('scripts/download-local-data.mjs')) {
      const nextManifestPath = valueAfter(commandArgs, '--manifest')
      await writeFile(nextManifestPath, `${JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-07-09T00:00:00.000Z',
        start: '2026-07-02',
        end: '2026-07-09',
        files: {
          leaguepediaJson: [],
          oracleCsv: [],
          lolEsportsJson: [],
        },
        sources: {
          oracle: {
            role: 'primary',
            status: 'failed',
            downloadedThisRun: 0,
            failedThisRun: 1,
          },
          leaguepedia: {
            role: 'backup-gap-fill',
            status: 'failed',
            downloadedThisRun: 0,
            failedThisRun: 1,
          },
        },
        warnings: [
          'Oracle source 2026.csv was not downloaded: download returned HTML (Google Drive - Quota exceeded)',
          'Leaguepedia backup download was not completed: HTTP 503 from Leaguepedia Cargo',
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
    ], { run: fakeRun })
    const finalManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const state = JSON.parse(await readFile(statePath, 'utf8'))

    assert.equal(result.changed, false)
    assert.equal(result.status, 'stale-source')
    assert.equal(result.reason, 'no-current-match-source-data')
    assert.equal(crunchCount, 0)
    assert.deepEqual(finalManifest.files.oracleCsv, [previousOraclePath])
    assert.equal(state.status, 'stale-source')
    assert.equal(state.reason, 'no-current-match-source-data')
    assert.equal(state.coverageEnd, '2026-07-08')
    assert.deepEqual(state.crunch, {
      skipped: true,
      reason: 'no-current-match-source-data',
    })
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
    ], { run: fakeRun })
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
  const previousBootstrapStart = process.env.RANKING_REFRESH_BOOTSTRAP_START
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
    process.env.RANKING_REFRESH_BOOTSTRAP_START = '2025-01-01'
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
    ], { run: fakeRun })
    const state = JSON.parse(await readFile(statePath, 'utf8'))

    assert.equal(downloadStart, '2025-01-01')
    assert.equal(state.mergeExistingRaw, false)
    assert.equal(state.coverageStart, '2025-01-01')
  } finally {
    if (previousBootstrapStart === undefined) {
      delete process.env.RANKING_REFRESH_BOOTSTRAP_START
    } else {
      process.env.RANKING_REFRESH_BOOTSTRAP_START = previousBootstrapStart
    }
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
  const previousEnv = { ...process.env }
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
    process.env.RANKING_BUCKET_NAME = 'bucket-123'
    process.env.RANKING_BUCKET_ENDPOINT = 'https://storage.railway.app'
    process.env.RANKING_BUCKET_ACCESS_KEY_ID = 'access-key'
    process.env.RANKING_BUCKET_SECRET_ACCESS_KEY = 'secret-key'
    process.env.RANKING_BUCKET_PREFIX = 'rankings'
    process.env.RANKING_BUCKET_RESTORE_RAW = 'false'

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
    ], { run: fakeRun, bucketClient: client })

    const uploadedStateBody = sent.find((entry) => entry.input.Key === 'rankings/raw/refresh-state.json')?.input.Body
    assert.equal(typeof uploadedStateBody, 'string')
    const uploadedState = JSON.parse(uploadedStateBody as string)
    const localState = JSON.parse(await readFile(statePath, 'utf8'))

    assert.deepEqual(uploadedState.bucket, {
      enabled: true,
      bucket: 'bucket-123',
      prefix: 'rankings',
      uploadedCount: 5,
      skipped: [{
        key: 'rankings/artifacts/latest-full.json',
        reason: 'full-snapshot-upload-disabled',
      }],
    })
    assert.deepEqual(localState.bucket, uploadedState.bucket)

    const publishBody = sent.find((entry) => entry.input.Key === 'rankings/latest-publish.json')?.input.Body
    assert.equal(typeof publishBody, 'string')
    assert.equal(JSON.parse(publishBody as string).artifactCount, uploadedState.bucket.uploadedCount)
  } finally {
    process.env = previousEnv
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
  const sent: Array<{ input: { Key: string; Bucket: string; ContentType?: string } }> = []
  const client = {
    async send(command: { input: { Key: string; Bucket: string; ContentType?: string } }) {
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
    const keys = sent.map((entry) => entry.input.Key).sort()

    assert.equal(result.enabled, true)
    assert.equal(result.uploaded.length, 5)
    assert.deepEqual(result.skipped, [{
      key: 'rankings/artifacts/latest-full.json',
      reason: 'full-snapshot-upload-disabled',
    }])
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
