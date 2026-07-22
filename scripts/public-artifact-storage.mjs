import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

export const CONTENT_ADDRESSED_STORAGE_MODE = 'content-addressed-gzip-v1'

const volatileArtifactKeys = new Set(['artifactMeta', 'generatedAt', 'modelVersion', 'modelConfigHash', 'schemaVersion'])

export function prepareSemanticArtifact(value) {
  assertRecord(value, 'public artifact')
  const withoutVolatileMetadata = Object.fromEntries(Object.entries(value).filter(([key]) => !volatileArtifactKeys.has(key)))
  const semantic = {
    artifactKind: 'public-semantic-artifact',
    schemaVersion: 1,
    content: normalizeKnownLogicalUrls(withoutVolatileMetadata),
  }
  const canonicalJson = canonicalJsonFor(semantic)
  const canonicalBytes = Buffer.from(canonicalJson, 'utf8')
  const digest = createHash('sha256').update(canonicalBytes).digest('hex')
  const compressed = gzipSync(canonicalBytes, { level: 9, mtime: 0 })
  return {
    semantic,
    canonicalJson,
    canonicalBytes,
    digest,
    bytes: canonicalBytes.byteLength,
    compressed,
    compressedBytes: compressed.byteLength,
  }
}

export function createGenerationManifest({ generationId, rootManifest, entries }) {
  assertRecord(rootManifest, 'ranking root manifest')
  assertRecord(rootManifest.model, 'ranking root model')
  assertString(rootManifest.model.version, 'ranking root model version')
  assertString(rootManifest.model.configHash, 'ranking root model configHash')
  assertString(rootManifest.generatedAt, 'ranking root generatedAt')
  assertString(rootManifest.source, 'ranking root source')
  assertString(rootManifest.dataMode, 'ranking root dataMode')
  if (!Array.isArray(rootManifest.sources)) throw new Error('Invalid public artifact: ranking root sources must be an array')
  const runId = typeof rootManifest.artifactMeta?.runId === 'string' ? rootManifest.artifactMeta.runId : generationId
  if (runId !== generationId) throw new Error('Invalid public artifact: generationId must match ranking root runId')
  return {
    artifactKind: 'public-artifact-generation-manifest',
    schemaVersion: 1,
    storageMode: CONTENT_ADDRESSED_STORAGE_MODE,
    generationId,
    runId,
    generatedAt: rootManifest.generatedAt,
    model: {
      version: rootManifest.model.version,
      configHash: rootManifest.model.configHash,
    },
    provenance: {
      source: rootManifest.source,
      dataMode: rootManifest.dataMode,
      sourceProviders: rootManifest.sources.map((source, index) => {
        assertRecord(source, `ranking root sources[${index}]`)
        assertString(source.name, `ranking root sources[${index}] name`)
        return source.name
      }),
    },
    rootArtifact: '/data/ranking-summary.json',
    artifacts: Object.fromEntries(entries.map((entry) => [entry.logicalPath, {
      logicalPath: entry.logicalPath,
      objectUrl: `/data/objects/sha256/${entry.digest}`,
      generationId,
      sha256: entry.digest,
      bytes: entry.bytes,
      encoding: 'gzip',
    }])),
  }
}

export function canonicalJsonFor(value) {
  if (value === null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => entry === undefined ? 'null' : canonicalJsonFor(entry)).join(',')}]`
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonFor(value[key])}`)
    .join(',')}}`
}

function normalizeKnownLogicalUrls(content) {
  switch (content.artifactKind) {
    case 'public-ranking-manifest':
      return normalizeRankingManifestUrls(content)
    case 'team-history-index':
    case 'match-history-index':
      return { ...content, scopeIndex: transformRecordEntryUrls(content.scopeIndex) }
    case 'tournament-movement-index':
      return { ...content, tournaments: transformArrayEntryUrls(content.tournaments) }
    case 'match-history-catalog':
      return { ...content, pages: transformArrayEntryUrls(content.pages) }
    default:
      return content
  }
}

function normalizeRankingManifestUrls(content) {
  const normalized = { ...content }
  for (const key of [
    'fullSnapshotUrl',
    'playerDirectoryUrl',
    'teamDirectoryUrl',
    'teamHistoryIndexUrl',
    'teamHistoryUrl',
    'regionHistoryUrl',
    'tournamentMovementIndexUrl',
    'matchHistoryIndexUrl',
  ]) {
    if (typeof normalized[key] === 'string') normalized[key] = normalizeLogicalArtifactUrl(normalized[key])
  }
  normalized.snapshotIndex = transformRecordEntryUrls(normalized.snapshotIndex)
  return normalized
}

function transformRecordEntryUrls(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, transformEntryUrl(entry)]))
}

function transformArrayEntryUrls(value) {
  if (!Array.isArray(value)) return value
  return value.map(transformEntryUrl)
}

function transformEntryUrl(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return typeof value.url === 'string'
    ? { ...value, url: normalizeLogicalArtifactUrl(value.url) }
    : value
}

function normalizeLogicalArtifactUrl(value) {
  const url = new URL(value, 'https://public-artifacts.invalid')
  if (!url.pathname.startsWith('/data/')) return value
  url.searchParams.delete('v')
  url.searchParams.sort()
  const query = url.searchParams.toString()
  return `${url.pathname}${query ? `?${query}` : ''}`
}

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid public artifact: ${label} must be an object`)
  }
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid public artifact: ${label} must be a non-empty string`)
  }
}
