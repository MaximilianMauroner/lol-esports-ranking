import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  finalizeRawSourceGeneration,
  hydrateFileBackedRawSourceGeneration,
  materializePreparedRawSourceGeneration,
  materializeVerifiedPreparedRawSourceGeneration,
  prepareRawSourceGeneration,
  RAW_ORACLE_MAX_DELTAS,
  type ActiveRawSourceAuthority,
  type PreparedRawSourceGeneration,
} from '../scripts/raw-source-generation.mjs'
import { ORACLE_BASELINE_KIND, ORACLE_DELTA_KIND, decodeRawObject, parseOracleCsv, rawObjectReferenceFor } from '../scripts/raw-source-storage.mjs'
import { importRankingSourceData } from '../scripts/ranking-source-import'
import { uploadContentAddressedRawSourceGeneration } from '../scripts/railway-bucket.mjs'

const importerVersion = 'community-source-import-v1'

test('aged Oracle delta chains deterministically re-baseline at the documented bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raw-generation-rebaseline-'))
  const stored = new Map<string, Buffer>()
  let active: ActiveRawSourceAuthority | undefined
  let originalBaselineKey: string | undefined
  let latestCsv = ''
  try {
    const games: Array<ReturnType<typeof game>> = []
    for (let cycle = 0; cycle <= RAW_ORACLE_MAX_DELTAS + 1; cycle += 1) {
      games.push(game(`g-${cycle}`, 'Alpha', 'Beta', 'Starter', '2026-01-01'))
      latestCsv = oracleCsv(games)
      const cycleRoot = join(root, `cycle-${cycle}`)
      const sourcePath = join(cycleRoot, 'oracle-current.csv')
      const manifestPath = join(cycleRoot, 'manifest.json')
      await mkdir(cycleRoot, { recursive: true })
      await writeFile(sourcePath, latestCsv)
      await writeFile(manifestPath, JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        start: '2026-01-01',
        end: '2026-01-01',
        files: { oracleCsv: [sourcePath], leaguepediaJson: [], lolEsportsJson: [] },
        sources: { oracle: { status: 'downloaded', downloadedCount: 1 } },
      }))
      const prepared = finalizeRawSourceGeneration(await prepareRawSourceGeneration({
        manifestPath,
        importerVersion,
        ...(active ? { previousAuthority: active } : {}),
      }), `raw_rebaseline_${cycle}`)
      if (cycle === 0) originalBaselineKey = prepared.oracle[0]!.baseline.key
      if (cycle === RAW_ORACLE_MAX_DELTAS) {
        assert.equal(prepared.oracle[0]!.deltas.length, RAW_ORACLE_MAX_DELTAS)
        assert.equal(prepared.oracle[0]!.baseline.key, originalBaselineKey)
      }
      if (cycle === RAW_ORACLE_MAX_DELTAS + 1) {
        assert.equal(prepared.oracle[0]!.deltas.length, 0)
        assert.notEqual(prepared.oracle[0]!.baseline.key, originalBaselineKey)
        assert.deepEqual(prepared.objects.map((object) => object.value.artifactKind), [ORACLE_BASELINE_KIND])
      }
      promote(prepared, stored)
      active = { receipt: prepared.receipt, objectResolver: async (reference) => stored.get(reference.key) }
    }
    assert.ok(active)
    const destination = join(root, 'materialized')
    await materializePreparedRawSourceGeneration(
      finalizeRawSourceGeneration(await prepareRawSourceGeneration({
        manifestPath: join(root, `cycle-${RAW_ORACLE_MAX_DELTAS + 1}`, 'manifest.json'),
        importerVersion,
        previousAuthority: active,
      }), 'raw_rebaseline_final'),
      destination,
      '2026-01-01T00:00:00.000Z',
    )
    const restored = await readFile(join(destination, 'oracles-elixir', 'oracle-current.csv'), 'utf8')
    assert.equal(
      parseOracleCsv(restored, { sourceFileName: 'oracle-current.csv', importerVersion }).digest,
      parseOracleCsv(latestCsv, { sourceFileName: 'oracle-current.csv', importerVersion }).digest,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('promoted raw authority restarts across append, same-day substitution, and historical correction/tombstone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raw-generation-cycles-'))
  const stored = new Map<string, Buffer>()
  try {
    const cycles = [
      oracleCsv([game('g1', 'Alpha', 'Beta'), game('g2', 'Beta', 'Alpha')]),
      oracleCsv([game('g1', 'Alpha', 'Beta'), game('g2', 'Beta', 'Alpha'), game('g3', 'Alpha', 'Beta')]),
      oracleCsv([game('g1', 'Alpha', 'Beta'), game('g2', 'Beta', 'Alpha'), game('g3', 'Alpha', 'Beta', 'Substitute')]),
      oracleCsv([game('g1', 'Beta', 'Alpha'), game('g3', 'Alpha', 'Beta', 'Substitute')]),
    ]
    let active: ActiveRawSourceAuthority | undefined
    let baselineKey: string | undefined
    const observedOperations = new Set<string>()
    for (const [index, csv] of cycles.entries()) {
      const cycleRoot = join(root, `cycle-${index}`)
      const sourcePath = join(cycleRoot, 'oracle-current.csv')
      const manifestPath = join(cycleRoot, 'manifest.json')
      await mkdir(cycleRoot, { recursive: true })
      await writeFile(sourcePath, csv)
      await writeFile(manifestPath, JSON.stringify({
        schemaVersion: 1,
        generatedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
        start: '2026-01-01',
        end: '2026-01-03',
        files: { oracleCsv: [sourcePath], leaguepediaJson: [], lolEsportsJson: [] },
        sources: { oracle: { status: 'downloaded', downloadedCount: 1 } },
      }))
      const prepared = finalizeRawSourceGeneration(await prepareRawSourceGeneration({
        manifestPath,
        importerVersion,
        ...(active ? { previousAuthority: active } : {}),
      }), `raw_cycle_${index}`)
      if (index === 0) {
        assert.equal(prepared.objects.some((object) => object.value.artifactKind === ORACLE_BASELINE_KIND), true)
        baselineKey = prepared.oracle[0]!.baseline.key
      } else {
        assert.equal(prepared.oracle[0]!.baseline.key, baselineKey)
        assert.equal(prepared.objects.every((object) => object.value.artifactKind === ORACLE_DELTA_KIND), true)
        for (const object of prepared.objects) {
          if (object.value.artifactKind !== ORACLE_DELTA_KIND) continue
          for (const mutation of object.value.mutations) observedOperations.add(mutation.operation)
        }
      }
      promote(prepared, stored)
      active = { receipt: prepared.receipt, objectResolver: async (reference) => stored.get(reference.key) }
      const destination = join(root, `materialized-${index}`)
      const materialized = await materializePreparedRawSourceGeneration(prepared, destination, `2026-01-0${index + 1}T00:00:00.000Z`)
      const materializedCsv = await readFile(join(destination, 'oracles-elixir', 'oracle-current.csv'), 'utf8')
      assert.equal(parseOracleCsv(materializedCsv, { sourceFileName: 'oracle-current.csv', importerVersion }).digest,
        parseOracleCsv(csv, { sourceFileName: 'oracle-current.csv', importerVersion }).digest)
      assert.equal(materialized.receipt.sourceReceiptDigest, prepared.sourceReceiptDigest)
    }
    assert.ok(active)
    assert.deepEqual([...observedOperations].sort(), ['add', 'delete', 'replace'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('raw generation preserves provider game order through receipt materialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raw-generation-order-'))
  try {
    const sourcePath = join(root, 'oracle-current.csv')
    const manifestPath = join(root, 'manifest.json')
    const csv = oracleCsv([
      game('z-first', 'Alpha', 'Beta', 'Starter', '2026-01-01'),
      game('a-second', 'Beta', 'Alpha', 'Starter', '2026-01-01'),
    ])
    await writeFile(sourcePath, csv)
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      start: '2026-01-01',
      end: '2026-01-01',
      files: { oracleCsv: [sourcePath], leaguepediaJson: [], lolEsportsJson: [] },
      sources: { oracle: { status: 'downloaded', downloadedCount: 1 } },
    }))
    const prepared = finalizeRawSourceGeneration(await prepareRawSourceGeneration({ manifestPath, importerVersion }), 'raw_order')
    const destination = join(root, 'materialized')
    await materializePreparedRawSourceGeneration(prepared, destination, '2026-01-01T00:00:00.000Z')
    const materialized = await readFile(join(destination, 'oracles-elixir', 'oracle-current.csv'), 'utf8')
    assert.equal(materialized, csv)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('verified prepared materialization imports equivalently from a clean receipt-bound directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raw-generation-verified-copy-'))
  const rawDir = join(root, 'raw')
  try {
    const sourcePath = join(rawDir, 'oracle-current.csv')
    const manifestPath = join(rawDir, 'manifest.json')
    await mkdir(rawDir, { recursive: true })
    await writeFile(sourcePath, oracleCsv([
      game('g1', 'Alpha', 'Beta', 'Starter', '2026-01-01'),
      game('g2', 'Beta', 'Alpha', 'Starter', '2026-01-02'),
    ]))
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-01-02T00:00:00.000Z',
      start: '2026-01-01',
      end: '2026-01-02',
      files: { oracleCsv: [sourcePath], leaguepediaJson: [], lolEsportsJson: [] },
      sources: { oracle: { status: 'downloaded', downloadedCount: 1 } },
    }))
    const before = await importRankingSourceData({ manifestPath })
    const prepared = await prepareRawSourceGeneration({ manifestPath, rawDir, importerVersion })
    const materialized = await materializeVerifiedPreparedRawSourceGeneration(
      prepared,
      rawDir,
      '2026-01-02T00:00:00.000Z',
    )
    const after = await importRankingSourceData({ manifestPath: materialized.manifestPath })

    assert.deepEqual(after.importedMatches, before.importedMatches)
    assert.deepEqual(after.matches, before.matches)
    assert.deepEqual(after.teams, before.teams)
    assert.equal(materialized.manifest.sourceReceipt.sourceReceiptDigest, prepared.sourceReceiptDigest)
    await assert.rejects(readFile(sourcePath), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('verified prepared materialization fails closed when staged bytes change after prepare', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raw-generation-tamper-'))
  const rawDir = join(root, 'raw')
  try {
    const sourcePath = join(rawDir, 'oracle-current.csv')
    const manifestPath = join(rawDir, 'manifest.json')
    await mkdir(rawDir, { recursive: true })
    await writeFile(sourcePath, oracleCsv([game('g1', 'Alpha', 'Beta')]))
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      start: '2026-01-01',
      end: '2026-01-01',
      files: { oracleCsv: [sourcePath], leaguepediaJson: [], lolEsportsJson: [] },
      sources: { oracle: { status: 'downloaded', downloadedCount: 1 } },
    }))
    const prepared = await prepareRawSourceGeneration({ manifestPath, rawDir, importerVersion })
    await writeFile(sourcePath, `${await readFile(sourcePath, 'utf8')}tampered\n`)

    await assert.rejects(
      materializeVerifiedPreparedRawSourceGeneration(prepared, rawDir, '2026-01-01T00:00:00.000Z'),
      /changed before receipt materialization/,
    )
    assert.match(await readFile(sourcePath, 'utf8'), /tampered/)
    assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).generatedAt, '2026-01-01T00:00:00.000Z')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('raw worker emits a file-backed generation and cleans partial output on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raw-worker-'))
  try {
    const success = await rawWorkerFixture(root, 'success')
    const successResult = await runRawWorker(success.inputPath, success.outputPath)
    assert.equal(successResult.code, 0, successResult.stderr)
    const output = JSON.parse(await readFile(success.outputPath, 'utf8'))
    assert.equal(output.action, 'prepare')
    assert.ok(output.childMaxRssBytes > 0)
    assert.ok(output.generation.objects.length > 0)
    await access(output.generation.objects[0].compressedPath)
    const imported = await importRankingSourceData({ manifestPath: output.manifestPath })
    assert.ok(imported.importedMatches.length > 0)

    const generation = hydrateFileBackedRawSourceGeneration(output.generation)
    const restoreInputPath = join(root, 'restore.input.json')
    const restoreOutputPath = join(root, 'restore.output.json')
    const restoreDir = join(root, 'restored')
    await writeFile(restoreInputPath, JSON.stringify({
      action: 'restore',
      receipt: generation.receipt,
      receiptReference: generation.receiptReference,
      objectFiles: Object.fromEntries(generation.objects.map((object) => [
        `raw/objects/sha256/${object.digest}`,
        object.compressedPath,
      ])),
      destinationDir: restoreDir,
      generatedAt: '2026-01-01T00:00:00.000Z',
      importerVersion,
    }))
    const restored = await runRawWorker(restoreInputPath, restoreOutputPath)
    assert.equal(restored.code, 0, restored.stderr)
    const restoreOutput = JSON.parse(await readFile(restoreOutputPath, 'utf8'))
    assert.equal(restoreOutput.action, 'restore')
    assert.equal(restoreOutput.identity.sourceReceiptDigest, generation.sourceReceiptDigest)
    assert.equal(restoreOutput.receiptDigest, generation.receiptReference.sha256)
    assert.equal(restoreOutput.objectCount, generation.objects.length)
    await access(join(restoreDir, 'manifest.json'))

    await writeFile(generation.objects[0].compressedPath!, Buffer.from('tampered'))
    const corruptInputPath = join(root, 'corrupt-restore.input.json')
    const corruptOutputPath = join(root, 'corrupt-restore.output.json')
    const corruptRestoreDir = join(root, 'corrupt-restored')
    await writeFile(corruptInputPath, JSON.stringify({
      action: 'restore',
      receipt: generation.receipt,
      receiptReference: generation.receiptReference,
      objectFiles: Object.fromEntries(generation.objects.map((object) => [
        `raw/objects/sha256/${object.digest}`,
        object.compressedPath,
      ])),
      destinationDir: corruptRestoreDir,
      generatedAt: '2026-01-01T00:00:00.000Z',
      importerVersion,
    }))
    const corruptRestore = await runRawWorker(corruptInputPath, corruptOutputPath)
    assert.notEqual(corruptRestore.code, 0)
    await assert.rejects(access(corruptOutputPath), { code: 'ENOENT' })
    await assert.rejects(access(join(corruptRestoreDir, 'manifest.json')), { code: 'ENOENT' })

    await assert.rejects(
      uploadContentAddressedRawSourceGeneration(streamConsumingBucketClient(), bucketConfig, generation),
      /changed before upload/,
    )

    const failure = await rawWorkerFixture(root, 'failure', '')
    const failureResult = await runRawWorker(failure.inputPath, failure.outputPath)
    assert.notEqual(failureResult.code, 0)
    await assert.rejects(access(failure.outputPath), { code: 'ENOENT' })
    await assert.rejects(access(failure.objectDir), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function rawWorkerFixture(root: string, name: string, generatedAt = '2026-01-01T00:00:00.000Z') {
  const rawDir = join(root, name, 'raw')
  const sourcePath = join(rawDir, 'oracle-current.csv')
  const manifestPath = join(rawDir, 'manifest.json')
  const objectDir = join(root, name, 'objects')
  const inputPath = join(root, name, 'input.json')
  const outputPath = join(root, name, 'output.json')
  await mkdir(rawDir, { recursive: true })
  await writeFile(sourcePath, oracleCsv([game(`${name}-game`, 'Alpha', 'Beta')]))
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    start: '2026-01-01',
    end: '2026-01-01',
    files: { oracleCsv: [sourcePath], leaguepediaJson: [], lolEsportsJson: [] },
    sources: { oracle: { status: 'downloaded', downloadedCount: 1 } },
  }))
  await writeFile(inputPath, JSON.stringify({
    action: 'prepare', manifestPath, rawDir, importerVersion, generatedAt, objectDir,
  }))
  return { inputPath, outputPath, objectDir }
}

async function runRawWorker(inputPath: string, outputPath: string) {
  const child = spawn(process.execPath, [
    ...process.execArgv,
    join(process.cwd(), 'scripts/raw-source-worker.mjs'),
    inputPath,
    outputPath,
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  const stderr: Buffer[] = []
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.on('error', rejectExit)
    child.on('exit', resolveExit)
  })
  return { code, stderr: Buffer.concat(stderr).toString('utf8') }
}

function streamConsumingBucketClient() {
  return {
    async send(command: { input?: { Body?: AsyncIterable<Uint8Array> } }) {
      for await (const chunk of command.input?.Body ?? []) void chunk
      return {}
    },
  }
}

const bucketConfig = {
  enabled: true,
  bucket: 'test',
  endpoint: 'https://example.invalid',
  region: 'auto',
  accessKeyId: 'x',
  secretAccessKey: 'y',
  prefix: 'rankings',
}

function promote(generation: PreparedRawSourceGeneration, stored: Map<string, Buffer>) {
  for (const object of [...generation.objects, generation.receiptPrepared]) {
    const reference = rawObjectReferenceFor(object)
    decodeRawObject(reference, object.compressed)
    stored.set(reference.key, object.compressed)
  }
}

function game(id: string, winner: string, loser: string, player = 'Starter', date?: string) {
  return { id, winner, loser, player, date }
}

function oracleCsv(games: Array<ReturnType<typeof game>>) {
  const rows = ['gameid,date,league,side,position,teamname,playername,playerid,result']
  for (const [index, entry] of games.entries()) {
    const date = entry.date ?? `2026-01-0${index + 1}`
    rows.push(`${entry.id},${date},LCK,Blue,team,${entry.winner},,,1`)
    rows.push(`${entry.id},${date},LCK,Blue,top,${entry.winner},${entry.player},player-${entry.id},1`)
    rows.push(`${entry.id},${date},LCK,Red,team,${entry.loser},,,0`)
    rows.push(`${entry.id},${date},LCK,Red,top,${entry.loser},Opponent,opponent-${entry.id},0`)
  }
  return `${rows.join('\n')}\n`
}
