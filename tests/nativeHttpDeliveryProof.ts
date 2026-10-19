import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, rm, utimes, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { httpRead, nativeServer } from './nativeHttpHelpers.ts'

const digest = 'a'.repeat(64)
const immutableCache = 'public, max-age=31536000, immutable'

async function transportFixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-delivery-'))
  await mkdir(join(root, 'objects/sha256'), { recursive: true })
  const files = new Map([
    ['ranking-summary.json', Buffer.from('{"source":"synthetic-test"}\n')],
    ['large.json', Buffer.from(JSON.stringify({ synthetic: 'x'.repeat(4096) }))],
    ['small.json', Buffer.from('{}')],
    [`objects/sha256/${digest}`, Buffer.alloc(2048, 97)],
    ['objects/sha256/invalid', Buffer.from('must not become a logical artifact')],
    ['a b.json', Buffer.from('decoded space')], ['a%20b.json', Buffer.from('literal percent escape')],
    ['a#b.json', Buffer.from('decoded fragment character')], ['a%23b.json', Buffer.from('literal percent fragment')],
    ['a?b.json', Buffer.from('decoded question character')], ['café.json', Buffer.from('UTF8 filename')],
    ...['css', 'html', 'ico', 'js', 'json', 'webmanifest', 'png', 'svg', 'txt', 'webp', 'xml', 'unknown'].map((extension): [string, Buffer] => [`mime.${extension}`, Buffer.alloc(2048, 120)]),
  ])
  for (const [name, body] of files) {
    await writeFile(join(root, name), body)
    await utimes(join(root, name), 1_700_000_000.1239, 1_700_000_000.1239)
  }
  return { root, files }
}

test('native routes decode once and reserve the canonical immutable namespace', async () => {
  const { root, files } = await transportFixture()
  const server = await nativeServer(root)
  try {
    for (const [path, filename] of [
      ['/data/a%20b.json', 'a b.json'], ['/data/a%2520b.json', 'a%20b.json'],
      ['/data/a%23b.json', 'a#b.json'], ['/data/a%2523b.json', 'a%23b.json'],
      ['/data/a%3Fb.json', 'a?b.json'], ['/data/caf%C3%A9.json', 'café.json'],
    ]) {
      const response = await httpRead(server.port, path)
      assert.equal(response.status, 200, path)
      assert.deepEqual(response.body, files.get(filename), path)
      assert.equal(response.headers['cache-control'], 'no-cache')
    }
    for (const path of [
      '/data/', '/data//large.json', '/data/large.json/', '/data/dir/../large.json',
      '/data/./large.json', '/data/%2e/large.json', '/data/dir/%2e%2e/large.json',
      '/data/a%2fb.json', '/data/a%5cb.json', '/data/a\\b.json', '/data/%', '/data/%GG',
      '/data/%C0%AF', '/data/%FF', '/data/%00', '/data/%1f', '/data/%7f', '/data/%C2%85',
      '/data/objects', '/data/objects/sha256/invalid', `/data/objects/sha256/${digest.toUpperCase()}`,
      `/data/%6fbjects/sha256/${digest}`, `/data/objects/%73ha256/${digest}`,
      `/data/objects/sha256/%61${digest.slice(1)}`, `/data/objects%2fsha256/${digest}`,
      `/data/objects/sha256/${digest}/extra`,
    ]) {
      const response = await httpRead(server.port, path)
      assert.equal(response.status, 400, path)
      assert.equal(response.headers['cache-control'], 'no-store')
    }
    assert.equal((await httpRead(server.port, `/data/%256fbjects/sha256/${digest}`)).status, 404)
    const object = await httpRead(server.port, `/data/objects/sha256/${digest}`)
    assert.equal(object.status, 200)
    assert.deepEqual(object.body, files.get(`objects/sha256/${digest}`))
    assert.equal(object.headers['cache-control'], immutableCache)
    assert.equal((await httpRead(server.port, `/data/objects/sha256/${'b'.repeat(64)}`)).status, 404)
    const head = await httpRead(server.port, '/data/%', { method: 'HEAD' })
    assert.equal(head.status, 400)
    assert.equal(head.body.length, 0)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('native parsed HTTP absolute paths and queries select only the pinned local artifact', async () => {
  const { root } = await transportFixture()
  const server = await nativeServer(root)
  try {
    for (const path of ['/data/large.json', `/data/objects/sha256/${digest}`]) {
      const baseline = await httpRead(server.port, path)
      for (const target of [
        `${path}?v=other&delivery=proxy&cache-repair=1`,
        `http://unreachable.invalid:1${path}`,
        `http://unreachable.invalid:1${path}?generation=another&sign=1`,
      ]) {
        const actual = await httpRead(server.port, target)
        assert.equal(actual.status, 200, target)
        assert.deepEqual(actual.body, baseline.body)
        for (const header of ['cache-control', 'etag', 'last-modified', 'content-type']) {
          assert.equal(actual.headers[header], baseline.headers[header], `${target} ${header}`)
        }
        assert.equal(actual.headers.location, undefined)
      }
    }
    assert.equal((await httpRead(server.port, 'https://unreachable.invalid/data/large.json')).status, 400)
    assert.equal((await httpRead(server.port, '*')).status, 400)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('native identity and gzip negotiation agrees across GET, HEAD and conditional responses', async () => {
  const { root, files } = await transportFixture()
  const server = await nativeServer(root)
  try {
    const cases: [string, number, string | undefined][] = [
      ['', 200, undefined], ['identity', 200, undefined], ['gzip', 200, 'gzip'],
      ['GZIP', 200, 'gzip'], ['gzip;q=0.5', 200, undefined],
      ['gzip;q=0.5, identity;q=0.4', 200, 'gzip'], ['gzip;q=0, identity;q=1', 200, undefined],
      ['gzip;q=0.000', 200, undefined], ['*', 200, 'gzip'], ['*;q=0', 406, undefined],
      ['gzip;q=0,*;q=1', 200, undefined], ['gzip;q=1,identity;q=0', 200, 'gzip'],
      ['gzip;q=0,gzip;q=1,identity;q=0', 406, undefined], ['identity;q=0', 406, undefined],
      ['br, gzip', 200, 'gzip'], ['x-gzip', 200, undefined],
      ['gzip;q=1.001', 200, undefined], ['gzip;q=0.0001,identity;q=0', 406, undefined],
      ['gzip;q=garbage', 200, undefined], ['gzip;q=1;extra=1,identity;q=0', 406, undefined],
    ]
    for (const path of ['/data/small.json', '/data/large.json']) {
      for (const [encoding, status, coding] of cases) {
        const headers = { 'accept-encoding': encoding }
        const get = await httpRead(server.port, path, { headers })
        const head = await httpRead(server.port, path, { method: 'HEAD', headers })
        assert.equal(get.status, status, `${path} ${encoding}`)
        assert.equal(head.status, status, `${path} HEAD ${encoding}`)
        assert.equal(head.body.length, 0)
        for (const header of ['content-type', 'cache-control', 'etag', 'last-modified', 'vary', 'content-encoding', 'content-length']) {
          assert.equal(head.headers[header], get.headers[header], `${encoding} ${header}`)
        }
        assert.equal(get.headers['content-encoding'], coding)
        assert.equal(get.headers.vary, 'Accept-Encoding')
        if (status === 200) {
          assert.deepEqual(coding === 'gzip' ? gunzipSync(get.body) : get.body, files.get(path.slice(6)))
          assert.equal(get.headers['content-length'], coding === 'gzip' ? undefined : String(get.body.length))
        }
      }
    }
    for (const path of ['/data/mime.png', `/data/objects/sha256/${digest}`]) {
      assert.equal((await httpRead(server.port, path, { headers: { 'accept-encoding': 'gzip,identity;q=0' } })).status, 406)
      const get = await httpRead(server.port, path, { headers: { 'accept-encoding': 'gzip' } })
      assert.equal(get.headers['content-encoding'], undefined)
      assert.equal(get.headers.vary, undefined)
    }
    const baseline = await httpRead(server.port, '/data/large.json')
    const etag = String(baseline.headers.etag)
    const modified = String(baseline.headers['last-modified'])
    assert.match(etag, /^W\/"[^"]+"$/)
    const conditionals: [Record<string, string>, number][] = [
      [{ 'if-none-match': etag }, 304], [{ 'if-none-match': etag.replace(/^W\//, '') }, 304],
      [{ 'if-none-match': `"mismatch", ${etag}` }, 304], [{ 'if-none-match': '*' }, 304],
      [{ 'if-none-match': '"mismatch"', 'if-modified-since': modified }, 200],
      [{ 'if-none-match': '', 'if-modified-since': modified }, 200],
      [{ 'if-modified-since': modified }, 304], [{ 'if-modified-since': 'invalid' }, 200],
      [{ 'if-modified-since': 'Tue, 14 Nov 2023 22:13:19 GMT' }, 200],
      [{ 'if-modified-since': 'Tuesday, 14-Nov-23 22:13:20 GMT' }, 304],
      [{ 'if-modified-since': 'Tue Nov 14 22:13:20 2023' }, 304],
    ]
    for (const [conditional, status] of conditionals) {
      for (const method of ['GET', 'HEAD']) {
        for (const encoding of ['identity', 'gzip']) {
          const response = await httpRead(server.port, '/data/large.json', { method, headers: { ...conditional, 'accept-encoding': encoding } })
          assert.equal(response.status, status, JSON.stringify({ conditional, method, encoding }))
          assert.equal(response.headers['content-encoding'], encoding === 'gzip' ? 'gzip' : undefined)
          assert.equal(response.headers.etag, etag)
          assert.equal(response.headers['last-modified'], modified)
          assert.equal(response.headers['cache-control'], 'no-cache')
          assert.equal(response.headers.vary, 'Accept-Encoding')
          if (status === 304) {
            assert.equal(response.body.length, 0)
            assert.equal(response.headers['content-length'], undefined)
          }
        }
      }
    }
    const unacceptable = await httpRead(server.port, '/data/large.json', { headers: { 'accept-encoding': '*;q=0', 'if-none-match': etag } })
    assert.equal(unacceptable.status, 406, 'negotiation must precede conditional evaluation')
    await writeFile(join(root, 'next.json'), files.get('large.json')!)
    await utimes(join(root, 'next.json'), 1_700_000_000.1239, 1_700_000_000.1239)
    await rename(join(root, 'next.json'), join(root, 'large.json'))
    const replacement = await httpRead(server.port, '/data/large.json', { headers: { 'if-none-match': etag } })
    assert.equal(replacement.status, 200)
    assert.notEqual(replacement.headers.etag, etag)
    assert.equal(replacement.headers['last-modified'], modified)
    const ranged = await httpRead(server.port, '/data/large.json', { headers: { range: 'bytes=1-2' } })
    assert.equal(ranged.status, 200)
    assert.deepEqual(ranged.body, files.get('large.json'))
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('native serves MIME metadata and ignores withdrawn environment switches', async () => {
  const { root, files } = await transportFixture()
  const server = await nativeServer(root, {
    RANKING_DATA_CACHE_CONTROL: 'bad\nheader', RANKING_DATA_MANIFEST_CACHE_CONTROL: 'private',
    RANKING_GZIP_ENABLED: 'false', RANKING_PUBLIC_DATA_DIR: '/missing', RAILWAY_GIT_COMMIT_SHA: 'must-not-leak',
  })
  try {
    for (const [extension, type] of [
      ['css', 'text/css; charset=utf-8'], ['html', 'text/html; charset=utf-8'], ['ico', 'image/x-icon'],
      ['js', 'text/javascript; charset=utf-8'], ['json', 'application/json; charset=utf-8'],
      ['webmanifest', 'application/manifest+json; charset=utf-8'], ['png', 'image/png'],
      ['svg', 'image/svg+xml'], ['txt', 'text/plain; charset=utf-8'], ['webp', 'image/webp'],
      ['xml', 'application/xml; charset=utf-8'], ['unknown', 'application/octet-stream'],
    ]) {
      const response = await httpRead(server.port, `/data/mime.${extension}`)
      assert.equal(response.status, 200)
      assert.equal(response.headers['content-type'], type)
      assert.deepEqual(response.body, files.get(`mime.${extension}`))
    }
    assert.equal((await httpRead(server.port, '/data/ranking-summary.json')).headers['cache-control'], 'no-cache')
    assert.equal((await httpRead(server.port, '/data/large.json')).headers['cache-control'], 'no-cache')
    assert.equal((await httpRead(server.port, `/data/objects/sha256/${digest}`)).headers['cache-control'], immutableCache)
    const compressed = await httpRead(server.port, '/data/large.json', { headers: { 'accept-encoding': 'gzip' } })
    assert.equal(compressed.headers['content-encoding'], 'gzip')
    assert.deepEqual(JSON.parse((await httpRead(server.port, '/api/live')).body.toString()), { ok: true })
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('native method and body rules precede routing and include health paths', async () => {
  const { root } = await transportFixture()
  const server = await nativeServer(root)
  try {
    for (const path of ['/api/live', '/api/ready', '/missing', '/data/large.json', '/data/%']) {
      for (const method of ['POST', 'OPTIONS', 'DELETE']) {
        const response = await httpRead(server.port, path, { method, headers: { 'content-length': '1' } })
        assert.equal(response.headers.connection, 'close')
        assert.equal(response.status, 405, `${method} ${path}`)
        assert.equal(response.headers.allow, 'GET, HEAD')
        assert.equal(response.headers['cache-control'], 'no-store')
      }
      const bodyHeaders: Record<string, string>[] = [{ 'content-length': '1' }, { 'transfer-encoding': 'chunked' }]
      for (const method of ['GET', 'HEAD']) {
        for (const headers of bodyHeaders) {
          const response = await httpRead(server.port, path, { method, headers })
          assert.equal(response.status, 400, `${method} ${path}`)
          assert.equal(response.headers.connection, 'close')
          assert.equal(response.headers['cache-control'], 'no-store')
          if (method === 'HEAD') assert.equal(response.body.length, 0)
        }
      }
    }
    for (const path of ['/api/live', '/api/ready', '/data/large.json']) {
      assert.equal((await httpRead(server.port, path, { headers: { 'content-length': '0' } })).status, 200)
    }
    for (const path of ['/api/live', '/api/ready']) {
      assert.equal((await httpRead(server.port, path)).headers['cache-control'], 'no-store')
    }
    await rm(join(root, 'ranking-summary.json'))
    const head = await httpRead(server.port, '/api/ready', { method: 'HEAD' })
    assert.equal(head.status, 503)
    assert.equal(head.body.length, 0)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})
