import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { createSourceFingerprint, refreshDataIfChanged, refreshDateWindow } = await import('../scripts/refresh-data-if-changed.mjs')
const { bucketKey, getBucketObject, safeObjectPath, safeRequestedObjectPath, uploadRankingArtifacts } = await import('../scripts/railway-bucket.mjs')

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
