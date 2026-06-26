import assert from 'node:assert/strict'
import test from 'node:test'
import handler, { isAuthorizedCronRequest } from '../api/recalculate-rankings.ts'

test('cron auth requires the configured bearer secret', () => {
  assert.equal(isAuthorizedCronRequest(undefined, undefined), false)
  assert.equal(isAuthorizedCronRequest(undefined, 'secret'), false)
  assert.equal(isAuthorizedCronRequest('Bearer wrong', 'secret'), false)
  assert.equal(isAuthorizedCronRequest('Bearer secret', 'secret'), true)
})

test('cron reports no-data snapshots unless seeded fallback is explicitly allowed', async () => {
  const previousEnv = { ...process.env }
  process.env.CRON_SECRET = 'secret'
  delete process.env.ORACLES_ELIXIR_CSV_URL
  delete process.env.LEAGUEPEDIA_MATCHES_JSON_URL
  delete process.env.ALLOW_SEEDED_SNAPSHOT
  delete process.env.BLOB_READ_WRITE_TOKEN

  try {
    const unauthenticated = await callHandler({ authorization: undefined, userAgent: 'vercel-cron/1.0' })
    assert.equal(unauthenticated.statusCode, 401)
    assert.deepEqual(unauthenticated.body, { ok: false, error: 'Unauthorized' })

    const noPublicRows = await callHandler({ authorization: 'Bearer secret' })
    assert.equal(noPublicRows.statusCode, 200)
    assert.equal(noPublicRows.body.ok, true)
    assert.equal(noPublicRows.body.dataMode, 'no-data')
    assert.equal(noPublicRows.body.source, 'no public match data available')
    assert.match(String(noPublicRows.body.warning), /not published/)

    process.env.ALLOW_SEEDED_SNAPSHOT = 'true'
    const allowedDemo = await callHandler({ authorization: 'Bearer secret' })
    assert.equal(allowedDemo.statusCode, 200)
    assert.equal(allowedDemo.body.ok, true)
    assert.equal(allowedDemo.body.dataMode, 'seeded-sample')
    assert.match(String(allowedDemo.body.warning), /never published/)
    assert.match(String(allowedDemo.body.modelVersion), /^transparent-gpr-v/)
  } finally {
    process.env = previousEnv
  }
})

async function callHandler({ authorization, userAgent }: { authorization?: string; userAgent?: string }) {
  const response = new MockResponse()
  await handler(
    {
      method: 'GET',
      headers: {
        authorization,
        'user-agent': userAgent,
      },
    },
    response,
  )
  return response
}

class MockResponse {
  statusCode = 200
  body: Record<string, unknown> = {}
  headers: Record<string, string> = {}

  status(code: number) {
    this.statusCode = code
    return this
  }

  json(value: unknown) {
    this.body = value as Record<string, unknown>
  }

  setHeader(name: string, value: string) {
    this.headers[name] = value
  }
}
