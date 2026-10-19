import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

const binary = process.env.RANKING_NATIVE_HTTP_BINARY
assert.ok(binary, 'Build platform-api and set RANKING_NATIVE_HTTP_BINARY')

async function servingPair() {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = (reservation.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  const root = await mkdtemp(join(tmpdir(), 'native-serving-'))
  await mkdir(join(root, 'dist'))
  await mkdir(join(root, 'data'))
  await writeFile(join(root, 'dist/index.html'), '<!doctype html><p>Serving fixture</p>')
  await writeFile(join(root, 'data/ranking-summary.json'), '{"source":"synthetic-lifecycle-test"}')
  const child = spawn(process.execPath, ['scripts/start-serving.mjs'], {
    env: {
      ...process.env, RANKING_NATIVE_HTTP_BINARY: binary, HOST: '127.0.0.1', PORT: String(port), RANKING_REFRESH_ENABLED: 'false',
      RAILWAY_DIST_DIR: join(root, 'dist'), RANKING_PUBLIC_DATA_DIR: join(root, 'data'),
      RANKING_BUCKET_NAME: '', RANKING_BUCKET_ENDPOINT: '', RANKING_BUCKET_ACCESS_KEY_ID: '', RANKING_BUCKET_SECRET_ACCESS_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 12_000)
    await exited
    clearTimeout(timer)
    await rm(root, { recursive: true, force: true })
  }
  try {
    let healthy = false
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, output)
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/live`, { signal: AbortSignal.timeout(1_000) })
        healthy = response.ok
        await response.body?.cancel()
        if (healthy) break
      } catch {
        healthy = false
      }
      await delay(25)
    }
    assert.equal(healthy, true, output)
    const event = output.split('\n').map(line => {
      try { return JSON.parse(line) as { event: string; address: string; pid: number } } catch { return null }
    }).find(value => value?.event === 'listening')
    assert.ok(event, output)
    assert.ok(event.pid > 0)
    assert.notEqual(Number(new URL(`http://${event.address}`).port), port)
    const data = await fetch(`http://127.0.0.1:${port}/data/ranking-summary.json`)
    assert.equal(data.headers.get('x-ranking-runtime'), 'rust')
    assert.equal((await data.json() as { source: string }).source, 'synthetic-lifecycle-test')
    return { child, nativePid: event.pid, exited, close, port }
  } catch (error) {
    await close()
    throw error
  }
}

test('supervised serving avoids the public port and joins both children on termination', { timeout: 20_000 }, async () => {
  const pair = await servingPair()
  try {
    pair.child.kill('SIGTERM')
    assert.equal(await pair.exited, 0)
    assert.throws(() => process.kill(pair.nativePid, 0), { code: 'ESRCH' })
    await assert.rejects(fetch(`http://127.0.0.1:${pair.port}/api/live`))
  } finally {
    await pair.close()
  }
})

test('a native process failure stops public serving and fails the deployment process', { timeout: 20_000 }, async () => {
  const pair = await servingPair()
  try {
    process.kill(pair.nativePid, 'SIGKILL')
    assert.equal(await pair.exited, 1)
    await assert.rejects(fetch(`http://127.0.0.1:${pair.port}/api/live`))
  } finally {
    await pair.close()
  }
})
