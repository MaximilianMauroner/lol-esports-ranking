import { createHash } from 'node:crypto'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { canonicalJsonFor } from './public-artifact-storage.mjs'

export const GENERATION_PUBLICATION_SCHEMA_VERSION = 1
export const GENERATION_PUBLICATION_STATUS = 'ready'

const legacyPointerFields = new Set([
  'schemaVersion',
  'generationId',
  'fencingToken',
  'promotedAt',
  'manifestKey',
  'storageMode',
  'manifestDigest',
  'manifestBytes',
  'manifestEtag',
  'stateManifestKey',
  'stateManifestDigest',
  'rawReceiptKey',
  'rawReceiptDigest',
  'rawReceiptBytes',
  'rawReceiptCompressedBytes',
  'sourceReceiptDigest',
  'rawIdentityDigest',
  'leaseKey',
  'leaseOwner',
  'leaseFencingToken',
  'leaseAcquiredAt',
  'leaseExpiresAt',
  'leaseRenewedAt',
  'leaseReleasedAt',
])
const legacyNativePointerFields = new Set([
  ...legacyPointerFields,
  'publicManifestSchemaVersion',
  'previousGeneration',
])

export function classifyActiveGenerationPointer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Active generation pointer is invalid')
  }
  const publicationFields = [
    'publicationReceiptKey',
    'publicationReceiptDigest',
    'publicationReceiptBytes',
    'publicationReceiptEtag',
  ]
  const present = publicationFields.filter((field) => value[field] !== undefined)
  if (value.publicationSchemaVersion === undefined) {
    if (present.length > 0) throw new Error('Legacy active generation pointer has contradictory publication receipt fields')
    if (value.publicManifestSchemaVersion === 2
      && Object.keys(value).every((field) => legacyNativePointerFields.has(field))) {
      return 'legacy-native'
    }
    if (value.publicManifestSchemaVersion !== undefined || value.previousGeneration !== undefined
      || Object.keys(value).some((field) => !legacyPointerFields.has(field))) {
      throw new Error('Legacy active generation pointer has unsupported native authority fields')
    }
    return 'legacy'
  }
  if (value.publicationSchemaVersion !== 1) {
    throw new Error('Active generation pointer publication schema is unsupported')
  }
  if (present.length !== publicationFields.length
    || typeof value.publicationReceiptKey !== 'string' || value.publicationReceiptKey.length === 0
    || !/^[a-f0-9]{64}$/.test(value.publicationReceiptDigest ?? '')
    || !Number.isSafeInteger(value.publicationReceiptBytes) || value.publicationReceiptBytes <= 0
    || typeof value.publicationReceiptEtag !== 'string' || value.publicationReceiptEtag.length === 0) {
    throw new Error('Active generation pointer publication receipt binding is incomplete')
  }
  return 'receipt-bound'
}

export function assertLegacyNativeGenerationCutoverPointer(pointer, publicManifest, publishReceipt) {
  const parsedReceipt = parseLegacyNativeGenerationPublishReceipt(publishReceipt, {
    generationId: pointer.generationId,
    prefix: prefixForAbsoluteKey(pointer.manifestKey),
  })
  if (classifyActiveGenerationPointer(pointer) !== 'legacy-native'
    || pointer.storageMode !== 'content-addressed-gzip-v1'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pointer.generationId ?? '')
    || typeof pointer.manifestKey !== 'string' || pointer.manifestKey.length === 0
    || !/^[a-f0-9]{64}$/.test(pointer.manifestDigest ?? '')
    || !Number.isSafeInteger(pointer.manifestBytes) || pointer.manifestBytes <= 0
    || typeof pointer.manifestEtag !== 'string' || pointer.manifestEtag.length === 0
    || !publicManifest || typeof publicManifest !== 'object' || Array.isArray(publicManifest)
    || publicManifest.artifactKind !== 'public-artifact-generation-manifest'
    || publicManifest.schemaVersion !== 2
    || publicManifest.generationId !== pointer.generationId
    || publicManifest.runId !== pointer.generationId
    || publicManifest.storageMode !== pointer.storageMode
    || parsedReceipt.authorities.publicManifest.key !== pointer.manifestKey
    || parsedReceipt.authorities.publicManifest.digest !== pointer.manifestDigest
    || parsedReceipt.authorities.publicManifest.bytes !== pointer.manifestBytes
    || parsedReceipt.authorities.rawReceipt.key !== pointer.rawReceiptKey
    || parsedReceipt.authorities.rawReceipt.digest !== pointer.rawReceiptDigest
    || parsedReceipt.authorities.rawReceipt.bytes !== pointer.rawReceiptCompressedBytes) {
    throw new Error('Legacy native active generation pointer is not bound to its schema-v2 publish receipt')
  }
  return true
}

export async function readLegacyNativeGenerationPublishReceipt(client, config, pointer) {
  if (classifyActiveGenerationPointer(pointer) !== 'legacy-native') {
    throw new Error('Active generation pointer is not a legacy native publication')
  }
  const prefix = config.prefix ?? ''
  const key = `${prefix ? `${prefix}/` : ''}generations/${pointer.generationId}/publish.json`
  const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
  const bytes = await bodyBytes(object.Body)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (Number(object.ContentLength) !== bytes.byteLength
    || object.ContentType !== 'application/json; charset=utf-8'
    || object.ContentEncoding !== undefined
    || object.Metadata?.sha256 !== digest
    || object.Metadata?.['semantic-bytes'] !== String(bytes.byteLength)) {
    throw new Error('Legacy native generation publish receipt authority mismatch')
  }
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error('Legacy native generation publish receipt is corrupt', { cause: error })
  }
  const receipt = parseLegacyNativeGenerationPublishReceipt(value, {
    generationId: pointer.generationId,
    prefix,
  })
  if (canonicalJsonFor(receipt) !== bytes.toString('utf8')) {
    throw new Error('Legacy native generation publish receipt is not canonical JSON')
  }
  return receipt
}

export function parseLegacyNativeGenerationPublishReceipt(value, { generationId, prefix = '' } = {}) {
  assertRecord(value, 'legacy native generation publish receipt')
  const required = [
    'schemaVersion', 'publishedAt', 'prefix', 'generationId', 'artifactCount',
    'uploadedCount', 'uploadedBytes', 'unchangedCount', 'unchangedBytes',
    'artifacts', 'unchanged', 'skipped', 'storageMode', 'authorities',
  ]
  const optional = new Set(['storage', 'refreshTelemetry'])
  if (required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.has(key))
    || value.schemaVersion !== 2 || value.storageMode !== 'content-addressed-gzip-v1'
    || value.generationId !== generationId || value.prefix !== prefix
    || typeof value.publishedAt !== 'string' || new Date(value.publishedAt).toISOString() !== value.publishedAt
    || !Array.isArray(value.artifacts) || !Array.isArray(value.unchanged) || !Array.isArray(value.skipped)) {
    throw new Error('Invalid legacy native generation publish receipt schema')
  }
  const entries = [...value.artifacts, ...value.unchanged]
  for (const entry of entries) assertLegacyPublishEntry(entry, prefix)
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) {
    throw new Error('Duplicate legacy native generation publish reference')
  }
  const expected = {
    artifactCount: entries.length,
    uploadedCount: value.artifacts.length,
    uploadedBytes: sumBytes(value.artifacts),
    unchangedCount: value.unchanged.length,
    unchangedBytes: sumBytes(value.unchanged),
  }
  if (Object.entries(expected).some(([key, count]) => value[key] !== count)) {
    throw new Error('Legacy native generation publish receipt counters are inconsistent')
  }
  assertRecord(value.authorities, 'legacy native generation publish authorities')
  if (Object.keys(value.authorities).sort().join(',') !== 'publicManifest,rawReceipt') {
    throw new Error('Legacy native generation publish authorities are incomplete')
  }
  for (const authority of Object.values(value.authorities)) {
    assertLegacyPublishEntry(authority, prefix)
    if (authority.contentType !== 'application/json; charset=utf-8'
      || entries.filter((entry) => entry.key === authority.key && entry.digest === authority.digest
        && entry.bytes === authority.bytes && entry.contentType === authority.contentType).length !== 1) {
      throw new Error('Legacy native generation publish authority is not bound to one receipt entry')
    }
  }
  return value
}

export function assertLegacyGenerationCutoverPointer(pointer, publicManifest) {
  if (classifyActiveGenerationPointer(pointer) !== 'legacy'
    || pointer.storageMode !== 'content-addressed-gzip-v1'
    || typeof pointer.generationId !== 'string' || pointer.generationId.length === 0
    || typeof pointer.manifestKey !== 'string' || pointer.manifestKey.length === 0
    || !/^[a-f0-9]{64}$/.test(pointer.manifestDigest ?? '')
    || !Number.isSafeInteger(pointer.manifestBytes) || pointer.manifestBytes <= 0
    || typeof pointer.manifestEtag !== 'string' || pointer.manifestEtag.length === 0
    || !publicManifest || typeof publicManifest !== 'object' || Array.isArray(publicManifest)
    || publicManifest.artifactKind !== 'public-artifact-generation-manifest'
    || publicManifest.schemaVersion !== 1
    || publicManifest.generationId !== pointer.generationId
    || publicManifest.runId !== pointer.generationId
    || publicManifest.storageMode !== pointer.storageMode) {
    throw new Error('Legacy active generation pointer is not an explicit schema-v1 cutover authority')
  }
  return true
}

const immutableKeyPatterns = [
  /^generations\/[A-Za-z0-9][A-Za-z0-9._-]*\/manifest\.json$/,
  /^objects\/sha256\/[a-f0-9]{64}$/,
  /^state\/generations\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/,
  /^state\/objects\/sha256\/[a-f0-9]{64}$/,
  /^raw\/objects\/sha256\/[a-f0-9]{64}$/,
]

export function createGenerationPublicationReceipt({
  generationId,
  preparedAt,
  prefix = '',
  fencingToken,
  leaseOwner,
  promotionEtag,
  provenance,
  authorities,
  objects,
}) {
  const receipt = {
    artifactKind: 'ranking-generation-publication-readiness',
    schemaVersion: GENERATION_PUBLICATION_SCHEMA_VERSION,
    status: GENERATION_PUBLICATION_STATUS,
    generationId,
    preparedAt,
    prefix,
    fencing: { token: fencingToken, owner: leaseOwner, promotionEtag },
    provenance,
    authorities,
    objects: [...objects].sort((left, right) => left.key.localeCompare(right.key)),
  }
  return parseGenerationPublicationReceipt(receipt, { generationId, prefix })
}

export function parseGenerationPublicationReceipt(value, { generationId, prefix } = {}) {
  assertRecord(value, 'generation publication receipt')
  assertExactKeys(value, [
    'artifactKind', 'schemaVersion', 'status', 'generationId', 'preparedAt', 'prefix',
    'fencing', 'provenance', 'authorities', 'objects',
  ], 'generation publication receipt')
  if (value.artifactKind !== 'ranking-generation-publication-readiness'
    || value.schemaVersion !== GENERATION_PUBLICATION_SCHEMA_VERSION
    || value.status !== GENERATION_PUBLICATION_STATUS) {
    throw new Error('Invalid generation publication receipt schema')
  }
  assertSafeId(value.generationId, 'generation publication generationId')
  if (generationId !== undefined && value.generationId !== generationId) {
    throw new Error('Generation publication receipt generation mismatch')
  }
  assertIso(value.preparedAt, 'generation publication preparedAt')
  if (typeof value.prefix !== 'string' || value.prefix.startsWith('/') || value.prefix.endsWith('/')) {
    throw new Error('Invalid generation publication prefix')
  }
  if (prefix !== undefined && value.prefix !== prefix) throw new Error('Generation publication prefix mismatch')

  assertRecord(value.fencing, 'generation publication fencing')
  assertExactKeys(value.fencing, ['token', 'owner', 'promotionEtag'], 'generation publication fencing')
  if (!Number.isSafeInteger(value.fencing.token) || value.fencing.token < 1) {
    throw new Error('Invalid generation publication fencing token')
  }
  assertNonEmpty(value.fencing.owner, 'generation publication lease owner')
  assertNonEmpty(value.fencing.promotionEtag, 'generation publication promotion ETag')

  assertRecord(value.provenance, 'generation publication provenance')
  assertExactKeys(value.provenance, [
    'modelVersion', 'modelConfigHash', 'source', 'dataMode', 'sourceProviders',
  ], 'generation publication provenance')
  for (const key of ['modelVersion', 'modelConfigHash', 'source', 'dataMode']) {
    assertNonEmpty(value.provenance[key], `generation publication provenance ${key}`)
  }
  if (!Array.isArray(value.provenance.sourceProviders)
    || value.provenance.sourceProviders.some((provider) => typeof provider !== 'string' || provider.length === 0)
    || new Set(value.provenance.sourceProviders).size !== value.provenance.sourceProviders.length) {
    throw new Error('Invalid generation publication source providers')
  }

  assertRecord(value.authorities, 'generation publication authorities')
  const authorityKeys = ['publicManifest', 'rawReceipt', ...(value.authorities.stateManifest ? ['stateManifest'] : [])]
  assertExactKeys(value.authorities, authorityKeys, 'generation publication authorities')
  const publicManifest = parseAuthority(value.authorities.publicManifest, 'public manifest', value.prefix)
  const rawReceipt = parseAuthority(value.authorities.rawReceipt, 'raw receipt', value.prefix)
  const stateManifest = value.authorities.stateManifest
    ? parseAuthority(value.authorities.stateManifest, 'state manifest', value.prefix)
    : undefined
  const base = value.prefix ? `${value.prefix}/` : ''
  if (publicManifest.key !== `${base}generations/${value.generationId}/manifest.json`) {
    throw new Error('Generation publication public manifest key is not canonical')
  }
  if (rawReceipt.key !== `${base}raw/objects/sha256/${rawReceipt.digest}`) {
    throw new Error('Generation publication raw receipt key is not canonical')
  }
  if (stateManifest && stateManifest.key !== `${base}state/generations/${value.generationId}.json`) {
    throw new Error('Generation publication state manifest key is not canonical')
  }

  if (!Array.isArray(value.objects) || value.objects.length === 0) {
    throw new Error('Generation publication immutable closure is empty')
  }
  const objects = value.objects.map((entry) => parseOutcome(entry, value.prefix))
  if (new Set(objects.map((entry) => entry.key)).size !== objects.length) {
    throw new Error('Generation publication immutable closure has duplicate membership')
  }
  for (const authority of [publicManifest, rawReceipt, ...(stateManifest ? [stateManifest] : [])]) {
    const member = objects.find((entry) => entry.key === authority.key)
    if (!member || member.digest !== authority.digest || member.bytes !== authority.bytes) {
      throw new Error(`Generation publication authority is absent from immutable closure: ${authority.key}`)
    }
  }
  return value
}

export function publicationReceiptBytes(value) {
  const body = Buffer.from(canonicalJsonFor(parseGenerationPublicationReceipt(value)))
  return {
    body,
    bytes: body.byteLength,
    digest: createHash('sha256').update(body).digest('hex'),
  }
}

export function deduplicatePublicationOutcomes(entries) {
  const priority = { reused: 0, unchanged: 1, uploaded: 2 }
  const byKey = new Map()
  for (const entry of entries) {
    const current = byKey.get(entry.key)
    if (!current || priority[entry.outcome] > priority[current.outcome]) byKey.set(entry.key, entry)
  }
  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key))
}

function parseAuthority(value, label, prefix) {
  assertRecord(value, `generation publication ${label} authority`)
  assertExactKeys(value, ['key', 'digest', 'bytes'], `generation publication ${label} authority`)
  parseObjectIdentity(value, label, prefix)
  return value
}

function parseOutcome(value, prefix) {
  assertRecord(value, 'generation publication object')
  assertExactKeys(value, ['key', 'digest', 'bytes', 'outcome'], 'generation publication object')
  parseObjectIdentity(value, 'object', prefix)
  if (!['uploaded', 'unchanged', 'reused'].includes(value.outcome)) {
    throw new Error('Invalid generation publication object outcome')
  }
  return value
}

function parseObjectIdentity(value, label, prefix) {
  assertNonEmpty(value.key, `generation publication ${label} key`)
  const relative = prefix ? value.key.slice(prefix.length + 1) : value.key
  if (prefix && !value.key.startsWith(`${prefix}/`)) {
    throw new Error(`Generation publication ${label} is outside its prefix`)
  }
  if (!immutableKeyPatterns.some((pattern) => pattern.test(relative))) {
    throw new Error(`Generation publication ${label} uses a mutable or unknown namespace`)
  }
  if (!/^[a-f0-9]{64}$/.test(value.digest ?? '') || !Number.isSafeInteger(value.bytes) || value.bytes <= 0) {
    throw new Error(`Invalid generation publication ${label} identity`)
  }
  const digestKey = /^(?:objects|state\/objects|raw\/objects)\/sha256\/([a-f0-9]{64})$/.exec(relative)
  if (digestKey && digestKey[1] !== value.digest) {
    throw new Error(`Generation publication ${label} digest does not match its key`)
  }
}

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`)
}

function assertLegacyPublishEntry(value, prefix) {
  assertRecord(value, 'legacy native generation publish entry')
  if (Object.keys(value).some((key) => !['key', 'bytes', 'contentType', 'digest'].includes(key))
    || typeof value.key !== 'string' || value.key.length === 0
    || (prefix && !value.key.startsWith(`${prefix}/`))
    || !Number.isSafeInteger(value.bytes) || value.bytes <= 0
    || typeof value.contentType !== 'string' || value.contentType.length === 0
    || !/^[a-f0-9]{64}$/.test(value.digest ?? '')) {
    throw new Error('Invalid legacy native generation publish entry')
  }
}

function prefixForAbsoluteKey(key) {
  if (typeof key !== 'string') return ''
  const marker = '/generations/'
  const index = key.indexOf(marker)
  return index < 0 ? '' : key.slice(0, index)
}

function sumBytes(entries) {
  return entries.reduce((total, entry) => total + (Number(entry?.bytes) || 0), 0)
}

async function bodyBytes(body) {
  if (typeof body?.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray())
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body)
  const chunks = []
  for await (const chunk of body ?? []) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function assertExactKeys(value, expected, label) {
  if (Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) {
    throw new Error(`Invalid ${label} fields`)
  }
}

function assertNonEmpty(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${label}`)
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`Invalid ${label}`)
}

function assertIso(value, label) {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime()) || new Date(value).toISOString() !== value) {
    throw new Error(`Invalid ${label}`)
  }
}
