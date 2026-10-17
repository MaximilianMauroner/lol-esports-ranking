import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { httpRead, nativeServer } from './nativeHttpHelpers.ts'

test('native CLI rejects unsafe roots, nonloopback addresses and invalid options', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-cli-'))
  const binary = process.env.RANKING_NATIVE_HTTP_BINARY
  assert.ok(binary, 'RANKING_NATIVE_HTTP_BINARY is required')
  const run = promisify(execFile)
  try {
    await mkdir(join(root, 'real'))
    await symlink(join(root, 'real'), join(root, 'link'))
    const help = await run(binary, ['--help'])
    assert.match(help.stdout, /127\.0\.0\.1:4174/)
    for (const args of [
      ['--bogus'], ['--listen'], ['--listen', '0.0.0.0:0'], ['--listen', '[::]:0'],
      ['--listen', '127.0.0.1:0', '--listen', '127.0.0.1:1'],
      ['--data-root', join(root, 'missing')], ['--data-root', join(root, 'link')],
      ['--data-root', join(root, 'link/child')],
    ]) {
      await assert.rejects(run(binary, args, { timeout: 5_000 }), undefined, args.join(' '))
    }
    await assert.rejects(run(binary, ['--data-root', root, '--listen', '127.0.0.1:0'], {
      env: { ...process.env, RANKING_DATA_CACHE_CONTROL: 'bad\nheader' }, timeout: 5_000,
    }))
    const relative = await nativeServer(join(root, 'real/../real'))
    await relative.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('native local lifecycle has scoped readiness and clean signal termination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-http-'))
  const server = await nativeServer(root)
  try {
    assert.deepEqual(JSON.parse((await httpRead(server.port, '/api/live')).body.toString()), { ok: true, commit: 'native-fixture' })
    assert.equal((await httpRead(server.port, '/api/ready')).status, 503)
    await writeFile(join(root, 'ranking-summary.json'), '{}')
    const ready = await httpRead(server.port, '/api/ready')
    assert.equal(ready.status, 200)
    assert.deepEqual(JSON.parse(ready.body.toString()), { ok: true, scope: 'local-data', data: 'local' })
    for (const path of ['/api/live', '/api/ready', '/missing']) {
      assert.equal((await httpRead(server.port, path, { method: 'HEAD' })).body.length, 0)
    }
    assert.equal((await httpRead(server.port, '/api/live', { method: 'POST' })).status, 200)
    assert.equal((await httpRead(server.port, '/data/a', { method: 'POST' })).status, 405)
    await rm(join(root, 'ranking-summary.json'))
    assert.equal((await httpRead(server.port, '/api/ready')).status, 503)
  } finally {
    await server.close('SIGINT')
    await rm(root, { recursive: true, force: true })
  }
  await assert.rejects(httpRead(server.port, '/api/live'))
})
