import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { isTournamentFeed, type TournamentFeed } from '../src/lib/tournamentFeed'
import { canonicalJsonFor } from './public-artifact-storage.mjs'
import { assertBucketLease, readBucketJson, writeBucketJson, type BucketClient, type BucketConfig, type BucketLeaseAuthority } from './railway-bucket.mjs'

export const TOURNAMENT_BUCKET_PREFIX = 'tournaments'
export const TOURNAMENT_LEASE_KEY = 'ops/collector-lease.json'
const JSON_TYPE = 'application/json; charset=utf-8'

/** Isolated publisher only. No collector, timer, serving route or production flag calls it. */
export async function publishTournamentFeedBucket(input: {
  feed: TournamentFeed
  config: BucketConfig
  client: BucketClient
  authority: BucketLeaseAuthority
  now?: () => Date
  beforePromotion?: () => Promise<void>
}) {
  const { feed, config, client, authority } = input
  const now = input.now ?? (() => new Date())
  requireNamespace(config)
  if (!isTournamentFeed(feed)) throw new Error('Invalid tournament feed')
  if (!feed.coverage.complete) return { published: false, reason: 'incomplete-coverage' as const }
  if (Date.parse(feed.fetchedAt) > now().getTime()) throw new Error('Tournament observation is in the future')
  if (!authority.etag || authority.etag !== authority.promotionEtag) throw new Error('Missing tournament promotion authority')
  const current = await readBucketJson('active-generation.json', { config, client })
  const live = await assertBucketLease(TOURNAMENT_LEASE_KEY, authority, { config, client, now: now() })
  if (!live.live || current.etag !== authority.etag) throw new Error('Tournament authority changed')
  const prior = current.value ?? {}
  if (typeof prior.checkedAt === 'string' && Date.parse(feed.fetchedAt) <= Date.parse(prior.checkedAt)) {
    return { published: false, reason: 'older-observation' as const }
  }
  // A successful unchanged poll updates pointer health, without a new public object.
  const content = canonicalJsonFor({ ...feed, fetchedAt: '' })
  const stateDigest = digest(Buffer.from(content))
  let objectKey = prior.feedKey
  let sha256 = prior.feedDigest
  let bytes = prior.feedBytes
  const changed = prior.stateDigest !== stateDigest
  if (changed) {
    const body = Buffer.from(canonicalJsonFor(feed) + '\n')
    sha256 = digest(body)
    bytes = body.length
    objectKey = `feed/objects/sha256/${sha256}`
    try {
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: `${config.prefix}/${objectKey}`,
        Body: body, ContentType: JSON_TYPE, Metadata: { sha256, bytes: String(bytes) }, IfNoneMatch: '*' }))
    } catch (error) {
      if (!isConflict(error)) throw error
    }
  }
  if (typeof objectKey !== 'string' || typeof sha256 !== 'string' || typeof bytes !== 'number') throw new Error('Missing tournament object authority')
  await verifyFeedObject(client, config, { key: objectKey, sha256, bytes })
  await input.beforePromotion?.()
  // Recheck the object after preparation, then CAS the same pointer that owns the lease.
  await verifyFeedObject(client, config, { key: objectKey, sha256, bytes })
  await assertBucketLease(TOURNAMENT_LEASE_KEY, authority, { config, client, now: now() })
  const result = await writeBucketJson('active-generation.json', {
    ...prior, schemaVersion: 1, kind: 'tournament-feed', stateDigest,
    feedKey: objectKey, feedDigest: sha256, feedBytes: bytes, checkedAt: feed.fetchedAt,
    ...(changed ? { publishedAt: now().toISOString() } : {}),
    fencingToken: authority.lease.fencingToken,
  }, { config, client, ifMatch: authority.promotionEtag })
  if (!result.written || !result.etag) throw new Error('Tournament authority changed during promotion')
  return { published: changed, reason: changed ? 'changed' as const : 'unchanged' as const,
    authority: { ...authority, etag: result.etag, promotionEtag: result.etag }, key: objectKey, sha256, bytes }
}

/** An active pointer is usable only if its immutable body and final ETag still agree. */
export async function readTournamentFeedBucket(config: BucketConfig, client: BucketClient) {
  requireNamespace(config)
  const active = await readBucketJson('active-generation.json', { config, client })
  if (!active.found || active.value?.kind !== 'tournament-feed') return null
  const { feedKey: key, feedDigest: sha256, feedBytes: bytes, checkedAt } = active.value
  if (typeof key !== 'string' || typeof sha256 !== 'string' || typeof bytes !== 'number'
    || typeof checkedAt !== 'string' || !Number.isFinite(Date.parse(checkedAt))) throw new Error('Invalid tournament pointer')
  const feed = await verifyFeedObject(client, config, { key, sha256, bytes })
  const final = await readBucketJson('active-generation.json', { config, client })
  if (final.etag !== active.etag) throw new Error('Tournament pointer changed while reading')
  return { feed, checkedAt, etag: active.etag }
}

async function verifyFeedObject(client: BucketClient, config: BucketConfig, identity: { key: string; sha256: string; bytes: number }) {
  if (!/^[a-f0-9]{64}$/.test(identity.sha256) || identity.key !== `feed/objects/sha256/${identity.sha256}`
    || !Number.isSafeInteger(identity.bytes) || identity.bytes <= 0) throw new Error('Invalid tournament object identity')
  const value = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: `${config.prefix}/${identity.key}` }))
  if (!isRecord(value) || value.ContentType !== JSON_TYPE || value.ContentEncoding !== undefined
    || !isRecord(value.Metadata) || value.Metadata.sha256 !== identity.sha256 || value.Metadata.bytes !== String(identity.bytes)) {
    throw new Error('Tournament object metadata mismatch')
  }
  const body = await objectBytes(value.Body)
  if (body.length !== identity.bytes || value.ContentLength !== identity.bytes || digest(body) !== identity.sha256) throw new Error('Tournament object digest mismatch')
  const feed: unknown = JSON.parse(body.toString('utf8'))
  if (!isTournamentFeed(feed) || !feed.coverage.complete || canonicalJsonFor(feed) + '\n' !== body.toString('utf8')) throw new Error('Invalid stored tournament feed')
  return feed
}

function requireNamespace(config: BucketConfig) {
  if (!config.enabled || config.prefix !== TOURNAMENT_BUCKET_PREFIX) throw new Error('Tournament storage requires the separate tournaments prefix')
}
function digest(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex') }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function isConflict(error: unknown) { return isRecord(error) && (error.name === 'PreconditionFailed' || isRecord(error.$metadata) && error.$metadata.httpStatusCode === 412) }
async function objectBytes(value: unknown) {
  if (Buffer.isBuffer(value)) return value
  if (!(value instanceof Readable)) throw new Error('Tournament object body is unavailable')
  const chunks: Buffer[] = []
  for await (const chunk of value) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
