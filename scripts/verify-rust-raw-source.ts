import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { gunzipSync } from 'node:zlib'
import { manifestWithResolvedFiles } from './local-data-manifest.js'
import { hydrateFileBackedRawSourceGeneration, type PreparedRawSourceGeneration } from './raw-source-generation.mjs'
import { rawSourceWorkerExecArgv } from './refresh-worker-memory.mjs'

type RawManifest = {
  start: string
  end: string
  files: { oracleCsv?: string[]; leaguepediaJson?: string[]; lolEsportsJson?: string[] }
}
type PrepareOutput = {
  generation: Omit<PreparedRawSourceGeneration, 'objects' | 'verifiedSourceFiles' | 'receiptPrepared' | 'receiptReference'> & {
    objects: Array<{ digest: string; bytes: number; compressedBytes: number; compressedPath: string; compressedSha256: string }>
  }
  childMaxRssBytes: number
  totalMs: number
  manifestPath: string
}

/** Compare isolated child runs; original raw files and production are never written. */
export async function verifyRustRawSource(manifestPath: string, binary: string) {
  const root = await mkdtemp(join(tmpdir(), 'rust-raw-corpus-'))
  try {
    const source: RawManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const manifest = manifestWithResolvedFiles(source, dirname(resolve(manifestPath)))
    const outputs: PrepareOutput[] = []
    const measured: Array<{ worker: 'node' | 'rust'; preparePeakRssBytes: number; prepareMs: number; restorePeakRssBytes?: number; restoreMs?: number }> = []
    for (const worker of ['node', 'rust'] as const) {
      const directory = join(root, worker)
      const rawDir = join(directory, 'raw')
      const files: RawManifest['files'] = {}
      for (const [group, folder] of [['oracleCsv', 'oracles-elixir'], ['leaguepediaJson', 'leaguepedia'], ['lolEsportsJson', 'lolesports']] as const) {
        files[group] = []
        await mkdir(join(rawDir, folder), { recursive: true })
        for (const path of manifest.files[group] ?? []) {
          const relative = `${folder}/${basename(path)}`
          await copyFile(path, join(rawDir, relative))
          files[group].push(relative)
        }
      }
      const staged = join(rawDir, 'manifest.json')
      await writeFile(staged, JSON.stringify({ ...source, files }))
      const output: PrepareOutput = JSON.parse(await run(worker, directory, binary, {
        action: 'prepare', manifestPath: staged, rawDir, objectDir: join(directory, 'objects'),
        importerVersion: 'community-source-import-v1', generatedAt: '2026-10-08T00:00:00.000Z',
      }))
      assert.ok(output.childMaxRssBytes > 0)
      outputs.push(output)
      measured.push({ worker, preparePeakRssBytes: output.childMaxRssBytes, prepareMs: output.totalMs })
    }
    const [node, rust] = outputs
    assert.deepEqual(rust.generation.receipt, node.generation.receipt)
    const identities = ({ generation }: PrepareOutput) => generation.objects.map(({ digest, bytes }) => ({ digest, bytes }))
    assert.deepEqual(identities(rust), identities(node))
    for (let index = 0; index < node.generation.objects.length; index++) {
      const actual = gunzipSync(await readFile(rust.generation.objects[index].compressedPath))
      const expected = gunzipSync(await readFile(node.generation.objects[index].compressedPath))
      assert.deepEqual(actual, expected)
    }
    assert.deepEqual(await readFile(rust.manifestPath), await readFile(node.manifestPath))
    const authority = hydrateFileBackedRawSourceGeneration(node.generation)
    // Restore both from Node transport bytes, proving cross-worker storage compatibility.
    const objectFiles = Object.fromEntries(node.generation.objects.map(({ digest, compressedPath }) => [`raw/objects/sha256/${digest}`, compressedPath]))
    for (const [index, worker] of (['node', 'rust'] as const).entries()) {
      const directory = join(root, `restore-${worker}`)
      const output: { childMaxRssBytes: number; restoreMs: number } = JSON.parse(await run(worker, directory, binary, {
        action: 'restore', receipt: authority.receipt, receiptReference: authority.receiptReference,
        importerVersion: authority.importerVersion, objectFiles, destinationDir: join(directory, 'raw'),
        requiredCoverage: authority.coverage, generatedAt: '2026-10-08T00:00:00.000Z',
      }))
      measured[index] = { ...measured[index], restorePeakRssBytes: output.childMaxRssBytes, restoreMs: output.restoreMs }
    }
    const restored: RawManifest = JSON.parse(await readFile(join(root, 'restore-node/raw/manifest.json'), 'utf8'))
    for (const relative of ['manifest.json', ...Object.values(restored.files).flat()]) {
      assert.deepEqual(await readFile(join(root, 'restore-rust/raw', relative)), await readFile(join(root, 'restore-node/raw', relative)))
    }
    return { parity: true, differingObjects: 0, objectCount: node.generation.objects.length, gameCount: authority.receipt.oracle.reduce((sum, source) => sum + source.gameInventory.length, 0), measured }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function run(worker: 'node' | 'rust', directory: string, binary: string, input: object) {
  await mkdir(directory, { recursive: true })
  const inputPath = join(directory, 'input.json')
  const outputPath = join(directory, 'output.json')
  await writeFile(inputPath, JSON.stringify(input))
  const command = worker === 'rust' ? binary : process.execPath
  const args = worker === 'rust'
    ? ['raw-source', inputPath, outputPath]
    : [...rawSourceWorkerExecArgv(process.execArgv), resolve('scripts/raw-source-worker.mjs'), inputPath, outputPath]
  const started = performance.now()
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  const stderr: Buffer[] = []
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', resolveExit)
  })
  assert.equal(code, 0, `${worker} raw seam failed after ${performance.now() - started}ms: ${Buffer.concat(stderr).toString('utf8')}`)
  return readFile(outputPath, 'utf8')
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const manifest = process.argv[2]
  if (!manifest) throw new Error('Usage: verify-rust-raw-source.ts <manifest.json> [ranking-refresh]')
  console.log(JSON.stringify(await verifyRustRawSource(resolve(manifest), resolve(process.argv[3] ?? 'worker/target/release/ranking-refresh'))))
}
