import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  RAW_SOURCE_WORKER_MAX_OLD_SPACE_MB,
  REFRESH_WORKER_MAX_OLD_SPACE_MB,
  REFRESH_WORKER_MAX_SEMI_SPACE_MB,
  rawSourceWorkerExecArgv,
  readProcessPeakRssBytes,
  refreshWorkerArgs,
  refreshWorkerExecArgv,
} from '../scripts/refresh-worker-memory.mjs'
import { rawSourceWorkerCommand } from '../scripts/raw-source-worker-command.mjs'

test('refresh worker memory flags are canonical and deduplicate inherited variants', () => {
  assert.equal(REFRESH_WORKER_MAX_OLD_SPACE_MB, 2048)
  assert.equal(RAW_SOURCE_WORKER_MAX_OLD_SPACE_MB, 2048)
  assert.equal(REFRESH_WORKER_MAX_SEMI_SPACE_MB, 4)
  const inherited = [
    '--trace-warnings',
    '--expose-gc',
    '--max-old-space-size=2048',
    '--max_old_space_size',
    '1024',
    '--max-semi-space-size=32',
    '--max_semi_space_size',
    '16',
    '--import',
    'tsx',
    '--import=tsx',
  ]
  const flags = refreshWorkerExecArgv(inherited)
  assert.deepEqual(flags, [
    '--trace-warnings',
    `--max-old-space-size=${REFRESH_WORKER_MAX_OLD_SPACE_MB}`,
    `--max-semi-space-size=${REFRESH_WORKER_MAX_SEMI_SPACE_MB}`,
    '--expose-gc',
    '--import=tsx',
  ])
  assert.deepEqual(
    refreshWorkerArgs('scripts/refresh-data-if-changed.mjs', ['--force'], inherited),
    [...flags, 'scripts/refresh-data-if-changed.mjs', '--force'],
  )
  assert.deepEqual(rawSourceWorkerExecArgv(inherited), [
    '--trace-warnings',
    `--max-old-space-size=${RAW_SOURCE_WORKER_MAX_OLD_SPACE_MB}`,
    `--max-semi-space-size=${REFRESH_WORKER_MAX_SEMI_SPACE_MB}`,
    '--expose-gc',
    '--import=tsx',
  ])
})

test('raw source selector defaults to Node, uses Rust CLI arguments, and rejects unknown workers', () => {
  const inherited = process.execArgv
  try {
    process.execArgv = ['--trace-warnings', '--max_old_space_size', '1024', '--max_semi_space_size=32', '--import', 'tsx']
    for (const env of [{}, { RANKING_RAW_SOURCE_WORKER: 'node' }]) {
      assert.deepEqual(rawSourceWorkerCommand('input.json', 'output.json', env), {
        command: process.execPath,
        args: ['--trace-warnings', '--max-old-space-size=2048', '--max-semi-space-size=4', '--expose-gc', '--import=tsx',
          resolve('scripts/raw-source-worker.mjs'), 'input.json', 'output.json'],
      })
    }
  } finally {
    process.execArgv = inherited
  }
  for (const binary of [undefined, '/custom/ranking-refresh']) {
    assert.deepEqual(rawSourceWorkerCommand('input.json', 'output.json', {
      RANKING_RAW_SOURCE_WORKER: 'rust', ...(binary ? { RANKING_REFRESH_BINARY: binary } : {}),
    }), {
      command: binary ?? resolve('worker/target/release/ranking-refresh'),
      args: ['raw-source', 'input.json', 'output.json'],
    })
  }
  assert.throws(() => rawSourceWorkerCommand('input.json', 'output.json', { RANKING_RAW_SOURCE_WORKER: 'unknown' }), /Unsupported RANKING_RAW_SOURCE_WORKER/)
})

test('Linux executable peak excludes the setup parent memory inherited across fork and exec', {
  skip: process.platform !== 'linux', timeout: 15_000,
}, () => {
  const memoryModule = new URL('../scripts/refresh-worker-memory.mjs', import.meta.url).href
  const childScript = `
    import { readProcessPeakRssBytes } from ${JSON.stringify(memoryModule)}
    const rssBytes = process.memoryUsage().rss
    process.stdout.write([rssBytes, readProcessPeakRssBytes(), process.resourceUsage().maxRSS * 1024].join('\\n'))
  `
  const parentScript = `
    import { execFileSync } from 'node:child_process'
    const allocation = Buffer.alloc(96 * 1024 * 1024, 1)
    const rssBytes = process.memoryUsage().rss
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(childScript)}], {
      encoding: 'utf8', timeout: 10_000,
    })
    if (allocation.at(-1) !== 1) throw new Error('Setup allocation was not resident')
    process.stdout.write(rssBytes + '\\n' + output)
  `
  const [parentRssBytes, childRssBytes, childPeakRssBytes, inheritedPeakRssBytes] = execFileSync(process.execPath,
    ['--input-type=module', '--eval', parentScript], { encoding: 'utf8', timeout: 12_000 })
    .trim().split('\n').map(Number)
  assert.ok(parentRssBytes >= 96 * 1024 * 1024)
  assert.ok(childPeakRssBytes >= childRssBytes)
  assert.ok(Number.isSafeInteger(childPeakRssBytes) && childPeakRssBytes > 0)
  assert.ok(parentRssBytes - childPeakRssBytes >= 64 * 1024 * 1024)
  assert.ok(inheritedPeakRssBytes - childPeakRssBytes >= 32 * 1024 * 1024)
})

test('Linux executable peak retains a real allocation after its backing memory is released', {
  skip: process.platform !== 'linux', timeout: 15_000,
}, () => {
  const memoryModule = new URL('../scripts/refresh-worker-memory.mjs', import.meta.url).href
  const script = `
    import { readProcessPeakRssBytes } from ${JSON.stringify(memoryModule)}
    let allocation = Buffer.alloc(96 * 1024 * 1024, 1)
    if (allocation.at(-1) !== 1) throw new Error('Test allocation was not resident')
    const allocated = process.memoryUsage()
    allocation = undefined
    for (let index = 0; index < 3; index += 1) {
      globalThis.gc()
      await new Promise((resolve) => setImmediate(resolve))
    }
    const released = process.memoryUsage()
    process.stdout.write([allocated.rss, allocated.external, released.external, readProcessPeakRssBytes()].join('\\n'))
  `
  const [allocatedRssBytes, allocatedExternalBytes, releasedExternalBytes, peakRssBytes] = execFileSync(process.execPath,
    ['--expose-gc', '--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 12_000 })
    .trim().split('\n').map(Number)
  assert.ok(allocatedExternalBytes - releasedExternalBytes >= 90 * 1024 * 1024)
  assert.ok(peakRssBytes >= allocatedRssBytes)
})

test('Linux executable peak fails closed when procfs high-water data is missing or invalid', {
  skip: process.platform !== 'linux', timeout: 15_000,
}, () => {
  const rssBytes = process.memoryUsage().rss
  assert.ok(readProcessPeakRssBytes() >= rssBytes)
  const memoryModule = new URL('../scripts/refresh-worker-memory.mjs', import.meta.url).href
  const script = `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    import { readProcessPeakRssBytes } from ${JSON.stringify(memoryModule)}
    const originalRead = fs.readFileSync
    for (const status of ['', 'VmHWM: 0 kB', 'VmHWM: 1 kB', 'VmHWM: 9007199254740991 kB', 'VmHWM: 123 MB']) {
      fs.readFileSync = (path, ...args) => path === '/proc/self/status' ? status : originalRead(path, ...args)
      syncBuiltinESMExports()
      assert.throws(() => readProcessPeakRssBytes(), /Invalid executable peak RSS/)
    }
    fs.readFileSync = (path, ...args) => {
      if (path === '/proc/self/status') throw new Error('procfs unavailable')
      return originalRead(path, ...args)
    }
    syncBuiltinESMExports()
    assert.throws(() => readProcessPeakRssBytes(), /procfs unavailable/)
  `
  execFileSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 12_000 })
})

test('worker, direct, and benchmark entry points share the exact refresh memory policy', async () => {
  const [packageJson, runner, once, benchmark, refreshWrapper] = await Promise.all([
    readFile('package.json', 'utf8'),
    readFile('scripts/run-refresh-worker.mjs', 'utf8'),
    readFile('scripts/refresh-once.mjs', 'utf8'),
    readFile('scripts/benchmark-incremental-ranking.ts', 'utf8'),
    readFile('scripts/refresh-data-if-changed.mjs', 'utf8'),
  ])
  assert.match(packageJson, /"railway:refresh": "node scripts\/run-refresh-worker\.mjs"/)
  assert.match(runner, /refreshWorkerArgs\('scripts\/refresh-data-if-changed\.mjs', process\.argv\.slice\(2\)\)/)
  assert.match(once, /refreshWorkerArgs\('scripts\/refresh-data-if-changed\.mjs'\)/)
  assert.match(benchmark, /execArgv: refreshWorkerExecArgv\(process\.execArgv\)/)
  assert.match(refreshWrapper, /rawSourceWorkerCommand\(inputPath, outputPath\)/)
})
