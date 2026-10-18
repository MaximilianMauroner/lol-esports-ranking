import { createServer, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

export type UpstreamReply =
  | { kind: 'bytes'; status: number; headers?: Record<string, string>; body: Buffer }
  | { kind: 'redirect'; status: 301 | 302 | 303 | 307 | 308; location: string }
  | { kind: 'stream'; status: number; headers?: Record<string, string>; intervalMs: number }
  | { kind: 'stall' }

export async function maliciousUpstream(reply: UpstreamReply) {
  let closing = false
  let closedSockets = 0
  const sockets = new Set<Socket>()
  const socketClosures = new Map<Socket, Promise<void>>()
  const timers = new Set<NodeJS.Timeout>()
  const requests: { method: string; path: string; signed: boolean; sessionToken: boolean }[] = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? '', path: (request.url ?? '').split('?')[0],
      signed: request.headers.authorization !== undefined,
      sessionToken: request.headers['x-amz-security-token'] !== undefined })
    if (reply.kind === 'stall') return
    if (reply.kind === 'redirect') {
      response.writeHead(reply.status, { Location: reply.location })
      response.end()
      return
    }
    response.writeHead(reply.status, reply.headers)
    if (reply.kind === 'bytes') { response.end(reply.body); return }
    response.flushHeaders()
    stream(response, reply.intervalMs)
  })
  function stream(response: ServerResponse, intervalMs: number) {
    const deadline = Date.now() + 30_000
    const timer = setInterval(() => {
      if (Date.now() >= deadline) response.destroy()
      else if (response.writableLength < 16_384) response.write(Buffer.alloc(1024, 120))
    }, intervalMs)
    timers.add(timer)
    response.once('close', () => { clearInterval(timer); timers.delete(timer) })
  }
  server.on('connection', socket => {
    sockets.add(socket)
    const closed = new Promise<void>(resolve => socket.once('close', () => {
      sockets.delete(socket)
      socketClosures.delete(socket)
      closedSockets += 1
      resolve()
    }))
    socketClosures.set(socket, closed)
    if (closing) socket.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback fixture listener')
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    observe: () => ({ openSockets: sockets.size, closedSockets, timers: timers.size }),
    async close() {
      closing = true
      for (const timer of timers) clearInterval(timer)
      timers.clear()
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      for (const socket of sockets) socket.destroy()
      await closed
      await Promise.all(socketClosures.values())
    },
  }
}
