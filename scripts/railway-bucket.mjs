import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, gunzipSync } from 'node:zlib'
import { basename, dirname, extname, join, posix, relative, resolve, sep } from 'node:path'
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { manifestWithResolvedFiles } from './local-data-manifest.js'
import { CONTENT_ADDRESSED_STORAGE_MODE, canonicalPublicLogicalPath, createGenerationManifest, prepareSemanticArtifact } from './public-artifact-storage.mjs'
import { assertStateManifestAuthority } from './incremental-state-storage.mjs'
import { decodeRawObject, parseRawSourceReceipt, rawObjectReferenceFor } from './raw-source-storage.mjs'

let activeGenerationCache = { expiresAt: 0, value: null }

export const PRESIGNED_URL_EXPIRY_SECONDS = 3600
const IMMUTABLE_PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const PUBLIC_JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

export function bucketConfigFromEnv(env = process.env) {
  const bucket = env.RANKING_BUCKET_NAME ?? env.S3_BUCKET ?? env.BUCKET
  const endpoint = env.RANKING_BUCKET_ENDPOINT ?? env.S3_ENDPOINT ?? env.ENDPOINT
  const region = env.RANKING_BUCKET_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? env.S3_REGION ?? env.REGION ?? 'auto'
  const accessKeyId = env.RANKING_BUCKET_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID ?? env.ACCESS_KEY_ID
  const secretAccessKey = env.RANKING_BUCKET_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY ?? env.SECRET_ACCESS_KEY
  const prefix = normalizePrefix(env.RANKING_BUCKET_PREFIX ?? 'rankings')
  const forcePathStyle = parseBoolean(env.RANKING_BUCKET_FORCE_PATH_STYLE)

  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) {
    return {
      enabled: false,
      missing: [
        !bucket ? 'BUCKET' : undefined,
        !endpoint ? 'ENDPOINT' : undefined,
        !accessKeyId ? 'ACCESS_KEY_ID' : undefined,
        !secretAccessKey ? 'SECRET_ACCESS_KEY' : undefined,
      ].filter(Boolean),
    }
  }

  return {
    enabled: true,
    bucket,
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    prefix,
    forcePathStyle,
  }
}

export function createBucketClient(config = bucketConfigFromEnv()) {
  if (!config.enabled) return null
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })
}

export async function uploadRankingArtifacts({
  publicDataDir,
  rawDir,
  fullSnapshotPath,
  manifestPath,
  statePath,
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
  uploadFullSnapshot = parseBoolean(process.env.RANKING_BUCKET_UPLOAD_FULL_SNAPSHOT),
  refreshStateForUpload,
  generationId,
  fencingToken,
  leaseAuthority,
  now = () => new Date(),
  monotonicNow = () => performance.now(),
  onStage,
  refreshTelemetry,
  beforePromotionWrite,
  stateManifestAuthority,
  publicArtifactPatch,
  rawSourceGeneration,
  contentAddressed = parseBoolean(process.env.RANKING_BUCKET_CONTENT_ADDRESSED),
} = {}) {
  if (!config.enabled) {
    return {
      enabled: false,
      missing: config.missing,
      uploaded: [],
      unchanged: [],
      skipped: [],
      artifactCount: 0,
      uploadedCount: 0,
      uploadedBytes: 0,
      unchangedCount: 0,
      unchangedBytes: 0,
    }
  }

  const uploads = []
  const unchanged = []
  const skipped = []
  if (contentAddressed && !generationId) {
    throw new Error('Content-addressed publication requires a generationId')
  }
  const dataPrefix = generationId ? `generations/${safeObjectPath(generationId)}/data` : 'data'
  if (leaseAuthority) await assertBucketLease(leaseAuthority.key, leaseAuthority, {
    config,
    client,
    now: now(),
    requireEtag: Boolean(leaseAuthority.etag),
  })
  let stageStarted = monotonicNow()
  const publicSync = contentAddressed
    ? publicArtifactPatch
      ? await uploadContentAddressedPublicArtifactPatch(client, config, { generationId, ...publicArtifactPatch })
      : await uploadContentAddressedPublicArtifacts(client, config, publicDataDir, generationId)
    : { uploaded: await uploadDirectory(client, config, publicDataDir, dataPrefix, 'ranking-summary.json'), unchanged: [] }
  uploads.push(...publicSync.uploaded)
  unchanged.push(...publicSync.unchanged)
  const storageMetrics = contentAddressed ? {
    mode: CONTENT_ADDRESSED_STORAGE_MODE,
    objectCount: publicSync.objectCount,
    logicalArtifactCount: publicSync.logicalArtifactCount,
    semanticLogicalBytes: publicSync.semanticLogicalBytes,
    compressedLogicalBytes: publicSync.compressedLogicalBytes,
    uniqueCompressedBytes: publicSync.uniqueCompressedBytes,
    ...(publicSync.changedLogicalPaths ? { changedLogicalPaths: publicSync.changedLogicalPaths } : {}),
    ...(publicSync.reusedLogicalPaths ? { reusedLogicalPaths: publicSync.reusedLogicalPaths } : {}),
    ...(publicSync.removedLogicalPaths ? { removedLogicalPaths: publicSync.removedLogicalPaths } : {}),
  } : undefined
  onStage?.('artifact-upload', {
    durationMs: monotonicNow() - stageStarted,
    output: {
      ...byteCounts(publicSync.uploaded),
      reusedCount: publicSync.unchanged.length,
      reusedBytes: sumBytes(publicSync.unchanged),
      ...(contentAddressed ? { storageMode: CONTENT_ADDRESSED_STORAGE_MODE } : {}),
      ...(storageMetrics ? { storage: storageMetrics } : {}),
    },
  })
  let rawAuthority
  if (rawSourceGeneration) {
    if (!generationId || rawSourceGeneration.receipt?.generationId !== generationId) {
      throw new Error('Content-addressed raw generation must match the public generation')
    }
    stageStarted = monotonicNow()
    const rawSync = await uploadContentAddressedRawSourceGeneration(client, config, rawSourceGeneration)
    rawAuthority = rawSync.authority
    uploads.push(...rawSync.uploaded)
    unchanged.push(...rawSync.unchanged)
    onStage?.('raw-synchronization', {
      durationMs: monotonicNow() - stageStarted,
      output: {
        storageMode: rawSourceGeneration.receipt.storageMode,
        uploadedCount: rawSync.uploaded.length,
        uploadedBytes: sumBytes(rawSync.uploaded),
        reusedCount: rawSync.unchanged.length,
        reusedBytes: sumBytes(rawSync.unchanged),
      },
    })
  } else if (rawDir) {
    if (leaseAuthority) await assertBucketLease(leaseAuthority.key, leaseAuthority, {
      config,
      client,
      now: now(),
      requireEtag: Boolean(leaseAuthority.etag),
    })
    stageStarted = monotonicNow()
    const rawSync = await uploadRawSourceFiles(client, config, rawDir, manifestPath)
    uploads.push(...rawSync.uploaded)
    unchanged.push(...rawSync.unchanged)
    onStage?.('raw-synchronization', {
      durationMs: monotonicNow() - stageStarted,
      output: {
        uploadedCount: rawSync.uploaded.length,
        uploadedBytes: sumBytes(rawSync.uploaded),
        reusedCount: rawSync.unchanged.length,
        reusedBytes: sumBytes(rawSync.unchanged),
      },
    })
  }

  if (fullSnapshotPath && uploadFullSnapshot) {
    uploads.push(await uploadFile(client, config, fullSnapshotPath, 'artifacts/latest-full.json'))
  } else if (fullSnapshotPath) {
    skipped.push({
      key: bucketKey(config, 'artifacts/latest-full.json'),
      reason: 'full-snapshot-upload-disabled',
    })
  }
  if (manifestPath && !rawSourceGeneration) {
    uploads.push(await uploadFile(client, config, manifestPath, 'raw/manifest.json'))
  }
  let promotionOutcome
  if (generationId) {
    stageStarted = monotonicNow()
    const liveAuthority = leaseAuthority
      ? await assertBucketLease(leaseAuthority.key, leaseAuthority, {
          config,
          client,
          now: now(),
          requireEtag: false,
        })
      : undefined
    const active = liveAuthority
      ? { found: true, value: liveAuthority.lease, etag: liveAuthority.etag }
      : await readBucketJson('active-generation.json', { config, client })
    if (Number(active.value?.fencingToken ?? 0) > Number(fencingToken ?? 0)) {
      throw new Error('Stale refresh worker cannot promote an active generation')
    }
    await beforePromotionWrite?.()
    const [, verifiedState, verifiedRaw] = await Promise.all([
      contentAddressed
        ? assertGenerationManifestAuthority(client, config, publicSync.manifestAuthority)
        : undefined,
      stateManifestAuthority
        ? assertStateManifestAuthority(client, config, stateManifestAuthority)
        : undefined,
      rawAuthority
        ? assertRawSourceGenerationAuthority(client, config, rawAuthority)
        : undefined,
    ])
    if (verifiedState && verifiedState.manifest.generationId !== generationId) {
      throw new Error('Incremental state generation does not match public generation')
    }
    if (verifiedRaw && verifiedRaw.receipt.generationId !== generationId) {
      throw new Error('Raw source receipt generation does not match public generation')
    }
    if (verifiedRaw && verifiedState
      && verifiedState.manifest.sourceReceiptDigest !== verifiedRaw.receipt.sourceReceiptDigest) {
      throw new Error('Incremental state source receipt does not match raw source authority')
    }
    const promotedAt = new Date(now()).toISOString()
    const activePointerBase = { ...active.value }
    delete activePointerBase.stateManifestKey
    delete activePointerBase.stateManifestDigest
    delete activePointerBase.rawReceiptKey
    delete activePointerBase.rawReceiptDigest
    delete activePointerBase.rawReceiptBytes
    delete activePointerBase.rawReceiptCompressedBytes
    delete activePointerBase.sourceReceiptDigest
    delete activePointerBase.rawIdentityDigest
    const promotion = await writeBucketJson('active-generation.json', {
      ...activePointerBase,
      schemaVersion: 1,
      generationId,
      fencingToken,
      promotedAt,
      manifestKey: bucketKey(config, contentAddressed
        ? `generations/${safeObjectPath(generationId)}/manifest.json`
        : `${dataPrefix}/ranking-summary.json`),
      ...(contentAddressed ? {
        storageMode: CONTENT_ADDRESSED_STORAGE_MODE,
        manifestDigest: publicSync.manifestAuthority.digest,
        manifestBytes: publicSync.manifestAuthority.bytes,
        manifestEtag: publicSync.manifestAuthority.etag,
      } : {}),
      ...(verifiedState ? {
        stateManifestKey: verifiedState.key,
        stateManifestDigest: verifiedState.digest,
      } : {}),
      ...(verifiedRaw ? {
        rawReceiptKey: verifiedRaw.key,
        rawReceiptDigest: verifiedRaw.reference.sha256,
        rawReceiptBytes: verifiedRaw.reference.bytes,
        rawReceiptCompressedBytes: verifiedRaw.reference.compressedBytes,
        sourceReceiptDigest: verifiedRaw.receipt.sourceReceiptDigest,
        rawIdentityDigest: verifiedRaw.receipt.rawIdentityDigest,
      } : {}),
    }, {
      config,
      client,
      ...(active.found ? { ifMatch: active.etag } : { ifNoneMatch: '*' }),
    })
    if (!promotion.written) throw new Error('Active generation changed during promotion')
    activeGenerationCache = { expiresAt: Date.now() + 30_000, value: generationId }
    onStage?.('promotion', {
      durationMs: monotonicNow() - stageStarted,
      output: { generationId, fencingToken, promotedAt, etag: promotion.etag },
    })
    promotionOutcome = {
      completed: true,
      generationId,
      fencingToken,
      promotedAt,
      etag: promotion.etag,
      ...(contentAddressed ? { storageMode: CONTENT_ADDRESSED_STORAGE_MODE } : {}),
    }
  }

  const telemetry = refreshTelemetry
    ? await (typeof refreshTelemetry === 'function' ? refreshTelemetry(promotionOutcome) : refreshTelemetry)
    : undefined
  if (leaseAuthority) await assertBucketLease(leaseAuthority.key, leaseAuthority, {
    config,
    client,
    now: now(),
    requireEtag: false,
  })
  if (statePath) {
    if (refreshStateForUpload) {
      uploads.push(await uploadRefreshState(client, config, refreshStateForUpload, {
        uploads,
        unchanged,
        skipped,
        promotion: promotionOutcome,
        refreshTelemetry: telemetry,
        storage: storageMetrics,
      }))
    } else {
      uploads.push(await uploadFile(client, config, statePath, 'raw/refresh-state.json'))
    }
  }
  const publishedArtifacts = [...uploads]
  const publishMetrics = publishMetricsFor(publishedArtifacts, unchanged)
  const publishReceipt = {
    schemaVersion: 1,
    publishedAt: promotionOutcome?.promotedAt ?? new Date(now()).toISOString(),
    prefix: config.prefix,
    ...(generationId ? { generationId } : {}),
    ...(contentAddressed ? { storageMode: CONTENT_ADDRESSED_STORAGE_MODE } : {}),
    ...(storageMetrics ? { storage: storageMetrics } : {}),
    ...publishMetrics,
    artifacts: publishedArtifacts.map(({ key, bytes, contentType }) => ({ key, bytes, contentType })),
    unchanged: unchanged.map(({ key, bytes, contentType, digest }) => ({ key, bytes, contentType, digest })),
    skipped,
    ...(telemetry ? { refreshTelemetry: telemetry } : {}),
  }
  if (leaseAuthority) await assertBucketLease(leaseAuthority.key, leaseAuthority, {
    config,
    client,
    now: now(),
    requireEtag: false,
  })
  await uploadJson(client, config, generationId ? `generations/${safeObjectPath(generationId)}/publish.json` : 'latest-publish.json', publishReceipt)

  return {
    enabled: true,
    bucket: config.bucket,
    prefix: config.prefix,
    uploaded: uploads,
    unchanged,
    skipped,
    promotion: promotionOutcome,
    refreshTelemetry: telemetry,
    ...(contentAddressed ? { storageMode: CONTENT_ADDRESSED_STORAGE_MODE } : {}),
    ...(storageMetrics ? { storage: storageMetrics } : {}),
    ...publishMetrics,
  }
}

export async function getBucketObject(relativePath, {
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
  generationId,
} = {}) {
  if (!config.enabled || !client) return { found: false, missingConfig: config.missing ?? [] }
  const safePath = safeRequestedObjectPath(relativePath)
  const contentObjectRequest = safePath.startsWith('objects/sha256/')
  const directContentObject = /^objects\/sha256\/[a-f0-9]{64}$/.test(safePath)
  if (contentObjectRequest && !directContentObject) return { found: false }
  const generation = directContentObject
    ? undefined
    : typeof generationId === 'string' && generationId.length > 0
      ? generationId
      : await activeGeneration(config, client)
  const keys = [
    ...(directContentObject ? [bucketKey(config, safePath)] : []),
    ...(generation && safePath === 'ranking-summary.json'
      ? [bucketKey(config, `generations/${safeObjectPath(generation)}/manifest.json`)]
      : []),
    ...(generation ? [bucketKey(config, `generations/${safeObjectPath(generation)}/data/${safePath}`)] : []),
    ...(generationId || directContentObject ? [] : [bucketKey(config, `data/${safePath}`)]),
  ]

  for (const key of keys) {
    try {
      const object = await client.send(new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }))
      return {
        found: true,
        key,
        body: object.Body,
        contentLength: object.ContentLength,
        contentType: object.ContentType ?? contentTypeForPath(relativePath),
        contentEncoding: object.ContentEncoding,
        etag: object.ETag,
        lastModified: object.LastModified,
      }
    } catch (error) {
      if (!isMissingObjectError(error)) throw error
    }
  }
  return { found: false, key: keys[0] }
}

export async function headBucketObject(relativePath, {
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
} = {}) {
  const { path } = parseContentAddressedObjectPath(relativePath)
  if (!config.enabled || !client) return { found: false, missingConfig: config.missing ?? [] }
  const key = bucketKey(config, path)
  try {
    const object = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))
    return {
      found: true,
      key,
      contentLength: object.ContentLength,
      contentType: object.ContentType,
      contentEncoding: object.ContentEncoding,
      cacheControl: object.CacheControl,
      metadata: object.Metadata,
      etag: object.ETag,
      lastModified: object.LastModified,
    }
  } catch (error) {
    if (isMissingObjectError(error)) return { found: false, key }
    throw error
  }
}

export async function presignBucketObject(relativePath, {
  method = 'GET',
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
  signer = getSignedUrl,
} = {}) {
  const { path } = parseContentAddressedObjectPath(relativePath)
  if (method !== 'GET' && method !== 'HEAD') throw new Error('Invalid presigned bucket object method')
  if (!config.enabled || !client) throw new Error('Bucket storage is not configured')
  const input = { Bucket: config.bucket, Key: bucketKey(config, path) }
  const command = method === 'HEAD' ? new HeadObjectCommand(input) : new GetObjectCommand(input)
  return signer(client, command, { expiresIn: PRESIGNED_URL_EXPIRY_SECONDS })
}

export async function preparePresignedBucketDelivery(relativePath, {
  method = 'GET',
  thresholdBytes,
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
  head = headBucketObject,
  presign = presignBucketObject,
} = {}) {
  const { sha256 } = parseContentAddressedObjectPath(relativePath)
  let bucketHead
  try {
    bucketHead = await head(relativePath, { config, client })
  } catch {
    return { kind: 'head-failed' }
  }
  if (!bucketHead.found || !isPresignedDeliveryMetadata(bucketHead, sha256, thresholdBytes)) {
    return { kind: 'proxy', bucketHead }
  }
  try {
    return {
      kind: 'redirect',
      location: await presign(relativePath, { method, config, client }),
    }
  } catch {
    return { kind: 'sign-failed', bucketHead }
  }
}

function isPresignedDeliveryMetadata(object, digest, thresholdBytes) {
  return Number.isSafeInteger(object.contentLength)
    && object.contentLength >= thresholdBytes
    && object.contentType?.toLowerCase() === PUBLIC_JSON_CONTENT_TYPE
    && object.contentEncoding?.toLowerCase() === 'gzip'
    && object.cacheControl?.toLowerCase() === IMMUTABLE_PUBLIC_CACHE_CONTROL
    && object.metadata?.sha256 === digest
    && object.metadata?.encoding === 'gzip'
    && /^[1-9]\d*$/.test(object.metadata?.['semantic-bytes'] ?? '')
}

export function parseContentAddressedObjectPath(path) {
  const value = String(path ?? '')
  const match = /^objects\/sha256\/([a-f0-9]{64})$/.exec(value)
  if (!match) throw new Error('Invalid content-addressed bucket object path')
  return { path: value, sha256: match[1] }
}

export async function readBucketJson(relativeKey, {
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
} = {}) {
  if (!config.enabled || !client) return { found: false, missingConfig: config.missing ?? [] }
  const key = bucketKey(config, relativeKey)
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
    return {
      found: true,
      key,
      etag: object.ETag,
      value: JSON.parse(await bodyText(object.Body)),
    }
  } catch (error) {
    if (isMissingObjectError(error)) return { found: false, key }
    throw error
  }
}

export async function readActiveContentAddressedGeneration({
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
  verifyArtifacts = true,
} = {}) {
  const active = await readBucketJson('active-generation.json', { config, client })
  if (!active.found || active.value?.storageMode !== CONTENT_ADDRESSED_STORAGE_MODE) {
    return { found: false, reason: active.found ? 'legacy-active-generation' : 'active-generation-missing', active: active.value, etag: active.etag }
  }
  const generationId = active.value.generationId
  const expectedKey = bucketKey(config, `generations/${safeObjectPath(generationId)}/manifest.json`)
  if (active.value.manifestKey !== expectedKey) throw new Error('Active public generation manifest key is not canonical')
  const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: expectedKey }))
  const manifestBytes = await bodyBytes(object.Body)
  const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex')
  if (!/^[a-f0-9]{64}$/.test(active.value.manifestDigest ?? '')
    || !Number.isSafeInteger(active.value.manifestBytes) || active.value.manifestBytes <= 0
    || typeof active.value.manifestEtag !== 'string'
    || active.value.manifestDigest !== manifestDigest
    || active.value.manifestBytes !== manifestBytes.byteLength
    || active.value.manifestEtag !== object.ETag
    || object.Metadata?.sha256 !== manifestDigest) {
    throw new Error('Active public generation manifest authority mismatch')
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (manifest.storageMode !== CONTENT_ADDRESSED_STORAGE_MODE || manifest.generationId !== generationId
    || manifest.runId !== generationId || manifest.rootArtifact !== '/data/ranking-summary.json'
    || !manifest.artifacts || typeof manifest.artifacts !== 'object' || Array.isArray(manifest.artifacts)) {
    throw new Error('Active public generation manifest is invalid')
  }
  const identities = {}
  for (const [logicalPath, identity] of Object.entries(manifest.artifacts)) {
    const canonical = canonicalPublicLogicalPath(logicalPath)
    if (identity?.logicalPath !== canonical || identity?.objectUrl !== `/data/objects/sha256/${identity?.sha256}`
      || identity?.generationId !== generationId || identity?.storageEncoding !== 'gzip') {
      throw new Error(`Active public generation has an invalid mapping for ${canonical}`)
    }
    identities[canonical] = identity
  }
  const loadArtifacts = async (logicalPaths) => Object.fromEntries(await Promise.all(
    [...new Set(logicalPaths.map((path) => canonicalPublicLogicalPath(path)))]
      .filter((canonical) => identities[canonical])
      .map(async (canonical) => {
      const identity = identities[canonical]
      return [canonical, await readVerifiedContentAddressedArtifact(client, config, identity, canonical)]
      }),
  ))
  const artifacts = verifyArtifacts
    ? await loadArtifacts(Object.keys(identities))
    : await loadArtifacts(['/data/ranking-summary.json'])
  const rootArtifact = artifacts['/data/ranking-summary.json']
  if (!rootArtifact) throw new Error('Active public generation has no valid root artifact')
  return { found: true, active: active.value, etag: active.etag, manifest, rootArtifact, artifacts, loadArtifacts }
}

export async function readActiveRawSourceAuthority({
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
} = {}) {
  const active = await readBucketJson('active-generation.json', { config, client })
  if (!active.found || typeof active.value?.rawReceiptKey !== 'string') {
    return { found: false, reason: active.found ? 'legacy-active-generation' : 'active-generation-missing' }
  }
  const reference = {
    key: relativeBucketKey(config, active.value.rawReceiptKey),
    sha256: active.value.rawReceiptDigest,
    bytes: active.value.rawReceiptBytes,
    compressedBytes: active.value.rawReceiptCompressedBytes,
    storageEncoding: 'gzip',
  }
  const compressed = await readRawObjectBytes(client, config, reference)
  const receipt = parseRawSourceReceipt(decodeRawObject(reference, compressed))
  if (receipt.generationId !== active.value.generationId
    || receipt.sourceReceiptDigest !== active.value.sourceReceiptDigest
    || receipt.rawIdentityDigest !== active.value.rawIdentityDigest) {
    throw new Error('Active raw source receipt authority mismatch')
  }
  return {
    found: true,
    active: active.value,
    receipt,
    receiptReference: reference,
    objectResolver: (objectReference) => readRawObjectBytes(client, config, objectReference),
    streamObjectToFile: (objectReference, destinationPath) => streamRawObjectToFile(client, config, objectReference, destinationPath),
  }
}

export async function uploadContentAddressedRawSourceGeneration(client, config, generation) {
  const uploaded = []
  const unchanged = []
  const unique = new Map()
  for (const prepared of [...generation.objects, generation.receiptPrepared]) unique.set(prepared.digest, prepared)
  for (const prepared of unique.values()) {
    const result = await syncContentAddressedRawObject(client, config, prepared)
    if (result.status === 'uploaded') uploaded.push(result)
    else unchanged.push(result)
  }
  return {
    uploaded,
    unchanged,
    authority: {
      key: bucketKey(config, generation.receiptReference.key),
      reference: generation.receiptReference,
      receipt: generation.receipt,
    },
  }
}

async function syncContentAddressedRawObject(client, config, prepared) {
  const reference = rawObjectReferenceFor(prepared)
  const key = bucketKey(config, reference.key)
  try {
    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: prepared.compressedPath ? verifiedFileBackedRawBody(prepared) : prepared.compressed,
      ContentLength: prepared.compressedBytes,
      ContentType: 'application/json; charset=utf-8',
      ContentEncoding: 'gzip',
      Metadata: { sha256: prepared.digest, 'semantic-bytes': String(prepared.bytes), encoding: 'gzip' },
      IfNoneMatch: '*',
    }))
    return { status: 'uploaded', key, bytes: prepared.compressedBytes, contentType: 'application/json; charset=utf-8', digest: prepared.digest }
  } catch (error) {
    if (!isPreconditionError(error)) throw error
    await readRawObjectBytes(client, config, reference)
    return { status: 'unchanged', key, bytes: prepared.compressedBytes, contentType: 'application/json; charset=utf-8', digest: prepared.digest }
  }
}

function verifiedFileBackedRawBody(prepared) {
  const digest = createHash('sha256')
  let bytes = 0
  const verify = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      digest.update(chunk)
      callback(null, chunk)
    },
    flush(callback) {
      if (bytes !== prepared.compressedBytes || digest.digest('hex') !== prepared.compressedSha256) {
        callback(new Error(`File-backed raw source object changed before upload: ${prepared.digest}`))
      } else {
        callback()
      }
    },
  })
  return createReadStream(prepared.compressedPath).pipe(verify)
}

async function assertRawSourceGenerationAuthority(client, config, authority) {
  const compressed = await readRawObjectBytes(client, config, authority.reference)
  const receipt = parseRawSourceReceipt(decodeRawObject(authority.reference, compressed))
  const references = [
    ...receipt.oracle.flatMap((source) => [source.baseline, ...source.deltas]),
    ...receipt.leaguepedia.map((source) => source.object),
    ...receipt.lolesports.map((source) => source.object),
  ]
  for (const reference of references) await readRawObjectBytes(client, config, reference)
  return { ...authority, receipt }
}

async function readRawObjectBytes(client, config, reference) {
  const key = bucketKey(config, reference.key)
  let object
  try {
    object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
  } catch (error) {
    if (isMissingObjectError(error)) throw new Error(`Referenced raw source object is missing: ${reference.key}`, { cause: error })
    throw error
  }
  const compressed = await bodyBytes(object.Body)
  if (object.ContentEncoding !== 'gzip' || object.Metadata?.sha256 !== reference.sha256
    || object.Metadata?.['semantic-bytes'] !== String(reference.bytes) || object.Metadata?.encoding !== 'gzip'
    || Number(object.ContentLength) !== reference.compressedBytes || compressed.byteLength !== reference.compressedBytes) {
    throw new Error(`Referenced raw source object metadata mismatch: ${reference.key}`)
  }
  decodeRawObject(reference, compressed)
  return compressed
}

async function streamRawObjectToFile(client, config, reference, destinationPath) {
  const key = bucketKey(config, reference.key)
  let object
  try {
    object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
  } catch (error) {
    if (isMissingObjectError(error)) throw new Error(`Referenced raw source object is missing: ${reference.key}`, { cause: error })
    throw error
  }
  if (object.ContentEncoding !== 'gzip' || object.Metadata?.sha256 !== reference.sha256
    || object.Metadata?.['semantic-bytes'] !== String(reference.bytes) || object.Metadata?.encoding !== 'gzip'
    || Number(object.ContentLength) !== reference.compressedBytes) {
    throw new Error(`Referenced raw source object metadata mismatch: ${reference.key}`)
  }
  const destination = resolve(destinationPath)
  const temporary = `${destination}.${process.pid}.tmp`
  let compressedBytes = 0
  const count = new Transform({
    transform(chunk, _encoding, callback) {
      compressedBytes += chunk.length
      callback(null, chunk)
    },
  })
  const body = typeof object.Body?.pipe === 'function'
    ? object.Body
    : Readable.from([await bodyBytes(object.Body)])
  await mkdir(dirname(destination), { recursive: true })
  try {
    await pipeline(body, count, createWriteStream(temporary, { flags: 'wx' }))
    if (compressedBytes !== reference.compressedBytes) throw new Error(`Referenced raw source object length mismatch: ${reference.key}`)
    await rename(temporary, destination)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return { path: destination, compressedBytes }
}

function relativeBucketKey(config, key) {
  const prefix = normalizePrefix(config.prefix)
  const expectedPrefix = prefix ? `${prefix}/` : ''
  if (expectedPrefix && !key.startsWith(expectedPrefix)) throw new Error('Active raw receipt key is outside the configured prefix')
  const relativeKey = expectedPrefix ? key.slice(expectedPrefix.length) : key
  if (!relativeKey.startsWith('raw/objects/sha256/')) throw new Error('Active raw receipt key is not canonical')
  return relativeKey
}

export async function writeBucketJson(relativeKey, value, {
  ifMatch,
  ifNoneMatch,
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
} = {}) {
  if (!config.enabled || !client) return { written: false, missingConfig: config.missing ?? [] }
  const key = bucketKey(config, relativeKey)
  const body = jsonBody(value)
  try {
    const result = await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json; charset=utf-8',
      ...(ifMatch ? { IfMatch: ifMatch } : {}),
      ...(ifNoneMatch ? { IfNoneMatch: ifNoneMatch } : {}),
    }))
    return { written: true, key, etag: result.ETag, bytes: Buffer.byteLength(body) }
  } catch (error) {
    if (isPreconditionError(error)) return { written: false, conflict: true, key }
    throw error
  }
}

export async function acquireBucketLease(relativeKey, {
  owner,
  ttlMs = 10 * 60_000,
  now = new Date(),
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
} = {}) {
  const active = await readBucketJson('active-generation.json', { config, client })
  const legacy = active.value?.leaseFencingToken === undefined
    ? await readBucketJson(relativeKey, { config, client })
    : { found: false }
  const nowMs = new Date(now).getTime()
  const currentLease = active.value?.leaseFencingToken !== undefined
    ? {
        owner: active.value.leaseOwner,
        fencingToken: active.value.leaseFencingToken,
        acquiredAt: active.value.leaseAcquiredAt,
        expiresAt: active.value.leaseExpiresAt,
      }
    : legacy.value
  if (new Date(currentLease?.expiresAt).getTime() > nowMs && currentLease?.owner !== owner) {
    return { acquired: false, reason: 'active-lease', lease: currentLease }
  }
  const lease = {
    schemaVersion: 1,
    owner,
    fencingToken: Math.max(
      Number(active.value?.leaseFencingToken ?? 0),
      Number(active.value?.fencingToken ?? 0),
      Number(legacy.value?.fencingToken ?? 0),
    ) + 1,
    acquiredAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
  }
  const write = await writeBucketJson('active-generation.json', {
    ...(active.value ?? {}),
    schemaVersion: 1,
    leaseKey: relativeKey,
    leaseOwner: lease.owner,
    leaseFencingToken: lease.fencingToken,
    leaseAcquiredAt: lease.acquiredAt,
    leaseExpiresAt: lease.expiresAt,
    fencingToken: Math.max(Number(active.value?.fencingToken ?? 0), lease.fencingToken),
  }, {
    config,
    client,
    ...(active.found ? { ifMatch: active.etag } : { ifNoneMatch: '*' }),
  })
  return write.written
    ? { acquired: true, lease, etag: write.etag, promotionEtag: write.etag }
    : { acquired: false, reason: write.conflict ? 'lease-race' : 'bucket-unavailable' }
}

export async function renewBucketLease(relativeKey, authority, {
  ttlMs = 10 * 60_000,
  now = new Date(),
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
} = {}) {
  if (!authority?.etag || !authority?.lease) return { renewed: false, reason: 'invalid-lease' }
  const current = await assertBucketLease(relativeKey, authority, { now, config, client, throwOnFailure: false })
  if (!current.live) return { renewed: false, reason: current.reason }
  const nowMs = new Date(now).getTime()
  const lease = {
    ...authority.lease,
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    renewedAt: new Date(nowMs).toISOString(),
  }
  const active = current.lease
  const write = await writeBucketJson('active-generation.json', {
    ...active,
    leaseExpiresAt: lease.expiresAt,
    leaseRenewedAt: lease.renewedAt,
  }, {
    config,
    client,
    ifMatch: authority.etag,
  })
  return write.written
    ? { renewed: true, lease, etag: write.etag, promotionEtag: write.etag }
    : { renewed: false, reason: write.conflict ? 'lease-changed' : 'bucket-unavailable' }
}

export async function assertBucketLease(relativeKey, authority, {
  now = new Date(),
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
  throwOnFailure = true,
  requireEtag = true,
} = {}) {
  const current = await readBucketJson('active-generation.json', { config, client })
  const reason = !authority?.lease || (requireEtag && !authority?.etag)
    ? 'invalid-lease'
    : !current.found
      ? 'lease-missing'
      : requireEtag && authority.etag && current.etag !== authority.etag
        ? 'lease-changed'
        : current.value?.leaseKey !== relativeKey
          ? 'lease-key-changed'
          : current.value?.leaseOwner !== authority.lease.owner
          ? 'lease-owner-changed'
          : Number(current.value?.leaseFencingToken) !== Number(authority.lease.fencingToken)
            ? 'lease-token-changed'
            : new Date(current.value?.leaseExpiresAt).getTime() <= new Date(now).getTime()
              ? 'lease-expired'
              : undefined
  if (!reason) return { live: true, lease: current.value, etag: current.etag }
  if (throwOnFailure) throw new Error(`Refresh lease is no longer authoritative: ${reason}`)
  return { live: false, reason }
}

export async function releaseBucketLease(relativeKey, lease, {
  now = new Date(),
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
} = {}) {
  if (!lease?.etag || !lease?.lease) return { released: false, reason: 'invalid-lease' }
  const current = await assertBucketLease(relativeKey, lease, { now, config, client, throwOnFailure: false })
  if (!current.live) return { released: false, reason: current.reason }
  const releasedAt = new Date(now).toISOString()
  const write = await writeBucketJson('active-generation.json', {
    ...current.lease,
    leaseExpiresAt: releasedAt,
    leaseReleasedAt: releasedAt,
  }, {
    config,
    client,
    ifMatch: lease.etag,
  })
  return write.written
    ? { released: true, etag: write.etag }
    : { released: false, reason: write.conflict ? 'lease-changed' : 'bucket-unavailable' }
}

export async function downloadBucketDirectory({
  destinationDir,
  sourcePrefix,
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
} = {}) {
  if (!config.enabled || !client) {
    return {
      enabled: false,
      missing: config.missing ?? [],
      downloaded: [],
    }
  }

  const root = resolve(destinationDir)
  const prefix = bucketKey(config, sourcePrefix).replace(/\/?$/, '/')
  const downloaded = []
  let continuationToken

  await mkdir(root, { recursive: true })

  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }))

    for (const object of response.Contents ?? []) {
      if (!object.Key || object.Key.endsWith('/')) continue
      const relativeKey = object.Key.slice(prefix.length)
      const safePath = safeObjectPath(relativeKey)
      if (!safePath) continue

      const outputPath = resolve(root, safePath)
      const rootWithSeparator = `${root}${sep}`
      if (outputPath !== root && !outputPath.startsWith(rootWithSeparator)) continue

      const bucketObject = await client.send(new GetObjectCommand({
        Bucket: config.bucket,
        Key: object.Key,
      }))
      await mkdir(dirname(outputPath), { recursive: true })
      await pipeline(bucketObject.Body, createWriteStream(outputPath))
      downloaded.push({
        key: object.Key,
        path: outputPath,
        bytes: object.Size,
      })
    }

    continuationToken = response.NextContinuationToken
  } while (continuationToken)

  return {
    enabled: true,
    bucket: config.bucket,
    prefix: config.prefix,
    downloaded,
  }
}

export async function downloadBucketObject({
  relativeKey,
  destinationPath,
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
} = {}) {
  if (!config.enabled || !client) {
    return {
      enabled: false,
      found: false,
      missing: config.missing ?? [],
    }
  }

  const key = bucketKey(config, relativeKey)
  try {
    const object = await client.send(new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }))
    const outputPath = resolve(destinationPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await pipeline(object.Body, createWriteStream(outputPath))
    return {
      enabled: true,
      found: true,
      key,
      path: outputPath,
      bytes: object.ContentLength,
    }
  } catch (error) {
    if (isMissingObjectError(error)) {
      return {
        enabled: true,
        found: false,
        key,
      }
    }
    throw error
  }
}

export async function uploadDirectory(client, config, dir, destinationPrefix, publishLast) {
  const root = resolve(dir)
  const files = await listFiles(root)
  if (publishLast) {
    files.sort((left, right) => Number(relative(root, left) === publishLast) - Number(relative(root, right) === publishLast))
  }
  const uploads = []
  for (const file of files) {
    const relativePath = relative(root, file).split(sep).join('/')
    uploads.push(await uploadFile(client, config, file, `${destinationPrefix}/${relativePath}`))
  }
  return uploads
}

export async function uploadContentAddressedPublicArtifacts(client, config, dir, generationId) {
  const root = resolve(dir)
  const files = await listFiles(root)
  files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)))
  const prepared = []
  const logicalPathSources = new Map()
  let rootManifest

  for (const file of files) {
    const relativePath = relative(root, file).split(sep).join('/')
    if (extname(relativePath).toLowerCase() !== '.json') {
      throw new Error(`Content-addressed public artifact must be JSON: ${relativePath}`)
    }
    const value = JSON.parse(await readFile(file, 'utf8'))
    if (relativePath === 'ranking-summary.json') rootManifest = value
    const logicalPath = canonicalPublicLogicalPath(`/data/${relativePath}`)
    const existingSource = logicalPathSources.get(logicalPath)
    if (existingSource) {
      throw new Error(`Duplicate public artifact logical path alias: ${existingSource} and ${relativePath}`)
    }
    logicalPathSources.set(logicalPath, relativePath)
    prepared.push({
      logicalPath,
      ...prepareSemanticArtifact(value),
    })
  }
  if (!rootManifest) throw new Error('Content-addressed publication requires ranking-summary.json')

  const uploaded = []
  const unchanged = []
  const uniqueArtifacts = new Map()
  for (const artifact of prepared) {
    const existing = uniqueArtifacts.get(artifact.digest)
    if (existing && existing.canonicalJson !== artifact.canonicalJson) {
      throw new Error(`Local semantic SHA-256 collision: ${artifact.digest}`)
    }
    uniqueArtifacts.set(artifact.digest, existing ?? artifact)
  }
  const manifest = createGenerationManifest({ generationId, rootManifest, entries: prepared })
  for (const artifact of uniqueArtifacts.values()) {
    const result = await syncContentAddressedObject(client, config, artifact)
    if (result.status === 'unchanged') unchanged.push(result)
    else uploaded.push(result)
  }

  const manifestSync = await syncGenerationManifest(client, config, generationId, manifest)
  if (manifestSync.result.status === 'unchanged') unchanged.push(manifestSync.result)
  else uploaded.push(manifestSync.result)
  return {
    uploaded,
    unchanged,
    manifest,
    manifestAuthority: manifestSync.authority,
    objectCount: uniqueArtifacts.size,
    logicalArtifactCount: prepared.length,
    compressedLogicalBytes: prepared.reduce((total, artifact) => total + artifact.compressedBytes, 0),
    semanticLogicalBytes: prepared.reduce((total, artifact) => total + artifact.bytes, 0),
    uniqueCompressedBytes: [...uniqueArtifacts.values()].reduce((total, artifact) => total + artifact.compressedBytes, 0),
  }
}

/**
 * Composes a complete immutable generation from the prior logical mapping and
 * a validated set of changed values. Only content hashes absent from storage
 * are uploaded; removed logical paths are deliberately omitted.
 */
export async function uploadContentAddressedPublicArtifactPatch(client, config, {
  generationId,
  previousManifest,
  changedArtifacts,
  removedLogicalPaths = [],
  expectedLogicalPaths,
}) {
  if (previousManifest?.storageMode !== CONTENT_ADDRESSED_STORAGE_MODE || !previousManifest?.artifacts) {
    throw new Error('Content-addressed artifact patch requires a compatible previous generation manifest')
  }
  const changedByPath = new Map()
  for (const entry of changedArtifacts ?? []) {
    const logicalPath = canonicalPublicLogicalPath(entry.logicalPath)
    if (changedByPath.has(logicalPath)) throw new Error(`Duplicate changed public artifact logical path: ${logicalPath}`)
    changedByPath.set(logicalPath, { logicalPath, value: entry.value })
  }
  const root = changedByPath.get('/data/ranking-summary.json')
  if (!root) throw new Error('Content-addressed artifact patch must include ranking-summary.json for generation provenance')
  const removed = new Set(removedLogicalPaths.map((path) => canonicalPublicLogicalPath(path)))
  const entriesByPath = new Map()
  for (const [logicalPath, identity] of Object.entries(previousManifest.artifacts)) {
    const canonical = canonicalPublicLogicalPath(logicalPath)
    if (removed.has(canonical) || changedByPath.has(canonical)) continue
    if (identity?.logicalPath !== canonical || !/^[a-f0-9]{64}$/.test(identity?.sha256 ?? '')
      || !Number.isSafeInteger(identity?.bytes) || identity.bytes <= 0) {
      throw new Error(`Previous generation has an invalid logical mapping for ${canonical}`)
    }
    entriesByPath.set(canonical, { logicalPath: canonical, digest: identity.sha256, bytes: identity.bytes })
  }
  const actualPaths = [...new Set([...entriesByPath.keys(), ...changedByPath.keys()])].sort()
  if (expectedLogicalPaths) {
    const expectedPaths = [...new Set(expectedLogicalPaths.map((path) => canonicalPublicLogicalPath(path)))].sort()
    if (actualPaths.join('\u0000') !== expectedPaths.join('\u0000')) {
      const actualPathSet = new Set(actualPaths)
      const missing = expectedPaths.filter((path) => !actualPathSet.has(path))
      const unexpected = actualPaths.filter((path) => !expectedPaths.includes(path))
      throw new Error(`Incomplete public artifact patch mapping; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`)
    }
  }
  if (!actualPaths.includes('/data/ranking-summary.json')) throw new Error('Public artifact patch removed the root manifest')

  const uniqueReused = new Map()
  for (const entry of entriesByPath.values()) uniqueReused.set(entry.digest, entry)
  const uploaded = []
  const unchanged = []
  for (const entry of uniqueReused.values()) {
    const verified = await assertReferencedContentAddressedIntegrity(client, config, {
      logicalPath: entry.logicalPath,
      sha256: entry.digest,
      bytes: entry.bytes,
    }, entry.logicalPath)
    if (!hasImmutablePublicMetadata(verified)) {
      uploaded.push(await putContentAddressedObject(client, config, bucketKey(config, `objects/sha256/${entry.digest}`), {
        digest: entry.digest,
        bytes: entry.bytes,
        compressed: verified.compressed,
        compressedBytes: verified.compressed.byteLength,
      }, publicContentAddressedMetadata(entry.digest, entry.bytes), {
        reason: 'content-addressed-object-metadata-upgraded',
      }))
    }
  }
  const uniqueChanged = new Map()
  let compressedLogicalBytes = 0
  for (const artifact of changedByPath.values()) {
    const prepared = prepareSemanticArtifact(artifact.value)
    compressedLogicalBytes += prepared.compressedBytes
    const existing = uniqueChanged.get(prepared.digest)
    if (existing) {
      if (prepareSemanticArtifact(existing.value).canonicalJson !== prepared.canonicalJson) {
        throw new Error(`Local semantic SHA-256 collision: ${prepared.digest}`)
      }
    } else {
      const result = await syncContentAddressedObject(client, config, prepared)
      if (result.status === 'unchanged') unchanged.push(result)
      else uploaded.push(result)
    }
    const metadata = existing ?? { ...artifact, digest: prepared.digest, bytes: prepared.bytes, compressedBytes: prepared.compressedBytes }
    uniqueChanged.set(prepared.digest, metadata)
    entriesByPath.set(artifact.logicalPath, {
      logicalPath: artifact.logicalPath,
      digest: prepared.digest,
      bytes: prepared.bytes,
    })
  }
  const manifest = createGenerationManifest({
    generationId,
    rootManifest: root.value,
    entries: [...entriesByPath.values()],
  })
  const manifestSync = await syncGenerationManifest(client, config, generationId, manifest)
  if (manifestSync.result.status === 'unchanged') unchanged.push(manifestSync.result)
  else uploaded.push(manifestSync.result)
  const semanticLogicalBytes = [...entriesByPath.values()].reduce((sum, entry) => sum + entry.bytes, 0)
  return {
    uploaded,
    unchanged,
    manifest,
    manifestAuthority: manifestSync.authority,
    objectCount: new Set([...entriesByPath.values()].map((entry) => entry.digest)).size,
    logicalArtifactCount: entriesByPath.size,
    compressedLogicalBytes,
    semanticLogicalBytes,
    uniqueCompressedBytes: [...uniqueChanged.values()].reduce((sum, entry) => sum + entry.compressedBytes, 0),
    changedLogicalPaths: [...changedByPath.keys()].sort(),
    reusedLogicalPaths: actualPaths.filter((path) => !changedByPath.has(path)),
    removedLogicalPaths: [...removed].sort(),
  }
}

async function syncGenerationManifest(client, config, generationId, manifest) {
  const relativeKey = `generations/${safeObjectPath(generationId)}/manifest.json`
  const key = bucketKey(config, relativeKey)
  const body = jsonBody(manifest)
  const bytes = Buffer.byteLength(body)
  const digest = createHash('sha256').update(body).digest('hex')
  try {
    const put = await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentLength: bytes,
      ContentType: 'application/json; charset=utf-8',
      Metadata: { sha256: digest },
      IfNoneMatch: '*',
    }))
    return {
      result: { status: 'uploaded', key, bytes, contentType: 'application/json; charset=utf-8', digest },
      authority: { key, etag: put.ETag, bytes, digest },
    }
  } catch (error) {
    if (!isPreconditionError(error)) throw error
    const existing = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
    const existingBody = await bodyText(existing.Body)
    if (existingBody !== body) {
      throw new Error(`Generation manifest collision for generationId ${generationId}`, { cause: error })
    }
    return {
      result: {
        status: 'unchanged',
        reason: 'identical-generation-manifest-reused',
        key,
        bytes,
        contentType: 'application/json; charset=utf-8',
        digest,
      },
      authority: { key, etag: existing.ETag, bytes, digest },
    }
  }
}

async function assertGenerationManifestAuthority(client, config, authority) {
  if (!authority?.etag) throw new Error('Generation manifest authority is missing an ETag')
  const current = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: authority.key }))
  const matches = current.ETag === authority.etag
    && Number(current.ContentLength) === authority.bytes
    && current.Metadata?.sha256 === authority.digest
  if (!matches) throw new Error('Generation manifest changed before active pointer promotion')
}

async function syncContentAddressedObject(client, config, artifact) {
  const relativeKey = `objects/sha256/${artifact.digest}`
  const key = bucketKey(config, relativeKey)
  const expectedMetadata = publicContentAddressedMetadata(artifact.digest, artifact.bytes)
  const existing = await assertReferencedContentAddressedIntegrity(client, config, {
    sha256: artifact.digest,
    bytes: artifact.bytes,
    compressedBytes: artifact.compressedBytes,
  }, key, { missingIsAbsent: true })
  if (existing && hasImmutablePublicMetadata(existing)) {
    return {
      status: 'unchanged',
      reason: 'content-addressed-object-reused',
      key,
      bytes: artifact.compressedBytes,
      semanticBytes: artifact.bytes,
      contentType: 'application/json; charset=utf-8',
      contentEncoding: 'gzip',
      digest: artifact.digest,
    }
  }
  if (existing) {
    return putContentAddressedObject(client, config, key, artifact, expectedMetadata, {
      reason: 'content-addressed-object-metadata-upgraded',
    })
  }

  try {
    return await putContentAddressedObject(client, config, key, artifact, expectedMetadata, { ifNoneMatch: '*' })
  } catch (error) {
    if (!isPreconditionError(error)) throw error
    const raced = await assertReferencedContentAddressedIntegrity(client, config, {
      sha256: artifact.digest,
      bytes: artifact.bytes,
      compressedBytes: artifact.compressedBytes,
    }, key)
    if (!hasImmutablePublicMetadata(raced)) {
      return putContentAddressedObject(client, config, key, artifact, expectedMetadata, {
        reason: 'content-addressed-object-metadata-upgraded',
      })
    }
    return {
      status: 'unchanged',
      reason: 'content-addressed-object-race-reused',
      key,
      bytes: artifact.compressedBytes,
      semanticBytes: artifact.bytes,
      contentType: 'application/json; charset=utf-8',
      contentEncoding: 'gzip',
      digest: artifact.digest,
    }
  }
}

async function putContentAddressedObject(client, config, key, artifact, metadata, {
  ifNoneMatch,
  reason,
} = {}) {
  const result = await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: artifact.compressed,
    ContentLength: artifact.compressedBytes,
    ContentType: PUBLIC_JSON_CONTENT_TYPE,
    ContentEncoding: 'gzip',
    CacheControl: IMMUTABLE_PUBLIC_CACHE_CONTROL,
    Metadata: metadata,
    ...(ifNoneMatch ? { IfNoneMatch: ifNoneMatch } : {}),
  }))
  return {
    status: 'uploaded',
    ...(reason ? { reason } : {}),
    key,
    bytes: artifact.compressedBytes,
    semanticBytes: artifact.bytes,
    contentType: PUBLIC_JSON_CONTENT_TYPE,
    contentEncoding: 'gzip',
    digest: artifact.digest,
    etag: result.ETag,
  }
}

function hasImmutablePublicMetadata(remote) {
  return remote.contentType === PUBLIC_JSON_CONTENT_TYPE
    && remote.contentEncoding === 'gzip'
    && remote.cacheControl === IMMUTABLE_PUBLIC_CACHE_CONTROL
}

function publicContentAddressedMetadata(digest, bytes) {
  return { sha256: digest, 'semantic-bytes': String(bytes), encoding: 'gzip' }
}

async function assertReferencedContentAddressedIntegrity(client, config, identity, logicalPath, { missingIsAbsent = false } = {}) {
  if (!/^[a-f0-9]{64}$/.test(identity?.sha256 ?? '') || !Number.isSafeInteger(identity?.bytes) || identity.bytes <= 0) {
    throw new Error(`Invalid content-addressed object identity for ${logicalPath}`)
  }
  const key = bucketKey(config, `objects/sha256/${identity.sha256}`)
  let remote
  try {
    remote = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
  } catch (error) {
    if (missingIsAbsent && isMissingObjectError(error)) return false
    if (isMissingObjectError(error)) throw new Error(`Referenced content-addressed object is missing: ${logicalPath}`, { cause: error })
    throw error
  }
  if (!Number.isSafeInteger(Number(remote.ContentLength)) || Number(remote.ContentLength) <= 0
    || (Number.isSafeInteger(identity.compressedBytes) && Number(remote.ContentLength) !== identity.compressedBytes)
    || remote.Metadata?.sha256 !== identity.sha256
    || remote.Metadata?.['semantic-bytes'] !== String(identity.bytes) || remote.Metadata?.encoding !== 'gzip') {
    throw new Error(`Referenced content-addressed object metadata mismatch: ${logicalPath}`)
  }
  let compressedBytes = 0
  let semanticBytes = 0
  const compressedChunks = []
  const digest = createHash('sha256')
  const countCompressed = new Transform({
    transform(chunk, _encoding, callback) {
      compressedBytes += chunk.length
      compressedChunks.push(Buffer.from(chunk))
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
    throw new Error(`Referenced content-addressed object gzip is corrupt: ${logicalPath}`, { cause: error })
  }
  if (compressedBytes !== Number(remote.ContentLength)
    || semanticBytes !== identity.bytes || digest.digest('hex') !== identity.sha256) {
    throw new Error(`Referenced content-addressed object digest mismatch: ${logicalPath}`)
  }
  return {
    compressed: Buffer.concat(compressedChunks),
    contentType: remote.ContentType,
    contentEncoding: remote.ContentEncoding,
    cacheControl: remote.CacheControl,
  }
}

async function readVerifiedContentAddressedArtifact(client, config, identity, logicalPath) {
  if (!/^[a-f0-9]{64}$/.test(identity?.sha256 ?? '') || !Number.isSafeInteger(identity?.bytes) || identity.bytes <= 0) {
    throw new Error(`Invalid content-addressed object identity for ${logicalPath}`)
  }
  const key = bucketKey(config, `objects/sha256/${identity.sha256}`)
  let remote
  try {
    remote = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
  } catch (error) {
    if (isMissingObjectError(error)) throw new Error(`Referenced content-addressed object is missing: ${logicalPath}`, { cause: error })
    throw error
  }
  const compressed = await bodyBytes(remote.Body)
  if (remote.ContentEncoding !== 'gzip' || remote.Metadata?.sha256 !== identity.sha256
    || remote.Metadata?.['semantic-bytes'] !== String(identity.bytes) || remote.Metadata?.encoding !== 'gzip'
    || Number(remote.ContentLength) !== compressed.byteLength) {
    throw new Error(`Referenced content-addressed object metadata mismatch: ${logicalPath}`)
  }
  let canonicalBytes
  try { canonicalBytes = gunzipSync(compressed) } catch (error) {
    throw new Error(`Referenced content-addressed object gzip is corrupt: ${logicalPath}`, { cause: error })
  }
  if (canonicalBytes.byteLength !== identity.bytes
    || createHash('sha256').update(canonicalBytes).digest('hex') !== identity.sha256) {
    throw new Error(`Referenced content-addressed object digest mismatch: ${logicalPath}`)
  }
  const envelope = JSON.parse(canonicalBytes.toString('utf8'))
  if (envelope?.artifactKind !== 'public-semantic-artifact' || envelope?.schemaVersion !== 1
    || !envelope.content || typeof envelope.content !== 'object' || Array.isArray(envelope.content)) {
    throw new Error(`Referenced content-addressed object semantic envelope is invalid: ${logicalPath}`)
  }
  return envelope.content
}

export async function uploadRawSourceFiles(client, config, rawDir, manifestPath) {
  if (!manifestPath) return { uploaded: [], unchanged: [] }

  const root = resolve(rawDir)
  const manifest = manifestWithResolvedFiles(JSON.parse(await readFile(manifestPath, 'utf8')), root)
  const rootWithSeparator = `${root}${sep}`
  const files = uniqueValues(Object.values(manifest?.files ?? {})
    .flatMap((entries) => Array.isArray(entries) ? entries : []))
  const uploaded = []
  const unchanged = []

  for (const file of files) {
    const filePath = resolve(file)
    if (filePath !== root && !filePath.startsWith(rootWithSeparator)) {
      throw new Error(`Raw source file is outside rawDir: ${file}`)
    }
    const relativePath = relative(root, filePath).split(sep).join('/')
    const result = await syncRawFile(client, config, filePath, `raw/files/${relativePath}`)
    if (result.status === 'unchanged') unchanged.push(result)
    else uploaded.push(result)
  }

  return { uploaded, unchanged }
}

export async function syncRawFile(client, config, filePath, relativeKey) {
  const key = bucketKey(config, relativeKey)
  const snapshotDir = await mkdtemp(join(tmpdir(), 'ranking-raw-upload-'))
  const snapshotPath = join(snapshotDir, basename(filePath))

  try {
    const sourceBeforeCopy = await stat(filePath)
    await copyFile(filePath, snapshotPath)
    const sourceAfterCopy = await stat(filePath)
    assertStableFile(sourceBeforeCopy, sourceAfterCopy, filePath)
    const snapshotStat = await stat(snapshotPath)
    const digest = await sha256File(snapshotPath)

    try {
      const remote = await client.send(new HeadObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }))
      if (remote.ContentLength === snapshotStat.size && remote.Metadata?.sha256 === digest) {
        return {
          status: 'unchanged',
          reason: 'unchanged-content',
          key,
          bytes: snapshotStat.size,
          contentType: contentTypeForPath(filePath),
          digest,
        }
      }
    } catch {
      // A missing object or unverifiable comparison must upload to preserve recovery correctness.
    }

    return await uploadFile(client, config, snapshotPath, relativeKey, {
      metadata: { sha256: digest },
      digest,
      expectedStat: snapshotStat,
      contentType: contentTypeForPath(filePath),
    })
  } finally {
    await rm(snapshotDir, { recursive: true, force: true })
  }
}

export async function uploadFile(client, config, filePath, relativeKey, { metadata, digest, expectedStat, contentType } = {}) {
  const fileStat = await stat(filePath)
  if (expectedStat) assertStableFile(expectedStat, fileStat, filePath)
  const key = bucketKey(config, relativeKey)
  const resolvedContentType = contentType ?? contentTypeForPath(filePath)
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: createReadStream(filePath),
    ContentLength: fileStat.size,
    ContentType: resolvedContentType,
    ...(metadata ? { Metadata: metadata } : {}),
  }))
  return {
    status: 'uploaded',
    key,
    bytes: fileStat.size,
    contentType: resolvedContentType,
    ...(digest ? { digest } : {}),
  }
}

export async function uploadJson(client, config, relativeKey, value) {
  return uploadJsonBody(client, config, relativeKey, jsonBody(value))
}

async function uploadJsonBody(client, config, relativeKey, body) {
  const key = bucketKey(config, relativeKey)
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: 'application/json; charset=utf-8',
  }))
  return {
    key,
    bytes: Buffer.byteLength(body),
    contentType: 'application/json; charset=utf-8',
  }
}

async function uploadRefreshState(client, config, refreshStateForUpload, { uploads, unchanged, skipped, promotion, refreshTelemetry, storage }) {
  let stateBytes = 0
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const projectedState = {
      key: bucketKey(config, 'raw/refresh-state.json'),
      bytes: stateBytes,
    }
    const metrics = publishMetricsFor([...uploads, projectedState], unchanged)
    const body = jsonBody(refreshStateForUpload({
      bucket: config.bucket,
      prefix: config.prefix,
      ...metrics,
      skipped,
      promotion,
      refreshTelemetry,
      storage,
    }))
    const nextBytes = Buffer.byteLength(body)
    if (nextBytes === stateBytes) return uploadJsonBody(client, config, 'raw/refresh-state.json', body)
    stateBytes = nextBytes
  }
  throw new Error('Refresh-state upload metrics did not stabilize')
}

export async function deleteObject(relativeKey, {
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
} = {}) {
  if (!config.enabled || !client) return false
  await client.send(new DeleteObjectCommand({
    Bucket: config.bucket,
    Key: bucketKey(config, relativeKey),
  }))
  return true
}

export function bucketKey(config, relativeKey) {
  const key = safeObjectPath(relativeKey)
  return config.prefix ? `${config.prefix}/${key}` : key
}

export function safeObjectPath(path) {
  if (!path) return ''
  const normalized = posix.normalize(String(path).replaceAll('\\', '/')).replace(/^(\.\.\/)+/, '')
  if (normalized === '.') return ''
  return normalized.replace(/^\/+/, '')
}

export function safeRequestedObjectPath(path) {
  const value = String(path ?? '')
  if (!value || value.includes('\\')) throw new Error('Invalid bucket object path')
  const segments = value.split('/')
  if (segments.some((segment) => segment.length === 0)) throw new Error('Invalid bucket object path')

  for (const segment of segments) {
    let decoded
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      throw new Error('Invalid bucket object path')
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw new Error('Invalid bucket object path')
    }
  }

  return value
}

export function contentTypeForPath(path) {
  switch (extname(path).toLowerCase()) {
    case '.css':
      return 'text/css; charset=utf-8'
    case '.html':
      return 'text/html; charset=utf-8'
    case '.ico':
      return 'image/x-icon'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.webmanifest':
      return 'application/manifest+json; charset=utf-8'
    case '.png':
      return 'image/png'
    case '.svg':
      return 'image/svg+xml'
    case '.txt':
      return 'text/plain; charset=utf-8'
    case '.webp':
      return 'image/webp'
    case '.xml':
      return 'application/xml; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function normalizePrefix(value) {
  return safeObjectPath(value ?? '').replace(/\/$/, '')
}

function parseBoolean(value) {
  return value === true || value === 'true' || value === '1'
}

function uniqueValues(values) {
  return Array.from(new Set(values.filter((value) => value !== undefined && value !== null)))
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

function sumBytes(entries) {
  return entries.reduce((total, entry) => total + (Number(entry?.bytes) || 0), 0)
}

function publishMetricsFor(uploaded, unchanged) {
  return {
    artifactCount: uploaded.length + unchanged.length,
    uploadedCount: uploaded.length,
    uploadedBytes: sumBytes(uploaded),
    unchangedCount: unchanged.length,
    unchangedBytes: sumBytes(unchanged),
  }
}

function byteCounts(entries) {
  return { uploadedCount: entries.length, uploadedBytes: sumBytes(entries) }
}

function jsonBody(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function assertStableFile(before, after, filePath) {
  if (before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`Raw source file changed while preparing upload: ${filePath}`)
  }
}

function isMissingObjectError(error) {
  return error?.name === 'NoSuchKey'
    || error?.name === 'NotFound'
    || error?.$metadata?.httpStatusCode === 404
}

async function activeGeneration(config, client) {
  if (activeGenerationCache.expiresAt > Date.now()) return activeGenerationCache.value
  try {
    const object = await client.send(new GetObjectCommand({
      Bucket: config.bucket,
      Key: bucketKey(config, 'active-generation.json'),
    }))
    const value = JSON.parse(await bodyText(object.Body))
    activeGenerationCache = {
      expiresAt: Date.now() + 30_000,
      value: typeof value?.generationId === 'string' ? value.generationId : null,
    }
  } catch (error) {
    if (!isMissingObjectError(error)) throw error
    activeGenerationCache = { expiresAt: Date.now() + 30_000, value: null }
  }
  return activeGenerationCache.value
}

function isPreconditionError(error) {
  return error?.name === 'PreconditionFailed' || error?.$metadata?.httpStatusCode === 412
}

async function bodyText(body) {
  if (typeof body?.transformToString === 'function') return body.transformToString()
  return (await bodyBytes(body)).toString('utf8')
}

async function bodyBytes(body) {
  if (typeof body?.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray())
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body)
  const chunks = []
  for await (const chunk of body ?? []) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
