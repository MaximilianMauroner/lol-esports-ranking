import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import test from 'node:test'
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import {
  assertAuthorityAgreement,
  assertStablePointer,
  canonicalReceiptDigest,
  parseRankingRestartBaselineReceipt,
  readLatestFullAuditAuthority,
  resolveCommitIdentity,
} from '../scripts/ranking-restart-baseline.mjs'
import { canonicalJsonFor } from '../scripts/public-artifact-storage.mjs'
import { prepareStateObject, stateObjectReferenceFor } from '../scripts/incremental-state-storage.mjs'
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
  assert.deepEqual(receipt.latestFullAudit, {
    status: 'absent',
    searchedPrefix: 'rankings/audits/days/',
    verifiedAt: '2026-07-23T19:30:00.000Z',
  })
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
  assert.deepEqual(new Set(calls), new Set(['ListObjectsV2Command', 'GetObjectCommand', 'HeadObjectCommand']))
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
  assert.match(source, /GetObjectCommand, HeadObjectCommand, ListObjectsV2Command/)
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
