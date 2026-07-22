import {
  PUBLIC_ARTIFACT_SCHEMA_VERSION,
  type PublicRankingManifest,
} from './schema'
import { assertCanonicalPublicLogicalPath, canonicalPublicLogicalPath } from './logicalPath.mjs'

export const PUBLIC_GENERATION_MANIFEST_SCHEMA_VERSION = 1 as const
export const PUBLIC_SEMANTIC_ARTIFACT_SCHEMA_VERSION = 1 as const

export type PublicArtifactEncoding = 'identity' | 'gzip'
type PublicArtifactCacheMode = 'default' | 'no-store' | 'reload' | 'no-cache' | 'force-cache' | 'only-if-cached'

export type PublicGenerationArtifactEntry = {
  logicalPath: string
  objectUrl: string
  generationId: string
  sha256: string
  /** Canonical UTF-8 byte length of the uncompressed semantic JSON. */
  bytes: number
  /** Legacy expected transport encoding for schema-v1 manifests. */
  encoding: PublicArtifactEncoding
  /** Encoding of the immutable object stored in the bucket. */
  storageEncoding?: PublicArtifactEncoding
  /** HTTP encodings the serving layer may use after reading the stored object. */
  transportEncodings?: PublicArtifactEncoding[]
}

export type PublicArtifactGenerationManifest = {
  artifactKind: 'public-artifact-generation-manifest'
  schemaVersion: typeof PUBLIC_GENERATION_MANIFEST_SCHEMA_VERSION
  generationId: string
  runId: string
  generatedAt: string
  model: {
    version: string
    configHash: string
  }
  provenance: {
    source: string
    dataMode: PublicRankingManifest['dataMode']
    sourceProviders: string[]
  }
  rootArtifact: string
  artifacts: Record<string, PublicGenerationArtifactEntry>
}

export type PublicSemanticArtifact = {
  artifactKind: 'public-semantic-artifact'
  schemaVersion: typeof PUBLIC_SEMANTIC_ARTIFACT_SCHEMA_VERSION
  content: Record<string, unknown>
}

type GenerationContext = {
  manifest: PublicArtifactGenerationManifest
  manifestUrl: string
}

const generationContexts = new WeakMap<object, GenerationContext>()
const volatileArtifactKeys = new Set(['artifactMeta', 'generatedAt', 'modelVersion', 'modelConfigHash', 'schemaVersion'])

export class PublicArtifactRequestError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Public artifact request failed with ${status}`)
    this.status = status
  }
}

export function parsePublicArtifactGenerationManifest(value: unknown): PublicArtifactGenerationManifest {
  assertRecord(value, 'generation manifest')
  assertEqual(value.artifactKind, 'public-artifact-generation-manifest', 'generation manifest artifactKind')
  assertEqual(value.schemaVersion, PUBLIC_GENERATION_MANIFEST_SCHEMA_VERSION, 'generation manifest schemaVersion')
  assertSafeIdentifier(value.generationId, 'generation manifest generationId')
  assertSafeIdentifier(value.runId, 'generation manifest runId')
  assertString(value.generatedAt, 'generation manifest generatedAt')
  assertRecord(value.model, 'generation manifest model')
  assertString(value.model.version, 'generation manifest model version')
  assertString(value.model.configHash, 'generation manifest model configHash')
  assertRecord(value.provenance, 'generation manifest provenance')
  assertString(value.provenance.source, 'generation manifest provenance source')
  assertOneOf(value.provenance.dataMode, ['no-data', 'seeded-sample', 'scheduled-public-data'], 'generation manifest provenance dataMode')
  assertStringArray(value.provenance.sourceProviders, 'generation manifest provenance sourceProviders')
  assertCanonicalPublicLogicalPath(value.rootArtifact, 'generation manifest rootArtifact')
  assertRecord(value.artifacts, 'generation manifest artifacts')

  const entries = Object.entries(value.artifacts)
  if (entries.length === 0) throw new Error('Invalid public artifact: generation manifest artifacts must not be empty')
  for (const [logicalPath, candidate] of entries) {
    assertCanonicalPublicLogicalPath(logicalPath, `generation manifest artifact key ${logicalPath}`)
    assertRecord(candidate, `generation manifest artifact ${logicalPath}`)
    assertEqual(candidate.logicalPath, logicalPath, `generation manifest artifact ${logicalPath} logicalPath`)
    assertEqual(candidate.generationId, value.generationId, `generation manifest artifact ${logicalPath} generationId`)
    assertSafeObjectUrl(candidate.objectUrl, `generation manifest artifact ${logicalPath} objectUrl`)
    assertSha256(candidate.sha256, `generation manifest artifact ${logicalPath} sha256`)
    assertObjectUrlDigest(candidate.objectUrl, candidate.sha256, `generation manifest artifact ${logicalPath} objectUrl`)
    assertNonNegativeInteger(candidate.bytes, `generation manifest artifact ${logicalPath} bytes`)
    assertOneOf(candidate.encoding, ['identity', 'gzip'], `generation manifest artifact ${logicalPath} encoding`)
    if (candidate.storageEncoding !== undefined) {
      assertOneOf(candidate.storageEncoding, ['identity', 'gzip'], `generation manifest artifact ${logicalPath} storageEncoding`)
    }
    if (candidate.transportEncodings !== undefined) {
      assertArtifactTransportEncodings(candidate.transportEncodings, `generation manifest artifact ${logicalPath} transportEncodings`)
      if (candidate.storageEncoding === undefined) {
        throw new Error(`Invalid public artifact: generation manifest artifact ${logicalPath} storageEncoding is required with transportEncodings`)
      }
    }
  }
  if (!Object.hasOwn(value.artifacts, value.rootArtifact)) {
    throw new Error('Invalid public artifact: generation manifest rootArtifact mapping is incomplete')
  }

  return value as PublicArtifactGenerationManifest
}

export function createPublicSemanticArtifact(value: unknown): PublicSemanticArtifact {
  assertRecord(value, 'semantic artifact source')
  const withoutVolatileMetadata = Object.fromEntries(Object.entries(value).filter(([key]) => !volatileArtifactKeys.has(key)))
  const content = normalizeKnownLogicalUrls(withoutVolatileMetadata)
  return {
    artifactKind: 'public-semantic-artifact',
    schemaVersion: PUBLIC_SEMANTIC_ARTIFACT_SCHEMA_VERSION,
    content,
  }
}

export function parsePublicSemanticArtifact(value: unknown): PublicSemanticArtifact {
  assertRecord(value, 'semantic artifact')
  assertEqual(value.artifactKind, 'public-semantic-artifact', 'semantic artifact artifactKind')
  assertEqual(value.schemaVersion, PUBLIC_SEMANTIC_ARTIFACT_SCHEMA_VERSION, 'semantic artifact schemaVersion')
  assertRecord(value.content, 'semantic artifact content')
  for (const key of volatileArtifactKeys) {
    if (Object.hasOwn(value.content, key)) {
      throw new Error(`Invalid public artifact: semantic artifact content must not contain volatile ${key}`)
    }
  }
  assertString(value.content.artifactKind, 'semantic artifact content artifactKind')
  return value as PublicSemanticArtifact
}

export function canonicalSemanticJson(value: PublicSemanticArtifact) {
  return canonicalJson(value)
}

export async function semanticArtifactIdentity(value: PublicSemanticArtifact) {
  const contents = canonicalSemanticJson(value)
  const bytes = new TextEncoder().encode(contents)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return {
    sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    bytes: bytes.byteLength,
  }
}

export function registerGenerationContext(
  artifact: object,
  manifest: PublicArtifactGenerationManifest,
  manifestUrl: string,
) {
  generationContexts.set(artifact, { manifest, manifestUrl })
}

export function generationContextFor(artifact: object) {
  return generationContexts.get(artifact)
}

export async function fetchPublicArtifact<T extends object>(
  owner: object,
  logicalUrl: string,
  fallbackBaseUrl: string,
  parse: (value: unknown) => T,
  {
    fetcher = fetch,
    signal,
    cache,
  }: {
    fetcher?: typeof fetch
    signal?: AbortSignal
    cache?: PublicArtifactCacheMode
  } = {},
): Promise<T> {
  const context = generationContexts.get(owner)
  if (!context) {
    const response = await fetcher(resolveUrl(logicalUrl, fallbackBaseUrl), {
      signal,
      cache,
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw new PublicArtifactRequestError(response.status)
    return parse(await response.json())
  }

  const logicalPath = canonicalPublicLogicalPath(logicalUrl)
  const entry = context.manifest.artifacts[logicalPath]
  if (!entry) throw new Error(`Invalid public artifact: generation mapping is incomplete for ${logicalPath}`)
  if (entry.generationId !== context.manifest.generationId) {
    throw new Error(`Invalid public artifact: mixed generation mapping for ${logicalPath}`)
  }
  const response = await fetcher(resolveUrl(entry.objectUrl, context.manifestUrl), {
    signal,
    cache,
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new PublicArtifactRequestError(response.status)
  assertTransportEncoding(response, entry, logicalPath)
  const semanticArtifact = parsePublicSemanticArtifact(await parseSemanticResponse(response, logicalPath))
  const identity = await semanticArtifactIdentity(semanticArtifact)
  if (identity.sha256 !== entry.sha256 || identity.bytes !== entry.bytes) {
    throw new Error(`Invalid public artifact: semantic digest mismatch for ${logicalPath}`)
  }

  const hydrated = hydrateSemanticArtifact(semanticArtifact, context.manifest)
  const parsed = parse(hydrated)
  assertArtifactModelIdentity(parsed, context.manifest, logicalPath)
  registerGenerationContext(parsed, context.manifest, context.manifestUrl)
  return parsed
}

function normalizeKnownLogicalUrls(content: Record<string, unknown>): Record<string, unknown> {
  switch (content.artifactKind) {
    case 'public-ranking-manifest':
      return normalizeRankingManifestUrls(content)
    case 'team-history-index':
    case 'match-history-index':
      return { ...content, scopeIndex: normalizeRecordEntryUrls(content.scopeIndex) }
    case 'tournament-movement-index':
      return { ...content, tournaments: normalizeArrayEntryUrls(content.tournaments) }
    case 'match-history-catalog':
      return { ...content, pages: normalizeArrayEntryUrls(content.pages) }
    default:
      return content
  }
}

function normalizeRankingManifestUrls(content: Record<string, unknown>) {
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
  ] as const) {
    if (typeof normalized[key] === 'string') normalized[key] = normalizeLogicalArtifactUrl(normalized[key])
  }
  normalized.snapshotIndex = normalizeRecordEntryUrls(normalized.snapshotIndex)
  return normalized
}

function normalizeRecordEntryUrls(value: unknown) {
  return transformRecordEntryUrls(value, normalizeLogicalArtifactUrl)
}

function transformRecordEntryUrls(value: unknown, transform: (value: string) => string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, transformEntryUrl(entry, transform)]))
}

function normalizeArrayEntryUrls(value: unknown) {
  return transformArrayEntryUrls(value, normalizeLogicalArtifactUrl)
}

function transformArrayEntryUrls(value: unknown, transform: (value: string) => string): unknown {
  if (!Array.isArray(value)) return value
  return value.map((entry) => transformEntryUrl(entry, transform))
}

function transformEntryUrl(value: unknown, transform: (value: string) => string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const entry = value as Record<string, unknown>
  return {
    ...entry,
    ...(typeof entry.url === 'string' ? { url: transform(entry.url) } : {}),
    ...(Array.isArray(entry.pages) ? { pages: transformArrayEntryUrls(entry.pages, transform) } : {}),
  }
}

function normalizeLogicalArtifactUrl(value: string) {
  const url = new URL(value, 'https://public-artifacts.invalid')
  if (!url.pathname.startsWith('/data/')) return value
  url.searchParams.delete('v')
  url.searchParams.sort()
  const query = url.searchParams.toString()
  return `${url.pathname}${query ? `?${query}` : ''}`
}

function withGenerationVersion(value: string, runId: string) {
  const url = new URL(value, 'https://public-artifacts.invalid')
  if (!url.pathname.startsWith('/data/')) return value
  url.searchParams.set('v', runId)
  url.searchParams.sort()
  const query = url.searchParams.toString()
  return `${url.pathname}?${query}`
}

function assertTransportEncoding(
  response: Response,
  entry: PublicGenerationArtifactEntry,
  logicalPath: string,
) {
  const header = response.headers.get('content-encoding')?.trim().toLowerCase()
  const actual = !header || header === 'identity' ? 'identity' : header
  if (actual !== 'identity' && actual !== 'gzip') {
    throw new Error(`Invalid public artifact: unsupported Content-Encoding ${actual} for ${logicalPath}`)
  }
  const allowed = entry.transportEncodings ?? [entry.encoding]
  if (!allowed.includes(actual)) {
    throw new Error(`Invalid public artifact: ${actual} transport is not allowed for ${logicalPath}`)
  }
}

async function parseSemanticResponse(
  response: Response,
  logicalPath: string,
) {
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    if (response.headers.get('content-encoding')?.trim().toLowerCase() === 'gzip') {
      throw new Error(`Invalid public artifact: gzip transport was not decoded by fetch for ${logicalPath}`, { cause: error })
    }
    throw new Error(`Invalid public artifact: identity transport is not valid JSON for ${logicalPath}`, { cause: error })
  }
}

function assertArtifactTransportEncodings(value: unknown, label: string): asserts value is PublicArtifactEncoding[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid public artifact: ${label} must be a non-empty array`)
  }
  const seen = new Set<PublicArtifactEncoding>()
  for (const encoding of value) {
    assertOneOf(encoding, ['identity', 'gzip'], `${label} entry`)
    if (seen.has(encoding)) throw new Error(`Invalid public artifact: ${label} must not contain duplicates`)
    seen.add(encoding)
  }
}

export function validateGenerationRankingManifest(
  rankingManifest: PublicRankingManifest,
  generationManifest: PublicArtifactGenerationManifest,
) {
  if (
    rankingManifest.model.version !== generationManifest.model.version
    || rankingManifest.model.configHash !== generationManifest.model.configHash
  ) {
    throw new Error('Invalid public artifact: ranking manifest model identity mismatch')
  }
  if (
    rankingManifest.source !== generationManifest.provenance.source
    || rankingManifest.dataMode !== generationManifest.provenance.dataMode
  ) {
    throw new Error('Invalid public artifact: ranking manifest provenance mismatch')
  }
  const sourceProviders = [...new Set(rankingManifest.sources.map((source) => source.name))].sort()
  const expectedProviders = [...new Set(generationManifest.provenance.sourceProviders)].sort()
  if (canonicalJson(sourceProviders) !== canonicalJson(expectedProviders)) {
    throw new Error('Invalid public artifact: ranking manifest source provenance mismatch')
  }

  for (const logicalPath of rankingManifestLogicalPaths(rankingManifest)) {
    if (!generationManifest.artifacts[logicalPath]) {
      throw new Error(`Invalid public artifact: generation mapping is incomplete for ${logicalPath}`)
    }
  }
}

export function assertGenerationMapping(owner: object, logicalUrl: string) {
  const context = generationContexts.get(owner)
  if (!context) return
  const logicalPath = canonicalPublicLogicalPath(logicalUrl)
  if (!context.manifest.artifacts[logicalPath]) {
    throw new Error(`Invalid public artifact: generation mapping is incomplete for ${logicalPath}`)
  }
}

function hydrateSemanticArtifact(
  artifact: PublicSemanticArtifact,
  manifest: PublicArtifactGenerationManifest,
): Record<string, unknown> {
  const content = hydrateKnownLogicalUrls(artifact.content, manifest.runId)
  return {
    ...content,
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    generatedAt: manifest.generatedAt,
    modelVersion: manifest.model.version,
    modelConfigHash: manifest.model.configHash,
    artifactMeta: {
      schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
      runId: manifest.runId,
      generatedAt: manifest.generatedAt,
      modelVersion: manifest.model.version,
      modelConfigHash: manifest.model.configHash,
    },
  }
}

function hydrateKnownLogicalUrls(content: Record<string, unknown>, runId: string) {
  const hydrateUrl = (value: string) => withGenerationVersion(value, runId)
  switch (content.artifactKind) {
    case 'public-ranking-manifest': {
      const hydrated = { ...content }
      for (const key of [
        'fullSnapshotUrl',
        'playerDirectoryUrl',
        'teamDirectoryUrl',
        'teamHistoryIndexUrl',
        'teamHistoryUrl',
        'regionHistoryUrl',
        'tournamentMovementIndexUrl',
        'matchHistoryIndexUrl',
      ] as const) {
        if (typeof hydrated[key] === 'string') hydrated[key] = hydrateUrl(hydrated[key])
      }
      hydrated.snapshotIndex = transformRecordEntryUrls(hydrated.snapshotIndex, hydrateUrl)
      return hydrated
    }
    case 'team-history-index':
    case 'match-history-index':
      return { ...content, scopeIndex: transformRecordEntryUrls(content.scopeIndex, hydrateUrl) }
    case 'tournament-movement-index':
      return { ...content, tournaments: transformArrayEntryUrls(content.tournaments, hydrateUrl) }
    case 'match-history-catalog':
      return { ...content, pages: transformArrayEntryUrls(content.pages, hydrateUrl) }
    default:
      return content
  }
}

function assertArtifactModelIdentity(
  artifact: object,
  manifest: PublicArtifactGenerationManifest,
  logicalPath: string,
) {
  const candidate = artifact as Record<string, unknown>
  if (candidate.modelVersion !== undefined && candidate.modelVersion !== manifest.model.version) {
    throw new Error(`Invalid public artifact: modelVersion mismatch for ${logicalPath}`)
  }
  if (candidate.modelConfigHash !== undefined && candidate.modelConfigHash !== manifest.model.configHash) {
    throw new Error(`Invalid public artifact: modelConfigHash mismatch for ${logicalPath}`)
  }
}

function rankingManifestLogicalPaths(manifest: PublicRankingManifest) {
  const urls = [
    manifest.playerDirectoryUrl,
    manifest.fullSnapshotUrl,
    manifest.teamDirectoryUrl,
    manifest.teamHistoryIndexUrl,
    manifest.teamHistoryUrl,
    manifest.regionHistoryUrl,
    manifest.tournamentMovementIndexUrl,
    manifest.matchHistoryIndexUrl,
    ...Object.values(manifest.snapshotIndex).map((entry) => entry.url),
  ].filter((url): url is string => Boolean(url))
  return [...new Set(urls.map(canonicalPublicLogicalPath))]
}

function assertSafeObjectUrl(value: unknown, label: string): asserts value is string {
  assertString(value, label)
  if (value.includes('\\')) throw new Error(`Invalid public artifact: ${label} must not contain backslashes`)
  const decodedValue = decodeURIComponent(value)
  if (/(?:^|\/)\.\.?(?:\/|$)/.test(decodedValue) || decodedValue.includes('\\')) {
    throw new Error(`Invalid public artifact: ${label} contains path traversal`)
  }
  const url = new URL(value, 'https://public-artifacts.invalid')
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Invalid public artifact: ${label} must use HTTP(S)`)
  if (url.username || url.password) throw new Error(`Invalid public artifact: ${label} must not contain credentials`)
  const decodedPath = decodeURIComponent(url.pathname)
  if (/(?:^|\/)\.\.?(?:\/|$)/.test(decodedPath) || decodedPath.includes('\\')) {
    throw new Error(`Invalid public artifact: ${label} contains path traversal`)
  }
}

function assertObjectUrlDigest(value: string, digest: string, label: string) {
  const url = new URL(value, 'https://public-artifacts.invalid')
  if (!decodeURIComponent(url.pathname).includes(digest)) {
    throw new Error(`Invalid public artifact: ${label} must contain its semantic digest`)
  }
}

function resolveUrl(value: string, baseUrl: string) {
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('/')) return value
  const runtime = globalThis as typeof globalThis & { location?: { origin?: unknown } }
  const origin = typeof runtime.location?.origin === 'string' ? runtime.location.origin : 'http://localhost'
  const base = /^[a-z][a-z\d+.-]*:/i.test(baseUrl) ? baseUrl : new URL(baseUrl, origin).toString()
  return new URL(value, base).toString()
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => entry === undefined ? 'null' : canonicalJson(entry)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid public artifact: ${label} must be an object`)
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid public artifact: ${label} must be a non-empty string`)
  }
}

function assertSafeIdentifier(value: unknown, label: string): asserts value is string {
  assertString(value, label)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`Invalid public artifact: ${label} must be a safe identifier`)
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid public artifact: ${label} must be an array`)
  value.forEach((entry, index) => assertString(entry, `${label}[${index}]`))
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid public artifact: ${label} must be a non-negative integer`)
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Invalid public artifact: ${label} must be a lowercase SHA-256 digest`)
  }
}

function assertOneOf<T extends string>(value: unknown, options: readonly T[], label: string): asserts value is T {
  if (typeof value !== 'string' || !options.includes(value as T)) {
    throw new Error(`Invalid public artifact: ${label} must be one of ${options.join(', ')}`)
  }
}

function assertEqual<T>(value: unknown, expected: T, label: string): asserts value is T {
  if (value !== expected) throw new Error(`Invalid public artifact: ${label} must be ${String(expected)}`)
}
