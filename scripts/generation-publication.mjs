import { createHash } from 'node:crypto'
import { canonicalJsonFor } from './public-artifact-storage.mjs'

export const GENERATION_PUBLICATION_SCHEMA_VERSION = 1
export const GENERATION_PUBLICATION_STATUS = 'ready'

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
