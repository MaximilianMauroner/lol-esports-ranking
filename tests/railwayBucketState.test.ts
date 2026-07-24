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
  readActiveRawSourceAuthority,
  readBucketJson,
  releaseBucketLease,
  renewBucketLease,
  uploadContentAddressedPublicArtifacts,
  uploadRankingArtifacts as uploadRankingArtifactsImplementation,
  writeBucketJson,
  type BucketClient,
  type BucketStorageConfig,
} from '../scripts/railway-bucket.mjs'
import { canonicalJsonFor, canonicalPublicLogicalPath, prepareSemanticArtifact } from '../scripts/public-artifact-storage.mjs'
import { createGenerationPublicationReceipt } from '../scripts/generation-publication.mjs'
import { ORACLE_GAME_INVENTORY_DIGEST_SCHEME, oracleGameInventory, prepareOracleBaseline, prepareRawSourceReceipt, rawObjectReferenceFor } from '../scripts/raw-source-storage.mjs'
import {
  prepareContentAddressedState,
  prepareStateObject,
  readActiveIncrementalState,
  stateObjectReferenceFor,
  syncContentAddressedStateObject,
  writeIncrementalStateManifest,
} from '../scripts/incremental-state-storage.mjs'
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

test('generation readiness closure rejects duplicate and mutable membership', () => {
  const identity = { key: 'rankings/generations/g1/manifest.json', digest: 'a'.repeat(64), bytes: 1 }
  const raw = { key: `rankings/raw/objects/sha256/${'b'.repeat(64)}`, digest: 'b'.repeat(64), bytes: 1 }
  const base = {
    generationId: 'g1',
    preparedAt: '2026-07-23T00:00:00.000Z',
    prefix: 'rankings',
    fencingToken: 1,
    leaseOwner: 'worker',
    promotionEtag: '"etag"',
    provenance: { modelVersion: 'm', modelConfigHash: 'c', source: 'test', dataMode: 'test', sourceProviders: ['test'] },
    authorities: { publicManifest: identity, rawReceipt: raw },
  }
  assert.throws(() => createGenerationPublicationReceipt({
    ...base,
    objects: [
      { ...identity, outcome: 'uploaded' },
      { ...raw, outcome: 'uploaded' },
      { key: 'rankings/raw/refresh-state.json', digest: 'c'.repeat(64), bytes: 1, outcome: 'uploaded' },
    ],
  }), /mutable or unknown namespace/)
  assert.throws(() => createGenerationPublicationReceipt({
    ...base,
    objects: [
      { ...identity, outcome: 'uploaded' },
      { ...identity, outcome: 'reused' },
      { ...raw, outcome: 'uploaded' },
    ],
  }), /duplicate membership/)
})

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
      promotionEtag: written.etag,
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
      leaseAuthority: { key: 'lease.json', lease: current.lease, promotionEtag: current.promotionEtag },
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
    }), /no longer authoritative|Active generation changed during promotion/)
    assert.ok(client.objects.has('rankings/generations/stale-generation/manifest.json'))
    assert.equal(JSON.parse(client.objects.get('rankings/active-generation.json')!.body).generationId, 'current')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readiness receipt failure leaves the prior active generation authoritative', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-receipt-failure-'))
  const publicDir = join(root, 'public')
  const generationId = 'receipt-failure'
  const backing = memoryS3()
  const client = {
    objects: backing.objects,
    async send(command: unknown) {
      const { name, input } = commandDetails(command)
      if (name === 'PutObjectCommand' && input.Key === `rankings/generations/${generationId}/publish.json`) {
        throw new Error('injected readiness receipt failure')
      }
      return backing.send(command)
    },
  }
  try {
    await writeContentAddressedFixture(publicDir, generationId)
    await writeBucketJson('active-generation.json', { generationId: 'prior', fencingToken: 0 }, { ifNoneMatch: '*', config, client })
    await assert.rejects(uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId,
      fencingToken: 1,
      config,
      client,
    }), /injected readiness receipt failure/)
    assert.equal(JSON.parse(client.objects.get('rankings/active-generation.json')!.body).generationId, 'prior')
    assert.equal(client.objects.has(`rankings/generations/${generationId}/manifest.json`), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readiness receipt stays pre-activation while mutable refresh telemetry records promotion', async () => {
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
    assert.equal(receipt.status, 'ready')
    assert.equal('refreshTelemetry' in receipt, false)
    assert.deepEqual(refreshState.lastRun, result.refreshTelemetry)
    assert.equal(refreshState.lastRun.cause, 'pending-match')
    assert.deepEqual(refreshState.lastRun.affected, { matchIds: ['match-1'], date: '2026-07-10' })
    assert.equal(refreshState.lastRun.stages[0].name, 'public-serialization')
    assert.equal(refreshState.lastRun.freshness.publishedAt, (result.promotion as { promotedAt: string }).promotedAt)
    const active = JSON.parse(client.objects.get('rankings/active-generation.json')!.body)
    assert.equal(active.publicationReceiptKey, 'rankings/generations/generation-canonical/publish.json')
    assert.equal(active.publicationReceiptDigest, client.objects.get(active.publicationReceiptKey)!.metadata?.sha256)
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

test('generation readiness receipt is canonical, digest-bound, and immutable', async () => {
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
    assert.equal(parsed.schemaVersion, 1)
    assert.equal(parsed.status, 'ready')
    for (const authority of [parsed.authorities.publicManifest, parsed.authorities.rawReceipt]) {
      assert.equal(parsed.objects.filter((entry: Record<string, unknown>) => entry.key === authority.key
        && entry.digest === authority.digest && entry.bytes === authority.bytes).length, 1)
    }

    const firstEtag = first.etag
    await assert.rejects(uploadRankingArtifacts({
      publicDataDir: publicDir, generationId, fencingToken: 2,
      now: () => new Date('2026-07-23T00:01:00.000Z'), config, client,
    }), /not identical and immutable/)
    assert.equal(client.objects.get(key)!.etag, firstEtag)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pre-promotion state model and publication outcomes are exact and exhaustive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-state-publication-contract-'))
  const publicDir = join(root, 'public')
  const generationId = 'state-publication-contract'
  const client = memoryS3()
  try {
    await writeContentAddressedFixture(publicDir, generationId)
    const rootManifest = JSON.parse(await readFile(join(publicDir, 'ranking-summary.json'), 'utf8'))
    const raw = testRawGeneration(generationId)
    const matching = await testStateAuthority(client, generationId, raw.sourceReceiptDigest, {
      modelVersion: rootManifest.model.version,
      modelConfigHash: rootManifest.model.configHash,
    })
    const missing = { ...matching }
    delete missing.publicationObjects
    await assert.rejects(uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId,
      fencingToken: 1,
      stateManifestAuthority: missing,
      rawSourceGeneration: raw,
      config,
      client,
    }), /publication outcomes are required/)

    await assert.rejects(uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId,
      fencingToken: 2,
      stateManifestAuthority: {
        ...matching,
        publicationObjects: [
          ...matching.publicationObjects,
          { key: `rankings/state/objects/sha256/${'f'.repeat(64)}`, digest: 'f'.repeat(64), bytes: 1, outcome: 'reused' },
        ],
      },
      rawSourceGeneration: raw,
      config,
      client,
    }), /not exhaustive/)

    client.objects.delete(String(matching.key))
    const mismatched = await testStateAuthority(client, generationId, raw.sourceReceiptDigest, {
      modelVersion: 'wrong-model',
      modelConfigHash: rootManifest.model.configHash,
    })
    await assert.rejects(uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId,
      fencingToken: 3,
      stateManifestAuthority: mismatched,
      rawSourceGeneration: raw,
      config,
      client,
    }), /state model authority does not match public generation/)
    assert.equal(JSON.parse(client.objects.get('rankings/active-generation.json')!.body).generationId, undefined)
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

    await assert.rejects(uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId,
      fencingToken: 2,
      config,
      client,
    }), /not identical and immutable/)

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
      /pointer and publication receipt authorities differ/,
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

test('active serving rejects unsupported and contradictory publication pointer schemas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-pointer-schema-'))
  const publicDir = join(root, 'public')
  const source = memoryS3()
  try {
    await writeContentAddressedFixture(publicDir, 'pointer-schema')
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'pointer-schema',
      fencingToken: 1,
      config,
      client: source,
    })
    const mutations = [
      {
        label: 'unknown marker 2',
        mutate: (pointer: Record<string, unknown>) => { pointer.publicationSchemaVersion = 2 },
        expected: /publication schema is unsupported/,
      },
      {
        label: 'unknown marker 999',
        mutate: (pointer: Record<string, unknown>) => {
          pointer.publicationSchemaVersion = 999
          delete pointer.storageMode
        },
        expected: /publication schema is unsupported/,
      },
      {
        label: 'receipt binding with invalid storage authority',
        mutate: (pointer: Record<string, unknown>) => { delete pointer.storageMode },
        expected: /invalid storage authority/,
      },
      {
        label: 'partial binding',
        mutate: (pointer: Record<string, unknown>) => { delete pointer.publicationReceiptEtag },
        expected: /receipt binding is incomplete/,
      },
      {
        label: 'contradictory legacy binding',
        mutate: (pointer: Record<string, unknown>) => { delete pointer.publicationSchemaVersion },
        expected: /contradictory publication receipt fields/,
      },
    ]
    for (const scenario of mutations) {
      const client = cloneMemoryS3(source)
      const active = client.objects.get('rankings/active-generation.json')!
      const pointer = JSON.parse(active.body)
      scenario.mutate(pointer)
      active.body = JSON.stringify(pointer)
      active.bytes = Buffer.from(active.body)
      await assert.rejects(
        getBucketObject('ranking-summary.json', { config, client }),
        scenario.expected,
        scenario.label,
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stripping publication bindings from a native pointer fails public, state, and raw readers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-native-pointer-downgrade-'))
  const publicDir = join(root, 'public')
  const source = memoryS3()
  const generationId = 'native-pointer-downgrade'
  try {
    await writeContentAddressedFixture(publicDir, generationId)
    const publicManifest = JSON.parse(await readFile(join(publicDir, 'ranking-summary.json'), 'utf8'))
    const raw = testRawGeneration(generationId)
    const state = await testStateAuthority(source, generationId, raw.sourceReceiptDigest, {
      modelVersion: publicManifest.model.version,
      modelConfigHash: publicManifest.model.configHash,
    })
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId,
      fencingToken: 1,
      stateManifestAuthority: state,
      rawSourceGeneration: raw,
      config,
      client: source,
    })

    for (const removePublicMarker of [false, true]) {
      const client = cloneMemoryS3(source)
      const activeObject = client.objects.get('rankings/active-generation.json')!
      const pointer = JSON.parse(activeObject.body)
      delete pointer.publicationSchemaVersion
      delete pointer.publicationReceiptKey
      delete pointer.publicationReceiptDigest
      delete pointer.publicationReceiptBytes
      delete pointer.publicationReceiptEtag
      if (removePublicMarker) delete pointer.publicManifestSchemaVersion
      activeObject.body = JSON.stringify(pointer)
      activeObject.bytes = Buffer.from(activeObject.body)
      activeObject.etag = removePublicMarker ? '"fully-stripped-native"' : '"stripped-native"'
      const expected = removePublicMarker
        ? /explicit schema-v1 cutover authority/
        : /unsupported native authority fields/
      await assert.rejects(getBucketObject('ranking-summary.json', { config, client }), expected)
      await assert.rejects(readActiveIncrementalState({ config, client }), expected)
      await assert.rejects(readActiveRawSourceAuthority({ config, client }), expected)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('verified active root serving is bounded, cached by pointer authority, and invalidated by a new ETag', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-root-serving-cache-'))
  const publicDir = join(root, 'public')
  const backing = memoryS3()
  const generationId = 'root-serving-cache'
  try {
    await writeContentAddressedFixture(publicDir, generationId)
    const publicManifest = JSON.parse(await readFile(join(publicDir, 'ranking-summary.json'), 'utf8'))
    const raw = testRawGeneration(generationId)
    const state = await testStateAuthority(backing, generationId, raw.sourceReceiptDigest, {
      modelVersion: publicManifest.model.version,
      modelConfigHash: publicManifest.model.configHash,
    })
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId,
      fencingToken: 1,
      stateManifestAuthority: state,
      rawSourceGeneration: raw,
      config,
      client: backing,
    })
    const reads: Array<{ key: string; bytes: number }> = []
    const client = {
      objects: backing.objects,
      async send(command: unknown) {
        const result = await backing.send(command)
        const { name, input } = commandDetails(command)
        if (name === 'GetObjectCommand') {
          reads.push({ key: String(input.Key), bytes: Number((result as { ContentLength?: number }).ContentLength ?? 0) })
        }
        return result
      },
    }

    const first = await getBucketObject('ranking-summary.json', { config, client })
    assert.equal(first.found, true)
    const storedGenerationManifest = JSON.parse(
      client.objects.get(`rankings/generations/${generationId}/manifest.json`)!.body,
    )
    const rootDigest = storedGenerationManifest.artifacts['/data/ranking-summary.json'].sha256
    assert.equal(reads.length, 4)
    assert.deepEqual(reads.map((read) => read.key), [
      'rankings/active-generation.json',
      `rankings/generations/${generationId}/publish.json`,
      `rankings/generations/${generationId}/manifest.json`,
      `rankings/objects/sha256/${rootDigest}`,
    ])
    assert.equal(reads.some((read) => read.key.includes('/state/')), false)
    assert.equal(reads.some((read) => read.key.includes('/raw/')), false)
    const firstBytes = reads.reduce((sum, read) => sum + read.bytes, 0)

    const second = await getBucketObject('ranking-summary.json', { config, client })
    assert.equal(second.found, true)
    assert.equal(second.etag, first.etag)
    assert.equal(reads.length, 5)
    assert.equal(reads[4].key, 'rankings/active-generation.json')
    assert.equal(reads.reduce((sum, read) => sum + read.bytes, 0) - firstBytes, reads[4].bytes)

    const activeObject = client.objects.get('rankings/active-generation.json')!
    const mutated = JSON.parse(activeObject.body)
    mutated.publicationReceiptDigest = '0'.repeat(64)
    activeObject.body = JSON.stringify(mutated)
    activeObject.bytes = Buffer.from(activeObject.body)
    activeObject.etag = '"new-active-etag"'
    await assert.rejects(
      getBucketObject('ranking-summary.json', { config, client }),
      /publication receipt authority mismatch/,
    )
    assert.equal(reads.at(-2)?.key, 'rankings/active-generation.json')
    assert.equal(reads.at(-1)?.key, `rankings/generations/${generationId}/publish.json`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('active reader rejects a receipt whose model provenance differs from the public manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-publication-model-authority-'))
  const publicDir = join(root, 'public')
  const client = memoryS3()
  try {
    await writeContentAddressedFixture(publicDir, 'publication-model-authority')
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'publication-model-authority',
      fencingToken: 1,
      config,
      client,
    })
    const activeObject = client.objects.get('rankings/active-generation.json')!
    const pointer = JSON.parse(activeObject.body)
    const receiptObject = client.objects.get(String(pointer.publicationReceiptKey))!
    const receipt = JSON.parse(receiptObject.body)
    receipt.provenance.modelVersion = 'different-model'
    const receiptBytes = Buffer.from(canonicalJsonFor(receipt))
    const receiptDigest = createHash('sha256').update(receiptBytes).digest('hex')
    const receiptEtag = '"resigned-receipt"'
    receiptObject.body = receiptBytes.toString('utf8')
    receiptObject.bytes = receiptBytes
    receiptObject.etag = receiptEtag
    receiptObject.metadata = {
      sha256: receiptDigest,
      'semantic-bytes': String(receiptBytes.byteLength),
    }
    pointer.publicationReceiptDigest = receiptDigest
    pointer.publicationReceiptBytes = receiptBytes.byteLength
    pointer.publicationReceiptEtag = receiptEtag
    activeObject.body = canonicalJsonFor(pointer)
    activeObject.bytes = Buffer.from(activeObject.body)

    await assert.rejects(
      getBucketObject('ranking-summary.json', { config, client }),
      /publication provenance does not match public manifest/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('post-commit operational failures return committed warnings without invalidating readers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-post-commit-warning-'))
  const publicDir = join(root, 'public')
  const statePath = join(root, 'refresh-state.json')
  const backing = memoryS3()
  let committed = false
  const client = {
    objects: backing.objects,
    async send(command: unknown) {
      const { name, input } = commandDetails(command)
      if (committed && name === 'GetObjectCommand' && input.Key === 'rankings/active-generation.json') {
        throw new Error('post-CAS lease assertion attempted')
      }
      if (committed && name === 'PutObjectCommand' && input.Key === 'rankings/raw/refresh-state.json') {
        throw new Error('injected post-CAS refresh-state failure')
      }
      const result = await backing.send(command)
      if (name === 'PutObjectCommand' && input.Key === 'rankings/active-generation.json'
        && JSON.parse(backing.objects.get('rankings/active-generation.json')!.body).generationId === 'post-commit-warning') {
        committed = true
      }
      return result
    },
  }
  try {
    await writeContentAddressedFixture(publicDir, 'post-commit-warning')
    await writeFile(statePath, '{}\n')
    const result = await uploadRankingArtifacts({
      publicDataDir: publicDir,
      statePath,
      refreshStateForUpload: () => ({ ok: true }),
      refreshTelemetry: () => { throw new Error('injected post-CAS audit/telemetry failure') },
      onStage: (name: string) => {
        if (name === 'promotion') throw new Error('injected post-CAS observer failure')
      },
      generationId: 'post-commit-warning',
      fencingToken: 1,
      config,
      client,
    })
    assert.equal(result.promotion?.completed, true)
    assert.equal(result.committedWithOperationalWarnings, true)
    assert.deepEqual(
      (result.operationalWarnings as Array<{ stage: string }>).map((warning) => warning.stage).sort(),
      ['post-commit-refresh-state', 'post-commit-telemetry', 'promotion-observer'],
    )
    committed = false
    const loaded = await readActiveContentAddressedGeneration({ config, client })
    assert.equal(loaded.found, true)
    assert.equal(loaded.found && loaded.active.generationId, 'post-commit-warning')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('active schema-v1 content-addressed cutover is read-only and the first v2 promotion drops its rollback target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-schema-cutover-'))
  const publicDir = join(root, 'public')
  const sourceClient = memoryS3()
  try {
    const oldGenerationId = 'pre_change_schema_v1'
    await writeContentAddressedFixture(publicDir, oldGenerationId)
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: oldGenerationId,
      fencingToken: 1,
      config,
      client: sourceClient,
    })

    const manifestKey = `rankings/generations/${oldGenerationId}/manifest.json`
    for (const marker of [undefined, 3]) {
      const mismatchedClient = cloneMemoryS3(sourceClient)
      const pointerObject = mismatchedClient.objects.get('rankings/active-generation.json')!
      const pointer = JSON.parse(pointerObject.body)
      if (marker === undefined) delete pointer.publicManifestSchemaVersion
      else pointer.publicManifestSchemaVersion = marker
      pointerObject.body = JSON.stringify(pointer)
      pointerObject.bytes = Buffer.from(pointerObject.body)
      await assert.rejects(
        readActiveContentAddressedGeneration({ config, client: mismatchedClient, verifyArtifacts: false }),
        /Active public generation manifest is invalid/,
      )
      await assert.rejects(
        getBucketObject('ranking-summary.json', { config, client: mismatchedClient }),
        /Active public generation manifest is invalid/,
      )
    }

    const storedManifest = sourceClient.objects.get(manifestKey)!
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

    const activeObject = sourceClient.objects.get('rankings/active-generation.json')!
    const markedPointer = JSON.parse(activeObject.body)
    markedPointer.manifestDigest = schemaV1Digest
    markedPointer.manifestBytes = schemaV1Bytes.byteLength
    markedPointer.manifestEtag = storedManifest.etag
    activeObject.body = JSON.stringify(markedPointer)
    activeObject.bytes = Buffer.from(activeObject.body)

    const markedClient = cloneMemoryS3(sourceClient)
    await assert.rejects(
      readActiveContentAddressedGeneration({ config, client: markedClient, verifyArtifacts: false }),
      /publication (?:receipt authorities differ|object authority mismatch)/,
    )
    await assert.rejects(
      getBucketObject('ranking-summary.json', { config, client: markedClient }),
      /pointer and publication receipt authorities differ/,
    )

    // Root serving revalidates the pointer against its receipt on every read.
    const cachedPointerObject = markedClient.objects.get('rankings/active-generation.json')!
    const cachedPointer = JSON.parse(cachedPointerObject.body)
    delete cachedPointer.publicManifestSchemaVersion
    cachedPointerObject.body = JSON.stringify(cachedPointer)
    cachedPointerObject.bytes = Buffer.from(cachedPointerObject.body)
    await assert.rejects(
      getBucketObject('ranking-summary.json', { config, client: markedClient }),
      /pointer and publication receipt authorities differ/,
    )

    const unknownMarkerClient = cloneMemoryS3(sourceClient)
    const unknownPointerObject = unknownMarkerClient.objects.get('rankings/active-generation.json')!
    const unknownPointer = JSON.parse(unknownPointerObject.body)
    unknownPointer.publicManifestSchemaVersion = 3
    unknownPointerObject.body = JSON.stringify(unknownPointer)
    unknownPointerObject.bytes = Buffer.from(unknownPointerObject.body)
    await assert.rejects(
      readActiveContentAddressedGeneration({ config, client: unknownMarkerClient, verifyArtifacts: false }),
      /publication (?:receipt authorities differ|object authority mismatch)/,
    )
    await assert.rejects(
      getBucketObject('ranking-summary.json', { config, client: unknownMarkerClient }),
      /pointer and publication receipt authorities differ/,
    )

    const oldPointer = JSON.parse(activeObject.body)
    delete oldPointer.publicManifestSchemaVersion
    delete oldPointer.publicationReceiptKey
    delete oldPointer.publicationReceiptDigest
    delete oldPointer.publicationReceiptBytes
    delete oldPointer.publicationReceiptEtag
    delete oldPointer.publicationSchemaVersion
    activeObject.body = JSON.stringify(oldPointer)
    activeObject.bytes = Buffer.from(activeObject.body)

    // A fresh process sees the pre-change pointer without a cached v2 marker.
    const client = cloneMemoryS3(sourceClient)
    const cutoverManifest = client.objects.get(manifestKey)!
    const delivered = await getBucketObject('ranking-summary.json', { config, client })
    assert.equal(delivered.cutover, 'schema-v1-active-manifest-to-v2')
    const deliveredBytes = await streamBytes(delivered.body)
    assert.equal(JSON.parse(deliveredBytes.toString('utf8')).schemaVersion, 2)
    assert.equal(delivered.etag, `"cutover-v2-${createHash('sha256').update(deliveredBytes).digest('hex')}"`)
    assert.notEqual(delivered.etag, cutoverManifest.etag)
    const repeated = await getBucketObject('ranking-summary.json', { config, client })
    assert.equal(repeated.etag, delivered.etag)
    assert.deepEqual(await streamBytes(repeated.body), deliveredBytes)
    assert.equal(JSON.parse(cutoverManifest.body).schemaVersion, 1)

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
    assert.equal(JSON.parse(cutoverManifest.body).schemaVersion, 1)
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
    }), /publication object authority mismatch/)
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

async function testStateAuthority(
  client: ReturnType<typeof memoryS3>,
  generationId: string,
  sourceReceiptDigest: string,
  model: { modelVersion: string; modelConfigHash: string },
) {
  const compatibility = {
    ...model,
    importerVersion: 'test-importer',
    taxonomyVersion: 'test-taxonomy',
    ratingCheckpointSchemaVersion: 1,
    causalPrefixSchemaVersion: 1,
    publicArtifactSchemaVersion: 23,
  }
  const ledger = prepareStateObject({ artifactKind: 'test-ledger', rows: [] })
  const ledgerResult = await syncContentAddressedStateObject(client, config, ledger)
  const prepared = prepareContentAddressedState({
    generationId,
    canonicalLedgerReference: stateObjectReferenceFor(ledger),
    sourceReceiptDigest,
    compatibility,
    checkpoints: [{
      boundary: { date: '2026-01-01', matchId: 'match-1' },
      rawPrefix: { matchCount: 1, digest: 'a'.repeat(64) },
      compatibility,
      ratingCheckpoint: {},
      causalSummaries: { sourcedPlayer: {}, dssTeam: {}, dssRegion: {}, rosterEra: {}, playerResume: {} },
    }],
  })
  const objectResults = []
  for (const object of prepared.objects) {
    objectResults.push(await syncContentAddressedStateObject(client, config, object))
  }
  const manifest = await writeIncrementalStateManifest(client, config, prepared)
  const publicationObjects = [ledgerResult, ...objectResults, manifest.result].map((entry) => ({
    key: String(entry.key),
    digest: String(entry.digest),
    bytes: Number(entry.bytes),
    outcome: entry.status === 'uploaded' ? 'uploaded' as const : 'unchanged' as const,
  }))
  return { ...manifest.authority, publicationObjects }
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

function cloneMemoryS3(source: ReturnType<typeof memoryS3>) {
  const clone = memoryS3()
  for (const [key, object] of source.objects) {
    clone.objects.set(key, {
      ...object,
      ...(object.bytes ? { bytes: Buffer.from(object.bytes) } : {}),
      ...(object.metadata ? { metadata: { ...object.metadata } } : {}),
    })
  }
  return clone
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
