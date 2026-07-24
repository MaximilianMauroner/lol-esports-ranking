import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  authorityIdentityFor,
  parseRankingSourceAuthorityEvidenceEnvelope,
  parseRankingSourceAuthorityEvidence,
  prepareRankingSourceAuthorityEvidence,
  rankingSourceAuthorityEvidenceDigest,
  validateRawSourceAuthority,
  type RankingSourceAuthorityEvidence,
  type RawSourceAuthority,
} from '../scripts/ranking-source-authority.mjs'
import {
  ORACLE_GAME_INVENTORY_DIGEST_SCHEME,
  oracleGameInventory,
  prepareOracleBaseline,
  prepareRawSourceReceipt,
  rawObjectReferenceFor,
  type PreparedRawObject,
  type RawObjectReference,
} from '../scripts/raw-source-storage.mjs'

const IMPORTER_VERSION = 'community-source-import-v1'
const COVERAGE = { start: '2026-01-01', end: '2026-07-08' }

function authorityFixture() {
  const baseline = prepareOracleBaseline({
    csv: [
      'gameid,date,league,side',
      'game-1,2026-07-08,LCK,Blue',
      'game-1,2026-07-08,LCK,Red',
    ].join('\n'),
    sourceFileName: '2026.csv',
    importerVersion: IMPORTER_VERSION,
  })
  const preparedReceipt = prepareRawSourceReceipt({
    generationId: 'raw_generation_1',
    importerVersion: IMPORTER_VERSION,
    coverage: COVERAGE,
    sourceReceiptInputs: { sources: { oracle: { status: 'downloaded' } } },
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
  const objects = new Map<string, Buffer>()
  addPrepared(objects, baseline.prepared)
  const authority: RawSourceAuthority = {
    found: true,
    receipt: preparedReceipt.receipt,
    receiptReference: rawObjectReferenceFor(preparedReceipt.prepared),
    objectResolver: async (reference) => objects.get(reference.key),
  }
  return { authority, objects, baseline }
}

function addPrepared(store: Map<string, Buffer>, prepared: PreparedRawObject) {
  store.set(rawObjectReferenceFor(prepared).key, prepared.compressed)
}

function providerResult(status: 'available' | 'unavailable' | 'no-data') {
  return {
    status,
    sources: { oracle: { status: status === 'available' ? 'downloaded' : 'failed' } },
    warnings: status === 'available' ? [] : ['provider unavailable'],
  }
}

test('fresh, stale, and forced recovery evidence are distinct canonical immutable proofs', async () => {
  const { authority } = authorityFixture()
  const validated = await validateRawSourceAuthority(authority, { importerVersion: IMPORTER_VERSION })
  const common = {
    runId: 'refresh-run-1',
    attemptedAt: '2026-07-09T00:00:00.000Z',
    requestedCoverage: { start: '2026-07-02', end: '2026-07-09' },
  }
  const fresh = prepareRankingSourceAuthorityEvidence({
    ...common,
    mode: 'fresh-ingestion',
    providerResult: providerResult('available'),
    authority: null,
    outage: null,
    restoredBaseline: null,
    compatibility: null,
  })
  const stale = prepareRankingSourceAuthorityEvidence({
    ...common,
    mode: 'stale-source-preservation',
    providerResult: providerResult('unavailable'),
    authority: null,
    outage: {
      reason: 'no-current-match-source-data',
      attemptedCoverage: common.requestedCoverage,
      providerResult: providerResult('unavailable'),
    },
    restoredBaseline: null,
    compatibility: null,
  })
  const recovery = prepareRankingSourceAuthorityEvidence({
    ...common,
    mode: 'forced-verified-raw-recovery',
    providerResult: providerResult('unavailable'),
    authority: authorityIdentityFor(validated),
    outage: {
      reason: 'no-current-match-source-data',
      attemptedCoverage: common.requestedCoverage,
      providerResult: providerResult('unavailable'),
    },
    restoredBaseline: {
      generationId: validated.receipt.generationId,
      sourceReceiptDigest: validated.receipt.sourceReceiptDigest,
      rawIdentityDigest: validated.receipt.rawIdentityDigest,
      coverage: validated.receipt.coverage,
    },
    compatibility: {
      importerVersion: validated.receipt.importerVersion,
      receiptSchemaVersion: 1,
      storageMode: validated.receipt.storageMode,
    },
  })

  assert.equal(new Set([fresh.evidenceDigest, stale.evidenceDigest, recovery.evidenceDigest]).size, 3)
  for (const proof of [fresh, stale, recovery]) {
    assert.deepEqual(parseRankingSourceAuthorityEvidence(proof.evidence), proof.evidence)
    assert.equal(rankingSourceAuthorityEvidenceDigest(proof.evidence), proof.evidenceDigest)
    assert.ok(proof.bytes > 0)
    assert.deepEqual(parseRankingSourceAuthorityEvidenceEnvelope(proof), proof)
  }
  assert.throws(() => parseRankingSourceAuthorityEvidenceEnvelope({
    ...stale,
    evidenceDigest: '0'.repeat(64),
  }), /envelope identity mismatch/)
  assert.equal(recovery.evidence.authority?.sourceReceiptDigest, validated.receipt.sourceReceiptDigest)
  assert.equal(recovery.evidence.authority?.rawIdentityDigest, validated.receipt.rawIdentityDigest)
  assert.deepEqual(recovery.evidence.authority?.coverage, COVERAGE)

  assert.throws(() => parseRankingSourceAuthorityEvidence({
    ...fresh.evidence,
    authority: recovery.evidence.authority,
  }), /without recovery provenance/)
  assert.throws(() => parseRankingSourceAuthorityEvidence({
    ...stale.evidence,
    compatibility: recovery.evidence.compatibility,
  }), /without a restored baseline/)
  assert.throws(() => parseRankingSourceAuthorityEvidence({
    ...stale.evidence,
    outage: {
      ...stale.evidence.outage!,
      attemptedCoverage: { start: '2026-07-01', end: '2026-07-09' },
    },
  }), /outage provenance contradicts/)
  assert.throws(() => parseRankingSourceAuthorityEvidence({
    ...recovery.evidence,
    restoredBaseline: {
      ...recovery.evidence.restoredBaseline!,
      rawIdentityDigest: 'f'.repeat(64),
    },
  }), /contradicts its authority identity/)
  assert.throws(() => parseRankingSourceAuthorityEvidence({
    ...recovery.evidence,
    compatibility: {
      ...recovery.evidence.compatibility!,
      importerVersion: 'different-importer',
    },
  }), /contradicts its authority identity/)
})

test('evidence modes reject ambiguous or weakened recovery provenance', () => {
  const stale = prepareRankingSourceAuthorityEvidence({
    mode: 'stale-source-preservation',
    runId: 'refresh-run-2',
    attemptedAt: '2026-07-09T00:00:00.000Z',
    providerResult: providerResult('no-data'),
    requestedCoverage: { start: '2026-07-02', end: '2026-07-09' },
    authority: null,
    outage: {
      reason: 'no-data',
      attemptedCoverage: { start: '2026-07-02', end: '2026-07-09' },
      providerResult: providerResult('no-data'),
    },
    restoredBaseline: null,
    compatibility: null,
  })
  const extraField = { ...stale.evidence, unexpected: true }
  assert.throws(() => parseRankingSourceAuthorityEvidence(extraField), /unexpected fields/)
  assert.throws(() => parseRankingSourceAuthorityEvidence({
    ...stale.evidence,
    mode: 'forced-verified-raw-recovery',
  }), /requires outage, authority, restored baseline, and compatibility/)
  assert.throws(() => parseRankingSourceAuthorityEvidence({
    ...stale.evidence,
    mode: 'fresh-ingestion',
  }), /available provider data/)
})

test('raw authority validation reconstructs every object and fails closed on reference, bytes, object, importer, or coverage mismatch', async () => {
  const { authority, objects, baseline } = authorityFixture()
  const validated = await validateRawSourceAuthority(authority, {
    importerVersion: IMPORTER_VERSION,
    requiredCoverage: COVERAGE,
  })
  assert.equal(validated.reconstructed.oracle.length, 1)

  await assert.rejects(validateRawSourceAuthority({
    ...authority,
    receiptReference: { ...authority.receiptReference, bytes: authority.receiptReference.bytes + 1 },
  }), /receipt reference mismatch/)
  await assert.rejects(validateRawSourceAuthority(authority, {
    importerVersion: 'incompatible-importer',
  }), /importer compatibility mismatch/)
  await assert.rejects(validateRawSourceAuthority(authority, {
    requiredCoverage: { start: '2025-01-01', end: '2026-07-09' },
  }), /coverage is incompatible/)

  const missing = new Map(objects)
  missing.delete(baseline.reference.key)
  await assert.rejects(validateRawSourceAuthority({
    ...authority,
    objectResolver: async (reference: RawObjectReference) => missing.get(reference.key),
  }), /object is missing/)

  const corrupt = new Map(objects)
  corrupt.set(baseline.reference.key, Buffer.from('corrupt'))
  await assert.rejects(validateRawSourceAuthority({
    ...authority,
    objectResolver: async (reference: RawObjectReference) => corrupt.get(reference.key),
  }), /compressed byte length|gzip is corrupt/)
})

test('evidence type remains a strict discriminated union at runtime', () => {
  const invalid = {
    artifactKind: 'ranking-source-authority-evidence',
    schemaVersion: 1,
    mode: 'stale-source-preservation',
  } satisfies Partial<RankingSourceAuthorityEvidence>
  assert.throws(() => parseRankingSourceAuthorityEvidence(invalid), /unexpected fields/)
})

test('raw authority proof is independent of Git metadata in an archive-shaped root', async () => {
  const archiveRoot = await mkdtemp(join(tmpdir(), 'ranking-authority-archive-'))
  const previousCwd = process.cwd()
  try {
    process.chdir(archiveRoot)
    const { authority } = authorityFixture()
    const validated = await validateRawSourceAuthority(authority, { importerVersion: IMPORTER_VERSION })
    assert.equal(validated.receipt.sourceReceiptDigest, authority.receipt.sourceReceiptDigest)
  } finally {
    process.chdir(previousCwd)
    await rm(archiveRoot, { recursive: true, force: true })
  }
})
