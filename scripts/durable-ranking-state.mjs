import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import {
  deleteObject,
  listBucketKeys,
  readBucketBytes,
  writeBucketBytes,
} from './railway-bucket.mjs'

export const DURABLE_STATE_SCHEMA_VERSION = 1
export const DEFAULT_DURABLE_PREFIX = 'private'

export function createRailwayDurableObjectStore({ config, client }) {
  return {
    get: (key) => readBucketBytes(key, { config, client }),
    put: (key, bytes, options = {}) => writeBucketBytes(key, bytes, {
      config,
      client,
      ...(options.ifMatch ? { ifMatch: options.ifMatch } : {}),
      ...(options.ifAbsent ? { ifNoneMatch: '*' } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
      contentType: options.contentType,
    }),
    list: async (prefix) => {
      const result = await listBucketKeys(prefix, { config, client })
      return result.keys
    },
    delete: (key) => deleteObject(key, { config, client }),
  }
}

export function createMemoryDurableObjectStore() {
  const objects = new Map()
  let revision = 0
  const failures = { putAfter: undefined, getKeys: new Set(), deleteKeys: new Set() }
  return {
    objects,
    failures,
    async get(key) {
      if (failures.getKeys.has(key)) throw new Error(`injected get failure: ${key}`)
      const object = objects.get(key)
      return object
        ? { found: true, key, etag: object.etag, bytes: Buffer.from(object.bytes), contentLength: object.bytes.byteLength, metadata: { ...object.metadata } }
        : { found: false, key }
    },
    async put(key, bytes, options = {}) {
      if (failures.putAfter !== undefined) {
        if (failures.putAfter <= 0) throw new Error(`injected put failure: ${key}`)
        failures.putAfter -= 1
      }
      const existing = objects.get(key)
      if (options.ifAbsent && existing) return { written: false, conflict: true, key, etag: existing.etag }
      if (options.ifMatch && existing?.etag !== options.ifMatch) return { written: false, conflict: true, key, etag: existing?.etag }
      if (options.ifMatch && !existing) return { written: false, conflict: true, key }
      revision += 1
      const body = Buffer.from(bytes)
      const etag = `"memory-${revision}"`
      objects.set(key, { bytes: body, etag, metadata: { ...(options.metadata ?? {}) } })
      return { written: true, key, etag, bytes: body.byteLength }
    },
    async list(prefix) {
      const root = prefix.replace(/\/?$/, '/')
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(root))
        .map(([key, value]) => ({ key, bytes: value.bytes.byteLength }))
        .sort((left, right) => left.key.localeCompare(right.key))
    },
    async delete(key) {
      if (failures.deleteKeys.has(key)) throw new Error(`injected delete failure: ${key}`)
      return objects.delete(key)
    },
  }
}

export async function stageDurableGeneration({
  store,
  stateDir,
  identity,
  generatedAt,
  retention = { date: generatedAt.slice(0, 10), boundaries: [] },
  parity = { kind: 'not-run' },
  prefix = DEFAULT_DURABLE_PREFIX,
}) {
  const root = resolve(stateDir)
  const files = await listLocalFiles(root)
  const refs = []
  let uploadedObjects = 0
  let uploadedBytes = 0
  let skippedObjects = 0
  let skippedBytes = 0
  for (const path of files) {
    const logicalPath = safeLogicalPath(relative(root, path).split(sep).join('/'))
    const bytes = await readFile(path)
    const digest = sha256(bytes)
    const category = categoryFor(logicalPath)
    const key = `${prefix}/objects/${category}/${digest}`
    const upload = await putImmutable(store, key, bytes, digest)
    if (upload.uploaded) {
      uploadedObjects += 1
      uploadedBytes += bytes.byteLength
    } else {
      skippedObjects += 1
      skippedBytes += bytes.byteLength
    }
    refs.push({ path: logicalPath, key, bytes: bytes.byteLength, digest, category })
  }
  refs.sort((left, right) => left.path.localeCompare(right.path))
  const identityHash = stableHash(identity)
  const stateRoot = stableHash(refs.map(({ path, bytes, digest, category }) => ({ path, bytes, digest, category })))
  const audit = {
    schemaVersion: DURABLE_STATE_SCHEMA_VERSION,
    kind: 'durable-ranking-audit',
    createdAt: generatedAt,
    identityHash,
    stateRoot,
    parity,
  }
  const auditBytes = jsonBytes(audit)
  const auditDigest = sha256(auditBytes)
  const auditKey = `${prefix}/audits/${auditDigest}.json`
  const auditUpload = await putImmutable(store, auditKey, auditBytes, auditDigest, 'application/json; charset=utf-8')
  const manifest = {
    schemaVersion: DURABLE_STATE_SCHEMA_VERSION,
    kind: 'durable-ranking-generation',
    createdAt: generatedAt,
    identity,
    identityHash,
    stateRoot,
    retention: {
      date: retention.date,
      boundaries: [...new Set(retention.boundaries)].sort(),
    },
    parity,
    audit: { key: auditKey, digest: auditDigest, bytes: auditBytes.byteLength },
    objects: refs,
  }
  const manifestBytes = jsonBytes(manifest)
  const manifestDigest = sha256(manifestBytes)
  const manifestKey = `${prefix}/generations/${manifestDigest}.json`
  const manifestUpload = await putImmutable(store, manifestKey, manifestBytes, manifestDigest, 'application/json; charset=utf-8')
  return {
    manifest,
    manifestKey,
    manifestDigest,
    manifestBytes: manifestBytes.byteLength,
    stateRoot,
    identityHash,
    metrics: {
      uploadedObjects: uploadedObjects + Number(auditUpload.uploaded) + Number(manifestUpload.uploaded),
      uploadedBytes: uploadedBytes
        + (auditUpload.uploaded ? auditBytes.byteLength : 0)
        + (manifestUpload.uploaded ? manifestBytes.byteLength : 0),
      skippedObjects: skippedObjects + Number(!auditUpload.uploaded) + Number(!manifestUpload.uploaded),
      skippedBytes: skippedBytes
        + (!auditUpload.uploaded ? auditBytes.byteLength : 0)
        + (!manifestUpload.uploaded ? manifestBytes.byteLength : 0),
    },
  }
}

export async function restoreDurableGeneration({
  store,
  stateDir,
  expectedIdentity,
  activeKey = 'active-generation.json',
}) {
  const metrics = { restoredObjects: 0, restoredBytes: 0, cacheHits: 0, cacheMisses: 0 }
  try {
    const activeObject = await store.get(activeKey)
    if (!activeObject.found) return restoreFallback('checkpoint-unavailable', 'durable-active-pointer-missing', metrics)
    const active = parseJsonBytes(activeObject.bytes)
    if (!isRecord(active) || active.schemaVersion !== 1 || !isRecord(active.privateState)) {
      return restoreFallback('checkpoint-corrupt', 'durable-active-pointer-invalid', metrics)
    }
    const pointer = active.privateState
    if (typeof pointer.manifestKey !== 'string' || typeof pointer.manifestDigest !== 'string' || typeof pointer.manifestBytes !== 'number') {
      return restoreFallback('checkpoint-corrupt', 'durable-private-pointer-invalid', metrics)
    }
    const manifestObject = await store.get(pointer.manifestKey)
    if (!manifestObject.found) return restoreFallback('checkpoint-unavailable', 'durable-generation-manifest-missing', metrics)
    metrics.cacheMisses += 1
    if (!validBytes(manifestObject.bytes, pointer.manifestBytes, pointer.manifestDigest)) {
      return restoreFallback('checkpoint-corrupt', 'durable-generation-manifest-integrity', metrics)
    }
    const manifest = parseJsonBytes(manifestObject.bytes)
    const validation = validateManifest(manifest, expectedIdentity)
    if (validation) return restoreFallback(validation.kind, validation.detail, metrics)
    const loaded = []
    for (const ref of manifest.objects) {
      const object = await store.get(ref.key)
      if (!object.found) return restoreFallback('checkpoint-unavailable', `durable-object-missing:${ref.path}`, metrics)
      metrics.cacheMisses += 1
      if (!validBytes(object.bytes, ref.bytes, ref.digest)) {
        return restoreFallback('checkpoint-corrupt', `durable-object-integrity:${ref.path}`, metrics)
      }
      loaded.push({ path: ref.path, bytes: Buffer.from(object.bytes) })
    }
    const target = resolve(stateDir)
    const next = `${target}.restore-${process.pid}-${Date.now()}`
    const previous = `${target}.previous-${process.pid}-${Date.now()}`
    await bestEffortRemove(next)
    await bestEffortRemove(previous)
    for (const object of loaded) {
      const path = resolve(next, object.path)
      assertInside(next, path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, object.bytes)
    }
    let hadPrevious = false
    try {
      await rename(target, previous)
      hadPrevious = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    try {
      await rename(next, target)
    } catch (error) {
      if (hadPrevious) await rename(previous, target)
      throw error
    }
    await bestEffortRemove(previous)
    metrics.restoredObjects = loaded.length
    metrics.restoredBytes = loaded.reduce((sum, object) => sum + object.bytes.byteLength, 0)
    return { restored: true, active, manifest, metrics }
  } catch (error) {
    return restoreFallback('checkpoint-corrupt', `durable-restore:${errorMessage(error)}`, metrics)
  }
}

export async function promoteDurableGeneration({
  store,
  candidate,
  fencingToken,
  generationId,
  promotedAt,
  parityOutcome,
  activeKey = 'active-generation.json',
  expectedActiveEtag,
}) {
  const currentObject = await store.get(activeKey)
  const current = currentObject.found ? parseJsonBytes(currentObject.bytes) : undefined
  const currentFence = isRecord(current) ? Number(current.fencingToken ?? 0) : 0
  if (!Number.isFinite(fencingToken) || fencingToken <= 0 || currentFence > fencingToken) {
    return { promoted: false, reason: 'stale-fencing-token', uploadedObjects: candidate.metrics.uploadedObjects, uploadedBytes: candidate.metrics.uploadedBytes }
  }
  if (isRecord(current?.privateState)
    && current.privateState.stateRoot === candidate.stateRoot
    && current.privateState.identityHash === candidate.identityHash) {
    return { promoted: false, reason: 'no-change', uploadedObjects: candidate.metrics.uploadedObjects, uploadedBytes: candidate.metrics.uploadedBytes }
  }
  if (expectedActiveEtag !== undefined && currentObject.etag !== expectedActiveEtag) {
    return { promoted: false, reason: 'active-pointer-conflict', uploadedObjects: candidate.metrics.uploadedObjects, uploadedBytes: candidate.metrics.uploadedBytes }
  }
  const rollout = recordRolloutOutcome(current?.rollout, {
    identityHash: candidate.identityHash,
    parity: parityOutcome,
    at: promotedAt,
  })
  const pointer = {
    ...(isRecord(current) ? current : {}),
    schemaVersion: 1,
    generationId,
    fencingToken,
    promotedAt,
    privateState: {
      manifestKey: candidate.manifestKey,
      manifestDigest: candidate.manifestDigest,
      manifestBytes: candidate.manifestBytes,
      stateRoot: candidate.stateRoot,
      identityHash: candidate.identityHash,
    },
    rollout,
  }
  const write = await store.put(activeKey, jsonBytes(pointer), {
    ...(currentObject.found ? { ifMatch: currentObject.etag } : { ifAbsent: true }),
    contentType: 'application/json; charset=utf-8',
  })
  return write.written
    ? { promoted: true, pointer, etag: write.etag, uploadedObjects: candidate.metrics.uploadedObjects, uploadedBytes: candidate.metrics.uploadedBytes }
    : { promoted: false, reason: 'active-pointer-conflict', uploadedObjects: candidate.metrics.uploadedObjects, uploadedBytes: candidate.metrics.uploadedBytes }
}

export function decideDurableCrunchMode({
  requestedMode,
  identity,
  activePointer,
  shadowThreshold = 3,
  now,
  auditIntervalMs = 7 * 24 * 60 * 60_000,
  forceAudit = false,
}) {
  if (requestedMode === 'full') return { effectiveMode: 'full', reason: 'full-requested', activationEligible: false }
  if (requestedMode === 'incremental-shadow') return { effectiveMode: 'incremental-shadow', reason: 'shadow-requested', activationEligible: false }
  const identityHash = stableHash(identity)
  const rollout = isRecord(activePointer?.rollout) ? activePointer.rollout : undefined
  if (!rollout || rollout.identityHash !== identityHash) {
    return { effectiveMode: 'full', reason: 'activation-identity-mismatch', activationEligible: false }
  }
  if (rollout.blockedReason) return { effectiveMode: 'full', reason: rollout.blockedReason, activationEligible: false }
  const lastAuditMs = new Date(rollout.lastAuditAt ?? 0).getTime()
  const auditDue = forceAudit || !Number.isFinite(lastAuditMs) || new Date(now).getTime() - lastAuditMs >= auditIntervalMs
  if (auditDue) return { effectiveMode: 'incremental-shadow', reason: forceAudit ? 'forced-audit' : 'scheduled-audit', activationEligible: false }
  const successes = Number(rollout.consecutiveShadowSuccesses ?? 0)
  if (successes < shadowThreshold) return { effectiveMode: 'full', reason: 'shadow-threshold-not-met', activationEligible: false }
  return { effectiveMode: 'incremental', reason: 'activation-eligible', activationEligible: true }
}

export function recordRolloutOutcome(previous, { identityHash, parity, at }) {
  const sameIdentity = isRecord(previous) && previous.identityHash === identityHash
  if (parity?.result === 'match') {
    return {
      identityHash,
      consecutiveShadowSuccesses: sameIdentity ? Number(previous.consecutiveShadowSuccesses ?? 0) + 1 : 1,
      lastShadowAt: at,
      lastAuditAt: parity.audit ? at : previous?.lastAuditAt,
    }
  }
  if (parity?.result === 'mismatch') {
    return {
      identityHash,
      consecutiveShadowSuccesses: 0,
      lastShadowAt: at,
      lastAuditAt: parity.audit ? at : previous?.lastAuditAt,
      blockedReason: 'parity-mismatch',
    }
  }
  return sameIdentity
    ? { ...previous }
    : { identityHash, consecutiveShadowSuccesses: 0, blockedReason: 'shadow-history-unavailable' }
}

export async function planDurableGc({
  store,
  activePointer,
  now,
  recentDays = 35,
  prefix = DEFAULT_DURABLE_PREFIX,
}) {
  const generationEntries = await store.list(`${prefix}/generations`)
  const objectEntries = await store.list(`${prefix}/objects`)
  const auditEntries = await store.list(`${prefix}/audits`)
  const activeManifestKey = activePointer?.privateState?.manifestKey
  const retainedManifests = new Map()
  let invalidManifests = 0
  for (const entry of generationEntries) {
    try {
      const object = await store.get(entry.key)
      if (!object.found) continue
      const manifest = parseJsonBytes(object.bytes)
      if (validateManifestShape(manifest)) throw new Error('invalid manifest')
      const ageMs = new Date(now).getTime() - new Date(`${manifest.retention.date}T00:00:00.000Z`).getTime()
      const permanent = manifest.retention.boundaries.length > 0
      if (entry.key === activeManifestKey || permanent || ageMs <= recentDays * 24 * 60 * 60_000) retainedManifests.set(entry.key, manifest)
    } catch {
      invalidManifests += 1
    }
  }
  if (activeManifestKey && !retainedManifests.has(activeManifestKey)) {
    return {
      safe: false,
      reason: 'active-manifest-unavailable',
      plannedDeletes: [],
      retainedManifests: retainedManifests.size,
      invalidManifests,
    }
  }
  const reachable = new Set([...retainedManifests.values()].flatMap((manifest) => manifest.objects.map((ref) => ref.key)))
  const reachableAudits = new Set([...retainedManifests.values()].map((manifest) => manifest.audit.key))
  const plannedDeletes = [
    ...objectEntries.filter((entry) => !reachable.has(entry.key)).map((entry) => ({ ...entry, kind: 'object' })),
    ...auditEntries.filter((entry) => !reachableAudits.has(entry.key)).map((entry) => ({ ...entry, kind: 'audit' })),
    ...generationEntries.filter((entry) => !retainedManifests.has(entry.key)).map((entry) => ({ ...entry, kind: 'manifest' })),
  ].sort((left, right) => left.key.localeCompare(right.key))
  return {
    safe: true,
    plannedDeletes,
    retainedManifests: retainedManifests.size,
    retainedObjects: reachable.size,
    retainedAudits: reachableAudits.size,
    invalidManifests,
  }
}

export async function executeDurableGc({ store, plan, dryRun = true }) {
  if (!plan.safe) return { planned: 0, deleted: 0, skipped: 0, bytesDeleted: 0, reason: plan.reason }
  if (dryRun) return { planned: plan.plannedDeletes.length, deleted: 0, skipped: plan.plannedDeletes.length, bytesDeleted: 0, dryRun: true }
  let deleted = 0
  let skipped = 0
  let bytesDeleted = 0
  for (const entry of plan.plannedDeletes) {
    try {
      if (await store.delete(entry.key)) {
        deleted += 1
        bytesDeleted += entry.bytes
      } else skipped += 1
    } catch {
      skipped += 1
    }
  }
  return { planned: plan.plannedDeletes.length, deleted, skipped, bytesDeleted, dryRun: false }
}

function validateManifest(manifest, expectedIdentity) {
  const shapeError = validateManifestShape(manifest)
  if (shapeError) return { kind: 'checkpoint-corrupt', detail: shapeError }
  if (manifest.identityHash !== stableHash(manifest.identity)) return { kind: 'checkpoint-corrupt', detail: 'durable-identity-hash' }
  if (manifest.identityHash !== stableHash(expectedIdentity)) return { kind: 'compatibility-hash-mismatch', detail: 'durable-generation-identity' }
  const root = stableHash(manifest.objects.map(({ path, bytes, digest, category }) => ({ path, bytes, digest, category })))
  if (root !== manifest.stateRoot) return { kind: 'checkpoint-corrupt', detail: 'durable-state-root' }
}

function validateManifestShape(manifest) {
  if (!isRecord(manifest)
    || manifest.schemaVersion !== DURABLE_STATE_SCHEMA_VERSION
    || manifest.kind !== 'durable-ranking-generation'
    || !isRecord(manifest.identity)
    || typeof manifest.identityHash !== 'string'
    || typeof manifest.stateRoot !== 'string'
    || !isRecord(manifest.retention)
    || typeof manifest.retention.date !== 'string'
    || !Array.isArray(manifest.retention.boundaries)
    || !isRecord(manifest.audit)
    || typeof manifest.audit.key !== 'string'
    || typeof manifest.audit.digest !== 'string'
    || typeof manifest.audit.bytes !== 'number'
    || !Array.isArray(manifest.objects)) return 'durable-generation-manifest-invalid'
  const paths = new Set()
  for (const ref of manifest.objects) {
    if (!isRecord(ref)
      || typeof ref.path !== 'string'
      || typeof ref.key !== 'string'
      || typeof ref.bytes !== 'number'
      || typeof ref.digest !== 'string'
      || typeof ref.category !== 'string'
      || paths.has(ref.path)) return 'durable-generation-object-ref-invalid'
    paths.add(ref.path)
  }
}

async function putImmutable(store, key, bytes, digest, contentType = 'application/octet-stream') {
  const write = await store.put(key, bytes, { ifAbsent: true, metadata: { sha256: digest }, contentType })
  if (write.written) return { uploaded: true }
  if (!write.conflict) throw new Error(`Unable to upload durable object ${key}`)
  const existing = await store.get(key)
  if (!existing.found || !validBytes(existing.bytes, bytes.byteLength, digest)) {
    throw new Error(`Content-addressed durable object conflict ${key}`)
  }
  return { uploaded: false }
}

async function listLocalFiles(root) {
  const files = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.includes('.staging-') || entry.name.includes('.previous-') || entry.name.includes('.materialized-')) continue
      const path = resolve(dir, entry.name)
      if (relative(root, path).split(sep).join('/') === 'durable-candidate.json') continue
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  await walk(root)
  return files.sort()
}

function categoryFor(path) {
  if (path === 'active-generation.json') return 'activation'
  const root = path.split('/')[0]
  if (['canonical', 'providers', 'reducers', 'players', 'snapshot-models', 'artifacts', 'generations'].includes(root)) return root
  return 'misc'
}

function safeLogicalPath(path) {
  if (!path || path.startsWith('/') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Invalid durable logical path: ${path}`)
  }
  return path
}

function assertInside(root, path) {
  const resolvedRoot = resolve(root)
  const resolvedPath = resolve(path)
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) throw new Error('Durable restore path escaped root')
}

function restoreFallback(kind, detail, metrics) {
  return { restored: false, fallback: { kind, detail }, metrics: { ...metrics, cacheMisses: metrics.cacheMisses + 1 } }
}

function validBytes(bytes, expectedLength, expectedDigest) {
  return bytes instanceof Uint8Array && bytes.byteLength === expectedLength && sha256(bytes) === expectedDigest
}

function stableHash(value) {
  return sha256(Buffer.from(stableJson(value)))
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
}

function parseJsonBytes(bytes) {
  return JSON.parse(Buffer.from(bytes).toString('utf8'))
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function bestEffortRemove(path) {
  try {
    await rm(path, { recursive: true, force: true })
  } catch {
    // Durable cleanup never changes the restore or promotion result.
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
