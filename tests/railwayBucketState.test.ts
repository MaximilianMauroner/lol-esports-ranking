import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import {
  acquireBucketLease,
  assertBucketLease,
  readBucketJson,
  releaseBucketLease,
  renewBucketLease,
  uploadRankingArtifacts,
  writeBucketJson,
} from '../scripts/railway-bucket.mjs'

const config = {
  enabled: true,
  bucket: 'bucket',
  endpoint: 'https://example.invalid',
  region: 'auto',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  prefix: 'rankings',
}

test('conditional JSON state writes and lease fencing reject stale owners', async () => {
  const client = memoryS3()
  const first = await writeBucketJson('state.json', { generation: 1 }, { ifNoneMatch: '*', config, client })
  assert.equal(first.written, true)
  assert.equal((await writeBucketJson('state.json', { generation: 2 }, { ifNoneMatch: '*', config, client })).conflict, true)
  assert.equal((await readBucketJson('state.json', { config, client })).value?.generation, 1)

  const lease1 = await acquireBucketLease('lease.json', { owner: 'one', now: '2026-07-11T00:00:00Z', ttlMs: 60_000, config, client })
  const blocked = await acquireBucketLease('lease.json', { owner: 'two', now: '2026-07-11T00:00:30Z', ttlMs: 60_000, config, client })
  const lease2 = await acquireBucketLease('lease.json', { owner: 'two', now: '2026-07-11T00:01:01Z', ttlMs: 60_000, config, client })
  assert.equal(lease1.acquired, true)
  assert.equal(blocked.acquired, false)
  assert.equal(lease2.acquired, true)
  assert.equal(lease2.lease.fencingToken, 2)
})

test('released leases allow the next scheduled worker to run immediately', async () => {
  const client = memoryS3()
  const first = await acquireBucketLease('lease.json', { owner: 'one', now: '2026-07-11T00:00:00Z', ttlMs: 60_000, config, client })
  assert.equal(first.acquired, true)
  if (!first.acquired) return

  const released = await releaseBucketLease('lease.json', first, { now: '2026-07-11T00:00:10Z', config, client })
  assert.equal(released.released, true)

  const second = await acquireBucketLease('lease.json', { owner: 'two', now: '2026-07-11T00:00:11Z', ttlMs: 60_000, config, client })
  assert.equal(second.acquired, true)
  assert.equal(second.acquired && second.lease.fencingToken, 2)
  assert.equal((await releaseBucketLease('lease.json', first, { now: '2026-07-11T00:00:12Z', config, client })).reason, 'lease-changed')
})

test('lease renewal is conditional and release uses the renewed ETag', async () => {
  const client = memoryS3()
  const acquired = await acquireBucketLease('lease.json', { owner: 'one', now: '2026-07-11T00:00:00Z', ttlMs: 60_000, config, client })
  assert.equal(acquired.acquired, true)
  if (!acquired.acquired) return
  const renewed = await renewBucketLease('lease.json', acquired, { now: '2026-07-11T00:00:30Z', ttlMs: 60_000, config, client })
  assert.equal(renewed.renewed, true)
  if (!renewed.renewed) return
  assert.notEqual(renewed.etag, acquired.etag)
  assert.equal((await releaseBucketLease('lease.json', acquired, { now: '2026-07-11T00:00:31Z', config, client })).reason, 'lease-changed')
  assert.equal((await releaseBucketLease('lease.json', renewed, { now: '2026-07-11T00:00:31Z', config, client })).released, true)
})

test('live lease assertion rejects expiry takeover and an old worker resuming', async () => {
  const client = memoryS3()
  const oldWorker = await acquireBucketLease('lease.json', { owner: 'old', now: '2026-07-11T00:00:00Z', ttlMs: 60_000, config, client })
  assert.equal(oldWorker.acquired, true)
  if (!oldWorker.acquired) return
  await assert.rejects(() => assertBucketLease('lease.json', oldWorker, { now: '2026-07-11T00:01:00Z', config, client }), /lease-expired/)
  const replacement = await acquireBucketLease('lease.json', { owner: 'new', now: '2026-07-11T00:01:01Z', ttlMs: 60_000, config, client })
  assert.equal(replacement.acquired, true)
  await assert.rejects(() => assertBucketLease('lease.json', oldWorker, { now: '2026-07-11T00:01:02Z', config, client }), /lease-changed/)
  assert.equal(replacement.acquired && replacement.lease.fencingToken, 2)
})

test('generation publication uploads immutable data before promoting one pointer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-generation-'))
  const publicDir = join(root, 'public')
  await mkdir(join(publicDir, 'scopes'), { recursive: true })
  await writeFile(join(publicDir, 'scopes', 'all.json'), '{"matchCount":1}\n')
  await writeFile(join(publicDir, 'ranking-summary.json'), '{"artifactKind":"public-ranking-manifest"}\n')
  const client = memoryS3()
  try {
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'run-1',
      fencingToken: 4,
      config,
      client,
    })
    assert.ok(client.objects.has('rankings/generations/run-1/data/scopes/all.json'))
    assert.ok(client.objects.has('rankings/generations/run-1/data/ranking-summary.json'))
    const active = JSON.parse(client.objects.get('rankings/active-generation.json')!.body)
    assert.equal(active.generationId, 'run-1')
    assert.equal(active.fencingToken, 4)

    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'run-2',
      fencingToken: 5,
      config,
      client,
    })
    await assert.rejects(() => uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'stale-run',
      fencingToken: 4,
      config,
      client,
    }), /Stale refresh worker/)
    assert.equal(JSON.parse(client.objects.get('rankings/active-generation.json')!.body).generationId, 'run-2')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('lost lease leaves uploaded generation objects orphaned and active pointer unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-orphan-'))
  const publicDir = join(root, 'public')
  await mkdir(publicDir, { recursive: true })
  await writeFile(join(publicDir, 'ranking-summary.json'), '{}\n')
  const backing = memoryS3()
  let replaceAfterArtifact = false
  const client = {
    objects: backing.objects,
    async send(command: unknown) {
      const result = await backing.send(command)
      const { name, input } = commandDetails(command)
      if (replaceAfterArtifact && name === 'PutObjectCommand' && input.Key === 'rankings/generations/orphan/data/ranking-summary.json') {
        backing.objects.set('rankings/lease.json', {
          body: JSON.stringify({ owner: 'new', fencingToken: 2, expiresAt: '2026-07-11T00:02:00Z' }),
          etag: 'replacement',
        })
      }
      return result
    },
  }
  const current = await acquireBucketLease('lease.json', { owner: 'old', now: '2026-07-11T00:00:00Z', ttlMs: 60_000, config, client })
  assert.equal(current.acquired, true)
  if (!current.acquired) return
  await writeBucketJson('active-generation.json', { generationId: 'good', fencingToken: 2 }, { ifNoneMatch: '*', config, client })
  replaceAfterArtifact = true
  try {
    await assert.rejects(() => uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'orphan',
      fencingToken: 1,
      leaseAuthority: { key: 'lease.json', lease: current.lease },
      now: () => new Date('2026-07-11T00:00:30Z'),
      config,
      client,
    }), /no longer authoritative/)
    assert.ok(client.objects.has('rankings/generations/orphan/data/ranking-summary.json'))
    assert.equal(JSON.parse(client.objects.get('rankings/active-generation.json')!.body).generationId, 'good')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function memoryS3() {
  const objects = new Map<string, { body: string; etag: string }>()
  let version = 0
  return {
    objects,
    async send(command: unknown) {
      const { name, input } = commandDetails(command)
      const key = String(input.Key)
      if (name === 'GetObjectCommand') {
        const object = objects.get(key)
        if (!object) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
        return { Body: Readable.from([object.body]), ETag: object.etag, ContentLength: Buffer.byteLength(object.body) }
      }
      if (name === 'PutObjectCommand') {
        const current = objects.get(key)
        if (input.IfNoneMatch === '*' && current) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        if (input.IfMatch && input.IfMatch !== current?.etag) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        const body = await streamText(input.Body)
        const etag = `"${++version}"`
        objects.set(key, { body, etag })
        return { ETag: etag }
      }
      throw new Error(`Unsupported command ${name}`)
    },
  }
}

function commandDetails(value: unknown) {
  const command = value as { constructor: { name: string }; input: Record<string, unknown> }
  return { name: command.constructor.name, input: command.input }
}

async function streamText(value: unknown) {
  if (typeof value === 'string') return value
  const chunks: Buffer[] = []
  for await (const chunk of value as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
