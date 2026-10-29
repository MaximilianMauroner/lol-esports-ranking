import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { handleDpsRequest } from '../../scripts/dps/http.ts'
import { sessionCookie } from '../../scripts/dps/auth/login.ts'
import { createSessionToken, SESSION_COOKIE } from '../../scripts/dps/auth/session.ts'

const saved = {
  PROTOTYPE_ACCESS_PASSWORD: process.env.PROTOTYPE_ACCESS_PASSWORD,
  PROTOTYPE_SESSION_SECRET: process.env.PROTOTYPE_SESSION_SECRET,
}
const password = randomUUID()
const server = createServer((request, response) => {
  void handleDpsRequest(request, response).then((handled) => {
    if (!handled) { response.statusCode = 404; response.end() }
  }, () => { response.statusCode = 500; response.end() })
})
let base = ''

beforeAll(async () => {
  process.env.PROTOTYPE_ACCESS_PASSWORD = password
  process.env.PROTOTYPE_SESSION_SECRET = randomUUID()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture address')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await new Promise<void>((done) => server.close(() => done()))
})

test('all DPS data endpoints require a session before request parsing', async () => {
  for (const path of ['cohort', 'progression', 'simulate']) {
    const response = await fetch(`${base}/api/dps/${path}`, { method: 'POST', body: '{' })
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ error: 'Prototype authentication required.' })
  }
})

test('missing, altered, and expired cookies cannot open the lab', async () => {
  const expired = await createSessionToken(Date.now() - 9 * 60 * 60 * 1000)
  for (const token of ['', 'invalid', expired]) {
    const response = await fetch(`${base}/lab`, { redirect: 'manual', headers: { cookie: `${SESSION_COOKIE}=${token}` } })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/lab/login?next=/lab')
  }
})

test('login sets the retained HttpOnly cookie and logout expires it', async () => {
  const response = await fetch(`${base}/api/dps/auth/login`, { method: 'POST', body: JSON.stringify({ password }) })
  expect(response.status).toBe(200)
  expect(response.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=`)
  expect(response.headers.get('set-cookie')).toContain('HttpOnly')
  expect(response.headers.get('set-cookie')).toContain('SameSite=Lax')
  const logout = await fetch(`${base}/api/dps/auth/logout`, { method: 'POST' })
  expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
})

test('body limits apply to streamed requests without content-length', async () => {
  const token = await createSessionToken()
  const init = {
    method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${token}` },
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(40_000))); controller.close() } }),
    duplex: 'half' as const,
  }
  const response = await fetch(`${base}/api/dps/cohort`, init)
  expect(response.status).toBe(413)
})

test('cross-origin login and unsupported methods fail before data access', async () => {
  const crossOrigin = await fetch(`${base}/api/dps/auth/login`, { method: 'POST', headers: { origin: 'https://other.invalid' }, body: JSON.stringify({ password }) })
  expect(crossOrigin.status).toBe(403)
  const method = await fetch(`${base}/api/dps/auth/login`)
  expect(method.status).toBe(405)
})

test('five failed logins trigger the retained attempt limit', async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${base}/api/dps/auth/login`, { method: 'POST', body: JSON.stringify({ password: 'wrong' }) })
    expect(response.status).toBe(401)
  }
  const limited = await fetch(`${base}/api/dps/auth/login`, { method: 'POST', body: JSON.stringify({ password }) })
  expect(limited.status).toBe(429)
})

test('production cookies are Secure even when NODE_ENV is unset', () => {
  const saved = process.env.NODE_ENV
  try {
    delete process.env.NODE_ENV
    expect(sessionCookie('test', 60)).toContain('; Secure')
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = saved
  }
})
