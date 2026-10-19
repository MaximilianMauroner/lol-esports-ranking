import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { proxyNativeData } from '../scripts/native-data-proxy.mjs'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

async function close(server) {
  server.closeAllConnections()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

function read(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path, agent: false, ...options }, incoming => {
      const chunks = []
      incoming.on('data', chunk => chunks.push(chunk))
      incoming.once('error', reject)
      incoming.once('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks) }))
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

test('native gateway preserves raw targets, request methods, validators and compressed bytes', async () => {
  const observations = []
  const payload = Buffer.from([31, 139, 0, 255, 128, 1])
  const origin = createServer((incoming, response) => {
    observations.push({ method: incoming.method, target: incoming.url, headers: incoming.headers })
    response.writeHead(200, {
      'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': payload.length,
      'Cache-Control': 'public, max-age=31536000, immutable', ETag: '"origin-etag"', Vary: 'Accept-Encoding',
      Connection: 'close, x-internal', 'X-Internal': 'omit',
    })
    response.end(incoming.method === 'HEAD' ? undefined : payload)
  })
  const originPort = await listen(origin)
  const gateway = createServer((incoming, response) => { void proxyNativeData(incoming, response, originPort) })
  const port = await listen(gateway)
  try {
    const path = '/data/objects/sha256/abc?delivery=proxy&v=generation%2F1#fragment'
    for (const method of ['GET', 'HEAD']) {
      const actual = await read(port, path, { method, headers: {
        'Accept-Encoding': 'gzip;q=0', 'If-None-Match': 'W/"old"', Connection: 'close, x-private', 'X-Private': 'omit',
      } })
      assert.equal(actual.status, 200)
      assert.deepEqual(actual.body, method === 'HEAD' ? Buffer.alloc(0) : payload)
      assert.equal(actual.headers['content-encoding'], 'gzip')
      assert.equal(actual.headers['content-length'], String(payload.length))
      assert.equal(actual.headers.etag, '"origin-etag"')
      assert.equal(actual.headers['x-internal'], undefined)
    }
    assert.deepEqual(observations.map(value => [value.method, value.target]), [['GET', path], ['HEAD', path]])
    for (const observation of observations) {
      assert.equal(observation.headers['accept-encoding'], 'gzip;q=0')
      assert.equal(observation.headers['if-none-match'], 'W/"old"')
      assert.equal(observation.headers['x-private'], undefined)
    }
  } finally {
    await close(gateway)
    await close(origin)
  }
})

test('native gateway returns a controlled unavailable response when its sibling is down', async () => {
  const reservation = createServer()
  const unusedPort = await listen(reservation)
  await close(reservation)
  const gateway = createServer((incoming, response) => { void proxyNativeData(incoming, response, unusedPort) })
  const port = await listen(gateway)
  try {
    for (const method of ['GET', 'HEAD']) {
      const actual = await read(port, '/data/ranking-summary.json?v=pinned', { method })
      assert.equal(actual.status, 502)
      assert.equal(actual.headers['cache-control'], 'no-store')
      assert.equal(actual.headers['content-encoding'], undefined)
      assert.equal(actual.body.toString(), method === 'HEAD' ? '' : '{"ok":false,"error":"Data service unavailable"}\n')
    }
  } finally {
    await close(gateway)
  }
})

test('native gateway labels plain successful data with identity encoding', async () => {
  const payload = Buffer.from('published ranking data\n'.repeat(100))
  const origin = createServer((incoming, response) => {
    if (incoming.url === '/data/unchanged.json') {
      response.writeHead(304, { ETag: '"current"' })
      response.end()
    } else if (incoming.url === '/data/redirect.json') {
      response.writeHead(307, { Location: '/data/target.json', 'Content-Length': 0 })
      response.end()
    } else if (incoming.url === '/data/unavailable.json') {
      response.writeHead(502, { 'Content-Length': 0 })
      response.end()
    } else {
      response.writeHead(200, {
        'Content-Type': 'application/json', 'Content-Length': payload.length, Vary: 'Accept-Encoding',
        ETag: '"current"', 'Cache-Control': 'public, max-age=31536000, immutable',
      })
      response.end(incoming.method === 'HEAD' ? undefined : payload)
    }
  })
  const originPort = await listen(origin)
  const gateway = createServer((incoming, response) => { void proxyNativeData(incoming, response, originPort) })
  const port = await listen(gateway)
  try {
    for (const method of ['GET', 'HEAD']) {
      const actual = await read(port, '/data/plain.json', { method, headers: { 'Accept-Encoding': 'gzip;q=0' } })
      assert.equal(actual.status, 200)
      assert.equal(actual.headers['content-encoding'], 'identity')
      assert.equal(actual.headers['content-length'], String(payload.length))
      assert.equal(actual.headers.vary, 'Accept-Encoding')
      assert.equal(actual.headers.etag, '"current"')
      assert.equal(actual.headers['cache-control'], 'public, max-age=31536000, immutable')
      assert.deepEqual(actual.body, method === 'HEAD' ? Buffer.alloc(0) : payload)
    }
    for (const [path, status] of [['/data/unchanged.json', 304], ['/data/redirect.json', 307], ['/data/unavailable.json', 502]]) {
      const actual = await read(port, path, { headers: { 'Accept-Encoding': 'gzip;q=0' } })
      assert.equal(actual.status, status)
      assert.equal(actual.headers['content-encoding'], undefined)
      assert.equal(actual.body.length, 0)
    }
  } finally {
    await close(gateway)
    await close(origin)
  }
})

test('native gateway cancels a bucket read when the browser disconnects', async () => {
  let disconnected
  const cancelled = new Promise(resolve => { disconnected = resolve })
  let arrived
  const started = new Promise(resolve => { arrived = resolve })
  const origin = createServer(incoming => {
    incoming.once('close', disconnected)
    arrived()
  })
  const originPort = await listen(origin)
  const gateway = createServer((incoming, response) => { void proxyNativeData(incoming, response, originPort) })
  const port = await listen(gateway)
  const outgoing = request({ host: '127.0.0.1', port, path: '/data/ranking-summary.json' })
  outgoing.on('error', () => {})
  try {
    outgoing.end()
    await started
    outgoing.destroy()
    await Promise.race([
      cancelled,
      new Promise((_, reject) => { setTimeout(() => reject(new Error('Origin read was not cancelled')), 2_000).unref() }),
    ])
  } finally {
    outgoing.destroy()
    await close(gateway)
    await close(origin)
  }
})

test('native gateway ends an active response at the absolute delivery deadline', async t => {
  const origin = createServer((incoming, response) => {
    response.writeHead(200, { 'Content-Length': 100 })
    response.write('x')
  })
  const originPort = await listen(origin)
  let completed
  const done = new Promise(resolve => { completed = resolve })
  const gateway = createServer((incoming, response) => { void proxyNativeData(incoming, response, originPort).finally(completed) })
  const port = await listen(gateway)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const outgoing = request({ host: '127.0.0.1', port, path: '/data/slow.json' })
  outgoing.on('error', () => {})
  try {
    const received = once(outgoing, 'response')
    outgoing.end()
    const [incoming] = await received
    const aborted = once(incoming, 'aborted')
    await once(incoming, 'data')
    t.mock.timers.tick(60_000)
    await aborted
    await done
    assert.equal(incoming.complete, false)
  } finally {
    t.mock.timers.reset()
    outgoing.destroy()
    await close(gateway)
    await close(origin)
  }
})
