import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, gunzipSync, gzipSync } from 'node:zlib'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { canonicalJsonFor } from './public-artifact-storage.mjs'

export const INCREMENTAL_STATE_STORAGE_MODE = 'content-addressed-state-gzip-v1'
export const INCREMENTAL_STATE_MANIFEST_KIND = 'incremental-state-generation-manifest'
export const INCREMENTAL_STATE_CHECKPOINT_KIND = 'incremental-state-checkpoint-bundle'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const CAUSAL_SUMMARY_KEYS = ['sourcedPlayer', 'dssTeam', 'dssRegion', 'rosterEra', 'playerResume']

export function prepareContentAddressedState({
  generationId,
  runId = generationId,
  baseGenerationId = null,
  baseRunId = null,
  canonicalLedgerReference,
  sourceReceiptDigest,
  compatibility,
  checkpoints,
}) {
  assertSafeId(generationId, 'generationId')
  assertSafeId(runId, 'runId')
  assertOptionalSafeId(baseGenerationId, 'baseGenerationId')
  assertOptionalSafeId(baseRunId, 'baseRunId')
  assertDigest(sourceReceiptDigest, 'sourceReceiptDigest')
  const ledger = parseObjectReference(canonicalLedgerReference, 'canonicalLedgerReference')
  const parsedCompatibility = parseCompatibility(compatibility, 'compatibility')
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    throw new Error('Invalid incremental state: checkpoints must be a non-empty array')
  }

  const objects = []
  const candidates = checkpoints.map((checkpoint, index) => {
    assertRecord(checkpoint, `checkpoints[${index}]`)
    const boundary = parseBoundary(checkpoint.boundary, `checkpoints[${index}].boundary`)
    const rawPrefix = parseRawPrefix(checkpoint.rawPrefix, `checkpoints[${index}].rawPrefix`)
    const storedObject = checkpoint.storedObjectReference
      ? parseObjectReference(checkpoint.storedObjectReference, `checkpoints[${index}].storedObjectReference`)
      : undefined
    if (!storedObject) {
      assertRecord(checkpoint.ratingCheckpoint, `checkpoints[${index}].ratingCheckpoint`)
      assertExactKeys(checkpoint.causalSummaries, CAUSAL_SUMMARY_KEYS, `checkpoints[${index}].causalSummaries`)
      for (const key of CAUSAL_SUMMARY_KEYS) {
        assertRecord(checkpoint.causalSummaries[key], `checkpoints[${index}].causalSummaries.${key}`)
      }
    }
    const checkpointCompatibility = parseCompatibility(
      checkpoint.compatibility ?? parsedCompatibility,
      `checkpoints[${index}].compatibility`,
    )
    if (canonicalJsonFor(checkpointCompatibility) !== canonicalJsonFor(parsedCompatibility)) {
      throw new Error(`Invalid incremental state: checkpoints[${index}] compatibility differs from manifest compatibility`)
    }
    const bundle = storedObject ? undefined : {
      artifactKind: INCREMENTAL_STATE_CHECKPOINT_KIND,
      schemaVersion: 1,
      boundary,
      rawPrefix,
      compatibility: checkpointCompatibility,
      ratingCheckpoint: checkpoint.ratingCheckpoint,
      causalSummaries: checkpoint.causalSummaries,
    }
    const prepared = storedObject ? undefined : prepareStateObject(bundle)
    if (prepared) objects.push(prepared)
    return {
      boundary,
      rawPrefix,
      object: storedObject ?? stateObjectReference(prepared),
    }
  })
  assertOrderedUniqueCandidates(candidates)

  const manifest = {
    artifactKind: INCREMENTAL_STATE_MANIFEST_KIND,
    schemaVersion: 1,
    storageMode: INCREMENTAL_STATE_STORAGE_MODE,
    generationId,
    runId,
    baseGenerationId,
    baseRunId,
    canonicalLedger: ledger,
    sourceReceiptDigest,
    compatibility: parsedCompatibility,
    checkpoints: candidates,
  }
  const manifestPrepared = prepareStateObject(manifest)
  return {
    manifest,
    manifestPrepared,
    objects: uniquePreparedObjects(objects),
  }
}

export function prepareStateObject(value) {
  assertRecord(value, 'state object')
  const canonicalJson = canonicalJsonFor(value)
  const canonicalBytes = Buffer.from(canonicalJson, 'utf8')
  const digest = createHash('sha256').update(canonicalBytes).digest('hex')
  const compressed = gzipSync(canonicalBytes, { level: 9, mtime: 0 })
  return {
    value,
    canonicalJson,
    canonicalBytes,
    digest,
    bytes: canonicalBytes.byteLength,
    compressed,
    compressedBytes: compressed.byteLength,
  }
}

export async function syncContentAddressedStateObject(client, config, prepared) {
  assertPreparedObject(prepared)
  const key = stateBucketKey(config, `state/objects/sha256/${prepared.digest}`)
  try {
    const remote = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))
    assertStateObjectMetadata(remote, prepared, key)
    await assertRemoteStateObjectBytes(client, config, key, prepared)
    return stateSyncResult('unchanged', key, prepared, 'content-addressed-state-object-reused')
  } catch (error) {
    if (!isMissingObjectError(error)) throw error
  }

  try {
    const result = await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: prepared.compressed,
      ContentLength: prepared.compressedBytes,
      ContentType: 'application/json; charset=utf-8',
      ContentEncoding: 'gzip',
      Metadata: stateObjectMetadata(prepared),
      IfNoneMatch: '*',
    }))
    return { ...stateSyncResult('uploaded', key, prepared), etag: result.ETag }
  } catch (error) {
    if (!isPreconditionError(error)) throw error
    const remote = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))
    assertStateObjectMetadata(remote, prepared, key)
    await assertRemoteStateObjectBytes(client, config, key, prepared)
    return stateSyncResult('unchanged', key, prepared, 'content-addressed-state-object-race-reused')
  }
}

export async function writeIncrementalStateManifest(client, config, preparedState, { verifyObjects = true } = {}) {
  assertRecord(preparedState, 'prepared state')
  const manifest = parseIncrementalStateManifest(preparedState.manifest)
  const prepared = preparedState.manifestPrepared ?? prepareStateObject(manifest)
  assertPreparedObject(prepared)
  if (canonicalJsonFor(manifest) !== prepared.canonicalJson) {
    throw new Error('Invalid incremental state: prepared manifest bytes do not match manifest')
  }
  if (verifyObjects) {
    await readStoredJsonStateObject(client, config, manifest.canonicalLedger)
    for (const candidate of manifest.checkpoints) await assertStoredStateObject(client, config, candidate)
  }
  const relativeKey = `state/generations/${safeStatePath(manifest.generationId)}.json`
  const key = stateBucketKey(config, relativeKey)
  const body = prepared.canonicalBytes
  try {
    const result = await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentLength: prepared.bytes,
      ContentType: 'application/json; charset=utf-8',
      Metadata: { sha256: prepared.digest, 'semantic-bytes': String(prepared.bytes) },
      IfNoneMatch: '*',
    }))
    return {
      result: manifestSyncResult('uploaded', key, prepared),
      authority: { key, etag: result.ETag, bytes: prepared.bytes, digest: prepared.digest, manifest },
    }
  } catch (error) {
    if (!isPreconditionError(error)) throw error
    const existing = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
    const existingBytes = await bodyBytes(existing.Body)
    if (!existingBytes.equals(body)
      || existing.Metadata?.sha256 !== prepared.digest
      || existing.Metadata?.['semantic-bytes'] !== String(prepared.bytes)
      || existing.ContentType !== 'application/json; charset=utf-8'
      || Number(existing.ContentLength) !== prepared.bytes) {
      throw new Error(`Incremental state manifest collision for generationId ${manifest.generationId}`, { cause: error })
    }
    return {
      result: manifestSyncResult('unchanged', key, prepared, 'identical-state-manifest-reused'),
      authority: { key, etag: existing.ETag, bytes: prepared.bytes, digest: prepared.digest, manifest },
    }
  }
}

export async function assertStateManifestAuthority(client, config, authority, { verifyObjects = true } = {}) {
  assertRecord(authority, 'state manifest authority')
  assertSafeStateKey(config, authority.key, 'state manifest authority key')
  assertString(authority.etag, 'state manifest authority ETag')
  assertDigest(authority.digest, 'state manifest authority digest')
  if (!Number.isSafeInteger(authority.bytes) || authority.bytes <= 0) {
    throw new Error('Invalid incremental state: state manifest authority bytes must be a positive integer')
  }
  const remote = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: authority.key }))
  const bytes = await bodyBytes(remote.Body)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const matches = remote.ETag === authority.etag
    && Number(remote.ContentLength) === authority.bytes
    && bytes.byteLength === authority.bytes
    && remote.ContentType === 'application/json; charset=utf-8'
    && remote.Metadata?.sha256 === authority.digest
    && remote.Metadata?.['semantic-bytes'] === String(authority.bytes)
    && digest === authority.digest
  if (!matches) throw new Error('Incremental state manifest changed before active pointer promotion')
  let parsed
  try {
    parsed = parseIncrementalStateManifest(JSON.parse(bytes.toString('utf8')))
  } catch (error) {
    throw new Error('Incremental state manifest is corrupt or invalid', { cause: error })
  }
  if (canonicalJsonFor(parsed) !== bytes.toString('utf8')) {
    throw new Error('Incremental state manifest is not canonical JSON')
  }
  const expectedKey = stateBucketKey(config, `state/generations/${safeStatePath(parsed.generationId)}.json`)
  if (authority.key !== expectedKey) throw new Error('Incremental state manifest authority key does not match generationId')
  if (authority.manifest && canonicalJsonFor(parseIncrementalStateManifest(authority.manifest)) !== canonicalJsonFor(parsed)) {
    throw new Error('Incremental state manifest authority does not match stored manifest')
  }
  if (verifyObjects) {
    await assertStoredStateObjectIntegrity(client, config, parsed.canonicalLedger)
    for (const candidate of parsed.checkpoints) {
      await assertStoredStateObjectIntegrity(client, config, candidate.object)
    }
  }
  return { manifest: parsed, key: authority.key, etag: remote.ETag, bytes: bytes.byteLength, digest }
}

export async function readActiveIncrementalState({ config, client, verifyObjects = true, checkpointLimit } = {}) {
  const activeKey = stateBucketKey(config, 'active-generation.json')
  let activeObject
  try {
    activeObject = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: activeKey }))
  } catch (error) {
    if (isMissingObjectError(error)) return { found: false, reason: 'active-generation-missing' }
    throw error
  }
  let active
  try {
    active = JSON.parse((await bodyBytes(activeObject.Body)).toString('utf8'))
  } catch (error) {
    throw new Error('Active generation pointer is corrupt', { cause: error })
  }
  assertRecord(active, 'active generation pointer')
  if (active.stateManifestKey === undefined && active.stateManifestDigest === undefined) {
    return { found: false, reason: 'legacy-active-generation', active, etag: activeObject.ETag }
  }
  assertSafeStateKey(config, active.stateManifestKey, 'active stateManifestKey')
  assertDigest(active.stateManifestDigest, 'active stateManifestDigest')
  const manifestObject = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: active.stateManifestKey }))
  const manifestBytes = await bodyBytes(manifestObject.Body)
  const digest = createHash('sha256').update(manifestBytes).digest('hex')
  if (digest !== active.stateManifestDigest
    || Number(manifestObject.ContentLength) !== manifestBytes.byteLength
    || manifestObject.ContentType !== 'application/json; charset=utf-8'
    || manifestObject.Metadata?.sha256 !== digest
    || manifestObject.Metadata?.['semantic-bytes'] !== String(manifestBytes.byteLength)) {
    throw new Error('Active incremental state manifest digest mismatch')
  }
  const manifest = parseIncrementalStateManifest(JSON.parse(manifestBytes.toString('utf8')))
  if (canonicalJsonFor(manifest) !== manifestBytes.toString('utf8')) {
    throw new Error('Active incremental state manifest is not canonical JSON')
  }
  if (manifest.generationId !== active.generationId) {
    throw new Error('Active incremental state generation does not match active public generation')
  }
  const expectedKey = stateBucketKey(config, `state/generations/${safeStatePath(manifest.generationId)}.json`)
  if (expectedKey !== active.stateManifestKey) throw new Error('Active incremental state manifest key is not canonical')
  const loadCheckpoints = async (candidates = manifest.checkpoints) => {
    const loaded = []
    for (const candidate of candidates) {
      const bundle = await readStoredStateObject(client, config, candidate)
      assertMatchingCompatibility(bundle.compatibility, manifest.compatibility)
      loaded.push({ candidate, bundle })
    }
    return loaded
  }
  let checkpoints = []
  const canonicalLedger = await readStoredJsonStateObject(client, config, manifest.canonicalLedger)
  if (verifyObjects) {
    const candidates = Number.isSafeInteger(checkpointLimit) && checkpointLimit > 0
      ? manifest.checkpoints.slice(-checkpointLimit)
      : manifest.checkpoints
    checkpoints = await loadCheckpoints(candidates)
  }
  return { found: true, active, etag: activeObject.ETag, manifest, canonicalLedger, checkpoints, loadCheckpoints }
}

export async function readStoredJsonStateObject(client, config, reference) {
  const parsedReference = parseObjectReference(reference, 'state object reference')
  const expectedReferenceKey = `state/objects/sha256/${parsedReference.sha256}`
  if (parsedReference.key !== expectedReferenceKey) throw new Error('Incremental state object key is not canonical')
  const expectedKey = stateBucketKey(config, expectedReferenceKey)
  const remote = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: expectedKey }))
  const compressed = await bodyBytes(remote.Body)
  if (Number(remote.ContentLength) !== parsedReference.compressedBytes
    || compressed.byteLength !== parsedReference.compressedBytes
    || remote.ContentType !== 'application/json; charset=utf-8'
    || remote.ContentEncoding !== 'gzip'
    || remote.Metadata?.sha256 !== parsedReference.sha256
    || remote.Metadata?.['semantic-bytes'] !== String(parsedReference.bytes)
    || remote.Metadata?.encoding !== 'gzip') {
    throw new Error(`Incremental state object metadata mismatch: ${expectedKey}`)
  }
  let canonicalBytes
  try {
    canonicalBytes = gunzipSync(compressed)
  } catch (error) {
    throw new Error(`Incremental state object gzip is corrupt: ${expectedKey}`, { cause: error })
  }
  const digest = createHash('sha256').update(canonicalBytes).digest('hex')
  if (canonicalBytes.byteLength !== parsedReference.bytes || digest !== parsedReference.sha256) {
    throw new Error(`Incremental state object semantic digest mismatch: ${expectedKey}`)
  }
  try {
    const value = JSON.parse(canonicalBytes.toString('utf8'))
    if (canonicalJsonFor(value) !== canonicalBytes.toString('utf8')) {
      throw new Error(`Incremental state object is not canonical JSON: ${expectedKey}`)
    }
    return value
  } catch (error) {
    throw new Error(`Incremental state object JSON is corrupt: ${expectedKey}`, { cause: error })
  }
}

async function assertStoredStateObjectIntegrity(client, config, reference) {
  const parsedReference = parseObjectReference(reference, 'state object reference')
  const expectedReferenceKey = `state/objects/sha256/${parsedReference.sha256}`
  if (parsedReference.key !== expectedReferenceKey) throw new Error('Incremental state object key is not canonical')
  const expectedKey = stateBucketKey(config, parsedReference.key)
  let remote
  try {
    remote = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: expectedKey }))
  } catch (error) {
    if (isMissingObjectError(error)) throw new Error(`Incremental state object is missing: ${expectedKey}`, { cause: error })
    throw error
  }
  if (Number(remote.ContentLength) !== parsedReference.compressedBytes
    || remote.ContentEncoding !== 'gzip' || remote.Metadata?.sha256 !== parsedReference.sha256
    || remote.Metadata?.['semantic-bytes'] !== String(parsedReference.bytes) || remote.Metadata?.encoding !== 'gzip') {
    throw new Error(`Incremental state object metadata mismatch: ${expectedKey}`)
  }
  let compressedBytes = 0
  let semanticBytes = 0
  const digest = createHash('sha256')
  const countCompressed = new Transform({
    transform(chunk, _encoding, callback) {
      compressedBytes += chunk.length
      callback(null, chunk)
    },
  })
  const hashSemantic = new Transform({
    transform(chunk, _encoding, callback) {
      semanticBytes += chunk.length
      digest.update(chunk)
      callback()
    },
  })
  try {
    await pipeline(remote.Body, countCompressed, createGunzip(), hashSemantic)
  } catch (error) {
    throw new Error(`Incremental state object gzip is corrupt: ${expectedKey}`, { cause: error })
  }
  if (compressedBytes !== parsedReference.compressedBytes
    || semanticBytes !== parsedReference.bytes || digest.digest('hex') !== parsedReference.sha256) {
    throw new Error(`Incremental state object semantic digest mismatch: ${expectedKey}`)
  }
}

export function stateObjectReferenceFor(prepared) {
  assertPreparedObject(prepared)
  return stateObjectReference(prepared)
}

export function parseIncrementalStateManifest(value) {
  assertExactKeys(value, [
    'artifactKind', 'schemaVersion', 'storageMode', 'generationId', 'runId', 'baseGenerationId',
    'baseRunId', 'canonicalLedger', 'sourceReceiptDigest', 'compatibility', 'checkpoints',
  ], 'state manifest')
  if (value.artifactKind !== INCREMENTAL_STATE_MANIFEST_KIND || value.schemaVersion !== 1
    || value.storageMode !== INCREMENTAL_STATE_STORAGE_MODE) {
    throw new Error('Invalid incremental state: unsupported state manifest schema')
  }
  assertSafeId(value.generationId, 'state manifest generationId')
  assertSafeId(value.runId, 'state manifest runId')
  assertOptionalSafeId(value.baseGenerationId, 'state manifest baseGenerationId')
  assertOptionalSafeId(value.baseRunId, 'state manifest baseRunId')
  const canonicalLedger = parseObjectReference(value.canonicalLedger, 'state manifest canonicalLedger')
  assertDigest(value.sourceReceiptDigest, 'state manifest sourceReceiptDigest')
  const compatibility = parseCompatibility(value.compatibility, 'state manifest compatibility')
  if (!Array.isArray(value.checkpoints) || value.checkpoints.length === 0) {
    throw new Error('Invalid incremental state: state manifest checkpoints must be a non-empty array')
  }
  const checkpoints = value.checkpoints.map((candidate, index) => {
    assertExactKeys(candidate, ['boundary', 'rawPrefix', 'object'], `state manifest checkpoints[${index}]`)
    return {
      boundary: parseBoundary(candidate.boundary, `state manifest checkpoints[${index}].boundary`),
      rawPrefix: parseRawPrefix(candidate.rawPrefix, `state manifest checkpoints[${index}].rawPrefix`),
      object: parseObjectReference(candidate.object, `state manifest checkpoints[${index}].object`),
    }
  })
  assertOrderedUniqueCandidates(checkpoints)
  return {
    artifactKind: value.artifactKind,
    schemaVersion: value.schemaVersion,
    storageMode: value.storageMode,
    generationId: value.generationId,
    runId: value.runId,
    baseGenerationId: value.baseGenerationId,
    baseRunId: value.baseRunId,
    canonicalLedger,
    sourceReceiptDigest: value.sourceReceiptDigest,
    compatibility,
    checkpoints,
  }
}

function parseCheckpointBundle(value, reference) {
  assertExactKeys(value, [
    'artifactKind', 'schemaVersion', 'boundary', 'rawPrefix', 'compatibility',
    'ratingCheckpoint', 'causalSummaries',
  ], 'checkpoint bundle')
  if (value.artifactKind !== INCREMENTAL_STATE_CHECKPOINT_KIND || value.schemaVersion !== 1) {
    throw new Error('Invalid incremental state: unsupported checkpoint bundle schema')
  }
  const boundary = parseBoundary(value.boundary, 'checkpoint bundle boundary')
  const rawPrefix = parseRawPrefix(value.rawPrefix, 'checkpoint bundle rawPrefix')
  const compatibility = parseCompatibility(value.compatibility, 'checkpoint bundle compatibility')
  assertRecord(value.ratingCheckpoint, 'checkpoint bundle ratingCheckpoint')
  assertExactKeys(value.causalSummaries, CAUSAL_SUMMARY_KEYS, 'checkpoint bundle causalSummaries')
  for (const key of CAUSAL_SUMMARY_KEYS) assertRecord(value.causalSummaries[key], `checkpoint bundle causalSummaries.${key}`)
  if (reference && canonicalJsonFor(boundary) !== canonicalJsonFor(reference.boundary)) {
    throw new Error('Incremental state checkpoint boundary differs from manifest')
  }
  if (reference && canonicalJsonFor(rawPrefix) !== canonicalJsonFor(reference.rawPrefix)) {
    throw new Error('Incremental state checkpoint raw prefix differs from manifest')
  }
  return {
    artifactKind: value.artifactKind,
    schemaVersion: value.schemaVersion,
    boundary,
    rawPrefix,
    compatibility,
    ratingCheckpoint: value.ratingCheckpoint,
    causalSummaries: value.causalSummaries,
  }
}

async function assertStoredStateObject(client, config, candidate) {
  await readStoredStateObject(client, config, candidate)
}

async function readStoredStateObject(client, config, candidate) {
  const value = await readStoredJsonStateObject(client, config, candidate.object)
  const bundle = parseCheckpointBundle(value, candidate)
  return bundle
}

async function assertRemoteStateObjectBytes(client, config, key, prepared) {
  const remote = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
  const compressed = await bodyBytes(remote.Body)
  if (!compressed.equals(prepared.compressed)) {
    throw new Error(`Content-addressed state object collision or byte mismatch: ${key}`)
  }
}

function parseCompatibility(value, label) {
  assertExactKeys(value, [
    'modelVersion', 'modelConfigHash', 'importerVersion', 'taxonomyVersion',
    'ratingCheckpointSchemaVersion', 'causalPrefixSchemaVersion', 'publicArtifactSchemaVersion',
  ], label)
  for (const key of ['modelVersion', 'modelConfigHash', 'importerVersion', 'taxonomyVersion']) {
    assertString(value[key], `${label}.${key}`)
  }
  for (const key of ['ratingCheckpointSchemaVersion', 'causalPrefixSchemaVersion', 'publicArtifactSchemaVersion']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) {
      throw new Error(`Invalid incremental state: ${label}.${key} must be a positive integer`)
    }
  }
  return { ...value }
}

function parseBoundary(value, label) {
  assertExactKeys(value, ['date', 'matchId'], label)
  if (typeof value.date !== 'string' || !ISO_DATE_PATTERN.test(value.date)
    || Number.isNaN(Date.parse(`${value.date}T00:00:00.000Z`))
    || new Date(`${value.date}T00:00:00.000Z`).toISOString().slice(0, 10) !== value.date) {
    throw new Error(`Invalid incremental state: ${label}.date must be an exact UTC calendar date`)
  }
  assertString(value.matchId, `${label}.matchId`)
  return { date: value.date, matchId: value.matchId }
}

function parseRawPrefix(value, label) {
  assertExactKeys(value, ['matchCount', 'digest'], label)
  if (!Number.isSafeInteger(value.matchCount) || value.matchCount < 0) {
    throw new Error(`Invalid incremental state: ${label}.matchCount must be a non-negative integer`)
  }
  assertDigest(value.digest, `${label}.digest`)
  return { matchCount: value.matchCount, digest: value.digest }
}

function parseObjectReference(value, label) {
  assertExactKeys(value, ['key', 'sha256', 'bytes', 'compressedBytes', 'storageEncoding'], label)
  assertString(value.key, `${label}.key`)
  if (value.key.startsWith('/') || value.key.includes('\\') || value.key.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid incremental state: ${label}.key is unsafe`)
  }
  assertDigest(value.sha256, `${label}.sha256`)
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0
    || !Number.isSafeInteger(value.compressedBytes) || value.compressedBytes <= 0) {
    throw new Error(`Invalid incremental state: ${label} byte sizes must be positive integers`)
  }
  if (value.storageEncoding !== 'gzip') throw new Error(`Invalid incremental state: ${label}.storageEncoding must be gzip`)
  return { ...value }
}

function assertOrderedUniqueCandidates(candidates) {
  let previous
  const seen = new Set()
  for (const candidate of candidates) {
    const identity = canonicalJsonFor(candidate.boundary)
    if (seen.has(identity)) throw new Error(`Invalid incremental state: duplicate checkpoint boundary ${candidate.boundary.date}/${candidate.boundary.matchId}`)
    if (previous && compareBoundaries(candidate.boundary, previous) <= 0) {
      throw new Error('Invalid incremental state: checkpoint candidates must be ordered by date then match ID')
    }
    seen.add(identity)
    previous = candidate.boundary
  }
}

function compareBoundaries(left, right) {
  if (left.date !== right.date) return left.date < right.date ? -1 : 1
  if (left.matchId === right.matchId) return 0
  return left.matchId < right.matchId ? -1 : 1
}

function assertMatchingCompatibility(actual, expected) {
  if (canonicalJsonFor(actual) !== canonicalJsonFor(expected)) {
    throw new Error('Incremental state checkpoint compatibility differs from state manifest')
  }
}

function stateObjectReference(prepared) {
  return {
    key: `state/objects/sha256/${prepared.digest}`,
    sha256: prepared.digest,
    bytes: prepared.bytes,
    compressedBytes: prepared.compressedBytes,
    storageEncoding: 'gzip',
  }
}

function uniquePreparedObjects(objects) {
  const unique = new Map()
  for (const prepared of objects) {
    const existing = unique.get(prepared.digest)
    if (existing && existing.canonicalJson !== prepared.canonicalJson) {
      throw new Error(`Local incremental state SHA-256 collision: ${prepared.digest}`)
    }
    unique.set(prepared.digest, existing ?? prepared)
  }
  return [...unique.values()]
}

function assertPreparedObject(value) {
  assertRecord(value, 'prepared state object')
  assertDigest(value.digest, 'prepared state object digest')
  if (!Buffer.isBuffer(value.canonicalBytes) || !Buffer.isBuffer(value.compressed)) {
    throw new Error('Invalid incremental state: prepared object bytes are missing')
  }
  const digest = createHash('sha256').update(value.canonicalBytes).digest('hex')
  if (digest !== value.digest || value.canonicalBytes.toString('utf8') !== value.canonicalJson
    || value.bytes !== value.canonicalBytes.byteLength || value.compressedBytes !== value.compressed.byteLength) {
    throw new Error('Invalid incremental state: prepared object integrity check failed')
  }
}

function stateObjectMetadata(prepared) {
  return { sha256: prepared.digest, 'semantic-bytes': String(prepared.bytes), encoding: 'gzip' }
}

function assertStateObjectMetadata(remote, prepared, key) {
  if (Number(remote.ContentLength) !== prepared.compressedBytes
    || remote.ContentType !== 'application/json; charset=utf-8'
    || remote.ContentEncoding !== 'gzip'
    || remote.Metadata?.sha256 !== prepared.digest
    || remote.Metadata?.['semantic-bytes'] !== String(prepared.bytes)
    || remote.Metadata?.encoding !== 'gzip') {
    throw new Error(`Content-addressed state object collision or metadata mismatch: ${key}`)
  }
}

function stateSyncResult(status, key, prepared, reason) {
  return {
    status,
    ...(reason ? { reason } : {}),
    key,
    bytes: prepared.compressedBytes,
    semanticBytes: prepared.bytes,
    contentType: 'application/json; charset=utf-8',
    contentEncoding: 'gzip',
    digest: prepared.digest,
  }
}

function manifestSyncResult(status, key, prepared, reason) {
  return {
    status,
    ...(reason ? { reason } : {}),
    key,
    bytes: prepared.bytes,
    contentType: 'application/json; charset=utf-8',
    digest: prepared.digest,
  }
}

function assertSafeStateKey(config, key, label) {
  assertString(key, label)
  const prefix = `${stateBucketKey(config, 'state')}/`
  if (!key.startsWith(prefix) || key.includes('\\') || key.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error(`Invalid incremental state: ${label} is outside the state prefix`)
  }
}

function stateBucketKey(config, relativeKey) {
  const prefix = normalizePrefix(config?.prefix ?? 'rankings')
  const safe = safeStatePath(relativeKey)
  return prefix ? `${prefix}/${safe}` : safe
}

function normalizePrefix(value) {
  return String(value ?? '').replace(/^\/+|\/+$/g, '')
}

function safeStatePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.includes('\\')) {
    throw new Error('Invalid incremental state object path')
  }
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid incremental state object path')
  return parts.join('/')
}

function assertSafeId(value, label) {
  assertString(value, label)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === '.' || value === '..') {
    throw new Error(`Invalid incremental state: ${label} is unsafe`)
  }
}

function assertOptionalSafeId(value, label) {
  if (value !== null) assertSafeId(value, label)
}

function assertExactKeys(value, allowedKeys, label) {
  assertRecord(value, label)
  const allowed = new Set(allowedKeys)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  const missing = allowedKeys.filter((key) => !Object.hasOwn(value, key))
  if (unknown.length || missing.length) {
    throw new Error(`Invalid incremental state: ${label} keys differ (missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'})`)
  }
}

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid incremental state: ${label} must be an object`)
  }
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid incremental state: ${label} must be a non-empty string`)
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`Invalid incremental state: ${label} must be a lowercase SHA-256 digest`)
  }
}

function isMissingObjectError(error) {
  return error?.name === 'NoSuchKey' || error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404
}

function isPreconditionError(error) {
  return error?.name === 'PreconditionFailed' || error?.$metadata?.httpStatusCode === 412
}

async function bodyBytes(body) {
  if (typeof body?.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray())
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body)
  const chunks = []
  for await (const chunk of body ?? []) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
