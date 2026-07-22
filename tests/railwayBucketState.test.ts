import assert from 'node:assert/strict'
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
  readBucketJson,
  releaseBucketLease,
  renewBucketLease,
  uploadRankingArtifacts,
  writeBucketJson,
} from '../scripts/railway-bucket.mjs'
import { prepareSemanticArtifact } from '../scripts/public-artifact-storage.mjs'
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

test('takeover between final assertion and active-pointer write invalidates the exact promotion CAS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-promotion-race-'))
  const publicDir = join(root, 'public')
  const client = memoryS3()
  await mkdir(publicDir, { recursive: true })
  await writeFile(join(publicDir, 'ranking-summary.json'), '{}\n')
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
    assert.ok(client.objects.has('rankings/generations/stale-generation/data/ranking-summary.json'))
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
  await mkdir(publicDir, { recursive: true })
  await writeFile(join(publicDir, 'ranking-summary.json'), '{}\n')
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
      contentAddressed: true,
      config,
      client,
    })
    const objectEntries = [...client.objects.entries()].filter(([key]) => key.startsWith('rankings/objects/sha256/'))
    const generationManifestObject = client.objects.get(`rankings/generations/${generationId}/manifest.json`)
    assert.ok(generationManifestObject)
    const generationManifest = JSON.parse(generationManifestObject.body)
    assert.equal(generationManifest.storageMode, 'content-addressed-gzip-v1')
    assert.equal(Object.keys(generationManifest.artifacts).length, 3)
    assert.equal(first.uploadedCount, 4)
    assert.equal(first.unchangedCount, 0)
    assert.equal(objectEntries.length, 3)

    let measuredCompressedBytes = 0
    let measuredSemanticBytes = 0
    for (const [logicalPath, entry] of Object.entries(generationManifest.artifacts) as Array<[string, {
      objectUrl: string
      sha256: string
      bytes: number
      encoding: string
    }]>) {
      const object = client.objects.get(`rankings/objects/sha256/${entry.sha256}`)
      assert.ok(object, logicalPath)
      assert.equal(entry.encoding, 'gzip')
      assert.equal(object.contentEncoding, 'gzip')
      assert.equal(object.metadata?.sha256, entry.sha256)
      assert.equal(object.metadata?.['semantic-bytes'], String(entry.bytes))
      assert.equal(object.metadata?.encoding, 'gzip')
      assert.equal(gunzipSync(object.bytes!).byteLength, entry.bytes)
      measuredCompressedBytes += object.bytes!.byteLength
      measuredSemanticBytes += entry.bytes
    }
    assert.ok(measuredCompressedBytes < measuredSemanticBytes)
    assert.equal(first.uploadedBytes, measuredCompressedBytes + generationManifestObject.bytes!.byteLength)
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
        return new Response(generationManifestObject.bytes, { headers: { 'Content-Type': 'application/json' } })
      }
      const object = client.objects.get(`rankings${url.pathname.replace(/^\/data/, '')}`)
      if (!object) return new Response(null, { status: 404 })
      return new Response(gunzipSync(object.bytes!), {
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
      contentAddressed: true,
      config,
      client,
    })
    assert.equal(repeated.uploadedCount, 1)
    assert.equal(repeated.unchangedCount, 3)
    assert.equal(repeated.unchangedBytes, measuredCompressedBytes)

    const shardPath = join(publicDir, 'scopes', 'all.json')
    const changedShard = JSON.parse(await readFile(shardPath, 'utf8'))
    changedShard.storageTestMarker = 'one-semantic-change'
    await writeFile(shardPath, `${JSON.stringify(changedShard)}\n`)
    const changed = await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId,
      fencingToken: 3,
      contentAddressed: true,
      config,
      client,
    })
    assert.equal(changed.uploadedCount, 2)
    assert.equal(changed.unchangedCount, 2)
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
    await uploadRankingArtifacts({ publicDataDir: publicDir, generationId, fencingToken: 1, contentAddressed: true, config, client: collisionClient })
    const objectKey = [...collisionClient.objects.keys()].find((key) => key.startsWith('rankings/objects/sha256/'))!
    collisionClient.objects.get(objectKey)!.metadata = { sha256: '0'.repeat(64), 'semantic-bytes': '1', encoding: 'gzip' }
    await assert.rejects(
      uploadRankingArtifacts({ publicDataDir: publicDir, generationId, fencingToken: 2, contentAddressed: true, config, client: collisionClient }),
      /collision or metadata mismatch/,
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
      uploadRankingArtifacts({ publicDataDir: publicDir, generationId, fencingToken: 5, contentAddressed: true, config, client: partialClient }),
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
      uploadRankingArtifacts({ publicDataDir: publicDir, generationId, fencingToken: 9, contentAddressed: true, config, client }),
      /Stale refresh worker/,
    )
    assert.equal(client.objects.has(`rankings/generations/${generationId}/manifest.json`), true)
    assert.equal(JSON.parse(client.objects.get('rankings/active-generation.json')!.body).generationId, 'current')
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
          Metadata: object.metadata,
        }
      }
      if (name === 'PutObjectCommand') {
        const current = objects.get(key)
        if (input.IfNoneMatch === '*' && current) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        if (input.IfMatch && input.IfMatch !== current?.etag) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        const bytes = await streamBytes(input.Body)
        const etag = `"${++version}"`
        objects.set(key, {
          body: bytes.toString('utf8'),
          bytes,
          etag,
          contentType: typeof input.ContentType === 'string' ? input.ContentType : undefined,
          contentEncoding: typeof input.ContentEncoding === 'string' ? input.ContentEncoding : undefined,
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
