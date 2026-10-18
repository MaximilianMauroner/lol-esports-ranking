import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { channel } from 'node:diagnostics_channel'
import { errorMonitor, type EventEmitter } from 'node:events'
import { access } from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { createServer, type Socket } from 'node:net'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export function fixtureEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC', ...extra }
}

export function sdkErrorDiagnostic(error: unknown) {
  function field(value: unknown, name: string): unknown {
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[name] : undefined
  }
  function token(value: unknown) {
    return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value) ? value : null
  }
  function number(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  const metadata = field(error, '$metadata')
  return {
    class: token(error instanceof Error ? error.constructor.name : undefined),
    name: token(field(error, 'name')),
    code: token(field(error, 'code')),
    causeCode: token(field(field(error, 'cause'), 'code')),
    $metadata: {
      httpStatusCode: number(field(metadata, 'httpStatusCode')),
      attempts: number(field(metadata, 'attempts')),
      totalRetryDelay: number(field(metadata, 'totalRetryDelay')),
    },
    $response: { statusCode: number(field(field(error, '$response'), 'statusCode')) },
  }
}

type TransportEvent =
  | { event: 'request-created' | 'request-finish' | 'request-close' | 'response-end' | 'response-aborted'
      | 'response-close' | 'socket-end' | 'socket-free' }
  | { event: 'request-socket'; reusedSocket: boolean; destroyed: boolean; readableEnded: boolean }
  | { event: 'response'; statusCode: number | null; connection: 'absent' | 'close' | 'keep-alive' | 'other' }
  | { event: 'request-error' | 'socket-error' | 'response-error'; code: string | null }
  | { event: 'socket-close'; hadError: boolean }
type TransportContext = { operation: string; requestId: number; socketId: number | null }

export function observeHttpTransport() {
  const scope = new AsyncLocalStorage<string>()
  const started = performance.now()
  const events: (TransportContext & TransportEvent & { sequence: number; elapsedMs: number })[] = []
  const sockets = new WeakMap<Socket, { id: number; current: TransportContext }>()
  const detach: (() => void)[] = []
  let sequence = 0
  let requests = 0
  let socketCount = 0
  let dropped = 0
  function record(context: TransportContext, event: TransportEvent) {
    sequence += 1
    if (events.length < 512) events.push({ ...context, ...event, sequence, elapsedMs: Math.round(performance.now() - started) })
    else dropped += 1
  }
  function listen(emitter: EventEmitter, event: string | symbol, listener: Parameters<EventEmitter['on']>[1]) {
    emitter.on(event, listener)
    detach.push(() => emitter.off(event, listener))
  }
  const created = channel('http.client.request.created')
  function onRequest(message: unknown) {
    const operation = scope.getStore()
    if (operation === undefined) return
    const { request } = message as { request: ClientRequest }
    const context: TransportContext = { operation, requestId: ++requests, socketId: null }
    record(context, { event: 'request-created' })
    listen(request, errorMonitor, (error: unknown) => record(context, { event: 'request-error', code: sdkErrorDiagnostic(error).code }))
    listen(request, 'finish', () => record(context, { event: 'request-finish' }))
    listen(request, 'close', () => record(context, { event: 'request-close' }))
    listen(request, 'socket', (socket: Socket) => {
      let state = sockets.get(socket)
      if (!state) {
        state = { id: ++socketCount, current: context }
        sockets.set(socket, state)
        const observed = state
        listen(socket, 'end', () => record(observed.current, { event: 'socket-end' }))
        listen(socket, 'free', () => record(observed.current, { event: 'socket-free' }))
        listen(socket, errorMonitor, (error: unknown) => record(observed.current, { event: 'socket-error', code: sdkErrorDiagnostic(error).code }))
        listen(socket, 'close', (hadError: boolean) => record(observed.current, { event: 'socket-close', hadError }))
      }
      state.current = context
      context.socketId = state.id
      record(context, { event: 'request-socket', reusedSocket: request.reusedSocket,
        destroyed: socket.destroyed, readableEnded: socket.readableEnded })
    })
    listen(request, 'response', (response: IncomingMessage) => {
      const value = response.headers.connection?.toLowerCase().split(',').map((token: string) => token.trim())
      const connection = value === undefined ? 'absent' : value.includes('close') ? 'close'
        : value.includes('keep-alive') ? 'keep-alive' : 'other'
      record(context, { event: 'response', statusCode: response.statusCode ?? null, connection })
      listen(response, 'end', () => record(context, { event: 'response-end' }))
      listen(response, 'aborted', () => record(context, { event: 'response-aborted' }))
      listen(response, 'close', () => record(context, { event: 'response-close' }))
      listen(response, errorMonitor, (error: unknown) => record(context, { event: 'response-error', code: sdkErrorDiagnostic(error).code }))
    })
  }
  created.subscribe(onRequest)
  return {
    run<T>(operation: string, request: () => T): T {
      assert.match(operation, /^[a-z][a-z0-9-]{0,39}$/)
      return scope.run(operation, request)
    },
    snapshot: () => ({ events: [...events], dropped }),
    close() {
      created.unsubscribe(onRequest)
      for (const remove of detach.splice(0)) remove()
      scope.disable()
    },
  }
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
