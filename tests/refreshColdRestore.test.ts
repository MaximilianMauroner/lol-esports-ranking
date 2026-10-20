import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test, { after, before, mock } from 'node:test'
import { acquireBucketLease, readActiveContentAddressedGeneration, readActiveRawSourceAuthority } from '../scripts/railway-bucket.mjs'

const refreshScript: string = '../scripts/refresh-data-if-changed.mjs'
const { refreshDataIfChanged } = await import(refreshScript)
const config = {
  enabled: true, bucket: 'fixture', prefix: 'rankings', region: 'auto',
  endpoint: 'https://fixture.invalid', accessKeyId: 'fixture', secretAccessKey: 'fixture',
}
const earlierClient = memoryS3()
const seedClient = memoryS3()
let root: string
let publishedFingerprint: string

before(async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 5, 29) })
  root = await mkdtemp(join(tmpdir(), 'refresh-cold-restore-'))
  assert.equal((await refresh(join(root, 'seed-first'), earlierClient, 1)).incrementalAction, 'publish-full')
  const second = await refresh(join(root, 'seed-second'), seedClient, 2)
  assert.equal(second.incrementalAction, 'publish-full')
  publishedFingerprint = JSON.parse(seedClient.objects.get('rankings/raw/refresh-state.json')!.bytes.toString()).publishedFingerprint
  assert.ok(publishedFingerprint)
})

after(async () => {
  mock.timers.reset()
  if (root) await rm(root, { recursive: true, force: true })
})

for (const force of [true, false]) {
  test(`cold refresh replays one append from a published remote generation with force=${force}`, async () => {
    const client = memoryS3(seedClient.objects)
    const directory = join(root, `cold-${force}`)
    const result = await refresh(directory, client, 3, force)
    assert.equal(result.incrementalAction, 'publish-incremental')
    assert.equal(result.incrementalMetrics.classification, 'latest-append')
    assert.equal(result.incrementalMetrics.replayedMatchCount, 1)
    assert.equal(result.incrementalMetrics.fullSnapshotWritten, false)
    const state = JSON.parse(await readFile(join(directory, 'raw/refresh-state.json'), 'utf8'))
    assert.equal(state.restoredRaw.restored, true)
    assert.equal(state.lastRun.stages.find((stage: { name: string }) => stage.name === 'checkpoint-restore').result, 'completed')
    const active = await readActiveContentAddressedGeneration({ config, client })
    assert.ok(active.found)
    assert.equal(active.active.publicationSchemaVersion, 1)
    assert.equal(active.manifest.generationId, result.generationId)
    assert.equal(state.publishedFingerprint, state.fingerprint)
    assert.equal(state.pendingPublication, undefined)

    const restart = await refresh(join(root, `restart-${force}`), client, 4, force)
    assert.equal(restart.incrementalAction, 'publish-incremental')
    assert.equal(restart.incrementalMetrics.addedCount, 1)
    assert.equal(restart.incrementalMetrics.fullSnapshotWritten, false)
  })
}

for (const localState of ['legacy', 'corrupt', 'unreadable', 'pending local', 'pending bucket'] as const) {
  test(`verified remote restore does not bypass existing ${localState} state`, async () => {
    const directory = join(root, localState.replaceAll(' ', '-'))
    const rawDir = join(directory, 'raw')
    const statePath = join(rawDir, 'refresh-state.json')
    await mkdir(rawDir, { recursive: true })
    if (localState === 'unreadable') {
      await symlink(join(directory, 'missing-state.json'), statePath)
      await assert.rejects(readFile(statePath), { code: 'ENOENT' })
    } else {
      await writeFile(statePath, localState === 'corrupt' ? '{' : JSON.stringify({
        schemaVersion: 1,
        ...(localState.startsWith('pending') ? {
          publishedFingerprint,
          pendingPublication: localState === 'pending bucket' ? 'bucket' : 'local',
        } : {}),
      }))
    }
    const result = await refresh(directory, memoryS3(seedClient.objects), 3)
    assert.equal(result.incrementalAction, 'publish-full')
    assert.equal(result.incrementalMetrics.fullSnapshotWritten, true)
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    assert.equal(state.restoredRaw.restored, true)
  })
}

test('cold refresh without active remote authority takes a full build', async () => {
  const client = memoryS3(seedClient.objects)
  client.objects.delete('rankings/active-generation.json')
  const result = await refresh(join(root, 'absent-authority'), client, 3)
  assert.equal(result.incrementalAction, 'publish-full')
  assert.equal(result.incrementalMetrics.fullSnapshotWritten, true)
})

test('cold refresh rejects damaged remote closure before promotion', async () => {
  const client = memoryS3(seedClient.objects)
  const pointer = JSON.parse(client.objects.get('rankings/active-generation.json')!.bytes.toString())
  client.objects.delete(pointer.stateManifestKey)
  await assert.rejects(refresh(join(root, 'damaged-authority'), client, 3), /missing/)
  assert.equal(JSON.parse(client.objects.get('rankings/active-generation.json')!.bytes.toString()).generationId, pointer.generationId)
})

test('cold refresh cannot replay from a different verified raw generation', async () => {
  const client = memoryS3(seedClient.objects)
  const earlierRaw = await readActiveRawSourceAuthority({ config, client: earlierClient })
  assert.ok(earlierRaw.found)
  let rawReads = 0
  const result = await refresh(join(root, 'mismatched-authority'), client, 3, true, {
    readActiveRawSourceAuthority: () => ++rawReads === 1
      ? Promise.resolve(earlierRaw)
      : readActiveRawSourceAuthority({ config, client }),
  })
  assert.equal(result.incrementalAction, 'publish-full')
  assert.equal(result.incrementalMetrics.fullSnapshotWritten, true)
})

async function refresh(directory: string, client: ReturnType<typeof memoryS3>, matchCount: number, force = true,
  options: Record<string, unknown> = {}) {
  mock.timers.tick(1000)
  const lease = await acquireBucketLease('ops/refresh-lease.json', { owner: 'fixture', config, client })
  assert.ok(lease.acquired)
  const rawDir = join(directory, 'raw')
  return refreshDataIfChanged([
    '--raw-dir', rawDir, '--manifest', join(rawDir, 'manifest.json'), '--state', join(rawDir, 'refresh-state.json'),
    '--staging-dir', join(directory, 'staging'), '--output', join(directory, 'full.json'),
    '--public-data-dir', join(directory, 'public'), '--start', '2026-01-01', '--end', '2026-06-29',
    ...(force ? ['--force'] : []),
  ], {
    env: {
      RANKING_REFRESH_MODE: 'gated', RANKING_REFRESH_CAUSE: 'pending-match', RANKING_RAW_SOURCE_WORKER: 'node',
      RANKING_BUCKET_RESTORE_RAW: 'true', RANKING_BUCKET_UPLOAD_ENABLED: 'true',
      RANKING_REFRESH_LEASE_OWNER: lease.lease.owner,
      RANKING_REFRESH_FENCING_TOKEN: String(lease.lease.fencingToken),
      RANKING_REFRESH_PROMOTION_ETAG: lease.promotionEtag,
    },
    bucketConfig: config,
    bucketClient: client,
    run: async (_command: string, args: string[]) => {
      assert.ok(args.includes('scripts/download-local-data.mjs'))
      const stagingDir = argument(args, '--out-dir')
      const csvPath = join(stagingDir, '2026.csv')
      const rows = ['gameid,date,year,league,split,playoffs,patch,position,side,teamname,result,kills,totalgold']
      for (let index = 1; index <= matchCount; index += 1) {
        rows.push(`fixture-${index},2026-06-${25 + index},2026,LCK,Summer,0,26.13,team,Blue,Gen.G,1,18,65000`)
        rows.push(`fixture-${index},2026-06-${25 + index},2026,LCK,Summer,0,26.13,team,Red,T1,0,10,58000`)
      }
      await writeFile(csvPath, `${rows.join('\n')}\n`)
      await writeFile(argument(args, '--manifest'), JSON.stringify({
        schemaVersion: 1, start: '2026-01-01', end: '2026-06-29', generatedAt: '2026-06-29T00:00:00.000Z',
        files: { oracleCsv: [csvPath], leaguepediaJson: [], lolEsportsJson: [] },
        sources: { oracle: { status: 'downloaded', downloadedCount: 1 } }, warnings: [],
      }))
    },
    ...options,
  })
}

function argument(args: string[], flag: string) {
  const index = args.indexOf(flag)
  assert.notEqual(index, -1)
  return args[index + 1]
}

type StoredObject = {
  bytes: Buffer
  etag: string
  contentType?: string
  contentEncoding?: string
  cacheControl?: string
  metadata?: Record<string, string>
}

function memoryS3(initial?: Map<string, StoredObject>) {
  const objects = new Map(initial)
  let version = objects.size
  return {
    objects,
    async send(command: unknown) {
      const { constructor: { name }, input } = command as { constructor: { name: string }; input: Record<string, unknown> }
      const key = String(input.Key)
      const stored = objects.get(key)
      if (name === 'GetObjectCommand' || name === 'HeadObjectCommand') {
        if (!stored) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
        return {
          ...(name === 'GetObjectCommand' ? { Body: Readable.from([stored.bytes]) } : {}),
          ETag: stored.etag, ContentLength: stored.bytes.byteLength, ContentType: stored.contentType,
          ContentEncoding: stored.contentEncoding, CacheControl: stored.cacheControl, Metadata: stored.metadata,
        }
      }
      assert.equal(name, 'PutObjectCommand')
      if (input.IfNoneMatch === '*' && stored || input.IfMatch && input.IfMatch !== stored?.etag) {
        throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
      }
      const bytes = await bodyBytes(input.Body)
      const etag = `"${++version}"`
      objects.set(key, {
        bytes, etag,
        contentType: input.ContentType as string | undefined,
        contentEncoding: input.ContentEncoding as string | undefined,
        cacheControl: input.CacheControl as string | undefined,
        metadata: input.Metadata as Record<string, string> | undefined,
      })
      return { ETag: etag }
    },
  }
}

async function bodyBytes(value: unknown) {
  if (typeof value === 'string' || value instanceof Uint8Array) return Buffer.from(value)
  const chunks: Buffer[] = []
  for await (const chunk of value as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
