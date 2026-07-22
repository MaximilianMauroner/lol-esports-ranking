const publicArtifactBaseUrl = 'https://public-artifacts.invalid'

export function canonicalPublicLogicalPath(value) {
  assertString(value, 'artifact logical path')
  if (value.includes('\\')) {
    throw new Error('Invalid public artifact: artifact logical path must be a safe /data/ path')
  }
  if (value.startsWith('/data/')) {
    const path = value.split(/[?#]/, 1)[0]
    assertPublicLogicalPath(path, 'artifact logical path')
    return decodeURIComponent(path)
  }
  let path
  try {
    path = new URL(value, publicArtifactBaseUrl).pathname
  } catch {
    throw new Error('Invalid public artifact: artifact logical path must be a valid URL path')
  }
  assertPublicLogicalPath(path, 'artifact logical path')
  return decodeURIComponent(path)
}

export function assertPublicLogicalPath(value, label = 'artifact logical path') {
  assertString(value, label)
  if (!value.startsWith('/data/') || value.includes('\\') || /(?:^|\/)\.\.?(?:\/|$)/.test(value)) {
    throw new Error(`Invalid public artifact: ${label} must be a safe /data/ path`)
  }
  if (/%(?:2f|5c)/i.test(value)) {
    throw new Error(`Invalid public artifact: ${label} contains encoded path separators`)
  }
  let decoded
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw new Error(`Invalid public artifact: ${label} contains invalid percent encoding`)
  }
  if (decoded.includes('\\') || /(?:^|\/)\.\.?(?:\/|$)/.test(decoded)) {
    throw new Error(`Invalid public artifact: ${label} contains encoded path traversal`)
  }
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid public artifact: ${label} must be a non-empty string`)
  }
}
