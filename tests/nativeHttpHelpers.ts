import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access } from 'node:fs/promises'
import { request, type IncomingHttpHeaders } from 'node:http'
import { resolve } from 'node:path'

const nativeBinary = process.env.RANKING_NATIVE_HTTP_BINARY
assert.ok(nativeBinary, 'Build platform-api and set RANKING_NATIVE_HTTP_BINARY explicitly')
await access(nativeBinary)
const nativeBinaryPath = resolve(nativeBinary)

export async function nativeServer(root: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(nativeBinaryPath, ['--data-root', root, '--listen', '127.0.0.1:0'], {
    env: {
      ...process.env,
      RANKING_BUCKET_NAME: 'poison-unrelated-bucket',
      RANKING_BUCKET_ENDPOINT: 'http://127.0.0.1:1',
      RANKING_BUCKET_ACCESS_KEY_ID: 'poison',
      RANKING_BUCKET_SECRET_ACCESS_KEY: 'poison',
      LEAGUEPEDIA_CARGO_EXPORT_URL: 'http://127.0.0.1:1',
      RANKING_REFRESH_ENABLED: 'true',
      RANKING_GZIP_ENABLED: 'true',
      RAILWAY_GIT_COMMIT_SHA: 'native-fixture',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ended = once(child, 'exit')
  void ended.catch(() => {})
  let output = ''
  let errors = ''
  child.stderr.on('data', (chunk) => { errors += String(chunk) })
  const port = await new Promise<number>((accept, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Native startup timed out. ${errors}`))
    }, 10_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Native exited before startup with ${code}. ${errors}`))
    })
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
      if (!output.includes('\n')) return
      try {
        const event = JSON.parse(output.split('\n')[0])
        assert.equal(event.event, 'listening')
        const address = new URL(`http://${event.address}`)
        assert.equal(address.hostname, '127.0.0.1')
        clearTimeout(timer)
        accept(Number(address.port))
      } catch (error) {
        clearTimeout(timer)
        child.kill('SIGKILL')
        reject(error)
      }
    })
  })
  return {
    port,
    child,
    async close(signal: NodeJS.Signals = 'SIGTERM', expectedCode = 0) {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal)
      const timer = setTimeout(() => child.kill('SIGKILL'), 8_000)
      const [code, exitSignal] = await ended
      clearTimeout(timer)
      assert.equal(exitSignal, null, errors)
      assert.equal(code, expectedCode, errors)
    },
  }
}

export function httpRead(port: number, path: string, options: { method?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((accept, reject) => {
    const req = request({ host: '127.0.0.1', port, path, agent: false, ...options }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => accept({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }))
    })
    req.setTimeout(5_000, () => req.destroy(new Error(`HTTP timeout for ${path}`)))
    req.on('error', reject)
    req.end()
  })
}
