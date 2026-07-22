import {
  PUBLIC_ARTIFACT_SCHEMA_VERSION,
  type PublicRankingManifest,
} from './schema'

export const PUBLIC_GENERATION_MANIFEST_SCHEMA_VERSION = 1 as const
export const PUBLIC_SEMANTIC_ARTIFACT_SCHEMA_VERSION = 1 as const

export type PublicArtifactEncoding = 'identity' | 'gzip'

export type PublicGenerationArtifactEntry = {
  logicalPath: string
  objectUrl: string
  generationId: string
  sha256: string
  bytes: number
  encoding: PublicArtifactEncoding
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
  constructor(public readonly status: number) {
    super(`Public artifact request failed with ${status}`)
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
  assertLogicalPath(value.rootArtifact, 'generation manifest rootArtifact')
  assertRecord(value.artifacts, 'generation manifest artifacts')

  const entries = Object.entries(value.artifacts)
  if (entries.length === 0) throw new Error('Invalid public artifact: generation manifest artifacts must not be empty')
  for (const [logicalPath, candidate] of entries) {
    assertLogicalPath(logicalPath, `generation manifest artifact key ${logicalPath}`)
    assertRecord(candidate, `generation manifest artifact ${logicalPath}`)
    assertEqual(candidate.logicalPath, logicalPath, `generation manifest artifact ${logicalPath} logicalPath`)
    assertEqual(candidate.generationId, value.generationId, `generation manifest artifact ${logicalPath} generationId`)
    assertSafeObjectUrl(candidate.objectUrl, `generation manifest artifact ${logicalPath} objectUrl`)
    assertSha256(candidate.sha256, `generation manifest artifact ${logicalPath} sha256`)
    assertObjectUrlDigest(candidate.objectUrl, candidate.sha256, `generation manifest artifact ${logicalPath} objectUrl`)
    assertNonNegativeInteger(candidate.bytes, `generation manifest artifact ${logicalPath} bytes`)
    assertOneOf(candidate.encoding, ['identity', 'gzip'], `generation manifest artifact ${logicalPath} encoding`)
  }
  if (!Object.hasOwn(value.artifacts, value.rootArtifact)) {
    throw new Error('Invalid public artifact: generation manifest rootArtifact mapping is incomplete')
  }

  return value as PublicArtifactGenerationManifest
}

export function createPublicSemanticArtifact(value: unknown): PublicSemanticArtifact {
  assertRecord(value, 'semantic artifact source')
  const content = Object.fromEntries(Object.entries(value).filter(([key]) => !volatileArtifactKeys.has(key)))
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
    cache?: RequestCache
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

  const logicalPath = canonicalLogicalPath(logicalUrl)
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
  const semanticArtifact = parsePublicSemanticArtifact(await response.json())
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
  const logicalPath = canonicalLogicalPath(logicalUrl)
  if (!context.manifest.artifacts[logicalPath]) {
    throw new Error(`Invalid public artifact: generation mapping is incomplete for ${logicalPath}`)
  }
}

function hydrateSemanticArtifact(
  artifact: PublicSemanticArtifact,
  manifest: PublicArtifactGenerationManifest,
): Record<string, unknown> {
  return {
    ...artifact.content,
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
  return [...new Set(urls.map(canonicalLogicalPath))]
}

function canonicalLogicalPath(value: string) {
  const url = new URL(value, 'https://public-artifacts.invalid')
  const decodedPath = decodeURIComponent(url.pathname)
  assertLogicalPath(decodedPath, 'artifact logical path')
  return decodedPath
}

function assertLogicalPath(value: unknown, label: string): asserts value is string {
  assertString(value, label)
  if (!value.startsWith('/data/') || value.includes('\\') || /(?:^|\/)\.\.?(?:\/|$)/.test(value)) {
    throw new Error(`Invalid public artifact: ${label} must be a safe /data/ path`)
  }
  if (/%(?:2f|5c)/i.test(value)) {
    throw new Error(`Invalid public artifact: ${label} contains encoded path separators`)
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw new Error(`Invalid public artifact: ${label} contains invalid percent encoding`)
  }
  if (decoded.includes('\\') || /(?:^|\/)\.\.?(?:\/|$)/.test(decoded)) {
    throw new Error(`Invalid public artifact: ${label} contains encoded path traversal`)
  }
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
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
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
