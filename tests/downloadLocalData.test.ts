import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

test('local data download manifest records Oracle primary and Leaguepedia backup roles', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-data-'))
  const manifestPath = join(tempDir, 'manifest.json')
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/csv' })
    response.end('gameid,datacompleteness\noe-test,complete\n')
  })

  try {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address() as AddressInfo

    await execFileAsync(process.execPath, [
      'scripts/download-local-data.mjs',
      '--out-dir',
      tempDir,
      '--manifest',
      manifestPath,
      '--oracle-csv-url',
      `http://127.0.0.1:${port}/oracle.csv`,
      '--oracle-drive',
      'false',
      '--leaguepedia',
      'false',
      '--riot-gpr',
      'false',
    ], { cwd: process.cwd(), maxBuffer: 1024 * 1024 })

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.equal(manifest.sources.oracle.role, 'primary')
    assert.equal(manifest.sources.oracle.status, 'downloaded')
    assert.equal(manifest.sources.leaguepedia.role, 'backup-gap-fill')
    assert.equal(manifest.sources.leaguepedia.status, 'skipped')
    assert.equal(manifest.files.oracleCsv.length, 1)
    assert.deepEqual(manifest.files.leaguepediaJson, [])
    assert.match(await readFile(manifest.files.oracleCsv[0], 'utf8'), /oe-test/)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    await rm(tempDir, { recursive: true, force: true })
  }
})
