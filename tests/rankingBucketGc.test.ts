import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { buildRankingBucketInventory, deleteApprovedRankingBucketInventory, parseGcArgs } from '../scripts/ranking-bucket-gc.mjs'
import { acquireBucketLease } from '../scripts/railway-bucket.mjs'
import { canonicalJsonFor, prepareSemanticArtifact } from '../scripts/public-artifact-storage.mjs'
import { prepareContentAddressedState, prepareStateObject, stateObjectReferenceFor } from '../scripts/incremental-state-storage.mjs'
import {
  ORACLE_GAME_INVENTORY_DIGEST_SCHEME,
  oracleGameInventory,
  prepareNarrowSourceObject,
  prepareOracleBaseline,
  prepareOracleMutationChain,
  prepareRawSourceReceipt,
} from '../scripts/raw-source-storage.mjs'

const config = {
  enabled: true,
  bucket: 'bucket',
  endpoint: 'https://example.invalid',
  region: 'auto',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  prefix: 'rankings',
}
const now = () => new Date('2026-07-23T17:00:00.000Z')

test('GC arguments require deletion and an exact lowercase inventory digest together', () => {
  assert.deepEqual(parseGcArgs([]), { delete: false })
  const digest = 'a'.repeat(64)
  assert.deepEqual(parseGcArgs(['--delete', '--approved-inventory-sha256', digest]), { delete: true, approvedInventorySha256: digest })
  assert.throws(() => parseGcArgs(['--delete']), /requires/)
  assert.throws(() => parseGcArgs(['--approved-inventory-sha256', digest]), /requires --delete/)
  assert.throws(() => parseGcArgs(['--delete', '--approved-inventory-sha256', 'A'.repeat(64)]), /lowercase/)
})

test('inventory protects retained and operational objects while exposing only old immutable orphans', async () => {
  const client = gcMemoryS3(2)
  seedValidBucket(client)
  const inventory = await buildRankingBucketInventory({ config, client, now })
  assert.equal(inventory.valid, true, JSON.stringify(inventory.errors))
  assert.equal(inventory.inventoryDate, '2026-07-23')
  assert.equal(inventory.activePointer.etag, 'active-etag')
  assert.deepEqual(inventory.deletionCandidates.map((entry) => entry.key), [
    `rankings/objects/sha256/${'b'.repeat(64)}`,
    `rankings/raw/objects/sha256/${'d'.repeat(64)}`,
  ])
  assert.ok(inventory.protected.some((entry) => entry.key === 'rankings/generations/g1/manifest.json' && entry.reasons.includes('active-generation-public-manifest')))
  assert.ok(inventory.protected.some((entry) => entry.key === 'rankings/generations/g0/manifest.json' && entry.reasons.includes('previous-generation-public-manifest')))
  assert.ok(inventory.protected.some((entry) => entry.key === `rankings/objects/sha256/${'c'.repeat(64)}` && entry.reasons.includes('minimum-delete-age')))
  assert.ok(inventory.protected.some((entry) => entry.key === 'rankings/raw/files/legacy.csv' && entry.reasons.includes('operational-or-unknown-namespace')))
  for (const key of [
    'rankings/generations/%2e%2e/manifest.json',
    'rankings/generations/g1/data/../secret.json',
    'rankings/generations/g1/data//double.json',
    'rankings/generations/g1/data/%252e%252e/encoded.json',
    'rankings/generations/g1/control/delete.json',
    'rankings/audits/days/not-a-date.json',
  ]) {
    assert.ok(inventory.protected.some((entry) => entry.key === key && entry.reasons.includes('operational-or-unknown-namespace')), key)
  }
  assert.equal(inventory.inventorySha256.length, 64)

  const repeated = await buildRankingBucketInventory({ config, client, now })
  assert.equal(repeated.inventorySha256, inventory.inventorySha256)
  const originalKey = `rankings/objects/sha256/${'b'.repeat(64)}`
  const renamedKey = `rankings/objects/sha256/${'e'.repeat(64)}`
  const renamedObject = client.objects.get(originalKey)!
  client.objects.delete(originalKey)
  client.objects.set(renamedKey, renamedObject)
  const keyChanged = await buildRankingBucketInventory({ config, client, now })
  assert.notEqual(keyChanged.inventorySha256, inventory.inventorySha256)
  client.objects.delete(renamedKey)
  client.objects.set(originalKey, renamedObject)
  client.objects.get(`rankings/objects/sha256/${'b'.repeat(64)}`)!.lastModified = new Date('2026-07-18T00:00:00.000Z')
  const changed = await buildRankingBucketInventory({ config, client, now })
  assert.notEqual(changed.inventorySha256, keyChanged.inventorySha256)
})

test('generation retention is the union of the 14-day window and newest 50 roots', async () => {
  const client = gcMemoryS3(7)
  seedValidBucket(client)
  for (let index = 0; index < 51; index += 1) {
    seedGeneration(client, `new-${String(index).padStart(2, '0')}`, '2026-06-20T00:00:00.000Z')
  }
  seedGeneration(client, 'window-boundary', '2026-07-10T00:00:00.000Z')
  seedGeneration(client, 'outside-union', '2026-06-01T00:00:00.000Z')
  const repromoted = seedGeneration(client, 'repromoted', '2026-01-01T00:00:00.000Z')
  seedPublishReceipt(client, 'repromoted', repromoted)
  const inventory = await buildRankingBucketInventory({ config, client, now })
  assert.equal(inventory.valid, true, JSON.stringify(inventory.errors))
  assert.ok(inventory.protected.some((entry) => entry.key === 'rankings/generations/window-boundary/manifest.json'))
  assert.ok(inventory.protected.some((entry) => entry.key === 'rankings/generations/repromoted/manifest.json'))
  assert.ok(inventory.deletionCandidates.some((entry) => entry.key === 'rankings/generations/outside-union/manifest.json'))
  assert.equal(inventory.protected.filter((entry) => entry.key.includes('/generations/new-') && entry.key.endsWith('/manifest.json')).length, 47)
  assert.equal(inventory.deletionCandidates.filter((entry) => entry.key.includes('/generations/new-')).length, 4)
})

test('malformed or truncated generation activity invalidates inventory instead of extending retention', async () => {
  for (const mutate of [
    (receipt: Record<string, unknown>) => { delete receipt.unchangedBytes },
    (receipt: Record<string, unknown>) => { receipt.artifactCount = 0 },
  ]) {
    const client = gcMemoryS3()
    seedValidBucket(client)
    const manifest = seedGeneration(client, 'invalid-repromotion', '2026-01-01T00:00:00.000Z')
    const receipt = seedPublishReceipt(client, 'invalid-repromotion', manifest) as Record<string, unknown>
    mutate(receipt)
    seedCanonicalJson(client, 'rankings/generations/invalid-repromotion/publish.json', receipt, '2026-07-23T00:00:00.000Z')
    const inventory = await buildRankingBucketInventory({ config, client, now })
    assert.equal(inventory.valid, false)
    assert.equal(inventory.deletionCandidates.length, 0)
    assert.ok(inventory.errors.some((error) => error.key.endsWith('/invalid-repromotion/publish.json')))
  }
})

test('missing retained references fail closed with no deletion candidates', async () => {
  const client = gcMemoryS3()
  seedValidBucket(client)
  client.objects.delete('rankings/generations/g1/manifest.json')
  const inventory = await buildRankingBucketInventory({ config, client, now })
  assert.equal(inventory.valid, false)
  assert.equal(inventory.deletionCandidates.length, 0)
  assert.ok(inventory.missingReferences.some((entry) => entry.referencedKey === 'rankings/generations/g1/manifest.json'))
})

test('minimum deletion age includes exactly 48 hours and protects just under', async () => {
  const client = gcMemoryS3()
  seedValidBucket(client)
  const exact = `rankings/objects/sha256/${'1'.repeat(64)}`
  const under = `rankings/objects/sha256/${'2'.repeat(64)}`
  client.set(exact, Buffer.from('exact'), '2026-07-21T17:00:00.000Z')
  client.set(under, Buffer.from('under'), '2026-07-21T17:00:01.000Z')
  const inventory = await buildRankingBucketInventory({ config, client, now })
  assert.ok(inventory.deletionCandidates.some((entry) => entry.key === exact && entry.ageHours === 48))
  assert.ok(inventory.protected.some((entry) => entry.key === under && entry.reasons.includes('minimum-delete-age')))
})

test('retained public, recursive state, current raw, and recent audit roots protect shared closure', async () => {
  const client = gcMemoryS3(3)
  seedValidBucket(client)
  const graph = seedRetainedGraph(client)
  const inventory = await buildRankingBucketInventory({ config, client, now })
  assert.equal(inventory.valid, true, JSON.stringify(inventory.errors))
  for (const key of graph.requiredKeys) {
    assert.ok(inventory.protected.some((entry) => entry.key === key), `expected retained reference ${key}`)
    assert.equal(inventory.missingReferences.some((entry) => entry.referencedKey === key), false)
  }
  assert.ok(inventory.protected.find((entry) => entry.key === graph.sharedPublicKey)?.reasons.includes('retained-public-artifact'))
  assert.ok(inventory.protected.find((entry) => entry.key === graph.ledgerKey)?.reasons.includes('retained-audit-ledger'))
  assert.ok(inventory.protected.find((entry) => entry.key === graph.rawNarrowKey)?.reasons.includes('retained-raw-reference'))
  assert.equal(inventory.protected.filter((entry) => entry.reasons.includes('retained-daily-audit')).length, 2)
})

test('corrupt retained content and pointer ETag/reference mutations change or invalidate approval', async () => {
  const client = gcMemoryS3()
  seedValidBucket(client)
  const graph = seedRetainedGraph(client)
  const baseline = await buildRankingBucketInventory({ config, client, now })
  const activeForBadPrevious = JSON.parse(client.objects.get('rankings/active-generation.json')!.bytes.toString('utf8'))
  activeForBadPrevious.previousGeneration = {
    generationId: 'g0', manifestKey: 'rankings/generations/g0/manifest.json',
    stateManifestKey: 'rankings/state/generations/g0.json', stateManifestDigest: 'f'.repeat(64),
  }
  client.objects.get('rankings/active-generation.json')!.bytes = Buffer.from(JSON.stringify(activeForBadPrevious))
  const badVisitedDigest = await buildRankingBucketInventory({ config, client, now })
  assert.equal(badVisitedDigest.valid, false)
  assert.ok(badVisitedDigest.errors.some((error) => error.message?.includes('digest differs')))
  client.objects.get('rankings/active-generation.json')!.bytes = Buffer.from(JSON.stringify({ ...activeForBadPrevious, previousGeneration: { generationId: 'g0', manifestKey: 'rankings/generations/g0/manifest.json' } }))
  client.objects.get('rankings/active-generation.json')!.etag = 'new-pointer-etag'
  const pointerChanged = await buildRankingBucketInventory({ config, client, now })
  assert.notEqual(pointerChanged.inventorySha256, baseline.inventorySha256)
  const activeObject = client.objects.get('rankings/active-generation.json')!
  const active = JSON.parse(activeObject.bytes.toString('utf8'))
  active.rawReceiptDigest = 'f'.repeat(64)
  activeObject.bytes = Buffer.from(JSON.stringify(active))
  const referenceChanged = await buildRankingBucketInventory({ config, client, now })
  assert.equal(referenceChanged.valid, false)
  assert.notEqual(referenceChanged.inventorySha256, pointerChanged.inventorySha256)
  active.rawReceiptDigest = graph.rawReceiptDigest
  activeObject.bytes = Buffer.from(JSON.stringify(active))
  const rawReceipt = client.objects.get(`rankings/raw/objects/sha256/${graph.rawReceiptDigest}`)!
  const rawReceiptMetadata = { ...rawReceipt.metadata }
  rawReceipt.metadata = { ...rawReceipt.metadata, sha256: '0'.repeat(64) }
  const corruptPointerRaw = await buildRankingBucketInventory({ config, client, now })
  assert.equal(corruptPointerRaw.valid, false)
  assert.ok(corruptPointerRaw.errors.some((error) => error.message?.includes('Raw receipt authority metadata')))
  rawReceipt.metadata = rawReceiptMetadata
  const publicManifest = client.objects.get('rankings/generations/g1/manifest.json')!
  publicManifest.contentType = undefined
  const corruptManifestMetadata = await buildRankingBucketInventory({ config, client, now })
  assert.equal(corruptManifestMetadata.valid, false)
  assert.ok(corruptManifestMetadata.errors.some((error) => error.message?.includes('Public manifest stored authority metadata')))
  publicManifest.contentType = 'application/json; charset=utf-8'
  client.objects.get(graph.rawNarrowKey)!.metadata = { sha256: '0'.repeat(64), 'semantic-bytes': '1', encoding: 'gzip' }
  const corrupt = await buildRankingBucketInventory({ config, client, now })
  assert.equal(corrupt.valid, false)
  assert.equal(corrupt.deletionCandidates.length, 0)
})

test('approved deletion removes exact candidates and writes a completion receipt', async () => {
  const client = gcMemoryS3()
  seedValidBucket(client)
  const inventory = await buildRankingBucketInventory({ config, client, now })
  await assert.rejects(
    deleteApprovedRankingBucketInventory({ delete: true, config, client, now } as never),
    /requires/,
  )
  assert.equal(client.deleted.length, 0)
  await assert.rejects(
    deleteApprovedRankingBucketInventory({ delete: true, approvedInventorySha256: '0'.repeat(64), config, client, now }),
    /does not match/,
  )
  assert.equal(client.deleted.length, 0)
  const receipt = await deleteApprovedRankingBucketInventory({
    delete: true,
    approvedInventorySha256: inventory.inventorySha256,
    config,
    client,
    now,
  })
  assert.deepEqual(receipt.deleted.map((entry) => entry.key), inventory.deletionCandidates.map((entry) => entry.key))
  assert.deepEqual(client.deleted, inventory.deletionCandidates.map((entry) => entry.key))
  assert.ok([...client.objects.keys()].some((key) => key.startsWith('rankings/gc/deletions/') && key.endsWith(`-${inventory.inventorySha256}.json`)))
})

test('pointer races before and between batches abort deletion without a success receipt', async () => {
  const beforeClient = gcMemoryS3()
  seedValidBucket(beforeClient)
  const before = await buildRankingBucketInventory({ config, client: beforeClient, now })
  await assert.rejects(deleteApprovedRankingBucketInventory({
    delete: true,
    approvedInventorySha256: before.inventorySha256,
    config,
    client: beforeClient,
    now,
    beforeFirstBatch: () => { beforeClient.objects.get('rankings/active-generation.json')!.etag = 'changed' },
  }), /pointer changed/i)
  assert.equal(beforeClient.deleted.length, 0)

  const betweenClient = gcMemoryS3()
  seedValidBucket(betweenClient)
  const between = await buildRankingBucketInventory({ config, client: betweenClient, now })
  await assert.rejects(deleteApprovedRankingBucketInventory({
    delete: true,
    approvedInventorySha256: between.inventorySha256,
    config,
    client: betweenClient,
    now,
    batchSize: 1,
    betweenBatches: () => { betweenClient.objects.get('rankings/active-generation.json')!.etag = 'changed' },
  }), /lease-changed|pointer changed/i)
  assert.equal(betweenClient.deleted.length, 1)
  assert.equal([...betweenClient.objects.keys()].some((key) => key.startsWith('rankings/gc/deletions/')), false)
})

test('live publisher blocks GC and the acquired GC lease excludes publishers', async () => {
  const blockedClient = gcMemoryS3()
  seedValidBucket(blockedClient)
  const blockedActive = JSON.parse(blockedClient.objects.get('rankings/active-generation.json')!.bytes.toString('utf8'))
  Object.assign(blockedActive, { leaseKey: 'ops/refresh-lease.json', leaseOwner: 'publisher', leaseFencingToken: 9, leaseExpiresAt: '2026-07-24T01:00:00.000Z' })
  blockedClient.objects.get('rankings/active-generation.json')!.bytes = Buffer.from(JSON.stringify(blockedActive))
  const blockedInventory = await buildRankingBucketInventory({ config, client: blockedClient, now })
  await assert.rejects(deleteApprovedRankingBucketInventory({ delete: true, approvedInventorySha256: blockedInventory.inventorySha256, config, client: blockedClient, now }), /live refresh publisher lease/)
  assert.equal(blockedClient.deleted.length, 0)

  const client = gcMemoryS3()
  seedValidBucket(client)
  let clock = new Date('2026-07-23T17:00:00.000Z')
  const advancingNow = () => new Date(clock)
  const inventory = await buildRankingBucketInventory({ config, client, now: advancingNow })
  let publisherAcquired = true
  await deleteApprovedRankingBucketInventory({
    delete: true, approvedInventorySha256: inventory.inventorySha256, config, client, now: advancingNow, batchSize: 1,
    betweenBatches: async () => {
      clock = new Date(clock.getTime() + 6 * 60_000)
      const publisher = await acquireBucketLease('ops/refresh-lease.json', { owner: 'publisher', now: advancingNow(), config, client })
      publisherAcquired = publisher.acquired
    },
  })
  assert.equal(publisherAcquired, false)
  assert.equal(clock.getTime() - new Date('2026-07-23T17:00:00.000Z').getTime() > 10 * 60_000, true)
  assert.ok([...client.objects.keys()].some((key) => key.startsWith('rankings/gc/deletions/')))
})

test('a delete that outlives the GC lease cannot continue after a publisher takes authority', async () => {
  let clock = new Date('2026-07-23T17:00:00.000Z')
  const advancingNow = () => new Date(clock)
  let publisherAcquired = false
  let first = true
  const client = gcMemoryS3(1000, async () => {
    if (!first) return
    first = false
    clock = new Date(clock.getTime() + 11 * 60_000)
    const publisher = await acquireBucketLease('ops/refresh-lease.json', { owner: 'publisher', now: advancingNow(), config, client })
    publisherAcquired = publisher.acquired
  })
  seedValidBucket(client)
  const inventory = await buildRankingBucketInventory({ config, client, now: advancingNow })
  await assert.rejects(deleteApprovedRankingBucketInventory({
    delete: true, approvedInventorySha256: inventory.inventorySha256, config, client, now: advancingNow,
  }), /renewal failed|lease-changed/i)
  assert.equal(publisherAcquired, true)
  assert.equal(client.deleted.length, 1)
  assert.equal(client.objects.has(inventory.deletionCandidates[1].key), true)
  assert.equal([...client.objects.keys()].some((key) => key.startsWith('rankings/gc/deletions/')), false)
})

test('an aborted delete settles without deleting or writing a success receipt', async () => {
  let abortedRequestSettled = false
  const client = gcMemoryS3(1000, async (_key, signal) => {
    await new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        abortedRequestSettled = true
        reject(signal.reason)
      }, { once: true })
    })
  })
  seedValidBucket(client)
  const inventory = await buildRankingBucketInventory({ config, client, now })
  await assert.rejects(deleteApprovedRankingBucketInventory({
    delete: true, approvedInventorySha256: inventory.inventorySha256, config, client, now, deleteTimeoutMs: 5,
  }), /timed out/)
  assert.equal(abortedRequestSettled, true)
  assert.equal(client.deleted.length, 0)
  assert.equal([...client.objects.keys()].some((key) => key.startsWith('rankings/gc/deletions/')), false)
})

test('strict publish closure rejects authority omission, body mutation, and metadata mismatch', async () => {
  const setup = () => {
    const client = gcMemoryS3()
    seedValidBucket(client)
    const manifest = seedGeneration(client, 'repromoted', '2026-01-01T00:00:00.000Z')
    const receipt = seedPublishReceipt(client, 'repromoted', manifest)
    return { client, manifest, receipt }
  }

  const omitted = setup()
  omitted.receipt.artifacts = omitted.receipt.artifacts.filter((entry) => entry.key !== omitted.receipt.authorities.rawReceipt.key)
  omitted.receipt.artifactCount = omitted.receipt.artifacts.length
  omitted.receipt.uploadedCount = omitted.receipt.artifacts.length
  omitted.receipt.uploadedBytes = omitted.receipt.artifacts.reduce((sum, entry) => sum + entry.bytes, 0)
  seedCanonicalJson(omitted.client, 'rankings/generations/repromoted/publish.json', omitted.receipt, '2026-07-23T00:00:00.000Z')
  const omittedInventory = await buildRankingBucketInventory({ config, client: omitted.client, now })
  assert.equal(omittedInventory.valid, false)
  assert.ok(omittedInventory.errors.some((error) => error.message?.includes('must match exactly one')))

  const mutated = setup()
  const publicObject = mutated.client.objects.get(mutated.manifest.key)!
  publicObject.bytes = Buffer.from(publicObject.bytes)
  publicObject.bytes[10] ^= 1
  const mutatedInventory = await buildRankingBucketInventory({ config, client: mutated.client, now })
  assert.equal(mutatedInventory.valid, false)
  assert.ok(mutatedInventory.errors.some((error) => error.message?.includes('body authority')))

  const metadata = setup()
  metadata.client.objects.get(metadata.manifest.publicObject.key)!.contentType = 'application/octet-stream'
  const metadataInventory = await buildRankingBucketInventory({ config, client: metadata.client, now })
  assert.equal(metadataInventory.valid, false)
  assert.ok(metadataInventory.errors.some((error) => error.message?.includes('metadata mismatch')))
})

type Stored = { bytes: Buffer; etag: string; lastModified: Date; contentType?: string; contentEncoding?: string; metadata?: Record<string, string> }

function seedValidBucket(client: ReturnType<typeof gcMemoryS3>) {
  const currentManifest = seedGeneration(client, 'g1', '2026-07-22T12:00:00.000Z')
  seedGeneration(client, 'g0', '2026-01-01T00:00:00.000Z')
  const active = {
    schemaVersion: 2,
    generationId: 'g1',
    manifestKey: 'rankings/generations/g1/manifest.json',
    fencingToken: 3,
    promotedAt: '2026-07-22T12:00:00.000Z',
    storageMode: 'content-addressed-gzip-v1',
    manifestDigest: currentManifest.digest,
    manifestBytes: currentManifest.bytes,
    manifestEtag: currentManifest.etag,
    previousGeneration: {
      generationId: 'g0',
      manifestKey: 'rankings/generations/g0/manifest.json',
      promotedAt: '2026-01-01T00:00:00.000Z',
    },
  }
  client.set('rankings/active-generation.json', Buffer.from(JSON.stringify(active)), '2026-07-22T12:00:00.000Z', 'active-etag')
  client.set(`rankings/objects/sha256/${'b'.repeat(64)}`, Buffer.from('old-public-orphan'), '2026-07-10T00:00:00.000Z')
  client.set(`rankings/objects/sha256/${'c'.repeat(64)}`, Buffer.from('young-public-orphan'), '2026-07-22T12:00:00.000Z')
  client.set(`rankings/raw/objects/sha256/${'d'.repeat(64)}`, Buffer.from('old-raw-orphan'), '2026-07-10T00:00:00.000Z')
  client.set('rankings/raw/files/legacy.csv', Buffer.from('legacy'), '2020-01-01T00:00:00.000Z')
  client.set('rankings/ops/refresh-control.json', Buffer.from('{}'), '2020-01-01T00:00:00.000Z')
  client.set('rankings/generations/%2e%2e/manifest.json', Buffer.from('{}'), '2020-01-01T00:00:00.000Z')
  client.set('rankings/generations/g1/data/../secret.json', Buffer.from('{}'), '2020-01-01T00:00:00.000Z')
  client.set('rankings/generations/g1/data//double.json', Buffer.from('{}'), '2020-01-01T00:00:00.000Z')
  client.set('rankings/generations/g1/data/%252e%252e/encoded.json', Buffer.from('{}'), '2020-01-01T00:00:00.000Z')
  client.set('rankings/generations/g1/control/delete.json', Buffer.from('{}'), '2020-01-01T00:00:00.000Z')
  client.set('rankings/audits/days/not-a-date.json', Buffer.from('{}'), '2020-01-01T00:00:00.000Z')
}

function seedGeneration(client: ReturnType<typeof gcMemoryS3>, generationId: string, lastModified: string) {
  const root = prepareSemanticArtifact({ artifactKind: 'test-ranking-root', rows: [] })
  const objectKey = `rankings/objects/sha256/${root.digest}`
  if (!client.objects.has(objectKey)) seedPrepared(client, objectKey, root, lastModified)
  const manifest = {
    artifactKind: 'public-artifact-generation-manifest',
    schemaVersion: 2,
    storageMode: 'content-addressed-gzip-v1',
    generationId,
    runId: generationId,
    generatedAt: '2026-07-01T00:00:00.000Z',
    model: { version: 'model-v1', configHash: 'config-v1' },
    provenance: { source: 'test', dataMode: 'scheduled-public-data', sourceProviders: ['test'] },
    rootArtifact: '/data/ranking-summary.json',
    artifacts: {
      '/data/ranking-summary.json': {
        logicalPath: '/data/ranking-summary.json', objectUrl: `/data/objects/sha256/${root.digest}`, generationId,
        sha256: root.digest, bytes: root.bytes, encoding: 'gzip', storageEncoding: 'gzip', transportEncodings: ['identity', 'gzip'],
      },
    },
  }
  const body = Buffer.from(JSON.stringify(manifest))
  const key = `rankings/generations/${generationId}/manifest.json`
  const manifestDigest = digest(body)
  client.set(key, body, lastModified, undefined, { contentType: 'application/json; charset=utf-8', metadata: { sha256: manifestDigest, 'semantic-bytes': String(body.byteLength) } })
  const stored = client.objects.get(key)!
  return {
    key, digest: manifestDigest, bytes: body.byteLength, etag: stored.etag,
    publicObject: { key: objectKey, digest: root.digest, bytes: root.compressedBytes },
  }
}

function publishReceipt(generationId: string, manifest: { key: string; digest: string; bytes: number; publicObject: { key: string; digest: string; bytes: number } }, raw: { key: string; digest: string; bytes: number }) {
  const artifacts = [
    { key: manifest.publicObject.key, bytes: manifest.publicObject.bytes, contentType: 'application/json; charset=utf-8', digest: manifest.publicObject.digest },
    { key: manifest.key, bytes: manifest.bytes, contentType: 'application/json; charset=utf-8', digest: manifest.digest },
    { key: raw.key, bytes: raw.bytes, contentType: 'application/json; charset=utf-8', digest: raw.digest },
  ]
  return {
    schemaVersion: 2,
    generationId,
    publishedAt: '2026-07-23T00:00:00.000Z',
    prefix: 'rankings',
    storageMode: 'content-addressed-gzip-v1',
    authorities: {
      publicManifest: { key: manifest.key, digest: manifest.digest, bytes: manifest.bytes, contentType: 'application/json; charset=utf-8' },
      rawReceipt: { key: raw.key, digest: raw.digest, bytes: raw.bytes, contentType: 'application/json; charset=utf-8' },
    },
    storage: {
      mode: 'content-addressed-gzip-v1', objectCount: 1, logicalArtifactCount: 1,
      semanticLogicalBytes: 1, compressedLogicalBytes: 1, uniqueCompressedBytes: 1,
    },
    artifactCount: artifacts.length,
    uploadedCount: artifacts.length,
    uploadedBytes: artifacts.reduce((sum, entry) => sum + entry.bytes, 0),
    unchangedCount: 0,
    unchangedBytes: 0,
    artifacts,
    unchanged: [],
    skipped: [],
  }
}

function seedPublishReceipt(client: ReturnType<typeof gcMemoryS3>, generationId: string, manifest: ReturnType<typeof seedGeneration>) {
  const baseline = prepareOracleBaseline({
    csv: ['gameid,date,league,side,position,teamname,result', `${generationId}-game,2026-01-01,LCK,Blue,team,Alpha,1`, `${generationId}-game,2026-01-01,LCK,Red,team,Beta,0`].join('\n'),
    sourceFileName: `${generationId}.csv`,
    importerVersion: 'importer-v1',
  })
  seedPrepared(client, `rankings/${baseline.reference.key}`, baseline.prepared, '2026-01-01T00:00:00.000Z')
  const raw = prepareRawSourceReceipt({
    generationId,
    importerVersion: 'importer-v1',
    coverage: { start: '2026-01-01', end: '2026-07-23' },
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
  const rawKey = `rankings/raw/objects/sha256/${raw.prepared.digest}`
  seedPrepared(client, rawKey, raw.prepared, '2026-01-01T00:00:00.000Z')
  const receipt = publishReceipt(generationId, manifest, { key: rawKey, digest: raw.prepared.digest, bytes: raw.prepared.compressedBytes })
  seedCanonicalJson(client, `rankings/generations/${generationId}/publish.json`, receipt, '2026-01-01T00:00:00.000Z')
  return receipt
}

function seedCanonicalJson(client: ReturnType<typeof gcMemoryS3>, key: string, value: unknown, lastModified: string) {
  const body = Buffer.from(canonicalJsonFor(value))
  client.set(key, body, lastModified, undefined, {
    contentType: 'application/json; charset=utf-8',
    metadata: { sha256: digest(body), 'semantic-bytes': String(body.byteLength) },
  })
}

function seedRetainedGraph(client: ReturnType<typeof gcMemoryS3>) {
  const generationId = 'g1'
  const publicObject = prepareSemanticArtifact({ artifactKind: 'test-public-artifact', rows: [] })
  const sharedPublicKey = `rankings/objects/sha256/${publicObject.digest}`
  seedPrepared(client, sharedPublicKey, publicObject, '2026-01-01T00:00:00.000Z')
  const publicManifest = {
    artifactKind: 'public-artifact-generation-manifest',
    schemaVersion: 2,
    storageMode: 'content-addressed-gzip-v1',
    generationId,
    runId: generationId,
    generatedAt: '2026-07-23T00:00:00.000Z',
    model: { version: 'model-v1', configHash: 'config-v1' },
    provenance: { source: 'test', dataMode: 'scheduled-public-data', sourceProviders: ['test'] },
    rootArtifact: '/data/ranking-summary.json',
    artifacts: {
      '/data/ranking-summary.json': {
        logicalPath: '/data/ranking-summary.json',
        objectUrl: `/data/objects/sha256/${publicObject.digest}`,
        generationId,
        sha256: publicObject.digest,
        bytes: publicObject.bytes,
        encoding: 'gzip',
        storageEncoding: 'gzip',
        transportEncodings: ['identity', 'gzip'],
      },
    },
  }
  const publicManifestBytes = Buffer.from(JSON.stringify(publicManifest))
  const publicManifestDigest = digest(publicManifestBytes)
  client.set('rankings/generations/g1/manifest.json', publicManifestBytes, '2026-07-22T12:00:00.000Z', undefined, { contentType: 'application/json; charset=utf-8', metadata: { sha256: publicManifestDigest, 'semantic-bytes': String(publicManifestBytes.byteLength) } })

  const narrow = prepareNarrowSourceObject({ provider: 'lolesports', sourceFileName: 'schedule.json', content: '{}', importerVersion: 'importer-v1' })
  const rawNarrowKey = `rankings/${narrow.reference.key}`
  seedPrepared(client, rawNarrowKey, narrow.prepared, '2026-01-01T00:00:00.000Z')
  const oracleCsv = (second = false) => [
    'gameid,date,league,side,position,teamname,result',
    'game-1,2026-01-01,LCK,Blue,team,Alpha,1',
    'game-1,2026-01-01,LCK,Red,team,Beta,0',
    ...(second ? ['game-2,2026-01-02,LCK,Blue,team,Alpha,0', 'game-2,2026-01-02,LCK,Red,team,Beta,1'] : []),
  ].join('\n')
  const baseline = prepareOracleBaseline({ csv: oracleCsv(), sourceFileName: 'oracle.csv', importerVersion: 'importer-v1' })
  const chain = prepareOracleMutationChain({ previousSource: baseline.source, nextCsv: oracleCsv(true) })
  const rawBaselineKey = `rankings/${baseline.reference.key}`
  seedPrepared(client, rawBaselineKey, baseline.prepared, '2026-01-01T00:00:00.000Z')
  const rawDeltaKeys = chain.deltas.map((delta) => {
    const key = `rankings/${delta.reference.key}`
    seedPrepared(client, key, delta.prepared, '2026-01-02T00:00:00.000Z')
    return key
  })
  const raw = prepareRawSourceReceipt({
    generationId,
    importerVersion: 'importer-v1',
    coverage: { start: '2026-01-01', end: '2026-07-23' },
    sourceReceiptInputs: {},
    oracle: [{
      sourceFileName: chain.source.sourceFileName,
      headerDigest: chain.source.headerDigest,
      digestScheme: ORACLE_GAME_INVENTORY_DIGEST_SCHEME,
      effectiveOracleDigest: chain.source.digest,
      gameInventory: oracleGameInventory(chain.source),
      baseline: baseline.reference,
      deltas: chain.deltas.map((delta) => delta.reference),
    }],
    lolesports: [{ sourceFileName: narrow.value.sourceFileName, contentSha256: narrow.value.contentSha256, object: narrow.reference }],
  })
  const rawReceiptKey = `rankings/raw/objects/sha256/${raw.prepared.digest}`
  seedPrepared(client, rawReceiptKey, raw.prepared, '2026-07-22T12:00:00.000Z')

  const ledger = prepareStateObject({ artifactKind: 'canonical-ledger-test', rows: [] })
  const ledgerReference = stateObjectReferenceFor(ledger)
  const ledgerKey = `rankings/${ledgerReference.key}`
  seedPrepared(client, ledgerKey, ledger, '2026-01-01T00:00:00.000Z')
  const compatibility = {
    modelVersion: 'model-v1', modelConfigHash: 'config-v1', importerVersion: 'importer-v1', taxonomyVersion: 'taxonomy-v1',
    ratingCheckpointSchemaVersion: 1, causalPrefixSchemaVersion: 1, publicArtifactSchemaVersion: 1,
  }
  const checkpoint = {
    boundary: { date: '2026-07-22', matchId: 'match-1' },
    rawPrefix: { matchCount: 1, digest: 'a'.repeat(64) },
    ratingCheckpoint: {},
    causalSummaries: { sourcedPlayer: {}, dssTeam: {}, dssRegion: {}, rosterEra: {}, playerResume: {} },
  }
  const base = prepareContentAddressedState({ generationId: 'g0', canonicalLedgerReference: ledgerReference, sourceReceiptDigest: raw.receipt.sourceReceiptDigest, compatibility, checkpoints: [checkpoint] })
  const current = prepareContentAddressedState({ generationId, baseGenerationId: 'g0', baseRunId: 'g0', canonicalLedgerReference: ledgerReference, sourceReceiptDigest: raw.receipt.sourceReceiptDigest, compatibility, checkpoints: [{ ...checkpoint, storedObjectReference: base.manifest.checkpoints[0].object }] })
  for (const prepared of base.objects) seedPrepared(client, `rankings/state/objects/sha256/${prepared.digest}`, prepared, '2026-01-01T00:00:00.000Z')
  client.set('rankings/state/generations/g0.json', base.manifestPrepared.canonicalBytes, '2026-01-01T00:00:00.000Z', undefined, { metadata: { sha256: base.manifestPrepared.digest, 'semantic-bytes': String(base.manifestPrepared.bytes) } })
  client.set('rankings/state/generations/g1.json', current.manifestPrepared.canonicalBytes, '2026-07-22T12:00:00.000Z', undefined, { metadata: { sha256: current.manifestPrepared.digest, 'semantic-bytes': String(current.manifestPrepared.bytes) } })

  const snapshotBytes = Buffer.from('{"artifactKind":"full-ranking-artifact"}\n')
  const snapshotDigest = digest(snapshotBytes)
  const snapshotCompressed = gzipSync(snapshotBytes, { level: 9 })
  const auditSnapshotKey = `rankings/audits/objects/sha256/${snapshotDigest}`
  client.set(auditSnapshotKey, snapshotCompressed, '2026-07-22T12:00:00.000Z', undefined, {
    contentEncoding: 'gzip', metadata: { sha256: snapshotDigest, 'semantic-bytes': String(snapshotBytes.byteLength), encoding: 'gzip' },
  })
  const auditReceipt = (auditDate: string) => ({
    artifactKind: 'full-ranking-audit-receipt', schemaVersion: 1, auditDate, cause: 'daily-audit', generationId, runId: generationId,
    fencingToken: 3, promotedAt: `${auditDate}T12:00:00.000Z`, model: { version: 'model-v1', configHash: 'config-v1' },
    sourceReceipt: { key: `raw/objects/sha256/${raw.prepared.digest}`, sha256: raw.prepared.digest, bytes: raw.prepared.bytes, compressedBytes: raw.prepared.compressedBytes, storageEncoding: 'gzip' },
    rawLedger: ledgerReference,
    fullSnapshot: { key: `audits/objects/sha256/${snapshotDigest}`, sha256: snapshotDigest, bytes: snapshotBytes.byteLength, compressedBytes: snapshotCompressed.byteLength, storageEncoding: 'gzip' },
  })
  for (const auditDate of ['2026-07-23', '2026-07-22']) client.set(`rankings/audits/days/${auditDate}.json`, Buffer.from(canonicalJsonFor(auditReceipt(auditDate))), `${auditDate}T12:00:00.000Z`)

  const activeObject = client.objects.get('rankings/active-generation.json')!
  const active = JSON.parse(activeObject.bytes.toString('utf8'))
  Object.assign(active, {
    manifestDigest: publicManifestDigest,
    manifestBytes: publicManifestBytes.byteLength,
    manifestEtag: client.objects.get('rankings/generations/g1/manifest.json')!.etag,
    stateManifestKey: 'rankings/state/generations/g1.json',
    stateManifestDigest: current.manifestPrepared.digest,
    rawReceiptKey,
    rawReceiptDigest: raw.prepared.digest,
    rawReceiptBytes: raw.prepared.bytes,
    rawReceiptCompressedBytes: raw.prepared.compressedBytes,
    sourceReceiptDigest: raw.receipt.sourceReceiptDigest,
    rawIdentityDigest: raw.receipt.rawIdentityDigest,
  })
  activeObject.bytes = Buffer.from(JSON.stringify(active))
  return {
    requiredKeys: [sharedPublicKey, rawNarrowKey, rawBaselineKey, ...rawDeltaKeys, rawReceiptKey, ledgerKey, 'rankings/state/generations/g1.json', 'rankings/state/generations/g0.json', auditSnapshotKey],
    sharedPublicKey, rawNarrowKey, rawReceiptDigest: raw.prepared.digest, ledgerKey,
  }
}

function seedPrepared(client: ReturnType<typeof gcMemoryS3>, key: string, prepared: { compressed: Buffer; digest: string; bytes: number }, lastModified: string) {
  client.set(key, prepared.compressed, lastModified, undefined, {
    contentType: 'application/json; charset=utf-8', contentEncoding: 'gzip', metadata: { sha256: prepared.digest, 'semantic-bytes': String(prepared.bytes), encoding: 'gzip' },
  })
}

function digest(value: Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}

function gcMemoryS3(pageSize = 1000, onDelete?: (key: string, signal?: AbortSignal) => void | Promise<void>) {
  const objects = new Map<string, Stored>()
  const deleted: string[] = []
  let version = 0
  return {
    objects,
    deleted,
    set(key: string, bytes: Buffer, lastModified: string, etag = `"seed-${++version}"`, properties: Partial<Stored> = {}) {
      objects.set(key, { bytes, etag, lastModified: new Date(lastModified), ...properties })
    },
    async send(command: unknown, options?: { abortSignal?: AbortSignal }) {
      const typed = command as { constructor: { name: string }; input: Record<string, unknown> }
      const name = typed.constructor.name
      const key = String(typed.input.Key ?? '')
      if (name === 'ListObjectsV2Command') {
        const prefix = String(typed.input.Prefix ?? '')
        const keys = [...objects.keys()].filter((candidate) => candidate.startsWith(prefix)).sort()
        const offset = typed.input.ContinuationToken ? Number(typed.input.ContinuationToken) : 0
        const page = keys.slice(offset, offset + pageSize)
        const next = offset + page.length
        return {
          Contents: page.map((candidate) => {
            const object = objects.get(candidate)!
            return { Key: candidate, Size: object.bytes.byteLength, LastModified: object.lastModified, ETag: object.etag }
          }),
          IsTruncated: next < keys.length,
          NextContinuationToken: next < keys.length ? String(next) : undefined,
        }
      }
      if (name === 'GetObjectCommand') {
        const object = objects.get(key)
        if (!object) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
        return { Body: Readable.from([object.bytes]), ETag: object.etag, ContentLength: object.bytes.byteLength, ContentType: object.contentType, ContentEncoding: object.contentEncoding, Metadata: object.metadata }
      }
      if (name === 'DeleteObjectCommand') {
        await onDelete?.(key, options?.abortSignal)
        objects.delete(key)
        deleted.push(key)
        return {}
      }
      if (name === 'PutObjectCommand') {
        const current = objects.get(key)
        if (typed.input.IfNoneMatch === '*' && current) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        if (typed.input.IfMatch && typed.input.IfMatch !== current?.etag) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        const bytes = await bodyBytes(typed.input.Body)
        const object = {
          bytes, etag: `"put-${++version}"`, lastModified: now(),
          contentType: typeof typed.input.ContentType === 'string' ? typed.input.ContentType : undefined,
          contentEncoding: typeof typed.input.ContentEncoding === 'string' ? typed.input.ContentEncoding : undefined,
          metadata: typed.input.Metadata as Record<string, string> | undefined,
        }
        objects.set(key, object)
        return { ETag: object.etag }
      }
      throw new Error(`Unsupported command ${name}`)
    },
  }
}

async function bodyBytes(value: unknown) {
  if (typeof value === 'string' || value instanceof Uint8Array) return Buffer.from(value)
  const chunks: Buffer[] = []
  for await (const chunk of value as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
