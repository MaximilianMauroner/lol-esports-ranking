import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { createArchive, ARCHIVE_PAGE_BYTES } from '../src/lib/publicArtifacts/archive.mjs'
import { assertCanonicalPublicLogicalPath } from '../src/lib/publicArtifacts/logicalPath.mjs'

export { assertCanonicalPublicLogicalPath, canonicalPublicLogicalPath } from '../src/lib/publicArtifacts/logicalPath.mjs'

export const CONTENT_ADDRESSED_STORAGE_MODE = 'content-addressed-gzip-v1'

const volatileArtifactKeys = new Set(['artifactMeta', 'generatedAt', 'modelVersion', 'modelConfigHash', 'schemaVersion'])

export function prepareSemanticArtifact(value, { compress = true } = {}) {
  assertRecord(value, 'public artifact')
  const withoutVolatileMetadata = Object.fromEntries(Object.entries(value).filter(([key]) => !volatileArtifactKeys.has(key)))
  const children = []
  const store = (content) => {
    const prepared = prepareEnvelope(content, compress)
    if (prepared.bytes > ARCHIVE_PAGE_BYTES || prepared.compressedBytes > ARCHIVE_PAGE_BYTES) throw new Error('Public archive node exceeds page budget')
    children.push(prepared)
    return { sha256: prepared.digest, bytes: prepared.bytes, encoding: 'gzip' }
  }
  const content = normalizeKnownLogicalUrls(withoutVolatileMetadata)
  // The ranking bootstrap keeps its existing size contract; history and entity
  // payloads use bounded immutable archive nodes when their logical view grows.
  const archived = content.artifactKind === 'public-ranking-manifest' || (content.artifactKind === 'public-snapshot-shard' && Buffer.byteLength(canonicalJsonFor(content)) <= 1_000_000)
    ? content : createArchive(content, store)
  return { ...prepareEnvelope(archived, compress), children }
}

function prepareEnvelope(content, compress) {
  const semantic = { artifactKind: 'public-semantic-artifact', schemaVersion: 1, content }
  const canonicalJson = canonicalJsonFor(semantic)
  const canonicalBytes = Buffer.from(canonicalJson, 'utf8')
  const digest = createHash('sha256').update(canonicalBytes).digest('hex')
  const compressed = compress ? gzipSync(canonicalBytes, { level: 9, mtime: 0 }) : Buffer.alloc(0)
  return { semantic, canonicalJson, canonicalBytes, digest, bytes: canonicalBytes.byteLength, compressed, compressedBytes: compressed.byteLength }
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
  const artifacts = {}
  for (const entry of entries) {
    assertCanonicalPublicLogicalPath(entry.logicalPath, 'generation manifest logical path')
    const logicalPath = entry.logicalPath
    if (Object.hasOwn(artifacts, logicalPath)) {
      throw new Error(`Invalid public artifact: duplicate logical path alias ${logicalPath}`)
    }
    artifacts[logicalPath] = {
      logicalPath,
      objectUrl: `/data/objects/sha256/${entry.digest}`,
      generationId,
      sha256: entry.digest,
      bytes: entry.bytes,
      storageEncoding: 'gzip',
      transportEncodings: ['identity', 'gzip'],
      encoding: 'gzip',
    }
  }
  return {
    artifactKind: 'public-artifact-generation-manifest',
    schemaVersion: 2,
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
    artifacts,
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

export class NonCanonicalJsonError extends Error {}

export function parseCanonicalJson(text) {
  if (typeof text !== 'string') throw new TypeError('Canonical JSON input must be text')
  const value = JSON.parse(text)
  let offset = 0
  function matchToken(token) {
    if (!text.startsWith(token, offset)) return false
    offset += token.length
    return true
  }
  function matchValue(entry) {
    if (entry === null || typeof entry !== 'object') return matchToken(JSON.stringify(entry) ?? 'null')
    if (Array.isArray(entry)) {
      // Parsing without a reviver guarantees dense arrays of JSON values.
      if (!('toJSON' in entry) && entry.every((item) => item === null || typeof item !== 'object')) {
        return matchToken(JSON.stringify(entry))
      }
      if (!matchToken('[')) return false
      for (let index = 0; index < entry.length; index += 1) {
        if (index > 0 && !matchToken(',')) return false
        if (!matchValue(entry[index])) return false
      }
      return matchToken(']')
    }
    if (!matchToken('{')) return false
    const keys = Object.keys(entry).filter((key) => entry[key] !== undefined).sort()
    for (let index = 0; index < keys.length; index += 1) {
      if (index > 0 && !matchToken(',')) return false
      const key = keys[index]
      if (!matchToken(JSON.stringify(key)) || !matchToken(':') || !matchValue(entry[key])) return false
    }
    return matchToken('}')
  }
  if (!matchValue(value) || offset !== text.length) throw new NonCanonicalJsonError('JSON text is not canonical')
  return value
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
  return {
    ...value,
    ...(typeof value.url === 'string' ? { url: normalizeLogicalArtifactUrl(value.url) } : {}),
    ...(Array.isArray(value.pages) ? { pages: transformArrayEntryUrls(value.pages) } : {}),
  }
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
