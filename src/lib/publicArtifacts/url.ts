export const DEFAULT_PUBLIC_RANKING_MANIFEST_URL = '/data/ranking-summary.json'

export function normalizeExternalRankingManifestUrl(url: string | undefined | null) {
  const configured = url?.trim()
  if (!configured) return DEFAULT_PUBLIC_RANKING_MANIFEST_URL
  if (!/^[a-z][a-z\d+.-]*:/i.test(configured)) return configured
  const parsed = new URL(configured)
  if (parsed.pathname.endsWith('.json')) return parsed.toString()
  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/`
  parsed.search = ''
  parsed.hash = ''
  return new URL('ranking-summary.json', parsed).toString()
}

export function resolvePublicArtifactUrl(url: string, manifestUrl: string, origin = browserOrigin()) {
  if (/^[a-z][a-z\d+.-]*:/i.test(url)) return url
  const normalizedManifest = normalizeExternalRankingManifestUrl(manifestUrl)
  const externalManifest = /^[a-z][a-z\d+.-]*:/i.test(normalizedManifest)
  if (!externalManifest) return url.startsWith('/') ? url : new URL(url, new URL(normalizedManifest, origin)).toString()
  if (url.startsWith('/data/')) return new URL(url.slice('/data/'.length), normalizedManifest).toString()
  return new URL(url, normalizedManifest).toString()
}

function browserOrigin(environment: object = globalThis) {
  const location = 'location' in environment ? environment.location : undefined
  return isLocationWithOrigin(location) ? location.origin : 'http://localhost'
}

function isLocationWithOrigin(value: unknown): value is { origin: string } {
  return typeof value === 'object' && value !== null && 'origin' in value && typeof value.origin === 'string' && value.origin.length > 0
}
