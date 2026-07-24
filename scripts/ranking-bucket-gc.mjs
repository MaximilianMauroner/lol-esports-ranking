import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { canonicalJsonFor, canonicalPublicLogicalPath } from './public-artifact-storage.mjs'
import { parseIncrementalStateManifest } from './incremental-state-storage.mjs'
import { parseFullAuditReceipt } from './full-audit-storage.mjs'
import { decodeRawObject, parseRawSourceReceipt } from './raw-source-storage.mjs'
import { bucketConfigFromEnv, bucketKey, createBucketClient, parseGenerationPublishReceipt, readBucketJson, safeRequestedObjectPath } from './railway-bucket.mjs'
import { parseGenerationPublicationReceipt } from './generation-publication.mjs'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const APPROVED_IMMUTABLE_KEYS = [
  /^generations\/[A-Za-z0-9][A-Za-z0-9._-]*\/(?:manifest\.json|publish\.json|data\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/,
  /^objects\/sha256\/[a-f0-9]{64}$/,
  /^state\/generations\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/,
  /^state\/objects\/sha256\/[a-f0-9]{64}$/,
  /^raw\/objects\/sha256\/[a-f0-9]{64}$/,
  /^audits\/days\/\d{4}-\d{2}-\d{2}\.json$/,
  /^audits\/objects\/sha256\/[a-f0-9]{64}$/,
]

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  parseGcArgs(process.argv.slice(2))
  const config = bucketConfigFromEnv()
  const client = createBucketClient(config)
  if (!config.enabled || !client) throw new Error(`Ranking bucket is not configured: ${(config.missing ?? []).join(', ')}`)
  const result = await buildRankingBucketInventory({ config, client })
  process.stdout.write(`${canonicalJsonFor(result)}\n`)
}

export function parseGcArgs(argv = []) {
  if (argv.length > 0) throw new Error('Ranking bucket GC is inventory-only; deletion and approval arguments are unavailable')
  return {}
}

export async function buildRankingBucketInventory({
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
  now = () => new Date(),
} = {}) {
  if (!config?.enabled || !client) throw new Error('Ranking bucket GC requires configured bucket storage')
  const capturedNow = new Date(now())
  const midnight = utcMidnight(capturedNow)
  const inventoryDate = midnight.toISOString().slice(0, 10)
  const generationCutoffDate = new Date(midnight.getTime() - 13 * DAY_MS)
  const auditCutoffDate = new Date(midnight.getTime() - 13 * DAY_MS)
  const policy = {
    retainAllGenerationDays: 14,
    retainNewestGenerationCount: 50,
    retainAuditDays: 14,
    minimumDeleteAgeHours: 48,
    generationCutoff: generationCutoffDate.toISOString(),
    auditCutoff: auditCutoffDate.toISOString().slice(0, 10),
  }
  const objects = await listInventory(client, config)
  const objectByKey = new Map(objects.map((object) => [object.key, object]))
  const protectedReasons = new Map()
  const errors = []
  const missingReferences = []
  const addError = (key, reason, error) => errors.push({ key, reason, ...(error ? { message: error instanceof Error ? error.message : String(error) } : {}) })
  const protect = (key, reason) => {
    if (!objectByKey.has(key)) return false
    const reasons = protectedReasons.get(key) ?? new Set()
    reasons.add(reason)
    protectedReasons.set(key, reasons)
    return true
  }
  const requireObject = (fromKey, referencedKey, reason) => {
    if (objectByKey.has(referencedKey)) return true
    missingReferences.push({ fromKey, referencedKey, reason })
    addError(fromKey, reason, `Missing retained reference ${referencedKey}`)
    return false
  }
  const activeKey = bucketKey(config, 'active-generation.json')
  const activeObject = objectByKey.get(activeKey)
  protect(activeKey, 'active-pointer')
  let active
  if (!activeObject?.etag) addError(activeKey, 'active-pointer-etag-missing')
  try {
    const read = await readBucketJson('active-generation.json', { config, client })
    if (!read.found || !read.etag || !read.value || typeof read.value !== 'object') throw new Error('Active pointer is missing or unreadable')
    active = { value: read.value, etag: read.etag }
  } catch (error) {
    addError(activeKey, 'active-pointer-invalid', error)
  }

  for (const object of objects) {
    if (!isApprovedImmutableKey(relativeKey(config, object.key))) protect(object.key, 'operational-or-unknown-namespace')
  }

  const generations = await publicGenerationRoots(objects, config, client, addError)
  const retainedGenerationIds = new Set()
  for (const root of generations.filter((entry) => new Date(entry.lastModified) >= generationCutoffDate)) retainedGenerationIds.add(root.generationId)
  for (const root of [...generations]
    .sort((left, right) => right.lastModified.localeCompare(left.lastModified) || left.generationId.localeCompare(right.generationId))
    .slice(0, policy.retainNewestGenerationCount)) retainedGenerationIds.add(root.generationId)
  const pointerAuthorities = []
  if (active) {
    const current = parsePointerGeneration(active.value, 'active generation', activeKey, addError, config, true)
    if (current) {
      retainedGenerationIds.add(current.generationId)
      pointerAuthorities.push({ ...current, reason: 'active-generation' })
    }
    if (active.value.previousGeneration !== undefined) {
      const previous = parsePointerGeneration(active.value.previousGeneration, 'previous generation', activeKey, addError, config, false)
      if (previous) {
        retainedGenerationIds.add(previous.generationId)
        pointerAuthorities.push({ ...previous, reason: 'previous-generation' })
      }
    }
  }

  const visitedState = new Map()
  const visitedRaw = new Map()
  const verifyReference = async (fromKey, reference, namespace, reason) => {
    const parsed = parseObjectReference(reference, namespace)
    const literal = absoluteReferenceKey(config, parsed.key)
    if (!requireObject(fromKey, literal, reason)) return undefined
    protect(literal, reason)
    const inventoryObject = objectByKey.get(literal)
    try {
      const stored = await getStored(client, config, literal)
      if (stored.contentEncoding !== 'gzip' || stored.metadata?.sha256 !== parsed.sha256
        || stored.metadata?.['semantic-bytes'] !== String(parsed.bytes) || stored.metadata?.encoding !== 'gzip'
        || inventoryObject.bytes !== parsed.compressedBytes || stored.bytes.byteLength !== parsed.compressedBytes) {
        throw new Error('Referenced object metadata does not match authority')
      }
      const semantic = gunzipSync(stored.bytes)
      if (semantic.byteLength !== parsed.bytes || sha256(semantic) !== parsed.sha256) throw new Error('Referenced object content does not match authority')
      return semantic
    } catch (error) {
      addError(fromKey, `${reason}-corrupt`, error)
      return undefined
    }
  }
  const traverseRawReceipt = async (fromKey, receiptKey, digest, reason) => {
    if (!requireObject(fromKey, receiptKey, reason)) return
    protect(receiptKey, reason)
    try {
      const stored = await getStored(client, config, receiptKey)
      const inventoryObject = objectByKey.get(receiptKey)
      const semanticBytes = Number(stored.metadata?.['semantic-bytes'])
      const reference = {
        key: relativeKey(config, receiptKey),
        sha256: digest ?? /^raw\/objects\/sha256\/([a-f0-9]{64})$/.exec(relativeKey(config, receiptKey))?.[1],
        bytes: semanticBytes,
        compressedBytes: inventoryObject.bytes,
        storageEncoding: 'gzip',
      }
      if (stored.contentEncoding !== 'gzip' || stored.metadata?.encoding !== 'gzip'
        || !/^[a-f0-9]{64}$/.test(reference.sha256 ?? '') || stored.metadata?.sha256 !== reference.sha256
        || !Number.isSafeInteger(semanticBytes) || semanticBytes <= 0 || stored.bytes.byteLength !== inventoryObject.bytes) throw new Error('Raw receipt authority metadata is invalid')
      if (visitedRaw.has(receiptKey)) return visitedRaw.get(receiptKey)
      const receipt = parseRawSourceReceipt(decodeRawObject(reference, stored.bytes))
      visitedRaw.set(receiptKey, receipt)
      const refs = [
        ...receipt.oracle.flatMap((source) => [source.baseline, ...source.deltas]),
        ...receipt.leaguepedia.map((source) => source.object),
        ...receipt.lolesports.map((source) => source.object),
      ]
      for (const referenceValue of refs) await verifyReference(receiptKey, referenceValue, 'raw', 'retained-raw-reference')
      return receipt
    } catch (error) {
      addError(receiptKey, 'retained-raw-receipt-invalid', error)
      return undefined
    }
  }
  const traverseState = async (fromKey, manifestKey, digest, reason) => {
    if (!requireObject(fromKey, manifestKey, reason)) return
    protect(manifestKey, reason)
    try {
      const stored = await getStored(client, config, manifestKey)
      const storedDigest = sha256(stored.bytes)
      if (stored.metadata?.sha256 !== storedDigest || stored.metadata?.['semantic-bytes'] !== String(stored.bytes.byteLength)) throw new Error('State manifest stored metadata is invalid')
      if (digest && storedDigest !== digest) throw new Error('State manifest digest differs from pointer authority')
      if (visitedState.has(manifestKey)) return visitedState.get(manifestKey)
      const manifest = parseIncrementalStateManifest(JSON.parse(stored.bytes.toString('utf8')))
      visitedState.set(manifestKey, manifest)
      if (canonicalJsonFor(manifest) !== stored.bytes.toString('utf8')) throw new Error('State manifest is not canonical JSON')
      await verifyReference(manifestKey, manifest.canonicalLedger, 'state', 'retained-state-ledger')
      for (const checkpoint of manifest.checkpoints) await verifyReference(manifestKey, checkpoint.object, 'state', 'retained-state-checkpoint')
      if (manifest.baseGenerationId) {
        await traverseState(manifestKey, bucketKey(config, `state/generations/${manifest.baseGenerationId}.json`), undefined, 'retained-state-base-chain')
      }
      return manifest
    } catch (error) {
      addError(manifestKey, 'retained-state-manifest-invalid', error)
      return undefined
    }
  }

  for (const authority of pointerAuthorities) {
    const manifestKey = absoluteReferenceKey(config, authority.manifestKey)
    requireObject(activeKey, manifestKey, `${authority.reason}-public-manifest`)
    protect(manifestKey, `${authority.reason}-public-manifest`)
    if (objectByKey.has(manifestKey)) {
      try {
        const stored = await getStored(client, config, manifestKey)
        const digest = sha256(stored.bytes)
        assertStoredPublicManifest(stored, digest)
        if (authority.manifestDigest && authority.manifestDigest !== digest) throw new Error('Public manifest pointer digest mismatch')
        if (authority.manifestBytes !== undefined && authority.manifestBytes !== stored.bytes.byteLength) throw new Error('Public manifest pointer byte length mismatch')
        if (authority.manifestEtag && authority.manifestEtag !== stored.etag) throw new Error('Public manifest pointer ETag mismatch')
        parsePublicGenerationManifest(JSON.parse(stored.bytes.toString('utf8')), authority.generationId)
      } catch (error) {
        addError(activeKey, `${authority.reason}-public-authority-invalid`, error)
      }
    }
    if (authority.stateManifestKey) {
      const state = await traverseState(activeKey, absoluteReferenceKey(config, authority.stateManifestKey), authority.stateManifestDigest, `${authority.reason}-state`)
      if (state && state.generationId !== authority.generationId) addError(activeKey, `${authority.reason}-state-generation-mismatch`)
    }
    if (authority.rawReceiptKey) {
      const raw = await traverseRawReceipt(activeKey, absoluteReferenceKey(config, authority.rawReceiptKey), authority.rawReceiptDigest, `${authority.reason}-raw`)
      if (raw && raw.generationId !== authority.generationId) addError(activeKey, `${authority.reason}-raw-generation-mismatch`)
      if (raw && authority.sourceReceiptDigest && raw.sourceReceiptDigest !== authority.sourceReceiptDigest) addError(activeKey, `${authority.reason}-source-receipt-digest-mismatch`)
      if (raw && authority.rawIdentityDigest && raw.rawIdentityDigest !== authority.rawIdentityDigest) addError(activeKey, `${authority.reason}-raw-identity-digest-mismatch`)
      if (raw && authority.rawReceiptBytes !== undefined) {
        const rawKey = absoluteReferenceKey(config, authority.rawReceiptKey)
        const rawStored = await getStored(client, config, rawKey)
        if (rawStored.metadata?.['semantic-bytes'] !== String(authority.rawReceiptBytes)
          || objectByKey.get(rawKey)?.bytes !== authority.rawReceiptCompressedBytes) addError(activeKey, `${authority.reason}-raw-size-mismatch`)
      }
    }
  }

  for (const generationId of [...retainedGenerationIds].sort()) {
    const candidates = generations.filter((entry) => entry.generationId === generationId)
    const manifestRoot = candidates.find((entry) => entry.kind === 'manifest')
    if (manifestRoot) {
      protect(manifestRoot.key, 'retained-public-generation')
      try {
        const stored = await getStored(client, config, manifestRoot.key)
        assertStoredPublicManifest(stored, sha256(stored.bytes))
        const manifest = parsePublicGenerationManifest(JSON.parse(stored.bytes.toString('utf8')), generationId)
        for (const [logicalPath, identity] of Object.entries(manifest.artifacts)) {
          if (identity?.logicalPath !== logicalPath || identity?.generationId !== generationId
            || identity?.objectUrl !== `/data/objects/sha256/${identity?.sha256}`) throw new Error(`Invalid artifact mapping ${logicalPath}`)
          await verifyReference(manifestRoot.key, {
            key: `objects/sha256/${identity.sha256}`,
            sha256: identity.sha256,
            bytes: identity.bytes,
            compressedBytes: objectByKey.get(bucketKey(config, `objects/sha256/${identity.sha256}`))?.bytes,
            storageEncoding: 'gzip',
          }, 'public', 'retained-public-artifact')
        }
      } catch (error) {
        addError(manifestRoot.key, 'retained-public-manifest-invalid', error)
      }
    } else addError(bucketKey(config, `generations/${generationId}`), 'retained-generation-root-missing')
    const generationPrefix = bucketKey(config, `generations/${generationId}/`)
    const retainedStateKey = bucketKey(config, `state/generations/${generationId}.json`)
    if (objectByKey.has(retainedStateKey)) {
      const state = await traverseState(manifestRoot?.key ?? generationPrefix, retainedStateKey, undefined, 'retained-generation-state')
      if (state && state.generationId !== generationId) addError(retainedStateKey, 'retained-generation-state-generation-mismatch')
    }
    const publishKey = bucketKey(config, `generations/${generationId}/publish.json`)
    if (objectByKey.has(publishKey)) {
      try {
        const publish = await readVerifiedPublishReceipt(client, config, publishKey, generationId)
        protect(publishKey, 'retained-generation-publish-authority')
        for (const entry of publishReceiptEntries(publish)) {
          if (typeof entry?.key !== 'string') throw new Error('Publish receipt has an invalid object key')
          const referenced = absoluteReferenceKey(config, entry.key)
          if (requireObject(publishKey, referenced, 'retained-publish-reference')) {
            const stored = await verifyPublishEntry(client, config, referenced, entry)
            protect(referenced, 'retained-publish-reference')
            if (referenced === publish.authorities.rawReceipt.key) {
              try {
                const value = JSON.parse(gunzipSync(stored.bytes).toString('utf8'))
                if (value?.artifactKind !== 'raw-source-generation-receipt') throw new Error('Raw receipt authority does not contain a raw source receipt')
                const raw = await traverseRawReceipt(publishKey, referenced, entry.digest, 'retained-generation-raw')
                if (raw && raw.generationId !== generationId) addError(publishKey, 'retained-generation-raw-generation-mismatch')
              } catch (error) {
                addError(publishKey, 'retained-publish-raw-reference-invalid', error)
              }
            } else if (referenced === publish.authorities.publicManifest.key) {
              parsePublicGenerationManifest(JSON.parse(stored.bytes.toString('utf8')), generationId)
            }
          }
        }
      } catch (error) {
        addError(publishKey, 'retained-publish-receipt-invalid', error)
      }
    } else addError(publishKey, 'retained-publish-receipt-missing')
  }

  for (let day = 0; day < policy.retainAuditDays; day += 1) {
    const auditDate = new Date(midnight.getTime() - day * DAY_MS).toISOString().slice(0, 10)
    const auditKey = bucketKey(config, `audits/days/${auditDate}.json`)
    if (!objectByKey.has(auditKey)) continue
    protect(auditKey, 'retained-daily-audit')
    try {
      const stored = await getStored(client, config, auditKey)
      const receipt = parseFullAuditReceipt(JSON.parse(stored.bytes.toString('utf8')))
      if (canonicalJsonFor(receipt) !== stored.bytes.toString('utf8') || receipt.auditDate !== auditDate) throw new Error('Audit receipt is not canonical for its UTC day')
      const raw = await traverseRawReceipt(auditKey, absoluteReferenceKey(config, receipt.sourceReceipt.key), receipt.sourceReceipt.sha256, 'retained-audit-source')
      if (raw && raw.generationId !== receipt.generationId) addError(auditKey, 'retained-audit-source-generation-mismatch')
      await verifyReference(auditKey, receipt.rawLedger, 'state', 'retained-audit-ledger')
      await verifyReference(auditKey, receipt.fullSnapshot, 'audit', 'retained-audit-snapshot')
    } catch (error) {
      addError(auditKey, 'retained-audit-receipt-invalid', error)
    }
  }

  errors.sort(compareKeyReason)
  missingReferences.sort((left, right) => left.fromKey.localeCompare(right.fromKey) || left.referencedKey.localeCompare(right.referencedKey) || left.reason.localeCompare(right.reason))
  const valid = errors.length === 0 && missingReferences.length === 0
  const deletionCandidates = []
  const danglingReferences = []
  for (const object of objects) {
    if (!isApprovedImmutableKey(relativeKey(config, object.key)) || protectedReasons.has(object.key)) continue
    const ageHours = Math.max(0, Math.floor((capturedNow.getTime() - new Date(object.lastModified).getTime()) / HOUR_MS))
    danglingReferences.push({ key: object.key, reason: 'unreferenced-immutable-object' })
    if (ageHours < policy.minimumDeleteAgeHours) protect(object.key, 'minimum-delete-age')
    else if (valid) deletionCandidates.push({ key: object.key, bytes: object.bytes, lastModified: object.lastModified, ageHours, reason: 'unreferenced-immutable-object' })
  }
  const protectedObjects = objects
    .filter((object) => protectedReasons.has(object.key))
    .map((object) => ({ ...publicObjectMetadata(object), reasons: [...protectedReasons.get(object.key)].sort() }))
    .sort(compareKey)
  deletionCandidates.sort(compareKey)
  danglingReferences.sort(compareKey)
  const beforeBytes = objects.reduce((sum, object) => sum + object.bytes, 0)
  const protectedBytes = protectedObjects.reduce((sum, object) => sum + object.bytes, 0)
  const deletionCandidateBytes = deletionCandidates.reduce((sum, object) => sum + object.bytes, 0)
  const payload = {
    artifactKind: 'ranking-bucket-gc-inventory',
    schemaVersion: 1,
    inventoryDate,
    activePointer: { key: activeKey, etag: active?.etag ?? '' },
    policy,
    valid,
    errors,
    protected: protectedObjects,
    deletionCandidates,
    danglingReferences,
    missingReferences,
    totals: {
      objectCount: objects.length,
      beforeBytes,
      protectedBytes,
      deletionCandidateBytes,
      estimatedAfterBytes: beforeBytes - deletionCandidateBytes,
    },
  }
  return { ...payload, inventorySha256: sha256(Buffer.from(canonicalJsonFor(payload))) }
}

async function listInventory(client, config) {
  const prefix = configuredPrefix(config)
  const objects = []
  let continuationToken
  do {
    const response = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, ContinuationToken: continuationToken }))
    for (const object of response.Contents ?? []) {
      if (typeof object.Key !== 'string' || object.Key.endsWith('/')) continue
      if (!Number.isSafeInteger(Number(object.Size)) || Number(object.Size) < 0 || !(object.LastModified instanceof Date) || Number.isNaN(object.LastModified.getTime())) {
        throw new Error(`Bucket inventory metadata is invalid for ${object.Key}`)
      }
      objects.push({ key: object.Key, bytes: Number(object.Size), lastModified: object.LastModified.toISOString(), etag: object.ETag ?? '' })
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
    if (response.IsTruncated && !continuationToken) throw new Error('Bucket inventory pagination did not return a continuation token')
  } while (continuationToken)
  return objects.sort(compareKey)
}

async function publicGenerationRoots(objects, config, client, addError) {
  const prefix = bucketKey(config, 'generations/')
  const roots = new Map()
  for (const object of objects) {
    if (!object.key.startsWith(prefix)) continue
    const relative = object.key.slice(prefix.length)
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/manifest\.json$/.exec(relative)
    if (match) roots.set(match[1], { generationId: match[1], key: object.key, lastModified: object.lastModified, kind: 'manifest' })
  }
  for (const root of roots.values()) {
    const publishKey = bucketKey(config, `generations/${root.generationId}/publish.json`)
    if (!objects.some((object) => object.key === publishKey)) continue
    try {
      const publish = await readVerifiedPublishReceipt(client, config, publishKey, root.generationId)
      const activityAt = publish.preparedAt ?? publish.publishedAt
      if (new Date(activityAt).getTime() > new Date(root.lastModified).getTime()) root.lastModified = activityAt
    } catch (error) {
      addError(publishKey, 'generation-publish-receipt-invalid', error)
    }
  }
  return [...roots.values()]
}

function parsePointerGeneration(value, label, key, addError, config, current) {
  if (!value || typeof value !== 'object' || typeof value.generationId !== 'string' || value.generationId.length === 0
    || typeof value.manifestKey !== 'string' || value.manifestKey.length === 0) {
    addError(key, `${label.replaceAll(' ', '-')}-invalid`)
    return undefined
  }
  const pair = (keyField, digestField) => {
    const hasKey = value[keyField] !== undefined
    const hasDigest = value[digestField] !== undefined
    if (hasKey !== hasDigest || (hasKey && (typeof value[keyField] !== 'string' || !/^[a-f0-9]{64}$/.test(value[digestField] ?? '')))) {
      addError(key, `${label.replaceAll(' ', '-')}-${keyField}-invalid`)
      return {}
    }
    return hasKey ? { [keyField]: value[keyField], [digestField]: value[digestField] } : {}
  }
  const expectedManifestKey = bucketKey(config, `generations/${value.generationId}/manifest.json`)
  const manifestKey = absoluteReferenceKey(config, value.manifestKey)
  if (manifestKey !== expectedManifestKey) addError(key, `${label.replaceAll(' ', '-')}-manifest-key-noncanonical`)
  const state = pair('stateManifestKey', 'stateManifestDigest')
  const raw = pair('rawReceiptKey', 'rawReceiptDigest')
  if (value.promotedAt !== undefined && (typeof value.promotedAt !== 'string' || Number.isNaN(new Date(value.promotedAt).getTime()))) {
    addError(key, `${label.replaceAll(' ', '-')}-promoted-at-invalid`)
  }
  if (current && value.storageMode === 'content-addressed-gzip-v1'
    && (!/^[a-f0-9]{64}$/.test(value.manifestDigest ?? '') || !Number.isSafeInteger(value.manifestBytes) || value.manifestBytes <= 0
      || typeof value.manifestEtag !== 'string' || value.manifestEtag.length === 0)) {
    addError(key, 'active-generation-public-authority-incomplete')
  }
  if (current && raw.rawReceiptKey
    && (!Number.isSafeInteger(value.rawReceiptBytes) || value.rawReceiptBytes <= 0
      || !Number.isSafeInteger(value.rawReceiptCompressedBytes) || value.rawReceiptCompressedBytes <= 0
      || !/^[a-f0-9]{64}$/.test(value.sourceReceiptDigest ?? '') || !/^[a-f0-9]{64}$/.test(value.rawIdentityDigest ?? ''))) {
    addError(key, 'active-generation-raw-authority-incomplete')
  }
  if (!current) {
    const approvedKeys = new Set([
      'generationId', 'manifestKey', 'promotedAt', 'stateManifestKey', 'stateManifestDigest',
      'rawReceiptKey', 'rawReceiptDigest', 'publicationSchemaVersion', 'publicationReceiptKey',
      'publicationReceiptDigest', 'publicationReceiptBytes', 'publicationReceiptEtag',
    ])
    if (Object.keys(value).some((field) => !approvedKeys.has(field))) addError(key, 'previous-generation-unknown-authority-field')
  }
  if (state.stateManifestKey && absoluteReferenceKey(config, state.stateManifestKey) !== bucketKey(config, `state/generations/${value.generationId}.json`)) {
    addError(key, `${label.replaceAll(' ', '-')}-state-manifest-key-noncanonical`)
  }
  if (raw.rawReceiptKey && absoluteReferenceKey(config, raw.rawReceiptKey) !== bucketKey(config, `raw/objects/sha256/${raw.rawReceiptDigest}`)) {
    addError(key, `${label.replaceAll(' ', '-')}-raw-receipt-key-noncanonical`)
  }
  return {
    generationId: value.generationId,
    manifestKey,
    ...state,
    ...raw,
    ...(current ? {
      manifestDigest: value.manifestDigest,
      manifestBytes: value.manifestBytes,
      manifestEtag: value.manifestEtag,
      sourceReceiptDigest: value.sourceReceiptDigest,
      rawIdentityDigest: value.rawIdentityDigest,
      rawReceiptBytes: value.rawReceiptBytes,
      rawReceiptCompressedBytes: value.rawReceiptCompressedBytes,
    } : {}),
  }
}

function parsePublicGenerationManifest(value, generationId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.artifactKind !== 'public-artifact-generation-manifest' || value.schemaVersion !== 2
    || value.storageMode !== 'content-addressed-gzip-v1' || value.generationId !== generationId || value.runId !== generationId
    || typeof value.generatedAt !== 'string' || Number.isNaN(new Date(value.generatedAt).getTime())
    || !value.model || typeof value.model.version !== 'string' || value.model.version.length === 0
    || typeof value.model.configHash !== 'string' || value.model.configHash.length === 0
    || !value.provenance || typeof value.provenance.source !== 'string' || value.provenance.source.length === 0
    || typeof value.provenance.dataMode !== 'string' || value.provenance.dataMode.length === 0
    || !Array.isArray(value.provenance.sourceProviders)
    || value.provenance.sourceProviders.some((provider) => typeof provider !== 'string' || provider.length === 0)
    || value.rootArtifact !== '/data/ranking-summary.json'
    || !value.artifacts || typeof value.artifacts !== 'object' || Array.isArray(value.artifacts)
    || Object.keys(value.artifacts).length === 0 || !Object.hasOwn(value.artifacts, value.rootArtifact)) {
    throw new Error('Invalid public generation manifest')
  }
  for (const [logicalPath, identity] of Object.entries(value.artifacts)) {
    if (canonicalPublicLogicalPath(logicalPath) !== logicalPath || !identity || typeof identity !== 'object'
      || identity.logicalPath !== logicalPath || identity.generationId !== generationId
      || !/^[a-f0-9]{64}$/.test(identity.sha256 ?? '') || !Number.isSafeInteger(identity.bytes) || identity.bytes <= 0
      || identity.objectUrl !== `/data/objects/sha256/${identity.sha256}`
      || identity.storageEncoding !== 'gzip' || identity.encoding !== 'gzip'
      || !Array.isArray(identity.transportEncodings) || !identity.transportEncodings.includes('identity') || !identity.transportEncodings.includes('gzip')) {
      throw new Error(`Invalid public generation artifact mapping: ${logicalPath}`)
    }
  }
  return value
}

async function getStored(client, config, literalKey) {
  const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: literalKey }))
  return {
    bytes: await bodyBytes(response.Body),
    etag: response.ETag,
    contentLength: response.ContentLength,
    contentType: response.ContentType,
    contentEncoding: response.ContentEncoding,
    metadata: response.Metadata ?? {},
  }
}

async function readVerifiedPublishReceipt(client, config, key, generationId) {
  const stored = await getStored(client, config, key)
  const digest = sha256(stored.bytes)
  if (stored.contentType !== 'application/json; charset=utf-8' || stored.contentEncoding !== undefined
    || Number(stored.contentLength) !== stored.bytes.byteLength || stored.metadata?.sha256 !== digest
    || stored.metadata?.['semantic-bytes'] !== String(stored.bytes.byteLength)) {
    throw new Error('Generation publish receipt stored authority metadata is invalid')
  }
  const value = JSON.parse(stored.bytes.toString('utf8'))
  if (canonicalJsonFor(value) !== stored.bytes.toString('utf8')) throw new Error('Generation publish receipt is not canonical JSON')
  return value?.artifactKind === 'ranking-generation-publication-readiness'
    ? parseGenerationPublicationReceipt(value, { generationId, prefix: config.prefix ?? '' })
    : parseGenerationPublishReceipt(value, { generationId, prefix: config.prefix ?? '' })
}

async function verifyPublishEntry(client, config, key, entry) {
  const stored = await getStored(client, config, key)
  if (stored.bytes.byteLength !== entry.bytes || Number(stored.contentLength) !== entry.bytes
    || (entry.contentType !== undefined && stored.contentType !== entry.contentType)
    || stored.metadata?.sha256 !== entry.digest) {
    throw new Error(`Published object authority metadata mismatch: ${key}`)
  }
  let semantic = stored.bytes
  if (stored.contentEncoding === 'gzip') {
    if (stored.metadata?.encoding !== 'gzip') throw new Error(`Published gzip object encoding metadata mismatch: ${key}`)
    semantic = gunzipSync(stored.bytes)
  } else if (stored.contentEncoding !== undefined || stored.metadata?.encoding !== undefined) {
    throw new Error(`Published object has unexpected content encoding: ${key}`)
  }
  if (sha256(semantic) !== entry.digest || stored.metadata?.['semantic-bytes'] !== String(semantic.byteLength)) {
    throw new Error(`Published object body authority mismatch: ${key}`)
  }
  return stored
}

function publishReceiptEntries(receipt) {
  return Array.isArray(receipt.objects)
    ? receipt.objects
    : [...(receipt.artifacts ?? []), ...(receipt.unchanged ?? [])]
}

function assertStoredPublicManifest(stored, digest) {
  if (stored.metadata?.sha256 !== digest || Number(stored.contentLength) !== stored.bytes.byteLength
    || stored.contentType !== 'application/json; charset=utf-8' || stored.contentEncoding !== undefined) {
    throw new Error('Public manifest stored authority metadata is invalid')
  }
}

function parseObjectReference(value, namespace) {
  if (!value || typeof value !== 'object' || typeof value.key !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '')
    || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || !Number.isSafeInteger(value.compressedBytes) || value.compressedBytes <= 0
    || value.storageEncoding !== 'gzip') throw new Error(`Invalid ${namespace} object reference`)
  const pattern = namespace === 'state' ? /^state\/objects\/sha256\/[a-f0-9]{64}$/
    : namespace === 'raw' ? /^raw\/objects\/sha256\/[a-f0-9]{64}$/
      : namespace === 'audit' ? /^audits\/objects\/sha256\/[a-f0-9]{64}$/
        : /^objects\/sha256\/[a-f0-9]{64}$/
  if (!pattern.test(value.key)) throw new Error(`Invalid ${namespace} object key`)
  return value
}

function absoluteReferenceKey(config, key) {
  if (typeof key !== 'string' || key.length === 0) throw new Error('Invalid bucket reference key')
  const prefix = configuredPrefix(config)
  return key.startsWith(prefix) ? key : bucketKey(config, key)
}

function relativeKey(config, key) {
  const prefix = configuredPrefix(config)
  return key.startsWith(prefix) ? key.slice(prefix.length) : key
}

function configuredPrefix(config) {
  const root = bucketKey(config, '').replace(/\/+$/, '')
  return root ? `${root}/` : ''
}

function isApprovedImmutableKey(key) {
  if (!APPROVED_IMMUTABLE_KEYS.some((pattern) => pattern.test(key))) return false
  try {
    if (safeRequestedObjectPath(key) !== key) return false
  } catch {
    return false
  }
  const dataMatch = /^generations\/[A-Za-z0-9][A-Za-z0-9._-]*\/data\/(.+)$/.exec(key)
  return !dataMatch || dataMatch[1].split('/').every((segment) => segment !== '.' && segment !== '..' && !segment.includes('%'))
}

function publicObjectMetadata(object) {
  return { key: object.key, bytes: object.bytes, lastModified: object.lastModified }
}

function utcMidnight(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('GC inventory time is invalid')
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function compareKey(left, right) {
  return left.key.localeCompare(right.key)
}

function compareKeyReason(left, right) {
  return String(left.key ?? '').localeCompare(String(right.key ?? '')) || String(left.reason ?? '').localeCompare(String(right.reason ?? ''))
}

async function bodyBytes(body) {
  if (typeof body?.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray())
  if (typeof body === 'string' || body instanceof Uint8Array) return Buffer.from(body)
  const chunks = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
