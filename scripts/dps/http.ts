import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { SESSION_COOKIE, verifySessionToken } from './auth/session.ts'
import { login, sessionCookie } from './auth/login.ts'
import { POST as cohort } from './api/cohort/route.ts'
import { GET as progression } from './api/progression/route.ts'
import { POST as simulate } from './api/simulate/route.ts'

const routes: Record<string, { method: string; limit: number; run: (request: Request) => Promise<Response> }> = {
  '/api/dps/cohort': { method: 'POST', limit: 32_768, run: cohort },
  '/api/dps/progression': { method: 'GET', limit: 0, run: progression },
  '/api/dps/simulate': { method: 'POST', limit: 128_000, run: simulate },
}

export async function handleDpsRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const path = url.pathname
  const isApi = path === '/api/dps' || path.startsWith('/api/dps/')
  const isLab = path === '/lab' || path.startsWith('/lab/')
  if (!isApi && !isLab) return false
  response.setHeader('cache-control', 'private, no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'DENY')
  response.setHeader('referrer-policy', 'same-origin')
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()')
  response.setHeader('cross-origin-opener-policy', 'same-origin')
  if (isLab && path === '/lab/login') return false
  const token = request.headers.cookie?.split(';').map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1)
  const authenticated = await verifySessionToken(token)
  if (isLab) {
    if (authenticated) return false
    response.writeHead(302, { location: '/lab/login?next=/lab' })
    response.end()
    return true
  }
  const authRoute = path === '/api/dps/auth/login' || path === '/api/dps/auth/logout'
  if (!authRoute && !authenticated) {
    send(response, Response.json({ error: 'Prototype authentication required.' }, { status: 401 }))
    return true
  }
  const route = routes[path]
  if (!route && !authRoute) {
    send(response, Response.json({ error: 'Not found.' }, { status: 404 }))
    return true
  }
  if (request.method !== (route?.method ?? 'POST')) {
    send(response, Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { allow: route?.method ?? 'POST' } }))
    return true
  }
  if (request.method === 'POST' && request.headers.origin && (!URL.canParse(request.headers.origin) || new URL(request.headers.origin).host !== url.host)) {
    send(response, Response.json({ error: 'Same-origin request required.' }, { status: 403 }))
    return true
  }
  try {
    const limit = route?.limit ?? 4096
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += Buffer.byteLength(chunk)
      if (size > limit) {
        request.resume()
        send(response, Response.json({ error: 'Request is too large.' }, { status: 413 }))
        return true
      }
      chunks.push(Buffer.from(chunk))
    }
    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    }
    const webRequest = new Request(url, { method: request.method, headers, ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) })
    const result = path === '/api/dps/auth/login'
      ? await login(webRequest, loginClientAddress(request.headers['x-forwarded-for'], request.socket.remoteAddress))
      : path === '/api/dps/auth/logout'
        ? Response.json({ ok: true }, { headers: { 'set-cookie': sessionCookie('', 0) } })
        : await route.run(webRequest)
    response.statusCode = result.status
    result.headers.forEach((value, key) => { if (key !== 'cache-control') response.setHeader(key, value) })
    response.end(Buffer.from(await result.arrayBuffer()))
  } catch {
    send(response, Response.json({ error: 'DPS request failed.' }, { status: 400 }))
  }
  return true
}

function send(response: ServerResponse, result: Response) {
  response.statusCode = result.status
  result.headers.forEach((value, key) => response.setHeader(key, value))
  void result.text().then((body) => response.end(body))
}

export function loginClientAddress(forwarded: string | string[] | undefined, remoteAddress: string | undefined): string {
  const nearest = process.env.DPS_TRUST_PROXY === 'true' && typeof forwarded === 'string'
    ? forwarded.split(',').at(-1)?.trim() : undefined
  return nearest && isIP(nearest) ? nearest : remoteAddress ?? 'unknown'
}
