import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { uploadContentAddressedPublicArtifactPatch, uploadContentAddressedPublicArtifacts } from '../scripts/railway-bucket.mjs'
import { materializePublicArtifactPatch } from '../scripts/public-artifact-materialization.mjs'
import { createPublicArtifactWritePlan } from '../src/domains/rankings/internal/published/writePlan.ts'
import { createStaticRankingData } from '../src/domains/rankings/internal/projections/snapshot.ts'

const config = { enabled: true, bucket: 'test', endpoint: 'https://example.invalid', region: 'auto', accessKeyId: 'x', secretAccessKey: 'y', prefix: 'rankings' }

test('partial artifact patch uploads only changed hashes and composes exact complete mapping with removals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ranking-patch-'))
  const client = memoryS3()
  try {
    await mkdir(join(dir, 'matches/pages'), { recursive: true })
    await writeFile(join(dir, 'ranking-summary.json'), JSON.stringify(root('base')))
    await writeFile(join(dir, 'stable.json'), JSON.stringify({ artifactKind: 'fixture', value: 1 }))
    await writeFile(join(dir, 'removed.json'), JSON.stringify({ artifactKind: 'fixture', value: 2 }))
    await writeFile(join(dir, 'matches/pages/all-1.json'), JSON.stringify({ artifactKind: 'fixture-page', matches: ['old'] }))
    const base = await uploadContentAddressedPublicArtifacts(client, config, dir, 'base')
    const putsBefore = client.putKeys.length
    const patch = await uploadContentAddressedPublicArtifactPatch(client, config, {
      generationId: 'next',
      previousManifest: base.manifest,
      changedArtifacts: [
        { logicalPath: '/data/ranking-summary.json', value: root('next') },
        { logicalPath: '/data/matches/pages/all-1.json', value: { artifactKind: 'fixture-page', matches: ['old', 'new'] } },
      ],
      removedLogicalPaths: ['/data/removed.json'],
      expectedLogicalPaths: ['/data/ranking-summary.json', '/data/stable.json', '/data/matches/pages/all-1.json'],
    })
    const patchArtifacts = record(patch.manifest.artifacts)
    const baseArtifacts = record(base.manifest.artifacts)
    assert.deepEqual(Object.keys(patchArtifacts).sort(), [
      '/data/matches/pages/all-1.json', '/data/ranking-summary.json', '/data/stable.json',
    ])
    assert.equal(record(patchArtifacts['/data/stable.json']).sha256, record(baseArtifacts['/data/stable.json']).sha256)
    assert.deepEqual(patch.changedLogicalPaths, ['/data/matches/pages/all-1.json', '/data/ranking-summary.json'])
    assert.deepEqual(patch.reusedLogicalPaths, ['/data/stable.json'])
    assert.deepEqual(patch.removedLogicalPaths, ['/data/removed.json'])
    assert.equal(client.putKeys.length - putsBefore, 2, 'one new semantic hash plus one immutable manifest; provenance-only root reuses its hash')
    await assert.rejects(uploadContentAddressedPublicArtifactPatch(client, config, {
      generationId: 'bad', previousManifest: base.manifest,
      changedArtifacts: [{ logicalPath: '/data/ranking-summary.json', value: root('bad') }],
      expectedLogicalPaths: ['/data/ranking-summary.json'],
    }), /Incomplete public artifact patch mapping/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('local-only patch verifies reused inputs and atomically materializes the same mapping', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ranking-local-patch-'))
  const client = memoryS3()
  try {
    await writeFile(join(dir, 'ranking-summary.json'), JSON.stringify(root('base-local')))
    await writeFile(join(dir, 'stable.json'), JSON.stringify({ artifactKind: 'fixture', value: 1 }))
    await writeFile(join(dir, 'removed.json'), JSON.stringify({ artifactKind: 'fixture', value: 2 }))
    const base = await uploadContentAddressedPublicArtifacts(client, config, dir, 'base-local')
    const patch = {
      previousManifest: base.manifest,
      changedArtifacts: [
        { logicalPath: '/data/ranking-summary.json', value: root('next-local') },
        { logicalPath: '/data/changed.json', value: { artifactKind: 'fixture', value: 3 } },
      ],
      removedLogicalPaths: ['/data/removed.json'],
      expectedLogicalPaths: ['/data/ranking-summary.json', '/data/stable.json', '/data/changed.json'],
    }
    const bucket = await uploadContentAddressedPublicArtifactPatch(client, config, { generationId: 'next-local', ...patch })
    const local = await materializePublicArtifactPatch(dir, patch)
    const bucketArtifacts = record(bucket.manifest.artifacts)
    assert.deepEqual(Object.keys(local.mapping).sort(), Object.keys(bucketArtifacts).sort())
    for (const [logicalPath, identity] of Object.entries(local.mapping)) {
      assert.equal(identity.sha256, record(bucketArtifacts[logicalPath]).sha256)
      assert.equal(identity.bytes, record(bucketArtifacts[logicalPath]).bytes)
    }
    assert.equal(JSON.parse(await readFile(join(dir, 'changed.json'), 'utf8')).value, 3)
    await assert.rejects(readFile(join(dir, 'removed.json'), 'utf8'), /ENOENT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('local patch reports committed backup cleanup failures without masking the new root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ranking-local-cleanup-warning-'))
  const client = memoryS3()
  try {
    await writeFile(join(dir, 'ranking-summary.json'), JSON.stringify(root('cleanup-base')))
    await writeFile(join(dir, 'stable.json'), JSON.stringify({ artifactKind: 'fixture', value: 1 }))
    const base = await uploadContentAddressedPublicArtifacts(client, config, dir, 'cleanup-base')
    const result = await materializePublicArtifactPatch(dir, {
      previousManifest: base.manifest,
      changedArtifacts: [
        { logicalPath: '/data/ranking-summary.json', value: root('cleanup-next') },
        { logicalPath: '/data/changed.json', value: { artifactKind: 'fixture', value: 2 } },
      ],
      expectedLogicalPaths: ['/data/ranking-summary.json', '/data/stable.json', '/data/changed.json'],
    }, {
      remove: async (path, options) => {
        if (String(path).includes('.previous-')) throw new Error('injected backup cleanup failure')
        return rm(path, options)
      },
    })

    assert.equal(result.materialized, true)
    assert.equal(result.cleanupWarning?.stage, 'backup-cleanup')
    assert.match(result.cleanupWarning?.message ?? '', /injected backup cleanup failure/)
    assert.equal(JSON.parse(await readFile(join(dir, 'ranking-summary.json'), 'utf8')).artifactMeta.runId, 'cleanup-next')
    assert.equal(JSON.parse(await readFile(join(dir, 'changed.json'), 'utf8')).value, 2)
    if (result.cleanupWarning) {
      await rm(result.cleanupWarning.backupPath, { recursive: true, force: true })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('local patch restores the old root when the staging-to-root rename fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ranking-local-swap-rollback-'))
  const client = memoryS3()
  try {
    await writeFile(join(dir, 'ranking-summary.json'), JSON.stringify(root('rollback-base')))
    await writeFile(join(dir, 'stable.json'), JSON.stringify({ artifactKind: 'fixture', value: 1 }))
    const base = await uploadContentAddressedPublicArtifacts(client, config, dir, 'rollback-base')
    let moveCount = 0
    await assert.rejects(materializePublicArtifactPatch(dir, {
      previousManifest: base.manifest,
      changedArtifacts: [
        { logicalPath: '/data/ranking-summary.json', value: root('rollback-next') },
        { logicalPath: '/data/changed.json', value: { artifactKind: 'fixture', value: 2 } },
      ],
      expectedLogicalPaths: ['/data/ranking-summary.json', '/data/stable.json', '/data/changed.json'],
    }, {
      move: async (from, to) => {
        moveCount += 1
        if (moveCount === 2) throw new Error('injected staging-to-root rename failure')
        return rename(from, to)
      },
    }), /injected staging-to-root rename failure/)

    assert.equal(moveCount, 3)
    assert.equal(JSON.parse(await readFile(join(dir, 'ranking-summary.json'), 'utf8')).artifactMeta.runId, 'rollback-base')
    assert.equal(JSON.parse(await readFile(join(dir, 'stable.json'), 'utf8')).value, 1)
    await assert.rejects(readFile(join(dir, 'changed.json'), 'utf8'), /ENOENT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('partial artifact patch fails before manifest creation when a reused object is missing or corrupt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ranking-patch-authority-'))
  const client = memoryS3()
  try {
    await writeFile(join(dir, 'ranking-summary.json'), JSON.stringify(root('base')))
    await writeFile(join(dir, 'stable.json'), JSON.stringify({ artifactKind: 'fixture', value: 1 }))
    const base = await uploadContentAddressedPublicArtifacts(client, config, dir, 'base')
    const stableIdentity = record(record(base.manifest.artifacts)['/data/stable.json'])
    const objectKey = `rankings/objects/sha256/${String(stableIdentity.sha256)}`
    const stored = client.objects.get(objectKey)
    assert.ok(stored)

    client.objects.delete(objectKey)
    await assert.rejects(uploadContentAddressedPublicArtifactPatch(client, config, {
      generationId: 'missing-reuse',
      previousManifest: base.manifest,
      changedArtifacts: [{ logicalPath: '/data/ranking-summary.json', value: root('missing-reuse') }],
      expectedLogicalPaths: ['/data/ranking-summary.json', '/data/stable.json'],
    }), /Referenced content-addressed object is missing/)
    assert.equal(client.objects.has('rankings/generations/missing-reuse/manifest.json'), false)

    client.objects.set(objectKey, { ...stored, bytes: Buffer.alloc(stored.bytes.length) })
    await assert.rejects(uploadContentAddressedPublicArtifactPatch(client, config, {
      generationId: 'corrupt-reuse',
      previousManifest: base.manifest,
      changedArtifacts: [{ logicalPath: '/data/ranking-summary.json', value: root('corrupt-reuse') }],
      expectedLogicalPaths: ['/data/ranking-summary.json', '/data/stable.json'],
    }), /Referenced content-addressed object gzip is corrupt/)
    assert.equal(client.objects.has('rankings/generations/corrupt-reuse/manifest.json'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('partial artifact patch repairs missing object metadata once without changing its reference', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ranking-patch-metadata-'))
  const client = memoryS3()
  try {
    await writeFile(join(dir, 'ranking-summary.json'), JSON.stringify(root('base')))
    await writeFile(join(dir, 'stable.json'), JSON.stringify({ artifactKind: 'fixture', value: 1 }))
    const base = await uploadContentAddressedPublicArtifacts(client, config, dir, 'base')
    const stableBefore = record(record(base.manifest.artifacts)['/data/stable.json'])
    const objectKey = `rankings/objects/sha256/${String(stableBefore.sha256)}`
    const stored = client.objects.get(objectKey)
    assert.ok(stored)
    client.objects.set(objectKey, {
      ...stored,
      contentType: 'application/octet-stream',
      contentEncoding: undefined,
      cacheControl: undefined,
    })
    const putsBefore = client.putKeys.filter((key) => key === objectKey).length

    const first = await uploadContentAddressedPublicArtifactPatch(client, config, {
      generationId: 'metadata-next',
      previousManifest: base.manifest,
      changedArtifacts: [{ logicalPath: '/data/ranking-summary.json', value: root('metadata-next') }],
      expectedLogicalPaths: ['/data/ranking-summary.json', '/data/stable.json'],
    })
    assert.equal(client.putKeys.filter((key) => key === objectKey).length - putsBefore, 1)
    assert.equal(first.uploaded.some((entry) => entry.reason === 'content-addressed-object-metadata-upgraded'), true)
    const stableAfterFirst = record(record(first.manifest.artifacts)['/data/stable.json'])
    assert.equal(stableAfterFirst.sha256, stableBefore.sha256)
    assert.equal(stableAfterFirst.bytes, stableBefore.bytes)
    assert.equal(stableAfterFirst.objectUrl, stableBefore.objectUrl)

    const putsAfterUpgrade = client.putKeys.filter((key) => key === objectKey).length
    const second = await uploadContentAddressedPublicArtifactPatch(client, config, {
      generationId: 'metadata-final',
      previousManifest: first.manifest,
      changedArtifacts: [{ logicalPath: '/data/ranking-summary.json', value: root('metadata-final') }],
      expectedLogicalPaths: ['/data/ranking-summary.json', '/data/stable.json'],
    })
    assert.equal(client.putKeys.filter((key) => key === objectKey).length, putsAfterUpgrade)
    const stableAfterSecond = record(record(second.manifest.artifacts)['/data/stable.json'])
    assert.equal(stableAfterSecond.sha256, stableBefore.sha256)
    assert.equal(stableAfterSecond.bytes, stableBefore.bytes)
    assert.equal(stableAfterSecond.objectUrl, stableBefore.objectUrl)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('full uploads stream-verify same-length pre-existing content-addressed objects before reuse', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ranking-full-authority-'))
  const client = memoryS3()
  try {
    await writeFile(join(dir, 'ranking-summary.json'), JSON.stringify(root('base')))
    await writeFile(join(dir, 'stable.json'), JSON.stringify({ artifactKind: 'fixture', value: 1 }))
    const base = await uploadContentAddressedPublicArtifacts(client, config, dir, 'base')
    const stableIdentity = record(record(base.manifest.artifacts)['/data/stable.json'])
    const objectKey = `rankings/objects/sha256/${String(stableIdentity.sha256)}`
    const stored = client.objects.get(objectKey)
    assert.ok(stored)
    client.objects.set(objectKey, { ...stored, bytes: Buffer.alloc(stored.bytes.length) })
    await assert.rejects(uploadContentAddressedPublicArtifacts(client, config, dir, 'base'), /gzip is corrupt|digest mismatch/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const closurePage = '/data/matches/pages/all-2026000001.json'
const missingClosurePage = /\/data\/matches\/(all|index)\.json references missing \/data\/matches\/pages\/all-2026000001\.json/

test('full upload rejects a generation that removes a match page its catalog still references', async () => {
  const { dir, runId } = await closureFixture()
  const client = memoryS3()
  try {
    await rm(join(dir, closurePage.slice('/data/'.length)))
    await assert.rejects(uploadContentAddressedPublicArtifacts(client, config, dir, runId), missingClosurePage)
    assert.equal(client.objects.has(`rankings/generations/${runId}/manifest.json`), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('patch upload rejects removing a match page that retained or changed catalogs still reference', async () => {
  const { dir, runId, nextRoot, valueAt } = await closureFixture()
  const client = memoryS3()
  try {
    const base = await uploadContentAddressedPublicArtifacts(client, config, dir, runId)
    const basePaths = Object.keys(record(base.manifest.artifacts))
    const removePage = {
      previousManifest: base.manifest,
      removedLogicalPaths: [closurePage],
      expectedLogicalPaths: basePaths.filter((path) => path !== closurePage),
    }
    const putsBefore = client.putKeys.length
    await assert.rejects(uploadContentAddressedPublicArtifactPatch(client, config, {
      ...removePage,
      generationId: 'closure-retained',
      changedArtifacts: [{ logicalPath: '/data/ranking-summary.json', value: nextRoot('closure-retained') }],
    }), missingClosurePage)
    await assert.rejects(uploadContentAddressedPublicArtifactPatch(client, config, {
      ...removePage,
      generationId: 'closure-changed',
      changedArtifacts: [
        { logicalPath: '/data/ranking-summary.json', value: nextRoot('closure-changed') },
        { logicalPath: '/data/matches/index.json', value: valueAt('/data/matches/index.json') },
        { logicalPath: '/data/matches/all.json', value: valueAt('/data/matches/all.json') },
      ],
    }), missingClosurePage)
    assert.equal(client.putKeys.length, putsBefore, 'a rejected patch writes no object or generation manifest')

    const getsBefore = client.getKeys.length
    await uploadContentAddressedPublicArtifactPatch(client, config, {
      generationId: 'closure-unchanged',
      previousManifest: base.manifest,
      changedArtifacts: [{ logicalPath: '/data/ranking-summary.json', value: nextRoot('closure-unchanged') }],
      expectedLogicalPaths: basePaths,
    })
    const bodyReads = client.getKeys.slice(getsBefore)
    assert.equal(new Set(bodyReads).size, bodyReads.length, 'closure reads no retained body twice')
    assert.deepEqual(client.putKeys.slice(putsBefore), ['rankings/generations/closure-unchanged/manifest.json'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('local materialization rejects removing a referenced match page and keeps the old root', async () => {
  const { dir, runId, nextRoot } = await closureFixture()
  try {
    const base = await uploadContentAddressedPublicArtifacts(memoryS3(), config, dir, runId)
    const basePaths = Object.keys(record(base.manifest.artifacts))
    await assert.rejects(materializePublicArtifactPatch(dir, {
      previousManifest: base.manifest,
      changedArtifacts: [{ logicalPath: '/data/ranking-summary.json', value: nextRoot('closure-local') }],
      removedLogicalPaths: [closurePage],
      expectedLogicalPaths: basePaths.filter((path) => path !== closurePage),
    }), missingClosurePage)
    assert.ok(JSON.parse(await readFile(join(dir, closurePage.slice('/data/'.length)), 'utf8')))
    assert.equal(JSON.parse(await readFile(join(dir, 'ranking-summary.json'), 'utf8')).artifactMeta.runId, runId)
    const unchanged = await materializePublicArtifactPatch(dir, {
      previousManifest: base.manifest,
      changedArtifacts: [{ logicalPath: '/data/ranking-summary.json', value: nextRoot('closure-local-unchanged') }],
      expectedLogicalPaths: basePaths,
    })
    assert.deepEqual(Object.keys(unchanged.mapping).sort(), basePaths.toSorted())
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

async function closureFixture() {
  const plan = createPublicArtifactWritePlan(createStaticRankingData({
    matches: [{
      id: 'closure', sourceProvider: 'oracles-elixir', date: '2026-01-01', datetimeUtc: '2026-01-01T12:00:00.000Z', season: 2026,
      event: 'LCK 2026', phase: 'Regular season', region: 'LCK', league: 'LCK', patch: '26.1', bestOf: 1, tier: 'regional-regular',
      teamA: 'Alpha', teamB: 'Beta', winner: 'Alpha', teamAKills: 15, teamBKills: 9, teamAGold: 60_000, teamBGold: 55_000,
    }],
    teams: { Alpha: { name: 'Alpha', code: 'ALP', league: 'LCK', region: 'LCK' }, Beta: { name: 'Beta', code: 'BET', league: 'LCK', region: 'LCK' } },
    rosters: {}, generatedAt: '2026-01-02T00:00:00.000Z', dataMode: 'scheduled-public-data', source: 'Reference closure fixture',
  }))
  const valueAt = (logicalPath: string) => plan.writes.find((write) => `/data/${write.relativePath}` === logicalPath)?.value
  assert.ok(valueAt(closurePage))
  const dir = await mkdtemp(join(tmpdir(), 'ranking-reference-closure-'))
  for (const write of plan.writes) {
    await mkdir(dirname(join(dir, write.relativePath)), { recursive: true })
    await writeFile(join(dir, write.relativePath), write.contents)
  }
  const nextRoot = (runId: string) => ({ ...plan.manifest, artifactMeta: { ...record(plan.manifest.artifactMeta), runId } })
  return { dir, valueAt, nextRoot, runId: String(record(plan.manifest.artifactMeta).runId) }
}

function root(runId: string) {
  return {
    artifactKind: 'public-ranking-manifest', schemaVersion: 23, generatedAt: '2026-07-22T00:00:00.000Z',
    source: 'fixture', dataMode: 'test', sources: [{ name: 'fixture' }],
    model: { version: 'model-v1', configHash: 'config-v1' }, artifactMeta: { runId },
  }
}

type Stored = { bytes: Buffer; etag: string; contentType?: string; contentEncoding?: string; cacheControl?: string; metadata: Record<string, string> }
function memoryS3() {
  const objects = new Map<string, Stored>()
  const putKeys: string[] = []
  const getKeys: string[] = []
  let version = 0
  return {
    objects, putKeys, getKeys,
    async send(command: unknown) {
      const details = command as { constructor: { name: string }; input: Record<string, unknown> }
      const name = details.constructor.name
      const input = details.input
      const key = String(input.Key)
      if (name === 'HeadObjectCommand' || name === 'GetObjectCommand') {
        if (name === 'GetObjectCommand') getKeys.push(key)
        const stored = objects.get(key)
        if (!stored) throw Object.assign(new Error('missing'), { name: name === 'HeadObjectCommand' ? 'NotFound' : 'NoSuchKey' })
        return {
          Body: Readable.from([stored.bytes]), ETag: stored.etag, ContentLength: stored.bytes.byteLength,
          ContentType: stored.contentType, ContentEncoding: stored.contentEncoding,
          CacheControl: stored.cacheControl, Metadata: stored.metadata,
        }
      }
      if (name === 'PutObjectCommand') {
        if (input.IfNoneMatch === '*' && objects.has(key)) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
        const bytes = await bodyBytes(input.Body)
        const etag = `"${++version}"`
        const metadata = isStringRecord(input.Metadata) ? input.Metadata : {}
        objects.set(key, {
          bytes, etag, contentType: stringValue(input.ContentType), contentEncoding: stringValue(input.ContentEncoding),
          cacheControl: stringValue(input.CacheControl), metadata,
        })
        putKeys.push(key)
        return { ETag: etag }
      }
      throw new Error(`unsupported ${name}`)
    },
  }
}
async function bodyBytes(value: unknown) {
  if (typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value)
  const chunks: Buffer[] = []
  for await (const chunk of value as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === 'string'))
}
function stringValue(value: unknown) { return typeof value === 'string' ? value : undefined }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected record')
  return value as Record<string, unknown>
}
