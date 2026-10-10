import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { acquireBucketLease, readActiveGenerationPublication, releaseBucketLease, renewBucketLease } from '../scripts/railway-bucket.mjs'
import { prepareStateObject, syncContentAddressedStateObject } from '../scripts/incremental-state-storage.mjs'
import { createGenerationPublicationReceipt, type GenerationPublicationReceipt } from '../scripts/generation-publication.mjs'
import { canonicalJsonFor } from '../scripts/public-artifact-storage.mjs'

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
  const client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } })
  const now = new Date('2026-10-09T00:00:00.000Z')
  const nativeConfig = { ...config, prefix: 'rust' }
  const invoke = (input: object, prefix = 'rust') => invokeStorage(root, { ...config, prefix }, input)
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
    assert.equal(nodeRenewed.renewed, true)
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
    const takeoverReleaseAt = new Date(later.getTime() + 1_000)
    const nativeReleased = await invoke({ action: 'release-lease', key,
      authority: { lease: takeover.lease, etag: takeover.etag, promotionEtag: takeover.promotionEtag },
      now: takeoverReleaseAt.toISOString() })
    assert.equal(nativeReleased.released, true)
    const releasedPointer = JSON.parse((await get('rust/active-generation.json')).bytes.toString())
    assert.equal(releasedPointer.leaseReleasedAt, takeoverReleaseAt.toISOString())
    const successor = await acquireBucketLease(key, { owner: 'host-c', now: takeoverReleaseAt, config: nativeConfig, client })
    assert.equal(successor.acquired, true, 'A Node host can acquire after native release')
    assert.ok(successor.lease!.fencingToken > takeover.lease!.fencingToken)
    const releaseAt = new Date(renewAt.getTime() + 1_000)
    const nodeReleased = await releaseBucketLease(key, nodeRenewed, { now: releaseAt, config, client })
    assert.equal(nodeReleased.released, true)
    await assert.rejects(invoke({ ...input, namespace: '../rankings' }), /Invalid immutable object identity/)
  } finally {
    client.destroy()
    await rm(root, { recursive: true, force: true })
  }
})

test('native publication reader matches Node against MinIO for authority and declared closure failures', { skip: !endpoint || !binary }, async (t) => {
  const url = new URL(endpoint!)
  assert.equal(url.protocol, 'http:')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  const root = await mkdtemp(join(tmpdir(), 'rust-publication-'))
  const config = { enabled: true as const, endpoint: endpoint!, bucket: `publication-${Date.now()}`, region: 'us-east-1',
    accessKeyId: 'minio-test', secretAccessKey: 'minio-test-password', prefix: 'isolated', forcePathStyle: true }
  const client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } })
  const readNode = () => readActiveGenerationPublication({ config, client })
  const readRust = () => invokeStorage(root, config, { action: 'verify-publication' })
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const put = async (key: string, body: Buffer, digest = hash(body), compressed = false) => {
    const result = await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body,
      ContentType: 'application/json; charset=utf-8', ...(compressed ? { ContentEncoding: 'gzip' } : {}),
      Metadata: { sha256: digest, 'semantic-bytes': String(body.length) } }))
    return { reference: { key, digest, bytes: body.length }, etag: result.ETag }
  }
  const activeKey = `${config.prefix}/active-generation.json`
  const generationId = 'declared-closure-fixture'
  try {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }))
    await t.test('missing and supported legacy pointers keep the Node compatibility result', async () => {
      assert.deepEqual(await readRust(), await readNode())
      for (const value of [{ generationId }, { generationId, publicManifestSchemaVersion: 2, previousGeneration: {} }]) {
        await put(activeKey, Buffer.from(JSON.stringify(value)))
        assert.deepEqual(await readRust(), await readNode())
      }
    })
    const manifestBytes = Buffer.from(canonicalJsonFor({ fixture: 'manifest' }))
    const manifest = await put(`${config.prefix}/generations/${generationId}/manifest.json`, manifestBytes)
    const state = await put(`${config.prefix}/state/generations/${generationId}.json`, Buffer.from('{"fixture":"state"}'))
    const compressed = await Promise.all(['raw/objects', 'state/objects', 'objects'].map(async (namespace) => {
      const semantic = Buffer.from(canonicalJsonFor({ fixture: namespace }))
      const digest = hash(semantic)
      const body = gzipSync(semantic)
      const stored = await put(`${config.prefix}/${namespace}/sha256/${digest}`, body, digest, true)
      return { ...stored, body, semantic }
    }))
    const receipt = createGenerationPublicationReceipt({ generationId, prefix: config.prefix,
      preparedAt: '2026-10-10T00:00:00.000Z', fencingToken: 1, leaseOwner: 'test-host', promotionEtag: '"test-lease"',
      provenance: { modelVersion: 'fixture', modelConfigHash: 'fixture', source: 'isolated-test', dataMode: 'fixture', sourceProviders: ['test'] },
      authorities: { publicManifest: manifest.reference, rawReceipt: compressed[0].reference, stateManifest: state.reference },
      objects: [manifest, state, ...compressed].map(({ reference }) => ({ ...reference, outcome: 'uploaded' as const })),
    })
    const pointer = { generationId, fencingToken: 1, manifestKey: manifest.reference.key,
      manifestDigest: manifest.reference.digest, manifestBytes: manifest.reference.bytes,
      rawReceiptKey: compressed[0].reference.key, rawReceiptDigest: compressed[0].reference.digest,
      stateManifestKey: state.reference.key, stateManifestDigest: state.reference.digest, publicationSchemaVersion: 1 }
    const publish = async (value: unknown = receipt, patch: Record<string, unknown> = {}, body?: Buffer) => {
      const stored = await put(`${config.prefix}/generations/${generationId}/publish.json`, body ?? Buffer.from(canonicalJsonFor(value)))
      await put(activeKey, Buffer.from(JSON.stringify({ ...pointer,
        publicationReceiptKey: stored.reference.key, publicationReceiptDigest: stored.reference.digest,
        publicationReceiptBytes: stored.reference.bytes, publicationReceiptEtag: stored.etag, ...patch })))
    }
    const rejected = async () => {
      await assert.rejects(readNode())
      await assert.rejects(readRust())
      await assert.rejects(readFile(join(root, 'output.json')), { code: 'ENOENT' }, 'No successful descriptor survives failure')
    }
    await t.test('canonical receipt and every public/raw/state member produce exact reader parity', async () => {
      await publish()
      assert.deepEqual(await readRust(), await readNode())
      // Receipt parsing follows JavaScript numeric values, not JSON integer spelling.
      await publish(receipt, {}, Buffer.from(canonicalJsonFor(receipt).replace('"schemaVersion":1', '"schemaVersion":1.0')))
      assert.deepEqual(await readRust(), await readNode())
    })
    await t.test('equivalent alternative gzip transport remains valid with its declared size', async () => {
      const original = compressed[0]
      const alternate = gzipSync(original.semantic, { level: 1 })
      await put(original.reference.key, alternate, original.reference.digest, true)
      const reference = { ...original.reference, bytes: alternate.length }
      await publish({ ...receipt, authorities: { ...receipt.authorities, rawReceipt: reference },
        objects: receipt.objects.map((object) => object.key === reference.key ? { ...object, bytes: alternate.length } : object) })
      assert.deepEqual(await readRust(), await readNode())
      await put(original.reference.key, original.body, original.reference.digest, true)
    })
    const mutations: Array<[string, (value: GenerationPublicationReceipt) => unknown]> = [
      ['duplicate membership', (value) => ({ ...value, objects: [...value.objects, value.objects[0]] })],
      ['mutable namespace', (value) => ({ ...value, objects: [...value.objects, { ...value.objects[0], key: `${config.prefix}/raw/manifest.json` }] })],
      ['outside prefix', (value) => ({ ...value, objects: [...value.objects, { ...value.objects[0], key: 'foreign/objects/sha256/' + value.objects[0].digest }] })],
      ['missing authority member', (value) => ({ ...value, objects: value.objects.filter((object) => object.key !== manifest.reference.key) })],
      ['unknown receipt field', (value) => ({ ...value, unverified: true })],
      ['unsafe byte count', (value) => ({ ...value, objects: value.objects.map((object, index) => index === 0 ? { ...object, bytes: Number.MAX_SAFE_INTEGER + 1 } : object) })],
      ['duplicate provenance provider', (value) => ({ ...value, provenance: { ...value.provenance, sourceProviders: ['test', 'test'] } })],
    ]
    for (const [name, mutate] of mutations) {
      await t.test(name, async () => { await publish(mutate(receipt)); await rejected() })
    }
    for (const patch of [{ publicationReceiptEtag: '"stale"' }, { manifestDigest: '0'.repeat(64) },
      { stateManifestDigest: '0'.repeat(64) }, { fencingToken: 2 }, { publicationSchemaVersion: 2 }]) {
      await t.test(`pointer rejects ${Object.keys(patch)[0]}`, async () => { await publish(receipt, patch); await rejected() })
    }
    await t.test('same-length manifest mutation with unchanged metadata fails semantic digest', async () => {
      await publish()
      const mutated = Buffer.from(canonicalJsonFor({ fixture: 'mutated!' }))
      assert.equal(mutated.length, manifestBytes.length)
      await put(manifest.reference.key, mutated, manifest.reference.digest)
      await rejected()
      await put(manifest.reference.key, manifestBytes)
    })
    await t.test('corrupt gzip and missing members reject without changing active authority', async () => {
      await publish()
      const original = compressed[0]
      const before = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: activeKey }))
      await put(original.reference.key, Buffer.alloc(original.body.length, 35), original.reference.digest, true)
      await rejected()
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: original.reference.key }))
      await rejected()
      const after = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: activeKey }))
      assert.equal(after.ETag, before.ETag)
      assert.deepEqual(await after.Body!.transformToByteArray(), await before.Body!.transformToByteArray())
    })
  } finally {
    client.destroy()
    await rm(root, { recursive: true, force: true })
  }
})

async function invokeStorage(root: string, config: {
  endpoint: string; bucket: string; region: string; prefix: string; accessKeyId: string; secretAccessKey: string
}, input: object) {
  const inputPath = join(root, 'input.json')
  const outputPath = join(root, 'output.json')
  await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 })
  await rm(outputPath, { force: true })
  await runFile(resolve(binary!), ['storage', inputPath, outputPath], { env: {
    ...process.env, RANKING_BUCKET_ENDPOINT: config.endpoint, RANKING_BUCKET_NAME: config.bucket,
    RANKING_BUCKET_REGION: config.region, RANKING_BUCKET_PREFIX: config.prefix,
    RANKING_BUCKET_ACCESS_KEY_ID: config.accessKeyId, RANKING_BUCKET_SECRET_ACCESS_KEY: config.secretAccessKey,
    RANKING_BUCKET_FORCE_PATH_STYLE: 'true',
  } })
  return JSON.parse(await readFile(outputPath, 'utf8'))
}
