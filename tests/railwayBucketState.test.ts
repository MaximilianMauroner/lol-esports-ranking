import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import {
  acquireBucketLease,
  readBucketJson,
  releaseBucketLease,
  uploadRankingArtifacts,
  writeBucketJson,
} from '../scripts/railway-bucket.mjs'
import {
  createRailwayDurableObjectStore,
  restoreDurableGeneration,
  stageDurableGeneration,
  type DurableIdentity,
} from '../scripts/durable-ranking-state.mjs'

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

test('Railway bucket adapter restores private state referenced by the public CAS pointer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-durable-adapter-'))
  const publicDir = join(root, 'public')
  const stateDir = join(root, 'state')
  const restoredDir = join(root, 'restored')
  const client = memoryS3()
  const durableIdentity: DurableIdentity = {
    compatibilityHash: 'compatibility',
    pipelineVersion: 'pipeline',
    codeHash: 'code',
    modelVersion: 'model',
    modelConfigHash: 'config',
  }
  try {
    await mkdir(publicDir, { recursive: true })
    await mkdir(join(stateDir, 'canonical'), { recursive: true })
    await writeFile(join(publicDir, 'ranking-summary.json'), '{"artifactKind":"public-ranking-manifest"}\n')
    await writeFile(join(stateDir, 'active-generation.json'), 'private active\n')
    await writeFile(join(stateDir, 'canonical', 'ledger.json'), 'private canonical\n')
    const store = createRailwayDurableObjectStore({ config, client })
    const candidate = await stageDurableGeneration({
      store,
      stateDir,
      identity: durableIdentity,
      generatedAt: '2026-07-19T00:00:00.000Z',
    })
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'durable-run',
      fencingToken: 8,
      config,
      client,
      privateState: {
        manifestKey: candidate.manifestKey,
        manifestDigest: candidate.manifestDigest,
        manifestBytes: candidate.manifestBytes,
        stateRoot: candidate.stateRoot,
        identityHash: candidate.identityHash,
      },
      rolloutForActive: (previous) => ({
        ...(typeof previous === 'object' && previous !== null ? previous : {}),
        identityHash: candidate.identityHash,
        consecutiveShadowSuccesses: 1,
      }),
    })
    const restored = await restoreDurableGeneration({ store, stateDir: restoredDir, expectedIdentity: durableIdentity })
    assert.equal(restored.restored, true)
    assert.equal(await readFile(join(restoredDir, 'canonical', 'ledger.json'), 'utf8'), 'private canonical\n')
    const active = JSON.parse(client.objects.get('rankings/active-generation.json')!.body)
    assert.equal(active.privateState.manifestKey, candidate.manifestKey)
    assert.equal(active.rollout.identityHash, candidate.identityHash)
    assert.equal(active.rollout.consecutiveShadowSuccesses, 1)
    assert.equal(active.fencingToken, 8)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function memoryS3() {
  const objects = new Map<string, { body: string; etag: string; metadata?: Record<string, string> }>()
  let version = 0
  return {
    objects,
    async send(command: unknown) {
      const { name, input } = commandDetails(command)
      const key = String(input.Key)
      if (name === 'GetObjectCommand') {
        const object = objects.get(key)
        if (!object) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
        return { Body: Readable.from([object.body]), ETag: object.etag, ContentLength: Buffer.byteLength(object.body), Metadata: object.metadata }
      }
      if (name === 'PutObjectCommand') {
        const current = objects.get(key)
        if (input.IfNoneMatch === '*' && current) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        if (input.IfMatch && input.IfMatch !== current?.etag) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        const body = await streamText(input.Body)
        const etag = `"${++version}"`
        objects.set(key, { body, etag, metadata: input.Metadata as Record<string, string> | undefined })
        return { ETag: etag }
      }
      if (name === 'ListObjectsV2Command') {
        const prefix = String(input.Prefix ?? '')
        return {
          Contents: [...objects.entries()]
            .filter(([objectKey]) => objectKey.startsWith(prefix))
            .map(([Key, value]) => ({ Key, Size: Buffer.byteLength(value.body) })),
        }
      }
      if (name === 'DeleteObjectCommand') {
        objects.delete(key)
        return {}
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
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  const chunks: Buffer[] = []
  for await (const chunk of value as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
