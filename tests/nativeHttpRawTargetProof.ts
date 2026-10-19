import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Agent, request } from 'node:http'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { httpRead, nativeServer, nodeLocalServer } from './nativeHttpHelpers.ts'

type Expected = { status: number; body: Buffer; cache: string }
type Response = Awaited<ReturnType<typeof httpRead>>

const objectBytes = Buffer.from('synthetic immutable object\n')
const digest = createHash('sha256').update(objectBytes).digest('hex')
const canonical = `/data/objects/sha256/${digest}`
const summary = Buffer.from('{"source":"synthetic-test"}\n')
const immutable: Expected = { status: 200, body: objectBytes, cache: 'public, max-age=31536000, immutable' }
const rejected: Expected = { status: 400, body: Buffer.from('{"ok":false,"error":"Invalid data path"}\n'), cache: 'no-store' }
const summaryResult: Expected = {
  status: 200, body: summary,
  cache: 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600, stale-if-error=86400',
}
const targets: [string, Expected][] = [
  [canonical, immutable],
  [`${canonical}#fragment`, rejected],
  [`${canonical}?query#fragment`, immutable],
  [`${canonical}?query=%23fragment`, immutable],
  [`${canonical}#fragment?query`, rejected],
  [`http://local${canonical}`, rejected],
  [`http://local${canonical}#fragment`, rejected],
  [`http://local${canonical}?query#fragment`, rejected],
  ['http://local/data/ranking-summary.json', summaryResult],
  [canonical.replace('objects', '%6fbjects'), rejected],
  [canonical.replace('objects', '%256fbjects'), rejected],
  [canonical.replace('objects/sha256', 'objects%2fsha256'), rejected],
  [`/data/objects/sha256/%${digest.charCodeAt(0).toString(16)}${digest.slice(1)}`, rejected],
  [`${canonical}%23fragment`, rejected],
  [`/data/./objects/sha256/${digest}`, rejected],
  [`/data/x/../objects/sha256/${digest}`, rejected],
  [`/data/%2e/objects/sha256/${digest}`, rejected],
]

function assertResponse(actual: Response, expected: Expected, label: string) {
  assert.equal(actual.status, expected.status, label)
  assert.deepEqual(actual.body, expected.body, `${label} body`)
  assert.equal(actual.headers['cache-control'], expected.cache, `${label} cache`)
  assert.equal(actual.headers['content-encoding'], undefined, `${label} encoding`)
  assert.equal(actual.headers.location, undefined, `${label} redirect`)
}

async function reusedRead(port: number, target: string, agent: Agent) {
  return new Promise<Response & { socket: Socket }>((accept, reject) => {
    const req = request({ host: '127.0.0.1', port, path: target, agent, signal: AbortSignal.timeout(5_000) }, (response) => {
      const socket = response.socket
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => accept({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks), socket }))
    })
    req.on('error', reject)
    req.end()
  })
}

function get(target: string, close = true) {
  return `GET ${target} HTTP/1.1\r\nHost: local\r\n${close ? 'Connection: close\r\n' : ''}\r\n`
}

async function rawExchange(port: number, pieces: string[]) {
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => {})
  socket.setNoDelay(true)
  const chunks: Buffer[] = []
  socket.on('data', (chunk: Buffer) => chunks.push(chunk))
  let peerEnded = false
  socket.once('end', () => { peerEnded = true })
  const signal = AbortSignal.timeout(5_000)
  const closed = once(socket, 'close', { signal })
  void closed.catch(() => {})
  try {
    await once(socket, 'connect', { signal })
    for (let index = 0; index < pieces.length; index += 1) {
      socket.write(pieces[index])
      if (index < pieces.length - 1) await delay(5)
    }
    const [hadError] = await closed
    assert.equal(hadError, false, 'the server must close without a socket error')
    assert.equal(peerEnded, true, 'the server must end the response before close')
    return Buffer.concat(chunks).toString('latin1')
  } finally {
    socket.destroy()
  }
}

function assertControlledResponses(wire: string, expected: Expected[], label: string) {
  const responses = wire.split('HTTP/1.1 ')
  assert.equal(responses.shift(), '', `${label} response prefix`)
  assert.equal(responses.length, expected.length, `${label} response count`)
  for (const [index, result] of expected.entries()) {
    const response = responses[index]
    const boundary = response.indexOf('\r\n\r\n')
    assert.ok(boundary > 0, `${label} response headers`)
    const headers = response.slice(0, boundary).toLowerCase().split('\r\n')
    assert.match(headers[0], new RegExp(`^${result.status} `), `${label} status ${index}`)
    assert.ok(headers.includes(`cache-control: ${result.cache}`), `${label} cache ${index}`)
    assert.ok(headers.includes(`content-length: ${result.body.length}`), `${label} length ${index}`)
    assert.ok(!headers.some((header) => /^(content-encoding|transfer-encoding|location):/.test(header)), `${label} identity response ${index}`)
    assert.deepEqual(Buffer.from(response.slice(boundary + 4), 'latin1'), result.body, `${label} body ${index}`)
  }
}

test('native and Node preserve raw immutable targets across socket reuse and framing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'native-raw-target-'))
  let native: Awaited<ReturnType<typeof nativeServer>> | undefined
  let node: Awaited<ReturnType<typeof nodeLocalServer>> | undefined
  try {
    await mkdir(join(root, 'objects/sha256'), { recursive: true })
    await writeFile(join(root, 'objects/sha256', digest), objectBytes)
    await writeFile(join(root, 'ranking-summary.json'), summary)
    native = await nativeServer(root)
    node = await nodeLocalServer(root)
    for (const [name, server] of [['Node', node], ['native', native]] as const) {
      for (const [target, expected] of targets) {
        const actual = await httpRead(server.port, target)
        assertResponse(actual, expected, `${name} ${target}`)
        t.diagnostic(JSON.stringify({ case: 'raw-target', server: name, target, status: actual.status, cache: actual.headers['cache-control'] }))
      }
      const agent = new Agent({ keepAlive: true, maxSockets: 1 })
      try {
        let socket: Socket | undefined
        for (const [target, expected] of [targets[0], targets[1], targets[2], targets[0]]) {
          const actual = await reusedRead(server.port, target, agent)
          assertResponse(actual, expected, `${name} reused ${target}`)
          if (socket) assert.equal(actual.socket, socket, `${name} must reuse one TCP socket`)
          socket = actual.socket
        }
        t.diagnostic(JSON.stringify({ case: 'raw-target-reuse', server: name, statuses: [200, 400, 200, 200] }))
      } finally {
        agent.destroy()
      }
      const exchanges = [
        { name: 'pipeline', pieces: [get(canonical, false) + get(`${canonical}#fragment`, false) + get(`${canonical}?query#fragment`)], expected: [immutable, rejected, immutable] },
        { name: 'fragmented-target', pieces: [`GET ${canonical}`, '#fra', 'gment HTTP/1.1\r\nHost: lo', 'cal\r\nConnection: close\r\n\r\n'], expected: [rejected] },
        { name: 'fragmented-query', pieces: [`GET ${canonical}?query`, '#frag', 'ment HTTP/1.1\r\nHost: local\r\nConnection: close\r\n\r\n'], expected: [immutable] },
      ]
      for (const exchange of exchanges) {
        assertControlledResponses(await rawExchange(server.port, exchange.pieces), exchange.expected, `${name} ${exchange.name}`)
        t.diagnostic(JSON.stringify({ case: exchange.name, server: name, statuses: exchange.expected.map((result) => result.status) }))
      }
    }
  } finally {
    try {
      await node?.close()
    } finally {
      try {
        await native?.close()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})
