import { createSessionToken, passwordMatches, SESSION_COOKIE, SESSION_TTL_SECONDS } from './session.ts'

const attempts = new Map<string, { count: number; resetAt: number }>()
const WINDOW_MS = 15 * 60 * 1000

export async function login(request: Request, ip: string): Promise<Response> {
  const now = Date.now()
  for (const [key, state] of attempts) if (state.resetAt <= now) attempts.delete(key)
  const state = attempts.get(ip)
  if ((state && state.count >= 5) || (!state && attempts.size >= 10_000)) {
    return Response.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }
  const body: unknown = await request.json().catch(() => null)
  const password = body && typeof body === 'object' && 'password' in body && typeof body.password === 'string'
    ? body.password.slice(0, 256) : ''
  if (!await passwordMatches(password)) {
    attempts.set(ip, { count: (state?.count ?? 0) + 1, resetAt: state?.resetAt ?? now + WINDOW_MS })
    return Response.json({ error: 'Invalid prototype password.' }, { status: 401 })
  }
  if (!process.env.PROTOTYPE_SESSION_SECRET) {
    return Response.json({ error: 'Prototype access is not configured.' }, { status: 503 })
  }
  attempts.delete(ip)
  return Response.json({ ok: true }, { headers: { 'set-cookie': sessionCookie(await createSessionToken(), SESSION_TTL_SECONDS) } })
}

export function sessionCookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${!['development', 'test'].includes(process.env.NODE_ENV ?? '') ? '; Secure' : ''}`
}
