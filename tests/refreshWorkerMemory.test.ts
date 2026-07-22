import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  REFRESH_WORKER_MAX_OLD_SPACE_MB,
  REFRESH_WORKER_MAX_SEMI_SPACE_MB,
  refreshWorkerArgs,
  refreshWorkerExecArgv,
} from '../scripts/refresh-worker-memory.mjs'

test('refresh worker memory flags are canonical and deduplicate inherited variants', () => {
  assert.equal(REFRESH_WORKER_MAX_OLD_SPACE_MB, 384)
  assert.equal(REFRESH_WORKER_MAX_SEMI_SPACE_MB, 8)
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
})

test('Railway, direct, and benchmark entry points share the exact refresh memory policy', async () => {
  const [packageJson, runner, once, server, benchmark] = await Promise.all([
    readFile('package.json', 'utf8'),
    readFile('scripts/run-refresh-worker.mjs', 'utf8'),
    readFile('scripts/refresh-once.mjs', 'utf8'),
    readFile('scripts/railway-server.mjs', 'utf8'),
    readFile('scripts/benchmark-incremental-ranking.ts', 'utf8'),
  ])
  assert.match(packageJson, /"railway:refresh": "node scripts\/run-refresh-worker\.mjs"/)
  assert.match(runner, /refreshWorkerArgs\('scripts\/refresh-data-if-changed\.mjs', process\.argv\.slice\(2\)\)/)
  assert.match(once, /refreshWorkerArgs\('scripts\/refresh-data-if-changed\.mjs'\)/)
  assert.match(server, /refreshWorkerArgs\(refreshScript\)/)
  assert.match(benchmark, /execArgv: refreshWorkerExecArgv\(process\.execArgv\)/)
})
