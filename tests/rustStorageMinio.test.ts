import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { crc32, gzipSync } from 'node:zlib'
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { acquireBucketLease, assertRawSourceGenerationAuthority, readActiveGenerationPublication, readVerifiedPublicArtifact, releaseBucketLease, renewBucketLease } from '../scripts/railway-bucket.mjs'
import { assertStateManifestAuthority, parseIncrementalStateManifest, prepareStateObject, stateObjectReferenceFor, syncContentAddressedStateObject, type IncrementalStateManifest } from '../scripts/incremental-state-storage.mjs'
import { createGenerationPublicationReceipt, type GenerationPublicationReceipt } from '../scripts/generation-publication.mjs'
import { canonicalJsonFor, prepareSemanticArtifact } from '../scripts/public-artifact-storage.mjs'
import { oracleGameInventory, prepareNarrowSourceObject, prepareOracleBaseline, prepareOracleMutationChain, prepareRawObject, prepareRawSourceReceipt, rawObjectReferenceFor, type PreparedRawObject, type RawObjectReference } from '../scripts/raw-source-storage.mjs'

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
    await t.test('pointer fencing follows Node Number coercion without weakening safe receipt tokens', async () => {
      for (const fencingToken of [1, '1', true, [1], ['1'], [['1']], ' +1.0e0 ', '\uFEFF1\u00A0', '0x1', '0o1', '0b1', '.1e1']) {
        await publish(receipt, { fencingToken })
        assert.deepEqual(await readRust(), await readNode(), JSON.stringify(fencingToken))
      }
      const safeToken = Number.MAX_SAFE_INTEGER
      const maximumReceipt = { ...receipt, fencing: { ...receipt.fencing, token: safeToken } }
      for (const fencingToken of [safeToken, String(safeToken), [String(safeToken)], '0x1fffffffffffff']) {
        await publish(maximumReceipt, { fencingToken })
        assert.deepEqual(await readRust(), await readNode(), JSON.stringify(fencingToken))
      }
      for (const fencingToken of [2, '2', false, null, [], [null], [true], [1, 0], {}, '1_0', '+0x1', '\u00851', 'Infinity', '1e999']) {
        await publish(receipt, { fencingToken })
        await rejected()
      }
    })
    await t.test('receipt canonical ISO accepts expanded years through both TimeClip endpoints', async () => {
      for (const preparedAt of ['0000-02-29T00:00:00.000Z', '2024-02-29T23:59:59.999Z', '9999-12-31T23:59:59.999Z',
        '+010000-01-01T00:00:00.000Z', '-000001-01-01T00:00:00.000Z',
        '-271821-04-20T00:00:00.000Z', '+275760-09-13T00:00:00.000Z']) {
        await publish({ ...receipt, preparedAt })
        assert.deepEqual(await readRust(), await readNode(), preparedAt)
      }
      for (const preparedAt of ['2023-02-29T00:00:00.000Z', '2024-04-31T00:00:00.000Z',
        '2024-02-29T23:59:60.000Z', '2024-02-29T24:00:00.000Z', '2024-02-29T00:00:00Z',
        '2024-02-29T00:00:00.000+00:00', '+009999-01-01T00:00:00.000Z', '-000000-01-01T00:00:00.000Z',
        '-271821-04-19T23:59:59.999Z', '+275760-09-13T00:00:00.001Z']) {
        await publish({ ...receipt, preparedAt })
        await rejected()
      }
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
    await t.test('complete gzip members accept Node padding and concatenation across public/raw/state', async () => {
      for (const original of compressed) {
        const split = Math.floor(original.semantic.length / 2)
        const concatenated = Buffer.concat([gzipSync(original.semantic.subarray(0, split)), gzipSync(original.semantic.subarray(split))])
        for (const body of [Buffer.concat([original.body, Buffer.alloc(8)]), Buffer.concat([original.body, Buffer.from([0, 0, 255, 1])]),
          concatenated, Buffer.concat([concatenated, Buffer.from([0, 255])])]) {
          const reference = { ...original.reference, bytes: body.length }
          await put(reference.key, body, reference.digest, true)
          await publish({ ...receipt,
            authorities: { ...receipt.authorities,
              ...(reference.key === receipt.authorities.rawReceipt.key ? { rawReceipt: reference } : {}) },
            objects: receipt.objects.map((object) => object.key === reference.key ? { ...object, bytes: reference.bytes } : object) })
          assert.deepEqual(await readRust(), await readNode(), reference.key)
        }
        await put(original.reference.key, original.body, original.reference.digest, true)
      }
    })
    await t.test('padding never conceals an invalid gzip footer or an incomplete member', async () => {
      const original = compressed[0]
      const crc = Buffer.from(original.body)
      crc[crc.length - 8] ^= 1
      const size = Buffer.from(original.body)
      size[size.length - 4] ^= 1
      for (const body of [Buffer.concat([crc, Buffer.alloc(8)]), Buffer.concat([size, Buffer.alloc(8)]),
        original.body.subarray(0, original.body.length - 1), Buffer.concat([original.body, Buffer.from([1, 2, 3])])]) {
        const reference = { ...original.reference, bytes: body.length }
        await put(reference.key, body, reference.digest, true)
        await publish({ ...receipt, authorities: { ...receipt.authorities, rawReceipt: reference },
          objects: receipt.objects.map((object) => object.key === reference.key ? { ...object, bytes: reference.bytes } : object) })
        await rejected()
      }
      await put(original.reference.key, original.body, original.reference.digest, true)
    })
    const mutations: Array<[string, (value: GenerationPublicationReceipt) => unknown]> = [
      ['duplicate membership', (value) => ({ ...value, objects: [...value.objects, value.objects[0]] })],
      ['mutable namespace', (value) => ({ ...value, objects: [...value.objects, { ...value.objects[0], key: `${config.prefix}/raw/manifest.json` }] })],
      ['outside prefix', (value) => ({ ...value, objects: [...value.objects, { ...value.objects[0], key: 'foreign/objects/sha256/' + value.objects[0].digest }] })],
      ['missing authority member', (value) => ({ ...value, objects: value.objects.filter((object) => object.key !== manifest.reference.key) })],
      ['unknown receipt field', (value) => ({ ...value, unverified: true })],
      ['unsafe byte count', (value) => ({ ...value, objects: value.objects.map((object, index) => index === 0 ? { ...object, bytes: Number.MAX_SAFE_INTEGER + 1 } : object) })],
      ['unsafe receipt fencing token', (value) => ({ ...value, fencing: { ...value.fencing, token: Number.MAX_SAFE_INTEGER + 1 } })],
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

test('native raw graph verifier matches Node before publication against MinIO', { skip: !endpoint || !binary }, async (t) => {
  const url = new URL(endpoint!)
  assert.equal(url.protocol, 'http:')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  const root = await mkdtemp(join(tmpdir(), 'rust-raw-graph-'))
  const config = { enabled: true as const, endpoint: endpoint!, bucket: `raw-graph-${Date.now()}`, region: 'us-east-1',
    accessKeyId: 'minio-test', secretAccessKey: 'minio-test-password', prefix: 'isolated', forcePathStyle: true }
  const client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } })
  const importerVersion = 'raw-graph-test'
  const csv = (notes: string) => `gameid,date,league,side,notes\na,2026-01-01,LCS,Blue,${notes}\na,2026-01-01,LCS,Red,${notes}\n`
  const baseline = prepareOracleBaseline({ csv: csv('before'), sourceFileName: 'oracle.csv', importerVersion })
  const chain = prepareOracleMutationChain({ previousSource: baseline.source, nextCsv: csv('after') })
  const narrow = (provider: 'leaguepedia' | 'lolesports') => prepareNarrowSourceObject({ provider,
    sourceFileName: `${provider}.json`, content: JSON.stringify({ provider, evidence: 'isolated fixture' }), importerVersion })
  const leaguepedia = narrow('leaguepedia')
  const lolesports = narrow('lolesports')
  const receiptInputs = {
    generationId: 'raw-graph-test', importerVersion, coverage: { start: '2026-01-01', end: '2026-01-02' },
    sourceReceiptInputs: { generatedAt: '2026-01-02T00:00:00.000Z', warnings: ['synthetic contract evidence'] },
    oracle: [{ sourceFileName: baseline.source.sourceFileName, headerDigest: baseline.source.headerDigest,
      digestScheme: 'oracle-game-inventory-v1' as const, effectiveOracleDigest: chain.source.digest,
      gameInventory: oracleGameInventory(chain.source), baseline: baseline.reference, deltas: chain.deltas.map((delta) => delta.reference) }],
    leaguepedia: [{ sourceFileName: leaguepedia.value.sourceFileName, contentSha256: leaguepedia.value.contentSha256, object: leaguepedia.reference }],
    lolesports: [{ sourceFileName: lolesports.value.sourceFileName, contentSha256: lolesports.value.contentSha256, object: lolesports.reference }],
  }
  const receipt = prepareRawSourceReceipt(receiptInputs)
  const reference = rawObjectReferenceFor(receipt.prepared)
  const objects = [baseline.prepared, ...chain.deltas.map((delta) => delta.prepared), leaguepedia.prepared, lolesports.prepared, receipt.prepared]
  const put = async (prepared: PreparedRawObject, body = prepared.compressed, metadata = {
    sha256: prepared.digest, 'semantic-bytes': String(prepared.bytes), encoding: 'gzip',
  }) => client.send(new PutObjectCommand({ Bucket: config.bucket,
    Key: `${config.prefix}/raw/objects/sha256/${prepared.digest}`, Body: body,
    ContentType: 'application/json; charset=utf-8', ContentEncoding: 'gzip', Metadata: metadata }))
  const authority = (ref: RawObjectReference) => ({ key: `${config.prefix}/${ref.key}`, reference: ref })
  const node = (ref = reference) => assertRawSourceGenerationAuthority(client, config, authority(ref))
  const rust = (ref = reference) => invokeStorage(root, config, { action: 'verify-raw-generation', reference: ref })
  const rejected = async (ref = reference) => {
    await assert.rejects(node(ref))
    await assert.rejects(rust(ref))
    await assert.rejects(readFile(join(root, 'output.json')), { code: 'ENOENT' })
  }
  const activeKey = `${config.prefix}/active-generation.json`
  const activeBytes = Buffer.from('{"generationId":"previous-generation","fencingToken":17}')
  try {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }))
    await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: activeKey, Body: activeBytes }))
    for (const prepared of objects) await put(prepared)
    await t.test('receipt determines every baseline, delta and provider member with exact proof parity', async () => {
      const expected = await node()
      assert.deepEqual(await rust(), expected)
      assert.deepEqual(expected.verifiedObjects.map((object) => object.key), [reference,
        baseline.reference, ...chain.deltas.map((delta) => delta.reference), leaguepedia.reference, lolesports.reference]
        .map((ref) => `${config.prefix}/${ref.key}`))
      const listed = await client.send(new ListObjectsV2Command({ Bucket: config.bucket }))
      assert.equal(listed.Contents?.length, objects.length + 1, 'Verification creates no readiness or audit object')
    })
    await t.test('alternative gzip transports and optional legacy sizes retain semantic identity', async () => {
      for (const prepared of [receipt.prepared, baseline.prepared]) {
        const alternate = gzipSync(Buffer.from(canonicalJsonFor(prepared.value)), { level: 1 })
        await put(prepared, alternate)
        assert.deepEqual(await rust(), await node())
        if (prepared === receipt.prepared) {
          const legacy = { ...reference, compressedBytes: alternate.length }
          assert.deepEqual(await rust(legacy), await node(legacy))
          await rejected({ ...legacy, compressedBytes: alternate.length + 1 })
        }
        await put(prepared)
      }
    })
    await t.test('Node-valid UTF-16 receipt strings and keys retain their exact stored identities', async () => {
      for (const warning of ['diagnostic \ud800', 'diagnostic \udc00', '\ud800\ud800\udc00\udc00', 'literal \\ud800 and 🙂']) {
        const sourceReceiptInputs = { warnings: [warning], nested: { ['key\ud800']: warning, ['key\udc00']: ['🙂', warning] } }
        const changed = prepareRawSourceReceipt({ ...receiptInputs, sourceReceiptInputs })
        await put(changed.prepared)
        const ref = rawObjectReferenceFor(changed.prepared)
        const expected = await node(ref)
        assert.deepEqual(await rust(ref), expected)
        assert.deepEqual(expected.receipt.sourceReceiptInputs, sourceReceiptInputs)
      }
      // Uppercase Unicode escapes are valid JSON but differ from Node's canonical bytes.
      const changed = prepareRawSourceReceipt({ ...receiptInputs, sourceReceiptInputs: { warning: '\ud800' } })
      const noncanonical = Buffer.from(canonicalJsonFor(changed.receipt).replace('\\ud800', '\\uD800'))
      assert.notDeepEqual(noncanonical, Buffer.from(canonicalJsonFor(changed.receipt)))
      const digest = createHash('sha256').update(noncanonical).digest('hex')
      await put({ ...changed.prepared, digest, bytes: noncanonical.length }, gzipSync(noncanonical))
      await rejected({ key: `raw/objects/sha256/${digest}`, sha256: digest, bytes: noncanonical.length, storageEncoding: 'gzip' })
    })
    await t.test('an accepted nested receipt remains valid when embedded in the verification result', async () => {
      let nested: { n: unknown } | string = 'leaf'
      for (let depth = 0; depth < 125; depth += 1) nested = { n: nested }
      const changed = prepareRawSourceReceipt({ ...receiptInputs, sourceReceiptInputs: { nested } })
      await put(changed.prepared)
      const ref = rawObjectReferenceFor(changed.prepared)
      assert.deepEqual(await rust(ref), await node(ref))
    })
    await t.test('Node-valid UTF-16 raw child strings are checked without rewriting content', async () => {
      const child = prepareNarrowSourceObject({ provider: 'leaguepedia', sourceFileName: 'provider-\ud800.json',
        content: 'provider \ud800 and \udc00', importerVersion })
      await put(child.prepared)
      const changed = prepareRawSourceReceipt({ ...receiptInputs,
        leaguepedia: [{ sourceFileName: child.value.sourceFileName, contentSha256: child.value.contentSha256, object: child.reference }] })
      await put(changed.prepared)
      const ref = rawObjectReferenceFor(changed.prepared)
      assert.deepEqual(await rust(ref), await node(ref))
      const stored = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: `${config.prefix}/${child.reference.key}` }))
      assert.deepEqual(Buffer.from(await stored.Body!.transformToByteArray()), child.prepared.compressed)
    })
    await t.test('missing members fail even when the receipt object remains intact', async () => {
      for (const prepared of objects.slice(0, -1)) {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: `${config.prefix}/raw/objects/sha256/${prepared.digest}` }))
        await rejected()
        await put(prepared)
      }
    })
    await t.test('metadata, gzip and semantic corruption fail without repairing stored bytes', async () => {
      for (const prepared of [receipt.prepared, baseline.prepared, leaguepedia.prepared]) {
        await put(prepared, prepared.compressed, { sha256: prepared.digest, 'semantic-bytes': String(prepared.bytes + 1), encoding: 'gzip' })
        await rejected()
        for (const bytes of [Buffer.from('bad gzip'), gzipSync(Buffer.from('{}'))]) {
          await put(prepared, bytes)
          await rejected()
          const stored = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: `${config.prefix}/raw/objects/sha256/${prepared.digest}` }))
          assert.deepEqual(Buffer.from(await stored.Body!.transformToByteArray()), bytes)
        }
        await put(prepared)
      }
    })
    await t.test('canonical JSON and receipt identity are checked independently of valid content hashes', async () => {
      const noncanonical = Buffer.from(` ${canonicalJsonFor(baseline.value)}`)
      const digest = createHash('sha256').update(noncanonical).digest('hex')
      const invalidReference: RawObjectReference = { key: `raw/objects/sha256/${digest}`, sha256: digest,
        bytes: noncanonical.length, storageEncoding: 'gzip' }
      await put({ ...baseline.prepared, digest, bytes: noncanonical.length }, gzipSync(noncanonical))
      const changed = prepareRawSourceReceipt({ ...receiptInputs,
        oracle: receiptInputs.oracle.map((entry) => ({ ...entry, baseline: invalidReference })) })
      await put(changed.prepared)
      await rejected(rawObjectReferenceFor(changed.prepared))
      for (const patch of [{ rawIdentityDigest: '0'.repeat(64) }, { sourceReceiptDigest: '0'.repeat(64) }, { unexpected: true }]) {
        const invalid = prepareRawObject({ ...receipt.receipt, ...patch })
        await put(invalid)
        await rejected(rawObjectReferenceFor(invalid))
      }
    })
    await t.test('receipt records reject array replacements despite valid object hashes', async () => {
      for (const coverage of [['2026-01-01', '2026-01-02'], ['2026-01-01', '2026-01-02', true]]) {
        const invalid = prepareRawObject({ ...receipt.receipt, coverage })
        await put(invalid)
        await rejected(rawObjectReferenceFor(invalid))
      }
    })
    await t.test('noncanonical reference namespace and wrong receipt digest fail', async () => {
      await rejected({ ...reference, key: `state/objects/sha256/${reference.sha256}` })
      await rejected({ ...reference, sha256: '0'.repeat(64) })
    })
    const active = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: activeKey }))
    assert.deepEqual(Buffer.from(await active.Body!.transformToByteArray()), activeBytes, 'Graph checks never mutate the active generation')
  } finally {
    client.destroy()
    await rm(root, { recursive: true, force: true })
  }
})

test('native state authority verifier matches Node integrity against MinIO', { skip: !endpoint || !binary }, async (t) => {
  const url = new URL(endpoint!)
  assert.equal(url.protocol, 'http:')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only an owned loopback MinIO test server is permitted')
  const root = await mkdtemp(join(tmpdir(), 'rust-state-'))
  const config = { enabled: true as const, endpoint: endpoint!, bucket: `state-${Date.now()}`, region: 'us-east-1',
    accessKeyId: 'minio-test', secretAccessKey: 'minio-test-password', prefix: 'nested/rankings', forcePathStyle: true }
  const client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } })
  const ledger = prepareStateObject({ matches: ['pinned synthetic ledger'] })
  const checkpoint = prepareStateObject({ modelEncoding: 'deferred', 'diagnostic\ud800': '\udc00' })
  const objects = [ledger, checkpoint]
  const manifest: IncrementalStateManifest = {
    artifactKind: 'incremental-state-generation-manifest', schemaVersion: 1,
    storageMode: 'content-addressed-state-gzip-v1', generationId: 'state-1', runId: 'run-1',
    baseGenerationId: null, baseRunId: null, canonicalLedger: stateObjectReferenceFor(ledger),
    sourceReceiptDigest: 'a'.repeat(64), compatibility: {
      modelVersion: 'model\ud800', modelConfigHash: 'stored-label', importerVersion: 'importer', taxonomyVersion: 'taxonomy',
      ratingCheckpointSchemaVersion: 1, causalPrefixSchemaVersion: 1, publicArtifactSchemaVersion: 1,
    }, checkpoints: [
      { boundary: { date: '0000-02-29', matchId: '\ud800' }, rawPrefix: { matchCount: 0, digest: 'b'.repeat(64) }, object: stateObjectReferenceFor(checkpoint) },
      { boundary: { date: '0000-02-29', matchId: '😀' }, rawPrefix: { matchCount: 1, digest: 'c'.repeat(64) }, object: stateObjectReferenceFor(checkpoint) },
      { boundary: { date: '9999-12-31', matchId: '\udc00' }, rawPrefix: { matchCount: 2, digest: 'd'.repeat(64) }, object: stateObjectReferenceFor(checkpoint) },
    ],
  }
  const putMember = (prepared: typeof ledger, body = prepared.compressed, patch: Partial<PutObjectCommand['input']> = {}) =>
    client.send(new PutObjectCommand({ Bucket: config.bucket, Key: `${config.prefix}/state/objects/sha256/${prepared.digest}`,
      Body: body, ContentType: 'application/json; charset=utf-8', ContentEncoding: 'gzip',
      Metadata: { sha256: prepared.digest, 'semantic-bytes': String(prepared.bytes), encoding: 'gzip' }, ...patch }))
  const putManifest = async (value: unknown = manifest, body = Buffer.from(canonicalJsonFor(value)), patch: Partial<PutObjectCommand['input']> = {}) => {
    const key = patch.Key ?? `${config.prefix}/state/generations/state-1.json`
    const digest = createHash('sha256').update(body).digest('hex')
    const response = await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body,
      ContentType: 'application/json; charset=utf-8', Metadata: { sha256: digest, 'semantic-bytes': String(body.length) }, ...patch }))
    return { key, etag: response.ETag!, bytes: body.length, digest }
  }
  const node = (authority: Awaited<ReturnType<typeof putManifest>>, value?: IncrementalStateManifest) =>
    assertStateManifestAuthority(client, config, { ...authority, ...(value ? { manifest: value } : {}) })
  const rust = (authority: Awaited<ReturnType<typeof putManifest>>, value?: IncrementalStateManifest) =>
    invokeStorage(root, config, { action: 'verify-state-generation', authority, ...(value ? { expectedManifestJson: canonicalJsonFor(value) } : {}) })
  const reject = async (authority: Awaited<ReturnType<typeof putManifest>>, value?: IncrementalStateManifest) => {
    await assert.rejects(node(authority, value))
    await assert.rejects(rust(authority, value))
    await assert.rejects(readFile(join(root, 'output.json')), { code: 'ENOENT' }, 'Failure cannot leave a success descriptor')
  }
  const compare = async (authority: Awaited<ReturnType<typeof putManifest>>, value?: IncrementalStateManifest) => {
    assert.deepEqual(await rust(authority, value), await node(authority, value))
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }))
    for (const prepared of objects) await putMember(prepared)
    const activeKey = `${config.prefix}/active-generation.json`
    const activeBytes = Buffer.from('{"unrelatedAuthority":"must remain unchanged"}')
    await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: activeKey, Body: activeBytes }))
    await t.test('canonical authority, nested prefix, nullable bases and UTF-16 boundaries', async () => {
      await compare(await putManifest(), manifest)
      const based = { ...manifest, baseGenerationId: 'base-1', baseRunId: 'prior-run' }
      await compare(await putManifest(based), based)
      const emptyPrefix = { ...config, prefix: '' }
      const authority = await putManifest(manifest, undefined, { Key: 'state/generations/state-1.json' })
      for (const prepared of objects) await putMember(prepared, undefined, { Key: `state/objects/sha256/${prepared.digest}` })
      assert.deepEqual(await invokeStorage(root, emptyPrefix, { action: 'verify-state-generation', authority }),
        await assertStateManifestAuthority(client, emptyPrefix, authority))
    })
    await t.test('alternate gzip and optional legacy transport sizes retain exact proofs', async () => {
      const alternative = gzipSync(checkpoint.canonicalBytes, { level: 1 })
      await putMember(checkpoint, alternative)
      const legacy = { ...manifest, checkpoints: manifest.checkpoints.map((candidate) => ({ ...candidate,
        object: { ...candidate.object, compressedBytes: alternative.length } })) }
      await compare(await putManifest(legacy), legacy)
      const wrongSize = { ...legacy, checkpoints: legacy.checkpoints.map((candidate) => ({ ...candidate,
        object: { ...candidate.object, compressedBytes: alternative.length + 1 } })) }
      await reject(await putManifest(wrongSize))
      await putMember(checkpoint)
    })
    await t.test('member integrity does not tighten the deferred JSON/model contract', async () => {
      for (const body of [Buffer.from('not JSON\n'), Buffer.from('{ "noncanonical": true }\n'), Buffer.from([0xff, 0xfe, 0])]) {
        const digest = createHash('sha256').update(body).digest('hex')
        const compressed = gzipSync(body)
        const reference = { key: `state/objects/sha256/${digest}`, sha256: digest, bytes: body.length, storageEncoding: 'gzip' as const }
        await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: `${config.prefix}/${reference.key}`, Body: compressed,
          ContentType: 'application/json; charset=utf-8', ContentEncoding: 'gzip',
          Metadata: { sha256: digest, 'semantic-bytes': String(body.length), encoding: 'gzip' } }))
        const deferred = { ...manifest, canonicalLedger: reference }
        await compare(await putManifest(deferred), deferred)
      }
    })
    await t.test('authority binding, canonical bytes and expected manifest cannot drift', async () => {
      const authority = await putManifest()
      for (const patch of [{ etag: '"stale"' }, { digest: '0'.repeat(64) }, { bytes: authority.bytes + 1 },
        { bytes: 0 }, { bytes: Number.MAX_SAFE_INTEGER + 1 }, { key: `other/state/generations/state-1.json` }]) {
        await reject({ ...authority, ...patch })
      }
      await reject(authority, { ...manifest, runId: 'changed-run' })
      await reject(await putManifest({ ...manifest, generationId: 'different-generation' }))
      await reject(await putManifest(manifest, Buffer.from(`${canonicalJsonFor(manifest)}\n`)))
      const metadataPatches: Partial<PutObjectCommand['input']>[] = [
        { ContentType: 'application/json' }, { Metadata: { sha256: authority.digest } },
        { Metadata: { sha256: '0'.repeat(64), 'semantic-bytes': String(authority.bytes) } },
      ]
      for (const patch of metadataPatches) {
        await reject(await putManifest(manifest, undefined, patch))
      }
      await putManifest()
    })
    await t.test('authority descriptor rejects positional input and incomplete objects', async () => {
      const authority = await putManifest()
      for (const invalid of [
        [authority.key, authority.etag, authority.bytes, authority.digest],
        { key: authority.key, etag: authority.etag, bytes: authority.bytes },
        { ...authority, unexpected: true },
      ]) {
        await assert.rejects(invokeStorage(root, config, { action: 'verify-state-generation', authority: invalid }))
        await assert.rejects(readFile(join(root, 'output.json')), { code: 'ENOENT' })
      }
      await compare(authority)
    })
    await t.test('schema, safe counts, exact dates and ordered unique checkpoints', async () => {
      const missingBase = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'baseGenerationId'))
      const checkpoint = manifest.checkpoints[0]
      const invalid: unknown[] = [
        missingBase, Object.values(manifest), { ...manifest, extra: true }, { ...manifest, schemaVersion: 2 },
        { ...manifest, baseRunId: 'unsafe/../id' }, { ...manifest, checkpoints: [] },
        { ...manifest, compatibility: { ...manifest.compatibility, modelConfigHash: '' } },
        { ...manifest, compatibility: { ...manifest.compatibility, publicArtifactSchemaVersion: Number.MAX_SAFE_INTEGER + 1 } },
        { ...manifest, checkpoints: [checkpoint, checkpoint] }, { ...manifest, checkpoints: [...manifest.checkpoints].reverse() },
        ...['2023-02-29', '2024-04-31', '2026-1-01'].map((date) => ({ ...manifest, checkpoints: [{ ...checkpoint, boundary: { date, matchId: 'x' } }] })),
        ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((matchCount) => ({ ...manifest, checkpoints: [{ ...checkpoint, rawPrefix: { ...checkpoint.rawPrefix, matchCount } }] })),
        { ...manifest, canonicalLedger: { ...manifest.canonicalLedger, compressedBytes: null } },
        { ...manifest, canonicalLedger: { ...manifest.canonicalLedger, bytes: 0 } },
        { ...manifest, canonicalLedger: { ...manifest.canonicalLedger, key: 'state/../escape' } },
        { ...manifest, checkpoints: [{ ...checkpoint, object: Object.values(checkpoint.object) }] },
      ]
      for (const value of invalid) {
        assert.throws(() => parseIncrementalStateManifest(value))
        await reject(await putManifest(value))
      }
    })
    await t.test('fresh reads reject missing or mutated ledger and checkpoint members', async () => {
      const authority = await putManifest()
      for (const prepared of objects) {
        await compare(authority)
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: `${config.prefix}/state/objects/sha256/${prepared.digest}` }))
        await reject(authority)
        await putMember(prepared, Buffer.from('bad gzip'))
        await reject(authority)
        await putMember(prepared, gzipSync(Buffer.from('{}')))
        await reject(authority)
        await putMember(prepared, undefined, { ContentType: 'application/json' })
        await reject(authority)
        await putMember(prepared, undefined, { Metadata: { sha256: prepared.digest, 'semantic-bytes': String(prepared.bytes) } })
        await reject(authority)
        await putMember(prepared)
        await compare(authority)
      }
    })
    await t.test('complete gzip members retain Node concatenation/padding and CRC failures', async () => {
      const split = Math.floor(ledger.canonicalBytes.length / 2)
      const concatenated = Buffer.concat([gzipSync(ledger.canonicalBytes.subarray(0, split)), gzipSync(ledger.canonicalBytes.subarray(split))])
      for (const suffix of [Buffer.alloc(0), Buffer.alloc(8), Buffer.from([0, 0, 255, 1])]) {
        await putMember(ledger, Buffer.concat([concatenated, suffix]))
        await compare(await putManifest())
      }
      for (const offset of [8, 4]) {
        const corrupt = Buffer.from(ledger.compressed)
        corrupt[corrupt.length - offset] ^= 1
        await putMember(ledger, Buffer.concat([corrupt, Buffer.alloc(8)]))
        await reject(await putManifest())
      }
      for (const body of [ledger.compressed.subarray(0, -1), Buffer.concat([ledger.compressed, Buffer.from([1, 2, 3])])]) {
        await putMember(ledger, body)
        await reject(await putManifest())
      }
      await putMember(ledger)
    })
    await t.test('Node-valid long filename/comment and checked optional gzip headers', async () => {
      const long = Buffer.concat([Buffer.alloc(65_536, 97), Buffer.from([0])])
      const optional = (flags: number, fields: Buffer, checksum = false) => {
        const fixed = Buffer.from(ledger.compressed.subarray(0, 10))
        fixed[3] = flags | (checksum ? 2 : 0)
        const header = Buffer.concat([fixed, fields])
        const crc = Buffer.alloc(checksum ? 2 : 0)
        if (checksum) crc.writeUInt16LE(crc32(header) & 0xffff)
        return Buffer.concat([header, crc, ledger.compressed.subarray(10)])
      }
      for (const body of [optional(8, long), optional(16, long),
        optional(8 | 16 | 4, Buffer.concat([Buffer.from([3, 0, 1, 2, 3]), long, long]), true)]) {
        await putMember(ledger, body)
        await compare(await putManifest())
      }
      const badChecksum = optional(8, Buffer.from('name\0'), true)
      badChecksum[15] ^= 1
      for (const body of [badChecksum, optional(8, Buffer.alloc(0)).subarray(0, 10),
        optional(4, Buffer.from([255, 255])), optional(0xe0, Buffer.alloc(0))]) {
        await putMember(ledger, body)
        await reject(await putManifest())
      }
      await putMember(ledger)
    })
    const active = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: activeKey }))
    assert.deepEqual(Buffer.from(await active.Body!.transformToByteArray()), activeBytes, 'State graph verification cannot change the active authority')
    const authority = await putManifest()
    const inventory = () => client.send(new ListObjectsV2Command({ Bucket: config.bucket }))
    const before = (await inventory()).Contents
    await compare(authority)
    assert.deepEqual((await inventory()).Contents, before, 'Successful verification writes no bucket object')
  } finally {
    client.destroy()
    await rm(root, { recursive: true, force: true })
  }
})

test('native public archive reader matches Node content and fresh transport proofs', { skip: !endpoint || !binary }, async (t) => {
  const url = new URL(endpoint!)
  assert.equal(url.protocol, 'http:')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  const root = await mkdtemp(join(tmpdir(), 'rust-public-archive-'))
  const config = { enabled: true as const, endpoint: endpoint!, bucket: `public-archive-${Date.now()}`, region: 'us-east-1',
    accessKeyId: 'minio-test', secretAccessKey: 'minio-test-password', prefix: 'isolated/public', forcePathStyle: true }
  const client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } })
  type Identity = { sha256: string; bytes: number }
  const hash = (body: Buffer) => createHash('sha256').update(body).digest('hex')
  const keyFor = (identity: Identity) => `${config.prefix ? `${config.prefix}/` : ''}objects/sha256/${identity.sha256}`
  const putBytes = async (semantic: Buffer, compressed: Buffer = gzipSync(semantic)) => {
    const identity = { sha256: hash(semantic), bytes: semantic.length }
    await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: keyFor(identity), Body: compressed,
      ContentType: 'application/json; charset=utf-8', ContentEncoding: 'gzip',
      Metadata: { sha256: identity.sha256, 'semantic-bytes': String(identity.bytes), encoding: 'gzip' } }))
    return identity
  }
  const putContent = (content: unknown) => putBytes(Buffer.from(canonicalJsonFor({ artifactKind: 'public-semantic-artifact', schemaVersion: 1, content })))
  const readRust = (identity: Identity) => invokeStorage(root, config, { action: 'verify-public-artifact', ...identity })
  const compare = async (identity: Identity) => {
    const references: Identity[] = [identity]
    const content = await readVerifiedPublicArtifact(client, config, identity, 'isolated public archive', {
      onReference: (reference) => { references.push(reference) },
    })
    const verifiedObjects = []
    for (const reference of references) {
      const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: keyFor(reference) }))
      const compressed = Buffer.from(await object.Body!.transformToByteArray())
      verifiedObjects.push({ key: keyFor(reference), digest: reference.sha256, compressedBytes: compressed.length, compressedSha256: hash(compressed) })
    }
    assert.deepEqual(await readRust(identity), JSON.parse(canonicalJsonFor({ content, verifiedObjects })))
  }
  const reject = async (identity: Identity) => {
    await assert.rejects(readVerifiedPublicArtifact(client, config, identity, 'isolated rejected archive'))
    await assert.rejects(readRust(identity))
    await assert.rejects(readFile(join(root, 'output.json')), { code: 'ENOENT' }, 'Failure leaves no success descriptor')
  }
  const inline = (value: unknown) => ({ kind: 'inline', value })
  const node = (tree: unknown) => ({ artifactKind: 'public-archive-node', formatVersion: 1, tree })
  const activeKey = `${config.prefix}/active-generation.json`
  const activeBytes = Buffer.from('{"generationId":"untouched-public-fixture"}')
  try {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }))
    await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: activeKey, Body: activeBytes }))
    await t.test('plain envelopes, exact binary64 and UTF-16 strings/keys', async () => {
      const identity = await putContent({ artifactKind: 'public-fixture', values: [1e-7, -0, 9007199254740991, '\ud800', '😀'],
        '\udfff': 'unpaired key', '\uE000': 1, '😀': 2, toJSON: 'ordinary stored property', __proto__: null })
      await compare(identity)
      const empty = { ...config, prefix: '' }
      const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: keyFor(identity) }))
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: `objects/sha256/${identity.sha256}`,
        Body: Buffer.from(await object.Body!.transformToByteArray()), ContentEncoding: 'gzip', Metadata: object.Metadata }))
      const nested = await readRust(identity)
      assert.deepEqual(await invokeStorage(root, empty, { action: 'verify-public-artifact', ...identity }),
        { ...nested, verifiedObjects: nested.verifiedObjects.map((proof: { key: string }) => ({ ...proof, key: proof.key.slice(config.prefix.length + 1) })) })
    })
    await t.test('actual Node archive partitioning and recursive hydration', async () => {
      const prepared = prepareSemanticArtifact({ artifactKind: 'public-history-fixture', rows: Array.from({ length: 900 }, (_, index) => ({
        matchId: `match-${index}`, date: index < 450 ? '2025-01-01' : '2026-01-01', team: index % 17 === 0 ? '\ud800' : 'captured-fixture', notes: 'x'.repeat(1500),
      })) })
      assert.ok(prepared.children!.length > 2, 'The Node producer must exercise multiple archive levels')
      for (const object of [...prepared.children!, prepared]) await putBytes(object.canonicalBytes, object.compressed)
      await compare({ sha256: prepared.digest, bytes: prepared.bytes })
    })
    await t.test('noncanonical public JSON, duplicate keys and ordinary special keys', async () => {
      const text = ' { "schemaVersion": 1.0, "artifactKind": "public-semantic-artifact", "content": { "z": 1, "z": 2e0, "__proto__": { "safe": true }, "\\uD800": "\\uDFFF", "constructor": 3 } } \n'
      await compare(await putBytes(Buffer.from(text)))
      const lossy = Buffer.concat([Buffer.from('{"artifactKind":"public-semantic-artifact","schemaVersion":1,"content":{"text":"'),
        Buffer.from([0xff]), Buffer.from('"}}')])
      await compare(await putBytes(lossy))
    })
    await t.test('raw string controls fail while escaped controls and valid noncontrols retain parity', async () => {
      const envelope = (content: string) => Buffer.from(`{"artifactKind":"public-semantic-artifact","schemaVersion":1,"content":${content}}`)
      for (const control of ['\0', '\t', '\n', '\x1f']) {
        for (const content of [`{"before${control}after":1}`, `{"key":"before${control}after"}`]) {
          await reject(await putBytes(envelope(content)))
        }
      }
      const escaped = String.raw`\u0000\b\t\n\f\r\u001f`
      const valid = '\u007f\u2028'
      await compare(await putBytes(envelope(`{"${escaped}":"${escaped}","${valid}":"${valid}"}`)))
    })
    await t.test('JSON.parse nesting beyond 128 levels, numeric overflow and invalid grammar', async () => {
      const envelope = (content: string) => Buffer.from(`{"artifactKind":"public-semantic-artifact","schemaVersion":1,"content":${content}}`)
      for (const depth of [140, 500]) {
        const nested = `${'['.repeat(depth)}0${']'.repeat(depth)}`
        await compare(await putBytes(envelope(`{"nested":${nested}}`)))
        const inlineTree = `{"kind":"inline","value":{"nested":${nested}}}`
        await compare(await putBytes(envelope(`{"artifactKind":"public-archive-node","formatVersion":1,"tree":${inlineTree}}`)))
      }
      await compare(await putBytes(envelope('{"positive":1e400,"negative":-1e400,"values":[1e400,-1E+400,1e-400]}')))
      // Overflow keeps Number semantics during validation: Infinity === Infinity.
      const tree = (artifactKind: string) => `{"kind":"inline","value":{"artifactKind":${artifactKind}}}`
      const archive = (artifactKind: string, originalKind: string) => putBytes(envelope(
        `{"artifactKind":"public-artifact-archive","formatVersion":1,"tree":${tree(artifactKind)},"originalKind":${originalKind}}`))
      await compare(await archive('1e400', '2e400'))
      await compare(await archive('-1e400', '-1e999'))
      await reject(await archive('1e400', '-1e400'))
      await reject(await archive('1e400', 'null'))
      const child = await putBytes(envelope('{"artifactKind":"public-archive-node","formatVersion":1,"tree":{"kind":"inline","value":{"a":1e400}}}'))
      const part = { ...child, encoding: 'gzip', count: 1 }
      await compare(await putContent(node({ kind: 'map', parts: [part] })))
      for (const field of ['"count":1e400', '"bytes":1e400', '"year":1e400', '"startUtcDate":1e400,"endUtcDate":"2026-01-01"']) {
        const reference = `${JSON.stringify(part).slice(0, -1)},${field}}`
        await reject(await putBytes(envelope(`{"artifactKind":"public-archive-node","formatVersion":1,"tree":{"kind":"map","parts":[${reference}]}}`)))
      }
      for (const content of ['{"a":1,}', '{"a":[1,]}', '{"a":01}', '{"a":1.}', '{"a":.5}', '{"a":+1}', '{"a":NaN}', '{"a":Infinity}',
        '{"a":-}', '{"a":1e}', '{"a":"\\x"}', '{"a" 1}', '{1:2}', `{"a":${'['.repeat(200)}}`, '{"a":1} x']) {
        await reject(await putBytes(envelope(content)))
      }
    })
    await t.test('validated alternate, long-header and concatenated gzip transport', async () => {
      const semantic = Buffer.from(canonicalJsonFor({ artifactKind: 'public-semantic-artifact', schemaVersion: 1, content: { fixture: 'transport' } }))
      const gzip = gzipSync(semantic)
      const header = Buffer.from(gzip.subarray(0, 10))
      header[3] = 8 | 2
      const fields = Buffer.concat([header, Buffer.alloc(65_536, 97), Buffer.from([0])])
      const checksum = Buffer.alloc(2)
      checksum.writeUInt16LE(crc32(fields) & 0xffff)
      for (const transport of [gzipSync(semantic, { level: 1 }), Buffer.concat([fields, checksum, gzip.subarray(10)]),
        Buffer.concat([gzipSync(semantic.subarray(0, 20)), gzipSync(semantic.subarray(20))]), Buffer.concat([gzip, Buffer.alloc(8), Buffer.from([255])])]) {
        await compare(await putBytes(semantic, transport))
      }
      for (const offset of [gzip.length - 8, gzip.length - 4]) {
        const corrupt = Buffer.from(gzip)
        corrupt[offset] ^= 1
        await reject(await putBytes(semantic, corrupt))
      }
      for (const transport of [gzip.subarray(0, -1), Buffer.concat([gzip, Buffer.from([1])])]) {
        await reject(await putBytes(semantic, transport))
      }
    })
    await t.test('optional archive ranges, numeric years and missing inline properties', async () => {
      const child = await putContent(node({ kind: 'record', entries: [['a', inline('first')], ['\ud800', inline('last')], ['missing', { kind: 'inline' }]] }))
      const identity = await putContent(node({ kind: 'map', parts: [{ ...child, encoding: 'gzip', count: 3,
        path: '/captured', keyStart: 'a', keyEnd: '\ud800', year: 2026, startUtcDate: ['2026-01-01'], endUtcDate: '2026-01-02' }] }))
      await compare(identity)
      await compare(await putContent(node({ kind: 'inline' })))
    })
    await t.test('missing inline values remain own keys when map children merge', async () => {
      const part = async (tree: unknown) => ({ ...await putContent(node(tree)), encoding: 'gzip', count: 1 })
      const missing = await part({ kind: 'record', entries: [['k', { kind: 'inline' }]] })
      const present = await part(inline({ k: 1 }))
      const other = await part(inline({ other: 1 }))
      for (const parts of [[missing, present], [present, missing], [missing, missing]]) {
        await reject(await putContent(node({ kind: 'map', parts })))
      }
      await compare(await putContent(node({ kind: 'map', parts: [missing, other] })))
    })
    await t.test('archive schema, count, type, duplicate-key and depth failures', async () => {
      const child = await putContent(node(inline(['one', 'two'])))
      const reference = { ...child, encoding: 'gzip', count: 2 }
      for (const tree of [{ kind: 'list', parts: [{ ...reference, count: 1 }] }, { kind: 'map', parts: [reference] },
        { kind: 'list', parts: [] }, { kind: 'record', entries: [['same', inline(1)], ['same', inline(2)]] },
        { kind: 'list', parts: [{ ...reference, keyStart: 'z', keyEnd: 'a' }] },
        { kind: 'list', parts: [{ ...reference, startUtcDate: '2026-02-01', endUtcDate: '2026-01-01' }] },
        { kind: 'list', parts: [{ ...reference, path: 42 }] }, { kind: 'list', parts: [{ ...reference, bytes: 512_001 }] }]) {
        await reject(await putContent(node(tree)))
      }
      const mapChild = await putContent(node(inline({ duplicate: true })))
      await reject(await putContent(node({ kind: 'map', parts: [1, 2].map(() => ({ ...mapChild, encoding: 'gzip', count: 1 })) })))
      const wrongChild = await putContent({ artifactKind: 'public-artifact-archive', formatVersion: 1, tree: inline(['one']), originalKind: 'wrong' })
      await reject(await putContent(node({ kind: 'list', parts: [{ ...wrongChild, encoding: 'gzip', count: 1 }] })))
      await reject(await putContent({ artifactKind: 'public-artifact-archive', formatVersion: 1, tree: inline({ artifactKind: {} }), originalKind: {} }))
      for (const depth of [24, 25]) {
        let tree: unknown = inline(1)
        for (let index = 0; index < depth; index++) tree = { kind: 'record', entries: [['nested', tree]] }
        const identity = await putContent(node(tree))
        if (depth === 24) await compare(identity)
        else await reject(identity)
      }
      for (const content of [{ artifactKind: 'public-archive-node', formatVersion: 2, tree: inline(1) },
        { artifactKind: 'public-archive-node', formatVersion: 1, tree: null }]) await reject(await putContent(content))
    })
    await t.test('fresh reads detect child mutation, missing members and metadata corruption', async () => {
      const childSemantic = Buffer.from(canonicalJsonFor({ artifactKind: 'public-semantic-artifact', schemaVersion: 1, content: node(inline(['one'])) }))
      const child = await putBytes(childSemantic)
      const parent = await putContent(node({ kind: 'list', parts: [{ ...child, encoding: 'gzip', count: 1 }] }))
      await compare(parent)
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: keyFor(child) }))
      await reject(parent)
      await putBytes(childSemantic, gzipSync(Buffer.from('changed semantic content')))
      await reject(parent)
      await putBytes(childSemantic)
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: keyFor(child), Body: gzipSync(childSemantic), ContentEncoding: 'gzip',
        Metadata: { sha256: child.sha256, 'semantic-bytes': String(child.bytes), encoding: 'identity' } }))
      await reject(parent)
      await putBytes(childSemantic)
      await compare(parent)
    })
    await t.test('bad semantic envelopes and invalid root identities fail closed', async () => {
      for (const envelope of [{ artifactKind: 'wrong', schemaVersion: 1, content: {} },
        { artifactKind: 'public-semantic-artifact', schemaVersion: 2, content: {} },
        { artifactKind: 'public-semantic-artifact', schemaVersion: 1, content: [] }]) {
        await reject(await putBytes(Buffer.from(canonicalJsonFor(envelope))))
      }
      for (const identity of [{ sha256: 'not-a-digest', bytes: 1 }, { sha256: 'a'.repeat(64), bytes: 0 }]) await reject(identity)
    })
    const pointer = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: activeKey }))
    assert.deepEqual(Buffer.from(await pointer.Body!.transformToByteArray()), activeBytes)
    const identity = await putContent({ fixture: 'no-writes' })
    const before = (await client.send(new ListObjectsV2Command({ Bucket: config.bucket }))).Contents
    await compare(identity)
    assert.deepEqual((await client.send(new ListObjectsV2Command({ Bucket: config.bucket }))).Contents, before)
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
