export function resolvePublicArtifactUrl(url: string, manifestUrl: string, origin = browserOrigin()) {
  if (/^[a-z][a-z\d+.-]*:/i.test(url)) return url
  const externalManifest = /^[a-z][a-z\d+.-]*:/i.test(manifestUrl)
  if (!externalManifest) return url.startsWith('/') ? url : new URL(url, new URL(manifestUrl, origin)).toString()
  if (url.startsWith('/data/')) return new URL(url.slice('/data/'.length), manifestUrl).toString()
  return new URL(url, manifestUrl).toString()
}

function browserOrigin() {
  return typeof window === 'undefined' ? 'http://localhost' : window.location.origin
}
