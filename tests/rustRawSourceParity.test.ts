import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { hydrateFileBackedRawSourceGeneration, type PreparedRawSourceGeneration } from '../scripts/raw-source-generation.mjs'
import { type RawSourceReceipt } from '../scripts/raw-source-storage.mjs'

const binary = process.env.RANKING_RUST_TEST_BINARY
const importerVersion = 'community-source-import-v1'
const generatedAt = '2026-01-05T00:00:00.000Z'
type PreparedOutput = {
  action: 'prepare'
  childMaxRssBytes: number
  manifestPath: string
  generation: Omit<PreparedRawSourceGeneration, 'objects' | 'verifiedSourceFiles' | 'receiptPrepared' | 'receiptReference'> & {
    objects: Array<{ digest: string; bytes: number; compressedBytes: number; compressedPath: string; compressedSha256: string }>
  }
}

test('Rust raw seam matches Node baseline, mutation partitions, restore and rebaseline', { skip: !binary }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'rust-raw-parity-'))
  const corpus = join(root, 'corpus')
  const stored = new Map<string, string>()
  let previousReceipt: RawSourceReceipt | undefined
  try {
    for (let cycle = 0; cycle < 4; cycle++) {
      await mkdir(corpus, { recursive: true })
      // Remove an existing game, edit another, add a partition, then exercise the 32-delta bound.
      const games = cycle === 0
        ? [['a', '2026-01-01', 'LØS', 'old'], ['b', '2026-01-02', 'LOUD', 'keep']]
        : [['a', '2026-01-03', 'LØS', 'changed'], ['c', '2026-01-04', '🙂', cycle === 3 ? 'rebaseline' : 'new']]
      const csv = ['gameid,date,league,side,notes', ...games.flatMap(([id, date, league, note]) => ['Blue', 'Red'].map((side) => `${id},${date} 12:30:00,${league},${side},"${note}, doubled ""quote"""`))].join('\r\n') + '\r\n'
      await writeFile(join(corpus, 'oracle.csv'), csv)
      await writeFile(join(corpus, 'leaguepedia.json'), '{"data":["LØS","🙂"]}\n')
      await writeFile(join(corpus, 'lolesports.json'), '{"data":[]}\n')
      await writeFile(join(corpus, 'manifest.json'), JSON.stringify({
        schemaVersion: 1, generatedAt, start: '2026-01-01', end: '2026-01-05',
        files: { oracleCsv: ['oracle.csv'], leaguepediaJson: ['leaguepedia.json'], lolEsportsJson: ['lolesports.json'] },
        sources: { oracle: { status: 'downloaded', downloadedCount: 1,
          metadata: { large: 1e20, small: 1e-6, '10': 'ten', '2': 'two', nested: [1e20, 1e-6, {}, []] },
        } }, warnings: [],
        refreshWindow: { start: '2026-01-01', end: '2026-01-05' }, refreshAttempt: { cause: 'parity' },
      }))
      if (cycle === 3 && previousReceipt) {
        // Unique delta references can be carried in inventory-only prepare; exceeding the bound rebaselines.
        previousReceipt = await receiptWithLongChain(previousReceipt)
      }
      const outputs: PreparedOutput[] = []
      for (const worker of ['node', 'rust'] as const) {
        const directory = join(root, `${cycle}-${worker}`)
        const rawDir = join(directory, 'raw')
        await cp(corpus, rawDir, { recursive: true })
        const descriptor = { action: 'prepare', manifestPath: join(rawDir, 'manifest.json'), rawDir, importerVersion, generatedAt, objectDir: join(directory, 'objects'), ...(previousReceipt ? { previousReceipt } : {}) }
        const output: PreparedOutput = JSON.parse(await invoke(worker, directory, descriptor))
        assert.ok(output.childMaxRssBytes > 0)
        outputs.push(output)
      }
      const [node, rust] = outputs
      assert.deepEqual(rust.generation.receipt, node.generation.receipt)
      assert.deepEqual(rust.generation.oracle, node.generation.oracle)
      assert.deepEqual(rust.generation.leaguepedia, node.generation.leaguepedia)
      assert.deepEqual(rust.generation.lolesports, node.generation.lolesports)
      assert.equal(rust.generation.rawIdentityDigest, node.generation.rawIdentityDigest)
      assert.equal(rust.generation.sourceReceiptDigest, node.generation.sourceReceiptDigest)
      assert.deepEqual(rust.generation.objects.map(({ digest, bytes }) => ({ digest, bytes })), node.generation.objects.map(({ digest, bytes }) => ({ digest, bytes })))
      for (let index = 0; index < node.generation.objects.length; index++) {
        const nodeBytes = gunzipSync(await readFile(node.generation.objects[index].compressedPath))
        const rustBytes = gunzipSync(await readFile(rust.generation.objects[index].compressedPath))
        assert.deepEqual(rustBytes, nodeBytes)
        stored.set(`raw/objects/sha256/${node.generation.objects[index].digest}`, node.generation.objects[index].compressedPath)
      }
      assert.deepEqual(await readFile(rust.manifestPath), await readFile(node.manifestPath))
      assert.deepEqual(await readFile(join(resolve(rust.manifestPath, '..'), 'oracles-elixir/oracle.csv')), Buffer.from(csv))
      // No-change cycle and rebaseline cycle both preserve valid descriptors.
      previousReceipt = node.generation.receipt
      if (cycle === 3) assert.equal(rust.generation.receipt.oracle[0].deltas.length, 0)
      if (cycle === 3) continue
      const authority = hydrateFileBackedRawSourceGeneration(node.generation)
      const references = [
        ...authority.receipt.oracle.flatMap(({ baseline, deltas }) => [baseline, ...deltas]),
        ...authority.receipt.leaguepedia.map(({ object }) => object),
        ...authority.receipt.lolesports.map(({ object }) => object),
      ]
      const objectFiles = Object.fromEntries(references.map(({ key }) => [key, stored.get(key)!]))
      if (cycle === 0) await assertRestoreFailures(root, authority, objectFiles)
      for (const worker of ['node', 'rust'] as const) {
        const directory = join(root, `restore-${cycle}-${worker}`)
        await mkdir(directory, { recursive: true })
        await invoke(worker, directory, { action: 'restore', receipt: authority.receipt, receiptReference: authority.receiptReference, ...(cycle === 0 ? {} : { importerVersion }), requiredCoverage: { start: '2026-01-01', end: '2026-01-05' }, objectFiles, destinationDir: join(directory, 'raw'), generatedAt })
      }
      for (const relative of ['manifest.json', 'oracles-elixir/oracle.csv', 'leaguepedia/leaguepedia.json', 'lolesports/lolesports.json']) {
        assert.deepEqual(await readFile(join(root, `restore-${cycle}-rust/raw`, relative)), await readFile(join(root, `restore-${cycle}-node/raw`, relative)))
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function receiptWithLongChain(receipt: RawSourceReceipt) {
  const { prepareRawSourceReceipt } = await import('../scripts/raw-source-storage.mjs')
  const oracle = receipt.oracle.map((source) => ({ ...source, deltas: Array.from({ length: 32 }, (_, index) => {
    const sha256 = (index + 1).toString(16).padStart(64, '0')
    return { key: `raw/objects/sha256/${sha256}`, sha256, bytes: 1, storageEncoding: 'gzip' as const }
  }) }))
  return prepareRawSourceReceipt({ ...receipt, oracle }).receipt
}

async function invoke(worker: 'node' | 'rust', directory: string, input: object) {
  const { code, stderr, outputPath } = await runWorker(worker, directory, input)
  assert.equal(code, 0, stderr)
  return readFile(outputPath, 'utf8')
}

async function assertRestoreFailures(
  root: string,
  authority: ReturnType<typeof hydrateFileBackedRawSourceGeneration>,
  objectFiles: Record<string, string>,
) {
  const corruptPath = join(root, 'corrupt-object')
  await writeFile(corruptPath, 'not gzip')
  for (const worker of ['node', 'rust'] as const) {
    for (const failure of ['null importer', 'wrong importer', 'corrupt object']) {
      const directory = join(root, `invalid-${worker}-${failure}`)
      const destinationDir = join(directory, 'raw')
      await mkdir(destinationDir, { recursive: true })
      await writeFile(join(destinationDir, 'sentinel'), 'preserve existing destination')
      const corruptedFiles = { ...objectFiles, [authority.receipt.oracle[0].baseline.key]: corruptPath }
      const result = await runWorker(worker, directory, {
        action: 'restore', receipt: authority.receipt, receiptReference: authority.receiptReference,
        importerVersion: failure === 'null importer' ? null : failure === 'wrong importer' ? 'wrong-importer' : importerVersion,
        objectFiles: failure === 'corrupt object' ? corruptedFiles : objectFiles, destinationDir, generatedAt,
      })
      assert.ok(result.code !== null && result.code > 0, `${worker}: ${failure} must exit nonzero`)
      assert.deepEqual(await readdir(destinationDir), ['sentinel'])
      assert.equal(await readFile(join(destinationDir, 'sentinel'), 'utf8'), 'preserve existing destination')
      await assert.rejects(readFile(result.outputPath), { code: 'ENOENT' })
      assert.ok(!(await readdir(directory)).some((name) => name.startsWith('raw.receipt-next-')))
    }
  }
}

async function runWorker(worker: 'node' | 'rust', directory: string, input: object) {
  await mkdir(directory, { recursive: true })
  const inputPath = join(directory, 'input.json')
  const outputPath = join(directory, 'output.json')
  await writeFile(inputPath, JSON.stringify(input))
  const command = worker === 'rust' ? binary! : process.execPath
  const args = worker === 'rust' ? ['raw-source', inputPath, outputPath] : ['--max-old-space-size=2048', '--import=tsx', resolve('scripts/raw-source-worker.mjs'), inputPath, outputPath]
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  const stderr: Buffer[] = []
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.on('error', rejectExit)
    child.on('exit', resolveExit)
  })
  return { code, stderr: Buffer.concat(stderr).toString('utf8'), outputPath }
}
