import { canonicalPublicLogicalPath } from './logicalPath.mjs'
import vocabulary from './referenceFields.json' with { type: 'json' }

const referenceFields = new Map(Object.entries(vocabulary))

export function mapArtifactReferences(content, transform) {
  const fields = referenceFields.get(content.artifactKind)
  if (!fields) return content
  const mapped = { ...content }
  for (const [key, role] of Object.entries(fields.urls ?? {})) {
    if (typeof mapped[key] === 'string') mapped[key] = transform(mapped[key], role)
  }
  for (const key of fields.records ?? []) {
    const entries = mapped[key]
    mapped[key] = entries && typeof entries === 'object' && !Array.isArray(entries)
      ? Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, mapEntry(entry, transform)]))
      : entries
  }
  for (const key of fields.arrays ?? []) {
    mapped[key] = mapEntries(mapped[key], transform)
  }
  return mapped
}

function mapEntries(value, transform) {
  return Array.isArray(value) ? value.map((entry) => mapEntry(entry, transform)) : value
}

function mapEntry(value, transform) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return {
    ...value,
    ...(typeof value.url === 'string' ? { url: transform(value.url, 'required') } : {}),
    ...(Array.isArray(value.pages) ? { pages: mapEntries(value.pages, transform) } : {}),
  }
}

export function artifactReferences(content) {
  const paths = new Set()
  mapArtifactReferences(content, (value, role) => {
    if (role === 'audit' && !new URL(value, 'https://public-artifacts.invalid').pathname.startsWith('/data/')) return value
    paths.add(canonicalPublicLogicalPath(value))
    return value
  })
  return [...paths]
}

export function assertReferenceClosure(edges, available) {
  for (const [referrer, targets] of edges) {
    for (const target of targets) {
      if (!available.has(target)) {
        throw new Error(`Incomplete public artifact references: ${referrer} references missing ${target}. Select the generated target in createPublicArtifactWritePlan.`)
      }
    }
  }
}

export function normalizeLogicalArtifactUrl(value) {
  const url = new URL(value, 'https://public-artifacts.invalid')
  if (!url.pathname.startsWith('/data/')) return value
  url.searchParams.delete('v')
  url.searchParams.sort()
  const query = url.searchParams.toString()
  return `${url.pathname}${query ? `?${query}` : ''}`
}
