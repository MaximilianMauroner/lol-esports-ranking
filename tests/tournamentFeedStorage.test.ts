import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { normalizeTournamentFeed } from '../src/lib/tournamentFeed'
import { acquireBucketLease } from '../scripts/railway-bucket.mjs'
import { publishTournamentFeedBucket, readTournamentFeedBucket, TOURNAMENT_LEASE_KEY } from '../scripts/tournament-feed-storage'

const config = { enabled: true as const, endpoint: 'http://example.invalid', bucket: 'isolated', region: 'auto',
  accessKeyId: 'fake', secretAccessKey: 'fake', prefix: 'tournaments' }
const start = new Date('2026-10-09T00:00:00.000Z')
function feed(fetchedAt = start.toISOString(), complete = true, state = 'unstarted') {
  return { ...normalizeTournamentFeed({ fetchedAt, coverageStart: '2026-10-01', coverageEnd: '2026-10-31', coverageComplete: complete,
    observations: [{ event: { league: { slug: 'worlds' }, startTime: '2026-10-10T00:00:00Z', state,
      match: { id: 'match-1', teams: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], strategy: { count: 3 } } },
    detail: { tournament: { id: 'source-tournament' } } }] }), dataMode: 'synthetic-fixture' as const }
}

test('durable feed preserves last good content and publishes corrections under a separate lease', async () => {
  const client = memoryBucket()
  const acquired = await acquireBucketLease(TOURNAMENT_LEASE_KEY, { config, client, owner: 'host-a', now: start, ttlMs: 60_000 })
  assert.equal(acquired.acquired, true)
  const published = await publishTournamentFeedBucket({ config, client, authority: acquired, feed: feed(), now: () => start })
  assert.equal(published.published, true)
  assert.ok(published.authority)
  assert.deepEqual((await readTournamentFeedBucket(config, client))?.feed, feed())
  const later = new Date(start.getTime() + 1_000)
  const unchanged = await publishTournamentFeedBucket({ config, client, authority: published.authority, feed: feed(later.toISOString()), now: () => later })
  assert.equal(unchanged.reason, 'unchanged')
  assert.ok(unchanged.authority)
  assert.equal(client.objects.size, 2, 'Unchanged input must not create another immutable feed')
  assert.equal((await readTournamentFeedBucket(config, client))?.checkedAt, later.toISOString())
  const pointerBefore = client.objects.get('tournaments/active-generation.json')?.body
  const partial = await publishTournamentFeedBucket({ config, client, authority: unchanged.authority, feed: feed(later.toISOString(), false) })
  assert.equal(partial.reason, 'incomplete-coverage')
  assert.equal(client.objects.get('tournaments/active-generation.json')?.body, pointerBefore)
  const old = await publishTournamentFeedBucket({ config, client, authority: unchanged.authority, feed: feed(), now: () => later })
  assert.equal(old.reason, 'older-observation')
  const next = new Date(start.getTime() + 2_000)
  const correction = await publishTournamentFeedBucket({ config, client, authority: unchanged.authority,
    feed: feed(next.toISOString(), true, 'inProgress'), now: () => next })
  assert.equal(correction.published, true)
  assert.equal((await readTournamentFeedBucket(config, client))?.feed.events[0]?.series[0]?.status, 'live')
  assert.ok([...client.objects.keys()].every((key) => key.startsWith('tournaments/')))
  await assert.rejects(publishTournamentFeedBucket({ config: { ...config, prefix: 'rankings' }, client, authority: acquired, feed: feed() }), /separate tournaments prefix/)
})

test('a second host fences a suspended publisher before and during final CAS', async () => {
  for (const phase of ['before-verification', 'during-cas'] as const) {
    const client = memoryBucket()
    const old = await acquireBucketLease(TOURNAMENT_LEASE_KEY, { config, client, owner: 'host-a', now: start, ttlMs: 1_000 })
    assert.equal(old.acquired, true)
    const later = new Date(start.getTime() + 2_000)
    let takeover: Awaited<ReturnType<typeof acquireBucketLease>> | undefined
    const replace = async () => { takeover = await acquireBucketLease(TOURNAMENT_LEASE_KEY, { config, client, owner: 'host-b', now: later }) }
    await assert.rejects(publishTournamentFeedBucket({ config, client, authority: old, feed: feed(), now: () => start,
      beforePromotion: async () => {
        if (phase === 'before-verification') await replace()
        else client.beforePointerPut = replace
      } }), /lease is no longer authoritative|authority changed/)
    assert.equal(takeover?.acquired, true)
    assert.equal(await readTournamentFeedBucket(config, client), null, 'Stale owner must not activate its object')
    assert.equal(JSON.parse(client.objects.get('tournaments/active-generation.json')!.body).leaseOwner, 'host-b')
  }
})

test('corrupt immutable content cannot become or remain an accepted feed', async () => {
  const client = memoryBucket()
  const lease = await acquireBucketLease(TOURNAMENT_LEASE_KEY, { config, client, owner: 'host-a', now: start })
  assert.equal(lease.acquired, true)
  const published = await publishTournamentFeedBucket({ config, client, authority: lease, feed: feed(), now: () => start })
  assert.ok(published.key)
  client.objects.get(`tournaments/${published.key}`)!.body = '{}'
  await assert.rejects(readTournamentFeedBucket(config, client), /digest mismatch/)
})

function memoryBucket() {
  const objects = new Map<string, { body: string; etag: string; contentType?: string; metadata?: Record<string, string> }>()
  let version = 0
  return { objects, beforePointerPut: undefined as (() => Promise<void>) | undefined,
    async send(command: unknown) {
      if (command instanceof GetObjectCommand) {
        const object = objects.get(command.input.Key!)
        if (!object) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
        return { Body: Readable.from([Buffer.from(object.body)]), ETag: object.etag, ContentType: object.contentType,
          ContentLength: Buffer.byteLength(object.body), Metadata: object.metadata }
      }
      if (!(command instanceof PutObjectCommand)) throw new Error('Unexpected storage operation')
      const input = command.input
      if (input.Key?.endsWith('/active-generation.json') && this.beforePointerPut) {
        const hook = this.beforePointerPut
        this.beforePointerPut = undefined
        await hook()
      }
      const prior = objects.get(input.Key!)
      if (input.IfNoneMatch && prior || input.IfMatch && input.IfMatch !== prior?.etag) throw Object.assign(new Error('conflict'), { name: 'PreconditionFailed' })
      const etag = `"${++version}"`
      objects.set(input.Key!, { body: Buffer.isBuffer(input.Body) ? input.Body.toString('utf8') : String(input.Body), etag,
        contentType: input.ContentType, metadata: input.Metadata })
      return { ETag: etag }
    },
  }
}
