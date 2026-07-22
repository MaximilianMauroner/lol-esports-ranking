import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { basename, dirname, extname, join, posix, relative, resolve, sep } from 'node:path'
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { manifestWithResolvedFiles } from './local-data-manifest.js'

let activeGenerationCache = { expiresAt: 0, value: null }

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
  if (leaseAuthority) await assertBucketLease(leaseAuthority.key, leaseAuthority, {
    config,
    client,
    now: now(),
    requireEtag: Boolean(leaseAuthority.etag),
  })
  let stageStarted = monotonicNow()
  const publicUploads = await uploadDirectory(client, config, publicDataDir, dataPrefix, 'ranking-summary.json')
  uploads.push(...publicUploads)
  onStage?.('artifact-upload', {
    durationMs: monotonicNow() - stageStarted,
    output: byteCounts(publicUploads),
  })
  if (rawDir) {
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
  if (manifestPath) {
    uploads.push(await uploadFile(client, config, manifestPath, 'raw/manifest.json'))
  }
  if (statePath) {
    if (refreshStateForUpload) {
      uploads.push(await uploadRefreshState(client, config, refreshStateForUpload, { uploads, unchanged, skipped }))
    } else {
      uploads.push(await uploadFile(client, config, statePath, 'raw/refresh-state.json'))
    }
  }
  const publishedArtifacts = [...uploads]
  const publishMetrics = publishMetricsFor(publishedArtifacts, unchanged)

  if (leaseAuthority) await assertBucketLease(leaseAuthority.key, leaseAuthority, {
    config,
    client,
    now: now(),
    requireEtag: Boolean(leaseAuthority.etag),
  })
  const publishReceipt = {
    schemaVersion: 1,
    publishedAt: new Date().toISOString(),
    prefix: config.prefix,
    ...(generationId ? { generationId } : {}),
    ...publishMetrics,
    artifacts: publishedArtifacts.map(({ key, bytes, contentType }) => ({ key, bytes, contentType })),
    unchanged: unchanged.map(({ key, bytes, contentType, digest }) => ({ key, bytes, contentType, digest })),
    skipped,
    ...(refreshTelemetry ? { refreshTelemetry: typeof refreshTelemetry === 'function' ? refreshTelemetry() : refreshTelemetry } : {}),
  }
  await uploadJson(client, config, generationId ? `generations/${safeObjectPath(generationId)}/publish.json` : 'latest-publish.json', publishReceipt)
  if (generationId) {
    stageStarted = monotonicNow()
    if (leaseAuthority) await assertBucketLease(leaseAuthority.key, leaseAuthority, {
      config,
      client,
      now: now(),
      requireEtag: Boolean(leaseAuthority.etag),
    })
    const active = await readBucketJson('active-generation.json', { config, client })
    if (Number(active.value?.fencingToken ?? 0) > Number(fencingToken ?? 0)) {
      throw new Error('Stale refresh worker cannot promote an active generation')
    }
    const promotion = await writeBucketJson('active-generation.json', {
      schemaVersion: 1,
      generationId,
      fencingToken,
      promotedAt: new Date(now()).toISOString(),
      manifestKey: bucketKey(config, `${dataPrefix}/ranking-summary.json`),
    }, {
      config,
      client,
      ...(active.found ? { ifMatch: active.etag } : { ifNoneMatch: '*' }),
    })
    if (!promotion.written) throw new Error('Active generation changed during promotion')
    activeGenerationCache = { expiresAt: Date.now() + 30_000, value: generationId }
    onStage?.('promotion', {
      durationMs: monotonicNow() - stageStarted,
      output: { generationId, fencingToken },
    })
  }

  return {
    enabled: true,
    bucket: config.bucket,
    prefix: config.prefix,
    uploaded: uploads,
    unchanged,
    skipped,
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
  return write.written
    ? { acquired: true, lease, etag: write.etag }
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
  const write = await writeBucketJson(relativeKey, lease, {
    config,
    client,
    ifMatch: authority.etag,
  })
  return write.written
    ? { renewed: true, lease, etag: write.etag }
    : { renewed: false, reason: write.conflict ? 'lease-changed' : 'bucket-unavailable' }
}

export async function assertBucketLease(relativeKey, authority, {
  now = new Date(),
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
  throwOnFailure = true,
  requireEtag = true,
} = {}) {
  const current = await readBucketJson(relativeKey, { config, client })
  const reason = !authority?.lease || (requireEtag && !authority?.etag)
    ? 'invalid-lease'
    : !current.found
      ? 'lease-missing'
      : authority.etag && current.etag !== authority.etag
        ? 'lease-changed'
        : current.value?.owner !== authority.lease.owner
          ? 'lease-owner-changed'
          : Number(current.value?.fencingToken) !== Number(authority.lease.fencingToken)
            ? 'lease-token-changed'
            : new Date(current.value?.expiresAt).getTime() <= new Date(now).getTime()
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
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body).toString('utf8')
  const chunks = []
  for await (const chunk of body ?? []) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
