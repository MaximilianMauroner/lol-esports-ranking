import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { canonicalJsonFor } from './public-artifact-storage.mjs'
import { assertStateManifestAuthority, readStoredJsonStateObject } from './incremental-state-storage.mjs'
import { decodeRawObject, parseRawSourceReceipt } from './raw-source-storage.mjs'
import { assertBucketLease, bucketKey, readBucketJson } from './railway-bucket.mjs'

const AUDIT_KIND = 'full-ranking-audit-receipt'
const JSON_TYPE = 'application/json; charset=utf-8'
const IMMUTABLE = 'public, max-age=31536000, immutable'

export function isFullAuditEligible(input = {}) {
  const cause = input.cause ?? input.refreshCause
  const result = input.result ?? input.incrementalBuild?.action
  const promotion = input.promotion ?? input.bucketPublish?.promotion
  const stateAuthority = input.stateManifestAuthority ?? input.incrementalState?.authority
  const rawAuthority = input.rawReceiptAuthority ?? input.rawSourceGeneration
  return (cause === 'daily-audit' || cause === 'manual-force')
    && result === 'publish-full'
    && typeof (input.fullSnapshotPath ?? input.snapshotPath) === 'string'
    && Boolean(input.fullSnapshotDescriptor)
    && typeof (input.generationId ?? promotion?.generationId) === 'string'
    && Number.isSafeInteger(input.fencingToken ?? promotion?.fencingToken)
    && promotion?.completed === true
    && typeof promotion.etag === 'string' && promotion.etag.length > 0
    && Boolean(stateAuthority?.key && stateAuthority?.digest)
    && Boolean((rawAuthority?.reference ?? rawAuthority?.receiptReference)?.key && rawAuthority?.receipt)
}

export async function stageFullAuditSnapshot({
  fullSnapshotPath,
  snapshotPath = fullSnapshotPath,
  snapshotDescriptor,
  publicManifest,
  config,
  client,
} = {}) {
  if (!client || !config?.bucket || typeof snapshotPath !== 'string' || snapshotPath.length === 0) {
    throw new Error('Full audit snapshot staging requires a bucket client, config, and snapshot path')
  }
  const descriptor = parseFullSnapshotDescriptor(snapshotDescriptor)
  if (publicManifest) assertFullSnapshotMatchesPublic(descriptor, publicManifest)
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ranking-full-audit-'))
  const compressedPath = join(temporaryDirectory, 'snapshot.json.gz')
  const digest = createHash('sha256')
  let bytes = 0
  let compressedBytes = 0
  const hashInput = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      digest.update(chunk)
      callback(null, chunk)
    },
  })
  const countOutput = new Transform({
    transform(chunk, _encoding, callback) {
      compressedBytes += chunk.length
      callback(null, chunk)
    },
  })
  try {
    await pipeline(
      createReadStream(snapshotPath),
      hashInput,
      createGzip({ level: 9, mtime: 0 }),
      countOutput,
      createWriteStream(compressedPath, { flags: 'wx', mode: 0o600 }),
    )
    if ((await stat(compressedPath)).size !== compressedBytes || bytes <= 0 || compressedBytes <= 0) {
      throw new Error('Full audit snapshot preparation produced invalid byte counts')
    }
    const sha256 = digest.digest('hex')
    if (sha256 !== descriptor.sha256 || bytes !== descriptor.bytes) {
      throw new Error('Full audit snapshot bytes do not match the trusted build descriptor')
    }
    const reference = {
      key: `audits/objects/sha256/${sha256}`,
      sha256,
      bytes,
      compressedBytes,
      storageEncoding: 'gzip',
    }
    const key = bucketKey(config, reference.key)
    let status = 'uploaded'
    try {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: createReadStream(compressedPath),
        ContentLength: compressedBytes,
        ContentType: JSON_TYPE,
        ContentEncoding: 'gzip',
        CacheControl: IMMUTABLE,
        Metadata: { sha256, 'semantic-bytes': String(bytes), encoding: 'gzip' },
        IfNoneMatch: '*',
      }))
    } catch (error) {
      if (!isPreconditionError(error)) throw error
      status = 'unchanged'
    }
    await verifyFullAuditObject(client, config, reference)
    return { status, reference, descriptor, ...reference }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

export async function publishFullAuditDayReceipt({
  cause,
  generationId,
  fencingToken,
  promotion,
  publicManifest,
  stateManifestAuthority,
  rawReceiptAuthority,
  rawSourceGeneration,
  stagedSnapshot,
  fullSnapshot = stagedSnapshot?.reference ?? stagedSnapshot,
  snapshotDescriptor = stagedSnapshot?.descriptor,
  leaseAuthority,
  leaseKey = leaseAuthority?.key ?? 'ops/refresh-lease.json',
  config,
  client,
  now = () => new Date(),
  beforeReceiptWrite,
} = {}) {
  if (cause !== 'daily-audit' && cause !== 'manual-force') throw new Error('Invalid full audit cause')
  const resolvedGenerationId = generationId ?? promotion?.generationId
  const resolvedFencingToken = fencingToken ?? promotion?.fencingToken
  if (promotion?.completed !== true || typeof promotion?.etag !== 'string' || promotion.etag.length === 0) {
    throw new Error('Full audit receipt requires a successful promotion authority')
  }
  if (!leaseAuthority?.lease || typeof leaseAuthority.key !== 'string') throw new Error('Full audit receipt requires a live refresh lease authority')
  if (Number(leaseAuthority.lease.fencingToken) !== resolvedFencingToken) throw new Error('Full audit lease fencing token does not match promotion')
  assertSafeId(resolvedGenerationId, 'full audit generationId')
  if (!Number.isSafeInteger(resolvedFencingToken) || resolvedFencingToken < 0) throw new Error('Invalid full audit fencing token')
  const snapshotReference = parseFullAuditObjectReference(fullSnapshot)
  const descriptor = parseFullSnapshotDescriptor(snapshotDescriptor)
  if (descriptor.sha256 !== snapshotReference.sha256 || descriptor.bytes !== snapshotReference.bytes) {
    throw new Error('Full audit snapshot reference does not match its trusted build descriptor')
  }
  assertFullSnapshotMatchesPublic(descriptor, publicManifest)
  await verifyFullAuditObjectMetadata(client, config, snapshotReference)
  const state = await assertStateManifestAuthority(client, config, stateManifestAuthority, { verifyObjects: false })
  const rawAuthority = rawReceiptAuthority ?? rawSourceGeneration
  const sourceReceipt = parseRawReference(rawAuthority?.reference ?? rawAuthority?.receiptReference, 'full audit source receipt')
  const rawReceipt = parseRawSourceReceipt(rawAuthority?.receipt)
  const publicModel = parsePublicModel(publicManifest)
  if (state.manifest.generationId !== resolvedGenerationId || state.manifest.runId !== resolvedGenerationId
    || rawReceipt.generationId !== resolvedGenerationId
    || state.manifest.sourceReceiptDigest !== rawReceipt.sourceReceiptDigest
    || state.manifest.compatibility.modelVersion !== publicModel.version
    || state.manifest.compatibility.modelConfigHash !== publicModel.configHash) {
    throw new Error('Full audit public, state, and raw authorities do not describe one generation')
  }
  await readStoredJsonStateObject(client, config, state.manifest.canonicalLedger)
  await verifyRawReceiptObject(client, config, sourceReceipt, rawReceipt)
  await assertBucketLease(leaseKey, leaseAuthority, { config, client, now: now(), requireEtag: false })
  const promotedAt = requiredIso(promotion.promotedAt, 'full audit promotedAt')
  const auditDate = promotedAt.slice(0, 10)
  const receipt = parseFullAuditReceipt({
    artifactKind: AUDIT_KIND,
    schemaVersion: 1,
    auditDate,
    cause,
    generationId: resolvedGenerationId,
    runId: resolvedGenerationId,
    fencingToken: resolvedFencingToken,
    promotedAt,
    model: publicModel,
    sourceReceipt,
    rawLedger: state.manifest.canonicalLedger,
    fullSnapshot: snapshotReference,
  })
  await assertActivePromotion(config, client, promotion, resolvedGenerationId, resolvedFencingToken)
  await beforeReceiptWrite?.()
  await assertBucketLease(leaseKey, leaseAuthority, { config, client, now: now(), requireEtag: false })
  await assertActivePromotion(config, client, promotion, resolvedGenerationId, resolvedFencingToken)

  const relativeKey = `audits/days/${auditDate}.json`
  const key = bucketKey(config, relativeKey)
  const body = Buffer.from(canonicalJsonFor(receipt))
  const digest = createHash('sha256').update(body).digest('hex')
  let current
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
    const currentBytes = await bodyBytes(object.Body)
    current = { etag: object.ETag, bytes: currentBytes, receipt: parseFullAuditReceipt(JSON.parse(currentBytes.toString('utf8'))) }
    if (canonicalJsonFor(current.receipt) !== currentBytes.toString('utf8')) throw new Error('Existing full audit receipt is not canonical JSON')
    if (current.receipt.fencingToken > resolvedFencingToken) throw new Error('A newer full audit authority already exists for this UTC day')
    if (current.receipt.fencingToken === resolvedFencingToken) {
      if (current.bytes.equals(body)) return { status: 'unchanged', key, receipt, digest, bytes: body.byteLength, etag: current.etag }
      throw new Error('Conflicting full audit authority exists for this UTC day')
    }
  } catch (error) {
    if (!isMissingObjectError(error)) throw error
  }
  await assertBucketLease(leaseKey, leaseAuthority, { config, client, now: now(), requireEtag: false })
  await assertActivePromotion(config, client, promotion, resolvedGenerationId, resolvedFencingToken)
  try {
    const result = await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentLength: body.byteLength,
      ContentType: JSON_TYPE,
      Metadata: { sha256: digest, 'semantic-bytes': String(body.byteLength) },
      ...(current ? { IfMatch: current.etag } : { IfNoneMatch: '*' }),
    }))
    return { status: current ? 'replaced' : 'uploaded', key, receipt, digest, bytes: body.byteLength, etag: result.ETag }
  } catch (error) {
    if (isPreconditionError(error)) throw new Error('Full audit day authority changed during receipt publication', { cause: error })
    throw error
  }
}

export function parseFullAuditReceipt(value) {
  assertExactKeys(value, ['artifactKind', 'schemaVersion', 'auditDate', 'cause', 'generationId', 'runId', 'fencingToken', 'promotedAt', 'model', 'sourceReceipt', 'rawLedger', 'fullSnapshot'], 'full audit receipt')
  if (value.artifactKind !== AUDIT_KIND || value.schemaVersion !== 1) throw new Error('Unsupported full audit receipt schema')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.auditDate ?? '')) throw new Error('Invalid full audit date')
  if (value.cause !== 'daily-audit' && value.cause !== 'manual-force') throw new Error('Invalid full audit cause')
  assertSafeId(value.generationId, 'full audit generationId')
  assertSafeId(value.runId, 'full audit runId')
  if (value.runId !== value.generationId) throw new Error('Full audit runId must match generationId')
  if (!Number.isSafeInteger(value.fencingToken) || value.fencingToken < 0) throw new Error('Invalid full audit fencing token')
  const promotedAt = requiredIso(value.promotedAt, 'full audit promotedAt')
  if (promotedAt.slice(0, 10) !== value.auditDate) throw new Error('Full audit date does not match promotedAt')
  return {
    artifactKind: value.artifactKind,
    schemaVersion: value.schemaVersion,
    auditDate: value.auditDate,
    cause: value.cause,
    generationId: value.generationId,
    runId: value.runId,
    fencingToken: value.fencingToken,
    promotedAt,
    model: parseModel(value.model),
    sourceReceipt: parseRawReference(value.sourceReceipt, 'full audit source receipt'),
    rawLedger: parseStateReference(value.rawLedger, 'full audit raw ledger'),
    fullSnapshot: parseFullAuditObjectReference(value.fullSnapshot),
  }
}

async function assertActivePromotion(config, client, promotion, generationId, fencingToken) {
  const active = await readBucketJson('active-generation.json', { config, client })
  if (!active.found || active.etag !== promotion.etag || active.value?.generationId !== generationId
    || Number(active.value?.fencingToken) !== fencingToken) {
    throw new Error('Active generation changed before full audit receipt publication')
  }
}

async function verifyFullAuditObject(client, config, reference) {
  const key = bucketKey(config, reference.key)
  const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
  if (object.ContentEncoding !== 'gzip' || object.ContentType !== JSON_TYPE || object.CacheControl !== IMMUTABLE
    || object.Metadata?.sha256 !== reference.sha256 || object.Metadata?.['semantic-bytes'] !== String(reference.bytes)
    || object.Metadata?.encoding !== 'gzip' || Number(object.ContentLength) !== reference.compressedBytes) {
    throw new Error(`Full audit object metadata mismatch: ${key}`)
  }
  let compressedBytes = 0
  let bytes = 0
  const digest = createHash('sha256')
  const countCompressed = new Transform({ transform(chunk, _encoding, callback) { compressedBytes += chunk.length; callback(null, chunk) } })
  const hashSemantic = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; digest.update(chunk); callback() } })
  try {
    await pipeline(readableBody(object.Body), countCompressed, createGunzip(), hashSemantic)
  } catch (error) {
    throw new Error(`Full audit object gzip is corrupt: ${key}`, { cause: error })
  }
  if (compressedBytes !== reference.compressedBytes || bytes !== reference.bytes || digest.digest('hex') !== reference.sha256) {
    throw new Error(`Full audit object semantic identity mismatch: ${key}`)
  }
}

async function verifyFullAuditObjectMetadata(client, config, reference) {
  const key = bucketKey(config, reference.key)
  const object = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))
  if (object.ContentEncoding !== 'gzip' || object.ContentType !== JSON_TYPE || object.CacheControl !== IMMUTABLE
    || object.Metadata?.sha256 !== reference.sha256 || object.Metadata?.['semantic-bytes'] !== String(reference.bytes)
    || object.Metadata?.encoding !== 'gzip' || Number(object.ContentLength) !== reference.compressedBytes) {
    throw new Error(`Full audit object metadata mismatch: ${key}`)
  }
}

function parseFullSnapshotDescriptor(value) {
  assertExactKeys(value, ['artifactKind', 'schemaVersion', 'generatedAt', 'source', 'sources', 'model', 'sha256', 'bytes'], 'full audit snapshot descriptor')
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.artifactKind !== 'full-ranking-artifact'
    || !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion <= 0
    || requiredIso(value.generatedAt, 'full audit snapshot generatedAt') !== value.generatedAt
    || typeof value.source !== 'string' || value.source.length === 0
    || !Array.isArray(value.sources) || value.sources.length === 0
    || value.sources.some((source) => {
      try { assertExactKeys(source, ['name'], 'full audit snapshot source'); return typeof source.name !== 'string' || source.name.length === 0 } catch { return true }
    })
    || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '') || !Number.isSafeInteger(value.bytes) || value.bytes <= 0) {
    throw new Error('Full audit snapshot descriptor is invalid')
  }
  return {
    artifactKind: value.artifactKind,
    schemaVersion: value.schemaVersion,
    generatedAt: value.generatedAt,
    source: value.source,
    sources: value.sources.map(({ name }) => ({ name })),
    model: parseModel(value.model),
    sha256: value.sha256,
    bytes: value.bytes,
  }
}

function assertFullSnapshotMatchesPublic(snapshot, publicManifest) {
  const manifest = publicManifest?.manifest ?? publicManifest
  if (!manifest || typeof manifest !== 'object'
    || snapshot.model.version !== manifest.model?.version
    || snapshot.model.configHash !== manifest.model?.configHash
    || snapshot.generatedAt !== manifest.generatedAt
    || snapshot.source !== manifest.source
    || canonicalJsonFor(snapshot.sources.map((source) => source.name)) !== canonicalJsonFor((manifest.sources ?? []).map((source) => source?.name))) {
    throw new Error('Full audit snapshot provenance does not match the promoted public artifact')
  }
}

async function verifyRawReceiptObject(client, config, reference, expected) {
  const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: bucketKey(config, reference.key) }))
  const compressed = await bodyBytes(object.Body)
  if (object.ContentEncoding !== 'gzip' || object.Metadata?.sha256 !== reference.sha256
    || object.Metadata?.['semantic-bytes'] !== String(reference.bytes) || object.Metadata?.encoding !== 'gzip'
    || Number(object.ContentLength) !== reference.compressedBytes || compressed.byteLength !== reference.compressedBytes) {
    throw new Error('Full audit raw receipt metadata mismatch')
  }
  const parsed = parseRawSourceReceipt(decodeRawObject(reference, compressed))
  if (canonicalJsonFor(parsed) !== canonicalJsonFor(expected)) throw new Error('Full audit raw receipt authority mismatch')
}

function parsePublicModel(value) {
  const manifest = value?.manifest ?? value
  if (!manifest || typeof manifest !== 'object') throw new Error('Full audit public manifest is required')
  return parseModel({
    version: manifest.model?.version,
    configHash: manifest.model?.configHash,
  })
}

function parseModel(value) {
  assertExactKeys(value, ['version', 'configHash'], 'full audit model')
  if (typeof value.version !== 'string' || value.version.length === 0 || typeof value.configHash !== 'string' || value.configHash.length === 0) {
    throw new Error('Invalid full audit model authority')
  }
  return { version: value.version, configHash: value.configHash }
}

function parseFullAuditObjectReference(value) {
  const parsed = parseReference(value, 'full audit object')
  if (parsed.key !== `audits/objects/sha256/${parsed.sha256}`) throw new Error('Full audit object key is not canonical')
  return parsed
}

function parseRawReference(value, label) {
  const parsed = parseReference(value, label)
  if (parsed.key !== `raw/objects/sha256/${parsed.sha256}`) throw new Error(`${label} key is not canonical`)
  return parsed
}

function parseStateReference(value, label) {
  const parsed = parseReference(value, label)
  if (parsed.key !== `state/objects/sha256/${parsed.sha256}`) throw new Error(`${label} key is not canonical`)
  return parsed
}

function parseReference(value, label) {
  assertExactKeys(value, ['key', 'sha256', 'bytes', 'compressedBytes', 'storageEncoding'], label)
  if (typeof value.key !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '')
    || !Number.isSafeInteger(value.bytes) || value.bytes <= 0
    || !Number.isSafeInteger(value.compressedBytes) || value.compressedBytes <= 0
    || value.storageEncoding !== 'gzip') throw new Error(`Invalid ${label}`)
  return { key: value.key, sha256: value.sha256, bytes: value.bytes, compressedBytes: value.compressedBytes, storageEncoding: 'gzip' }
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`Invalid ${label} fields`)
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`Invalid ${label}`)
}

function requiredIso(value, label) {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime()) || new Date(value).toISOString() !== value) throw new Error(`Invalid ${label}`)
  return value
}

function readableBody(body) {
  return typeof body?.pipe === 'function' ? body : Readable.from([body])
}

async function bodyBytes(body) {
  if (typeof body?.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray())
  const chunks = []
  for await (const chunk of readableBody(body)) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function isMissingObjectError(error) {
  return error?.name === 'NoSuchKey' || error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404
}

function isPreconditionError(error) {
  return error?.name === 'PreconditionFailed' || error?.$metadata?.httpStatusCode === 412
}
