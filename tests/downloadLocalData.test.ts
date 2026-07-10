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
      '--lolesports',
      'false',
      '--riot-gpr',
      'false',
    ], { cwd: process.cwd(), maxBuffer: 1024 * 1024 })

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.equal(manifest.sources.oracle.role, 'primary')
    assert.equal(manifest.sources.oracle.status, 'downloaded')
    assert.equal(manifest.sources.leaguepedia.role, 'backup-gap-fill')
    assert.equal(manifest.sources.leaguepedia.status, 'skipped')
    assert.equal(manifest.sources.lolesports.role, 'schedule-results-reference')
    assert.equal(manifest.sources.lolesports.status, 'skipped')
    assert.equal(manifest.files.oracleCsv.length, 1)
    assert.deepEqual(manifest.files.leaguepediaJson, [])
    assert.deepEqual(manifest.files.lolEsportsJson, [])
    assert.equal('riotGprJson' in manifest.files, false)
    assert.equal('riotGpr' in manifest.sources, false)
    assert.match(await readFile(manifest.files.oracleCsv[0], 'utf8'), /oe-test/)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('LoL Esports reference download failure is warning-only unless required', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-data-'))
  const manifestPath = join(tempDir, 'manifest.json')
  const server = createServer((_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' })
    response.end('{"error":"temporarily unavailable"}\n')
  })

  try {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address() as AddressInfo
    const lolesportsBaseUrl = `http://127.0.0.1:${port}`

    await execFileAsync(process.execPath, [
      'scripts/download-local-data.mjs',
      '--out-dir',
      tempDir,
      '--manifest',
      manifestPath,
      '--oracle',
      'false',
      '--leaguepedia',
      'false',
      '--lolesports-base-url',
      lolesportsBaseUrl,
      '--lolesports-older-pages',
      '0',
      '--lolesports-newer-pages',
      '0',
      '--lolesports-detail-limit',
      '0',
      '--riot-gpr',
      'false',
    ], { cwd: process.cwd(), maxBuffer: 1024 * 1024 })

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.equal(manifest.sources.lolesports.status, 'failed')
    assert.equal(manifest.sources.lolesports.failedCount, 1)
    assert.deepEqual(manifest.files.lolEsportsJson, [])
    assert.match(manifest.warnings.join('\n'), /LoL Esports schedule reference was not downloaded/)

    await assert.rejects(
      execFileAsync(process.execPath, [
        'scripts/download-local-data.mjs',
        '--out-dir',
        tempDir,
        '--manifest',
        join(tempDir, 'required-manifest.json'),
        '--oracle',
        'false',
        '--leaguepedia',
        'false',
        '--lolesports-base-url',
        lolesportsBaseUrl,
        '--lolesports-required',
        'true',
        '--riot-gpr',
        'false',
      ], { cwd: process.cwd(), maxBuffer: 1024 * 1024 }),
      /LoL Esports schedule reference download is required but failed/,
    )
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('Oracle HTML quota failure still allows Leaguepedia fallback download', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'lol-ranking-data-'))
  const manifestPath = join(tempDir, 'manifest.json')
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/oracle.csv') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html><head><title>Google Drive - Quota exceeded</title></head><body>quota</body></html>')
      return
    }

    if (url.pathname === '/api.php') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(`${JSON.stringify({
        cargoquery: [{
          title: {
            OverviewPage: 'LCK 2026',
            Team1: 'Blue',
            Team2: 'Red',
            WinTeam: 'Blue',
            LossTeam: 'Red',
            'DateTime UTC': '2026-07-08 12:00:00',
            Patch: '16.1',
            GameId: 'leaguepedia-game-1',
            Team1Kills: '10',
            Team2Kills: '5',
            Team1Gold: '50000',
            Team2Gold: '45000',
          },
        }],
      })}\n`)
      return
    }

    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"error":"not found"}\n')
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
      '--start',
      '2026-07-08',
      '--end',
      '2026-07-08',
      '--oracle-csv-url',
      `http://127.0.0.1:${port}/oracle.csv`,
      '--oracle-drive',
      'false',
      '--leaguepedia-base-url',
      `http://127.0.0.1:${port}/api.php`,
      '--lolesports',
      'false',
      '--riot-gpr',
      'false',
    ], { cwd: process.cwd(), maxBuffer: 1024 * 1024 })

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.equal(manifest.sources.oracle.status, 'failed')
    assert.equal(manifest.sources.oracle.downloadedThisRun, 0)
    assert.equal(manifest.sources.oracle.failedThisRun, 1)
    assert.equal(manifest.sources.leaguepedia.status, 'downloaded')
    assert.equal(manifest.sources.leaguepedia.downloadedThisRun, 1)
    assert.equal(manifest.sources.leaguepedia.failedThisRun, 0)
    assert.deepEqual(manifest.files.oracleCsv, [])
    assert.equal(manifest.files.leaguepediaJson.length, 1)
    assert.match(manifest.warnings.join('\n'), /download returned HTML \(Google Drive - Quota exceeded\)/)
    assert.doesNotMatch(manifest.warnings.join('\n'), /Leaguepedia backup download skipped/)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    await rm(tempDir, { recursive: true, force: true })
  }
})
