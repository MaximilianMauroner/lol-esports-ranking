import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, mkdir, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { createPublicRankingManifestLoader } from '../src/browser/rankings/published/manifestLoader.ts'
import { fetchPublicSnapshotShard } from '../src/browser/rankings/published/resolver.ts'
import { writeSyntheticArtifacts } from './nativeHttpFixtures.ts'
import { httpRead, nativeServer } from './nativeHttpHelpers.ts'

test('native CLI rejects unsafe roots, nonloopback addresses and invalid options', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-cli-'))
  const binary = process.env.RANKING_NATIVE_HTTP_BINARY
  assert.ok(binary, 'RANKING_NATIVE_HTTP_BINARY is required')
  const run = promisify(execFile)
  try {
    await mkdir(join(root, 'real'))
    await symlink(join(root, 'real'), join(root, 'link'))
    const help = await run(binary, ['--help'])
    assert.match(help.stdout, /127\.0\.0\.1:4174/)
    for (const args of [
      ['--bogus'], ['--listen'], ['--listen', '0.0.0.0:0'], ['--listen', '[::]:0'],
      ['--listen', '127.0.0.1:0', '--listen', '127.0.0.1:1'],
      ['--data-root', join(root, 'missing')], ['--data-root', join(root, 'link')],
      ['--data-root', join(root, 'link/child')],
    ]) {
      await assert.rejects(run(binary, args, { timeout: 5_000 }), undefined, args.join(' '))
    }
    await assert.rejects(run(binary, ['--data-root', root, '--listen', '127.0.0.1:0'], {
      env: { ...process.env, RANKING_DATA_CACHE_CONTROL: 'bad\nheader' }, timeout: 5_000,
    }))
    const relative = await nativeServer(join(root, 'real/../real'))
    await relative.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('native local lifecycle has scoped readiness and clean signal termination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-http-'))
  const server = await nativeServer(root)
  try {
    assert.deepEqual(JSON.parse((await httpRead(server.port, '/api/live')).body.toString()), { ok: true, commit: 'native-fixture' })
    assert.equal((await httpRead(server.port, '/api/ready')).status, 503)
    await writeFile(join(root, 'ranking-summary.json'), '{}')
    const ready = await httpRead(server.port, '/api/ready')
    assert.equal(ready.status, 200)
    assert.deepEqual(JSON.parse(ready.body.toString()), { ok: true, scope: 'local-data', data: 'local' })
    for (const path of ['/api/live', '/api/ready', '/missing']) {
      assert.equal((await httpRead(server.port, path, { method: 'HEAD' })).body.length, 0)
    }
    assert.equal((await httpRead(server.port, '/api/live', { method: 'POST' })).status, 200)
    assert.equal((await httpRead(server.port, '/data/a', { method: 'POST' })).status, 405)
    await rm(join(root, 'ranking-summary.json'))
    assert.equal((await httpRead(server.port, '/api/ready')).status, 503)
  } finally {
    await server.close('SIGINT')
    await rm(root, { recursive: true, force: true })
  }
  await assert.rejects(httpRead(server.port, '/api/live'))
})

for (const generation of [false, true]) {
  test(`synthetic ${generation ? 'identity generation' : 'raw'} artifacts reach the existing browser readers`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'native-reader-'))
    const fixture = await writeSyntheticArtifacts(root, generation)
    const server = await nativeServer(root)
    try {
      const consumed = await browserJourney(server.port)
      assert.equal(consumed.manifest.source, fixture.manifest.source)
      assert.equal(consumed.manifest.dataMode, 'seeded-sample')
      assert.deepEqual(consumed.manifest.model, fixture.manifest.model)
      assert.deepEqual(consumed.shard.filter, fixture.shard.filter)
      assert.equal(consumed.shard.matchCount, 0)
      if (generation) {
        for (const { artifact } of fixture.prepared.slice(0, 2)) {
          assert.ok(consumed.requests.some((entry) => entry.path.startsWith(`/data/objects/sha256/${artifact.digest}`)))
        }
        const object = fixture.prepared[1].artifact
        await writeFile(join(root, 'objects/sha256', object.digest), object.canonicalJson.replace('"matchCount":0', '"matchCount":1'))
        assert.equal((await httpRead(server.port, '/api/ready')).status, 200)
        await assert.rejects(browserJourney(server.port), /digest|identity|hash|mismatch/i)
      }
      t.diagnostic(JSON.stringify({ case: generation ? 'synthetic-generation' : 'synthetic-raw', source: consumed.manifest.source, dataMode: consumed.manifest.dataMode, model: consumed.manifest.model, requests: consumed.requests }))
    } finally {
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('retained corpus reaches existing browser readers without download or mutation', async (t) => {
  const root = process.env.RANKING_NATIVE_HTTP_RETAINED_DATA_DIR
  assert.ok(root, 'Set RANKING_NATIVE_HTTP_RETAINED_DATA_DIR to an existing frozen reference public/data directory')
  const summary = await readFile(join(root, 'ranking-summary.json'))
  const digest = sha256(summary)
  assert.equal(digest, '115712b21735fb0c44787c98c69364328642625b52b055af45e82fd7586f14d8')
  const server = await nativeServer(root)
  try {
    const consumed = await browserJourney(server.port)
    assert.equal(consumed.manifest.source, "Oracle's Elixir primary with Leaguepedia Cargo gap-fill")
    assert.equal(consumed.manifest.dataMode, 'scheduled-public-data')
    assert.equal(consumed.manifest.model.version, 'transparent-power-index-v0.2.0')
    assert.equal(consumed.manifest.model.configHash, 'fnv1a-5eebb6ce')
    assert.ok(consumed.shard.matchCount > 0)
    assert.ok(consumed.shard.standings.length > 0)
    assert.equal(sha256(await readFile(join(root, 'ranking-summary.json'))), digest)
    t.diagnostic(JSON.stringify({ case: 'retained', root, summarySha256: digest, source: consumed.manifest.source, dataMode: consumed.manifest.dataMode, model: { version: consumed.manifest.model.version, configHash: consumed.manifest.model.configHash }, matchCount: consumed.shard.matchCount, requests: consumed.requests }))
  } finally {
    await server.close()
  }
})

async function browserJourney(port: number) {
  const origin = `http://127.0.0.1:${port}`
  const requests: { path: string; status: number; sha256: string; bytes: number }[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin)
    assert.equal(url.origin, origin)
    assert.ok(url.pathname.startsWith('/data/'))
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
    const bytes = Buffer.from(await response.clone().arrayBuffer())
    requests.push({ path: url.pathname + url.search, status: response.status, sha256: sha256(bytes), bytes: bytes.length })
    return response
  }
  const manifest = await createPublicRankingManifestLoader(`${origin}/data/ranking-summary.json`, fetcher)()
  const key = manifest.defaultSnapshotKey
  const expected = manifest.snapshotIndex[key]
  const shard = await fetchPublicSnapshotShard(expected.url, key, expected, manifest, { fetcher })
  assert.equal(shard.matchCount, expected.matchCount)
  assert.ok(requests.length >= 2)
  assert.equal(requests[0].path, '/data/ranking-summary.json')
  assert.ok(requests.every((entry) => entry.status === 200))
  return { manifest, shard, requests }
}

function sha256(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex') }
