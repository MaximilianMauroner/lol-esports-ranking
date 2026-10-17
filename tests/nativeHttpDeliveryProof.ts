import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { httpRead, nativeServer, nodeLocalServer } from './nativeHttpHelpers.ts'

const digest = 'a'.repeat(64)
const summaryCache = 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600, stale-if-error=86400'
const dataCache = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800, stale-if-error=604800'
const immutableCache = 'public, max-age=31536000, immutable'

async function transportFixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-delivery-'))
  await mkdir(join(root, 'objects/sha256'), { recursive: true })
  const files = new Map([
    ['ranking-summary.json', Buffer.from('{"source":"synthetic-test"}\n')],
    ['large.json', Buffer.from(JSON.stringify({ synthetic: 'x'.repeat(4096) }))],
    ['small.json', Buffer.alloc(1023, 32)], ['threshold.json', Buffer.alloc(1024, 32)],
    [`objects/sha256/${digest}`, Buffer.alloc(2048, 97)], ['objects/sha256/invalid', Buffer.from('ordinary data')],
    ['a%20b.json', Buffer.from('literal encoded filename')], ['a b.json', Buffer.from('decoded filename')],
    ['a%2520b.json', Buffer.from('double encoded filename')],
    ...['css', 'html', 'ico', 'js', 'json', 'webmanifest', 'png', 'svg', 'txt', 'webp', 'xml', 'unknown'].map((extension): [string, Buffer] => [`mime.${extension}`, Buffer.alloc(2048, 120)]),
  ])
  for (const [name, body] of files) {
    await writeFile(join(root, name), body)
    await utimes(join(root, name), 1_700_000_000.1239, 1_700_000_000.1239)
  }
  return { root, files }
}

test('native local GET, HEAD, validators, MIME and gzip agree with Node sockets', async (t) => {
  const { root, files } = await transportFixture()
  const native = await nativeServer(root)
  const node = await nodeLocalServer(root)
  let comparisons = 0
  try {
    const compare = async (path: string, options: { method?: string; headers?: Record<string, string> } = {}) => {
      const reference = await httpRead(node.port, path, options)
      const actual = await httpRead(native.port, path, options)
      assert.equal(actual.status, reference.status, path)
      for (const header of ['content-type', 'cache-control', 'etag', 'last-modified', 'vary', 'content-encoding', 'content-length', 'x-robots-tag']) {
        assert.equal(actual.headers[header], reference.headers[header], `${path} ${header}`)
      }
      const unpack = (value: typeof actual) => value.headers['content-encoding'] === 'gzip' ? gunzipSync(value.body) : value.body
      assert.deepEqual(unpack(actual), unpack(reference), path)
      comparisons += 1
      return actual
    }
    for (const [name, bytes] of files) {
      const path = `/data/${name.replace(' ', '%20')}`
      const actual = await compare(path)
      if (!name.includes(' ')) assert.deepEqual(actual.body, bytes)
      const head = await compare(path, { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } })
      assert.equal(head.body.length, 0)
      assert.equal(head.headers['content-encoding'], undefined)
    }
    assert.equal((await compare('/data/ranking-summary.json')).headers['cache-control'], summaryCache)
    assert.equal((await compare('/data/large.json')).headers['cache-control'], dataCache)
    assert.equal((await compare(`/data/objects/sha256/${digest}`)).headers['cache-control'], immutableCache)
    for (const encoding of ['', 'identity', 'gzip', 'gzip;q=0', 'gzip;q=0.5', 'gzip;q=0.000', 'GZIP', '*', 'gzip;q=1,gzip;q=0', 'br, gzip', 'gzip;q=0.9', 'x-gzip']) {
      for (const path of ['/data/small.json', '/data/threshold.json', '/data/large.json', `/data/objects/sha256/${digest}`]) {
        await compare(path, { headers: { 'accept-encoding': encoding } })
      }
    }
    const baseline = await compare('/data/large.json')
    const etag = String(baseline.headers.etag)
    const modified = String(baseline.headers['last-modified'])
    const conditionals: Record<string, string>[] = [
      { 'if-none-match': etag }, { 'if-none-match': etag.replace(/^W\//, '') }, { 'if-none-match': etag.replace(/^W\//, 'w/') },
      { 'if-none-match': `"mismatch", ${etag}` }, { 'if-none-match': '*' }, { 'if-none-match': '"mismatch"' },
      { 'if-none-match': '', 'if-modified-since': modified }, { 'if-modified-since': modified },
      { 'if-modified-since': 'Tuesday, 14-Nov-23 22:13:20 GMT' }, { 'if-modified-since': 'Tue Nov 14 22:13:20 2023' },
      { 'if-modified-since': 'Tue, 14 Nov 2023 22:13:19 GMT' }, { 'if-modified-since': 'invalid' },
      { 'if-none-match': '"mismatch"', 'if-modified-since': 'Tue, 14 Nov 2034 22:13:20 GMT' },
    ]
    for (const headers of conditionals) {
      for (const method of ['GET', 'HEAD']) {
        const response = await compare('/data/large.json', { method, headers: { ...headers, 'accept-encoding': 'gzip' } })
        if (response.status === 304) {
          assert.equal(response.body.length, 0)
          assert.equal(response.headers['content-encoding'], undefined)
          assert.equal(response.headers['content-length'], undefined)
        }
      }
    }
    await utimes(join(root, 'large.json'), new Date(-1), new Date(-1))
    const preEpoch = await compare('/data/large.json')
    assert.match(String(preEpoch.headers.etag), /--1"$/)
    await compare('/data/large.json', { headers: { 'if-modified-since': String(preEpoch.headers['last-modified']) } })
    t.diagnostic(JSON.stringify({ case: 'local-http-parity', comparisons }))
  } finally {
    await node.close()
    await native.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('native raw paths preserve Node normalization and immutable guards', async (t) => {
  const { root } = await transportFixture()
  const native = await nativeServer(root)
  const node = await nodeLocalServer(root)
  const paths = [
    '/data/', '/data//large.json', '/data/large.json/', '/data/dir/../large.json', '/data/%2e/large.json', '/data/dir/%2e%2e/large.json',
    '/data/a%20b.json', '/data/a%2520b.json', '/data/a%2fb.json', '/data/a%5cb.json', '/data/%', '/data/%GG', '/data/%C0%AF',
    '/data/large.json?v=fixture&delivery=proxy&cache-repair=1', '/data/objects/sha256/invalid', `/data/objects/sha256/${digest.toUpperCase()}`,
    `/data/objects/sha256/${digest}`, `/data/./objects/sha256/${digest}`, `/data/%6fbjects/sha256/${digest}`,
    `/data/%256fbjects/sha256/${digest}`, `/data/objects%2fsha256/${digest}`, `/data/objects/sha256/%61${digest.slice(1)}`,
    `http://localhost/data/objects/sha256/${digest}`, 'http://localhost/data/large.json', '/data/objects/sha256/short',
  ]
  try {
    for (const path of paths) {
      const actual = await httpRead(native.port, path)
      const reference = await httpRead(node.port, path)
      assert.equal(actual.status, reference.status, path)
      if (actual.status === 200) assert.deepEqual(actual.body, reference.body, path)
      else {
        assert.deepEqual(JSON.parse(actual.body.toString()), JSON.parse(reference.body.toString()), path)
        assert.equal(actual.headers['cache-control'], 'no-store')
        assert.equal(actual.body.at(-1), 10)
      }
    }
    const head = await httpRead(native.port, '/data/%', { method: 'HEAD' })
    assert.equal(head.status, 400)
    assert.equal(head.body.length, 0)
    t.diagnostic(JSON.stringify({ case: 'raw-path-parity', paths }))
  } finally {
    await node.close()
    await native.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('native existing cache and gzip environment controls retain their scope', async () => {
  const { root } = await transportFixture()
  const server = await nativeServer(root, { RANKING_DATA_CACHE_CONTROL: 'private, max-age=12', RANKING_DATA_MANIFEST_CACHE_CONTROL: 'no-cache', RANKING_GZIP_ENABLED: 'false' })
  try {
    assert.equal((await httpRead(server.port, '/data/ranking-summary.json')).headers['cache-control'], 'no-cache')
    assert.equal((await httpRead(server.port, '/data/large.json')).headers['cache-control'], 'private, max-age=12')
    assert.equal((await httpRead(server.port, `/data/objects/sha256/${digest}`)).headers['cache-control'], immutableCache)
    assert.equal((await httpRead(server.port, '/data/large.json', { headers: { 'accept-encoding': 'gzip' } })).headers['content-encoding'], undefined)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})
