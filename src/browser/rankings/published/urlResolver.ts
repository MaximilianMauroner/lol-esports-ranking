export function resolvePublicArtifactUrl(
  value: string,
  baseUrl: string,
  runtimeOrigin = browserOrigin(),
) {
  if (isAbsoluteUrl(value) || isRootRelative(value)) return value
  const origin = runtimeOrigin ?? absoluteOrigin(baseUrl) ?? 'http://localhost'
  const base = isAbsoluteUrl(baseUrl) ? baseUrl : new URL(baseUrl, origin).toString()
  return new URL(value, base).toString()
}

export function publicArtifactProxyFallbackUrl(
  objectUrl: string,
  manifestUrl: string,
  runtimeOrigin = browserOrigin(),
) {
  const rootRelative = isRootRelative(objectUrl)
  const referenceOrigin = runtimeOrigin ?? absoluteOrigin(manifestUrl)
  if (!rootRelative && !referenceOrigin) return undefined
  let parsed: URL
  try {
    parsed = new URL(objectUrl, referenceOrigin ?? 'https://same-origin.invalid')
  } catch {
    return undefined
  }
  if (!rootRelative && parsed.origin !== referenceOrigin) return undefined
  if (!/^\/data\/objects\/sha256\/[a-f0-9]{64}$/.test(parsed.pathname)) return undefined
  if (parsed.searchParams.get('delivery') === 'proxy') return undefined
  parsed.searchParams.set('delivery', 'proxy')
  return rootRelative ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString()
}

export function publicArtifactResponseFollowedRedirect(
  response: Response,
  objectUrl: string,
  manifestUrl: string,
  runtimeOrigin = browserOrigin(),
) {
  if (response.redirected) return true
  if (!response.url) return false
  const base = runtimeOrigin ?? absoluteOrigin(manifestUrl)
    ?? (isRootRelative(objectUrl) ? 'https://same-origin.invalid' : undefined)
  if (!base) return false
  try {
    const finalUrl = new URL(response.url, base)
    const originalUrl = new URL(objectUrl, base)
    finalUrl.hash = ''
    originalUrl.hash = ''
    return finalUrl.toString() !== originalUrl.toString()
  } catch {
    return false
  }
}

function browserOrigin() {
  const runtime = globalThis as typeof globalThis & { location?: { origin?: unknown } }
  return typeof runtime.location?.origin === 'string' ? runtime.location.origin : undefined
}

function isRootRelative(value: string) {
  return value.startsWith('/') && !value.startsWith('//')
}

function isAbsoluteUrl(value: string) {
  return /^[a-z][a-z\d+.-]*:/i.test(value)
}

function absoluteOrigin(value: string) {
  try {
    return isAbsoluteUrl(value) ? new URL(value).origin : undefined
  } catch {
    return undefined
  }
}
