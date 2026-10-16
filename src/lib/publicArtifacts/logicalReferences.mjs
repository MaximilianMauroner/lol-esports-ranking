import { canonicalPublicLogicalPath } from './logicalPath.mjs'

const referenceFields = new Map([
  ['public-ranking-manifest', {
    urls: {
      fullSnapshotUrl: 'audit',
      playerDirectoryUrl: 'required',
      teamDirectoryUrl: 'required',
      teamHistoryIndexUrl: 'required',
      regionHistoryUrl: 'required',
      tournamentMovementIndexUrl: 'required',
      matchHistoryIndexUrl: 'required',
    },
    records: ['snapshotIndex'],
  }],
  ['team-history-index', { records: ['scopeIndex'] }],
  ['match-history-index', { records: ['scopeIndex'] }],
  ['tournament-movement-index', { arrays: ['tournaments'] }],
  ['match-history-catalog', { arrays: ['pages'] }],
])

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

export function normalizeLogicalArtifactUrl(value) {
  const url = new URL(value, 'https://public-artifacts.invalid')
  if (!url.pathname.startsWith('/data/')) return value
  url.searchParams.delete('v')
  url.searchParams.sort()
  const query = url.searchParams.toString()
  return `${url.pathname}${query ? `?${query}` : ''}`
}
