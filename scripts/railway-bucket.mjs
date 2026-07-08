import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { dirname, extname, posix, relative, resolve, sep } from 'node:path'
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { manifestWithResolvedFiles } from './local-data-manifest.js'

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
} = {}) {
  if (!config.enabled) {
    return {
      enabled: false,
      missing: config.missing,
      uploaded: [],
      skipped: [],
    }
  }

  const uploads = []
  const skipped = []
  uploads.push(...await uploadDirectory(client, config, publicDataDir, 'data'))
  if (rawDir) {
    uploads.push(...await uploadRawSourceFiles(client, config, rawDir, manifestPath))
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
      uploads.push(await uploadJson(client, config, 'raw/refresh-state.json', refreshStateForUpload({
        bucket: config.bucket,
        prefix: config.prefix,
        uploadedCount: uploads.length + 1,
        skipped,
      })))
    } else {
      uploads.push(await uploadFile(client, config, statePath, 'raw/refresh-state.json'))
    }
  }

  await uploadJson(client, config, 'latest-publish.json', {
    schemaVersion: 1,
    publishedAt: new Date().toISOString(),
    prefix: config.prefix,
    artifactCount: uploads.length,
    artifacts: uploads.map(({ key, bytes, contentType }) => ({ key, bytes, contentType })),
    skipped,
  })

  return {
    enabled: true,
    bucket: config.bucket,
    prefix: config.prefix,
    uploaded: uploads,
    skipped,
  }
}

export async function getBucketObject(relativePath, {
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
} = {}) {
  if (!config.enabled || !client) return { found: false, missingConfig: config.missing ?? [] }
  const key = bucketKey(config, `data/${safeRequestedObjectPath(relativePath)}`)

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
    if (isMissingObjectError(error)) return { found: false, key }
    throw error
  }
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

export async function uploadDirectory(client, config, dir, destinationPrefix) {
  const root = resolve(dir)
  const files = await listFiles(root)
  const uploads = []
  for (const file of files) {
    const relativePath = relative(root, file).split(sep).join('/')
    uploads.push(await uploadFile(client, config, file, `${destinationPrefix}/${relativePath}`))
  }
  return uploads
}

export async function uploadRawSourceFiles(client, config, rawDir, manifestPath) {
  if (!manifestPath) return []

  const root = resolve(rawDir)
  const manifest = manifestWithResolvedFiles(JSON.parse(await readFile(manifestPath, 'utf8')), root)
  const rootWithSeparator = `${root}${sep}`
  const files = uniqueValues(Object.values(manifest?.files ?? {})
    .flatMap((entries) => Array.isArray(entries) ? entries : []))
  const uploads = []

  for (const file of files) {
    const filePath = resolve(file)
    if (filePath !== root && !filePath.startsWith(rootWithSeparator)) {
      throw new Error(`Raw source file is outside rawDir: ${file}`)
    }
    const relativePath = relative(root, filePath).split(sep).join('/')
    uploads.push(await uploadFile(client, config, filePath, `raw/files/${relativePath}`))
  }

  return uploads
}

export async function uploadFile(client, config, filePath, relativeKey) {
  const fileStat = await stat(filePath)
  const key = bucketKey(config, relativeKey)
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: createReadStream(filePath),
    ContentLength: fileStat.size,
    ContentType: contentTypeForPath(filePath),
  }))
  return {
    key,
    bytes: fileStat.size,
    contentType: contentTypeForPath(filePath),
  }
}

export async function uploadJson(client, config, relativeKey, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`
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

function isMissingObjectError(error) {
  return error?.name === 'NoSuchKey'
    || error?.name === 'NotFound'
    || error?.$metadata?.httpStatusCode === 404
}
