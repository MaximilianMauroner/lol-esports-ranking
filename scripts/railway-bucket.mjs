import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { basename, dirname, extname, join, posix, relative, resolve, sep } from 'node:path'
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { manifestWithResolvedFiles } from './local-data-manifest.js'

const activeGenerationCaches = new WeakMap()

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
  privateState,
  rollout,
  rolloutForActive,
  publishGeneration = true,
  leaseGuard,
  rolloutUpdateId,
  clock = () => new Date(),
  beforeActivePointerCas,
  rawRetentionDays = positiveInteger(process.env.RANKING_DURABLE_RETENTION_DAYS) ?? 35,
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
  const dataPrefix = generationId ? `generations/${safeObjectPath(generationId)}/data` : 'data'
  let active
  let idempotentGeneration = false
  if (!publishGeneration && rolloutForActive && fencingToken) {
    await requirePromotionLease(leaseGuard, { config, client, now: clock() })
  }
  if (generationId && publishGeneration) {
    await requirePromotionLease(leaseGuard, { config, client, now: clock() })
    active = await readBucketJson('active-generation.json', { config, client })
    const currentFence = Number(active.value?.fencingToken ?? 0)
    const incomingFence = Number(fencingToken ?? 0)
    if (!Number.isFinite(incomingFence) || incomingFence <= 0 || currentFence > incomingFence) {
      throw new Error('Stale refresh worker cannot promote an active generation')
    }
    if (currentFence === incomingFence) {
      if (active.value?.generationId === generationId) idempotentGeneration = true
      else if (!leaseGuard
        || active.value?.refreshLease?.owner !== leaseGuard.owner
        || Number(active.value?.refreshLease?.fencingToken) !== incomingFence) {
        throw new Error('Equal fencing token cannot promote a different generation')
      }
    }
  }
  if (!publishGeneration && !rolloutForActive) {
    return {
      enabled: true,
      bucket: config.bucket,
      prefix: config.prefix,
      uploaded: [],
      unchanged: [],
      skipped: [],
      promotion: { promoted: false, reason: 'semantic-no-change' },
      artifactCount: 0,
      uploadedCount: 0,
      uploadedBytes: 0,
      unchangedCount: 0,
      unchangedBytes: 0,
    }
  }
  if (publishGeneration) {
    const publicSync = await uploadDirectory(client, config, publicDataDir, dataPrefix, 'ranking-summary.json', { immutable: Boolean(generationId) })
    uploads.push(...publicSync.filter((entry) => entry.status !== 'unchanged'))
    unchanged.push(...publicSync.filter((entry) => entry.status === 'unchanged'))
  }
  let rawState
  if (rawDir && generationId && manifestPath) {
    if (idempotentGeneration && active.value?.rawState) {
      rawState = active.value.rawState
    } else {
      const rawCreatedAt = new Date(clock()).toISOString()
      const rawSync = await stageRawGeneration(client, config, {
        rawDir,
        manifestPath,
        statePath,
        createdAt: rawCreatedAt,
        boundaries: privateState?.retention?.boundaries ?? [],
      })
      rawState = rawSync.rawState
      uploads.push(...rawSync.uploaded)
      unchanged.push(...rawSync.unchanged)
    }
  } else if (rawDir && publishGeneration) {
    const rawSync = await uploadRawSourceFiles(client, config, rawDir, manifestPath)
    uploads.push(...rawSync.uploaded)
    unchanged.push(...rawSync.unchanged)
  }

  if (fullSnapshotPath && uploadFullSnapshot) {
    uploads.push(await uploadFile(client, config, fullSnapshotPath, 'artifacts/latest-full.json'))
  } else if (fullSnapshotPath) {
    skipped.push({
      key: bucketKey(config, 'artifacts/latest-full.json'),
      reason: 'full-snapshot-upload-disabled',
    })
  }
  if (manifestPath && publishGeneration && !generationId) {
    uploads.push(await uploadFile(client, config, manifestPath, 'raw/manifest.json'))
  }
  if (statePath && publishGeneration && !generationId) {
    if (refreshStateForUpload) {
      uploads.push(await uploadRefreshState(client, config, refreshStateForUpload, { uploads, unchanged, skipped }))
    } else {
      uploads.push(await uploadFile(client, config, statePath, 'raw/refresh-state.json'))
    }
  }
  const publishedArtifacts = [...uploads]
  const publishMetrics = publishMetricsFor(publishedArtifacts, unchanged)

  const publishReceipt = {
    schemaVersion: 1,
    ...(generationId ? {} : { publishedAt: new Date().toISOString() }),
    prefix: config.prefix,
    ...(generationId ? { generationId } : {}),
    ...publishMetrics,
    artifacts: publishedArtifacts.map(({ key, bytes, contentType }) => ({ key, bytes, contentType })),
    unchanged: unchanged.map(({ key, bytes, contentType, digest }) => ({ key, bytes, contentType, digest })),
    skipped,
  }
  if (generationId && publishGeneration) {
    const generationReceiptKey = `generations/${safeObjectPath(generationId)}/publish.json`
    if (idempotentGeneration) {
      const existingReceipt = await readBucketBytes(generationReceiptKey, { config, client })
      if (!existingReceipt.found) throw new Error('Idempotent generation is missing its immutable publish receipt')
    } else {
      await uploadImmutableJson(client, config, generationReceiptKey, publishReceipt)
    }
  } else {
    await uploadJson(client, config, 'latest-publish.json', publishReceipt)
  }
  if (generationId && publishGeneration) {
    await requirePromotionLease(leaseGuard, { config, client, now: clock() })
    active = await readBucketJson('active-generation.json', { config, client })
    const finalFence = Number(active.value?.fencingToken ?? 0)
    const incomingFence = Number(fencingToken ?? 0)
    if (finalFence > incomingFence) throw new Error('Stale refresh worker cannot promote an active generation')
    if (finalFence === incomingFence
      && active.value?.generationId !== generationId
      && (!leaseGuard
        || active.value?.refreshLease?.owner !== leaseGuard.owner
        || Number(active.value?.refreshLease?.fencingToken) !== incomingFence)) {
      throw new Error('Equal fencing token cannot promote a different generation')
    }
    const rolloutAlreadyApplied = Boolean(rolloutUpdateId && active.value?.rolloutUpdateId === rolloutUpdateId)
    const resolvedRollout = rolloutAlreadyApplied
      ? active.value?.rollout
      : rolloutForActive ? rolloutForActive(active.value?.rollout) : rollout
    const promotedAt = new Date().toISOString()
    const nextPointer = {
      ...(active.value && typeof active.value === 'object' && !Array.isArray(active.value) ? active.value : {}),
      schemaVersion: 1,
      generationId,
      fencingToken,
      promotedAt,
      manifestKey: bucketKey(config, `${dataPrefix}/ranking-summary.json`),
      ...(privateState ? { privateState } : {}),
      ...(rawState ? { rawState } : {}),
      ...(rawState ? { rawHistory: activatedRawHistory(active.value, rawState, promotedAt, rawRetentionDays) } : {}),
      ...(resolvedRollout ? { rollout: resolvedRollout } : {}),
      ...(rolloutUpdateId ? { rolloutUpdateId } : {}),
      ...(privateState ? { durableHistory: activatedDurableHistory(active.value, privateState, promotedAt) } : {}),
    }
    if (idempotentGeneration) {
      if (active.value?.manifestKey !== nextPointer.manifestKey
        || (privateState && stableObjectJson(active.value?.privateState) !== stableObjectJson(privateState))
        || (rawState && stableObjectJson(active.value?.rawState) !== stableObjectJson(rawState))) {
        throw new Error('Same-generation retry does not match the active generation identity')
      }
      setActiveGenerationCache(config, client, generationId)
      return {
        enabled: true,
        bucket: config.bucket,
        prefix: config.prefix,
        uploaded: uploads,
        unchanged,
        skipped,
        promotion: { promoted: false, idempotent: true, generationId, fencingToken },
        ...publishMetrics,
      }
    }
    if (beforeActivePointerCas) await beforeActivePointerCas()
    const promotion = await writeBucketJson('active-generation.json', nextPointer, {
      config,
      client,
      ...(active.found ? { ifMatch: active.etag } : { ifNoneMatch: '*' }),
    })
    if (!promotion.written) throw new Error('Active generation changed during promotion')
    setActiveGenerationCache(config, client, generationId)
  }
  let rolloutUpdated = false
  if (!publishGeneration && rolloutForActive && fencingToken) {
    await requirePromotionLease(leaseGuard, { config, client, now: clock() })
    const current = await readBucketJson('active-generation.json', { config, client })
    if (!current.found || !current.etag) throw new Error('Semantic no-change rollout update requires an active generation')
    const currentFence = Number(current.value?.fencingToken ?? 0)
    if (currentFence > Number(fencingToken)) throw new Error('Stale refresh worker cannot update rollout metadata')
    if (!rolloutUpdateId || current.value?.rolloutUpdateId !== rolloutUpdateId) {
      const nextPointer = {
        ...current.value,
        fencingToken: Number(fencingToken),
        rollout: rolloutForActive(current.value?.rollout),
        rolloutUpdatedAt: new Date().toISOString(),
        ...(rolloutUpdateId ? { rolloutUpdateId } : {}),
      }
      if (beforeActivePointerCas) await beforeActivePointerCas()
      const update = await writeBucketJson('active-generation.json', nextPointer, { config, client, ifMatch: current.etag })
      if (!update.written) throw new Error('Active generation changed during rollout metadata update')
      rolloutUpdated = true
      setActiveGenerationCache(config, client, current.value?.generationId ?? null)
    }
  }

  return {
    enabled: true,
    bucket: config.bucket,
    prefix: config.prefix,
    uploaded: uploads,
    unchanged,
    skipped,
    promotion: generationId && publishGeneration
      ? { promoted: true, generationId, fencingToken }
      : { promoted: false, reason: publishGeneration ? 'unversioned-upload' : 'semantic-no-change', ...(rolloutUpdated ? { rolloutUpdated: true } : {}) },
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
  const generation = typeof generationId === 'string' && generationId.length > 0
    ? generationId
    : await activeGeneration(config, client)
  const keys = [
    ...(generation ? [bucketKey(config, `generations/${safeObjectPath(generation)}/data/${safePath}`)] : []),
    ...(generationId ? [] : [bucketKey(config, `data/${safePath}`)]),
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
        etag: object.ETag,
        lastModified: object.LastModified,
      }
    } catch (error) {
      if (!isMissingObjectError(error)) throw error
    }
  }
  return { found: false, key: keys[0] }
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

export async function readBucketBytes(relativeKey, {
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
} = {}) {
  if (!config.enabled || !client) return { found: false, missingConfig: config.missing ?? [] }
  const key = bucketKey(config, relativeKey)
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
    const bytes = await bodyBytes(object.Body)
    return {
      found: true,
      key,
      etag: object.ETag,
      bytes,
      contentLength: object.ContentLength ?? bytes.byteLength,
      metadata: object.Metadata ?? {},
    }
  } catch (error) {
    if (isMissingObjectError(error)) return { found: false, key }
    throw error
  }
}

export async function headBucketObject(relativeKey, {
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
} = {}) {
  if (!config.enabled || !client) return { found: false, missingConfig: config.missing ?? [] }
  const key = bucketKey(config, relativeKey)
  try {
    let object
    try {
      object = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key, ChecksumMode: 'ENABLED' }))
    } catch (error) {
      if (!isUnsupportedChecksumError(error)) throw error
      object = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))
    }
    const storageVerifiedSha256 = checksumBase64ToHex(object.ChecksumSHA256)
    return {
      found: true,
      key,
      etag: object.ETag,
      contentLength: object.ContentLength,
      metadata: object.Metadata ?? {},
      ...(storageVerifiedSha256 ? { storageVerifiedSha256 } : {}),
    }
  } catch (error) {
    if (isMissingObjectError(error)) return { found: false, key }
    throw error
  }
}

export async function writeBucketBytes(relativeKey, bytes, {
  ifMatch,
  ifNoneMatch,
  metadata,
  checksumSHA256,
  contentType = 'application/octet-stream',
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
} = {}) {
  if (!config.enabled || !client) return { written: false, missingConfig: config.missing ?? [] }
  const key = bucketKey(config, relativeKey)
  const body = Buffer.from(bytes)
  try {
    const input = {
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentLength: body.byteLength,
      ContentType: contentType,
      ...(checksumSHA256 ? { ChecksumSHA256: checksumSHA256 } : {}),
      ...(metadata ? { Metadata: metadata } : {}),
      ...(ifMatch ? { IfMatch: ifMatch } : {}),
      ...(ifNoneMatch ? { IfNoneMatch: ifNoneMatch } : {}),
    }
    let result
    try {
      result = await client.send(new PutObjectCommand(input))
    } catch (error) {
      if (!checksumSHA256 || !isUnsupportedChecksumError(error)) throw error
      const fallbackInput = { ...input }
      delete fallbackInput.ChecksumSHA256
      result = await client.send(new PutObjectCommand(fallbackInput))
    }
    return { written: true, key, etag: result.ETag, bytes: body.byteLength }
  } catch (error) {
    if (isPreconditionError(error)) return { written: false, conflict: true, key }
    throw error
  }
}

export async function listBucketKeys(relativePrefix, {
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
} = {}) {
  if (!config.enabled || !client) return { enabled: false, keys: [], missingConfig: config.missing ?? [] }
  const rootPrefix = bucketKey(config, relativePrefix).replace(/\/?$/, '/')
  const keys = []
  let continuationToken
  do {
    const result = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: rootPrefix,
      ContinuationToken: continuationToken,
    }))
    for (const object of result.Contents ?? []) {
      if (!object.Key || object.Key.endsWith('/')) continue
      keys.push({
        key: object.Key.slice(config.prefix ? `${config.prefix}/`.length : 0),
        bytes: object.Size ?? 0,
      })
    }
    continuationToken = result.NextContinuationToken
  } while (continuationToken)
  return { enabled: true, keys }
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
  fenceActiveKey,
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
  beforeAuthorityCas,
  afterMirrorPut,
} = {}) {
  if (fenceActiveKey) {
    return acquireAuthoritativeBucketLease(relativeKey, fenceActiveKey, {
      owner,
      ttlMs,
      now,
      config,
      client,
      beforeAuthorityCas,
      afterMirrorPut,
    })
  }
  const current = await readBucketJson(relativeKey, { config, client })
  const nowMs = new Date(now).getTime()
  if (current.found && new Date(current.value?.expiresAt).getTime() > nowMs && current.value?.owner !== owner) {
    return { acquired: false, reason: 'active-lease', lease: current.value }
  }
  const lease = {
    schemaVersion: 1,
    owner,
    fencingToken: Number(current.value?.fencingToken ?? 0) + 1,
    acquiredAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
  }
  const write = await writeBucketJson(relativeKey, lease, {
    config,
    client,
    ...(current.found ? { ifMatch: current.etag } : { ifNoneMatch: '*' }),
  })
  if (!write.written) return { acquired: false, reason: write.conflict ? 'lease-race' : 'bucket-unavailable' }
  return { acquired: true, lease, etag: write.etag }
}

export async function releaseBucketLease(relativeKey, lease, {
  now = new Date(),
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
} = {}) {
  if (!lease?.lease) return { released: false, reason: 'invalid-lease' }
  if (lease.authorityKey) {
    const authority = await readBucketJson(lease.authorityKey, { config, client })
    const embedded = authority.value?.refreshLease
    if (!authority.found || !authority.etag
      || embedded?.key !== relativeKey
      || embedded?.owner !== lease.lease.owner
      || Number(embedded?.fencingToken) !== Number(lease.lease.fencingToken)) {
      return { released: false, reason: 'lease-changed' }
    }
    const releasedAt = new Date(now).toISOString()
    const next = {
      ...authority.value,
      refreshLease: {
        ...embedded,
        expiresAt: releasedAt,
        releasedAt,
      },
    }
    const write = await writeBucketJson(lease.authorityKey, next, {
      config,
      client,
      ifMatch: authority.etag,
    })
    if (!write.written) return { released: false, reason: write.conflict ? 'lease-changed' : 'bucket-unavailable' }
    await writeLeaseMirror(relativeKey, next.refreshLease, { config, client })
    return { released: true, etag: write.etag }
  }
  if (!lease.etag) return { released: false, reason: 'invalid-lease' }
  const releasedAt = new Date(now).toISOString()
  const write = await writeBucketJson(relativeKey, {
    ...lease.lease,
    expiresAt: releasedAt,
    releasedAt,
  }, {
    config,
    client,
    ifMatch: lease.etag,
  })
  return write.written
    ? { released: true, etag: write.etag }
    : { released: false, reason: write.conflict ? 'lease-changed' : 'bucket-unavailable' }
}

export async function verifyBucketLease(relativeKey, expected, {
  now = new Date(),
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
} = {}) {
  if (!expected || !config.enabled || !client) return { valid: false, reason: 'invalid-lease-guard' }
  const authorityKey = expected.authorityKey
  const current = await readBucketJson(authorityKey ?? relativeKey, { config, client })
  if (!current.found) return { valid: false, reason: 'lease-missing' }
  const currentLease = authorityKey ? current.value?.refreshLease : current.value
  if (authorityKey && currentLease?.key !== relativeKey) return { valid: false, reason: 'lease-key-changed' }
  if (!authorityKey && expected.etag && current.etag !== expected.etag) return { valid: false, reason: 'lease-etag-changed' }
  if (currentLease?.owner !== expected.owner
    || Number(currentLease?.fencingToken) !== Number(expected.fencingToken)) {
    return { valid: false, reason: 'lease-owner-changed' }
  }
  if (new Date(currentLease?.expiresAt).getTime() <= new Date(now).getTime()) {
    return { valid: false, reason: 'lease-expired' }
  }
  return { valid: true, lease: currentLease, etag: current.etag }
}

export async function verifyBucketRefreshAuthority(relativeKey, expected, options = {}) {
  if (expected?.authorityKey !== 'active-generation.json') {
    return { valid: false, reason: 'invalid-refresh-lease-authority' }
  }
  const verified = await verifyBucketLease(relativeKey, expected, options)
  if (!verified.valid) return verified
  const authority = await readBucketJson('active-generation.json', options)
  if (authority.value?.maintenance) return { valid: false, reason: 'maintenance-active' }
  return verified
}

export async function acquireBucketMaintenance({
  owner,
  now = new Date(),
  authorityKey = 'active-generation.json',
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
} = {}) {
  if (!owner || !config.enabled || !client) return { acquired: false, reason: 'invalid-maintenance-request' }
  const nowMs = new Date(now).getTime()
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const active = await readBucketJson(authorityKey, { config, client })
    const current = active.value && typeof active.value === 'object' && !Array.isArray(active.value) ? active.value : {}
    if (current.maintenance) {
      if (current.maintenance.owner === owner) {
        return { acquired: true, maintenance: current.maintenance, authorityKey, etag: active.etag, idempotent: true }
      }
      return { acquired: false, reason: 'maintenance-active', maintenance: current.maintenance }
    }
    const refreshLease = current.refreshLease
    if (new Date(refreshLease?.expiresAt).getTime() > nowMs) {
      return { acquired: false, reason: 'active-refresh-lease', lease: refreshLease }
    }
    const fencingToken = Math.max(Number(current.fencingToken ?? 0), Number(refreshLease?.fencingToken ?? 0)) + 1
    const acquiredAt = new Date(nowMs).toISOString()
    const maintenance = { kind: 'ranking-state-gc', owner, fencingToken, acquiredAt, heartbeatAt: acquiredAt }
    const write = await writeBucketJson(authorityKey, {
      ...current,
      schemaVersion: 1,
      fencingToken,
      maintenance,
    }, {
      config,
      client,
      ...(active.found ? { ifMatch: active.etag } : { ifNoneMatch: '*' }),
    })
    if (write.written) return { acquired: true, maintenance, authorityKey, etag: write.etag }
    if (!write.conflict) return { acquired: false, reason: 'bucket-unavailable' }
  }
  return { acquired: false, reason: 'maintenance-race' }
}

export async function verifyBucketMaintenance(expected, {
  authorityKey = 'active-generation.json',
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
} = {}) {
  if (!expected?.owner || !Number.isFinite(Number(expected?.fencingToken))) return { valid: false, reason: 'invalid-maintenance-guard' }
  const active = await readBucketJson(authorityKey, { config, client })
  const maintenance = active.value?.maintenance
  if (!active.found || !active.etag || maintenance?.kind !== 'ranking-state-gc'
    || maintenance.owner !== expected.owner
    || Number(maintenance.fencingToken) !== Number(expected.fencingToken)) {
    return { valid: false, reason: 'maintenance-changed' }
  }
  return { valid: true, maintenance, etag: active.etag, activePointer: active.value }
}

export async function releaseBucketMaintenance(expected, options = {}) {
  const authorityKey = options.authorityKey ?? 'active-generation.json'
  const verified = await verifyBucketMaintenance(expected, { ...options, authorityKey })
  if (!verified.valid) return { released: false, reason: verified.reason }
  const next = { ...verified.activePointer }
  delete next.maintenance
  const write = await writeBucketJson(authorityKey, next, { ...options, ifMatch: verified.etag })
  return write.written
    ? { released: true, etag: write.etag }
    : { released: false, reason: write.conflict ? 'maintenance-changed' : 'bucket-unavailable' }
}

export async function recoverBucketMaintenance(expected, { confirmedTerminated = false, ...options } = {}) {
  if (!confirmedTerminated) return { released: false, reason: 'operator-confirmation-required' }
  return releaseBucketMaintenance(expected, options)
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

export async function uploadDirectory(client, config, dir, destinationPrefix, publishLast, { immutable = false } = {}) {
  const root = resolve(dir)
  const files = await listFiles(root)
  if (publishLast) {
    files.sort((left, right) => Number(relative(root, left) === publishLast) - Number(relative(root, right) === publishLast))
  }
  const uploads = []
  for (const file of files) {
    const relativePath = relative(root, file).split(sep).join('/')
    uploads.push(immutable
      ? await uploadImmutableFile(client, config, file, `${destinationPrefix}/${relativePath}`)
      : await uploadFile(client, config, file, `${destinationPrefix}/${relativePath}`))
  }
  return uploads
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

async function stageRawGeneration(client, config, { rawDir, manifestPath, statePath, createdAt, boundaries }) {
  const root = resolve(rawDir)
  const manifest = manifestWithResolvedFiles(JSON.parse(await readFile(manifestPath, 'utf8')), root)
  const rootWithSeparator = `${root}${sep}`
  const uploaded = []
  const unchanged = []
  const objects = []
  const logicalFiles = {}
  for (const [kind, paths] of Object.entries(manifest.files ?? {})) {
    if (!Array.isArray(paths)) continue
    logicalFiles[kind] = []
    for (const path of paths) {
      const filePath = resolve(path)
      if (filePath !== root && !filePath.startsWith(rootWithSeparator)) throw new Error(`Raw source file is outside rawDir: ${path}`)
      const logicalPath = relative(root, filePath).split(sep).join('/')
      const bytes = await readFile(filePath)
      const digest = sha256Bytes(bytes)
      const result = await uploadImmutableBytes(client, config, `raw/objects/${digest}`, bytes, contentTypeForPath(filePath), digest, createdAt)
      ;(result.status === 'unchanged' ? unchanged : uploaded).push(result)
      objects.push({ kind: 'source', logicalPath, key: `raw/objects/${digest}`, digest, bytes: bytes.byteLength })
      logicalFiles[kind].push(logicalPath)
    }
  }
  const logicalManifest = { ...manifest, files: logicalFiles }
  const manifestBytes = Buffer.from(jsonBody(logicalManifest))
  const manifestDigest = sha256Bytes(manifestBytes)
  const manifestResult = await uploadImmutableBytes(client, config, `raw/objects/${manifestDigest}`, manifestBytes, 'application/json; charset=utf-8', manifestDigest, createdAt)
  ;(manifestResult.status === 'unchanged' ? unchanged : uploaded).push(manifestResult)
  objects.push({ kind: 'manifest', logicalPath: 'manifest.json', key: `raw/objects/${manifestDigest}`, digest: manifestDigest, bytes: manifestBytes.byteLength })
  if (statePath) {
    const stateBytes = await readFile(statePath)
    const stateDigest = sha256Bytes(stateBytes)
    const stateResult = await uploadImmutableBytes(client, config, `raw/objects/${stateDigest}`, stateBytes, 'application/json; charset=utf-8', stateDigest, createdAt)
    ;(stateResult.status === 'unchanged' ? unchanged : uploaded).push(stateResult)
    objects.push({ kind: 'refresh-state', logicalPath: 'refresh-state.json', key: `raw/objects/${stateDigest}`, digest: stateDigest, bytes: stateBytes.byteLength })
  }
  objects.sort((left, right) => `${left.kind}:${left.logicalPath}`.localeCompare(`${right.kind}:${right.logicalPath}`))
  const descriptor = {
    schemaVersion: 1,
    kind: 'raw-generation',
    createdAt,
    retention: { date: createdAt.slice(0, 10), boundaries: [...new Set(boundaries)].sort() },
    objects,
  }
  const descriptorBytes = Buffer.from(jsonBody(descriptor))
  const descriptorDigest = sha256Bytes(descriptorBytes)
  const descriptorKey = `raw/generations/${descriptorDigest}.json`
  const descriptorResult = await uploadImmutableBytes(client, config, descriptorKey, descriptorBytes, 'application/json; charset=utf-8', descriptorDigest, createdAt)
  ;(descriptorResult.status === 'unchanged' ? unchanged : uploaded).push(descriptorResult)
  return {
    uploaded,
    unchanged,
    rawState: {
      descriptorKey,
      descriptorDigest,
      descriptorBytes: descriptorBytes.byteLength,
      createdAt,
      date: createdAt.slice(0, 10),
      boundaries: [...new Set(boundaries)].sort(),
    },
  }
}

async function uploadImmutableBytes(client, config, relativeKey, bytes, contentType, digest, createdAt) {
  const result = await writeBucketBytes(relativeKey, bytes, {
    config,
    client,
    ifNoneMatch: '*',
    contentType,
    checksumSHA256: Buffer.from(digest, 'hex').toString('base64'),
    metadata: { sha256: digest, ...(createdAt ? { 'created-at': createdAt } : {}) },
  })
  if (result.written) return { status: 'uploaded', key: result.key, bytes: bytes.byteLength, contentType, digest }
  const existingHead = await headBucketObject(relativeKey, { config, client })
  if (existingHead.found && existingHead.contentLength === bytes.byteLength) {
    if (existingHead.storageVerifiedSha256 === digest) {
      return { status: 'unchanged', key: existingHead.key, bytes: bytes.byteLength, contentType, digest }
    }
    if (typeof existingHead.storageVerifiedSha256 === 'string') {
      throw new Error(`Immutable raw object collision: ${relativeKey}`)
    }
  }
  const existing = await readBucketBytes(relativeKey, { config, client })
  if (!existing.found || existing.contentLength !== bytes.byteLength || sha256Bytes(existing.bytes) !== digest) {
    throw new Error(`Immutable raw object collision: ${relativeKey}`)
  }
  return { status: 'unchanged', key: existing.key, bytes: bytes.byteLength, contentType, digest }
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

async function uploadImmutableJson(client, config, relativeKey, value) {
  const body = jsonBody(value)
  const result = await writeBucketBytes(relativeKey, body, {
    config,
    client,
    ifNoneMatch: '*',
    contentType: 'application/json; charset=utf-8',
  })
  if (result.written) return result
  const existing = await readBucketBytes(relativeKey, { config, client })
  if (!existing.found || !Buffer.from(existing.bytes).equals(Buffer.from(body))) {
    throw new Error(`Immutable generation object collision: ${relativeKey}`)
  }
  return { ...result, written: false, unchanged: true, bytes: Buffer.byteLength(body) }
}

async function uploadImmutableFile(client, config, filePath, relativeKey) {
  const bytes = await readFile(filePath)
  const result = await writeBucketBytes(relativeKey, bytes, {
    config,
    client,
    ifNoneMatch: '*',
    contentType: contentTypeForPath(filePath),
  })
  if (result.written) return { status: 'uploaded', key: result.key, bytes: bytes.byteLength, contentType: contentTypeForPath(filePath) }
  const existing = await readBucketBytes(relativeKey, { config, client })
  if (!existing.found || !Buffer.from(existing.bytes).equals(bytes)) {
    throw new Error(`Immutable generation object collision: ${relativeKey}`)
  }
  return { status: 'unchanged', key: result.key, bytes: bytes.byteLength, contentType: contentTypeForPath(filePath) }
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

async function uploadRefreshState(client, config, refreshStateForUpload, { uploads, unchanged, skipped }) {
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

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function sumBytes(entries) {
  return entries.reduce((total, entry) => total + (entry.bytes ?? 0), 0)
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
  const cached = getActiveGenerationCache(config, client)
  if (cached?.expiresAt > Date.now()) return cached.value
  try {
    const object = await client.send(new GetObjectCommand({
      Bucket: config.bucket,
      Key: bucketKey(config, 'active-generation.json'),
    }))
    const value = JSON.parse(await bodyText(object.Body))
    setActiveGenerationCache(config, client, typeof value?.generationId === 'string' ? value.generationId : null)
  } catch (error) {
    if (!isMissingObjectError(error)) throw error
    setActiveGenerationCache(config, client, null)
  }
  return getActiveGenerationCache(config, client)?.value ?? null
}

function activeGenerationCacheKey(config) {
  return `${config.bucket}\0${config.prefix}`
}

function getActiveGenerationCache(config, client) {
  return activeGenerationCaches.get(client)?.get(activeGenerationCacheKey(config))
}

function setActiveGenerationCache(config, client, value) {
  let clientCache = activeGenerationCaches.get(client)
  if (!clientCache) {
    clientCache = new Map()
    activeGenerationCaches.set(client, clientCache)
  }
  clientCache.set(activeGenerationCacheKey(config), { expiresAt: Date.now() + 30_000, value })
}

function isPreconditionError(error) {
  return error?.name === 'PreconditionFailed' || error?.$metadata?.httpStatusCode === 412
}

function isUnsupportedChecksumError(error) {
  return error?.name === 'NotImplemented'
    || error?.name === 'InvalidRequest'
    || error?.name === 'InvalidArgument'
    || error?.$metadata?.httpStatusCode === 501
}

function checksumBase64ToHex(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return undefined
  const bytes = Buffer.from(value, 'base64')
  return bytes.byteLength === 32 && bytes.toString('base64') === value ? bytes.toString('hex') : undefined
}

async function bodyText(body) {
  if (typeof body?.transformToString === 'function') return body.transformToString()
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body).toString('utf8')
  const chunks = []
  for await (const chunk of body ?? []) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function bodyBytes(body) {
  if (typeof body?.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray())
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body)
  const chunks = []
  for await (const chunk of body ?? []) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function stableObjectJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableObjectJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableObjectJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function positiveInteger(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function activatedDurableHistory(active, nextPrivateState, activatedAt) {
  const history = Array.isArray(active?.durableHistory)
    ? active.durableHistory.filter((entry) => entry && typeof entry.manifestKey === 'string' && Array.isArray(entry.boundaries))
    : []
  const activated = [[active?.privateState, active?.promotedAt ?? activatedAt], [nextPrivateState, activatedAt]].flatMap(([state, stateActivatedAt]) => (
    state && typeof state.manifestKey === 'string' && Array.isArray(state.retention?.boundaries) && state.retention.boundaries.length > 0
      ? [{ manifestKey: state.manifestKey, manifestDigest: state.manifestDigest, boundaries: [...new Set(state.retention.boundaries)].sort(), activatedAt: stateActivatedAt }]
      : []
  ))
  const byManifest = new Map(history.map((entry) => [entry.manifestKey, entry]))
  for (const entry of activated) if (!byManifest.has(entry.manifestKey)) byManifest.set(entry.manifestKey, entry)
  return [...byManifest.values()]
    .sort((left, right) => left.manifestKey.localeCompare(right.manifestKey))
}

function activatedRawHistory(active, nextRawState, activatedAt, recentDays = 35) {
  const entries = [
    ...(Array.isArray(active?.rawHistory) ? active.rawHistory : []),
    ...(active?.rawState ? [{ ...active.rawState, activatedAt: active.promotedAt ?? activatedAt }] : []),
    { ...nextRawState, activatedAt },
  ].filter((entry) => entry && typeof entry.descriptorKey === 'string' && typeof entry.date === 'string')
  const cutoff = new Date(activatedAt).getTime() - recentDays * 24 * 60 * 60_000
  const permanent = entries.filter((entry) => Array.isArray(entry.boundaries) && entry.boundaries.length > 0)
  const latestByDate = new Map()
  for (const entry of entries) {
    if (new Date(`${entry.date}T00:00:00.000Z`).getTime() < cutoff && !permanent.includes(entry)) continue
    const previous = latestByDate.get(entry.date)
    if (!previous || `${entry.activatedAt}:${entry.descriptorKey}` > `${previous.activatedAt}:${previous.descriptorKey}`) {
      latestByDate.set(entry.date, entry)
    }
  }
  for (const entry of permanent) latestByDate.set(`permanent:${entry.descriptorKey}`, entry)
  return [...new Map([...latestByDate.values()].map((entry) => [entry.descriptorKey, entry])).values()]
    .sort((left, right) => left.descriptorKey.localeCompare(right.descriptorKey))
}

async function requirePromotionLease(leaseGuard, options) {
  if (!leaseGuard) throw new Error('Protected publication requires an active generation lease guard')
  const verified = await verifyBucketRefreshAuthority(leaseGuard.key, leaseGuard, options)
  if (!verified.valid) throw new Error(`Refresh lease no longer authorizes promotion: ${verified.reason}`)
}

async function acquireAuthoritativeBucketLease(relativeKey, authorityKey, {
  owner,
  ttlMs,
  now,
  config,
  client,
  beforeAuthorityCas,
  afterMirrorPut,
}) {
  const nowMs = new Date(now).getTime()
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const active = await readBucketJson(authorityKey, { config, client })
    if (active.value?.maintenance) {
      return { acquired: false, reason: 'maintenance-active', maintenance: active.value.maintenance }
    }
    const currentLease = active.value?.refreshLease
    const currentExpiresAt = new Date(currentLease?.expiresAt).getTime()
    if (currentLease?.key === relativeKey && currentLease?.owner === owner && currentExpiresAt > nowMs) {
      return {
        acquired: true,
        lease: currentLease,
        authorityKey,
        activeEtag: active.etag,
        idempotent: true,
      }
    }
    if (currentExpiresAt > nowMs && currentLease?.owner !== owner) {
      return { acquired: false, reason: 'active-lease', lease: currentLease }
    }
    const fencingToken = Math.max(
      Number(active.value?.fencingToken ?? 0),
      Number(currentLease?.fencingToken ?? 0),
    ) + 1
    const lease = {
      schemaVersion: 1,
      key: relativeKey,
      owner,
      fencingToken,
      acquiredAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
    }
    const next = {
      ...(active.value && typeof active.value === 'object' && !Array.isArray(active.value) ? active.value : {}),
      schemaVersion: 1,
      fencingToken,
      refreshLease: lease,
    }
    if (beforeAuthorityCas) await beforeAuthorityCas({ attempt, active, lease })
    const write = await writeBucketJson(authorityKey, next, {
      config,
      client,
      ...(active.found ? { ifMatch: active.etag } : { ifNoneMatch: '*' }),
    })
    if (write.written) {
      const mirror = await writeLeaseMirror(relativeKey, lease, { config, client })
      if (afterMirrorPut) await afterMirrorPut({ lease, mirror })
      return {
        acquired: true,
        lease,
        authorityKey,
        activeEtag: write.etag,
        ...(mirror.etag ? { etag: mirror.etag } : {}),
      }
    }
    if (!write.conflict) return { acquired: false, reason: 'bucket-unavailable' }
  }
  return { acquired: false, reason: 'lease-race' }
}

async function writeLeaseMirror(relativeKey, lease, options) {
  try {
    const current = await readBucketJson(relativeKey, options)
    return await writeBucketJson(relativeKey, lease, {
      ...options,
      ...(current.found ? { ifMatch: current.etag } : { ifNoneMatch: '*' }),
    })
  } catch {
    return { written: false }
  }
}
