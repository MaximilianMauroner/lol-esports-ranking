import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import {
  acquireBucketLease,
  assertBucketLease,
  getBucketObject,
  readActiveContentAddressedGeneration,
  readBucketJson,
  readPreviousGenerationAuthorities,
  releaseBucketLease,
  renewBucketLease,
  uploadContentAddressedPublicArtifacts,
  uploadRankingArtifacts as uploadRankingArtifactsImplementation,
  writeBucketJson,
  type BucketClient,
  type BucketStorageConfig,
} from '../scripts/railway-bucket.mjs'
import { canonicalJsonFor, canonicalPublicLogicalPath, prepareSemanticArtifact } from '../scripts/public-artifact-storage.mjs'
import { ORACLE_GAME_INVENTORY_DIGEST_SCHEME, oracleGameInventory, prepareOracleBaseline, prepareRawSourceReceipt, rawObjectReferenceFor } from '../scripts/raw-source-storage.mjs'
import { createPublicRankingManifestLoader } from '../src/lib/publicArtifacts/manifestLoader.ts'
import { fetchPublicSnapshotShard } from '../src/lib/publicArtifacts/resolver.ts'

const config = {
  enabled: true,
  bucket: 'bucket',
  endpoint: 'https://example.invalid',
  region: 'auto',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  prefix: 'rankings',
}

async function uploadRankingArtifacts(options: Parameters<typeof uploadRankingArtifactsImplementation>[0]) {
  let withRaw = options
  if (options?.generationId && !options.rawSourceGeneration) {
    withRaw = { ...options, rawSourceGeneration: testRawGeneration(String(options.generationId)) }
  }
  if (!withRaw?.generationId || withRaw.leaseAuthority) return uploadRankingArtifactsImplementation(withRaw)
  const fencingToken = Number(withRaw.fencingToken)
  const storage = { config: withRaw.config as BucketStorageConfig, client: withRaw.client as BucketClient }
  const current = await readBucketJson('active-generation.json', storage)
  const owner = `test-publication-${fencingToken}`
  const leaseValue = {
    ...(current.value ?? {}),
    leaseKey: 'ops/refresh-lease.json', leaseOwner: owner, leaseFencingToken: fencingToken,
    leaseAcquiredAt: '2026-07-23T00:00:00.000Z', leaseExpiresAt: '2099-01-01T00:00:00.000Z',
  }
  const written = await writeBucketJson('active-generation.json', leaseValue, {
    ...storage,
    ...(current.found ? { ifMatch: current.etag } : { ifNoneMatch: '*' }),
  })
  assert.equal(written.written, true)
  return uploadRankingArtifactsImplementation({
    ...withRaw,
    leaseAuthority: {
      key: 'ops/refresh-lease.json',
      lease: { owner, fencingToken, acquiredAt: leaseValue.leaseAcquiredAt, expiresAt: leaseValue.leaseExpiresAt },
    },
  })
}

function testRawGeneration(generationId: string) {
  const baseline = prepareOracleBaseline({
    csv: ['gameid,date,league,side,position,teamname,result', `${generationId}-game,2026-01-01,LCK,Blue,team,Alpha,1`, `${generationId}-game,2026-01-01,LCK,Red,team,Beta,0`].join('\n'),
    sourceFileName: `${generationId}.csv`,
    importerVersion: 'test-importer',
  })
  const prepared = prepareRawSourceReceipt({
    generationId,
    importerVersion: 'test-importer',
    coverage: { start: '2026-01-01', end: '2026-01-01' },
    sourceReceiptInputs: {},
    oracle: [{
      sourceFileName: baseline.source.sourceFileName,
      headerDigest: baseline.source.headerDigest,
      digestScheme: ORACLE_GAME_INVENTORY_DIGEST_SCHEME,
      effectiveOracleDigest: baseline.source.digest,
      gameInventory: oracleGameInventory(baseline.source),
      baseline: baseline.reference,
      deltas: [],
    }],
  })
  return {
    generationId,
    importerVersion: 'test-importer',
    coverage: { start: '2026-01-01', end: '2026-01-01' },
    sourceReceiptInputs: {},
    oracle: prepared.receipt.oracle,
    leaguepedia: [],
    lolesports: [],
    objects: [baseline.prepared],
    verifiedSourceFiles: [],
    receipt: prepared.receipt,
    receiptPrepared: prepared.prepared,
    receiptReference: rawObjectReferenceFor(prepared.prepared),
    sourceReceiptDigest: prepared.receipt.sourceReceiptDigest,
    rawIdentityDigest: prepared.receipt.rawIdentityDigest,
  }
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

test('every generation promotion requires the live shared lease and raw authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-required-lease-'))
  const publicDir = join(root, 'public')
  const client = memoryS3()
  await mkdir(publicDir, { recursive: true })
  await writeFile(join(publicDir, 'ranking-summary.json'), '{"artifactKind":"public-ranking-manifest"}\n')
  try {
    await assert.rejects(uploadRankingArtifactsImplementation({
      publicDataDir: publicDir, generationId: 'missing-lease', fencingToken: 1, config, client,
    }), /requires a live refresh lease authority/)
    assert.equal(client.objects.size, 0)

    const leasedClient = memoryS3()
    const lease = await acquireBucketLease('ops/refresh-lease.json', {
      owner: 'missing-raw',
      now: '2026-07-23T00:00:00.000Z',
      ttlMs: 60_000,
      config,
      client: leasedClient,
    })
    assert.equal(lease.acquired, true)
    if (!lease.acquired) return
    await assert.rejects(uploadRankingArtifactsImplementation({
      publicDataDir: publicDir,
      generationId: 'missing-raw',
      fencingToken: lease.lease.fencingToken,
      leaseAuthority: { key: 'ops/refresh-lease.json', ...lease },
      config,
      client: leasedClient,
    }), /requires a raw source generation authority/)
    assert.equal(leasedClient.objects.has('rankings/generations/missing-raw/manifest.json'), false)
    assert.equal(JSON.parse(leasedClient.objects.get('rankings/active-generation.json')!.body).generationId, undefined)

    const nongenerational = await uploadRankingArtifactsImplementation({ publicDataDir: publicDir, config, client })
    assert.equal(nongenerational.enabled, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('lost lease leaves uploaded generation objects orphaned and active pointer unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-orphan-'))
  const publicDir = join(root, 'public')
  await writeContentAddressedFixture(publicDir, 'orphan')
  const backing = memoryS3()
  let replaceAfterArtifact = false
  const client = {
    objects: backing.objects,
    async send(command: unknown) {
      const result = await backing.send(command)
      const { name, input } = commandDetails(command)
      if (replaceAfterArtifact && name === 'PutObjectCommand' && input.Key === 'rankings/generations/orphan/manifest.json') {
        const active = JSON.parse(backing.objects.get('rankings/active-generation.json')!.body)
        backing.objects.set('rankings/active-generation.json', {
          body: JSON.stringify({
            ...active,
            leaseOwner: 'new',
            leaseFencingToken: Number(active.leaseFencingToken) + 1,
            leaseExpiresAt: '2026-07-11T00:02:00Z',
          }),
          etag: 'replacement',
        })
      }
      return result
    },
  }
  await writeBucketJson('active-generation.json', { generationId: 'good', fencingToken: 2 }, { ifNoneMatch: '*', config, client })
  const current = await acquireBucketLease('lease.json', { owner: 'old', now: '2026-07-11T00:00:00Z', ttlMs: 60_000, config, client })
  assert.equal(current.acquired, true)
  if (!current.acquired) return
  replaceAfterArtifact = true
  try {
    await assert.rejects(() => uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'orphan',
      fencingToken: current.lease.fencingToken,
      leaseAuthority: { key: 'lease.json', lease: current.lease },
      now: () => new Date('2026-07-11T00:00:30Z'),
      config,
      client,
    }), /no longer authoritative/)
    assert.ok(client.objects.has('rankings/generations/orphan/manifest.json'))
    assert.equal(JSON.parse(client.objects.get('rankings/active-generation.json')!.body).generationId, 'good')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('takeover between final assertion and active-pointer write invalidates the exact promotion CAS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-promotion-race-'))
  const publicDir = join(root, 'public')
  const client = memoryS3()
  await writeContentAddressedFixture(publicDir, 'stale-generation')
  await writeBucketJson('active-generation.json', { generationId: 'current', fencingToken: 0 }, { ifNoneMatch: '*', config, client })
  const oldWorker = await acquireBucketLease('lease.json', { owner: 'old', now: '2026-07-11T00:00:00Z', ttlMs: 60_000, config, client })
  assert.equal(oldWorker.acquired, true)
  if (!oldWorker.acquired) return

  try {
    await assert.rejects(() => uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'stale-generation',
      fencingToken: oldWorker.lease.fencingToken,
      leaseAuthority: { key: 'lease.json', lease: oldWorker.lease, promotionEtag: oldWorker.promotionEtag },
      now: () => new Date('2026-07-11T00:00:30Z'),
      beforePromotionWrite: async () => {
        const replacement = await acquireBucketLease('lease.json', { owner: 'new', now: '2026-07-11T00:01:01Z', ttlMs: 60_000, config, client })
        assert.equal(replacement.acquired, true)
      },
      config,
      client,
    }), /Active generation changed during promotion/)
    assert.ok(client.objects.has('rankings/generations/stale-generation/manifest.json'))
    assert.equal(JSON.parse(client.objects.get('rankings/active-generation.json')!.body).generationId, 'current')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('post-promotion refresh state and receipt contain the same canonical telemetry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-canonical-metrics-'))
  const publicDir = join(root, 'public')
  const statePath = join(root, 'refresh-state.json')
  const client = memoryS3()
  await writeContentAddressedFixture(publicDir, 'generation-canonical')
  await writeFile(statePath, '{}\n')
  const lease = await acquireBucketLease('lease.json', { owner: 'worker', now: '2026-07-11T00:00:00Z', ttlMs: 60_000, config, client })
  assert.equal(lease.acquired, true)
  if (!lease.acquired) return
  const base = {
    schemaVersion: 1,
    runId: 'run-canonical',
    mode: 'gated',
    cause: 'pending-match',
    affected: { matchIds: ['match-1'], date: '2026-07-10' },
    freshness: { providerAvailableAt: null, detectedAt: '2026-07-11T00:00:00Z', publishedAt: null },
    stages: [{ name: 'public-serialization', result: 'completed', durationMs: 5, input: {}, output: { outputBytes: 3 } }],
  }
  try {
    const result = await uploadRankingArtifacts({
      publicDataDir: publicDir,
      statePath,
      generationId: 'generation-canonical',
      fencingToken: lease.lease.fencingToken,
      leaseAuthority: { key: 'lease.json', lease: lease.lease, promotionEtag: lease.promotionEtag },
      now: () => new Date('2026-07-11T00:00:30Z'),
      refreshTelemetry: (promotion: { promotedAt: string }) => ({ ...base, freshness: { ...base.freshness, publishedAt: promotion.promotedAt } }),
      refreshStateForUpload: ({ refreshTelemetry }: { refreshTelemetry: unknown }) => ({ lastRun: refreshTelemetry }),
      config,
      client,
    })
    const receipt = JSON.parse(client.objects.get('rankings/generations/generation-canonical/publish.json')!.body)
    const refreshState = JSON.parse(client.objects.get('rankings/raw/refresh-state.json')!.body)
    assert.deepEqual(receipt.refreshTelemetry, refreshState.lastRun)
    assert.deepEqual(receipt.refreshTelemetry, result.refreshTelemetry)
    assert.equal(receipt.refreshTelemetry.cause, 'pending-match')
    assert.deepEqual(receipt.refreshTelemetry.affected, { matchIds: ['match-1'], date: '2026-07-10' })
    assert.equal(receipt.refreshTelemetry.stages[0].name, 'public-serialization')
    assert.equal(receipt.refreshTelemetry.freshness.publishedAt, (result.promotion as { promotedAt: string }).promotedAt)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('semantic public artifacts produce deterministic gzip bytes over canonical uncompressed JSON', () => {
  const first = prepareSemanticArtifact({
    artifactKind: 'match-history-index',
    schemaVersion: 23,
    generatedAt: '2026-07-11T00:00:00Z',
    artifactMeta: { runId: 'run-one' },
    scopeIndex: { all: { url: '/data/matches/all.json?v=run-one' } },
  })
  const second = prepareSemanticArtifact({
    scopeIndex: { all: { url: '/data/matches/all.json?v=run-two' } },
    artifactMeta: { runId: 'run-two' },
    generatedAt: '2026-07-12T00:00:00Z',
    schemaVersion: 23,
    artifactKind: 'match-history-index',
  })

  assert.equal(second.digest, first.digest)
  assert.deepEqual(second.compressed, first.compressed)
  assert.equal(first.bytes, first.canonicalBytes.byteLength)
  assert.equal(gunzipSync(first.compressed).toString('utf8'), first.canonicalJson)
})

test('generation publish receipt is canonical, digest-bound, and safely CAS-repromoted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-publish-authority-'))
  const publicDir = join(root, 'public')
  const generationId = 'publish_authority'
  const client = memoryS3()
  try {
    await writeContentAddressedFixture(publicDir, generationId)
    await uploadRankingArtifacts({
      publicDataDir: publicDir, generationId, fencingToken: 1,
      now: () => new Date('2026-07-23T00:00:00.000Z'), config, client,
    })
    const key = `rankings/generations/${generationId}/publish.json`
    const first = client.objects.get(key)!
    const parsed = JSON.parse(first.body)
    assert.equal(first.body, canonicalJsonFor(parsed))
    assert.equal(first.contentType, 'application/json; charset=utf-8')
    assert.equal(first.contentEncoding, undefined)
    assert.equal(first.metadata?.sha256, createHash('sha256').update(first.bytes!).digest('hex'))
    assert.equal(first.metadata?.['semantic-bytes'], String(first.bytes!.byteLength))
    assert.equal(parsed.schemaVersion, 2)
    for (const authority of [parsed.authorities.publicManifest, parsed.authorities.rawReceipt]) {
      assert.equal(parsed.artifacts.filter((entry: Record<string, unknown>) => entry.key === authority.key
        && entry.digest === authority.digest && entry.bytes === authority.bytes && entry.contentType === authority.contentType).length, 1)
    }

    const firstEtag = first.etag
    await uploadRankingArtifacts({
      publicDataDir: publicDir, generationId, fencingToken: 2,
      now: () => new Date('2026-07-23T00:01:00.000Z'), config, client,
    })
    const repromoted = client.objects.get(key)!
    assert.notEqual(repromoted.etag, firstEtag)
    assert.equal(JSON.parse(repromoted.body).publishedAt, '2026-07-23T00:01:00.000Z')
    await assert.rejects(uploadRankingArtifacts({
      publicDataDir: publicDir, generationId, fencingToken: 3,
      now: () => new Date('2026-07-23T00:00:30.000Z'), config, client,
    }), /replacement is not newer/)
    assert.equal(client.objects.get(key)!.etag, repromoted.etag)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('content-addressed generation reuses unchanged objects, uploads only changed content, and remains reader-compatible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-content-addressed-'))
  const publicDir = join(root, 'public')
  const generationId = 'run_content_storage'
  const client = memoryS3()
  try {
    await writeContentAddressedFixture(publicDir, generationId)
    const first = await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId,
      fencingToken: 1,
      config,
      client,
    })
    const objectEntries = [...client.objects.entries()].filter(([key]) => key.startsWith('rankings/objects/sha256/'))
    const generationManifestObject = client.objects.get(`rankings/generations/${generationId}/manifest.json`)
    assert.ok(generationManifestObject)
    const generationManifest = JSON.parse(generationManifestObject.body)
    assert.equal(generationManifest.storageMode, 'content-addressed-gzip-v1')
    assert.equal(Object.keys(generationManifest.artifacts).length, 3)
    assert.equal(first.uploadedCount, 6)
    assert.equal(first.unchangedCount, 0)
    assert.equal(objectEntries.length, 3)

    let measuredCompressedBytes = 0
    let measuredSemanticBytes = 0
    for (const [logicalPath, entry] of Object.entries(generationManifest.artifacts) as Array<[string, {
      objectUrl: string
      sha256: string
      bytes: number
      encoding: string
      storageEncoding: string
      transportEncodings: string[]
    }]>) {
      const object = client.objects.get(`rankings/objects/sha256/${entry.sha256}`)
      assert.ok(object, logicalPath)
      assert.equal(entry.encoding, 'gzip')
      assert.equal(entry.storageEncoding, 'gzip')
      assert.deepEqual(entry.transportEncodings, ['identity', 'gzip'])
      assert.equal(object.contentEncoding, 'gzip')
      assert.equal(object.cacheControl, 'public, max-age=31536000, immutable')
      assert.equal(object.metadata?.sha256, entry.sha256)
      assert.equal(object.metadata?.['semantic-bytes'], String(entry.bytes))
      assert.equal(object.metadata?.encoding, 'gzip')
      assert.equal(gunzipSync(object.bytes!).byteLength, entry.bytes)
      measuredCompressedBytes += object.bytes!.byteLength
      measuredSemanticBytes += entry.bytes
    }
    assert.ok(measuredCompressedBytes < measuredSemanticBytes)
    const rawUploadedBytes = (first.uploaded as Array<{ key: string; bytes: number }>)
      .filter((entry) => entry.key.startsWith('rankings/raw/objects/sha256/'))
      .reduce((sum, entry) => sum + entry.bytes, 0)
    assert.equal(first.uploadedBytes, measuredCompressedBytes + generationManifestObject.bytes!.byteLength + rawUploadedBytes)
    assert.deepEqual(first.storage, {
      mode: 'content-addressed-gzip-v1',
      objectCount: 3,
      logicalArtifactCount: 3,
      semanticLogicalBytes: measuredSemanticBytes,
      compressedLogicalBytes: measuredCompressedBytes,
      uniqueCompressedBytes: measuredCompressedBytes,
    })

    const resolvedManifest = await getBucketObject('ranking-summary.json', { generationId, config, client })
    assert.equal(resolvedManifest.found, true)
    assert.equal(resolvedManifest.key, `rankings/generations/${generationId}/manifest.json`)
    const firstDigest = Object.values(generationManifest.artifacts)[0] as { sha256: string }
    const resolvedObject = await getBucketObject(`objects/sha256/${firstDigest.sha256}`, { generationId, config, client })
    assert.equal(resolvedObject.found, true)
    assert.equal(resolvedObject.contentEncoding, 'gzip')

    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input), 'https://reader.invalid')
      if (url.pathname === '/data/ranking-summary.json') {
        return new Response(new Uint8Array(generationManifestObject.bytes!), { headers: { 'Content-Type': 'application/json' } })
      }
      const object = client.objects.get(`rankings${url.pathname.replace(/^\/data/, '')}`)
      if (!object) return new Response(null, { status: 404 })
      return new Response(new Uint8Array(gunzipSync(object.bytes!)), {
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      })
    }
    const manifest = await createPublicRankingManifestLoader('/data/ranking-summary.json', fetcher)()
    const expected = manifest.snapshotIndex[manifest.defaultSnapshotKey]
    const snapshot = await fetchPublicSnapshotShard(expected.url, manifest.defaultSnapshotKey, expected, manifest, { fetcher })
    assert.equal(snapshot.matchCount, expected.matchCount)

    const repeated = await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId,
      fencingToken: 2,
      config,
      client,
    })
    assert.equal(repeated.uploadedCount, 0)
    assert.equal(repeated.unchangedCount, 6)
    assert.equal(repeated.unchangedBytes, measuredCompressedBytes + generationManifestObject.bytes!.byteLength + rawUploadedBytes)

    const changedGenerationId = 'run_content_storage_changed'
    await writeContentAddressedFixture(publicDir, changedGenerationId)
    const shardPath = join(publicDir, 'scopes', 'all.json')
    const changedShard = JSON.parse(await readFile(shardPath, 'utf8'))
    changedShard.storageTestMarker = 'one-semantic-change'
    await writeFile(shardPath, `${JSON.stringify(changedShard)}\n`)
    const changed = await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: changedGenerationId,
      fencingToken: 3,
      config,
      client,
    })
    assert.equal(changed.uploadedCount, 4)
    assert.equal(changed.unchangedCount, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('active content-addressed restore verifies pointer, manifest, and every referenced object authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-active-authority-'))
  const publicDir = join(root, 'public')
  try {
    const pointerClient = memoryS3()
    await writeContentAddressedFixture(publicDir, 'pointer-authority')
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'pointer-authority',
      fencingToken: 1,
      config,
      client: pointerClient,
    })
    const restored = await readActiveContentAddressedGeneration({ config, client: pointerClient })
    assert.equal(restored.found, true)
    assert.equal(Object.keys(restored.artifacts).length, 3)

    const activeObject = pointerClient.objects.get('rankings/active-generation.json')
    assert.ok(activeObject)
    const badPointer = { ...JSON.parse(activeObject.body), manifestDigest: '0'.repeat(64) }
    activeObject.body = `${JSON.stringify(badPointer)}\n`
    activeObject.bytes = Buffer.from(activeObject.body)
    await assert.rejects(
      readActiveContentAddressedGeneration({ config, client: pointerClient }),
      /Active public generation manifest authority mismatch/,
    )

    const objectClient = memoryS3()
    await writeContentAddressedFixture(publicDir, 'object-authority')
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'object-authority',
      fencingToken: 1,
      config,
      client: objectClient,
    })
    const generationManifest = JSON.parse(objectClient.objects.get('rankings/generations/object-authority/manifest.json')!.body)
    const rootIdentity = generationManifest.artifacts['/data/ranking-summary.json'] as { sha256: string }
    const rootObject = objectClient.objects.get(`rankings/objects/sha256/${rootIdentity.sha256}`)
    assert.ok(rootObject)
    rootObject.metadata = { ...rootObject.metadata, 'semantic-bytes': '1' }
    await assert.rejects(
      readActiveContentAddressedGeneration({ config, client: objectClient }),
      /Referenced content-addressed object metadata mismatch/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('active schema-v1 content-addressed cutover is read-only and the first v2 promotion drops its rollback target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-schema-cutover-'))
  const publicDir = join(root, 'public')
  const client = memoryS3()
  try {
    const oldGenerationId = 'pre_change_schema_v1'
    await writeContentAddressedFixture(publicDir, oldGenerationId)
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: oldGenerationId,
      fencingToken: 1,
      config,
      client,
    })

    const manifestKey = `rankings/generations/${oldGenerationId}/manifest.json`
    const storedManifest = client.objects.get(manifestKey)!
    const schemaV1 = { ...JSON.parse(storedManifest.body), schemaVersion: 1 }
    const schemaV1Body = `${JSON.stringify(schemaV1, null, 2)}\n`
    const schemaV1Bytes = Buffer.from(schemaV1Body)
    const schemaV1Digest = createHash('sha256').update(schemaV1Bytes).digest('hex')
    storedManifest.body = schemaV1Body
    storedManifest.bytes = schemaV1Bytes
    storedManifest.metadata = {
      sha256: schemaV1Digest,
      'semantic-bytes': String(schemaV1Bytes.byteLength),
    }

    const activeObject = client.objects.get('rankings/active-generation.json')!
    const oldPointer = JSON.parse(activeObject.body)
    delete oldPointer.publicManifestSchemaVersion
    oldPointer.manifestDigest = schemaV1Digest
    oldPointer.manifestBytes = schemaV1Bytes.byteLength
    oldPointer.manifestEtag = storedManifest.etag
    activeObject.body = JSON.stringify(oldPointer)
    activeObject.bytes = Buffer.from(activeObject.body)

    const delivered = await getBucketObject('ranking-summary.json', { config, client })
    assert.equal(delivered.cutover, 'schema-v1-active-manifest-to-v2')
    assert.equal(JSON.parse((await streamBytes(delivered.body)).toString('utf8')).schemaVersion, 2)
    assert.equal(JSON.parse(storedManifest.body).schemaVersion, 1)

    const restored = await readActiveContentAddressedGeneration({ config, client, verifyArtifacts: false })
    assert.equal(restored.found, true)
    assert.equal(restored.found && restored.cutover, 'schema-v1-active-manifest-to-v2')
    assert.equal(restored.found && restored.manifest.schemaVersion, 2)

    const nextGenerationId = 'first_native_schema_v2'
    await writeContentAddressedFixture(publicDir, nextGenerationId)
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: nextGenerationId,
      fencingToken: 2,
      config,
      client,
    })
    const promoted = JSON.parse(client.objects.get('rankings/active-generation.json')!.body)
    assert.equal(promoted.publicManifestSchemaVersion, 2)
    assert.equal(Object.hasOwn(promoted, 'previousGeneration'), false)
    assert.equal(JSON.parse(storedManifest.body).schemaVersion, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('content-addressed collisions and partial uploads fail before promotion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-content-failure-'))
  const publicDir = join(root, 'public')
  const generationId = 'run_content_failure'
  try {
    await writeContentAddressedFixture(publicDir, generationId)
    const collisionClient = memoryS3()
    await uploadRankingArtifacts({ publicDataDir: publicDir, generationId, fencingToken: 1, config, client: collisionClient })
    const changedShardPath = join(publicDir, 'scopes', 'all.json')
    const sameIdChangedShard = JSON.parse(await readFile(changedShardPath, 'utf8'))
    sameIdChangedShard.storageTestMarker = 'same-generation-different-manifest'
    await writeFile(changedShardPath, `${JSON.stringify(sameIdChangedShard)}\n`)
    await assert.rejects(
      uploadRankingArtifacts({ publicDataDir: publicDir, generationId, fencingToken: 2, config, client: collisionClient }),
      /Generation manifest collision/,
    )
    assert.equal(JSON.parse(collisionClient.objects.get('rankings/active-generation.json')!.body).fencingToken, 1)

    await writeContentAddressedFixture(publicDir, generationId)
    const objectKey = [...collisionClient.objects.keys()].find((key) => key.startsWith('rankings/objects/sha256/'))!
    collisionClient.objects.get(objectKey)!.metadata = { sha256: '0'.repeat(64), 'semantic-bytes': '1', encoding: 'gzip' }
    await assert.rejects(
      uploadRankingArtifacts({ publicDataDir: publicDir, generationId, fencingToken: 2, config, client: collisionClient }),
      /collision|metadata mismatch/,
    )
    assert.equal(JSON.parse(collisionClient.objects.get('rankings/active-generation.json')!.body).fencingToken, 1)

    const backing = memoryS3()
    await writeBucketJson('active-generation.json', { generationId: 'current', fencingToken: 4 }, { ifNoneMatch: '*', config, client: backing })
    let objectPuts = 0
    const partialClient = {
      objects: backing.objects,
      async send(command: unknown) {
        const { name, input } = commandDetails(command)
        if (name === 'PutObjectCommand' && String(input.Key).startsWith('rankings/objects/sha256/')) {
          objectPuts += 1
          if (objectPuts === 2) throw new Error('simulated partial object failure')
        }
        return backing.send(command)
      },
    }
    await assert.rejects(
      uploadRankingArtifacts({ publicDataDir: publicDir, generationId, fencingToken: 5, config, client: partialClient }),
      /simulated partial object failure/,
    )
    assert.equal(backing.objects.has(`rankings/generations/${generationId}/manifest.json`), false)
    assert.equal(JSON.parse(backing.objects.get('rankings/active-generation.json')!.body).generationId, 'current')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stale content-addressed publication never promotes its generation manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-content-stale-'))
  const publicDir = join(root, 'public')
  const generationId = 'run_content_stale'
  const client = memoryS3()
  try {
    await writeContentAddressedFixture(publicDir, generationId)
    await writeBucketJson('active-generation.json', { generationId: 'current', fencingToken: 10 }, { ifNoneMatch: '*', config, client })
    await assert.rejects(
      uploadRankingArtifacts({ publicDataDir: publicDir, generationId, fencingToken: 9, config, client }),
      /Stale refresh worker/,
    )
    assert.equal(client.objects.has(`rankings/generations/${generationId}/manifest.json`), true)
    assert.equal(JSON.parse(client.objects.get('rankings/active-generation.json')!.body).generationId, 'current')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('generation manifest mutation between upload and pointer CAS blocks activation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-content-manifest-race-'))
  const publicDir = join(root, 'public')
  const generationId = 'run_manifest_race'
  const client = memoryS3()
  try {
    await writeContentAddressedFixture(publicDir, generationId)
    await writeBucketJson('active-generation.json', { generationId: 'current', fencingToken: 1 }, { ifNoneMatch: '*', config, client })
    await assert.rejects(() => uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId,
      fencingToken: 2,
      beforePromotionWrite: () => {
        const key = `rankings/generations/${generationId}/manifest.json`
        const manifest = client.objects.get(key)!
        manifest.body = `${manifest.body} `
        manifest.bytes = Buffer.from(manifest.body)
        manifest.etag = 'mutated-manifest'
        manifest.metadata = { sha256: '0'.repeat(64) }
      },
      config,
      client,
    }), /Generation manifest changed before active pointer promotion/)
    assert.equal(JSON.parse(client.objects.get('rankings/active-generation.json')!.body).generationId, 'current')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent identical generation publishers conditionally create or reuse one immutable manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-content-concurrent-'))
  const publicDir = join(root, 'public')
  const generationId = 'run_concurrent_manifest'
  const backing = memoryS3()
  let manifestAttempts = 0
  let releaseManifestBarrier: (() => void) | undefined
  const manifestBarrier = new Promise<void>((resolve) => { releaseManifestBarrier = resolve })
  const client = {
    objects: backing.objects,
    async send(command: unknown) {
      const { name, input } = commandDetails(command)
      if (name === 'PutObjectCommand' && input.Key === `rankings/generations/${generationId}/manifest.json`) {
        manifestAttempts += 1
        if (manifestAttempts === 2) releaseManifestBarrier?.()
        await manifestBarrier
      }
      return backing.send(command)
    },
  }
  try {
    await writeContentAddressedFixture(publicDir, generationId)
    const [first, second] = await Promise.all([
      uploadContentAddressedPublicArtifacts(client, config, publicDir, generationId),
      uploadContentAddressedPublicArtifacts(client, config, publicDir, generationId),
    ])
    assert.equal(manifestAttempts, 2)
    const manifestKey = `rankings/generations/${generationId}/manifest.json`
    assert.equal(backing.objects.has(manifestKey), true)
    assert.equal(
      [first, second].filter((result) => result.uploaded.some((entry) => entry.key === manifestKey)).length,
      1,
    )
    assert.equal(
      [first, second].filter((result) => result.unchanged.some((entry) => entry.key === manifestKey)).length,
      1,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('logical path aliases and encoded traversal fail before any bucket upload', async () => {
  assert.equal(canonicalPublicLogicalPath('/data/scopes/%C3%81.json?v=run'), '/data/scopes/Á.json')
  assert.equal(canonicalPublicLogicalPath('/data/%2520.json'), '/data/%20.json')
  assert.equal(canonicalPublicLogicalPath('/data/%252F.json'), '/data/%2F.json')
  assert.equal(canonicalPublicLogicalPath('/data/%252e%252e.json'), '/data/%2e%2e.json')
  assert.throws(() => canonicalPublicLogicalPath('/data/a%2Fb.json'), /encoded path separators/)
  assert.throws(() => canonicalPublicLogicalPath('/data/%2e%2e/private.json'), /path traversal/)
  assert.throws(() => canonicalPublicLogicalPath('/data/%ZZ.json'), /invalid percent encoding/)

  for (const artifactPaths of [
    ['a%2Fb.json', 'a/b.json'],
    ['%2e%2e/private.json'],
    ['%ZZ.json'],
    ['alias%20x.json', 'alias x.json'],
  ]) {
    const root = await mkdtemp(join(tmpdir(), 'ranking-content-invalid-path-'))
    const publicDir = join(root, 'public')
    const client = memoryS3()
    try {
      await writeContentAddressedFixture(publicDir, 'run_invalid_path')
      for (const artifactPath of artifactPaths) {
        const target = join(publicDir, ...artifactPath.split('/'))
        await mkdir(join(target, '..'), { recursive: true })
        await writeFile(target, '{"artifactKind":"test-artifact"}\n')
      }
      await assert.rejects(
        uploadRankingArtifacts({ publicDataDir: publicDir, generationId: 'run_invalid_path', fencingToken: 1, config, client }),
        /encoded path separators|path traversal|invalid percent encoding|Duplicate public artifact logical path alias/,
      )
      assert.deepEqual([...client.objects.keys()], ['rankings/active-generation.json'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('double-encoded filenames are canonicalized exactly once before manifest assembly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-content-single-canonicalization-'))
  const publicDir = join(root, 'public')
  const generationId = 'run_single_canonicalization'
  const client = memoryS3()
  try {
    await writeContentAddressedFixture(publicDir, generationId)
    for (const artifactPath of ['%2520.json', '%252F.json', '%252e%252e.json']) {
      await writeFile(join(publicDir, artifactPath), '{"artifactKind":"test-artifact"}\n')
    }
    const result = await uploadContentAddressedPublicArtifacts(client, config, publicDir, generationId)
    const artifacts = result.manifest.artifacts as Record<string, unknown>
    assert.equal(Object.hasOwn(artifacts, '/data/%20.json'), true)
    assert.equal(Object.hasOwn(artifacts, '/data/%2F.json'), true)
    assert.equal(Object.hasOwn(artifacts, '/data/%2e%2e.json'), true)
    assert.equal(Object.hasOwn(artifacts, '/data/ .json'), false)
    assert.equal(Object.hasOwn(artifacts, '/data//.json'), false)
    assert.equal(Object.hasOwn(artifacts, '/data/...json'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('generation manifest validation finishes before any content object upload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-content-preflight-'))
  const publicDir = join(root, 'public')
  const client = memoryS3()
  try {
    await writeContentAddressedFixture(publicDir, 'run_manifest_source')
    await assert.rejects(
      uploadContentAddressedPublicArtifacts(client, config, publicDir, 'run_manifest_mismatch'),
      /generationId must match ranking root runId/,
    )
    assert.equal(client.objects.size, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function writeContentAddressedFixture(publicDir: string, generationId: string) {
  const rootManifest = JSON.parse(await readFile('public/data/ranking-summary.json', 'utf8'))
  const defaultKey = rootManifest.defaultSnapshotKey
  const defaultEntry = rootManifest.snapshotIndex[defaultKey]
  const shard = JSON.parse(await readFile(`public${new URL(defaultEntry.url, 'https://fixture.invalid').pathname}`, 'utf8'))
  const generatedAt = '2026-07-11T00:00:00.000Z'
  rootManifest.generatedAt = generatedAt
  rootManifest.artifactMeta = {
    schemaVersion: 23,
    runId: generationId,
    generatedAt,
    modelVersion: rootManifest.model.version,
    modelConfigHash: rootManifest.model.configHash,
  }
  rootManifest.snapshotIndex = {
    [defaultKey]: { ...defaultEntry, url: `/data/scopes/all.json?v=${generationId}` },
  }
  rootManifest.tournamentMovementIndexUrl = `/data/history/tournament-moves/index.json?v=${generationId}`
  delete rootManifest.playerDirectoryUrl
  delete rootManifest.teamDirectoryUrl
  delete rootManifest.teamHistoryIndexUrl
  delete rootManifest.teamHistoryUrl
  delete rootManifest.regionHistoryUrl
  delete rootManifest.matchHistoryIndexUrl
  delete rootManifest.fullSnapshotUrl
  shard.generatedAt = generatedAt
  shard.modelVersion = rootManifest.model.version
  shard.modelConfigHash = rootManifest.model.configHash
  shard.artifactMeta = { ...rootManifest.artifactMeta }

  await mkdir(join(publicDir, 'scopes'), { recursive: true })
  await mkdir(join(publicDir, 'history', 'tournament-moves'), { recursive: true })
  await writeFile(join(publicDir, 'ranking-summary.json'), `${JSON.stringify(rootManifest)}\n`)
  await writeFile(join(publicDir, 'scopes', 'all.json'), `${JSON.stringify(shard)}\n`)
  await writeFile(join(publicDir, 'history', 'tournament-moves', 'index.json'), `${JSON.stringify({
    artifactKind: 'tournament-movement-index',
    schemaVersion: 23,
    generatedAt,
    modelVersion: rootManifest.model.version,
    modelConfigHash: rootManifest.model.configHash,
    artifactMeta: { ...rootManifest.artifactMeta },
    tournaments: [],
  })}\n`)
}

function memoryS3() {
  const objects = new Map<string, {
    body: string
    bytes?: Buffer
    etag: string
    contentType?: string
    contentEncoding?: string
    cacheControl?: string
    metadata?: Record<string, string>
  }>()
  let version = 0
  return {
    objects,
    async send(command: unknown) {
      const { name, input } = commandDetails(command)
      const key = String(input.Key)
      if (name === 'GetObjectCommand') {
        const object = objects.get(key)
        if (!object) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
        const bytes = object.bytes ?? Buffer.from(object.body)
        return {
          Body: Readable.from([bytes]),
          ETag: object.etag,
          ContentLength: bytes.byteLength,
          ContentType: object.contentType,
          ContentEncoding: object.contentEncoding,
          CacheControl: object.cacheControl,
          Metadata: object.metadata,
        }
      }
      if (name === 'HeadObjectCommand') {
        const object = objects.get(key)
        if (!object) throw Object.assign(new Error('missing'), { name: 'NotFound' })
        const bytes = object.bytes ?? Buffer.from(object.body)
        return {
          ETag: object.etag,
          ContentLength: bytes.byteLength,
          ContentType: object.contentType,
          ContentEncoding: object.contentEncoding,
          CacheControl: object.cacheControl,
          Metadata: object.metadata,
        }
      }
      if (name === 'PutObjectCommand') {
        const bytes = await streamBytes(input.Body)
        const current = objects.get(key)
        if (input.IfNoneMatch === '*' && current) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        if (input.IfMatch && input.IfMatch !== current?.etag) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        const etag = `"${++version}"`
        objects.set(key, {
          body: bytes.toString('utf8'),
          bytes,
          etag,
          contentType: typeof input.ContentType === 'string' ? input.ContentType : undefined,
          contentEncoding: typeof input.ContentEncoding === 'string' ? input.ContentEncoding : undefined,
          cacheControl: typeof input.CacheControl === 'string' ? input.CacheControl : undefined,
          metadata: isStringRecord(input.Metadata) ? input.Metadata : undefined,
        })
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

async function streamBytes(value: unknown) {
  if (typeof value === 'string') return Buffer.from(value)
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value)
  const chunks: Buffer[] = []
  for await (const chunk of value as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === 'string'))
}
