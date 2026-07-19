import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import {
  deleteObject,
  headBucketObject,
  listBucketKeys,
  readBucketBytes,
  verifyBucketMaintenance,
  writeBucketBytes,
} from './railway-bucket.mjs'

export const DURABLE_STATE_SCHEMA_VERSION = 1
export const DEFAULT_DURABLE_PREFIX = 'private'

export function createRailwayDurableObjectStore({ config, client }) {
  return {
    get: (key) => readBucketBytes(key, { config, client }),
    head: (key) => headBucketObject(key, { config, client }),
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
    async head(key) {
      const object = objects.get(key)
      return object
        ? { found: true, key, etag: object.etag, contentLength: object.bytes.byteLength, metadata: { ...object.metadata }, storageVerifiedSha256: sha256(object.bytes) }
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
  outcome = 'incremental-success',
  stateSummary,
  reachablePaths,
  retention = { date: generatedAt.slice(0, 10), boundaries: [] },
  parity = { kind: 'not-run' },
  prefix = DEFAULT_DURABLE_PREFIX,
}) {
  const root = resolve(stateDir)
  const files = reachablePaths
    ? await reachableLocalFiles(root, reachablePaths)
    : await listLocalFiles(root)
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
    const upload = await putImmutable(store, key, bytes, digest, 'application/octet-stream', generatedAt)
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
  const auditUpload = await putImmutable(store, auditKey, auditBytes, auditDigest, 'application/json; charset=utf-8', generatedAt)
  const manifest = {
    schemaVersion: DURABLE_STATE_SCHEMA_VERSION,
    kind: 'durable-ranking-generation',
    createdAt: generatedAt,
    identity,
    identityHash,
    stateRoot,
    eligibility: 'eligible',
    outcome,
    semanticState: stateSummary ?? { stateRoot, compatibilityHash: identity.compatibilityHash },
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
  const manifestUpload = await putImmutable(store, manifestKey, manifestBytes, manifestDigest, 'application/json; charset=utf-8', generatedAt)
  return {
    eligibility: 'eligible',
    outcome,
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
  validateStateDir,
  fsOps = {},
  activeKey = 'active-generation.json',
}) {
  const metrics = { restoredObjects: 0, restoredBytes: 0, cacheHits: 0, cacheMisses: 0 }
  let restorationPath
  let previousPath
  let targetPath
  const writeRestoredFile = fsOps.writeFile ?? writeFile
  const renameRestoredPath = fsOps.rename ?? rename
  try {
    const activeObject = await store.get(activeKey)
    if (!activeObject.found) return restoreFallback('checkpoint-unavailable', 'durable-active-pointer-missing', metrics)
    const active = parseJsonBytes(activeObject.bytes)
    if (!isRecord(active) || active.schemaVersion !== 1) {
      return restoreFallback('checkpoint-corrupt', 'durable-active-pointer-invalid', metrics)
    }
    if (active.privateState === undefined) return restoreFallback('checkpoint-unavailable', 'durable-private-pointer-missing', metrics)
    if (!isRecord(active.privateState)) return restoreFallback('checkpoint-corrupt', 'durable-private-pointer-invalid', metrics)
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
    const auditObject = await store.get(manifest.audit.key)
    if (!auditObject.found) return restoreFallback('checkpoint-unavailable', 'durable-audit-missing', metrics)
    metrics.cacheMisses += 1
    if (!validBytes(auditObject.bytes, manifest.audit.bytes, manifest.audit.digest)) {
      return restoreFallback('checkpoint-corrupt', 'durable-audit-integrity', metrics)
    }
    const auditValidation = validateAudit(parseJsonBytes(auditObject.bytes), manifest)
    if (auditValidation) return restoreFallback('checkpoint-corrupt', auditValidation, metrics)
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
    targetPath = target
    const next = `${target}.restore-${process.pid}-${Date.now()}`
    restorationPath = next
    const previous = `${target}.previous-${process.pid}-${Date.now()}`
    previousPath = previous
    await bestEffortRemove(next)
    await bestEffortRemove(previous)
    for (const object of loaded) {
      const path = resolve(next, object.path)
      assertInside(next, path)
      await mkdir(dirname(path), { recursive: true })
      await writeRestoredFile(path, object.bytes)
    }
    if (validateStateDir) {
      const stateSummary = await validateStateDir(next, expectedIdentity)
      if (!isRecord(stateSummary)
        || !isRecord(manifest.semanticState)
        || stateSummary.stateRoot !== manifest.semanticState.stateRoot
        || stateSummary.compatibilityHash !== expectedIdentity.compatibilityHash) {
        await bestEffortRemove(next)
        return restoreFallback('checkpoint-corrupt', 'durable-inner-state-root', metrics)
      }
    }
    let hadPrevious = false
    try {
      await renameRestoredPath(target, previous)
      hadPrevious = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    try {
      await renameRestoredPath(next, target)
      restorationPath = undefined
    } catch (error) {
      if (hadPrevious) {
        try {
          await renameRestoredPath(previous, target)
          previousPath = undefined
        } catch {
          // Preserve the original commit failure; outer cleanup retries rollback.
        }
      }
      throw error
    }
    await bestEffortRemove(previous)
    previousPath = undefined
    metrics.restoredObjects = loaded.length
    metrics.restoredBytes = loaded.reduce((sum, object) => sum + object.bytes.byteLength, 0)
    return { restored: true, active, manifest, metrics }
  } catch (error) {
    if (restorationPath) await bestEffortRemove(restorationPath)
    if (previousPath && targetPath) {
      if (!await pathExists(targetPath) && await pathExists(previousPath)) {
        try {
          await rename(previousPath, targetPath)
          previousPath = undefined
        } catch {
          // Preserve the original restore error in the typed fallback.
        }
      }
      if (await pathExists(targetPath)) await bestEffortRemove(previousPath)
    }
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
  if (candidate?.eligibility !== 'eligible') {
    return { promoted: false, reason: 'candidate-ineligible', uploadedObjects: 0, uploadedBytes: 0 }
  }
  const currentObject = await store.get(activeKey)
  const current = currentObject.found ? parseJsonBytes(currentObject.bytes) : undefined
  if (isRecord(current?.maintenance)) {
    return { promoted: false, reason: 'maintenance-active', uploadedObjects: candidate.metrics.uploadedObjects, uploadedBytes: candidate.metrics.uploadedBytes }
  }
  const currentFence = isRecord(current) ? Number(current.fencingToken ?? 0) : 0
  if (!Number.isFinite(fencingToken) || fencingToken <= 0 || currentFence > fencingToken) {
    return { promoted: false, reason: 'stale-fencing-token', uploadedObjects: candidate.metrics.uploadedObjects, uploadedBytes: candidate.metrics.uploadedBytes }
  }
  if (currentFence === fencingToken && isRecord(current) && current.generationId !== generationId) {
    return { promoted: false, reason: 'equal-fencing-token-conflict', uploadedObjects: candidate.metrics.uploadedObjects, uploadedBytes: candidate.metrics.uploadedBytes }
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
      retention: candidate.manifest.retention,
    },
    durableHistory: activatedDurableHistory(current, {
      manifestKey: candidate.manifestKey,
      manifestDigest: candidate.manifestDigest,
      retention: candidate.manifest.retention,
    }, promotedAt),
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
      lastAuditAt: at,
    }
  }
  if (parity?.result === 'mismatch') {
    return {
      identityHash,
      consecutiveShadowSuccesses: 0,
      lastShadowAt: at,
      lastAuditAt: at,
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
  activeEtag,
  activeKey = 'active-generation.json',
  now,
  recentDays = 35,
  stagingGraceMs = 24 * 60 * 60_000,
  prefix = DEFAULT_DURABLE_PREFIX,
}) {
  const generationEntries = await store.list(`${prefix}/generations`)
  const objectEntries = await store.list(`${prefix}/objects`)
  const auditEntries = await store.list(`${prefix}/audits`)
  const rawGenerationEntries = await store.list('raw/generations')
  const rawObjectEntries = await store.list('raw/objects')
  const activeManifestKey = activePointer?.privateState?.manifestKey
  const authoritativeBoundaryManifests = new Set(
    (Array.isArray(activePointer?.durableHistory) ? activePointer.durableHistory : [])
      .filter((entry) => isRecord(entry) && typeof entry.manifestKey === 'string' && Array.isArray(entry.boundaries) && entry.boundaries.length > 0)
      .map((entry) => entry.manifestKey),
  )
  const retainedManifests = new Map()
  const parsedManifests = new Map()
  const recentLatestByDate = new Map()
  let invalidManifests = 0
  for (const entry of generationEntries) {
    try {
      const object = await store.get(entry.key)
      if (!object.found) continue
      const manifestDigest = entry.key.split('/').at(-1)?.replace(/\.json$/, '')
      if (!manifestDigest || !/^[a-f0-9]{64}$/.test(manifestDigest) || sha256(object.bytes) !== manifestDigest) throw new Error('invalid manifest integrity')
      const manifest = parseJsonBytes(object.bytes)
      if (validateManifestShape(manifest)) throw new Error('invalid manifest')
      parsedManifests.set(entry.key, manifest)
      const ageMs = new Date(now).getTime() - new Date(`${manifest.retention.date}T00:00:00.000Z`).getTime()
      const permanent = authoritativeBoundaryManifests.has(entry.key)
      if (entry.key === activeManifestKey || permanent) retainedManifests.set(entry.key, manifest)
      else if (ageMs <= recentDays * 24 * 60 * 60_000) {
        const previous = recentLatestByDate.get(manifest.retention.date)
        if (!previous || `${manifest.createdAt}:${entry.key}` > `${previous.manifest.createdAt}:${previous.entry.key}`) {
          recentLatestByDate.set(manifest.retention.date, { entry, manifest })
        }
      }
    } catch {
      invalidManifests += 1
    }
  }
  for (const { entry, manifest } of recentLatestByDate.values()) retainedManifests.set(entry.key, manifest)
  if (invalidManifests > 0) {
    return {
      safe: false,
      reason: 'durable-manifest-invalid',
      plannedDeletes: [],
      retainedManifests: retainedManifests.size,
      invalidManifests,
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
  if (activeManifestKey) {
    const activeManifestObject = await store.get(activeManifestKey)
    if (!activeManifestObject.found
      || (typeof activePointer?.privateState?.manifestDigest === 'string' && sha256(activeManifestObject.bytes) !== activePointer.privateState.manifestDigest)
      || (typeof activePointer?.privateState?.manifestBytes === 'number' && activeManifestObject.contentLength !== activePointer.privateState.manifestBytes)) {
      return { safe: false, reason: 'active-manifest-pointer-invalid', plannedDeletes: [], retainedManifests: retainedManifests.size, invalidManifests }
    }
  }
  const reachable = new Set([...retainedManifests.values()].flatMap((manifest) => manifest.objects.map((ref) => ref.key)))
  const reachableAudits = new Set([...retainedManifests.values()].map((manifest) => manifest.audit.key))
  const nowMs = new Date(now).getTime()
  const unreferencedObjects = await gcEntriesPastGrace(store, objectEntries.filter((entry) => !reachable.has(entry.key)), nowMs, stagingGraceMs)
  const unreferencedAudits = await gcEntriesPastGrace(store, auditEntries.filter((entry) => !reachableAudits.has(entry.key)), nowMs, stagingGraceMs)
  const unretainedManifests = generationEntries.filter((entry) => !retainedManifests.has(entry.key))
    .filter((entry) => {
      const createdAt = parsedManifests.get(entry.key)?.createdAt
      return typeof createdAt === 'string' && nowMs - new Date(createdAt).getTime() >= stagingGraceMs
    })
  const rawPlan = await planRawGc({
    store,
    activePointer,
    generationEntries: rawGenerationEntries,
    objectEntries: rawObjectEntries,
    nowMs,
    recentDays,
    stagingGraceMs,
  })
  if (rawPlan.metrics.safe === false) {
    return {
      safe: false,
      reason: rawPlan.metrics.reason ?? 'raw-gc-unsafe',
      plannedDeletes: [],
      retainedManifests: retainedManifests.size,
      retainedObjects: reachable.size,
      retainedAudits: reachableAudits.size,
      invalidManifests,
      raw: rawPlan.metrics,
    }
  }
  const plannedDeletes = [
    ...unreferencedObjects.map((entry) => ({ ...entry, kind: 'object' })),
    ...unreferencedAudits.map((entry) => ({ ...entry, kind: 'audit' })),
    ...unretainedManifests.map((entry) => ({ ...entry, kind: 'manifest' })),
    ...rawPlan.plannedDeletes,
  ].sort((left, right) => left.key.localeCompare(right.key))
  return {
    safe: true,
    ...(activeEtag ? { activeSnapshot: {
      activeKey,
      etag: activeEtag,
      fencingToken: activePointer?.fencingToken,
      generationId: activePointer?.generationId,
      manifestKey: activeManifestKey,
    } } : {}),
    plannedDeletes,
    retainedManifests: retainedManifests.size,
    retainedObjects: reachable.size,
    retainedAudits: reachableAudits.size,
    invalidManifests,
    raw: rawPlan.metrics,
  }
}

async function planRawGc({ store, activePointer, generationEntries, objectEntries, nowMs, recentDays, stagingGraceMs }) {
  const validReferenceKinds = new Set(['source', 'manifest', 'refresh-state'])
  const activeDescriptorKey = activePointer?.rawState?.descriptorKey
  const historyKeys = new Set((Array.isArray(activePointer?.rawHistory) ? activePointer.rawHistory : [])
    .filter((entry) => isRecord(entry) && typeof entry.descriptorKey === 'string')
    .map((entry) => entry.descriptorKey))
  if (activeDescriptorKey) historyKeys.add(activeDescriptorKey)
  const descriptors = new Map()
  const retained = new Set(historyKeys)
  const recentLatestByDate = new Map()
  let invalidDescriptors = 0
  let legacyDescriptors = 0
  for (const entry of generationEntries) {
    try {
      const object = await store.get(entry.key)
      if (!object.found) continue
      const descriptorDigest = entry.key.slice('raw/generations/'.length).replace(/\.json$/, '')
      if (!/^[a-f0-9]{64}$/.test(descriptorDigest) || sha256(object.bytes) !== descriptorDigest) throw new Error('raw descriptor integrity')
      const descriptor = parseJsonBytes(object.bytes)
      if (!isRecord(descriptor) || descriptor.schemaVersion !== 1 || descriptor.kind !== 'raw-generation' || !Array.isArray(descriptor.objects)) throw new Error('invalid raw descriptor')
      if (descriptor.objects.some((ref) => !isRecord(ref)
        || !validReferenceKinds.has(ref.kind)
        || typeof ref.logicalPath !== 'string'
        || ref.logicalPath.length === 0
        || typeof ref.key !== 'string'
        || typeof ref.digest !== 'string'
        || !/^[a-f0-9]{64}$/.test(ref.digest)
        || ref.key !== `raw/objects/${ref.digest}`
        || !Number.isSafeInteger(ref.bytes)
        || ref.bytes < 0)) throw new Error('invalid raw reference')
      descriptors.set(entry.key, descriptor)
      const createdAt = typeof descriptor.createdAt === 'string' ? descriptor.createdAt : object.metadata?.['created-at']
      const date = isRecord(descriptor.retention) && typeof descriptor.retention.date === 'string'
        ? descriptor.retention.date
        : typeof createdAt === 'string' ? createdAt.slice(0, 10) : undefined
      if (!createdAt || !date) {
        legacyDescriptors += 1
        retained.add(entry.key)
        continue
      }
      const ageMs = nowMs - new Date(`${date}T00:00:00.000Z`).getTime()
      if (ageMs <= recentDays * 24 * 60 * 60_000) {
        const previous = recentLatestByDate.get(date)
        if (!previous || `${createdAt}:${entry.key}` > `${previous.createdAt}:${previous.key}`) recentLatestByDate.set(date, { key: entry.key, createdAt })
      }
    } catch {
      invalidDescriptors += 1
    }
  }
  for (const entry of recentLatestByDate.values()) retained.add(entry.key)
  if (activeDescriptorKey && !descriptors.has(activeDescriptorKey)) {
    return { plannedDeletes: [], metrics: { safe: false, reason: 'active-raw-descriptor-unavailable', invalidDescriptors, legacyDescriptors } }
  }
  if (activeDescriptorKey) {
    const activeDescriptorObject = await store.get(activeDescriptorKey)
    const expectedDigest = activePointer?.rawState?.descriptorDigest
    const expectedBytes = activePointer?.rawState?.descriptorBytes
    if (!activeDescriptorObject.found
      || (typeof expectedDigest === 'string' && sha256(activeDescriptorObject.bytes) !== expectedDigest)
      || (typeof expectedBytes === 'number' && activeDescriptorObject.contentLength !== expectedBytes)) {
      return { plannedDeletes: [], metrics: { safe: false, reason: 'active-raw-pointer-invalid', invalidDescriptors, legacyDescriptors } }
    }
  }
  // An unreadable descriptor may reference any object. Conservatively disable all raw deletion.
  if (invalidDescriptors > 0) {
    return { plannedDeletes: [], metrics: { safe: false, reason: 'raw-descriptor-invalid', invalidDescriptors, legacyDescriptors } }
  }
  let integrityDeferred = 0
  for (const key of retained) {
    const descriptor = descriptors.get(key)
    if (!descriptor) return { plannedDeletes: [], metrics: { safe: false, reason: 'retained-raw-descriptor-unavailable', invalidDescriptors, legacyDescriptors } }
    for (const ref of descriptor.objects) {
      const object = await store.head(ref.key)
      if (!object.found || object.contentLength !== ref.bytes) {
        return { plannedDeletes: [], metrics: { safe: false, reason: 'retained-raw-object-invalid', invalidDescriptors, legacyDescriptors } }
      }
      if (typeof object.storageVerifiedSha256 === 'string' && object.storageVerifiedSha256 !== ref.digest) {
        return { plannedDeletes: [], metrics: { safe: false, reason: 'retained-raw-object-invalid', invalidDescriptors, legacyDescriptors } }
      }
      if (object.storageVerifiedSha256 !== ref.digest) integrityDeferred += 1
    }
  }
  const reachableObjects = new Set([...retained].flatMap((key) => descriptors.get(key)?.objects.map((ref) => ref.key) ?? []))
  const collectibleObjects = await gcEntriesPastGrace(store, objectEntries.filter((entry) => !reachableObjects.has(entry.key)), nowMs, stagingGraceMs)
  const collectibleDescriptors = []
  for (const entry of generationEntries.filter((candidate) => !retained.has(candidate.key))) {
    const descriptor = descriptors.get(entry.key)
    const createdAt = descriptor?.createdAt
    if (typeof createdAt === 'string' && nowMs - new Date(createdAt).getTime() >= stagingGraceMs) collectibleDescriptors.push(entry)
  }
  return {
    plannedDeletes: [
      ...collectibleObjects.map((entry) => ({ ...entry, kind: 'raw-object' })),
      ...collectibleDescriptors.map((entry) => ({ ...entry, kind: 'raw-descriptor' })),
    ],
    metrics: {
      safe: true,
      retainedDescriptors: retained.size,
      retainedObjects: reachableObjects.size,
      invalidDescriptors,
      legacyDescriptors,
      integrityDeferred,
      ...(integrityDeferred > 0 ? { integrityDeferredReason: 'checksum-unavailable' } : {}),
    },
  }
}

export async function executeDurableGc({ store, plan, dryRun = true, beforeDelete }) {
  return executeDurableGcWithAuthority({ store, plan, dryRun, beforeDelete })
}

export async function executeRailwayDurableGc({
  store,
  plan,
  dryRun = true,
  maintenanceGuard,
  bucketConfig,
  bucketClient,
  beforeAuthorityCheck,
  beforeDelete,
  replan,
}) {
  const verifyAuthority = maintenanceGuard
    ? () => verifyBucketMaintenance(maintenanceGuard, { config: bucketConfig, client: bucketClient })
    : undefined
  return executeDurableGcWithAuthority({ store, plan, dryRun, verifyAuthority, beforeAuthorityCheck, beforeDelete, replan })
}

async function executeDurableGcWithAuthority({ store, plan, dryRun, verifyAuthority, beforeAuthorityCheck, beforeDelete, replan }) {
  if (!plan.safe) return { planned: 0, deleted: 0, skipped: 0, bytesDeleted: 0, reason: plan.reason }
  if (dryRun) return { planned: plan.plannedDeletes.length, deleted: 0, skipped: plan.plannedDeletes.length, bytesDeleted: 0, dryRun: true }
  const initialGuardFailure = await durableGcGuardFailure(store, plan, verifyAuthority, beforeAuthorityCheck)
  if (initialGuardFailure) return { planned: plan.plannedDeletes.length, deleted: 0, skipped: plan.plannedDeletes.length, bytesDeleted: 0, reason: initialGuardFailure }
  if (replan) {
    const refreshedPlan = await replan()
    if (!refreshedPlan?.safe) return { planned: 0, deleted: 0, skipped: 0, bytesDeleted: 0, reason: refreshedPlan?.reason ?? 'gc-replan-unsafe' }
    plan = refreshedPlan
    const refreshedGuardFailure = await durableGcGuardFailure(store, plan, verifyAuthority, beforeAuthorityCheck)
    if (refreshedGuardFailure) return { planned: plan.plannedDeletes.length, deleted: 0, skipped: plan.plannedDeletes.length, bytesDeleted: 0, reason: refreshedGuardFailure }
  }
  let deleted = 0
  let skipped = 0
  let bytesDeleted = 0
  for (const entry of plan.plannedDeletes) {
    const guardFailure = await durableGcGuardFailure(store, plan, verifyAuthority, beforeAuthorityCheck)
    if (guardFailure) {
      return {
        planned: plan.plannedDeletes.length,
        deleted,
        skipped: skipped + plan.plannedDeletes.length - deleted - skipped,
        bytesDeleted,
        reason: guardFailure,
      }
    }
    if (beforeDelete) await beforeDelete(entry)
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

async function durableGcGuardFailure(store, plan, verifyAuthority, beforeAuthorityCheck) {
  if (!verifyAuthority) return 'missing-gc-authority'
  if (beforeAuthorityCheck) await beforeAuthorityCheck()
  const result = await verifyAuthority()
  if (result === false || (isRecord(result) && result.valid === false)) return result?.reason ?? 'lease-changed'
  if (!isRecord(plan.activeSnapshot)) return undefined
  const current = await store.get(plan.activeSnapshot.activeKey)
  if (!current.found || !plan.activeSnapshot.etag || current.etag !== plan.activeSnapshot.etag) return 'active-pointer-changed'
  const pointer = parseJsonBytes(current.bytes)
  if (!isRecord(pointer)
    || pointer.fencingToken !== plan.activeSnapshot.fencingToken
    || pointer.generationId !== plan.activeSnapshot.generationId
    || pointer.privateState?.manifestKey !== plan.activeSnapshot.manifestKey) return 'active-pointer-changed'
}

function validateManifest(manifest, expectedIdentity) {
  const shapeError = validateManifestShape(manifest)
  if (shapeError) return { kind: 'checkpoint-corrupt', detail: shapeError }
  if (manifest.identityHash !== stableHash(manifest.identity)) return { kind: 'checkpoint-corrupt', detail: 'durable-identity-hash' }
  if (manifest.identityHash !== stableHash(expectedIdentity)) return { kind: 'compatibility-hash-mismatch', detail: 'durable-generation-identity' }
  const root = stableHash(manifest.objects.map(({ path, bytes, digest, category }) => ({ path, bytes, digest, category })))
  if (root !== manifest.stateRoot) return { kind: 'checkpoint-corrupt', detail: 'durable-state-root' }
}

function validateAudit(audit, manifest) {
  if (!isRecord(audit)
    || audit.schemaVersion !== DURABLE_STATE_SCHEMA_VERSION
    || audit.kind !== 'durable-ranking-audit'
    || audit.identityHash !== manifest.identityHash
    || audit.stateRoot !== manifest.stateRoot
    || stableHash(audit.parity) !== stableHash(manifest.parity)) return 'durable-audit-invalid'
}

function activatedDurableHistory(active, nextPrivateState, activatedAt) {
  const history = Array.isArray(active?.durableHistory)
    ? active.durableHistory.filter((entry) => isRecord(entry) && typeof entry.manifestKey === 'string' && Array.isArray(entry.boundaries))
    : []
  const activated = [[active?.privateState, active?.promotedAt ?? activatedAt], [nextPrivateState, activatedAt]].flatMap(([state, stateActivatedAt]) => (
    isRecord(state) && typeof state.manifestKey === 'string' && Array.isArray(state.retention?.boundaries) && state.retention.boundaries.length > 0
      ? [{ manifestKey: state.manifestKey, manifestDigest: state.manifestDigest, boundaries: [...new Set(state.retention.boundaries)].sort(), activatedAt: stateActivatedAt }]
      : []
  ))
  const byManifest = new Map(history.map((entry) => [entry.manifestKey, entry]))
  for (const entry of activated) if (!byManifest.has(entry.manifestKey)) byManifest.set(entry.manifestKey, entry)
  return [...byManifest.values()]
    .sort((left, right) => left.manifestKey.localeCompare(right.manifestKey))
}

function validateManifestShape(manifest) {
  if (!isRecord(manifest)
    || manifest.schemaVersion !== DURABLE_STATE_SCHEMA_VERSION
    || manifest.kind !== 'durable-ranking-generation'
    || !isRecord(manifest.identity)
    || typeof manifest.identityHash !== 'string'
    || typeof manifest.stateRoot !== 'string'
    || manifest.eligibility !== 'eligible'
    || typeof manifest.outcome !== 'string'
    || !isRecord(manifest.semanticState)
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

async function gcEntriesPastGrace(store, entries, nowMs, stagingGraceMs) {
  const eligible = []
  for (const entry of entries) {
    try {
      const object = await store.head(entry.key)
      const createdAt = object.metadata?.['created-at']
      if (object.found && typeof createdAt === 'string'
        && nowMs - new Date(createdAt).getTime() >= stagingGraceMs) eligible.push(entry)
    } catch {
      // Missing or unreadable age fails closed; a staged graph may still reference this object.
    }
  }
  return eligible
}

async function putImmutable(store, key, bytes, digest, contentType = 'application/octet-stream', createdAt) {
  const write = await store.put(key, bytes, {
    ifAbsent: true,
    metadata: { sha256: digest, ...(createdAt ? { 'created-at': createdAt } : {}) },
    contentType,
  })
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

async function reachableLocalFiles(root, reachablePaths) {
  if (!Array.isArray(reachablePaths) || reachablePaths.length === 0) throw new Error('Durable reachable path set is empty')
  const files = []
  for (const logicalPath of [...new Set(reachablePaths)].sort()) {
    const safePath = safeLogicalPath(logicalPath)
    const path = resolve(root, safePath)
    assertInside(root, path)
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`Durable reachable path is not a file: ${safePath}`)
    files.push(path)
  }
  return files
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

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
