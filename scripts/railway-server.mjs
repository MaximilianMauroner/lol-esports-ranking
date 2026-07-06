import { createReadStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { normalize, resolve, sep } from 'node:path'
import { createGzip } from 'node:zlib'
import { bucketConfigFromEnv, contentTypeForPath, getBucketObject } from './railway-bucket.mjs'

const port = Number(process.env.PORT ?? 4173)
const host = process.env.HOST ?? '0.0.0.0'
const distDir = resolve(process.env.RAILWAY_DIST_DIR ?? 'dist')
const publicDataDir = resolve(process.env.RANKING_PUBLIC_DATA_DIR ?? 'public/data')
const refreshEnabled = process.env.RANKING_REFRESH_ENABLED === 'true'
const refreshIntervalMinutes = Math.max(1, Number(process.env.RANKING_REFRESH_INTERVAL_MINUTES ?? 60))
const refreshOnStart = process.env.RANKING_REFRESH_ON_START === 'true'
const dataCacheControl = process.env.RANKING_DATA_CACHE_CONTROL ?? 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800, stale-if-error=604800'
const dataManifestCacheControl = process.env.RANKING_DATA_MANIFEST_CACHE_CONTROL ?? 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600, stale-if-error=86400'
const gzipEnabled = process.env.RANKING_GZIP_ENABLED !== 'false'
const cronSecret = process.env.CRON_SECRET
const bucketConfig = bucketConfigFromEnv()

let refreshInFlight = null
let lastRefresh = {
  status: 'not-run',
  startedAt: null,
  finishedAt: null,
  reason: null,
  exitCode: null,
  error: null,
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

    if (url.pathname === '/api/health') {
      sendJson(response, 200, {
        ok: true,
        refreshEnabled,
        refreshInFlight: Boolean(refreshInFlight),
        bucket: bucketConfig.enabled
          ? { enabled: true, bucket: bucketConfig.bucket, prefix: bucketConfig.prefix }
          : { enabled: false, missing: bucketConfig.missing },
        lastRefresh,
        dataCacheControl,
        dataManifestCacheControl,
        gzipEnabled,
      })
      return
    }

    if (url.pathname === '/api/refresh') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'Method not allowed' })
        return
      }
      if (!cronSecret || request.headers.authorization !== `Bearer ${cronSecret}`) {
        sendJson(response, 401, { ok: false, error: 'Unauthorized' })
        return
      }
      void runRefresh('manual')
      sendJson(response, 202, { ok: true, accepted: true, refreshInFlight: true })
      return
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { ok: false, error: 'Method not allowed' })
      return
    }

    if (url.pathname.startsWith('/data/')) {
      const relativeDataPath = url.pathname.slice('/data/'.length)
      await serveDataFile(response, relativeDataPath, {
        cacheControl: cacheControlForDataPath(relativeDataPath),
        headOnly: request.method === 'HEAD',
        requestHeaders: request.headers,
      })
      return
    }

    await serveAppFile(response, url.pathname, request.method === 'HEAD', request.headers)
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(port, host, () => {
  console.log(`Railway server listening on ${host}:${port}`)
  if (!refreshEnabled) return

  if (refreshOnStart) {
    setTimeout(() => {
      void runRefresh('startup')
    }, 1000)
  }

  setInterval(() => {
    void runRefresh('schedule')
  }, refreshIntervalMinutes * 60 * 1000).unref()
})

async function serveAppFile(response, pathname, headOnly, requestHeaders) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1)
  const served = await tryServeFile(response, distDir, relativePath, {
    cacheControl: cacheControlForPath(relativePath),
    headOnly,
    requestHeaders,
  })
  if (served) return

  await serveFile(response, distDir, 'index.html', {
    cacheControl: 'no-store',
    headOnly,
    requestHeaders,
  })
}

async function serveFile(response, rootDir, relativePath, options) {
  const served = await tryServeFile(response, rootDir, relativePath, options)
  if (!served) sendJson(response, 404, { ok: false, error: 'Not found' })
}

async function serveDataFile(response, relativePath, options) {
  const safePath = safeRequestPath(relativePath)
  if (!safePath) {
    sendJson(response, 400, { ok: false, error: 'Invalid data path' })
    return
  }

  const servedLocal = await tryServeFile(response, publicDataDir, safePath, options)
  if (servedLocal) return

  if (bucketConfig.enabled) {
    const servedBucket = await tryServeBucketFile(response, safePath, options)
    if (servedBucket) return
  }

  sendJson(response, 404, { ok: false, error: 'Not found' })
}

async function tryServeBucketFile(response, relativePath, { cacheControl, headOnly, requestHeaders }) {
  const object = await getBucketObject(relativePath, { config: bucketConfig })
  if (!object.found) return false

  const contentType = object.contentType ?? contentTypeForPath(relativePath)
  const compressible = isCompressibleContentType(contentType)
  if (isFreshRequest(requestHeaders, object.etag, object.lastModified)) {
    destroyBody(object.body)
    sendNotModified(response, {
      cacheControl,
      contentType,
      etag: object.etag,
      lastModified: object.lastModified,
      varyAcceptEncoding: compressible,
    })
    return true
  }

  const gzip = shouldGzip(requestHeaders, contentType, object.contentLength, headOnly)
  response.statusCode = 200
  response.setHeader('Content-Type', contentType)
  response.setHeader('Cache-Control', cacheControl)
  if (compressible) response.setHeader('Vary', 'Accept-Encoding')
  if (gzip) response.setHeader('Content-Encoding', 'gzip')
  else if (object.contentLength !== undefined) response.setHeader('Content-Length', String(object.contentLength))
  if (object.etag) response.setHeader('ETag', object.etag)
  if (object.lastModified) response.setHeader('Last-Modified', object.lastModified.toUTCString())
  if (headOnly) {
    response.end()
    return true
  }

  await pipeBody(object.body, response, { gzip })
  return true
}

async function tryServeFile(response, rootDir, relativePath, { cacheControl, headOnly, requestHeaders }) {
  const path = resolveSafePath(rootDir, relativePath)
  if (!path) return false

  let fileStat
  try {
    fileStat = await stat(path)
  } catch {
    return false
  }
  if (!fileStat.isFile()) return false

  const contentType = contentTypeForPath(path)
  const etag = localFileEtag(fileStat)
  const lastModified = fileStat.mtime
  const compressible = isCompressibleContentType(contentType)
  if (isFreshRequest(requestHeaders, etag, lastModified)) {
    sendNotModified(response, {
      cacheControl,
      contentType,
      etag,
      lastModified,
      varyAcceptEncoding: compressible,
    })
    return true
  }

  const gzip = shouldGzip(requestHeaders, contentType, fileStat.size, headOnly)
  response.statusCode = 200
  response.setHeader('Content-Type', contentType)
  response.setHeader('Cache-Control', cacheControl)
  response.setHeader('ETag', etag)
  response.setHeader('Last-Modified', lastModified.toUTCString())
  if (compressible) response.setHeader('Vary', 'Accept-Encoding')
  if (gzip) response.setHeader('Content-Encoding', 'gzip')
  else response.setHeader('Content-Length', String(fileStat.size))
  if (headOnly) {
    response.end()
    return true
  }

  const stream = createReadStream(path)
  if (gzip) stream.pipe(createGzip()).pipe(response)
  else stream.pipe(response)
  return true
}

function resolveSafePath(rootDir, relativePath) {
  const safePath = safeRequestPath(relativePath)
  if (!safePath) return null

  const normalized = normalize(safePath)
  const resolved = resolve(rootDir, normalized)
  const rootWithSeparator = `${resolve(rootDir)}${sep}`
  if (resolved !== resolve(rootDir) && !resolved.startsWith(rootWithSeparator)) return null
  return resolved
}

function safeRequestPath(relativePath) {
  if (!relativePath || relativePath.includes('\\')) return null
  const segments = relativePath.split('/')
  if (segments.some((segment) => segment.length === 0)) return null

  for (const segment of segments) {
    let decoded
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) return null
  }

  return relativePath
}

function runRefresh(reason) {
  if (refreshInFlight) return refreshInFlight

  lastRefresh = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    reason,
    exitCode: null,
    error: null,
  }

  refreshInFlight = new Promise((resolveRefresh) => {
    const child = spawn(process.execPath, ['scripts/refresh-data-if-changed.mjs'], {
      env: process.env,
      stdio: 'inherit',
    })

    child.on('error', (error) => {
      lastRefresh = {
        ...lastRefresh,
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: error.message,
      }
      refreshInFlight = null
      resolveRefresh()
    })

    child.on('exit', (code) => {
      lastRefresh = {
        ...lastRefresh,
        status: code === 0 ? 'ok' : 'error',
        finishedAt: new Date().toISOString(),
        exitCode: code,
        error: code === 0 ? null : `refresh exited with ${code}`,
      }
      refreshInFlight = null
      resolveRefresh()
    })
  })

  return refreshInFlight
}

function sendJson(response, statusCode, value) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(`${JSON.stringify(value)}\n`)
}

async function pipeBody(body, response, { gzip = false } = {}) {
  if (body && typeof body.pipe === 'function') {
    if (gzip) body.pipe(createGzip()).pipe(response)
    else body.pipe(response)
    return
  }
  if (body && typeof body.transformToByteArray === 'function') {
    const buffer = Buffer.from(await body.transformToByteArray())
    if (!gzip) {
      response.end(buffer)
      return
    }
    const gzipStream = createGzip()
    gzipStream.pipe(response)
    gzipStream.end(buffer)
    return
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    if (gzip) {
      const gzipStream = createGzip()
      gzipStream.pipe(response)
      for await (const chunk of body) {
        gzipStream.write(chunk)
      }
      gzipStream.end()
      return
    }
    for await (const chunk of body) {
      response.write(chunk)
    }
    response.end()
    return
  }
  response.end()
}

function cacheControlForPath(path) {
  if (path === 'index.html') return 'no-store'
  if (path.startsWith('assets/')) return 'public, max-age=31536000, immutable'
  return 'public, max-age=3600'
}

function cacheControlForDataPath(path) {
  if (path === 'ranking-summary.json') return dataManifestCacheControl
  return dataCacheControl
}

function shouldGzip(requestHeaders, contentType, contentLength, headOnly) {
  if (!gzipEnabled || headOnly || !isCompressibleContentType(contentType)) return false
  if (contentLength !== undefined && contentLength < 1024) return false
  return acceptsGzip(requestHeaders?.['accept-encoding'])
}

function acceptsGzip(value) {
  if (!value) return false
  return /\bgzip\b/i.test(String(value)) && !/\bgzip\s*;\s*q=0(?:\.0+)?\b/i.test(String(value))
}

function isCompressibleContentType(contentType) {
  const value = String(contentType).toLowerCase()
  return value.startsWith('application/json')
    || value.startsWith('text/')
    || value.startsWith('image/svg+xml')
    || value.startsWith('application/javascript')
    || value.startsWith('text/javascript')
}

function localFileEtag(fileStat) {
  return `W/"${fileStat.size.toString(16)}-${Math.floor(fileStat.mtimeMs).toString(16)}"`
}

function isFreshRequest(requestHeaders, etag, lastModified) {
  const ifNoneMatch = requestHeaders?.['if-none-match']
  if (ifNoneMatch && etag) return entityTagMatches(ifNoneMatch, etag)

  const ifModifiedSince = requestHeaders?.['if-modified-since']
  if (!ifModifiedSince || !lastModified) return false

  const since = Date.parse(String(ifModifiedSince))
  if (!Number.isFinite(since)) return false
  return Math.floor(lastModified.getTime() / 1000) * 1000 <= since
}

function entityTagMatches(header, etag) {
  const expected = normalizeEntityTag(etag)
  return String(header)
    .split(',')
    .map((entry) => entry.trim())
    .some((entry) => entry === '*' || normalizeEntityTag(entry) === expected)
}

function normalizeEntityTag(value) {
  return String(value).trim().replace(/^W\//i, '')
}

function sendNotModified(response, {
  cacheControl,
  contentType,
  etag,
  lastModified,
  varyAcceptEncoding = false,
}) {
  response.statusCode = 304
  response.setHeader('Content-Type', contentType)
  response.setHeader('Cache-Control', cacheControl)
  if (varyAcceptEncoding) response.setHeader('Vary', 'Accept-Encoding')
  if (etag) response.setHeader('ETag', etag)
  if (lastModified) response.setHeader('Last-Modified', lastModified.toUTCString())
  response.end()
}

function destroyBody(body) {
  if (body && typeof body.destroy === 'function') body.destroy()
}
