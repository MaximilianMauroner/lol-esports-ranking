import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import {
  acquireBucketLease,
  acquireBucketMaintenance,
  readBucketJson,
  releaseBucketLease,
  recoverBucketMaintenance,
  releaseBucketMaintenance,
  uploadRankingArtifacts,
  verifyBucketLease,
  verifyBucketMaintenance,
  writeBucketJson,
} from '../scripts/railway-bucket.mjs'

test('exclusive maintenance fences expired refreshes and blocks all successors until exact release', async () => {
  const client = memoryS3()
  const expired = await acquireBucketLease('ops/refresh-lease.json', {
    owner: 'expired', now: '2026-07-19T00:00:00Z', ttlMs: 1_000, fenceActiveKey: 'active-generation.json', config, client,
  })
  assert.equal(expired.acquired, true)
  const maintenance = await acquireBucketMaintenance({ owner: 'gc-owner', now: '2026-07-19T00:00:02Z', config, client })
  assert.equal(maintenance.acquired, true)
  if (!maintenance.maintenance) return
  assert.equal(maintenance.maintenance?.fencingToken, 2)
  const blocked = await acquireBucketLease('ops/refresh-lease.json', {
    owner: 'successor', now: '2030-01-01T00:00:00Z', ttlMs: 60_000, fenceActiveKey: 'active-generation.json', config, client,
  })
  assert.equal(blocked.acquired, false)
  if (blocked.acquired) assert.fail('maintenance must block refresh lease acquisition')
  assert.equal(blocked.reason, 'maintenance-active')
  assert.equal((await verifyBucketMaintenance({ owner: 'wrong', fencingToken: 2 }, { config, client })).valid, false)
  assert.equal((await releaseBucketMaintenance({ owner: 'wrong', fencingToken: 2 }, { config, client })).released, false)
  assert.equal((await releaseBucketMaintenance(maintenance.maintenance, { config, client })).released, true)
  const successor = await acquireBucketLease('ops/refresh-lease.json', {
    owner: 'successor', now: '2026-07-19T00:00:03Z', ttlMs: 60_000, fenceActiveKey: 'active-generation.json', config, client,
  })
  assert.equal(successor.acquired, true)
  assert.equal(successor.acquired && successor.lease.fencingToken, 3)
})

test('maintenance recovery requires operator confirmation and exact identity', async () => {
  const client = memoryS3()
  const maintenance = await acquireBucketMaintenance({ owner: 'crashed-gc', config, client })
  assert.equal(maintenance.acquired, true)
  if (!maintenance.maintenance) return
  assert.equal((await recoverBucketMaintenance(maintenance.maintenance, { config, client })).reason, 'operator-confirmation-required')
  assert.equal((await recoverBucketMaintenance({ ...maintenance.maintenance, fencingToken: maintenance.maintenance.fencingToken + 1 }, { confirmedTerminated: true, config, client })).released, false)
  assert.equal((await recoverBucketMaintenance(maintenance.maintenance, { confirmedTerminated: true, config, client })).released, true)
})
import {
  createMemoryDurableObjectStore,
  createRailwayDurableObjectStore,
  decideDurableCrunchMode,
  executeRailwayDurableGc,
  planDurableGc,
  promoteDurableGeneration,
  recordRolloutOutcome,
  restoreDurableGeneration,
  stageDurableGeneration,
  type DurableIdentity,
} from '../scripts/durable-ranking-state.mjs'
import { runRankingStateGc } from '../scripts/gc-ranking-state.mjs'

test('maintenance prints exact recovery identity before a planning failure', async () => {
  const client = memoryS3()
  let output = ''
  let recoveryOutputFlushed = false
  await assert.rejects(runRankingStateGc({
    args: [],
    env: {},
    config,
    client,
    owner: 'printed-owner',
    now: () => new Date('2026-07-20T00:00:00.000Z'),
    output: async (message: string) => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      output += message
      recoveryOutputFlushed = true
    },
    planGc: async () => {
      assert.equal(recoveryOutputFlushed, true)
      throw new Error('injected planning failure')
    },
  }), /injected planning failure/)
  assert.match(output, /^Maintenance acquired owner=printed-owner fencingToken=1\n/)
  assert.match(output, /--recover printed-owner 1 --confirm-terminated/)
})

test('exclusive sweep and successor promotion share one active-pointer authority without a deletion race', async () => {
  const client = memoryS3()
  const store = createRailwayDurableObjectStore({ config, client })
  const root = await mkdtemp(join(tmpdir(), 'ranking-gc-race-'))
  const stateDir = join(root, 'state')
  await mkdir(join(stateDir, 'canonical'), { recursive: true })
  const identity: DurableIdentity = { compatibilityHash: 'gc', pipelineVersion: 'gc', codeHash: 'gc', modelVersion: 'gc', modelConfigHash: 'gc' }
  try {
    await writeFile(join(stateDir, 'canonical', 'state.json'), 'planned-reused-digest')
    const old = await stageDurableGeneration({ store, stateDir, identity, generatedAt: '2026-01-01T00:00:00.000Z', retention: { date: '2026-01-01', boundaries: [] } })
    await writeFile(join(stateDir, 'canonical', 'state.json'), 'active-digest')
    const activeCandidate = await stageDurableGeneration({ store, stateDir, identity, generatedAt: '2026-07-19T00:00:00.000Z' })
    assert.equal((await promoteDurableGeneration({ store, candidate: activeCandidate, fencingToken: 1, generationId: 'active', promotedAt: '2026-07-19T00:00:01.000Z' })).promoted, true)
    const maintenance = await acquireBucketMaintenance({ owner: 'integrated-gc', now: '2026-07-20T00:00:00.000Z', config, client })
    assert.equal(maintenance.acquired, true)
    if (!maintenance.maintenance) return
    const readPlan = async () => {
      const pointer = await readBucketJson('active-generation.json', { config, client })
      return planDurableGc({ store, activePointer: pointer.value, activeEtag: pointer.etag, now: '2026-07-20T00:00:00.000Z', recentDays: 1 })
    }
    const plan = await readPlan()
    assert.ok(old.manifest.objects.some((ref) => plan.plannedDeletes.some((entry) => entry.key === ref.key)))
    let checkedRace = false
    const swept = await executeRailwayDurableGc({
      store,
      plan,
      dryRun: false,
      maintenanceGuard: maintenance.maintenance,
      bucketConfig: config,
      bucketClient: client,
      replan: readPlan,
      beforeDelete: async () => {
        if (checkedRace) return
        checkedRace = true
        const blocked = await acquireBucketLease('ops/refresh-lease.json', { owner: 'successor', now: '2026-07-20T00:00:01.000Z', ttlMs: 60_000, fenceActiveKey: 'active-generation.json', config, client })
        assert.equal(blocked.acquired, false)
        assert.equal(!blocked.acquired && blocked.reason, 'maintenance-active')
        assert.equal((await promoteDurableGeneration({ store, candidate: old, fencingToken: 3, generationId: 'forbidden', promotedAt: '2026-07-20T00:00:01.000Z' })).reason, 'maintenance-active')
      },
    })
    assert.ok(Number(swept.deleted) > 0)
    assert.equal((await releaseBucketMaintenance(maintenance.maintenance, { config, client })).released, true)
    const successor = await acquireBucketLease('ops/refresh-lease.json', { owner: 'successor', now: '2026-07-20T00:00:02.000Z', ttlMs: 60_000, fenceActiveKey: 'active-generation.json', config, client })
    assert.equal(successor.acquired, true)
    if (!successor.acquired) return
    await writeFile(join(stateDir, 'canonical', 'state.json'), 'planned-reused-digest')
    const reused = await stageDurableGeneration({ store, stateDir, identity, generatedAt: '2026-07-20T00:00:02.000Z' })
    const publicDir = join(root, 'public')
    await mkdir(publicDir, { recursive: true })
    await writeFile(join(publicDir, 'ranking-summary.json'), '{"artifactMeta":{"runId":"successor"}}\n')
    const publication = await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'successor',
      fencingToken: successor.lease.fencingToken,
      privateState: {
        manifestKey: reused.manifestKey,
        manifestDigest: reused.manifestDigest,
        manifestBytes: reused.manifestBytes,
        stateRoot: reused.stateRoot,
        identityHash: reused.identityHash,
        retention: reused.manifest.retention,
      },
      leaseGuard: { key: 'ops/refresh-lease.json', owner: successor.lease.owner, fencingToken: successor.lease.fencingToken, authorityKey: successor.authorityKey },
      config,
      client,
      clock: () => new Date('2026-07-20T00:00:03.000Z'),
    })
    const promotion = publication.promotion
    assert.equal(typeof promotion === 'object' && promotion !== null && 'promoted' in promotion && promotion.promoted, true)
    for (const ref of reused.manifest.objects) assert.equal((await store.head(ref.key)).found, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const config = {
  enabled: true,
  bucket: 'bucket',
  endpoint: 'https://example.invalid',
  region: 'auto',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  prefix: 'rankings',
}

test('conditional JSON state writes and lease fencing reject stale owners', async () => {
  const client = memoryS3()
  const first = await writeBucketJson('state.json', { generation: 1 }, { ifNoneMatch: '*', config, client })
  assert.equal(first.written, true)
  assert.equal((await writeBucketJson('state.json', { generation: 2 }, { ifNoneMatch: '*', config, client })).conflict, true)
  assert.equal((await readBucketJson('state.json', { config, client })).value?.generation, 1)

  const lease1 = await acquireBucketLease('lease.json', { owner: 'one', now: '2026-07-11T00:00:00Z', ttlMs: 60_000, config, client })
  const blocked = await acquireBucketLease('lease.json', { owner: 'two', now: '2026-07-11T00:00:30Z', ttlMs: 60_000, config, client })
  const lease2 = await acquireBucketLease('lease.json', { owner: 'two', now: '2026-07-11T00:01:01Z', ttlMs: 60_000, config, client })
  assert.equal(lease1.acquired, true)
  assert.equal(blocked.acquired, false)
  assert.equal(lease2.acquired, true)
  assert.equal(lease2.lease.fencingToken, 2)
})

test('released leases allow the next scheduled worker to run immediately', async () => {
  const client = memoryS3()
  const first = await acquireBucketLease('lease.json', { owner: 'one', now: '2026-07-11T00:00:00Z', ttlMs: 60_000, config, client })
  assert.equal(first.acquired, true)
  if (!first.acquired) return

  const released = await releaseBucketLease('lease.json', first, { now: '2026-07-11T00:00:10Z', config, client })
  assert.equal(released.released, true)

  const second = await acquireBucketLease('lease.json', { owner: 'two', now: '2026-07-11T00:00:11Z', ttlMs: 60_000, config, client })
  assert.equal(second.acquired, true)
  assert.equal(second.acquired && second.lease.fencingToken, 2)
  assert.equal((await releaseBucketLease('lease.json', first, { now: '2026-07-11T00:00:12Z', config, client })).reason, 'lease-changed')
})

test('active pointer CAS is the single lease authority across the expired-successor interleaving', async () => {
  const client = memoryS3()
  await writeBucketJson('active-generation.json', {
    schemaVersion: 1,
    generationId: 'current-generation',
    fencingToken: 1,
    privateState: { manifestKey: 'durable/current.json' },
    refreshLease: {
      schemaVersion: 1,
      key: 'ops/refresh-lease.json',
      owner: 'expired',
      fencingToken: 1,
      acquiredAt: '2026-07-19T00:00:00.000Z',
      expiresAt: '2026-07-19T00:00:10.000Z',
    },
  }, { ifNoneMatch: '*', config, client })

  let resumeStaleCas: (() => void) | undefined
  const stalePaused = new Promise<void>((resolvePause) => {
    resumeStaleCas = resolvePause
  })
  let staleReachedCas: (() => void) | undefined
  const staleAtCas = new Promise<void>((resolveReached) => {
    staleReachedCas = resolveReached
  })
  const staleAttempt = acquireBucketLease('ops/refresh-lease.json', {
    owner: 'stale-successor',
    now: '2026-07-19T00:00:11.000Z',
    ttlMs: 60_000,
    fenceActiveKey: 'active-generation.json',
    config,
    client,
    beforeAuthorityCas: async ({ attempt }) => {
      if (attempt !== 0) return
      staleReachedCas?.()
      await stalePaused
    },
  })
  await staleAtCas

  const winner = await acquireBucketLease('ops/refresh-lease.json', {
    owner: 'winner',
    now: '2026-07-19T00:00:12.000Z',
    ttlMs: 60_000,
    fenceActiveKey: 'active-generation.json',
    config,
    client,
  })
  assert.equal(winner.acquired, true)
  if (!winner.acquired) return
  resumeStaleCas?.()
  const stale = await staleAttempt
  assert.equal(stale.acquired, false)
  assert.equal(stale.reason, 'active-lease')

  const active = await readBucketJson('active-generation.json', { config, client })
  assert.equal(active.value?.generationId, 'current-generation')
  assert.deepEqual(active.value?.privateState, { manifestKey: 'durable/current.json' })
  assert.equal(active.value?.fencingToken, 2)
  assert.equal((active.value?.refreshLease as { owner?: string }).owner, 'winner')

  const retry = await acquireBucketLease('ops/refresh-lease.json', {
    owner: 'winner',
    now: '2026-07-19T00:00:13.000Z',
    ttlMs: 60_000,
    fenceActiveKey: 'active-generation.json',
    config,
    client,
  })
  assert.equal(retry.acquired, true)
  assert.equal(retry.acquired && retry.idempotent, true)
  assert.equal(retry.acquired && retry.lease.fencingToken, 2)

  const staleRelease = await releaseBucketLease('ops/refresh-lease.json', {
    authorityKey: 'active-generation.json',
    lease: {
      owner: 'expired', fencingToken: 1, acquiredAt: '2026-07-19T00:00:00.000Z', expiresAt: '2026-07-19T00:00:10.000Z',
    },
  }, { now: '2026-07-19T00:00:14.000Z', config, client })
  assert.equal(staleRelease.released, false)
  assert.equal((await readBucketJson('active-generation.json', { config, client })).value?.fencingToken, 2)
})

test('lease authority remains valid when the observability mirror cannot be written', async () => {
  const client = memoryS3({ failPutKeys: new Set(['rankings/ops/refresh-lease.json']) })
  const acquired = await acquireBucketLease('ops/refresh-lease.json', {
    owner: 'authority-owner',
    now: '2026-07-19T00:00:00.000Z',
    ttlMs: 60_000,
    fenceActiveKey: 'active-generation.json',
    config,
    client,
  })
  assert.equal(acquired.acquired, true)
  if (!acquired.acquired) return
  assert.equal(client.objects.has('rankings/ops/refresh-lease.json'), false)
  const verified = await verifyBucketLease('ops/refresh-lease.json', {
    authorityKey: acquired.authorityKey,
    owner: acquired.lease.owner,
    fencingToken: acquired.lease.fencingToken,
    etag: 'deliberately-stale-observability-etag',
  }, { now: '2026-07-19T00:00:01.000Z', config, client })
  assert.equal(verified.valid, true)
})

test('a successor remains authoritative when an expired owner pauses after its mirror write', async () => {
  const client = memoryS3()
  let resumeMirror: (() => void) | undefined
  const mirrorPaused = new Promise<void>((resolvePause) => {
    resumeMirror = resolvePause
  })
  let mirrorReached: (() => void) | undefined
  const atMirror = new Promise<void>((resolveReached) => {
    mirrorReached = resolveReached
  })
  const expiredAttempt = acquireBucketLease('ops/refresh-lease.json', {
    owner: 'expired-owner',
    now: '2026-07-19T00:00:00.000Z',
    ttlMs: 10_000,
    fenceActiveKey: 'active-generation.json',
    config,
    client,
    afterMirrorPut: async () => {
      mirrorReached?.()
      await mirrorPaused
    },
  })
  await atMirror
  const successor = await acquireBucketLease('ops/refresh-lease.json', {
    owner: 'successor',
    now: '2026-07-19T00:00:11.000Z',
    ttlMs: 60_000,
    fenceActiveKey: 'active-generation.json',
    config,
    client,
  })
  assert.equal(successor.acquired, true)
  resumeMirror?.()
  const expired = await expiredAttempt
  assert.equal(expired.acquired, true)
  if (!expired.acquired || !successor.acquired) return
  assert.equal((await verifyBucketLease('ops/refresh-lease.json', {
    authorityKey: expired.authorityKey,
    owner: expired.lease.owner,
    fencingToken: expired.lease.fencingToken,
  }, { now: '2026-07-19T00:00:11.000Z', config, client })).valid, false)
  const active = await readBucketJson('active-generation.json', { config, client })
  assert.equal(active.value?.fencingToken, successor.lease.fencingToken)
  assert.equal((active.value?.refreshLease as { owner?: string }).owner, 'successor')
})

test('an active refresh lease rejects unguarded and competing generation promotion', async () => {
  const client = memoryS3()
  const publicDir = await mkdtemp(join(tmpdir(), 'lease-promotion-'))
  await mkdir(join(publicDir, 'scopes'), { recursive: true })
  await writeFile(join(publicDir, 'ranking-summary.json'), '{}\n')
  await writeFile(join(publicDir, 'scopes', 'all.json'), '{}\n')
  const lease = await acquireBucketLease('ops/refresh-lease.json', {
    owner: 'winner',
    now: new Date(),
    ttlMs: 60_000,
    fenceActiveKey: 'active-generation.json',
    config,
    client,
  })
  assert.equal(lease.acquired, true)
  if (!lease.acquired) return
  try {
    await assert.rejects(() => uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'unguarded',
      fencingToken: lease.lease.fencingToken,
      config,
      client,
    }), /requires an active generation lease guard/)
    await assert.rejects(() => uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'competitor',
      fencingToken: lease.lease.fencingToken,
      leaseGuard: { key: 'ops/refresh-lease.json', owner: 'competitor', fencingToken: lease.lease.fencingToken, authorityKey: lease.authorityKey },
      config,
      client,
    }), /no longer authorizes promotion/)
    const promoted = await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'winner',
      fencingToken: lease.lease.fencingToken,
      leaseGuard: { key: 'ops/refresh-lease.json', owner: lease.lease.owner, fencingToken: lease.lease.fencingToken, authorityKey: lease.authorityKey },
      config,
      client,
    })
    assert.equal((promoted.promotion as { promoted?: boolean }).promoted, true)
  } finally {
    await rm(publicDir, { recursive: true, force: true })
  }
})

test('a higher-token mirror-only lease cannot publish or update rollout metadata', async () => {
  const client = memoryS3()
  const publicDir = await mkdtemp(join(tmpdir(), 'mirror-only-guard-'))
  await writeFile(join(publicDir, 'ranking-summary.json'), '{}\n')
  try {
    const initialLease = await acquireRefreshAuthority(client, 'active-before-mirror', '2026-07-19T00:00:00.000Z')
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'active-before-mirror',
      fencingToken: initialLease.lease.fencingToken,
      leaseGuard: refreshGuard(initialLease),
      config,
      client,
    })
    const mirror = await writeBucketJson('ops/mirror-only.json', {
      schemaVersion: 1,
      owner: 'mirror-only',
      fencingToken: 9,
      acquiredAt: '2026-07-19T00:00:00.000Z',
      expiresAt: '2026-07-19T01:00:00.000Z',
    }, { ifNoneMatch: '*', config, client })
    assert.equal(mirror.written, true)
    const mirrorGuard = {
      key: 'ops/mirror-only.json',
      owner: 'mirror-only',
      fencingToken: 9,
      etag: mirror.etag,
    }
    assert.equal((await verifyBucketLease(mirrorGuard.key, mirrorGuard, {
      now: '2026-07-19T00:30:00.000Z', config, client,
    })).valid, true)
    const before = new Map([...client.objects].map(([key, value]) => [key, { ...value }]))

    await assert.rejects(() => uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'mirror-illegal-generation',
      fencingToken: 9,
      leaseGuard: mirrorGuard,
      clock: () => '2026-07-19T00:30:00.000Z',
      config,
      client,
    }), /invalid-refresh-lease-authority/)
    assert.deepEqual(client.objects, before)

    await assert.rejects(() => uploadRankingArtifacts({
      publicDataDir: publicDir,
      publishGeneration: false,
      fencingToken: 9,
      leaseGuard: mirrorGuard,
      rolloutForActive: () => ({ consecutiveShadowSuccesses: 99 }),
      clock: () => '2026-07-19T00:30:00.000Z',
      config,
      client,
    }), /invalid-refresh-lease-authority/)
    assert.deepEqual(client.objects, before)
  } finally {
    await rm(publicDir, { recursive: true, force: true })
  }
})

test('protected publication requires active authority even when no lease objects exist', async () => {
  const client = memoryS3()
  const publicDir = await mkdtemp(join(tmpdir(), 'missing-authority-'))
  await writeFile(join(publicDir, 'ranking-summary.json'), '{}\n')
  const before = new Map(client.objects)
  try {
    await assert.rejects(() => uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'unguarded-empty-bucket',
      fencingToken: 1,
      config,
      client,
    }), /requires an active generation lease guard/)
    assert.deepEqual(client.objects, before)
    await assert.rejects(() => uploadRankingArtifacts({
      publicDataDir: publicDir,
      publishGeneration: false,
      fencingToken: 1,
      rolloutForActive: () => ({ consecutiveShadowSuccesses: 1 }),
      config,
      client,
    }), /requires an active generation lease guard/)
    assert.deepEqual(client.objects, before)
  } finally {
    await rm(publicDir, { recursive: true, force: true })
  }
})

test('expired lease owners cannot publish and a successor fenced during the final CAS wins', async () => {
  const client = memoryS3()
  const root = await mkdtemp(join(tmpdir(), 'lease-cas-adversary-'))
  const staleDir = join(root, 'stale')
  const winnerDir = join(root, 'winner')
  const staleRawDir = join(root, 'stale-raw')
  const winnerRawDir = join(root, 'winner-raw')
  await mkdir(staleDir, { recursive: true })
  await mkdir(winnerDir, { recursive: true })
  await mkdir(staleRawDir, { recursive: true })
  await mkdir(winnerRawDir, { recursive: true })
  await writeFile(join(staleDir, 'ranking-summary.json'), '{"worker":"stale"}\n')
  await writeFile(join(winnerDir, 'ranking-summary.json'), '{"worker":"winner"}\n')
  await writeFile(join(staleRawDir, 'matches.csv'), 'worker,game\nstale,1\n')
  await writeFile(join(winnerRawDir, 'matches.csv'), 'worker,game\nwinner,1\n')
  await writeFile(join(staleRawDir, 'manifest.json'), `${JSON.stringify({ files: { oracleCsv: [join(staleRawDir, 'matches.csv')] } })}\n`)
  await writeFile(join(winnerRawDir, 'manifest.json'), `${JSON.stringify({ files: { oracleCsv: [join(winnerRawDir, 'matches.csv')] } })}\n`)
  await writeFile(join(staleRawDir, 'refresh-state.json'), '{"worker":"stale"}\n')
  await writeFile(join(winnerRawDir, 'refresh-state.json'), '{"worker":"winner"}\n')
  let now = '2026-07-19T00:00:00.000Z'
  const staleLease = await acquireBucketLease('ops/refresh-lease.json', {
    owner: 'stale', now, ttlMs: 10_000, fenceActiveKey: 'active-generation.json', config, client,
  })
  assert.equal(staleLease.acquired, true)
  if (!staleLease.acquired) return
  try {
    await assert.rejects(() => uploadRankingArtifacts({
      publicDataDir: staleDir,
      generationId: 'expired',
      fencingToken: staleLease.lease.fencingToken,
      leaseGuard: { key: 'ops/refresh-lease.json', owner: staleLease.lease.owner, fencingToken: staleLease.lease.fencingToken, authorityKey: staleLease.authorityKey },
      clock: () => '2026-07-19T00:00:11.000Z',
      config,
      client,
    }), /lease-expired/)

    now = '2026-07-19T00:00:05.000Z'
    await assert.rejects(() => uploadRankingArtifacts({
      publicDataDir: staleDir,
      rawDir: staleRawDir,
      manifestPath: join(staleRawDir, 'manifest.json'),
      statePath: join(staleRawDir, 'refresh-state.json'),
      generationId: 'stale',
      fencingToken: staleLease.lease.fencingToken,
      leaseGuard: { key: 'ops/refresh-lease.json', owner: staleLease.lease.owner, fencingToken: staleLease.lease.fencingToken, authorityKey: staleLease.authorityKey },
      clock: () => now,
      beforeActivePointerCas: async () => {
        now = '2026-07-19T00:00:11.000Z'
        const winnerLease = await acquireBucketLease('ops/refresh-lease.json', {
          owner: 'winner', now, ttlMs: 60_000, fenceActiveKey: 'active-generation.json', config, client,
        })
        assert.equal(winnerLease.acquired, true)
        if (!winnerLease.acquired) return
        await uploadRankingArtifacts({
          publicDataDir: winnerDir,
          rawDir: winnerRawDir,
          manifestPath: join(winnerRawDir, 'manifest.json'),
          statePath: join(winnerRawDir, 'refresh-state.json'),
          generationId: 'winner',
          fencingToken: winnerLease.lease.fencingToken,
          leaseGuard: { key: 'ops/refresh-lease.json', owner: winnerLease.lease.owner, fencingToken: winnerLease.lease.fencingToken, authorityKey: winnerLease.authorityKey },
          clock: () => now,
          config,
          client,
        })
      },
      config,
      client,
    }), /active generation changed during promotion/i)
    const active = JSON.parse(client.objects.get('rankings/active-generation.json')!.body)
    assert.equal(active.generationId, 'winner')
    assert.equal(active.fencingToken, 2)
    const rawDescriptor = JSON.parse(client.objects.get(`rankings/${active.rawState.descriptorKey}`)!.body)
    const winnerSource = rawDescriptor.objects.find((entry: { kind: string }) => entry.kind === 'source')
    assert.ok(winnerSource)
    assert.equal(client.objects.get(`rankings/${winnerSource.key}`)?.body, 'worker,game\nwinner,1\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parity mismatch is committed with the public full pointer, preserves private state, and is retry-idempotent', async () => {
  const client = memoryS3()
  const root = await mkdtemp(join(tmpdir(), 'rollout-mismatch-'))
  await writeFile(join(root, 'ranking-summary.json'), '{}\n')
  const privateState = {
    manifestKey: 'durable/generations/owner/manifest.json',
    manifestDigest: 'manifest',
    manifestBytes: 10,
    stateRoot: 'state',
    identityHash: 'identity',
  }
  try {
    const initialLease = await acquireRefreshAuthority(client, 'before-mismatch', '2026-07-19T00:00:00.000Z')
    await uploadRankingArtifacts({
      publicDataDir: root,
      generationId: 'before-mismatch',
      fencingToken: initialLease.lease.fencingToken,
      leaseGuard: refreshGuard(initialLease),
      privateState,
      rollout: { identityHash: 'identity', consecutiveShadowSuccesses: 3 },
      config,
      client,
    })
    assert.equal((await releaseBucketLease('ops/refresh-lease.json', initialLease, { now: '2026-07-19T00:01:00.000Z', config, client })).released, true)
    const mismatchLease = await acquireRefreshAuthority(client, 'mismatch', '2026-07-19T00:01:01.000Z')
    const mismatchAt = '2026-07-19T12:00:00.000Z'
    await uploadRankingArtifacts({
      publicDataDir: root,
      generationId: 'mismatch-full',
      fencingToken: mismatchLease.lease.fencingToken,
      leaseGuard: refreshGuard(mismatchLease),
      rolloutUpdateId: 'mismatch-run',
      rolloutForActive: (previous) => recordRolloutOutcome(previous, {
        identityHash: 'identity', parity: { result: 'mismatch' }, at: mismatchAt,
      }),
      config,
      client,
    })
    const mismatchPointer = JSON.parse(client.objects.get('rankings/active-generation.json')!.body)
    assert.equal(mismatchPointer.generationId, 'mismatch-full')
    assert.deepEqual(mismatchPointer.privateState, privateState)
    assert.equal(mismatchPointer.rollout.consecutiveShadowSuccesses, 0)
    assert.equal(mismatchPointer.rollout.blockedReason, 'parity-mismatch')
    assert.equal(mismatchPointer.rollout.lastAuditAt, mismatchAt)

    await uploadRankingArtifacts({
      publicDataDir: root,
      generationId: 'mismatch-full',
      fencingToken: mismatchLease.lease.fencingToken,
      leaseGuard: refreshGuard(mismatchLease),
      rolloutUpdateId: 'mismatch-run',
      rolloutForActive: () => { throw new Error('mismatch rollout reapplied') },
      config,
      client,
    })
    assert.deepEqual(JSON.parse(client.objects.get('rankings/active-generation.json')!.body), mismatchPointer)
    assert.equal(decideDurableCrunchMode({
      requestedMode: 'incremental',
      identity: {
        compatibilityHash: 'compatibility', pipelineVersion: 'pipeline', codeHash: 'code', modelVersion: 'model', modelConfigHash: 'config',
      },
      activePointer: mismatchPointer,
      now: '2026-07-20T00:00:00.000Z',
    }).effectiveMode, 'full')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('generation publication uploads immutable data before promoting one pointer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-generation-'))
  const publicDir = join(root, 'public')
  await mkdir(join(publicDir, 'scopes'), { recursive: true })
  await writeFile(join(publicDir, 'scopes', 'all.json'), '{"matchCount":1}\n')
  await writeFile(join(publicDir, 'ranking-summary.json'), '{"artifactKind":"public-ranking-manifest"}\n')
  const client = memoryS3()
  try {
    const firstLease = await acquireRefreshAuthority(client, 'run-1')
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'run-1',
      fencingToken: firstLease.lease.fencingToken,
      leaseGuard: refreshGuard(firstLease),
      config,
      client,
    })
    assert.ok(client.objects.has('rankings/generations/run-1/data/scopes/all.json'))
    assert.ok(client.objects.has('rankings/generations/run-1/data/ranking-summary.json'))
    const active = JSON.parse(client.objects.get('rankings/active-generation.json')!.body)
    assert.equal(active.generationId, 'run-1')
    assert.equal(active.fencingToken, firstLease.lease.fencingToken)

    assert.equal((await releaseBucketLease('ops/refresh-lease.json', firstLease, { config, client })).released, true)
    const secondLease = await acquireRefreshAuthority(client, 'run-2')
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'run-2',
      fencingToken: secondLease.lease.fencingToken,
      leaseGuard: refreshGuard(secondLease),
      config,
      client,
    })
    const retry = await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'run-2',
      fencingToken: secondLease.lease.fencingToken,
      leaseGuard: refreshGuard(secondLease),
      config,
      client,
    })
    assert.equal((retry.promotion as { idempotent?: boolean }).idempotent, true)
    await writeFile(join(publicDir, 'scopes', 'all.json'), '{"matchCount":2}\n')
    await assert.rejects(() => uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'run-2',
      fencingToken: secondLease.lease.fencingToken,
      leaseGuard: refreshGuard(secondLease),
      config,
      client,
    }), /Immutable generation object collision/)
    await assert.rejects(() => uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'stale-run',
      fencingToken: firstLease.lease.fencingToken,
      leaseGuard: refreshGuard(secondLease),
      config,
      client,
    }), /Stale refresh worker/)
    assert.equal(JSON.parse(client.objects.get('rankings/active-generation.json')!.body).generationId, 'run-2')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Railway bucket adapter restores private state referenced by the public CAS pointer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ranking-durable-adapter-'))
  const publicDir = join(root, 'public')
  const stateDir = join(root, 'state')
  const restoredDir = join(root, 'restored')
  const client = memoryS3()
  const durableIdentity: DurableIdentity = {
    compatibilityHash: 'compatibility',
    pipelineVersion: 'pipeline',
    codeHash: 'code',
    modelVersion: 'model',
    modelConfigHash: 'config',
  }
  try {
    await mkdir(publicDir, { recursive: true })
    await mkdir(join(stateDir, 'canonical'), { recursive: true })
    await writeFile(join(publicDir, 'ranking-summary.json'), '{"artifactKind":"public-ranking-manifest"}\n')
    await writeFile(join(stateDir, 'active-generation.json'), 'private active\n')
    await writeFile(join(stateDir, 'canonical', 'ledger.json'), 'private canonical\n')
    const store = createRailwayDurableObjectStore({ config, client })
    const candidate = await stageDurableGeneration({
      store,
      stateDir,
      identity: durableIdentity,
      generatedAt: '2026-07-19T00:00:00.000Z',
    })
    const lease = await acquireRefreshAuthority(client, 'durable-run')
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      generationId: 'durable-run',
      fencingToken: lease.lease.fencingToken,
      leaseGuard: refreshGuard(lease),
      config,
      client,
      privateState: {
        manifestKey: candidate.manifestKey,
        manifestDigest: candidate.manifestDigest,
        manifestBytes: candidate.manifestBytes,
        stateRoot: candidate.stateRoot,
        identityHash: candidate.identityHash,
      },
      rolloutForActive: (previous) => ({
        ...(typeof previous === 'object' && previous !== null ? previous : {}),
        identityHash: candidate.identityHash,
        consecutiveShadowSuccesses: 1,
      }),
    })
    const restored = await restoreDurableGeneration({ store, stateDir: restoredDir, expectedIdentity: durableIdentity })
    assert.equal(restored.restored, true)
    assert.equal(await readFile(join(restoredDir, 'canonical', 'ledger.json'), 'utf8'), 'private canonical\n')
    const active = JSON.parse(client.objects.get('rankings/active-generation.json')!.body)
    assert.equal(active.privateState.manifestKey, candidate.manifestKey)
    assert.equal(active.rollout.identityHash, candidate.identityHash)
    assert.equal(active.rollout.consecutiveShadowSuccesses, 1)
    assert.equal(active.fencingToken, lease.lease.fencingToken)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('raw GC fails closed for every unsafe descriptor logical path', async (t) => {
  for (const logicalPath of ['../escape.csv', '/absolute.csv', 'dir/./file.csv', '']) {
    await t.test(JSON.stringify(logicalPath), async () => {
      const store = createMemoryDurableObjectStore()
      const referencedDigest = 'a'.repeat(64)
      const rawGarbageKey = `raw/objects/${'b'.repeat(64)}`
      const privateGarbageKey = `private/objects/${'c'.repeat(64)}`
      const descriptorBytes = Buffer.from(JSON.stringify({
        schemaVersion: 1,
        kind: 'raw-generation',
        createdAt: '2026-01-01T00:00:00.000Z',
        retention: { date: '2026-01-01', boundaries: [] },
        objects: [{ kind: 'source', logicalPath, key: `raw/objects/${referencedDigest}`, digest: referencedDigest, bytes: 1 }],
      }))
      const descriptorDigest = createHash('sha256').update(descriptorBytes).digest('hex')
      await store.put(`raw/generations/${descriptorDigest}.json`, descriptorBytes, {
        ifAbsent: true,
        metadata: { 'created-at': '2026-01-01T00:00:00.000Z' },
      })
      await store.put(rawGarbageKey, Buffer.from('raw garbage'), {
        ifAbsent: true,
        metadata: { 'created-at': '2026-01-01T00:00:00.000Z' },
      })
      await store.put(privateGarbageKey, Buffer.from('private garbage'), {
        ifAbsent: true,
        metadata: { 'created-at': '2026-01-01T00:00:00.000Z' },
      })

      const plan = await planDurableGc({
        store,
        now: '2026-07-30T00:00:00.000Z',
        recentDays: 1,
        stagingGraceMs: 1,
      })
      const raw = plan.raw as { safe?: boolean; reason?: string }
      assert.equal(plan.safe, false)
      assert.equal(plan.reason, 'raw-descriptor-invalid')
      assert.equal(raw.safe, false)
      assert.equal(raw.reason, 'raw-descriptor-invalid')
      assert.deepEqual(plan.plannedDeletes, [])
      assert.equal((await store.head(rawGarbageKey)).found, true)
      assert.equal((await store.head(privateGarbageKey)).found, true)
    })
  }
})

test('raw generations are immutable, deduplicated, and become authoritative only with the public CAS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raw-generation-cas-'))
  const publicDir = join(root, 'public')
  const rawDir = join(root, 'raw')
  const sourcePath = join(rawDir, 'oracle', '2026.csv')
  const manifestPath = join(rawDir, 'manifest.json')
  const statePath = join(rawDir, 'refresh-state.json')
  const client = memoryS3()
  try {
    await mkdir(publicDir, { recursive: true })
    await mkdir(dirname(sourcePath), { recursive: true })
    await writeFile(join(publicDir, 'ranking-summary.json'), '{}\n')
    await writeFile(sourcePath, 'gameid,result\ng1,1\n')
    await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, files: { oracleCsv: [sourcePath] } })}\n`)
    await writeFile(statePath, '{"fingerprint":"one"}\n')
    const firstLease = await acquireRefreshAuthority(client, 'raw-first')
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      rawDir,
      manifestPath,
      statePath,
      generationId: 'raw-first',
      fencingToken: firstLease.lease.fencingToken,
      leaseGuard: refreshGuard(firstLease),
      rawRetentionDays: 1,
      clock: () => new Date('2026-07-01T00:00:00.000Z'),
      config,
      client,
    })
    const firstActive = JSON.parse(client.objects.get('rankings/active-generation.json')!.body)
    assert.equal(typeof firstActive.rawState.descriptorKey, 'string')
    assert.equal(client.objects.has('rankings/raw/manifest.json'), false)
    assert.equal(client.objects.has('rankings/raw/refresh-state.json'), false)
    const firstDescriptor = client.objects.get(`rankings/${firstActive.rawState.descriptorKey}`)
    assert.ok(firstDescriptor)
    const firstRawObjects = [...client.objects].filter(([key]) => key.startsWith('rankings/raw/objects/'))
    assert.ok(firstRawObjects.length > 0)
    assert.equal(firstRawObjects.every(([key]) => client.checksumPutKeys.includes(key)), true)
    assert.equal(client.checksumPutKeys.includes(`rankings/${firstActive.rawState.descriptorKey}`), true)

    assert.equal((await releaseBucketLease('ops/refresh-lease.json', firstLease, { config, client })).released, true)
    await writeFile(sourcePath, 'gameid,result\ng1,0\n')
    await writeFile(statePath, '{"fingerprint":"two"}\n')
    const interruptedLease = await acquireRefreshAuthority(client, 'raw-interrupted')
    const activeBeforeInterrupted = { ...client.objects.get('rankings/active-generation.json')! }
    await assert.rejects(() => uploadRankingArtifacts({
      publicDataDir: publicDir,
      rawDir,
      manifestPath,
      statePath,
      generationId: 'raw-interrupted',
      fencingToken: interruptedLease.lease.fencingToken,
      leaseGuard: refreshGuard(interruptedLease),
      beforeActivePointerCas: async () => { throw new Error('interrupted before active CAS') },
      config,
      client,
    }), /interrupted before active CAS/)
    assert.deepEqual(client.objects.get('rankings/active-generation.json'), activeBeforeInterrupted)
    assert.equal(JSON.parse(client.objects.get('rankings/active-generation.json')!.body).rawState.descriptorKey, firstActive.rawState.descriptorKey)
    assert.ok(firstRawObjects.every(([key, value]) => client.objects.get(key)?.body === value.body))
    assert.equal(client.getKeys.some((key) => key.startsWith('rankings/raw/objects/')), false)
    assert.equal((await releaseBucketLease('ops/refresh-lease.json', interruptedLease, { config, client })).released, true)
    client.behavior.rejectChecksumRequests = true
    client.behavior.headChecksums = false
    const secondLease = await acquireRefreshAuthority(client, 'raw-second', '2026-07-30T00:00:00.000Z')
    await uploadRankingArtifacts({
      publicDataDir: publicDir,
      rawDir,
      manifestPath,
      statePath,
      generationId: 'raw-second',
      fencingToken: secondLease.lease.fencingToken,
      leaseGuard: refreshGuard(secondLease),
      rawRetentionDays: 1,
      clock: () => new Date('2026-07-30T00:00:00.000Z'),
      config,
      client,
    })
    const secondActive = JSON.parse(client.objects.get('rankings/active-generation.json')!.body)
    assert.equal(secondActive.rawHistory.some((entry: { descriptorKey: string }) => entry.descriptorKey === firstActive.rawState.descriptorKey), false)
    const durableStore = createRailwayDurableObjectStore({ config, client })
    assert.equal((await releaseBucketLease('ops/refresh-lease.json', secondLease, { config, client })).released, true)
    const maintenance = await acquireBucketMaintenance({ owner: 'raw-gc', now: '2026-07-30T00:00:01.000Z', config, client })
    assert.equal(maintenance.acquired, true)
    if (!maintenance.maintenance) return
    const readChecksumlessPlan = async () => {
      const pointer = await readBucketJson('active-generation.json', { config, client })
      return planDurableGc({
        store: durableStore,
        activePointer: pointer.value,
        activeEtag: pointer.etag,
        now: '2026-07-30T00:00:01.000Z',
        recentDays: 1,
      })
    }
    client.getKeys.length = 0
    const fallbackPlan = await readChecksumlessPlan()
    assert.equal(fallbackPlan.safe, true)
    const fallbackRaw = fallbackPlan.raw as { integrityDeferred?: number; integrityDeferredReason?: string }
    assert.ok(Number(fallbackRaw.integrityDeferred) > 0)
    assert.equal(fallbackRaw.integrityDeferredReason, 'checksum-unavailable')
    assert.ok(fallbackPlan.plannedDeletes.some((entry) => entry.kind === 'raw-object' || entry.kind === 'raw-descriptor'))
    const fallbackSweep = await executeRailwayDurableGc({
      store: durableStore,
      plan: fallbackPlan,
      dryRun: false,
      maintenanceGuard: maintenance.maintenance,
      bucketConfig: config,
      bucketClient: client,
      replan: readChecksumlessPlan,
    })
    assert.ok(Number(fallbackSweep.deleted) > 0)
    assert.equal(client.getKeys.some((key) => key.startsWith('rankings/raw/objects/')), false)
    assert.equal((await releaseBucketMaintenance(maintenance.maintenance, { config, client })).released, true)
    client.behavior.rejectChecksumRequests = false
    client.behavior.headChecksums = true
    const privateGarbageKey = `private/objects/${'b'.repeat(64)}`
    await durableStore.put(privateGarbageKey, Buffer.from('old private garbage'), {
      ifAbsent: true,
      metadata: { 'created-at': '2026-01-01T00:00:00.000Z' },
    })
    const safeWithGarbage = await planDurableGc({
      store: durableStore,
      activePointer: secondActive,
      now: '2026-07-30T00:00:00.000Z',
      recentDays: 1,
    })
    assert.ok(safeWithGarbage.plannedDeletes.some((entry) => entry.key === privateGarbageKey))
    const descriptor = JSON.parse(client.objects.get(`rankings/${secondActive.rawState.descriptorKey}`)!.body)
    const rawObjectKey = `rankings/${descriptor.objects[0].key}`
    const rawObject = client.objects.get(rawObjectKey)
    assert.ok(rawObject)
    const originalRawBytes = Buffer.byteLength(rawObject.body)
    assert.equal(rawObject.metadata?.sha256, descriptor.objects[0].digest)
    rawObject.body = `${rawObject.body.startsWith('x') ? 'y' : 'x'}${rawObject.body.slice(1)}`
    assert.equal(Buffer.byteLength(rawObject.body), originalRawBytes)
    assert.equal(rawObject.metadata?.sha256, descriptor.objects[0].digest)
    const unsafe = await planDurableGc({
      store: durableStore,
      activePointer: secondActive,
      now: '2026-07-30T00:00:00.000Z',
      recentDays: 1,
    })
    assert.equal(unsafe.safe, false)
    assert.deepEqual(unsafe.plannedDeletes, [])
    assert.equal(client.objects.has(`rankings/${privateGarbageKey}`), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function acquireRefreshAuthority(client: ReturnType<typeof memoryS3>, owner: string, now: string | Date = new Date()) {
  const lease = await acquireBucketLease('ops/refresh-lease.json', {
    owner,
    now,
    ttlMs: 24 * 60 * 60_000,
    fenceActiveKey: 'active-generation.json',
    config,
    client,
  })
  if (!lease.acquired) throw new Error(`Fixture authority unavailable: ${lease.reason}`)
  return lease
}

function refreshGuard(lease: Awaited<ReturnType<typeof acquireRefreshAuthority>>) {
  return {
    key: 'ops/refresh-lease.json',
    owner: lease.lease.owner,
    fencingToken: lease.lease.fencingToken,
    authorityKey: lease.authorityKey,
  }
}

function memoryS3(options: { failPutKeys?: Set<string> } = {}) {
  const objects = new Map<string, { body: string; etag: string; metadata?: Record<string, string> }>()
  const behavior = { headChecksums: true, rejectChecksumRequests: false }
  const getKeys: string[] = []
  const checksumPutKeys: string[] = []
  let version = 0
  return {
    objects,
    behavior,
    getKeys,
    checksumPutKeys,
    async send(command: unknown) {
      const { name, input } = commandDetails(command)
      const key = String(input.Key)
      if (name === 'GetObjectCommand') {
        getKeys.push(key)
        const object = objects.get(key)
        if (!object) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
        return { Body: Readable.from([object.body]), ETag: object.etag, ContentLength: Buffer.byteLength(object.body), Metadata: object.metadata }
      }
      if (name === 'HeadObjectCommand') {
        if (input.ChecksumMode === 'ENABLED' && behavior.rejectChecksumRequests) {
          throw Object.assign(new Error('checksums unsupported'), { name: 'InvalidRequest' })
        }
        const object = objects.get(key)
        if (!object) throw Object.assign(new Error('missing'), { name: 'NotFound' })
        return {
          ETag: object.etag,
          ContentLength: Buffer.byteLength(object.body),
          Metadata: object.metadata,
          ...(input.ChecksumMode === 'ENABLED' && behavior.headChecksums
            ? { ChecksumSHA256: createHash('sha256').update(object.body).digest('base64') }
            : {}),
        }
      }
      if (name === 'PutObjectCommand') {
        if (input.ChecksumSHA256 && behavior.rejectChecksumRequests) {
          throw Object.assign(new Error('checksums unsupported'), { name: 'InvalidRequest' })
        }
        if (options.failPutKeys?.has(key)) throw new Error('observability mirror unavailable')
        const current = objects.get(key)
        if (input.IfNoneMatch === '*' && current) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        if (input.IfMatch && input.IfMatch !== current?.etag) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        const body = await streamText(input.Body)
        if (typeof input.ChecksumSHA256 === 'string') {
          assert.equal(input.ChecksumSHA256, createHash('sha256').update(body).digest('base64'))
          checksumPutKeys.push(key)
        }
        const etag = `"${++version}"`
        objects.set(key, { body, etag, metadata: input.Metadata as Record<string, string> | undefined })
        return { ETag: etag }
      }
      if (name === 'ListObjectsV2Command') {
        const prefix = String(input.Prefix ?? '')
        return {
          Contents: [...objects.entries()]
            .filter(([objectKey]) => objectKey.startsWith(prefix))
            .map(([Key, value]) => ({ Key, Size: Buffer.byteLength(value.body) })),
        }
      }
      if (name === 'DeleteObjectCommand') {
        objects.delete(key)
        return {}
      }
      throw new Error(`Unsupported command ${name}`)
    },
  }
}

function commandDetails(value: unknown) {
  const command = value as { constructor: { name: string }; input: Record<string, unknown> }
  return { name: command.constructor.name, input: command.input }
}

async function streamText(value: unknown) {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  const chunks: Buffer[] = []
  for await (const chunk of value as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
