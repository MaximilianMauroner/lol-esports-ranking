import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import test from 'node:test'
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import {
  assertAuthorityAgreement,
  assertPublishReceiptBindings,
  assertStablePointer,
  canonicalReceiptDigest,
  captureRankingRestartBaseline,
  parseArgs,
  parseRankingRestartBaselineReceipt,
  readLatestFullAuditAuthority,
  resolveCommitIdentity,
} from '../scripts/ranking-restart-baseline.mjs'
import {
  canonicalJsonFor,
  createGenerationManifest,
  prepareSemanticArtifact,
} from '../scripts/public-artifact-storage.mjs'
import {
  prepareContentAddressedState,
  prepareStateObject,
  stateObjectReferenceFor,
} from '../scripts/incremental-state-storage.mjs'
import {
  ORACLE_GAME_INVENTORY_DIGEST_SCHEME,
  oracleGameInventory,
  prepareOracleBaseline,
  prepareRawSourceReceipt,
  rawObjectReferenceFor,
} from '../scripts/raw-source-storage.mjs'

const lessons = [
  'Green CI is not production-shaped proof; test Git and archive roots; do not assume .git.',
  'Full replay is a separate ~2GB workload; distinct probe/append/bootstrap/audit envelopes and honest measurement.',
  'Authority includes failure semantics; discriminated child states with explicit required/optional artifacts; real absent-file/provider fixtures.',
  'Recovery needs narrow override; scheduled freshness stays strict; verified-raw rebuild requires force + separate recovery authorization.',
  'Published movement is not causal match impact; explanations come from causal per-series engine output.',
  'Publication is transactional; immutable objects/state/receipts first, reassert fencing, active pointer last; immutable receipt members only.',
  'Correctness covers local-only, upload-disabled, content-addressed full, patch, no-data.',
  'Artifact dependencies need typed domain evidence including tournament invalidation and endpoint-state ratings.',
  'Rollout evidence measures the exact gate; one canonical schema/path resolver across CLI/runtime/runbook/tests/cost; audit success exact zero-mutation/full-comparison.',
  'Large stacked PRs hide risk; one current-main contract PR with production-shaped test at a time.',
]
const dispositions = new Set(['proven-fixed', 'still-exposed', 'intentionally-unsupported'])

test('incident ledger is exactly the approved ten ordered lessons with real mappings', async () => {
  const ledger = JSON.parse(await readFile('ops/ranking-restart/incident-ledger.json', 'utf8')) as {
    entries: Array<{
      id: string
      lesson: string
      currentPaths: string[]
      existingEvidence: string[]
      phase0Evidence: string[]
      disposition: string
      rationale: string
      followup: string
    }>
  }
  assert.equal(ledger.entries.length, 10)
  assert.deepEqual(ledger.entries.map(({ lesson }) => lesson), lessons)
  assert.deepEqual(ledger.entries.map(({ id }) => id), lessons.map((_, index) => `lesson-${String(index + 1).padStart(2, '0')}-${[
    'production-shaped-proof',
    'path-specific-memory',
    'discriminated-failure-authority',
    'narrow-recovery-override',
    'causal-explanations',
    'transactional-publication',
    'all-publication-modes',
    'typed-artifact-dependencies',
    'one-canonical-rollout-gate',
    'small-sequential-prs',
  ][index]}`))
  for (const entry of ledger.entries) {
    assert.ok(dispositions.has(entry.disposition))
    assert.ok(entry.existingEvidence.length > 0)
    assert.ok(entry.phase0Evidence.length > 0)
    assert.ok(entry.rationale.length > 0)
    assert.ok(entry.followup.length > 0)
    for (const path of entry.currentPaths) assert.ok((await stat(path)).isFile(), path)
  }
})

test('committed receipt is strict, canonical, complete, and authority-bound', async () => {
  const bytes = await readFile('ops/ranking-restart/baseline-receipt.json', 'utf8')
  const value = JSON.parse(bytes)
  const receipt = parseRankingRestartBaselineReceipt(value)
  assert.equal(bytes, `${canonicalJsonFor(receipt)}\n`)
  assert.equal(receipt.baseline.commit, '3682553419beada82a7954ad02db366571320667')
  assert.equal(receipt.active.generationId, 'run_20260723180458_transparent-power-index-v0-0-0_fnv1a-7e4c9e6f')
  assert.equal(receipt.active.model.version, 'transparent-power-index-v0.0.0')
  assert.equal(receipt.active.model.configHash, 'fnv1a-7e4c9e6f')
  assert.equal(receipt.active.rankingSchemaVersion, 23)
  assert.deepEqual(receipt.active.coverage, { start: '2025-01-12', end: '2026-07-19', matchCount: 4460, seeded: false })
  assert.equal(receipt.active.seeded, false)
  assert.equal(receipt.previous.complete, true)
  assert.equal(receipt.previous.publishReceipt.status, 'absent')
  assert.equal(receipt.latestFullAudit.status, 'absent')
  if (receipt.latestFullAudit.status === 'absent') {
    assert.equal(receipt.latestFullAudit.searchedPrefix, 'rankings/audits/days/')
    assert.equal(receipt.latestFullAudit.verifiedAt, receipt.capturedAt)
  }
  assert.equal(receipt.canonicalDigest, canonicalReceiptDigest(Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== 'canonicalDigest'),
  )))
})

test('strict parser rejects corruption, extra fields, and crossed authorities fail', async () => {
  const original = JSON.parse(await readFile('ops/ranking-restart/baseline-receipt.json', 'utf8'))
  assert.throws(() => parseRankingRestartBaselineReceipt({ ...original, invented: true }), /fields/)
  assert.throws(() => parseRankingRestartBaselineReceipt({ ...original, canonicalDigest: '0'.repeat(64) }), /digest mismatch/)
  assert.throws(() => assertAuthorityAgreement({
    generationId: 'generation-a',
    manifest: { generationId: 'generation-a', runId: 'generation-a', model: { version: 'v', configHash: 'c' } },
    stateManifest: { generationId: 'generation-b', sourceReceiptDigest: 'a', compatibility: { modelVersion: 'v', modelConfigHash: 'c' } },
    rawReceipt: { generationId: 'generation-a', sourceReceiptDigest: 'a' },
    pointer: { generationId: 'generation-a' },
  }), /Crossed generation/)
})

test('active pointer ETag or content race fails closed', () => {
  const first = { found: true, etag: '"etag-a"', value: { generationId: 'generation-a' } }
  assert.doesNotThrow(() => assertStablePointer(first, structuredClone(first)))
  assert.throws(() => assertStablePointer(first, { ...first, etag: '"etag-b"' }), /changed during baseline capture/)
  assert.throws(() => assertStablePointer(first, { ...first, value: { generationId: 'generation-b' } }), /changed during baseline capture/)
})

test('full capture hashes the bounded production graph and permits only read commands', async () => {
  const fixture = productionCaptureFixture({ audit: 'present' })
  const receipt = await captureRankingRestartBaseline(fixture.captureOptions)
  assert.equal(receipt.active.publicManifest.bytes, fixture.active.publicManifestBytes)
  assert.equal(receipt.previous.publicManifest.bytes, fixture.previous.publicManifestBytes)
  const previousManifestBody = fixture.objects.get(fixture.previous.publicKey)?.bytes
  assert.ok(previousManifestBody)
  assert.equal(receipt.previous.publicManifest.bytes, previousManifestBody.byteLength)
  assert.equal(receipt.previous.publicManifest.sha256, sha256(previousManifestBody))
  assert.equal(receipt.active.rankingSchemaVersion, 23)
  assert.equal(receipt.previous.publishReceipt.status, 'absent')
  assert.equal(receipt.latestFullAudit.status, 'present')
  assert.ok(fixture.calls.filter((name) => name === 'ListObjectsV2Command').length >= 2)
  assert.deepEqual(new Set(fixture.calls), new Set(['GetObjectCommand', 'ListObjectsV2Command']))
})

test('full capture rejects corrupt bodies, crossed publish authority, and pointer races', async () => {
  const corrupt = productionCaptureFixture()
  const corrupted = corrupt.objects.get(corrupt.active.extraPublicKey)
  assert.ok(corrupted)
  corrupted.bytes = Buffer.from(corrupted.bytes)
  corrupted.bytes[corrupted.bytes.length - 1] ^= 1
  await assert.rejects(captureRankingRestartBaseline(corrupt.captureOptions), /gzip is corrupt|body digest mismatch/)

  const crossed = productionCaptureFixture()
  const publish = crossed.objects.get(crossed.active.publishKey)
  assert.ok(publish)
  const value = JSON.parse(publish.bytes.toString('utf8'))
  const wrongDigest = 'f'.repeat(64)
  value.authorities.publicManifest.digest = wrongDigest
  const entry = [...value.artifacts, ...value.unchanged].find((candidate) => candidate.key === value.authorities.publicManifest.key)
  entry.digest = wrongDigest
  publish.bytes = Buffer.from(canonicalJsonFor(value))
  publish.contentLength = publish.bytes.byteLength
  await assert.rejects(captureRankingRestartBaseline(crossed.captureOptions), /publicManifest authority does not match/)

  const raced = productionCaptureFixture()
  await assert.rejects(captureRankingRestartBaseline({
    ...raced.captureOptions,
    beforeFinalPointerRead: () => {
      const pointer = raced.objects.get(raced.active.pointerKey)
      assert.ok(pointer)
      pointer.etag = '"raced"'
    },
  }), /changed during baseline capture/)
})

test('publish bindings reject crossed key, digest, and byte authorities', () => {
  const expected = {
    publicManifest: { key: 'rankings/generations/g/manifest.json', digest: 'a'.repeat(64), bytes: 10 },
    rawReceipt: { key: `rankings/raw/objects/sha256/${'b'.repeat(64)}`, digest: 'b'.repeat(64), bytes: 20 },
  }
  const receipt = { authorities: structuredClone(expected) }
  assert.doesNotThrow(() => assertPublishReceiptBindings(receipt, expected))
  for (const [field, value] of [['key', 'other'], ['digest', 'c'.repeat(64)], ['bytes', 11]] as const) {
    const crossed = structuredClone(receipt)
    crossed.authorities.publicManifest[field] = value as never
    assert.throws(() => assertPublishReceiptBindings(crossed, expected), /does not match/)
  }
})

test('canonical self-digest cannot legitimize crossed paths, integrity, or seeded state', async () => {
  const original = JSON.parse(await readFile('ops/ranking-restart/baseline-receipt.json', 'utf8'))
  const mutations = [
    (value: typeof original) => { value.active.publicManifest.key = 'rankings/generations/crossed/manifest.json' },
    (value: typeof original) => { value.active.rawReceipt.key = `rankings/raw/objects/sha256/${'0'.repeat(64)}` },
    (value: typeof original) => { value.active.seeded = true },
    (value: typeof original) => { value.integrity[0].key = 'rankings/crossed.json' },
    (value: typeof original) => { value.latestFullAudit.searchedPrefix = 'rankings/crossed/' },
    (value: typeof original) => { value.active.pointer.key = '../active-generation.json' },
    (value: typeof original) => { value.active.publicManifest.key = '/rankings/generations/crossed/manifest.json' },
    (value: typeof original) => { value.active.stateManifest.key = 'rankings\\state\\generations\\crossed.json' },
    (value: typeof original) => { value.producingCode[0] = 'scripts/../secrets.txt' },
    (value: typeof original) => { value.producingCode[0] = 'scripts/./unsafe.mjs' },
    (value: typeof original) => { value.producingCode[0] = 'scripts//unsafe.mjs' },
  ]
  for (const mutate of mutations) {
    const value = structuredClone(original)
    mutate(value)
    value.canonicalDigest = canonicalReceiptDigest(Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== 'canonicalDigest'),
    ))
    assert.throws(() => parseRankingRestartBaselineReceipt(value), /canonical|disagree|bound|Invalid/)
  }
})

test('capture requires schema authority from state compatibility with no fallback', async () => {
  const fixture = productionCaptureFixture()
  const stateManifest = fixture.active.stateManifest
  const readers = {
    readActiveIncrementalState: async () => ({
      found: true,
      active: fixture.active.pointer,
      manifest: {
        ...stateManifest,
        compatibility: { ...stateManifest.compatibility, publicArtifactSchemaVersion: undefined },
      },
      bytes: fixture.active.stateManifestBytes,
    }),
  }
  await assert.rejects(captureRankingRestartBaseline({
    ...fixture.captureOptions,
    readers,
  }), /ranking schemaVersion from state compatibility/)
})

test('audit inspection is paginated, selects newest canonical day, and is read-only', async () => {
  const baseline = prepareOracleBaseline({
    sourceFileName: 'oracle.csv',
    importerVersion: 'test-importer',
    csv: 'gameid,date,league,side,position,teamname,result\ngame-1,2026-01-02,LCK,Blue,team,Alpha,1\ngame-1,2026-01-02,LCK,Red,team,Beta,0\n',
  })
  const raw = prepareRawSourceReceipt({
    generationId: 'audit-generation',
    importerVersion: 'test-importer',
    coverage: { start: '2026-01-01', end: '2026-01-02' },
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
  const rawReference = rawObjectReferenceFor(raw.prepared)
  const ledger = prepareStateObject({ kind: 'test-ledger' })
  const ledgerReference = stateObjectReferenceFor(ledger)
  const snapshot = prepareStateObject({ kind: 'test-snapshot' })
  const snapshotReference = {
    key: `audits/objects/sha256/${snapshot.digest}`,
    sha256: snapshot.digest,
    bytes: snapshot.bytes,
    compressedBytes: snapshot.compressedBytes,
    storageEncoding: 'gzip' as const,
  }
  const receipt = {
    artifactKind: 'full-ranking-audit-receipt',
    schemaVersion: 1,
    auditDate: '2026-07-23',
    cause: 'daily-audit',
    generationId: 'audit-generation',
    runId: 'audit-generation',
    fencingToken: 4,
    promotedAt: '2026-07-23T01:00:00.000Z',
    model: { version: 'model-v1', configHash: 'config-v1' },
    sourceReceipt: rawReference,
    rawLedger: ledgerReference,
    fullSnapshot: snapshotReference,
  }
  const config = bucketConfig()
  const objects = new Map<string, StoredObject>()
  objects.set('rankings/audits/days/2026-07-23.json', plainObject(receipt))
  objects.set(`rankings/${rawReference.key}`, compressedObject(raw.prepared))
  objects.set(`rankings/${baseline.reference.key}`, compressedObject(baseline.prepared))
  objects.set(`rankings/${ledgerReference.key}`, compressedObject(ledger))
  objects.set(`rankings/${snapshotReference.key}`, compressedObject(snapshot))
  const calls: string[] = []
  const client = {
    async send(command: unknown) {
      const name = (command as { constructor: { name: string } }).constructor.name
      calls.push(name)
      assert.ok(['GetObjectCommand', 'HeadObjectCommand', 'ListObjectsV2Command'].includes(name), name)
      const input = (command as { input: { Key?: string; ContinuationToken?: string } }).input
      if (command instanceof ListObjectsV2Command) {
        return input.ContinuationToken
          ? { IsTruncated: false, Contents: [{ Key: 'rankings/audits/days/2026-07-23.json' }] }
          : {
              IsTruncated: true,
              NextContinuationToken: 'page-2',
              Contents: [
                { Key: 'rankings/audits/days/2026-07-22.json' },
                { Key: 'rankings/audits/days/not-a-day.json' },
              ],
            }
      }
      const object = objects.get(input.Key ?? '')
      if (!object) throw new Error(`Unexpected object ${input.Key}`)
      if (command instanceof HeadObjectCommand) {
        const head = { ...object, Body: undefined }
        return head
      }
      assert.ok(command instanceof GetObjectCommand)
      return object
    },
  }
  const authority = await readLatestFullAuditAuthority({
    config,
    client,
    verifiedAt: '2026-07-23T02:00:00.000Z',
  })
  assert.equal(authority.status, 'present')
  if (authority.status === 'present') assert.equal(authority.auditDate, '2026-07-23')
  assert.deepEqual(new Set(calls), new Set(['ListObjectsV2Command', 'GetObjectCommand']))
})

test('audit absence records the canonical searched prefix across all pages', async () => {
  const calls: string[] = []
  const client = {
    async send(command: unknown) {
      calls.push((command as { constructor: { name: string } }).constructor.name)
      assert.ok(command instanceof ListObjectsV2Command)
      const token = (command as ListObjectsV2Command).input.ContinuationToken
      return token
        ? { IsTruncated: false, Contents: [] }
        : { IsTruncated: true, NextContinuationToken: 'next', Contents: [{ Key: 'rankings/audits/days/invalid.json' }] }
    },
  }
  assert.deepEqual(await readLatestFullAuditAuthority({
    config: bucketConfig(),
    client,
    verifiedAt: '2026-07-23T02:00:00.000Z',
  }), {
    status: 'absent',
    searchedPrefix: 'rankings/audits/days/',
    verifiedAt: '2026-07-23T02:00:00.000Z',
  })
  assert.deepEqual(calls, ['ListObjectsV2Command', 'ListObjectsV2Command'])
})

test('commit identity has explicit/env/Git priority and archive failure is strict', async () => {
  const explicit = '1'.repeat(40)
  const railway = '2'.repeat(40)
  const generic = '3'.repeat(40)
  const git = '4'.repeat(40)
  const options = {
    env: { RAILWAY_GIT_COMMIT_SHA: railway, GIT_COMMIT_SHA: generic },
    hasGitMetadata: async () => true,
    git: async () => git,
  }
  assert.equal(await resolveCommitIdentity({ ...options, explicitCommit: explicit }), explicit)
  assert.equal(await resolveCommitIdentity(options), railway)
  assert.equal(await resolveCommitIdentity({ ...options, env: { GIT_COMMIT_SHA: generic } }), generic)
  assert.equal(await resolveCommitIdentity({ ...options, env: {} }), git)
  assert.equal(await resolveCommitIdentity({ explicitCommit: explicit, env: {}, hasGitMetadata: async () => false }), explicit)
  await assert.rejects(resolveCommitIdentity({ env: {}, hasGitMetadata: async () => false }), /archives without .git/)
  assert.throws(() => parseArgs(['capture', '--overwrite']), /Unknown baseline argument/)
})

test('runtime defaults, cron, proxy delivery, and delete opt-in remain unchanged', async () => {
  const [once, server, gc, refreshToml] = await Promise.all([
    readFile('scripts/refresh-once.mjs', 'utf8'),
    readFile('scripts/railway-server.mjs', 'utf8'),
    readFile('scripts/ranking-bucket-gc.mjs', 'utf8'),
    readFile('railway.refresh.toml', 'utf8'),
  ])
  assert.match(once, /RANKING_REFRESH_INTERVAL_MINUTES', 360/)
  assert.match(once, /return value === 'shadow' \? 'shadow' : 'gated'/)
  assert.match(server, /RANKING_PRESIGNED_DELIVERY_ENABLED === 'true'/)
  assert.match(gc, /if \(argument === '--delete'\)|if \(arg === '--delete'\)/)
  assert.match(refreshToml, /cronSchedule = "0 \*\/6 \* \* \*"/)
})

test('baseline inspector imports and issues no publication or deletion capability', async () => {
  const source = await readFile('scripts/ranking-restart-baseline.mjs', 'utf8')
  for (const forbidden of [
    'PutObjectCommand',
    'DeleteObjectCommand',
    'CopyObjectCommand',
    'writeBucketJson',
    'uploadRankingArtifacts',
    'publishGenerationReceipt',
    'deleteObject(',
  ]) assert.equal(source.includes(forbidden), false, forbidden)
  assert.match(source, /GetObjectCommand, ListObjectsV2Command/)
})

function bucketConfig() {
  return {
    enabled: true as const,
    bucket: 'test',
    endpoint: 'https://example.invalid',
    region: 'auto',
    accessKeyId: 'x',
    secretAccessKey: 'y',
    prefix: 'rankings',
  }
}

type StoredObject = {
  Body: Buffer
  ContentLength: number
  ETag?: string
  ContentEncoding?: string
  Metadata?: Record<string, string>
}

function plainObject(value: unknown): StoredObject {
  const bytes = Buffer.from(canonicalJsonFor(value))
  return { Body: bytes, ContentLength: bytes.byteLength, ETag: '"plain"' }
}

function compressedObject(prepared: { compressed: Buffer; compressedBytes: number; digest: string; bytes: number }): StoredObject {
  return {
    Body: prepared.compressed,
    ContentLength: prepared.compressedBytes,
    ContentEncoding: 'gzip',
    Metadata: {
      sha256: prepared.digest,
      'semantic-bytes': String(prepared.bytes),
      encoding: 'gzip',
    },
  }
}

type BucketStored = {
  bytes: Buffer
  contentLength: number
  etag?: string
  contentType?: string
  contentEncoding?: string
  metadata?: Record<string, string>
}

function productionCaptureFixture({ audit = 'absent' }: { audit?: 'absent' | 'present' } = {}) {
  const config = bucketConfig()
  const objects = new Map<string, BucketStored>()
  const calls: string[] = []
  const model = { version: 'transparent-power-index-v0.0.0', configHash: 'fnv1a-test' }
  const compatibility = {
    modelVersion: model.version,
    modelConfigHash: model.configHash,
    importerVersion: 'test-importer',
    taxonomyVersion: 'test-taxonomy',
    ratingCheckpointSchemaVersion: 1,
    causalPrefixSchemaVersion: 1,
    publicArtifactSchemaVersion: 23,
  }
  const baseline = prepareOracleBaseline({
    sourceFileName: 'oracle.csv',
    importerVersion: compatibility.importerVersion,
    csv: 'gameid,date,league,side,position,teamname,result\ngame-1,2026-01-02,LCK,Blue,team,Alpha,1\ngame-1,2026-01-02,LCK,Red,team,Beta,0\n',
  })
  putCompressed(objects, `rankings/${baseline.reference.key}`, baseline.prepared)

  const createGeneration = (generationId: string, promotedAt: string) => {
    const root = {
      artifactKind: 'public-ranking-manifest',
      schemaVersion: 23,
      generatedAt: promotedAt,
      artifactMeta: { runId: generationId },
      source: 'production-shaped-test',
      sources: [{ name: 'Oracle test fixture' }],
      dataMode: 'scheduled-public-data',
      model,
      coverage: {
        coverageStart: '2026-01-01',
        coverageEnd: '2026-01-02',
        latestMatchDate: '2026-01-02',
        matchCount: 1,
        seededSample: false,
        sourceProviders: ['oracles-elixir'],
      },
    }
    const publicObjects = [
      { logicalPath: '/data/ranking-summary.json', prepared: prepareSemanticArtifact(root) },
      { logicalPath: '/data/entities/teams.json', prepared: prepareSemanticArtifact({ artifactKind: 'team-directory', schemaVersion: 23, teams: [] }) },
    ]
    for (const entry of publicObjects) putCompressed(objects, `rankings/objects/sha256/${entry.prepared.digest}`, entry.prepared)
    const publicManifest = createGenerationManifest({
      generationId,
      rootManifest: root,
      entries: publicObjects.map(({ logicalPath, prepared }) => ({
        logicalPath,
        digest: prepared.digest,
        bytes: prepared.bytes,
      })),
    })
    const publicStored = putPlain(objects, `rankings/generations/${generationId}/manifest.json`, publicManifest, `"manifest-${generationId}"`, true)

    const raw = prepareRawSourceReceipt({
      generationId,
      importerVersion: compatibility.importerVersion,
      coverage: { start: '2026-01-01', end: '2026-01-02' },
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
    const rawReference = rawObjectReferenceFor(raw.prepared)
    putCompressed(objects, `rankings/${rawReference.key}`, raw.prepared)

    const ledger = prepareStateObject({ artifactKind: 'canonical-ledger-test', generationId, rows: [] })
    const ledgerReference = stateObjectReferenceFor(ledger)
    putCompressed(objects, `rankings/${ledgerReference.key}`, ledger)
    const state = prepareContentAddressedState({
      generationId,
      canonicalLedgerReference: ledgerReference,
      sourceReceiptDigest: raw.receipt.sourceReceiptDigest,
      compatibility,
      checkpoints: [{
        boundary: { date: '2026-01-02', matchId: 'match-1' },
        rawPrefix: { matchCount: 1, digest: 'a'.repeat(64) },
        ratingCheckpoint: {},
        causalSummaries: { sourcedPlayer: {}, dssTeam: {}, dssRegion: {}, rosterEra: {}, playerResume: {} },
      }],
    })
    for (const prepared of state.objects) putCompressed(objects, `rankings/state/objects/sha256/${prepared.digest}`, prepared)
    const stateStored = putPlain(objects, `rankings/state/generations/${generationId}.json`, state.manifest, `"state-${generationId}"`, true)

    const publish = publishReceiptFor({
      generationId,
      publicStored,
      rawReference,
      publicObjects: publicObjects.map(({ prepared }) => prepared),
    })
    const publishKey = `rankings/generations/${generationId}/publish.json`
    putPlain(objects, publishKey, publish, `"publish-${generationId}"`)
    return {
      generationId,
      promotedAt,
      root,
      publicManifest,
      publicManifestBytes: publicStored.bytes.byteLength,
      publicManifestDigest: sha256(publicStored.bytes),
      publicManifestEtag: publicStored.etag,
      publicKey: `rankings/generations/${generationId}/manifest.json`,
      extraPublicKey: `rankings/objects/sha256/${publicObjects[1].prepared.digest}`,
      stateManifest: state.manifest,
      stateManifestBytes: stateStored.bytes.byteLength,
      stateManifestDigest: sha256(stateStored.bytes),
      stateKey: `rankings/state/generations/${generationId}.json`,
      ledgerReference,
      raw,
      rawReference,
      rawKey: `rankings/${rawReference.key}`,
      publish,
      publishKey,
    }
  }

  const previous = createGeneration('previous-generation', '2026-07-22T01:00:00.000Z')
  objects.delete(previous.publishKey)
  const active = createGeneration('active-generation', '2026-07-23T01:00:00.000Z')
  const pointerKey = 'rankings/active-generation.json'
  const pointer = {
    schemaVersion: 1,
    generationId: active.generationId,
    fencingToken: 7,
    promotedAt: active.promotedAt,
    manifestKey: active.publicKey,
    publicManifestSchemaVersion: 2,
    storageMode: 'content-addressed-gzip-v1',
    manifestDigest: active.publicManifestDigest,
    manifestBytes: active.publicManifestBytes,
    manifestEtag: active.publicManifestEtag,
    stateManifestKey: active.stateKey,
    stateManifestDigest: active.stateManifestDigest,
    rawReceiptKey: active.rawKey,
    rawReceiptDigest: active.rawReference.sha256,
    rawReceiptBytes: active.rawReference.bytes,
    rawReceiptCompressedBytes: active.rawReference.compressedBytes,
    sourceReceiptDigest: active.raw.receipt.sourceReceiptDigest,
    rawIdentityDigest: active.raw.receipt.rawIdentityDigest,
    previousGeneration: {
      generationId: previous.generationId,
      manifestKey: previous.publicKey,
      promotedAt: previous.promotedAt,
      stateManifestKey: previous.stateKey,
      stateManifestDigest: previous.stateManifestDigest,
      rawReceiptKey: previous.rawKey,
      rawReceiptDigest: previous.rawReference.sha256,
    },
  }
  putPlain(objects, pointerKey, pointer, '"pointer"')

  let auditReceiptKey: string | undefined
  if (audit === 'present') {
    const snapshot = prepareStateObject({ artifactKind: 'full-ranking-artifact-test', rows: [] })
    const fullSnapshot = {
      key: `audits/objects/sha256/${snapshot.digest}`,
      sha256: snapshot.digest,
      bytes: snapshot.bytes,
      compressedBytes: snapshot.compressedBytes,
      storageEncoding: 'gzip' as const,
    }
    putCompressed(objects, `rankings/${fullSnapshot.key}`, snapshot)
    const receipt = {
      artifactKind: 'full-ranking-audit-receipt',
      schemaVersion: 1,
      auditDate: '2026-07-23',
      cause: 'daily-audit',
      generationId: active.generationId,
      runId: active.generationId,
      fencingToken: 7,
      promotedAt: active.promotedAt,
      model,
      sourceReceipt: active.rawReference,
      rawLedger: active.ledgerReference,
      fullSnapshot,
    }
    auditReceiptKey = 'rankings/audits/days/2026-07-23.json'
    putPlain(objects, auditReceiptKey, receipt, '"audit"')
  }

  const client = {
    async send(command: unknown) {
      const name = (command as { constructor: { name: string } }).constructor.name
      calls.push(name)
      if (!['GetObjectCommand', 'HeadObjectCommand', 'ListObjectsV2Command'].includes(name)) {
        throw new Error(`Mutation command rejected: ${name}`)
      }
      const input = (command as { input: { Key?: string; ContinuationToken?: string } }).input
      if (command instanceof ListObjectsV2Command) {
        if (input.ContinuationToken) {
          return { IsTruncated: false, Contents: auditReceiptKey ? [{ Key: auditReceiptKey }] : [] }
        }
        return {
          IsTruncated: true,
          NextContinuationToken: 'page-2',
          Contents: [{ Key: 'rankings/audits/days/not-canonical.json' }],
        }
      }
      const stored = objects.get(input.Key ?? '')
      if (!stored) {
        const error = Object.assign(new Error('missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } })
        throw error
      }
      return {
        Body: Buffer.from(stored.bytes),
        ContentLength: stored.contentLength,
        ContentType: stored.contentType,
        ContentEncoding: stored.contentEncoding,
        Metadata: stored.metadata ? { ...stored.metadata } : undefined,
        ETag: stored.etag,
      }
    },
  }
  const captureOptions = {
    config,
    client,
    baselineCommit: '1'.repeat(40),
    baselineTag: 'ranking-restart-test',
    capturedAt: '2026-07-23T02:00:00.000Z',
    railway: {
      projectId: '11111111-1111-4111-8111-111111111111',
      environmentId: '22222222-2222-4222-8222-222222222222',
      bucketId: '33333333-3333-4333-8333-333333333333',
      bucketName: 'ranking-artifacts',
      web: {
        serviceId: '44444444-4444-4444-8444-444444444444',
        deploymentId: '55555555-5555-4555-8555-555555555555',
        commit: '1'.repeat(40),
      },
      refresh: {
        serviceId: '66666666-6666-4666-8666-666666666666',
        deploymentId: '77777777-7777-4777-8777-777777777777',
        commit: '1'.repeat(40),
      },
    },
  }
  return {
    objects,
    calls,
    active: { ...active, pointer, pointerKey },
    previous,
    captureOptions,
  }
}

function publishReceiptFor({
  generationId,
  publicStored,
  rawReference,
  publicObjects,
}: {
  generationId: string
  publicStored: BucketStored
  rawReference: ReturnType<typeof rawObjectReferenceFor>
  publicObjects: Array<ReturnType<typeof prepareSemanticArtifact>>
}) {
  const manifestDigest = sha256(publicStored.bytes)
  const entries = [
    {
      key: `rankings/generations/${generationId}/manifest.json`,
      bytes: publicStored.bytes.byteLength,
      contentType: 'application/json; charset=utf-8',
      digest: manifestDigest,
    },
    {
      key: `rankings/raw/objects/sha256/${rawReference.sha256}`,
      bytes: rawReference.compressedBytes,
      contentType: 'application/json; charset=utf-8',
      digest: rawReference.sha256,
    },
    ...publicObjects.map((prepared) => ({
      key: `rankings/objects/sha256/${prepared.digest}`,
      bytes: prepared.compressedBytes,
      contentType: 'application/json; charset=utf-8',
      digest: prepared.digest,
    })),
  ]
  return {
    schemaVersion: 2,
    publishedAt: '2026-07-23T01:00:00.000Z',
    prefix: 'rankings',
    generationId,
    storageMode: 'content-addressed-gzip-v1',
    storage: {
      mode: 'content-addressed-gzip-v1',
      objectCount: publicObjects.length,
      logicalArtifactCount: publicObjects.length,
      semanticLogicalBytes: publicObjects.reduce((sum, prepared) => sum + prepared.bytes, 0),
      compressedLogicalBytes: publicObjects.reduce((sum, prepared) => sum + prepared.compressedBytes, 0),
      uniqueCompressedBytes: publicObjects.reduce((sum, prepared) => sum + prepared.compressedBytes, 0),
    },
    authorities: {
      publicManifest: {
        key: entries[0].key,
        digest: manifestDigest,
        bytes: publicStored.bytes.byteLength,
        contentType: 'application/json; charset=utf-8',
      },
      rawReceipt: {
        key: entries[1].key,
        digest: rawReference.sha256,
        bytes: rawReference.compressedBytes,
        contentType: 'application/json; charset=utf-8',
      },
    },
    artifactCount: entries.length,
    uploadedCount: entries.length,
    uploadedBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    unchangedCount: 0,
    unchangedBytes: 0,
    artifacts: entries,
    unchanged: [],
    skipped: [],
  }
}

function putPlain(
  objects: Map<string, BucketStored>,
  key: string,
  value: unknown,
  etag: string,
  authoritativeMetadata = false,
) {
  const bytes = Buffer.from(canonicalJsonFor(value))
  const digest = sha256(bytes)
  const stored = {
    bytes,
    contentLength: bytes.byteLength,
    contentType: 'application/json; charset=utf-8',
    etag,
    ...(authoritativeMetadata ? { metadata: { sha256: digest, 'semantic-bytes': String(bytes.byteLength) } } : {}),
  }
  objects.set(key, stored)
  return stored
}

function putCompressed(
  objects: Map<string, BucketStored>,
  key: string,
  prepared: { compressed: Buffer; compressedBytes: number; digest: string; bytes: number },
) {
  objects.set(key, {
    bytes: Buffer.from(prepared.compressed),
    contentLength: prepared.compressedBytes,
    contentType: 'application/json; charset=utf-8',
    contentEncoding: 'gzip',
    metadata: {
      sha256: prepared.digest,
      'semantic-bytes': String(prepared.bytes),
      encoding: 'gzip',
    },
  })
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}
