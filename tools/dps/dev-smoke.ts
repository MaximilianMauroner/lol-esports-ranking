import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'vite'

process.env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: 'test',
  PROTOTYPE_ACCESS_PASSWORD: randomUUID(),
  PROTOTYPE_SESSION_SECRET: randomUUID(),
}
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
try {
  await server.listen()
  const address = server.httpServer?.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  assert.equal((await fetch(`${base}/api/dps/cohort`, { method: 'POST' })).status, 401)
  assert.equal((await fetch(`${base}/lab`, { redirect: 'manual' })).status, 302)
  assert.equal((await fetch(`${base}/lab/login`)).status, 200)
  const login = await fetch(`${base}/api/dps/auth/login`, { method: 'POST', body: JSON.stringify({ password: process.env.PROTOTYPE_ACCESS_PASSWORD }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  const lab = await fetch(`${base}/lab`, { headers: { cookie } })
  assert.equal(lab.status, 200)
  assert.match(await lab.text(), /\/src\/main\.tsx/)
  const cohort = await fetch(`${base}/api/dps/cohort`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ phase: 'yunara-level', level: 13 }) })
  assert.equal(cohort.status, 200)
  assert.equal((await cohort.json() as { dataset: { provenance: string } }).dataset.provenance, 'fixture')
  const progression = await fetch(`${base}/api/dps/progression?level=13`, { headers: { cookie } })
  assert.equal(progression.status, 200)
  assert.equal((await progression.json() as { provenance: string }).provenance, 'fixture')
  for (const worker of ['simulation.worker', 'optimizer.worker']) {
    const response = await fetch(`${base}/src/browser/dps/${worker}.ts`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /javascript/)
  }
  console.log('rift-delta Vite development API, authentication, lab route, and worker assets passed with fixture data')
} finally {
  await server.close()
}
