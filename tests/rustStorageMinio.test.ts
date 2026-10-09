import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { CreateBucketCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'
import { acquireBucketLease, createBucketClient, releaseBucketLease, renewBucketLease } from '../scripts/railway-bucket.mjs'
import { prepareStateObject, syncContentAddressedStateObject } from '../scripts/incremental-state-storage.mjs'

const endpoint = process.env.RANKING_STORAGE_TEST_ENDPOINT
const binary = process.env.RANKING_RUST_TEST_BINARY
const runFile = promisify(execFile)

test('native storage matches Node immutable bytes and shares MinIO lease fencing', { skip: !endpoint || !binary }, async () => {
  const url = new URL(endpoint!)
  assert.equal(url.protocol, 'http:')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only an owned loopback MinIO test server is permitted')
  const root = await mkdtemp(join(tmpdir(), 'rust-storage-'))
  const config = { enabled: true as const, endpoint: endpoint!, bucket: `parity-${Date.now()}`, region: 'us-east-1',
    accessKeyId: 'minio-test', secretAccessKey: 'minio-test-password', prefix: 'node', forcePathStyle: true }
  const client = createBucketClient(config)!
  const now = new Date('2026-10-09T00:00:00.000Z')
  const nativeConfig = { ...config, prefix: 'rust' }
  const invoke = async (input: object, prefix = 'rust') => {
    const inputPath = join(root, 'input.json')
    const outputPath = join(root, 'output.json')
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 })
    await rm(outputPath, { force: true })
    await runFile(resolve(binary!), ['storage', inputPath, outputPath], { env: {
      ...process.env, RANKING_BUCKET_ENDPOINT: endpoint!, RANKING_BUCKET_NAME: config.bucket,
      RANKING_BUCKET_REGION: config.region, RANKING_BUCKET_PREFIX: prefix,
      RANKING_BUCKET_ACCESS_KEY_ID: config.accessKeyId, RANKING_BUCKET_SECRET_ACCESS_KEY: config.secretAccessKey,
      RANKING_BUCKET_FORCE_PATH_STYLE: 'true',
    } })
    return JSON.parse(await readFile(outputPath, 'utf8'))
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }))
    const prepared = prepareStateObject({ '😀': 1, z: [0, 1e-7, { rating: 1_234.5 }], a: 'captured input contract' })
    const compressedPath = join(root, 'object.gz')
    await writeFile(compressedPath, prepared.compressed)
    const input = { action: 'sync-object', namespace: 'state', compressedPath, digest: prepared.digest, bytes: prepared.bytes }
    const node = await syncContentAddressedStateObject(client, config, prepared)
    const rust = await invoke(input)
    assert.equal(rust.status, node.status)
    const get = async (Key: string) => {
      const value = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key }))
      return { bytes: Buffer.from(await value.Body!.transformToByteArray()), metadata: value.Metadata, contentType: value.ContentType, encoding: value.ContentEncoding }
    }
    assert.deepEqual(await get(rust.key), await get(node.key))
    const all = await client.send(new ListObjectsV2Command({ Bucket: config.bucket }))
    assert.deepEqual(all.Contents?.map((item) => item.Key?.replace(/^(node|rust)\//, '')).sort(),
      [node.key.replace('node/', ''), node.key.replace('node/', '')])
    // A valid stored semantic object compressed by another encoder remains reusable.
    const alternative = gzipSync(prepared.canonicalBytes, { level: 1 })
    await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: rust.key, Body: alternative,
      ContentType: 'application/json; charset=utf-8', ContentEncoding: 'gzip',
      Metadata: { sha256: prepared.digest, 'semantic-bytes': String(prepared.bytes), encoding: 'gzip' } }))
    const reused = await invoke(input)
    assert.equal(reused.status, 'unchanged')
    assert.equal(reused.bytes, alternative.length)
    await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: rust.key, Body: Buffer.from('corrupt'),
      ContentType: 'application/json; charset=utf-8', ContentEncoding: 'gzip',
      Metadata: { sha256: prepared.digest, 'semantic-bytes': String(prepared.bytes), encoding: 'gzip' } }))
    await assert.rejects(invoke(input), /Stored object gzip is corrupt/)
    assert.equal((await get(rust.key)).bytes.toString(), 'corrupt', 'A collision must not be overwritten')

    // Existing Node raw objects have no public CacheControl requirement.
    const rawKey = `rust/raw/objects/sha256/${prepared.digest}`
    await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: rawKey, Body: alternative,
      ContentType: 'application/json; charset=utf-8', ContentEncoding: 'gzip',
      Metadata: { sha256: prepared.digest, 'semantic-bytes': String(prepared.bytes), encoding: 'gzip' } }))
    assert.equal((await invoke({ ...input, namespace: 'raw' })).status, 'unchanged')

    const key = 'ops/refresh-lease.json'
    const nodeLease = await acquireBucketLease(key, { owner: 'host-a', ttlMs: 60_000, now, config, client })
    const rustLease = await invoke({ action: 'acquire-lease', key, owner: 'host-a', ttlMs: 60_000, now: now.toISOString() })
    assert.equal(nodeLease.acquired, true)
    assert.deepEqual(rustLease, nodeLease)
    assert.deepEqual(await get('node/active-generation.json'), await get('rust/active-generation.json'))
    const renewAt = new Date(now.getTime() + 1_000)
    const nodeRenewed = await renewBucketLease(key, nodeLease, { ttlMs: 60_000, now: renewAt, config, client })
    const authority = { lease: rustLease.lease, etag: rustLease.etag, promotionEtag: rustLease.promotionEtag }
    const rustRenewed = await invoke({ action: 'renew-lease', key, authority, ttlMs: 60_000, now: renewAt.toISOString() })
    assert.deepEqual(rustRenewed, nodeRenewed)
    assert.deepEqual(await get('node/active-generation.json'), await get('rust/active-generation.json'))
    const renewedAuthority = { lease: rustRenewed.lease, etag: rustRenewed.etag, promotionEtag: rustRenewed.promotionEtag }
    const denied = await invoke({ action: 'acquire-lease', key, owner: 'host-b', ttlMs: 60_000, now: renewAt.toISOString() })
    assert.deepEqual(denied, await acquireBucketLease(key, { owner: 'host-b', ttlMs: 60_000, now: renewAt, config, client }))
    // Node host takes over the native prefix after expiration. Native host's old
    // authority cannot renew or release it, even if its local process remains alive.
    const later = new Date(now.getTime() + 120_000)
    const takeover = await acquireBucketLease(key, { owner: 'host-b', now: later, config: nativeConfig, client })
    assert.equal(takeover.acquired, true)
    assert.ok(takeover.lease!.fencingToken > rustLease.lease.fencingToken)
    assert.deepEqual(await invoke({ action: 'renew-lease', key, authority: renewedAuthority, ttlMs: 60_000, now: later.toISOString() }),
      { renewed: false, reason: 'lease-changed' })
    assert.deepEqual(await invoke({ action: 'release-lease', key, authority: renewedAuthority, now: later.toISOString() }),
      { released: false, reason: 'lease-changed' })
    const releaseAt = new Date(renewAt.getTime() + 1_000)
    const nodeReleased = await releaseBucketLease(key, nodeRenewed, { now: releaseAt, config, client })
    assert.equal(nodeReleased.released, true)
    await assert.rejects(invoke({ ...input, namespace: '../rankings' }), /Invalid immutable object identity/)
  } finally {
    client.destroy()
    await rm(root, { recursive: true, force: true })
  }
})
