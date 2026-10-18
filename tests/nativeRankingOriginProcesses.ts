import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access } from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import { createServer } from 'node:net'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export function fixtureEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC', ...extra }
}

export async function requiredBinary(name: string) {
  const path = process.env[name]
  assert.ok(path && isAbsolute(path), `${name} must name an existing absolute executable path`)
  await access(path, constants.X_OK)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { path, sha256: hash.digest('hex') }
}

export async function unusedLoopbackPort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

export function ownedProcess(binary: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let exited = false
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', error => { exited = true; reject(error) })
    child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }) })
  })
  void completion.catch(() => {})
  child.stdout.resume()
  child.stderr.resume()
  let closing: Promise<void> | undefined
  return {
    async ready(url: string) {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && !exited) {
        try {
          const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(500) })
          await response.body?.cancel()
          if (response.status === 200) return
        } catch { await delay(50) }
        await delay(50)
      }
      throw new Error('Owned fixture did not become ready within 15 seconds')
    },
    close() {
      closing ??= stop(child, completion)
      return closing
    },
  }
}

async function stop(child: ChildProcess, completion: Promise<unknown>) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  const force = setTimeout(() => child.kill('SIGKILL'), 5_000)
  try { await completion } finally { clearTimeout(force) }
}
