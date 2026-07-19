import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createMemoryDurableObjectStore,
  decideDurableCrunchMode,
  executeDurableGc,
  planDurableGc,
  promoteDurableGeneration,
  restoreDurableGeneration,
  stageDurableGeneration,
  type DurableIdentity,
} from '../scripts/durable-ranking-state.mjs'

const identity: DurableIdentity = {
  compatibilityHash: 'compat-a',
  pipelineVersion: 'incremental-canonical-v2',
  codeHash: 'code-a',
  modelVersion: 'model-a',
  modelConfigHash: 'config-a',
}

test('durable generation cold-restores a complete byte-identical local state tree', async () => {
  const fixture = await stateFixture('cold')
  const restoredDir = join(fixture.root, 'restored')
  const store = createMemoryDurableObjectStore()
  try {
    const candidate = await stageDurableGeneration({
      store,
      stateDir: fixture.stateDir,
      identity,
      generatedAt: '2026-07-19T00:00:00.000Z',
    })
    assert.ok(store.objects.has(candidate.manifest.audit.key))
    const promotion = await promoteDurableGeneration({
      store,
      candidate,
      fencingToken: 1,
      generationId: 'cold-generation',
      promotedAt: '2026-07-19T00:00:01.000Z',
      parityOutcome: { result: 'match' },
    })
    assert.equal(promotion.promoted, true)
    const restored = await restoreDurableGeneration({ store, stateDir: restoredDir, expectedIdentity: identity })
    assert.equal(restored.restored, true)
    assert.equal(await readFile(join(restoredDir, 'active-generation.json'), 'utf8'), fixture.active)
    assert.equal(await readFile(join(restoredDir, 'canonical', 'objects', 'canonical-a.json'), 'utf8'), fixture.canonical)
    assert.equal(await readFile(join(restoredDir, 'reducers', 'checkpoints', 'checkpoint-a.json'), 'utf8'), fixture.reducer)
    assert.ok(Number(record(restored.metrics).restoredBytes) > 0)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('cold restore rejects missing, corrupt, partial, and incompatible generations without mixing local state', async () => {
  const fixture = await stateFixture('validation')
  const store = createMemoryDurableObjectStore()
  const destination = join(fixture.root, 'destination')
  await mkdir(destination, { recursive: true })
  await writeFile(join(destination, 'sentinel.txt'), 'keep-me')
  try {
    const missing = await restoreDurableGeneration({ store, stateDir: destination, expectedIdentity: identity })
    assert.equal(fallbackDetail(missing), 'durable-active-pointer-missing')

    const candidate = await stageDurableGeneration({ store, stateDir: fixture.stateDir, identity, generatedAt: '2026-07-19T00:00:00.000Z' })
    await promoteDurableGeneration({
      store,
      candidate,
      fencingToken: 1,
      generationId: 'validation-generation',
      promotedAt: '2026-07-19T00:00:01.000Z',
      parityOutcome: { result: 'match' },
    })
    const incompatible = await restoreDurableGeneration({
      store,
      stateDir: destination,
      expectedIdentity: { ...identity, codeHash: 'different-code' },
    })
    assert.equal(fallbackKind(incompatible), 'compatibility-hash-mismatch')
    assert.equal(await readFile(join(destination, 'sentinel.txt'), 'utf8'), 'keep-me')

    const missingRef = candidate.manifest.objects[0]
    assert.ok(missingRef)
    store.objects.delete(missingRef.key)
    const partial = await restoreDurableGeneration({ store, stateDir: destination, expectedIdentity: identity })
    assert.match(fallbackDetail(partial), /durable-object-missing/)
    assert.equal(await readFile(join(destination, 'sentinel.txt'), 'utf8'), 'keep-me')

    const restaged = await stageDurableGeneration({ store, stateDir: fixture.stateDir, identity, generatedAt: '2026-07-19T00:00:00.000Z' })
    const auditObject = store.objects.get(restaged.manifest.audit.key)
    assert.ok(auditObject)
    const auditBytes = Buffer.from(auditObject.bytes)
    store.objects.delete(restaged.manifest.audit.key)
    const missingAudit = await restoreDurableGeneration({ store, stateDir: destination, expectedIdentity: identity })
    assert.equal(fallbackDetail(missingAudit), 'durable-audit-missing')
    store.objects.set(restaged.manifest.audit.key, { ...auditObject, bytes: auditBytes })
    const restoredAuditObject = store.objects.get(restaged.manifest.audit.key)
    assert.ok(restoredAuditObject)
    restoredAuditObject.bytes = Buffer.from('{"corrupt":true}\n')
    const corruptAudit = await restoreDurableGeneration({ store, stateDir: destination, expectedIdentity: identity })
    assert.equal(fallbackDetail(corruptAudit), 'durable-audit-integrity')
    restoredAuditObject.bytes = auditBytes
    const manifestObject = store.objects.get(restaged.manifestKey)
    assert.ok(manifestObject)
    manifestObject.bytes = Buffer.from('corrupt manifest')
    const corrupt = await restoreDurableGeneration({ store, stateDir: destination, expectedIdentity: identity })
    assert.equal(fallbackDetail(corrupt), 'durable-generation-manifest-integrity')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('restore validator, write, and commit failures preserve the target and leak no restore directories', async () => {
  const fixture = await stateFixture('restore-cleanup')
  const store = createMemoryDurableObjectStore()
  const candidate = await stageDurableGeneration({ store, stateDir: fixture.stateDir, identity, generatedAt: '2026-07-19T00:00:00.000Z' })
  await promoteDurableGeneration({ store, candidate, fencingToken: 1, generationId: 'cleanup', promotedAt: '2026-07-19T00:00:01.000Z' })
  try {
    for (const failure of ['validator', 'write', 'rename'] as const) {
      const destination = join(fixture.root, `cleanup-${failure}`)
      await mkdir(destination, { recursive: true })
      await writeFile(join(destination, 'sentinel.txt'), failure)
      let failedCommit = false
      const restored = await restoreDurableGeneration({
        store,
        stateDir: destination,
        expectedIdentity: identity,
        ...(failure === 'validator' ? { validateStateDir: async () => { throw new Error('validator-injected') } } : {}),
        ...(failure === 'write' ? { fsOps: { writeFile: async () => { throw new Error('write-injected') } } } : {}),
        ...(failure === 'rename' ? { fsOps: {
          rename: async (from, to) => {
            if (!failedCommit && from.includes('.restore-')) {
              failedCommit = true
              throw new Error('rename-injected')
            }
            return rename(from, to)
          },
        } } : {}),
      })
      assert.equal(restored.restored, false)
      assert.match(fallbackDetail(restored), new RegExp(`${failure === 'validator' ? 'validator' : failure}-injected`))
      assert.equal(await readFile(join(destination, 'sentinel.txt'), 'utf8'), failure)
      assert.deepEqual((await readdir(fixture.root)).filter((name) => name.startsWith(`cleanup-${failure}.restore-`) || name.startsWith(`cleanup-${failure}.previous-`)), [])
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('durable promotion is fenced, CAS-safe, interruption-safe, and skips exact no-change', async () => {
  const fixture = await stateFixture('promotion')
  const store = createMemoryDurableObjectStore()
  try {
    const candidate = await stageDurableGeneration({ store, stateDir: fixture.stateDir, identity, generatedAt: '2026-07-19T00:00:00.000Z' })
    const first = await promoteDurableGeneration({
      store,
      candidate,
      fencingToken: 4,
      generationId: 'first',
      promotedAt: '2026-07-19T00:00:01.000Z',
      parityOutcome: { result: 'match' },
    })
    assert.equal(first.promoted, true)
    const activeBefore = Buffer.from(requiredObject(store, 'active-generation.json').bytes)
    const stale = await promoteDurableGeneration({
      store,
      candidate,
      fencingToken: 3,
      generationId: 'stale',
      promotedAt: '2026-07-19T00:00:02.000Z',
    })
    assert.equal(stale.reason, 'stale-fencing-token')
    const equalFence = await promoteDurableGeneration({
      store,
      candidate,
      fencingToken: 4,
      generationId: 'equal-fence-different-generation',
      promotedAt: '2026-07-19T00:00:02.500Z',
    })
    assert.equal(equalFence.reason, 'equal-fencing-token-conflict')
    const unchanged = await promoteDurableGeneration({
      store,
      candidate,
      fencingToken: 5,
      generationId: 'unchanged',
      promotedAt: '2026-07-19T00:00:03.000Z',
    })
    assert.equal(unchanged.reason, 'no-change')
    assert.deepEqual(requiredObject(store, 'active-generation.json').bytes, activeBefore)

    await writeFile(join(fixture.stateDir, 'canonical', 'objects', 'canonical-a.json'), 'changed canonical')
    const changed = await stageDurableGeneration({ store, stateDir: fixture.stateDir, identity, generatedAt: '2026-07-20T00:00:00.000Z' })
    const conflict = await promoteDurableGeneration({
      store,
      candidate: changed,
      fencingToken: 5,
      generationId: 'conflict',
      promotedAt: '2026-07-20T00:00:01.000Z',
      expectedActiveEtag: '"stale-etag"',
    })
    assert.equal(conflict.reason, 'active-pointer-conflict')
    assert.deepEqual(requiredObject(store, 'active-generation.json').bytes, activeBefore)

    store.failures.putAfter = 1
    await writeFile(join(fixture.stateDir, 'reducers', 'checkpoints', 'checkpoint-a.json'), 'changed reducer')
    await assert.rejects(stageDurableGeneration({ store, stateDir: fixture.stateDir, identity, generatedAt: '2026-07-21T00:00:00.000Z' }), /injected put failure/)
    assert.deepEqual(requiredObject(store, 'active-generation.json').bytes, activeBefore)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('rollout activation is identity-scoped, thresholded, reset by mismatch, and audited', () => {
  const now = '2026-07-19T00:00:00.000Z'
  const identityHash = hashIdentityFromCandidateIdentity(identity)
  const eligiblePointer = {
    rollout: {
      identityHash,
      consecutiveShadowSuccesses: 3,
      lastAuditAt: '2026-07-18T00:00:00.000Z',
    },
  }
  assert.deepEqual(decideDurableCrunchMode({ requestedMode: 'full', identity, activePointer: eligiblePointer, now }), {
    effectiveMode: 'full', reason: 'full-requested', activationEligible: false,
  })
  assert.equal(decideDurableCrunchMode({ requestedMode: 'incremental', identity, activePointer: eligiblePointer, now }).effectiveMode, 'incremental')
  assert.equal(decideDurableCrunchMode({
    requestedMode: 'incremental', identity, activePointer: eligiblePointer, now, forceAudit: true,
  }).reason, 'forced-audit')
  assert.equal(decideDurableCrunchMode({
    requestedMode: 'incremental', identity, activePointer: { rollout: { ...eligiblePointer.rollout, consecutiveShadowSuccesses: 2 } }, now,
  }).reason, 'shadow-threshold-not-met')
  assert.equal(decideDurableCrunchMode({
    requestedMode: 'incremental', identity: { ...identity, modelVersion: 'model-b' }, activePointer: eligiblePointer, now,
  }).reason, 'activation-identity-mismatch')
  assert.equal(decideDurableCrunchMode({
    requestedMode: 'incremental', identity, activePointer: { rollout: { ...eligiblePointer.rollout, blockedReason: 'parity-mismatch' } }, now,
  }).effectiveMode, 'full')
  assert.equal(decideDurableCrunchMode({
    requestedMode: 'incremental', identity, activePointer: { rollout: { ...eligiblePointer.rollout, lastAuditAt: '2026-06-01T00:00:00.000Z' } }, now,
  }).reason, 'scheduled-audit')
})

test('reachability GC protects active, recent, and permanent-boundary generations and is nonfatal', async () => {
  const fixture = await stateFixture('gc')
  const store = createMemoryDurableObjectStore()
  try {
    const old = await stageDurableGeneration({
      store, stateDir: fixture.stateDir, identity, generatedAt: '2026-01-01T00:00:00.000Z', retention: { date: '2026-01-01', boundaries: [] },
    })
    await writeFile(join(fixture.stateDir, 'canonical', 'objects', 'canonical-a.json'), 'permanent')
    const permanent = await stageDurableGeneration({
      store, stateDir: fixture.stateDir, identity, generatedAt: '2026-02-01T00:00:00.000Z', retention: { date: '2026-02-01', boundaries: ['month-end'] },
    })
    const permanentPromotion = await promoteDurableGeneration({
      store, candidate: permanent, fencingToken: 1, generationId: 'gc-permanent', promotedAt: '2026-02-01T00:00:01.000Z', parityOutcome: { result: 'match' },
    })
    assert.equal(permanentPromotion.promoted, true)
    await writeFile(join(fixture.stateDir, 'canonical', 'objects', 'canonical-a.json'), 'unactivated-boundary')
    const unactivatedBoundary = await stageDurableGeneration({
      store, stateDir: fixture.stateDir, identity, generatedAt: '2026-03-01T00:00:00.000Z', retention: { date: '2026-03-01', boundaries: ['season-split'] },
    })
    await writeFile(join(fixture.stateDir, 'canonical', 'objects', 'canonical-a.json'), 'active')
    const activeCandidate = await stageDurableGeneration({
      store, stateDir: fixture.stateDir, identity, generatedAt: '2026-07-19T00:00:00.000Z', retention: { date: '2026-07-19', boundaries: [] },
    })
    const promotion = await promoteDurableGeneration({
      store, candidate: activeCandidate, fencingToken: 2, generationId: 'gc-active', promotedAt: '2026-07-19T00:00:01.000Z', parityOutcome: { result: 'match' },
    })
    assert.equal(promotion.promoted, true)
    const pointer = parseObject(requiredObject(store, 'active-generation.json').bytes)
    const plan = await planDurableGc({ store, activePointer: pointer, now: '2026-07-20T00:00:00.000Z', recentDays: 35 })
    assert.equal(plan.safe, true)
    assert.ok(plan.plannedDeletes.some((entry) => entry.key === old.manifestKey))
    assert.ok(plan.plannedDeletes.some((entry) => entry.key === unactivatedBoundary.manifestKey))
    assert.ok(plan.plannedDeletes.some((entry) => entry.key === unactivatedBoundary.manifest.audit.key))
    const retainedObjectKeys = new Set([...permanent.manifest.objects, ...activeCandidate.manifest.objects].map((entry) => entry.key))
    const unactivatedUniqueObjects = unactivatedBoundary.manifest.objects.filter((entry) => !retainedObjectKeys.has(entry.key))
    assert.ok(unactivatedUniqueObjects.length > 0)
    assert.ok(unactivatedUniqueObjects.every((object) => plan.plannedDeletes.some((entry) => entry.key === object.key)))
    assert.ok(!plan.plannedDeletes.some((entry) => entry.key === permanent.manifestKey))
    assert.ok(!plan.plannedDeletes.some((entry) => entry.key === permanent.manifest.audit.key))
    assert.ok(!plan.plannedDeletes.some((entry) => entry.key === activeCandidate.manifestKey))
    const dry = await executeDurableGc({ store, plan, dryRun: true })
    assert.equal(dry.deleted, 0)
    assert.equal(requiredObject(store, old.manifestKey).bytes.byteLength, old.manifestBytes)
    const firstDelete = plan.plannedDeletes[0]
    assert.ok(firstDelete)
    store.failures.deleteKeys.add(firstDelete.key)
    const swept = await executeDurableGc({ store, plan, dryRun: false })
    assert.ok(Number(swept.skipped) >= 1)

    const activeObject = requiredObject(store, 'active-generation.json')
    const fencedPlan = await planDurableGc({
      store,
      activePointer: pointer,
      activeEtag: activeObject.etag,
      now: '2026-07-20T00:00:00.000Z',
      recentDays: 35,
    })
    await store.put('active-generation.json', Buffer.from('{"schemaVersion":1,"generationId":"winner","fencingToken":2}\n'), { ifMatch: activeObject.etag })
    const raced = await executeDurableGc({ store, plan: fencedPlan, dryRun: false })
    assert.equal(raced.reason, 'active-pointer-changed')
    assert.equal(raced.deleted, 0)
    assert.ok(store.objects.has(activeCandidate.manifestKey))
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('GC rechecks active authority before the first delete and preserves a concurrent winner graph', async () => {
  const fixture = await stateFixture('gc-race')
  const store = createMemoryDurableObjectStore()
  try {
    const winnerCandidate = await stageDurableGeneration({
      store, stateDir: fixture.stateDir, identity, generatedAt: '2026-01-01T00:00:00.000Z', retention: { date: '2026-01-01', boundaries: [] },
    })
    await writeFile(join(fixture.stateDir, 'canonical', 'objects', 'canonical-a.json'), 'initial-active')
    const activeCandidate = await stageDurableGeneration({
      store, stateDir: fixture.stateDir, identity, generatedAt: '2026-07-19T00:00:00.000Z', retention: { date: '2026-07-19', boundaries: [] },
    })
    await promoteDurableGeneration({ store, candidate: activeCandidate, fencingToken: 1, generationId: 'initial', promotedAt: '2026-07-19T00:00:01.000Z' })
    const activeObject = requiredObject(store, 'active-generation.json')
    const active = parseObject(activeObject.bytes)
    const plan = await planDurableGc({
      store,
      activePointer: active,
      activeEtag: activeObject.etag,
      now: '2026-07-20T00:00:00.000Z',
      recentDays: 1,
    })
    assert.ok(plan.plannedDeletes.some((entry) => entry.key === winnerCandidate.manifestKey))
    let guardCalls = 0
    const swept = await executeDurableGc({
      store,
      plan,
      dryRun: false,
      guard: async () => {
        guardCalls += 1
        if (guardCalls === 2) {
          await store.put('active-generation.json', Buffer.from(`${JSON.stringify({
            schemaVersion: 1,
            generationId: 'concurrent-winner',
            fencingToken: 2,
            privateState: {
              manifestKey: winnerCandidate.manifestKey,
              manifestDigest: winnerCandidate.manifestDigest,
              manifestBytes: winnerCandidate.manifestBytes,
            },
          })}\n`), { ifMatch: activeObject.etag })
        }
        return { valid: true }
      },
    })
    assert.equal(swept.reason, 'active-pointer-changed')
    assert.equal(swept.deleted, 0)
    assert.ok(store.objects.has(winnerCandidate.manifestKey))
    for (const ref of winnerCandidate.manifest.objects) assert.ok(store.objects.has(ref.key))
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('durable staging is deterministic for identical metadata and records exact byte reductions', async () => {
  const fixture = await stateFixture('deterministic')
  const store = createMemoryDurableObjectStore()
  try {
    const first = await stageDurableGeneration({ store, stateDir: fixture.stateDir, identity, generatedAt: '2026-07-19T00:00:00.000Z', parity: { result: 'match' } })
    const second = await stageDurableGeneration({ store, stateDir: fixture.stateDir, identity, generatedAt: '2026-07-19T00:00:00.000Z', parity: { result: 'match' } })
    assert.equal(second.manifestDigest, first.manifestDigest)
    assert.equal(second.stateRoot, first.stateRoot)
    assert.equal(second.metrics.uploadedObjects, 0)
    assert.ok(second.metrics.skippedObjects > 0)
    assert.ok(second.metrics.skippedBytes > 0)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('durable staging uploads only the active local reachability graph', async () => {
  const fixture = await stateFixture('reachable')
  const store = createMemoryDurableObjectStore()
  try {
    await mkdir(join(fixture.stateDir, 'canonical', 'objects'), { recursive: true })
    await writeFile(join(fixture.stateDir, 'canonical', 'objects', 'obsolete.json'), 'obsolete')
    const candidate = await stageDurableGeneration({
      store,
      stateDir: fixture.stateDir,
      identity,
      generatedAt: '2026-07-19T00:00:00.000Z',
      reachablePaths: ['active-generation.json', 'canonical/objects/canonical-a.json'],
    })
    assert.deepEqual(candidate.manifest.objects.map((entry) => entry.path), [
      'active-generation.json',
      'canonical/objects/canonical-a.json',
    ])
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

async function stateFixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `durable-ranking-${name}-`))
  const stateDir = join(root, 'state')
  const active = 'active pointer\n'
  const canonical = 'canonical state\n'
  const reducer = 'reducer checkpoint\n'
  await mkdir(join(stateDir, 'canonical', 'objects'), { recursive: true })
  await mkdir(join(stateDir, 'reducers', 'checkpoints'), { recursive: true })
  await writeFile(join(stateDir, 'active-generation.json'), active)
  await writeFile(join(stateDir, 'canonical', 'objects', 'canonical-a.json'), canonical)
  await writeFile(join(stateDir, 'reducers', 'checkpoints', 'checkpoint-a.json'), reducer)
  return { root, stateDir, active, canonical, reducer }
}

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object')
  assert.notEqual(value, null)
  assert.equal(Array.isArray(value), false)
  return value as Record<string, unknown>
}

function fallbackKind(result: Record<string, unknown>) {
  return String(record(result.fallback).kind)
}

function fallbackDetail(result: Record<string, unknown>) {
  return String(record(result.fallback).detail)
}

function requiredObject(store: ReturnType<typeof createMemoryDurableObjectStore>, key: string) {
  const object = store.objects.get(key)
  assert.ok(object, key)
  return object
}

function parseObject(bytes: Uint8Array): Record<string, unknown> {
  return record(JSON.parse(Buffer.from(bytes).toString('utf8')))
}

function hashIdentityFromCandidateIdentity(value: DurableIdentity) {
  const keys = Object.keys(value).sort() as Array<keyof DurableIdentity>
  const stable = `{${keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`).join(',')}}`
  return createHash('sha256').update(stable).digest('hex')
}
