import { canonicalJsonFor } from './public-artifact-storage.mjs'
import {
  parseRawSourceReceipt,
  prepareRawObject,
  rawObjectReferenceFor,
  reconstructRawSourceReceipt,
} from './raw-source-storage.mjs'

export const RANKING_SOURCE_AUTHORITY_EVIDENCE_KIND = 'ranking-source-authority-evidence'
export const RANKING_SOURCE_AUTHORITY_EVIDENCE_MODES = [
  'fresh-ingestion',
  'stale-source-preservation',
  'forced-verified-raw-recovery',
]

export function prepareRankingSourceAuthorityEvidence({
  mode,
  runId,
  attemptedAt,
  providerResult,
  requestedCoverage,
  authority = null,
  outage = null,
  restoredBaseline = null,
  compatibility = null,
}) {
  const value = parseRankingSourceAuthorityEvidence({
    artifactKind: RANKING_SOURCE_AUTHORITY_EVIDENCE_KIND,
    schemaVersion: 1,
    mode,
    runId,
    attemptedAt,
    providerResult,
    requestedCoverage,
    authority,
    outage,
    restoredBaseline,
    compatibility,
  })
  const prepared = prepareRawObject(value)
  return {
    evidence: value,
    evidenceDigest: prepared.digest,
    bytes: prepared.bytes,
  }
}

export function parseRankingSourceAuthorityEvidence(value) {
  assertExactKeys(value, [
    'artifactKind',
    'schemaVersion',
    'mode',
    'runId',
    'attemptedAt',
    'providerResult',
    'requestedCoverage',
    'authority',
    'outage',
    'restoredBaseline',
    'compatibility',
  ], 'ranking source authority evidence')
  if (value.artifactKind !== RANKING_SOURCE_AUTHORITY_EVIDENCE_KIND || value.schemaVersion !== 1) {
    throw new Error('Unsupported ranking source authority evidence schema')
  }
  if (!RANKING_SOURCE_AUTHORITY_EVIDENCE_MODES.includes(value.mode)) {
    throw new Error('Invalid ranking source authority evidence mode')
  }
  assertNonEmptyString(value.runId, 'ranking source authority runId')
  assertIsoTimestamp(value.attemptedAt, 'ranking source authority attemptedAt')
  const providerResult = parseProviderResult(value.providerResult)
  const requestedCoverage = parseCoverage(value.requestedCoverage, 'requestedCoverage')
  const authority = value.authority === null ? null : parseAuthorityIdentity(value.authority)
  const outage = value.outage === null ? null : parseOutage(value.outage)
  const restoredBaseline = value.restoredBaseline === null ? null : parseRestoredBaseline(value.restoredBaseline)
  const compatibility = value.compatibility === null ? null : parseCompatibility(value.compatibility)

  if (value.mode === 'fresh-ingestion') {
    if (providerResult.status !== 'available' || outage !== null || restoredBaseline !== null) {
      throw new Error('Fresh-ingestion evidence must describe available provider data without recovery provenance')
    }
  } else if (value.mode === 'stale-source-preservation') {
    if (providerResult.status === 'available' || outage === null || restoredBaseline !== null) {
      throw new Error('Stale-source-preservation evidence must describe an outage without a restored baseline')
    }
  } else if (providerResult.status === 'available' || outage === null || authority === null || restoredBaseline === null || compatibility === null) {
    throw new Error('Forced verified-raw evidence requires outage, authority, restored baseline, and compatibility provenance')
  }

  return {
    artifactKind: value.artifactKind,
    schemaVersion: value.schemaVersion,
    mode: value.mode,
    runId: value.runId,
    attemptedAt: value.attemptedAt,
    providerResult,
    requestedCoverage,
    authority,
    outage,
    restoredBaseline,
    compatibility,
  }
}

export function rankingSourceAuthorityEvidenceDigest(value) {
  return prepareRawObject(parseRankingSourceAuthorityEvidence(value)).digest
}

export async function validateRawSourceAuthority(authority, {
  importerVersion,
  requiredCoverage,
} = {}) {
  if (!authority || authority.found !== true) throw new Error('Verified raw source authority is missing')
  const receipt = parseRawSourceReceipt(authority.receipt)
  const receiptReference = parseReceiptReference(authority.receiptReference)
  const preparedReceipt = prepareRawObject(receipt)
  if (preparedReceipt.digest !== receiptReference.sha256
    || preparedReceipt.bytes !== receiptReference.bytes
    || preparedReceipt.compressedBytes !== receiptReference.compressedBytes
    || rawObjectReferenceFor(preparedReceipt).key !== receiptReference.key) {
    throw new Error('Raw source authority receipt reference mismatch')
  }
  if (importerVersion !== undefined && receipt.importerVersion !== importerVersion) {
    throw new Error('Raw source authority importer compatibility mismatch')
  }
  if (requiredCoverage !== undefined) {
    const coverage = parseCoverage(requiredCoverage, 'requiredCoverage')
    if (receipt.coverage.start > coverage.start || receipt.coverage.end < coverage.end) {
      throw new Error('Raw source authority coverage is incompatible with the requested recovery window')
    }
  }
  if (typeof authority.objectResolver !== 'function') throw new Error('Raw source authority object resolver is missing')
  const reconstructed = await reconstructRawSourceReceipt(receipt, authority.objectResolver)
  return {
    receipt,
    receiptReference,
    reconstructed,
    identity: {
      generationId: receipt.generationId,
      importerVersion: receipt.importerVersion,
      coverage: receipt.coverage,
      sourceReceiptDigest: receipt.sourceReceiptDigest,
      rawIdentityDigest: receipt.rawIdentityDigest,
      receiptReference,
    },
  }
}

export function authorityIdentityFor(validated) {
  return parseAuthorityIdentity(validated.identity)
}

function parseAuthorityIdentity(value) {
  assertExactKeys(value, [
    'generationId',
    'importerVersion',
    'coverage',
    'sourceReceiptDigest',
    'rawIdentityDigest',
    'receiptReference',
  ], 'ranking source authority identity')
  assertNonEmptyString(value.generationId, 'authority generationId')
  assertNonEmptyString(value.importerVersion, 'authority importerVersion')
  const coverage = parseCoverage(value.coverage, 'authority coverage')
  assertDigest(value.sourceReceiptDigest, 'authority sourceReceiptDigest')
  assertDigest(value.rawIdentityDigest, 'authority rawIdentityDigest')
  return {
    generationId: value.generationId,
    importerVersion: value.importerVersion,
    coverage,
    sourceReceiptDigest: value.sourceReceiptDigest,
    rawIdentityDigest: value.rawIdentityDigest,
    receiptReference: parseReceiptReference(value.receiptReference),
  }
}

function parseReceiptReference(value) {
  assertExactKeys(value, ['key', 'sha256', 'bytes', 'compressedBytes', 'storageEncoding'], 'raw receipt reference')
  if (typeof value.key !== 'string' || value.key !== `raw/objects/sha256/${value.sha256}`) throw new Error('Raw receipt reference key is invalid')
  assertDigest(value.sha256, 'raw receipt reference sha256')
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0) throw new Error('Raw receipt reference bytes are invalid')
  if (!Number.isSafeInteger(value.compressedBytes) || value.compressedBytes <= 0) throw new Error('Raw receipt reference compressedBytes are invalid')
  if (value.storageEncoding !== 'gzip') throw new Error('Raw receipt reference encoding is invalid')
  return { ...value }
}

function parseProviderResult(value) {
  assertExactKeys(value, ['status', 'sources', 'warnings'], 'provider result')
  if (!['available', 'unavailable', 'no-data'].includes(value.status)) throw new Error('Provider result status is invalid')
  assertRecord(value.sources, 'provider result sources')
  if (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== 'string')) {
    throw new Error('Provider result warnings are invalid')
  }
  return { status: value.status, sources: value.sources, warnings: [...value.warnings] }
}

function parseOutage(value) {
  assertExactKeys(value, ['reason', 'attemptedCoverage', 'providerResult'], 'source outage')
  assertNonEmptyString(value.reason, 'source outage reason')
  return {
    reason: value.reason,
    attemptedCoverage: parseCoverage(value.attemptedCoverage, 'source outage attemptedCoverage'),
    providerResult: parseProviderResult(value.providerResult),
  }
}

function parseRestoredBaseline(value) {
  assertExactKeys(value, ['generationId', 'sourceReceiptDigest', 'rawIdentityDigest', 'coverage'], 'restored baseline')
  assertNonEmptyString(value.generationId, 'restored baseline generationId')
  assertDigest(value.sourceReceiptDigest, 'restored baseline sourceReceiptDigest')
  assertDigest(value.rawIdentityDigest, 'restored baseline rawIdentityDigest')
  return { ...value, coverage: parseCoverage(value.coverage, 'restored baseline coverage') }
}

function parseCompatibility(value) {
  assertExactKeys(value, ['importerVersion', 'receiptSchemaVersion', 'storageMode'], 'source authority compatibility')
  assertNonEmptyString(value.importerVersion, 'compatibility importerVersion')
  if (value.receiptSchemaVersion !== 1) throw new Error('Source authority receipt schema is incompatible')
  assertNonEmptyString(value.storageMode, 'compatibility storageMode')
  return { ...value }
}

function parseCoverage(value, label) {
  assertExactKeys(value, ['start', 'end'], label)
  if (!isIsoDate(value.start) || !isIsoDate(value.end) || value.start > value.end) throw new Error(`${label} is invalid`)
  return { start: value.start, end: value.end }
}

function assertExactKeys(value, keys, label) {
  assertRecord(value, label)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (canonicalJsonFor(actual) !== canonicalJsonFor(expected)) throw new Error(`${label} has unexpected fields`)
}

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`)
}

function assertIsoTimestamp(value, label) {
  assertNonEmptyString(value, label)
  if (new Date(value).toISOString() !== value) throw new Error(`${label} must be an ISO timestamp`)
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}
