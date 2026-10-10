import { referencePublicDataDir, referencePublicDir } from '../scripts/reference-public-data.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { Readable } from 'node:stream'
import test from 'node:test'
import zlib, { gunzipSync, gzipSync } from 'node:zlib'
import {
  acquireBucketLease,
  assertBucketLease,
  getBucketObject,
  readActiveContentAddressedGeneration,
  readActiveGenerationPublication,
  readActiveRawSourceAuthority,
  readPreviousGenerationAuthorities,
  readBucketJson,
  releaseBucketLease,
  renewBucketLease,
  uploadContentAddressedPublicArtifacts,
  uploadContentAddressedPublicArtifactPatch,
  uploadRankingArtifacts as uploadRankingArtifactsImplementation,
  writeBucketJson,
  type BucketClient,
  type BucketStorageConfig,
} from '../scripts/railway-bucket.mjs'
import { canonicalJsonFor, canonicalPublicLogicalPath, prepareSemanticArtifact } from '../scripts/public-artifact-storage.mjs'
import { createGenerationPublicationReceipt, parseGenerationPublicationReceipt, publicationReceiptBytes } from '../scripts/generation-publication.mjs'
import { ORACLE_GAME_INVENTORY_DIGEST_SCHEME, oracleGameInventory, prepareOracleBaseline, prepareRawSourceReceipt, rawObjectReferenceFor } from '../scripts/raw-source-storage.mjs'
import {
  prepareContentAddressedState,
  prepareStateObject,
  readActiveIncrementalState,
  stateObjectReferenceFor,
  syncContentAddressedStateObject,
  writeIncrementalStateManifest,
  type StateManifestAuthority,
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

test('acquiring the next lease preserves the current receipt-bound publication authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-next-lease-authority-'))
  const publicDir = join(root, 'public')
  const client = memoryS3()
  const generationId = 'current-publication'
  try {
    await writeContentAddressedFixture(publicDir, generationId)
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId,
      fencingToken: 1,
      config,
      client,
    })
    const before = await readBucketJson('active-generation.json', { config, client })

    const next = await acquireBucketLease('ops/refresh-lease.json', {
      owner: 'next-worker',
      now: '2100-01-01T00:00:00.000Z',
      ttlMs: 60_000,
      config,
      client,
    })
    assert.equal(next.acquired, true)
    const after = await readBucketJson('active-generation.json', { config, client })
    assert.equal(after.value?.fencingToken, before.value?.fencingToken)
    assert.equal(after.value?.leaseFencingToken, 2)

    const raw = await readActiveRawSourceAuthority({ config, client })
    assert.equal(raw.found, true)
    assert.equal(raw.receipt?.generationId, generationId)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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
    const { publicationObjects, ...missing } = matching
    assert.ok(publicationObjects)
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
          ...publicationObjects,
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

test('public and raw reuse measure alternate gzip sizes in the publication closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alternate-gzip-publication-'))
  const publicDir = join(root, 'public')
  const client = memoryS3()
  try {
    await writeContentAddressedFixture(publicDir, 'gzip-first')
    const originalRaw = testRawGeneration('gzip-first')
    await uploadRankingArtifacts({ publicDataDir: publicDir, generationId: 'gzip-first', fencingToken: 1, rawSourceGeneration: originalRaw, config, client })
    const altered = new Map<string, Buffer>()
    for (const [key, object] of client.objects) {
      if (!key.startsWith('rankings/objects/sha256/') && !key.startsWith('rankings/raw/objects/sha256/')) continue
      const alternate = gzipSync(gunzipSync(object.bytes!), { level: 0 })
      assert.notEqual(alternate.byteLength, object.bytes!.byteLength)
      object.bytes = alternate
      altered.set(key, alternate)
    }
    await writeContentAddressedFixture(publicDir, 'gzip-next')
    const nextReceipt = prepareRawSourceReceipt({ ...originalRaw.receipt, generationId: 'gzip-next' })
    const nextRaw = { ...originalRaw, generationId: 'gzip-next', receipt: nextReceipt.receipt,
      receiptPrepared: nextReceipt.prepared, receiptReference: rawObjectReferenceFor(nextReceipt.prepared),
    }
    const published = await uploadRankingArtifacts({ publicDataDir: publicDir, generationId: 'gzip-next', fencingToken: 2, rawSourceGeneration: nextRaw, config, client })
    const receipt = parseGenerationPublicationReceipt(published.publicationReceipt)
    const outcomes = published.unchanged as Array<{ key: string; bytes: number }>
    for (const outcome of outcomes) {
      const alternate = altered.get(outcome.key)
      if (!alternate) continue
      assert.equal(outcome.bytes, alternate.byteLength)
      assert.equal(receipt.objects.find((member) => member.key === outcome.key)?.bytes, alternate.byteLength)
      assert.deepEqual(client.objects.get(outcome.key)!.bytes, alternate)
    }
    assert.ok(outcomes.some((entry) => altered.has(entry.key) && entry.key.startsWith('rankings/objects/')))
    assert.ok(outcomes.some((entry) => altered.has(entry.key) && entry.key.startsWith('rankings/raw/')))
    const storage = published.storage as { compressedLogicalBytes: number }
    const publicSizes = receipt.objects.filter((member) => member.key.startsWith('rankings/objects/'))
      .reduce((sum, member) => sum + member.bytes, 0)
    assert.equal(storage.compressedLogicalBytes, publicSizes)
    assert.equal((await readActiveRawSourceAuthority({ config, client })).found, true)
    assert.equal((await readActiveContentAddressedGeneration({ config, client })).found, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('publication reuses only raw and public proofs from this upload and rechecks changed gzip bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'raw-public-publication-proof-'))
  const publicDir = join(root, 'public')
  const backing = memoryS3()
  const generationId = 'raw-public-proof'
  const raw = testRawGeneration(generationId)
  const originalBytes = new Map<string, Buffer>()
  const keyByCompressedHash = new Map<string, string>()
  const finalInflates = new Map<string, number>()
  const finalGets = new Map<string, number>()
  let finalCheck = false
  const compressedMember = (key: string) => key.startsWith('rankings/objects/sha256/') || key.startsWith('rankings/raw/objects/sha256/')
  const client = {
    objects: backing.objects,
    async send(command: unknown) {
      const { name, input } = commandDetails(command)
      const key = String(input.Key)
      if (finalCheck && name === 'GetObjectCommand' && compressedMember(key)) finalGets.set(key, (finalGets.get(key) ?? 0) + 1)
      return backing.send(command)
    },
  }
  const originalGunzip = gunzipSync
  t.mock.method(zlib, 'gunzipSync', (bytes: Parameters<typeof gunzipSync>[0], options?: Parameters<typeof gunzipSync>[1]) => {
    if (finalCheck && Buffer.isBuffer(bytes)) {
      const key = keyByCompressedHash.get(createHash('sha256').update(bytes).digest('hex'))
      if (key) finalInflates.set(key, (finalInflates.get(key) ?? 0) + 1)
    }
    return originalGunzip(bytes, options)
  })
  syncBuiltinESMExports()
  try {
    for (const [fencingToken, mode] of [[1, 'uploaded'], [2, 'reused'], [3, 'changed']] as const) {
      const nextId = `${generationId}-${fencingToken}`
      await writeContentAddressedFixture(publicDir, nextId)
      const nextReceipt = prepareRawSourceReceipt({ ...raw.receipt, generationId: nextId })
      const nextRaw = { ...raw, generationId: nextId, receipt: nextReceipt.receipt,
        receiptPrepared: nextReceipt.prepared, receiptReference: rawObjectReferenceFor(nextReceipt.prepared) }
      const patch = mode === 'reused' ? {
        previousManifest: JSON.parse(backing.objects.get(`rankings/generations/${generationId}-1/manifest.json`)!.body),
        changedArtifacts: [{ logicalPath: '/data/ranking-summary.json', value: JSON.parse(await readFile(join(publicDir, 'ranking-summary.json'), 'utf8')) }],
        onVerifiedStored: () => { throw new Error('Caller must not replace the internal stored-byte proof collector') },
      } : undefined
      finalCheck = false
      finalGets.clear()
      finalInflates.clear()
      const changedKeys = new Set<string>()
      if (mode === 'changed') {
        for (const [key, bytes] of originalBytes) {
          const alternate = Buffer.from(bytes)
          alternate[4] ^= 1 // Equal-length gzip MTIME change preserves the semantic value.
          assert.deepEqual(originalGunzip(alternate), originalGunzip(bytes))
          backing.objects.get(key)!.bytes = alternate
          changedKeys.add(key)
        }
      }
      const published = await uploadRankingArtifacts({ publicDataDir: publicDir, generationId: nextId, fencingToken,
        rawSourceGeneration: nextRaw, publicArtifactPatch: patch, config, client,
        beforePromotionWrite: () => {
          for (const [key, object] of backing.objects) {
            if (!compressedMember(key)) continue
            assert.ok(object.bytes)
            if (!originalBytes.has(key)) originalBytes.set(key, Buffer.from(object.bytes))
            // Record the final bytes for observing semantic fallback. Current-upload
            // proofs saw the alternate bytes, so an earlier upload's proof is unsafe.
            if (changedKeys.has(key)) object.bytes = originalBytes.get(key)!
            keyByCompressedHash.set(createHash('sha256').update(object.bytes).digest('hex'), key)
          }
          finalCheck = true
        },
      })
      const receipt = parseGenerationPublicationReceipt(published.publicationReceipt)
      const members = receipt.objects.filter((member) => compressedMember(member.key))
      assert.deepEqual([...finalGets.keys()].sort(), members.map((member) => member.key).sort())
      assert.ok([...finalGets.values()].every((count) => count === 1))
      const expectedInflates = mode === 'uploaded' ? members.filter((member) => member.key.startsWith('rankings/objects/'))
        : mode === 'changed' ? members.filter((member) => changedKeys.has(member.key)) : []
      assert.deepEqual([...finalInflates.keys()].sort(), expectedInflates.map((member) => member.key).sort())
      assert.ok([...finalInflates.values()].every((count) => count === 1))
      const rawReceiptKey = `rankings/${nextRaw.receiptReference.key}`
      const receiptMember = receipt.objects.find((member) => member.key === rawReceiptKey)
      assert.deepEqual(receiptMember, { key: rawReceiptKey, digest: nextRaw.receiptReference.sha256,
        bytes: backing.objects.get(rawReceiptKey)!.bytes!.byteLength, outcome: 'uploaded' })
    }
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await rm(root, { recursive: true, force: true })
  }
})

test('active publication proof reuse keeps fresh transport checks and isolated receipt scopes', async (t) => {
  let inflates = 0
  const gets: Array<{ bucket: string; key: string }> = []
  const originalGunzip = gunzipSync
  t.mock.method(zlib, 'gunzipSync', (bytes: Parameters<typeof gunzipSync>[0], options?: Parameters<typeof gunzipSync>[1]) => {
    inflates += 1
    return originalGunzip(bytes, options)
  })
  syncBuiltinESMExports()
  const observedClient = (backing: ReturnType<typeof memoryS3>) => ({
    async send(command: unknown) {
      const { name, input } = commandDetails(command)
      if (name === 'GetObjectCommand') gets.push({ bucket: String(input.Bucket), key: String(input.Key) })
      return backing.send(command)
    },
  })
  const read = async (
    fixture: ReturnType<typeof publicationClosureFixture>,
    client: BucketClient,
    storageConfig = config,
    verifyClosure = true,
  ) => {
    inflates = 0
    gets.length = 0
    const result = await readActiveGenerationPublication({ config: storageConfig, client, active: fixture.active, verifyClosure })
    assert.equal(result.found, true)
    assert.deepEqual(gets.map(({ key }) => key).sort(),
      [fixture.active.publicationReceiptKey, ...(verifyClosure ? fixture.receipt.objects.map(({ key }) => key) : [])].sort())
    return { result, inflates }
  }
  try {
    await t.test('repeated reads fetch every member but only changed gzip bytes inflate again', async () => {
      const backing = memoryS3()
      const fixture = publicationClosureFixture(backing)
      const client = observedClient(backing)
      assert.equal((await read(fixture, client)).inflates, fixture.compressedKeys.length)
      const repeated = await read(fixture, client)
      assert.equal(repeated.inflates, 0)
      assert.ok(repeated.result.found)
      repeated.result.receipt.objects[0].digest = '0'.repeat(64)
      assert.equal((await read(fixture, client)).inflates, 0)
      const target = backing.objects.get(fixture.compressedKeys[0])!
      assert.ok(target.bytes)
      const alternate = Buffer.from(target.bytes)
      alternate[4] ^= 1 // Equal-length MTIME change preserves the gzip payload.
      target.bytes = alternate
      assert.equal((await read(fixture, client)).inflates, 1)
      assert.equal((await read(fixture, client)).inflates, 0)
    })

    for (const mode of ['crc', 'semantic', 'metadata', 'length', 'missing'] as const) {
      await t.test(`warmed reads reject ${mode} corruption`, async () => {
        const backing = memoryS3()
        const fixture = publicationClosureFixture(backing)
        const client = observedClient(backing)
        await read(fixture, client)
        const key = fixture.compressedKeys[0]
        const target = backing.objects.get(key)!
        assert.ok(target.bytes && target.metadata)
        const original = Buffer.from(target.bytes)
        if (mode === 'crc') {
          target.bytes = Buffer.from(original)
          target.bytes[target.bytes.length - 8] ^= 1
        } else if (mode === 'semantic') {
          target.bytes = gzipSync(Buffer.from('{"fixture":"bad"}'))
          assert.equal(target.bytes.byteLength, original.byteLength)
        } else if (mode === 'metadata') target.metadata.sha256 = '0'.repeat(64)
        else if (mode === 'length') target.bytes = Buffer.concat([original, Buffer.from([0])])
        else backing.objects.delete(key)
        const expected = mode === 'crc' ? /publication object gzip is corrupt/
          : mode === 'semantic' ? /publication object digest mismatch/
            : mode === 'missing' ? /missing/ : /publication object authority mismatch/
        await assert.rejects(read(fixture, client), expected)
      })
    }

    await t.test('a changed response length is rejected even when the body and hash match', async () => {
      const backing = memoryS3()
      const fixture = publicationClosureFixture(backing)
      const observed = observedClient(backing)
      let wrongLength = false
      const client = { async send(command: unknown) {
        const response = await observed.send(command)
        const { name, input } = commandDetails(command)
        return 'ContentLength' in response && wrongLength && name === 'GetObjectCommand' && input.Key === fixture.compressedKeys[0]
          ? { ...response, ContentLength: Number(response.ContentLength) + 1 } : response
      } }
      await read(fixture, client)
      wrongLength = true
      await assert.rejects(read(fixture, client), /publication object authority mismatch/)
    })

    await t.test('unverified or invalid receipts and failed closures do not warm proofs', async () => {
      const backing = memoryS3()
      const fixture = publicationClosureFixture(backing)
      const client = observedClient(backing)
      assert.equal((await read(fixture, client, config, false)).inflates, 0)
      const invalid = { ...fixture, active: { ...fixture.active, fencingToken: 2 } }
      await assert.rejects(read(invalid, client), /pointer and publication receipt authorities differ/)
      const lastKey = fixture.compressedKeys.at(-1)!
      const target = backing.objects.get(lastKey)!
      assert.ok(target.bytes)
      const original = target.bytes
      target.bytes = Buffer.alloc(original.byteLength)
      await assert.rejects(read(fixture, client), /publication object gzip is corrupt/)
      target.bytes = original
      assert.equal((await read(fixture, client)).inflates, fixture.compressedKeys.length)
      assert.equal((await read(fixture, client)).inflates, 0)
    })

    await t.test('new clients, buckets, prefixes and receipt bindings start cold and replace the sole retained scope', async () => {
      const backing = memoryS3()
      const fixture = publicationClosureFixture(backing)
      const client = observedClient(backing)
      const coldInflates = fixture.compressedKeys.length
      await read(fixture, client)
      assert.equal((await read(fixture, observedClient(backing))).inflates, coldInflates)
      assert.equal((await read(fixture, client, { ...config, bucket: 'another-bucket' })).inflates, coldInflates)
      assert.equal((await read(fixture, client)).inflates, coldInflates)
      const otherPrefix = publicationClosureFixture(backing, 'closure', 'other-prefix')
      assert.equal((await read(otherPrefix, client, { ...config, prefix: 'other-prefix' })).inflates, coldInflates)
      assert.equal((await read(fixture, client)).inflates, coldInflates)
      const receiptObject = backing.objects.get(fixture.active.publicationReceiptKey)!
      receiptObject.etag = '"changed-receipt"'
      fixture.active.publicationReceiptEtag = receiptObject.etag
      assert.equal((await read(fixture, client)).inflates, coldInflates)
      fixture.receipt.fencing.owner = 'different-longer-owner'
      const changed = publicationReceiptBytes(fixture.receipt)
      receiptObject.bytes = changed.body
      receiptObject.metadata = { sha256: changed.digest, 'semantic-bytes': String(changed.bytes) }
      fixture.active.publicationReceiptDigest = changed.digest
      fixture.active.publicationReceiptBytes = changed.bytes
      assert.equal((await read(fixture, client)).inflates, coldInflates)
      const nextReceipt = publicationClosureFixture(backing, 'closure-next')
      assert.equal((await read(nextReceipt, client)).inflates, coldInflates)
      assert.equal((await read(fixture, client)).inflates, coldInflates)
    })

    await t.test('concurrent distinct receipts cannot replace another read\'s operation-local proofs', async () => {
      const firstBacking = memoryS3()
      const secondBacking = memoryS3()
      const first = publicationClosureFixture(firstBacking)
      const second = publicationClosureFixture(secondBacking)
      for (const key of second.compressedKeys) {
        const object = secondBacking.objects.get(key)!
        assert.ok(object.bytes)
        object.bytes = Buffer.from(object.bytes)
        object.bytes[4] ^= 1
      }
      const firstConfig = { ...config, bucket: 'bucket-a' }
      const secondConfig = { ...config, bucket: 'bucket-b' }
      let pauseFirst = false
      let release = () => {}
      let entered = () => {}
      const blocked = new Promise<void>((resolve) => { release = resolve })
      const reached = new Promise<void>((resolve) => { entered = resolve })
      const firstClient = observedClient(firstBacking)
      const secondClient = observedClient(secondBacking)
      const client = { async send(command: unknown) {
        const { input } = commandDetails(command)
        if (pauseFirst && input.Bucket === firstConfig.bucket && input.Key === first.active.manifestKey) {
          pauseFirst = false
          entered()
          await blocked
        }
        return input.Bucket === firstConfig.bucket ? firstClient.send(command) : secondClient.send(command)
      } }
      await read(first, client, firstConfig)
      inflates = 0
      gets.length = 0
      pauseFirst = true
      const firstRead = readActiveGenerationPublication({ config: firstConfig, client, active: first.active })
      try {
        await reached
        const secondRead = await readActiveGenerationPublication({ config: secondConfig, client, active: second.active })
        release()
        assert.equal(secondRead.found, true)
        assert.equal((await firstRead).found, true)
        assert.equal(inflates, second.compressedKeys.length)
        for (const bucket of [firstConfig.bucket, secondConfig.bucket]) {
          assert.deepEqual(gets.filter((entry) => entry.bucket === bucket).map(({ key }) => key).sort(),
            [first.active.publicationReceiptKey, ...first.receipt.objects.map(({ key }) => key)].sort())
        }
        assert.equal((await read(first, client, firstConfig)).inflates, 0)
        assert.equal((await read(second, client, secondConfig)).inflates, second.compressedKeys.length)
      } finally {
        release()
        await firstRead
      }
    })
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

for (const namespace of ['objects', 'raw/objects'] as const) {
  test(`publication rejects ${namespace} corruption after stored validation despite caller-supplied proofs`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'publication-proof-corruption-'))
    const publicDir = join(root, 'public')
    const client = memoryS3()
    const generationId = 'corrupt-raw-public-proof'
    const raw = testRawGeneration(generationId)
    const callerProofs = new Map<string, { key: string; digest: string; compressedBytes: number; compressedSha256: string }>()
    try {
      await writeContentAddressedFixture(publicDir, generationId)
      await uploadRankingArtifacts({ publicDataDir: publicDir, generationId, fencingToken: 1, rawSourceGeneration: raw, config, client })
      const target = [...client.objects].find(([key]) => key.startsWith(`rankings/${namespace}/sha256/`))
      assert.ok(target)
      const [key, stored] = target
      assert.ok(stored.bytes)
      const corruption = Buffer.alloc(stored.bytes.byteLength)
      assert.ok(stored.metadata)
      callerProofs.set(key, { key, digest: stored.metadata.sha256, compressedBytes: corruption.byteLength,
        compressedSha256: createHash('sha256').update(corruption).digest('hex') })
      const nextId = `${generationId}-next`
      await writeContentAddressedFixture(publicDir, nextId)
      const nextReceipt = prepareRawSourceReceipt({ ...raw.receipt, generationId: nextId })
      const nextRaw = { ...raw, generationId: nextId, receipt: nextReceipt.receipt,
        receiptPrepared: nextReceipt.prepared, receiptReference: rawObjectReferenceFor(nextReceipt.prepared) }
      await assert.rejects(uploadRankingArtifacts({ publicDataDir: publicDir, generationId: nextId, fencingToken: 2,
        rawSourceGeneration: nextRaw, config, client, verifiedObjects: callerProofs,
        beforePromotionWrite: () => { stored.bytes = corruption },
      }), /publication object gzip is corrupt/)
      assert.equal(JSON.parse(client.objects.get('rankings/active-generation.json')!.body).fencingToken, 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

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
        : /Invalid legacy native generation publish receipt schema/
      await assert.rejects(getBucketObject('ranking-summary.json', { config, client }), expected)
      await assert.rejects(readActiveIncrementalState({ config, client }), expected)
      await assert.rejects(readActiveRawSourceAuthority({ config, client }), expected)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the pre-readiness schema-v2 pointer restores through its legacy publish receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-legacy-native-pointer-'))
  const publicDir = join(root, 'public')
  const client = memoryS3()
  const generationId = 'legacy-native-pointer'
  try {
    await writeContentAddressedFixture(publicDir, generationId)
    const publicManifest = JSON.parse(await readFile(join(publicDir, 'ranking-summary.json'), 'utf8'))
    const raw = testRawGeneration(generationId)
    const state = await testStateAuthority(client, generationId, raw.sourceReceiptDigest, {
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
      client,
    })

    const activeObject = client.objects.get('rankings/active-generation.json')!
    const pointer = JSON.parse(activeObject.body)
    for (const field of [
      'publicationSchemaVersion',
      'publicationReceiptKey',
      'publicationReceiptDigest',
      'publicationReceiptBytes',
      'publicationReceiptEtag',
    ]) delete pointer[field]
    const publicAuthority = {
      key: pointer.manifestKey,
      digest: pointer.manifestDigest,
      bytes: pointer.manifestBytes,
      contentType: 'application/json; charset=utf-8',
    }
    const rawAuthority = {
      key: pointer.rawReceiptKey,
      digest: pointer.rawReceiptDigest,
      bytes: pointer.rawReceiptCompressedBytes,
      contentType: 'application/json; charset=utf-8',
    }
    const artifacts = [publicAuthority, rawAuthority]
    const legacyReceipt = {
      schemaVersion: 2,
      publishedAt: pointer.promotedAt,
      prefix: 'rankings',
      generationId,
      storageMode: 'content-addressed-gzip-v1',
      authorities: { publicManifest: publicAuthority, rawReceipt: rawAuthority },
      artifactCount: artifacts.length,
      uploadedCount: artifacts.length,
      uploadedBytes: artifacts.reduce((sum, entry) => sum + entry.bytes, 0),
      unchangedCount: 0,
      unchangedBytes: 0,
      artifacts,
      unchanged: [],
      skipped: [],
    }
    const receiptBytes = Buffer.from(canonicalJsonFor(legacyReceipt))
    const receiptDigest = createHash('sha256').update(receiptBytes).digest('hex')
    client.objects.set(`rankings/generations/${generationId}/publish.json`, {
      body: receiptBytes.toString('utf8'),
      bytes: receiptBytes,
      etag: '"legacy-publish"',
      contentType: 'application/json; charset=utf-8',
      metadata: { sha256: receiptDigest, 'semantic-bytes': String(receiptBytes.byteLength) },
    })
    activeObject.body = JSON.stringify(pointer)
    activeObject.bytes = Buffer.from(activeObject.body)
    activeObject.etag = '"legacy-native-pointer"'

    const restoredPublic = await readActiveContentAddressedGeneration({ config, client, verifyArtifacts: false })
    const restoredState = await readActiveIncrementalState({ config, client, checkpointLimit: 1 })
    const restoredRaw = await readActiveRawSourceAuthority({ config, client })
    assert.equal(restoredPublic.found, true)
    assert.equal(restoredState.found, true)
    assert.equal(restoredRaw.found, true)
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
    const promotion = result.promotion
    assert.ok(promotion && typeof promotion === 'object')
    assert.equal('completed' in promotion && promotion.completed, true)
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
    const legacyActive = client.objects.get('rankings/active-generation.json')!
    const renewed = await renewBucketLease('ops/refresh-lease.json', {
      etag: legacyActive.etag,
      lease: {
        owner: String(oldPointer.leaseOwner),
        fencingToken: Number(oldPointer.leaseFencingToken),
        acquiredAt: String(oldPointer.leaseAcquiredAt),
        expiresAt: String(oldPointer.leaseExpiresAt),
      },
    }, {
      now: '2026-07-24T00:00:00.000Z',
      ttlMs: 60_000,
      config,
      client,
    })
    assert.ok(renewed.renewed)
    const renewedActive = await readActiveContentAddressedGeneration({
      config,
      client,
      verifyArtifacts: false,
    })
    assert.equal(renewedActive.found, true)
    if (!renewedActive.found) throw new Error('Renewed legacy active generation was not found')
    assert.equal(renewedActive.cutover, 'schema-v1-active-manifest-to-v2')

    const released = await releaseBucketLease('ops/refresh-lease.json', renewed, {
      now: '2026-07-24T00:00:30.000Z',
      config,
      client,
    })
    assert.equal(released.released, true)
    const releasedActive = await readActiveContentAddressedGeneration({
      config,
      client,
      verifyArtifacts: false,
    })
    assert.equal(releasedActive.found, true)
    if (!releasedActive.found) throw new Error('Released legacy active generation was not found')
    assert.equal(releasedActive.cutover, 'schema-v1-active-manifest-to-v2')

    const unknownFieldClient = cloneMemoryS3(client)
    const unknownFieldObject = unknownFieldClient.objects.get('rankings/active-generation.json')!
    const unknownFieldPointer = JSON.parse(unknownFieldObject.body)
    unknownFieldPointer.unexpectedLeaseField = true
    unknownFieldObject.body = JSON.stringify(unknownFieldPointer)
    unknownFieldObject.bytes = Buffer.from(unknownFieldObject.body)
    await assert.rejects(
      readActiveContentAddressedGeneration({ config, client: unknownFieldClient, verifyArtifacts: false }),
      /unsupported native authority fields/,
    )

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
  const rootManifest = JSON.parse(await readFile(join(referencePublicDataDir, 'ranking-summary.json'), 'utf8'))
  const defaultKey = rootManifest.defaultSnapshotKey
  const defaultEntry = rootManifest.snapshotIndex[defaultKey]
  const shard = JSON.parse(await readFile(join(referencePublicDir, new URL(defaultEntry.url, 'https://fixture.invalid').pathname.slice(1)), 'utf8'))
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
): Promise<StateManifestAuthority> {
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

function publicationClosureFixture(client: ReturnType<typeof memoryS3>, generationId = 'closure', prefix = 'rankings') {
  const store = (key: string, semantic: Buffer, compressed = false) => {
    const bytes = compressed ? gzipSync(semantic) : semantic
    const digest = createHash('sha256').update(semantic).digest('hex')
    client.objects.set(key, {
      body: bytes.toString('utf8'), bytes, etag: '"fixture"',
      contentType: 'application/json; charset=utf-8',
      ...(compressed ? { contentEncoding: 'gzip' } : {}),
      metadata: { sha256: digest, 'semantic-bytes': String(semantic.byteLength) },
    })
    return { key, digest, bytes: bytes.byteLength }
  }
  const publicManifest = store(`${prefix}/generations/${generationId}/manifest.json`, Buffer.from('{"fixture":"manifest"}'))
  const compressed = ['raw/objects', 'objects', 'state/objects'].map((namespace) => {
    const semantic = Buffer.from(JSON.stringify({ fixture: namespace === 'raw/objects' ? 'raw' : namespace }))
    const digest = createHash('sha256').update(semantic).digest('hex')
    return store(`${prefix}/${namespace}/sha256/${digest}`, semantic, true)
  })
  const receipt = createGenerationPublicationReceipt({
    generationId, prefix, preparedAt: '2026-07-23T00:00:00.000Z',
    fencingToken: 1, leaseOwner: 'fixture', promotionEtag: '"promotion"',
    provenance: { modelVersion: 'fixture', modelConfigHash: 'fixture', source: 'test', dataMode: 'test', sourceProviders: ['test'] },
    authorities: { publicManifest, rawReceipt: compressed[0] },
    objects: [publicManifest, ...compressed].map((entry) => ({ ...entry, outcome: 'uploaded' as const })),
  })
  const publication = publicationReceiptBytes(receipt)
  const receiptKey = `${prefix}/generations/${generationId}/publish.json`
  store(receiptKey, publication.body)
  return {
    receipt,
    compressedKeys: compressed.map(({ key }) => key),
    active: {
      generationId, fencingToken: 1, manifestKey: publicManifest.key,
      publicationSchemaVersion: 1, publicationReceiptKey: receiptKey,
      publicationReceiptDigest: publication.digest, publicationReceiptBytes: publication.bytes,
      publicationReceiptEtag: '"fixture"',
    },
  }
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


test('synthetic archive over 40 MB publishes, restores fresh, and reuses its complete closure on the next generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-year-recovery-'))
  const publicDir = join(root, 'public')
  const client = memoryS3()
  try {
    await writeContentAddressedFixture(publicDir, 'year-rebuild')
    const history = { artifactKind: 'synthetic-history', sample: true, rows: Array.from({ length: 42_000 }, (_, index) => ({
      id: index, date: `${2020 + Math.floor(index / 4200)}-06-01`, detail: 'x'.repeat(1000),
    })) }
    const serialized = JSON.stringify(history)
    assert.ok(Buffer.byteLength(serialized) > 40_000_000)
    await writeFile(join(publicDir, 'history', 'archive.json'), serialized)
    await uploadRankingArtifacts({ publicDataDir: publicDir, generationId: 'year-rebuild', fencingToken: 1, config, client })
    const first = await readActiveContentAddressedGeneration({ config, client: cloneMemoryS3(client) })
    assert.ok(first.found)
    assert.equal(canonicalJsonFor(first.artifacts['/data/history/archive.json']), canonicalJsonFor(history))
    const archiveObjects = [...client.objects.entries()].filter(([key]) => key.startsWith('rankings/objects/sha256/'))
    assert.ok(archiveObjects.length > 80)
    for (const [, object] of archiveObjects) assert.ok(Number(object.metadata?.['semantic-bytes']) <= 1_000_000)
    await writeContentAddressedFixture(publicDir, 'year-next')
    const nextRoot: unknown = JSON.parse(await readFile(join(publicDir, 'ranking-summary.json'), 'utf8'))
    const patch = await uploadContentAddressedPublicArtifactPatch(client, config, { generationId: 'year-next', previousManifest: first.manifest!,
      changedArtifacts: [{ logicalPath: '/data/ranking-summary.json', value: nextRoot }] })
    assert.ok(patch.reused.length > 80)
    assert.ok(!patch.uploaded.some((entry) => entry.key.startsWith('rankings/objects/sha256/')))
    await uploadRankingArtifacts({ publicDataDir: publicDir, generationId: 'year-next', fencingToken: 2, config, client })
    const next = await readActiveContentAddressedGeneration({ config, client: cloneMemoryS3(client) })
    assert.ok(next.found)
    assert.equal(canonicalJsonFor(next.artifacts['/data/history/archive.json']), canonicalJsonFor(history))
    const previous = await readPreviousGenerationAuthorities({ config, client })
    assert.ok(previous.found)
    assert.equal(previous.previous?.generationId, 'year-rebuild')
    const childKey = archiveObjects.find(([, object]) => gunzipSync(object.bytes!).toString().includes('public-archive-node'))![0]
    const crossed = cloneMemoryS3(client)
    const active = JSON.parse(crossed.objects.get('rankings/active-generation.json')!.body)
    const receiptObject = crossed.objects.get(active.publicationReceiptKey)!
    const receipt = JSON.parse(receiptObject.body)
    receipt.objects = receipt.objects.filter((entry: { key: string }) => entry.key !== childKey)
    receiptObject.bytes = Buffer.from(canonicalJsonFor(receipt))
    receiptObject.body = receiptObject.bytes.toString()
    receiptObject.metadata = { ...receiptObject.metadata, 'semantic-bytes': String(receiptObject.bytes.byteLength), sha256: createHash('sha256').update(receiptObject.bytes).digest('hex') }
    active.publicationReceiptDigest = receiptObject.metadata.sha256
    active.publicationReceiptBytes = receiptObject.bytes.byteLength
    const pointerObject = crossed.objects.get('rankings/active-generation.json')!
    pointerObject.body = JSON.stringify(active)
    pointerObject.bytes = Buffer.from(pointerObject.body)
    await assert.rejects(readActiveContentAddressedGeneration({ config, client: crossed }), /outside publication receipt closure/)
    const missing = cloneMemoryS3(client)
    missing.objects.delete(childKey)
    await assert.rejects(readActiveContentAddressedGeneration({ config, client: missing }), /missing/)
    await assert.rejects(readPreviousGenerationAuthorities({ config, client: missing }), /missing/)
    const corrupt = cloneMemoryS3(client)
    corrupt.objects.get(childKey)!.bytes = Buffer.from('corrupt')
    await assert.rejects(readActiveContentAddressedGeneration({ config, client: corrupt }), /mismatch|corrupt/)
    await writeContentAddressedFixture(publicDir, 'year-partial')
    const failing = { objects: client.objects, send: async (command: unknown) => {
      const details = commandDetails(command)
      if (details.name === 'GetObjectCommand' && details.input.Key === childKey) throw new Error('archive unavailable')
      return client.send(command)
    } }
    await assert.rejects(uploadRankingArtifacts({ publicDataDir: publicDir, generationId: 'year-partial', fencingToken: 3, config, client: failing }), /archive unavailable/)
    assert.equal(JSON.parse(client.objects.get('rankings/active-generation.json')!.body).generationId, 'year-next')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('large generation directories remain bounded and browser lookup reads only needed directory pages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-year-directory-'))
  const publicDir = join(root, 'public')
  const client = memoryS3()
  try {
    await writeContentAddressedFixture(publicDir, 'directory-generation')
    await mkdir(join(publicDir, 'synthetic'))
    for (let index = 0; index < 4000; index++) await writeFile(join(publicDir, 'synthetic', `${String(index).padStart(4, '0')}.json`), '{"artifactKind":"synthetic","sample":true}')
    const publication = await uploadRankingArtifacts({ publicDataDir: publicDir, generationId: 'directory-generation', fencingToken: 1, config, client })
    const storage = publication.storage
    assert.ok(storage && typeof storage === 'object' && 'objectCount' in storage)
    assert.equal(storage.objectCount, [...client.objects.keys()].filter((key) => key.startsWith('rankings/objects/sha256/')).length)
    const stored = client.objects.get('rankings/generations/directory-generation/manifest.json')!
    assert.ok(stored.bytes!.byteLength <= 250_000)
    assert.ok(JSON.parse(stored.body).artifactDirectory)
    const reads: string[] = []
    const serving = { send: async (command: unknown) => { const details = commandDetails(command); if (details.name === 'GetObjectCommand') reads.push(String(details.input.Key)); return client.send(command) } }
    assert.ok((await getBucketObject('ranking-summary.json', { config, client: serving })).found)
    assert.ok(reads.filter((key) => key.startsWith('rankings/objects/')).length === 1, `bootstrap read ${reads.length} objects`)
    const restored = await readActiveContentAddressedGeneration({ config, client })
    assert.ok(restored.found)
    assert.equal(Object.keys(restored.manifest!.artifacts as object).length, 4003)
    let requests = 0
    const fetcher: typeof fetch = async (input) => {
      requests++
      const path = new URL(String(input), 'https://reader.invalid').pathname
      const object = path === '/data/ranking-summary.json' ? stored : client.objects.get(`rankings${path.replace(/^\/data/, '')}`)
      if (!object) return new Response(null, { status: 404 })
      return new Response(new Uint8Array(object.contentEncoding === 'gzip' ? gunzipSync(object.bytes!) : object.bytes!), { headers: { 'Content-Type': 'application/json' } })
    }
    const manifest = await createPublicRankingManifestLoader('/data/ranking-summary.json', fetcher)()
    const expected = manifest.snapshotIndex[manifest.defaultSnapshotKey]
    const snapshot = await fetchPublicSnapshotShard(expected.url, manifest.defaultSnapshotKey, expected, manifest, { fetcher })
    assert.equal(snapshot.matchCount, expected.matchCount)
    assert.ok(requests < 10, `lookup needed ${requests} requests`)
  } finally { await rm(root, { recursive: true, force: true }) }
})
