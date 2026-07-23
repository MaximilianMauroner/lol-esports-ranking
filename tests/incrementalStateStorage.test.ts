import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import {
  assertStateManifestAuthority,
  prepareContentAddressedState,
  prepareStateObject,
  stateObjectReferenceFor,
  readActiveIncrementalState,
  syncContentAddressedStateObject,
  writeIncrementalStateManifest,
  type PreparedStateObject,
  type StateCompatibility,
  type StateObjectReference,
} from '../scripts/incremental-state-storage.mjs'
import { readActiveRawSourceAuthority, readBucketJson, readPreviousGenerationAuthorities, uploadRankingArtifacts as uploadRankingArtifactsImplementation, writeBucketJson, type BucketClient, type BucketStorageConfig } from '../scripts/railway-bucket.mjs'
import { canonicalJsonFor } from '../scripts/public-artifact-storage.mjs'
import { ORACLE_GAME_INVENTORY_DIGEST_SCHEME, oracleGameInventory, prepareOracleBaseline, prepareRawSourceReceipt, rawObjectReferenceFor } from '../scripts/raw-source-storage.mjs'

const config = {
  enabled: true,
  bucket: 'test-bucket',
  endpoint: 'https://example.invalid',
  region: 'auto',
  accessKeyId: 'test',
  secretAccessKey: 'test',
  prefix: 'custom-rankings',
}

const compatibility: StateCompatibility = {
  modelVersion: 'model-v1',
  modelConfigHash: 'config-v1',
  importerVersion: 'importer-v1',
  taxonomyVersion: 'taxonomy-v1',
  ratingCheckpointSchemaVersion: 2,
  causalPrefixSchemaVersion: 1,
  publicArtifactSchemaVersion: 23,
}

type StateInputCheckpoint = Parameters<typeof prepareContentAddressedState>[0]['checkpoints'][number]

async function uploadRankingArtifacts(options: Parameters<typeof uploadRankingArtifactsImplementation>[0]) {
  if (!options?.generationId || options.leaseAuthority) return uploadRankingArtifactsImplementation(options)
  const fencingToken = Number(options.fencingToken)
  const storage = { config: options.config as BucketStorageConfig, client: options.client as BucketClient }
  const current = await readBucketJson('active-generation.json', storage)
  const owner = `test-publication-${fencingToken}`
  const leaseValue = {
    ...(current.value ?? {}),
    leaseKey: 'ops/refresh-lease.json',
    leaseOwner: owner,
    leaseFencingToken: fencingToken,
    leaseAcquiredAt: '2026-07-23T00:00:00.000Z',
    leaseExpiresAt: '2099-01-01T00:00:00.000Z',
  }
  const written = await writeBucketJson('active-generation.json', leaseValue, {
    ...storage,
    ...(current.found ? { ifMatch: current.etag } : { ifNoneMatch: '*' }),
  })
  assert.equal(written.written, true)
  return uploadRankingArtifactsImplementation({
    ...options,
    leaseAuthority: {
      key: 'ops/refresh-lease.json',
      lease: { owner, fencingToken, acquiredAt: leaseValue.leaseAcquiredAt, expiresAt: leaseValue.leaseExpiresAt },
    },
  })
}

test('state preparation hashes canonical JSON and creates deterministic gzip bytes', () => {
  const left = prepareStateObject({ z: [3, 2, 1], a: { y: true, x: 'value' } })
  const right = prepareStateObject({ a: { x: 'value', y: true }, z: [3, 2, 1] })
  assert.equal(left.digest, right.digest)
  assert.deepEqual(left.compressed, right.compressed)
  assert.equal(gunzipSync(left.compressed).toString('utf8'), left.canonicalJson)
  assert.equal(createHash('sha256').update(left.canonicalBytes).digest('hex'), left.digest)
})

test('one active CAS binds public, state, and raw receipt authorities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'triple-authority-'))
  const publicDir = join(root, 'public')
  const client = memoryS3()
  try {
    const generationId = 'triple_authority'
    await writePublicFixture(publicDir, generationId)
    const raw = rawGeneration(generationId)
    const state = preparedStateWithReceipt(generationId, raw.sourceReceiptDigest)
    await syncAllStateObjects(client, state.objects)
    const manifest = await writeIncrementalStateManifest(client, config, state)
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId,
      fencingToken: 1,
      contentAddressed: true,
      stateManifestAuthority: manifest.authority,
      rawSourceGeneration: raw,
      config,
      client,
    })

    const active = (await readBucketJson('active-generation.json', { config, client })).value!
    assert.equal(active.generationId, generationId)
    assert.equal(active.sourceReceiptDigest, raw.sourceReceiptDigest)
    assert.equal(active.stateManifestDigest, manifest.authority.digest)
    assert.equal(active.rawReceiptDigest, raw.receiptReference.sha256)
    const restored = await readActiveRawSourceAuthority({ config, client })
    assert.equal(restored.found, true)
    assert.equal(restored.found && restored.receipt.sourceReceiptDigest, raw.sourceReceiptDigest)

    const nextGenerationId = 'triple_authority_next'
    await writePublicFixture(publicDir, nextGenerationId)
    const nextRaw = rawGeneration(nextGenerationId)
    const nextState = preparedStateWithReceipt(nextGenerationId, nextRaw.sourceReceiptDigest)
    await syncAllStateObjects(client, nextState.objects)
    const nextManifest = await writeIncrementalStateManifest(client, config, nextState)
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: nextGenerationId,
      fencingToken: 2,
      contentAddressed: true,
      stateManifestAuthority: nextManifest.authority,
      rawSourceGeneration: nextRaw,
      config,
      client,
    })
    const promoted = (await readBucketJson('active-generation.json', { config, client })).value!
    assert.deepEqual(promoted.previousGeneration, {
      generationId,
      manifestKey: active.manifestKey,
      promotedAt: active.promotedAt,
      stateManifestKey: manifest.authority.key,
      stateManifestDigest: manifest.authority.digest,
      rawReceiptKey: `custom-rankings/${raw.receiptReference.key}`,
      rawReceiptDigest: raw.receiptReference.sha256,
    })
    for (const key of [
      String(active.manifestKey),
      manifest.authority.key,
      ...state.manifest.checkpoints.map((candidate) => `custom-rankings/${candidate.object.key}`),
      `custom-rankings/${state.manifest.canonicalLedger.key}`,
      `custom-rankings/${raw.receiptReference.key}`,
      ...raw.oracle.flatMap((source) => [source.baseline, ...source.deltas]).map((reference) => `custom-rankings/${reference.key}`),
    ]) assert.ok(client.objects.has(key), `previous authority must remain resolvable: ${key}`)
    const rollback = await readPreviousGenerationAuthorities({ config, client })
    assert.equal(rollback.found, true)
    if (rollback.found) {
      assert.ok(rollback.state)
      assert.ok(rollback.raw)
      assert.equal(rollback.public.manifest.generationId, generationId)
      assert.equal(rollback.state.manifest.generationId, generationId)
      assert.equal(rollback.state.checkpoints.length, state.manifest.checkpoints.length)
      assert.equal(rollback.raw.receipt.generationId, generationId)
      assert.equal(rollback.raw.receipt.oracle[0]?.deltas.length, raw.oracle[0]?.deltas.length)
    }

    const activeObject = client.objects.get('custom-rankings/active-generation.json')!
    const publicObject = client.objects.get(String(active.manifestKey))!
    const stateObject = client.objects.get(manifest.authority.key)!
    const originalActive = { ...activeObject, bytes: Buffer.from(activeObject.bytes), metadata: { ...activeObject.metadata } }
    const originalPublic = { ...publicObject, bytes: Buffer.from(publicObject.bytes), metadata: { ...publicObject.metadata } }
    const originalState = { ...stateObject, bytes: Buffer.from(stateObject.bytes), metadata: { ...stateObject.metadata } }
    const assertInvalidPrevious = async (mutate: (previous: Record<string, unknown>) => void, expected: RegExp) => {
      const pointer = JSON.parse(originalActive.bytes.toString('utf8'))
      mutate(pointer.previousGeneration)
      const bytes = Buffer.from(JSON.stringify(pointer))
      Object.assign(activeObject, { body: bytes.toString('utf8'), bytes, etag: '"invalid-previous"' })
      await assert.rejects(readPreviousGenerationAuthorities({ config, client }), expected)
      Object.assign(activeObject, originalActive)
    }
    await assertInvalidPrevious((previous) => { previous.generationId = '../unsafe' }, /authority is invalid/)
    await assertInvalidPrevious((previous) => { previous.manifestKey = 'custom-rankings/generations/triple_authority/other.json' }, /manifest key is not canonical/)
    await assertInvalidPrevious((previous) => { delete previous.stateManifestDigest }, /state authority is incomplete/)
    await assertInvalidPrevious((previous) => { previous.stateManifestKey = 'custom-rankings/state/generations/other.json' }, /state manifest key is not canonical/)
    await assertInvalidPrevious((previous) => { previous.rawReceiptKey = `custom-rankings/raw/objects/sha256/${'e'.repeat(64)}` }, /raw receipt key is not canonical/)

    const publicWithoutModel = JSON.parse(originalPublic.bytes.toString('utf8'))
    delete publicWithoutModel.model
    const publicWithoutModelBytes = Buffer.from(JSON.stringify(publicWithoutModel, null, 2) + '\n')
    Object.assign(publicObject, {
      body: publicWithoutModelBytes.toString('utf8'), bytes: publicWithoutModelBytes, etag: '"missing-model"',
      metadata: { sha256: createHash('sha256').update(publicWithoutModelBytes).digest('hex'), 'semantic-bytes': String(publicWithoutModelBytes.byteLength) },
    })
    await assert.rejects(readPreviousGenerationAuthorities({ config, client }), /public generation manifest is invalid/)
    Object.assign(publicObject, originalPublic)
    const installStateMutation = (mutate: (value: Record<string, unknown>) => void) => {
      const value = JSON.parse(originalState.bytes.toString('utf8')) as Record<string, unknown>
      mutate(value)
      const bytes = Buffer.from(canonicalJsonFor(value))
      const digest = createHash('sha256').update(bytes).digest('hex')
      Object.assign(stateObject, { body: bytes.toString('utf8'), bytes, etag: '"mutated-state"', metadata: { sha256: digest, 'semantic-bytes': String(bytes.byteLength) } })
      const pointer = JSON.parse(originalActive.bytes.toString('utf8'))
      pointer.previousGeneration.stateManifestDigest = digest
      Object.assign(activeObject, { body: JSON.stringify(pointer), bytes: Buffer.from(JSON.stringify(pointer)), etag: '"mutated-pointer"' })
    }
    installStateMutation((value) => { value.sourceReceiptDigest = 'f'.repeat(64) })
    await assert.rejects(readPreviousGenerationAuthorities({ config, client }), /state and raw source receipt authorities do not match/)
    Object.assign(stateObject, originalState)
    Object.assign(activeObject, originalActive)
    installStateMutation((value) => {
      value.compatibility = { ...(value.compatibility as Record<string, unknown>), modelVersion: 'mismatched-model' }
    })
    await assert.rejects(readPreviousGenerationAuthorities({ config, client }), /public and state model authorities do not match/)
    Object.assign(stateObject, originalState)
    Object.assign(activeObject, originalActive)
    await assert.rejects(readPreviousGenerationAuthorities({
      config,
      client,
      beforePointerRecheck: () => { activeObject.etag = '"rollback-race"' },
    }), /changed during rollback hydration/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('raw/state receipt mismatch and corrupt raw references never promote', async () => {
  const root = await mkdtemp(join(tmpdir(), 'triple-authority-fail-closed-'))
  const publicDir = join(root, 'public')
  const client = memoryS3()
  try {
    await writeBucketJson('active-generation.json', { schemaVersion: 1, generationId: 'current', fencingToken: 1 }, { config, client })
    for (const failure of ['digest-mismatch', 'corrupt-reference'] as const) {
      const generationId = `rejected_${failure.replace('-', '_')}`
      await writePublicFixture(publicDir, generationId)
      const raw = rawGeneration(generationId)
      const state = preparedStateWithReceipt(generationId, failure === 'digest-mismatch' ? 'f'.repeat(64) : raw.sourceReceiptDigest)
      await syncAllStateObjects(client, state.objects)
      const manifest = await writeIncrementalStateManifest(client, config, state)
      await assert.rejects(uploadRankingArtifacts({
        publicDataDir: publicDir,
        generationId,
        fencingToken: 2,
        contentAddressed: true,
        stateManifestAuthority: manifest.authority,
        rawSourceGeneration: raw,
        ...(failure === 'corrupt-reference' ? {
          beforePromotionWrite: () => {
            const key = `custom-rankings/${raw.oracle[0]!.baseline.key}`
            const stored = client.objects.get(key)!
            stored.bytes = Buffer.alloc(stored.bytes.byteLength)
          },
        } : {}),
        config,
        client,
      }), failure === 'digest-mismatch' ? /source receipt does not match/ : /gzip is corrupt|digest mismatch/)
      assert.equal((await readBucketJson('active-generation.json', { config, client })).value?.generationId, 'current')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prepared state contains complete compatibility and ordered checkpoint candidates', () => {
  const prepared = preparedState('generation-1')
  assert.equal(prepared.manifest.checkpoints.length, 2)
  assert.deepEqual(prepared.manifest.compatibility, compatibility)
  assert.deepEqual(prepared.manifest.checkpoints.map((entry) => entry.boundary), [
    { date: '2026-01-01', matchId: 'match-1' },
    { date: '2026-01-01', matchId: 'match-2' },
  ])
  assert.ok(prepared.manifest.checkpoints.every((entry) => entry.object.key.startsWith('state/objects/sha256/')))
  assert.ok(prepared.objects.slice(1).every((entry) => entry.value.artifactKind === 'incremental-state-checkpoint-bundle'))

  assert.throws(() => preparedState('duplicate', [checkpoint('match-1'), checkpoint('match-1')]), /duplicate checkpoint boundary/)
  assert.throws(() => preparedState('unordered', [checkpoint('match-2'), checkpoint('match-1')]), /must be ordered/)
  assert.throws(() => prepareContentAddressedState({
    ...stateInput('unsafe'),
    generationId: '../unsafe',
  }), /generationId is unsafe/)
})

test('state preparation preserves ref-only checkpoints without re-materializing their bundles', () => {
  const original = preparedState('ref-source')
  const refs = original.manifest.checkpoints.map((candidate) => ({
    boundary: candidate.boundary,
    rawPrefix: candidate.rawPrefix,
    storedObjectReference: candidate.object,
  }))
  const prepared = prepareContentAddressedState({ ...stateInput('ref-target', refs), checkpoints: refs })
  assert.deepEqual(prepared.manifest.checkpoints.map((candidate) => candidate.object), original.manifest.checkpoints.map((candidate) => candidate.object))
  assert.equal(prepared.objects.length, 0)
})

test('state objects conditionally create, reuse identical bytes, and reject collisions', async () => {
  const client = memoryS3()
  const object = preparedState('object-sync').objects[0]
  const first = await syncContentAddressedStateObject(client, config, object)
  const reused = await syncContentAddressedStateObject(client, config, object)
  assert.equal(first.status, 'uploaded')
  assert.equal(reused.status, 'unchanged')
  assert.match(first.key, /^custom-rankings\/state\/objects\/sha256\/[a-f0-9]{64}$/)

  const stored = client.objects.get(first.key)!
  stored.metadata = { ...stored.metadata, 'semantic-bytes': '1' }
  await assert.rejects(syncContentAddressedStateObject(client, config, object), /collision or metadata mismatch/)
})

test('a conditional-create race reuses only byte-identical state objects', async () => {
  const backing = memoryS3()
  const object = preparedState('object-race').objects[0]
  let headMisses = 0
  const client = {
    objects: backing.objects,
    async send(command: unknown) {
      const { name } = commandDetails(command)
      if (name === 'HeadObjectCommand' && headMisses < 2) {
        headMisses += 1
        throw Object.assign(new Error('missing'), { name: 'NotFound' })
      }
      return backing.send(command)
    },
  }
  const [first, second] = await Promise.all([
    syncContentAddressedStateObject(client, config, object),
    syncContentAddressedStateObject(client, config, object),
  ])
  assert.deepEqual([first.status, second.status].sort(), ['unchanged', 'uploaded'])
  assert.equal([first, second].find((entry) => entry.status === 'unchanged')?.reason, 'content-addressed-state-object-race-reused')
})

test('state manifests are immutable and identical retries reuse the original object', async () => {
  const client = memoryS3()
  const prepared = preparedState('manifest-immutable')
  await syncAllStateObjects(client, prepared.objects)
  const first = await writeIncrementalStateManifest(client, config, prepared)
  const reused = await writeIncrementalStateManifest(client, config, prepared)
  assert.equal(first.result.status, 'uploaded')
  assert.equal(reused.result.status, 'unchanged')
  assert.equal(first.authority.key, 'custom-rankings/state/generations/manifest-immutable.json')

  const changed = preparedState('manifest-immutable', [checkpoint('match-1', 1)])
  await assert.rejects(writeIncrementalStateManifest(client, config, changed), /state manifest collision/)
})

test('manifest authority fails closed for mutation, missing objects, and corrupt object bytes', async () => {
  const prepared = preparedState('authority')

  const mutatedClient = memoryS3()
  await syncAllStateObjects(mutatedClient, prepared.objects)
  const written = await writeIncrementalStateManifest(mutatedClient, config, prepared)
  const manifestStored = mutatedClient.objects.get(written.authority.key)!
  manifestStored.bytes = Buffer.concat([manifestStored.bytes, Buffer.from(' ')])
  await assert.rejects(assertStateManifestAuthority(mutatedClient, config, written.authority), /changed before active pointer promotion/)

  const missingClient = memoryS3()
  await syncAllStateObjects(missingClient, prepared.objects)
  const missingWritten = await writeIncrementalStateManifest(missingClient, config, prepared)
  missingClient.objects.delete(`custom-rankings/${prepared.manifest.checkpoints[0].object.key}`)
  await assert.rejects(assertStateManifestAuthority(missingClient, config, missingWritten.authority), /missing/)

  const corruptClient = memoryS3()
  await syncAllStateObjects(corruptClient, prepared.objects)
  const corruptWritten = await writeIncrementalStateManifest(corruptClient, config, prepared)
  const objectKey = `custom-rankings/${prepared.manifest.checkpoints[0].object.key}`
  const stored = corruptClient.objects.get(objectKey)!
  stored.bytes = Buffer.from('not gzip')
  stored.metadata = { ...stored.metadata }
  stored.metadata.sha256 = prepared.manifest.checkpoints[0].object.sha256
  stored.metadata['semantic-bytes'] = String(prepared.manifest.checkpoints[0].object.bytes)
  await assert.rejects(assertStateManifestAuthority(corruptClient, config, corruptWritten.authority), /metadata mismatch|gzip is corrupt/)
})

test('active pointers without state authority trigger a full rebuild and promotion resolves both manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incremental-state-public-'))
  const publicDir = join(root, 'public')
  const client = memoryS3()
  try {
    await writeBucketJson('active-generation.json', { schemaVersion: 1, generationId: 'without-state', fencingToken: 1 }, {
      config,
      client,
      ifNoneMatch: '*',
    })
    assert.deepEqual(
      await readActiveIncrementalState({ config, client }),
      {
        found: false,
        reason: 'incremental-state-authority-missing',
        active: { schemaVersion: 1, generationId: 'without-state', fencingToken: 1 },
        etag: '"1"',
      },
    )

    const generationId = 'state-public-generation'
    const raw = rawGeneration(generationId)
    const prepared = preparedStateWithReceipt(generationId, raw.sourceReceiptDigest)
    await syncAllStateObjects(client, prepared.objects)
    const state = await writeIncrementalStateManifest(client, config, prepared)
    await writePublicFixture(publicDir, generationId)
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId,
      fencingToken: 2,
      contentAddressed: true,
      stateManifestAuthority: state.authority,
      rawSourceGeneration: raw,
      config,
      client,
    })

    const activeStored = client.objects.get('custom-rankings/active-generation.json')!
    const active = JSON.parse(activeStored.bytes.toString('utf8')) as Record<string, unknown>
    assert.equal(active.generationId, generationId)
    assert.equal(active.stateManifestKey, state.authority.key)
    assert.equal(active.stateManifestDigest, state.authority.digest)
    assert.equal(client.objects.has(String(active.manifestKey)), true)
    assert.equal(client.objects.has(String(active.stateManifestKey)), true)

    const restored = await readActiveIncrementalState({ config, client })
    assert.equal(restored.found, true)
    if (!restored.found) assert.fail('active incremental state was not restored')
    assert.equal(restored.manifest.generationId, generationId)
    assert.equal(restored.checkpoints.length, 2)

    const partiallyRestored = await readActiveIncrementalState({ config, client, checkpointLimit: 1 })
    if (!partiallyRestored.found) assert.fail('partial incremental state was not restored')
    assert.equal(partiallyRestored.checkpoints.length, 1)
    assert.equal(typeof partiallyRestored.loadCheckpoints, 'function')
    assert.equal((await partiallyRestored.loadCheckpoints(partiallyRestored.manifest.checkpoints)).length, 2)

  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('crashes and stale workers cannot activate prepared state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incremental-state-orphan-'))
  const publicDir = join(root, 'public')
  const client = memoryS3()
  try {
    await writeBucketJson('active-generation.json', { schemaVersion: 1, generationId: 'current', fencingToken: 10 }, {
      config,
      client,
      ifNoneMatch: '*',
    })
    const raw = rawGeneration('orphan')
    const prepared = preparedStateWithReceipt('orphan', raw.sourceReceiptDigest)
    await syncAllStateObjects(client, prepared.objects)
    const state = await writeIncrementalStateManifest(client, config, prepared)
    assert.equal(JSON.parse(client.objects.get('custom-rankings/active-generation.json')!.body).generationId, 'current')

    await writePublicFixture(publicDir, 'orphan')
    await assert.rejects(uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'orphan',
      fencingToken: 9,
      contentAddressed: true,
      stateManifestAuthority: state.authority,
      rawSourceGeneration: raw,
      config,
      client,
    }), /Stale refresh worker/)
    const active = JSON.parse(client.objects.get('custom-rankings/active-generation.json')!.body)
    assert.equal(active.generationId, 'current')
    assert.equal(active.stateManifestKey, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('state-manifest mutation after preparation blocks public pointer promotion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incremental-state-race-'))
  const publicDir = join(root, 'public')
  const client = memoryS3()
  try {
    await writeBucketJson('active-generation.json', { schemaVersion: 1, generationId: 'current', fencingToken: 1 }, {
      config,
      client,
      ifNoneMatch: '*',
    })
    const raw = rawGeneration('state-race')
    const prepared = preparedStateWithReceipt('state-race', raw.sourceReceiptDigest)
    await syncAllStateObjects(client, prepared.objects)
    const state = await writeIncrementalStateManifest(client, config, prepared)
    await writePublicFixture(publicDir, 'state-race')
    await assert.rejects(uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'state-race',
      fencingToken: 2,
      contentAddressed: true,
      stateManifestAuthority: state.authority,
      rawSourceGeneration: raw,
      beforePromotionWrite: () => {
        const stored = client.objects.get(state.authority.key)!
        stored.bytes = Buffer.concat([stored.bytes, Buffer.from(' ')])
        stored.etag = '"mutated"'
      },
      config,
      client,
    }), /state manifest changed before active pointer promotion/i)
    assert.equal(JSON.parse(client.objects.get('custom-rankings/active-generation.json')!.body).generationId, 'current')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function rawGeneration(generationId: string) {
  const baseline = prepareOracleBaseline({
    sourceFileName: 'oracle-current.csv',
    importerVersion: compatibility.importerVersion,
    csv: [
      'gameid,date,league,side,position,teamname,result',
      'game-1,2026-01-01,LCK,Blue,team,Alpha,1',
      'game-1,2026-01-01,LCK,Red,team,Beta,0',
    ].join('\n'),
  })
  const prepared = prepareRawSourceReceipt({
    generationId,
    importerVersion: compatibility.importerVersion,
    coverage: { start: '2026-01-01', end: '2026-01-01' },
    sourceReceiptInputs: { source: 'test' },
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
    importerVersion: compatibility.importerVersion,
    coverage: { start: '2026-01-01', end: '2026-01-01' },
    sourceReceiptInputs: { source: 'test' },
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

function preparedStateWithReceipt(generationId: string, sourceReceiptDigest: string) {
  const ledger = prepareStateObject({ artifactKind: 'canonical-match-ledger', schemaVersion: 1, rows: [] })
  const prepared = prepareContentAddressedState({
    ...stateInput(generationId),
    runId: generationId,
    canonicalLedgerReference: stateObjectReferenceFor(ledger),
    sourceReceiptDigest,
  })
  return { ...prepared, objects: [ledger, ...prepared.objects] }
}

function stateInput(generationId: string, checkpoints: StateInputCheckpoint[] = [checkpoint('match-1'), checkpoint('match-2', 2)]) {
  return {
    generationId,
    runId: `${generationId}-run`,
    baseGenerationId: 'base-generation',
    baseRunId: 'base-run',
    canonicalLedgerReference: objectReference('a'.repeat(64), 'state/objects/sha256'),
    sourceReceiptDigest: 'b'.repeat(64),
    compatibility,
    checkpoints,
  }
}

function preparedState(generationId: string, checkpoints: StateInputCheckpoint[] = [checkpoint('match-1'), checkpoint('match-2', 2)]) {
  const ledger = prepareStateObject({ artifactKind: 'canonical-match-ledger', schemaVersion: 1, rows: [] })
  const prepared = prepareContentAddressedState({
    ...stateInput(generationId, checkpoints),
    canonicalLedgerReference: stateObjectReferenceFor(ledger),
  })
  return { ...prepared, objects: [ledger, ...prepared.objects] }
}

function checkpoint(matchId: string, matchCount = 1) {
  return {
    boundary: { date: '2026-01-01', matchId },
    rawPrefix: { matchCount, digest: createHash('sha256').update(`${matchId}:${matchCount}`).digest('hex') },
    ratingCheckpoint: { artifactKind: 'rating-checkpoint', teams: { Alpha: 1510 } },
    causalSummaries: {
      sourcedPlayer: { prefixLength: matchCount },
      dssTeam: { prefixLength: matchCount },
      dssRegion: { prefixLength: matchCount },
      rosterEra: { prefixLength: matchCount },
      playerResume: { prefixLength: matchCount },
    },
  }
}

function objectReference(digest: string, prefix: string): StateObjectReference {
  return { key: `${prefix}/${digest}`, sha256: digest, bytes: 1, compressedBytes: 1, storageEncoding: 'gzip' }
}

async function syncAllStateObjects(client: ReturnType<typeof memoryS3>, objects: PreparedStateObject[]) {
  for (const object of objects) await syncContentAddressedStateObject(client, config, object)
}

async function writePublicFixture(publicDir: string, generationId: string) {
  const generatedAt = '2026-07-22T00:00:00.000Z'
  await mkdir(publicDir, { recursive: true })
  await writeFile(join(publicDir, 'ranking-summary.json'), JSON.stringify({
    artifactKind: 'public-ranking-manifest',
    schemaVersion: 23,
    generatedAt,
    source: 'official-source-fixture',
    dataMode: 'test',
    sources: [{ name: 'fixture' }],
    model: { version: compatibility.modelVersion, configHash: compatibility.modelConfigHash },
    artifactMeta: { runId: generationId },
  }))
}

type StoredObject = {
  body: string
  bytes: Buffer
  etag: string
  contentType?: string
  contentEncoding?: string
  metadata: Record<string, string>
}

function memoryS3() {
  const objects = new Map<string, StoredObject>()
  let version = 0
  return {
    objects,
    async send(command: unknown) {
      const { name, input } = commandDetails(command)
      const key = String(input.Key)
      if (name === 'GetObjectCommand') {
        const object = objects.get(key)
        if (!object) throw Object.assign(new Error(`missing ${key}`), { name: 'NoSuchKey' })
        return {
          Body: Readable.from([object.bytes]),
          ETag: object.etag,
          ContentLength: object.bytes.byteLength,
          ContentType: object.contentType,
          ContentEncoding: object.contentEncoding,
          Metadata: object.metadata,
        }
      }
      if (name === 'HeadObjectCommand') {
        const object = objects.get(key)
        if (!object) throw Object.assign(new Error(`missing ${key}`), { name: 'NotFound' })
        return {
          ETag: object.etag,
          ContentLength: object.bytes.byteLength,
          ContentType: object.contentType,
          ContentEncoding: object.contentEncoding,
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
          metadata: isStringRecord(input.Metadata) ? input.Metadata : {},
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
