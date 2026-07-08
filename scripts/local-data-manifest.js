import { isAbsolute, resolve, sep } from 'node:path'

export function manifestWithResolvedFiles(manifest, rawDir) {
  if (!manifest || typeof manifest !== 'object') return manifest
  const files = {}
  for (const [kind, entries] of Object.entries(manifest.files ?? {})) {
    files[kind] = Array.isArray(entries)
      ? entries.map((entry) => resolveManifestFilePath(entry, rawDir))
      : entries
  }
  return {
    ...manifest,
    files,
  }
}

export function resolveManifestFilePath(value, rawDir) {
  const path = String(value ?? '')
  const root = resolve(rawDir)
  if (!path) return root
  if (!isAbsolute(path)) return resolve(root, path)

  const localPrefix = `${root}${sep}`
  const resolvedPath = resolve(path)
  if (resolvedPath === root || resolvedPath.startsWith(localPrefix)) return resolvedPath

  const suffix = rawDataPathSuffix(path)
  return suffix ? resolve(root, ...suffix) : resolvedPath
}

function rawDataPathSuffix(path) {
  const parts = String(path).replaceAll('\\', '/').split('/').filter(Boolean)
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    if (parts[index] === 'data' && parts[index + 1] === 'raw') {
      return parts.slice(index + 2)
    }
  }
  return undefined
}
