import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { isFullAuditEligible, parseFullAuditReceipt, publishFullAuditDayReceipt, stageFullAuditSnapshot, type FullSnapshotDescriptor } from '../scripts/full-audit-storage.mjs'
import { canonicalJsonFor } from '../scripts/public-artifact-storage.mjs'
import { prepareContentAddressedState, prepareStateObject, stateObjectReferenceFor } from '../scripts/incremental-state-storage.mjs'
import { prepareOracleBaseline, prepareRawSourceReceipt, ORACLE_GAME_INVENTORY_DIGEST_SCHEME, oracleGameInventory } from '../scripts/raw-source-storage.mjs'

const config = {
  enabled: true,
  bucket: 'bucket',
  endpoint: 'https://example.invalid',
  region: 'auto',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  prefix: 'rankings',
}

test('full audit eligibility is restricted to fenced daily/manual full promotions', () => {
  const eligible = {
    cause: 'daily-audit',
    result: 'publish-full',
    fullSnapshotPath: '/tmp/full.json',
    fullSnapshotDescriptor: descriptorFor(Buffer.from(`${JSON.stringify(fullSnapshotFixture())}\n`)),
    generationId: 'generation-1',
    fencingToken: 2,
    promotion: { completed: true, etag: 'etag' },
    stateManifestAuthority: { key: 'state', digest: 'a'.repeat(64) },
    rawReceiptAuthority: { reference: { key: 'raw' }, receipt: {} },
  }
  assert.equal(isFullAuditEligible(eligible), true)
  assert.equal(isFullAuditEligible({ ...eligible, cause: 'manual-force' }), true)
  for (const patch of [
    { cause: 'pending-match' },
    { result: 'publish-incremental' },
    { result: 'no-change' },
    { fullSnapshotPath: undefined },
    { fencingToken: undefined },
    { promotion: { completed: false, etag: 'etag' } },
    { stateManifestAuthority: undefined },
    { rawReceiptAuthority: undefined },
  ]) assert.equal(isFullAuditEligible({ ...eligible, ...patch }), false)
})

test('full audit snapshot gzip is deterministic, reusable, and verified before reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'full-audit-test-'))
  const snapshotPath = join(root, 'ranking-snapshot.full.json')
  const client = memoryS3()
  try {
    const bytes = Buffer.from(`${JSON.stringify(fullSnapshotFixture())}\n`)
    const snapshotDescriptor = descriptorFor(bytes)
    await writeFile(snapshotPath, bytes)
    const first = await stageFullAuditSnapshot({ fullSnapshotPath: snapshotPath, snapshotDescriptor, config, client })
    const second = await stageFullAuditSnapshot({ fullSnapshotPath: snapshotPath, snapshotDescriptor, config, client })
    assert.equal(first.status, 'uploaded')
    assert.equal(second.status, 'unchanged')
    assert.deepEqual(second.reference, first.reference)
    const stored = client.objects.get(`rankings/${first.reference.key}`)
    assert.ok(stored)
    assert.deepEqual(gunzipSync(stored.bytes), bytes)
    assert.equal(stored.metadata?.sha256, first.reference.sha256)
    assert.equal(stored.metadata?.['semantic-bytes'], String(bytes.byteLength))
    stored.metadata = { ...stored.metadata, sha256: '0'.repeat(64) }
    await assert.rejects(
      stageFullAuditSnapshot({ fullSnapshotPath: snapshotPath, snapshotDescriptor, config, client }),
      /metadata mismatch/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('full audit receipt parser enforces the canonical authority shape', () => {
  const digest = 'a'.repeat(64)
  const reference = { key: `raw/objects/sha256/${digest}`, sha256: digest, bytes: 10, compressedBytes: 20, storageEncoding: 'gzip' as const }
  const receipt = parseFullAuditReceipt({
    artifactKind: 'full-ranking-audit-receipt',
    schemaVersion: 1,
    auditDate: '2026-07-23',
    cause: 'daily-audit',
    generationId: 'generation-1',
    runId: 'generation-1',
    fencingToken: 4,
    promotedAt: '2026-07-23T02:00:00.000Z',
    model: { version: 'model-1', configHash: digest },
    sourceReceipt: reference,
    rawLedger: { ...reference, key: `state/objects/sha256/${digest}` },
    fullSnapshot: { ...reference, key: `audits/objects/sha256/${digest}` },
  })
  assert.equal(receipt.auditDate, '2026-07-23')
  assert.throws(() => parseFullAuditReceipt({ ...receipt, runId: 'other' }), /runId/)
  assert.throws(() => parseFullAuditReceipt({ ...receipt, auditDate: '2026-07-22' }), /promotedAt/)
})

test('day receipt is canonical, promotion-bound, lease-checked, and idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'full-audit-publish-test-'))
  const snapshotPath = join(root, 'ranking-snapshot.full.json')
  const client = memoryS3()
  const generationId = 'audit-generation'
  try {
    const publicManifest = {
      ...publicManifestFixture(),
      model: {
        ...publicManifestFixture().model,
        name: 'Transparent Power Index',
        ratingScale: { version: 'published-power-index-v1' },
        parameters: { initialTeamRating: 1500 },
      },
    }
    const snapshotBytes = Buffer.from(`${JSON.stringify(fullSnapshotFixture())}\n`)
    await writeFile(snapshotPath, snapshotBytes)
    const staged = await stageFullAuditSnapshot({ fullSnapshotPath: snapshotPath, snapshotDescriptor: descriptorFor(snapshotBytes), publicManifest, config, client })
    const baseline = prepareOracleBaseline({
      sourceFileName: 'oracle.csv', importerVersion: 'importer-v1',
      csv: 'gameid,date,league,side,position,teamname,result\ngame-1,2026-07-23,LCK,Blue,team,Alpha,1\ngame-1,2026-07-23,LCK,Red,team,Beta,0\n',
    })
    const raw = prepareRawSourceReceipt({
      generationId, importerVersion: 'importer-v1', coverage: { start: '2026-07-23', end: '2026-07-23' }, sourceReceiptInputs: {},
      oracle: [{ sourceFileName: baseline.source.sourceFileName, headerDigest: baseline.source.headerDigest, digestScheme: ORACLE_GAME_INVENTORY_DIGEST_SCHEME, effectiveOracleDigest: baseline.source.digest, gameInventory: oracleGameInventory(baseline.source), baseline: baseline.reference, deltas: [] }],
    })
    putPrepared(client, `rankings/raw/objects/sha256/${raw.prepared.digest}`, raw.prepared)
    const ledger = prepareStateObject({ artifactKind: 'canonical-ledger-test', rows: [] })
    putPrepared(client, `rankings/state/objects/sha256/${ledger.digest}`, ledger)
    const compatibility = { modelVersion: 'model-v1', modelConfigHash: 'config-v1', importerVersion: 'importer-v1', taxonomyVersion: 'taxonomy-v1', ratingCheckpointSchemaVersion: 1, causalPrefixSchemaVersion: 1, publicArtifactSchemaVersion: 1 }
    const preparedState = prepareContentAddressedState({
      generationId, canonicalLedgerReference: stateObjectReferenceFor(ledger), sourceReceiptDigest: raw.receipt.sourceReceiptDigest, compatibility,
      checkpoints: [{ boundary: { date: '2026-07-23', matchId: 'match-1' }, rawPrefix: { matchCount: 1, digest: 'a'.repeat(64) }, ratingCheckpoint: {}, causalSummaries: { sourcedPlayer: {}, dssTeam: {}, dssRegion: {}, rosterEra: {}, playerResume: {} } }],
    })
    for (const prepared of preparedState.objects) putPrepared(client, `rankings/state/objects/sha256/${prepared.digest}`, prepared)
    const stateKey = `rankings/state/generations/${generationId}.json`
    client.objects.set(stateKey, {
      bytes: preparedState.manifestPrepared.canonicalBytes,
      etag: '"state"',
      contentType: 'application/json; charset=utf-8',
      metadata: { sha256: preparedState.manifestPrepared.digest, 'semantic-bytes': String(preparedState.manifestPrepared.bytes) },
    })
    const active = {
      schemaVersion: 1, generationId, fencingToken: 4, manifestKey: `rankings/generations/${generationId}/manifest.json`,
      leaseKey: 'ops/refresh-lease.json', leaseOwner: 'worker', leaseFencingToken: 4, leaseExpiresAt: '2026-07-24T00:00:00.000Z',
    }
    client.objects.set('rankings/active-generation.json', { bytes: Buffer.from(JSON.stringify(active)), etag: '"promotion"' })
    const options = {
      cause: 'daily-audit' as const,
      generationId,
      fencingToken: 4,
      promotion: { completed: true as const, generationId, fencingToken: 4, promotedAt: '2026-07-23T12:00:00.000Z', etag: '"promotion"' },
      publicManifest,
      stateManifestAuthority: { key: stateKey, etag: '"state"', bytes: preparedState.manifestPrepared.bytes, digest: preparedState.manifestPrepared.digest, manifest: preparedState.manifest },
      rawReceiptAuthority: { reference: { key: `raw/objects/sha256/${raw.prepared.digest}`, sha256: raw.prepared.digest, bytes: raw.prepared.bytes, compressedBytes: raw.prepared.compressedBytes, storageEncoding: 'gzip' as const }, receipt: raw.receipt },
      stagedSnapshot: staged,
      leaseAuthority: { key: 'ops/refresh-lease.json', lease: { owner: 'worker', fencingToken: 4, acquiredAt: '2026-07-23T00:00:00.000Z', expiresAt: '2026-07-24T00:00:00.000Z' } },
      config,
      client,
      now: () => new Date('2026-07-23T12:00:01.000Z'),
    }
    const first = await publishFullAuditDayReceipt(options)
    const repeated = await publishFullAuditDayReceipt(options)
    assert.equal(first.status, 'uploaded')
    assert.equal(repeated.status, 'unchanged')
    const stored = client.objects.get('rankings/audits/days/2026-07-23.json')!
    assert.equal(stored.bytes.toString('utf8'), canonicalJsonFor(first.receipt))
    await assert.rejects(publishFullAuditDayReceipt({ ...options, promotion: { ...options.promotion, etag: '"stale"' } }), /Active generation changed/)
    await assert.rejects(publishFullAuditDayReceipt({ ...options, leaseAuthority: undefined } as never), /requires a live refresh lease/)

    const replaceActive = { ...active, fencingToken: 5, leaseFencingToken: 5 }
    client.objects.set('rankings/active-generation.json', { bytes: Buffer.from(JSON.stringify(replaceActive)), etag: '"promotion-5"' })
    const newerOptions = {
      ...options,
      fencingToken: 5,
      promotion: { ...options.promotion, fencingToken: 5, promotedAt: '2026-07-23T13:00:00.000Z', etag: '"promotion-5"' },
      leaseAuthority: { ...options.leaseAuthority, lease: { ...options.leaseAuthority.lease, fencingToken: 5 } },
    }
    assert.equal((await publishFullAuditDayReceipt(newerOptions)).status, 'replaced')
    await assert.rejects(publishFullAuditDayReceipt({ ...newerOptions, cause: 'manual-force' }), /Conflicting/)

    const staleActive = { ...active, fencingToken: 4, leaseFencingToken: 4 }
    client.objects.set('rankings/active-generation.json', { bytes: Buffer.from(JSON.stringify(staleActive)), etag: '"promotion-stale"' })
    await assert.rejects(publishFullAuditDayReceipt({
      ...options,
      promotion: { ...options.promotion, etag: '"promotion-stale"' },
    }), /newer full audit authority/)

    const raceActive = { ...active, fencingToken: 6, leaseFencingToken: 6 }
    client.objects.set('rankings/active-generation.json', { bytes: Buffer.from(JSON.stringify(raceActive)), etag: '"promotion-6"' })
    await assert.rejects(publishFullAuditDayReceipt({
      ...options,
      fencingToken: 6,
      promotion: { ...options.promotion, fencingToken: 6, promotedAt: '2026-07-24T01:00:00.000Z', etag: '"promotion-6"' },
      leaseAuthority: { ...options.leaseAuthority, lease: { ...options.leaseAuthority.lease, fencingToken: 6 } },
      beforeReceiptWrite: () => {
        client.objects.set('rankings/active-generation.json', {
          bytes: Buffer.from(JSON.stringify({ ...raceActive, leaseOwner: 'takeover', leaseFencingToken: 7 })),
          etag: '"takeover"',
        })
      },
    }), /lease-changed|lease-owner-changed/)
    assert.equal(client.objects.has('rankings/audits/days/2026-07-24.json'), false)

    client.objects.set('rankings/active-generation.json', { bytes: Buffer.from(JSON.stringify(raceActive)), etag: '"promotion-6"' })
    await assert.rejects(publishFullAuditDayReceipt({
      ...options,
      fencingToken: 6,
      promotion: { ...options.promotion, fencingToken: 6, promotedAt: '2026-07-25T01:00:00.000Z', etag: '"promotion-6"' },
      leaseAuthority: { ...options.leaseAuthority, lease: { ...options.leaseAuthority.lease, fencingToken: 6 } },
      beforeReceiptWrite: () => {
        client.objects.set('rankings/active-generation.json', {
          bytes: Buffer.from(JSON.stringify({ ...raceActive, generationId: 'same-owner-repromotion' })),
          etag: '"same-owner-repromotion"',
        })
      },
    }), /Active generation changed/)
    assert.equal(client.objects.has('rankings/audits/days/2026-07-25.json'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('full audit staging rejects non-JSON, stale, and mismatched provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'full-audit-schema-test-'))
  const snapshotPath = join(root, 'snapshot.json')
  const client = memoryS3()
  const manifest = publicManifestFixture()
  try {
    const validBytes = Buffer.from(`${JSON.stringify(fullSnapshotFixture())}\n`)
    const validDescriptor = descriptorFor(validBytes)
    await writeFile(snapshotPath, 'not-json')
    await assert.rejects(stageFullAuditSnapshot({ fullSnapshotPath: snapshotPath, snapshotDescriptor: validDescriptor, publicManifest: manifest, config, client }), /trusted build descriptor/)
    for (const snapshot of [
      { ...fullSnapshotFixture(), generatedAt: '2026-07-22T00:00:00.000Z' },
      { ...fullSnapshotFixture(), model: { version: 'other', configHash: 'config-v1' } },
      { ...fullSnapshotFixture(), source: 'other source' },
    ]) {
      const bytes = Buffer.from(JSON.stringify(snapshot))
      await writeFile(snapshotPath, bytes)
      await assert.rejects(stageFullAuditSnapshot({ fullSnapshotPath: snapshotPath, snapshotDescriptor: descriptorFor(bytes, snapshot), publicManifest: manifest, config, client }), /provenance/)
    }
    assert.equal([...client.objects.keys()].some((key) => key.includes('/audits/')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function publicManifestFixture() {
  return { generatedAt: '2026-07-23T00:00:00.000Z', source: 'test source', sources: [{ name: 'Oracle test' }], model: { version: 'model-v1', configHash: 'config-v1' } }
}

function fullSnapshotFixture() {
  return { artifactKind: 'full-ranking-artifact', schemaVersion: 23, generatedAt: '2026-07-23T00:00:00.000Z', source: 'test source', sources: [{ name: 'Oracle test' }], model: { version: 'model-v1', configHash: 'config-v1' } }
}

function descriptorFor(bytes: Buffer, snapshot = fullSnapshotFixture()): FullSnapshotDescriptor {
  return {
    artifactKind: 'full-ranking-artifact',
    schemaVersion: snapshot.schemaVersion,
    generatedAt: snapshot.generatedAt,
    source: snapshot.source,
    sources: snapshot.sources.map(({ name }) => ({ name })),
    model: snapshot.model,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
  }
}

function memoryS3() {
  const objects = new Map<string, {
    bytes: Buffer
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
      const typed = command as { constructor: { name: string }; input: Record<string, unknown> }
      const key = String(typed.input.Key)
      if (typed.constructor.name === 'GetObjectCommand') {
        const object = objects.get(key)
        if (!object) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
        return {
          Body: Readable.from([object.bytes]),
          ETag: object.etag,
          ContentLength: object.bytes.byteLength,
          ContentType: object.contentType,
          ContentEncoding: object.contentEncoding,
          CacheControl: object.cacheControl,
          Metadata: object.metadata,
        }
      }
      if (typed.constructor.name === 'HeadObjectCommand') {
        const object = objects.get(key)
        if (!object) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
        return {
          ETag: object.etag,
          ContentLength: object.bytes.byteLength,
          ContentType: object.contentType,
          ContentEncoding: object.contentEncoding,
          CacheControl: object.cacheControl,
          Metadata: object.metadata,
        }
      }
      if (typed.constructor.name === 'PutObjectCommand') {
        const current = objects.get(key)
        if (typed.input.IfNoneMatch === '*' && current) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        if (typed.input.IfMatch && typed.input.IfMatch !== current?.etag) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        const bytes = await bodyBytes(typed.input.Body)
        const object = {
          bytes,
          etag: `"${++version}"`,
          contentType: typeof typed.input.ContentType === 'string' ? typed.input.ContentType : undefined,
          contentEncoding: typeof typed.input.ContentEncoding === 'string' ? typed.input.ContentEncoding : undefined,
          cacheControl: typeof typed.input.CacheControl === 'string' ? typed.input.CacheControl : undefined,
          metadata: typed.input.Metadata as Record<string, string> | undefined,
        }
        objects.set(key, object)
        return { ETag: object.etag }
      }
      throw new Error(`Unsupported command ${typed.constructor.name}`)
    },
  }
}

function putPrepared(client: ReturnType<typeof memoryS3>, key: string, prepared: { compressed: Buffer; digest: string; bytes: number }) {
  client.objects.set(key, {
    bytes: prepared.compressed,
    etag: `"${prepared.digest.slice(0, 8)}"`,
    contentType: 'application/json; charset=utf-8',
    contentEncoding: 'gzip',
    metadata: { sha256: prepared.digest, 'semantic-bytes': String(prepared.bytes), encoding: 'gzip' },
  })
}

async function bodyBytes(value: unknown) {
  if (typeof value === 'string' || value instanceof Uint8Array) return Buffer.from(value)
  const chunks: Buffer[] = []
  for await (const chunk of value as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
