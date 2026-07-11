import { createReadStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { access, readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { normalize, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { bucketConfigFromEnv, contentTypeForPath, getBucketObject, readBucketJson } from './railway-bucket.mjs'
import { injectHomepagePrerender, renderHomepagePrerenderFromDataDir, renderSitemapFromDataDir } from './seo-prerender.ts'

const port = Number(process.env.PORT ?? 4173)
const host = process.env.HOST ?? '0.0.0.0'
const distDir = resolve(process.env.RAILWAY_DIST_DIR ?? 'dist')
const publicDataDir = resolve(process.env.RANKING_PUBLIC_DATA_DIR ?? 'public/data')
const refreshEnabled = process.env.RANKING_REFRESH_ENABLED === 'true'
const refreshMode = ['shadow', 'gated'].includes(process.env.RANKING_REFRESH_MODE) ? process.env.RANKING_REFRESH_MODE : 'legacy'
const refreshIntervalMinutes = Math.max(1, Number(process.env.RANKING_REFRESH_INTERVAL_MINUTES ?? 60))
const refreshOnStart = process.env.RANKING_REFRESH_ON_START === 'true'
const refreshScript = process.env.RANKING_REFRESH_SCRIPT ?? 'scripts/refresh-data-if-changed.mjs'
const refreshStatePath = resolve(process.env.RANKING_REFRESH_STATE ?? 'data/raw/refresh-state.json')
const dataCacheControl = process.env.RANKING_DATA_CACHE_CONTROL ?? 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800, stale-if-error=604800'
const dataManifestCacheControl = process.env.RANKING_DATA_MANIFEST_CACHE_CONTROL ?? 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600, stale-if-error=86400'
const htmlCacheControl = process.env.RANKING_HTML_CACHE_CONTROL ?? 'no-store'
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
  details: null,
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

    if (url.pathname === '/api/live') {
      sendJson(response, 200, { ok: true, commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null })
      return
    }

    if (url.pathname === '/api/ready') {
      const readiness = await readinessStatus()
      sendJson(response, readiness.ok ? 200 : 503, readiness)
      return
    }

    if (url.pathname === '/api/scheduler') {
      sendJson(response, 200, await schedulerStatus())
      return
    }

    if (url.pathname === '/api/health') {
      sendJson(response, 200, {
        ok: true,
        refreshEnabled,
        refreshMode,
        refreshInFlight: Boolean(refreshInFlight),
        bucket: bucketConfig.enabled
          ? { enabled: true, bucket: bucketConfig.bucket, prefix: bucketConfig.prefix }
          : { enabled: false, missing: bucketConfig.missing },
        lastRefresh,
        dataCacheControl,
        dataManifestCacheControl,
        htmlCacheControl,
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
    if (response.headersSent || response.writableEnded) {
      console.error(error)
      response.destroy(error instanceof Error ? error : undefined)
      return
    }
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(port, host, () => {
  console.log(`Railway server listening on ${host}:${port}`)
  if (!refreshEnabled || refreshMode !== 'legacy') return

  if (refreshOnStart) {
    setTimeout(() => {
      void runRefresh('startup')
    }, 1000)
  }

  setInterval(() => {
    void runRefresh('schedule')
  }, refreshIntervalMinutes * 60 * 1000).unref()
})

async function readinessStatus() {
  try {
    await access(resolve(distDir, 'index.html'))
    try {
      await access(resolve(publicDataDir, 'ranking-summary.json'))
      return { ok: true, app: true, data: 'local' }
    } catch {
      const manifest = await getBucketObject('ranking-summary.json')
      if (manifest.found) {
        destroyBody(manifest.body)
        return { ok: true, app: true, data: 'bucket' }
      }
      return { ok: false, app: true, data: 'missing' }
    }
  } catch (error) {
    return { ok: false, app: false, data: 'unknown', error: error instanceof Error ? error.message : String(error) }
  }
}

async function schedulerStatus() {
  const remote = await readBucketJson(process.env.RANKING_TRIGGER_STATE_KEY ?? 'raw/refresh-trigger-state.json')
  let state = remote.found ? remote.value : null
  if (!state) {
    try {
      state = JSON.parse(await readFile(process.env.RANKING_TRIGGER_STATE ?? 'data/raw/refresh-trigger-state.json', 'utf8'))
    } catch {
      state = null
    }
  }
  const pending = Object.values(state?.pending ?? {})
  const oldestPendingAt = pending.map((entry) => entry?.detectedAt).filter(Boolean).sort()[0] ?? null
  return {
    ok: Boolean(state),
    enabled: refreshEnabled,
    mode: refreshMode,
    phase: state?.lastProbe?.status === 'error' ? 'degraded' : pending.length > 0 ? 'waiting-for-source' : 'waiting-for-game',
    checkedAt: state?.checkedAt ?? null,
    observationWatermark: state?.observationWatermark ?? null,
    pendingCount: pending.length,
    oldestPendingAt,
    lastProbe: state?.lastProbe ?? null,
    metrics: state?.metrics ?? null,
  }
}

async function serveAppFile(response, pathname, headOnly, requestHeaders) {
  if (pathname === '/sitemap.xml') {
    await serveLiveSitemap(response, headOnly, requestHeaders)
    return
  }
  if (isKnownAppRoute(pathname)) {
    await serveAppShell(response, headOnly, requestHeaders)
    return
  }

  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1)
  const served = await tryServeFile(response, distDir, relativePath, {
    cacheControl: cacheControlForPath(relativePath),
    headOnly,
    requestHeaders,
  })
  if (served) return

  sendNotFound(response, { headOnly, requestHeaders })
}

async function serveAppShell(response, headOnly, requestHeaders) {
  const indexPath = resolveSafePath(distDir, 'index.html')
  if (!indexPath) {
    sendJson(response, 404, { ok: false, error: 'Not found' })
    return
  }

  let html
  try {
    html = await readFile(indexPath, 'utf8')
  } catch {
    sendJson(response, 404, { ok: false, error: 'Not found' })
    return
  }

  try {
    const prerendered = await renderHomepagePrerenderFromDataDir(publicDataDir)
    html = injectHomepagePrerender(html, prerendered)
  } catch (error) {
    console.warn(`Live homepage prerender fallback used: ${error instanceof Error ? error.message : String(error)}`)
  }

  await sendHtml(response, html, { headOnly, requestHeaders })
}

async function sendHtml(response, html, { headOnly, requestHeaders }) {
  await sendText(response, html, {
    cacheControl: htmlCacheControl,
    contentType: 'text/html; charset=utf-8',
    headOnly,
    requestHeaders,
  })
}

async function serveLiveSitemap(response, headOnly, requestHeaders) {
  const sitemapPath = resolveSafePath(distDir, 'sitemap.xml')
  if (!sitemapPath) {
    sendJson(response, 404, { ok: false, error: 'Not found' })
    return
  }
  try {
    const sitemap = await readFile(sitemapPath, 'utf8')
    const rendered = await renderSitemapFromDataDir(publicDataDir, sitemap)
    await sendText(response, rendered, {
      cacheControl: cacheControlForPath('sitemap.xml'),
      contentType: 'application/xml; charset=utf-8',
      headOnly,
      requestHeaders,
    })
  } catch {
    const served = await tryServeFile(response, distDir, 'sitemap.xml', {
      cacheControl: cacheControlForPath('sitemap.xml'),
      headOnly,
      requestHeaders,
    })
    if (!served) sendJson(response, 404, { ok: false, error: 'Not found' })
  }
}

async function sendText(response, text, { cacheControl, contentType, headOnly, requestHeaders }) {
  const body = Buffer.from(text)
  const gzip = shouldGzip(requestHeaders, contentType, body.length, headOnly)
  response.statusCode = 200
  response.setHeader('Content-Type', contentType)
  response.setHeader('Cache-Control', cacheControl)
  response.setHeader('Vary', 'Accept-Encoding')
  if (gzip) response.setHeader('Content-Encoding', 'gzip')
  else response.setHeader('Content-Length', String(body.length))
  if (headOnly) {
    response.end()
    return
  }
  if (gzip) {
    await pipeBody(Readable.from([body]), response, { gzip: true })
    return
  }
  response.end(body)
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
  await pipeBody(stream, response, { gzip })
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
    details: null,
  }

  refreshInFlight = new Promise((resolveRefresh) => {
    const child = spawn(process.execPath, [refreshScript], {
      env: process.env,
      stdio: 'inherit',
    })

    child.on('error', (error) => {
      lastRefresh = {
        ...lastRefresh,
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: error.message,
        details: null,
      }
      refreshInFlight = null
      resolveRefresh()
    })

    child.on('exit', (code) => {
      void finishRefreshExit(code, resolveRefresh)
    })
  })

  return refreshInFlight
}

async function finishRefreshExit(code, resolveRefresh) {
  const state = code === 0 ? await readRefreshState() : null
  const staleSource = state?.status === 'stale-source'
  lastRefresh = {
    ...lastRefresh,
    status: staleSource ? 'stale-source' : code === 0 ? 'ok' : 'error',
    finishedAt: new Date().toISOString(),
    exitCode: code,
    error: staleSource ? state.reason ?? null : code === 0 ? null : `refresh exited with ${code}`,
    details: staleSource
      ? {
          reason: state.reason ?? null,
          downloadStart: state.downloadStart ?? null,
          downloadEnd: state.downloadEnd ?? null,
          coverageStart: state.coverageStart ?? null,
          coverageEnd: state.coverageEnd ?? null,
        }
      : null,
  }
  refreshInFlight = null
  resolveRefresh()
}

async function readRefreshState() {
  try {
    return JSON.parse(await readFile(refreshStatePath, 'utf8'))
  } catch {
    return null
  }
}

function sendJson(response, statusCode, value) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  if (statusCode === 404) response.setHeader('X-Robots-Tag', 'noindex')
  response.end(`${JSON.stringify(value)}\n`)
}

function sendNotFound(response, { headOnly, requestHeaders }) {
  const acceptsHtml = acceptsContentType(requestHeaders?.accept, 'text/html')
  const body = acceptsHtml
    ? '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Not found</title></head><body><h1>Not found</h1></body></html>\n'
    : '{"ok":false,"error":"Not found"}\n'
  response.statusCode = 404
  response.setHeader('Content-Type', acceptsHtml ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Robots-Tag', 'noindex')
  response.setHeader('Content-Length', String(Buffer.byteLength(body)))
  if (headOnly) {
    response.end()
    return
  }
  response.end(body)
}

async function pipeBody(body, response, { gzip = false } = {}) {
  const stream = await readableBody(body)
  if (!stream) {
    response.end()
    return
  }
  if (gzip) await pipeline(stream, createGzip(), response)
  else await pipeline(stream, response)
}

async function readableBody(body) {
  if (!body) return null
  if (typeof body.pipe === 'function') return body
  if (typeof body.transformToByteArray === 'function') {
    return Readable.from([Buffer.from(await body.transformToByteArray())])
  }
  if (typeof body[Symbol.asyncIterator] === 'function') return Readable.from(body)
  return Readable.from([body])
}

function cacheControlForPath(path) {
  if (path === 'index.html') return htmlCacheControl
  if (isRevalidatingMetadataAssetPath(path)) return 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'
  if (path.startsWith('assets/')) return 'public, max-age=31536000, immutable'
  if (isImmutableStaticAssetPath(path)) return 'public, max-age=31536000, immutable'
  return 'public, max-age=3600'
}

function isKnownAppRoute(pathname) {
  const normalizedPathname = pathname !== '/' && pathname.endsWith('/')
    ? pathname.slice(0, -1)
    : pathname
  return normalizedPathname === '/'
    || normalizedPathname === '/rankings'
    || normalizedPathname === '/teams'
    || normalizedPathname === '/regions'
    || normalizedPathname === '/legal'
    || normalizedPathname === '/privacy'
    || normalizedPathname === '/licenses'
}

function isRevalidatingMetadataAssetPath(path) {
  return path === 'site.webmanifest'
    || path === 'robots.txt'
    || path === 'sitemap.xml'
    || path === 'llms.txt'
    || /^(?:apple-touch-icon|favicon|icons|logo|og-image)\.(?:ico|jpg|jpeg|png|svg|webp)$/.test(path)
}

function isImmutableStaticAssetPath(path) {
  return path.startsWith('league-icons/')
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

function acceptsContentType(value, contentType) {
  if (!value) return true
  return String(value)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => entry === '*/*' || entry.startsWith(`${contentType};`) || entry === contentType)
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
