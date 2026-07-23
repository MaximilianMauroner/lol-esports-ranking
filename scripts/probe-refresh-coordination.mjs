import { bucketConfigFromEnv, createBucketClient, readBucketJson, writeBucketJson } from './railway-bucket.mjs'

export function rolloutProbeKey(probeId) {
  if (typeof probeId !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(probeId)) throw new Error('Invalid rollout probe id')
  return `ops/rollout-probes/${probeId}.json`
}

export async function acquireProbeCoordination(probeId, {
  owner,
  ttlMs = 60_000,
  now = new Date(),
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
  readJson = readBucketJson,
  writeJson = writeBucketJson,
} = {}) {
  assertOwner(owner)
  const key = rolloutProbeKey(probeId)
  const current = await readJson(key, { config, client })
  const nowMs = new Date(now).getTime()
  if (current.found && current.value?.status === 'active' && Date.parse(current.value.expiresAt) > nowMs) {
    return { acquired: false, reason: 'active-probe', key, authority: current.value }
  }
  const fencingToken = Math.max(0, Number(current.value?.fencingToken) || 0) + 1
  const authority = {
    artifactKind: 'ranking-rollout-probe-coordination',
    schemaVersion: 1,
    probeId,
    owner,
    fencingToken,
    status: 'active',
    acquiredAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
  }
  const write = await writeJson(key, authority, {
    config,
    client,
    ...(current.found ? { ifMatch: current.etag } : { ifNoneMatch: '*' }),
  })
  return write.written
    ? { acquired: true, key, authority, etag: write.etag }
    : { acquired: false, reason: write.conflict ? 'probe-race' : 'bucket-unavailable', key }
}

export function createProbeCoordinationEvidence(input = {}) {
  const observations = input.observations ?? {}
  const tokens = Array.isArray(observations.fencingTokens) ? observations.fencingTokens.map(Number) : []
  return parseProbeCoordinationEvidence({
    artifactKind: 'ranking-rollout-probe-coordination-evidence',
    schemaVersion: 1,
    evidenceClass: input.evidenceClass,
    commit: input.commit,
    deploymentId: input.deploymentId,
    runId: input.runId,
    recordedAt: input.recordedAt,
    expiresAt: input.expiresAt,
    status: input.status ?? 'completed',
    checks: {
      acquire: observations.acquire?.acquired === true,
      exclusion: observations.exclusion?.reason === 'active-probe',
      renew: observations.renew?.renewed === true,
      takeover: observations.takeover?.acquired === true,
      staleRejected: ['stale-probe', 'fencing-token-changed'].includes(observations.staleAttempt?.reason),
      release: observations.release?.released === true,
      concurrentWinners: Array.isArray(observations.concurrentResults)
        ? observations.concurrentResults.filter((entry) => entry?.acquired === true).length
        : 0,
    },
    lease: {
      monotonic: tokens.length >= 2 && tokens.every((token, index) => index === 0 || token > tokens[index - 1]),
      staleRejected: ['stale-probe', 'fencing-token-changed'].includes(observations.staleAttempt?.reason),
    },
  })
}

export function parseProbeCoordinationEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.artifactKind !== 'ranking-rollout-probe-coordination-evidence'
    || value.schemaVersion !== 1) throw new Error('Invalid rollout probe coordination evidence')
  assertExactKeys(value, ['artifactKind', 'schemaVersion', 'evidenceClass', 'commit', 'deploymentId', 'runId', 'recordedAt', 'expiresAt', 'status', 'checks', 'lease'], 'probe evidence')
  for (const field of ['evidenceClass', 'commit', 'deploymentId', 'runId', 'recordedAt', 'expiresAt', 'status']) {
    if (typeof value[field] !== 'string' || value[field].length === 0) throw new Error(`Probe evidence ${field} is required`)
  }
  if (!['live', 'production-like-fixture'].includes(value.evidenceClass) || value.status !== 'completed') throw new Error('Probe evidence identity is invalid')
  if (!Number.isFinite(Date.parse(value.recordedAt)) || !Number.isFinite(Date.parse(value.expiresAt))
    || Date.parse(value.expiresAt) <= Date.parse(value.recordedAt)) throw new Error('Probe evidence dates are invalid')
  const booleanChecks = ['acquire', 'exclusion', 'renew', 'takeover', 'staleRejected', 'release']
  assertExactKeys(value.checks, [...booleanChecks, 'concurrentWinners'], 'probe evidence checks')
  if (!value.checks || booleanChecks.some((field) => value.checks[field] !== true)
    || value.checks.concurrentWinners !== 1) throw new Error('Probe evidence checks are incomplete')
  assertExactKeys(value.lease, ['monotonic', 'staleRejected'], 'probe evidence lease')
  if (!value.lease || value.lease.monotonic !== true || value.lease.staleRejected !== true) {
    throw new Error('Probe evidence lease checks are incomplete')
  }
  return value
}

export async function renewProbeCoordination(probeId, authority, options = {}) {
  const validated = await currentProbeAuthority(probeId, authority, options)
  if (!validated.live) return { renewed: false, reason: validated.reason, key: validated.key }
  const nowMs = new Date(options.now ?? new Date()).getTime()
  const value = {
    ...validated.value,
    renewedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + (options.ttlMs ?? 60_000)).toISOString(),
  }
  const write = await (options.writeJson ?? writeBucketJson)(validated.key, value, {
    config: options.config ?? bucketConfigFromEnv(),
    client: options.client ?? createBucketClient(options.config ?? bucketConfigFromEnv()),
    ifMatch: validated.etag,
  })
  return write.written
    ? { renewed: true, key: validated.key, authority: value, etag: write.etag }
    : { renewed: false, reason: write.conflict ? 'stale-probe' : 'bucket-unavailable', key: validated.key }
}

export async function releaseProbeCoordination(probeId, authority, options = {}) {
  const validated = await currentProbeAuthority(probeId, authority, options)
  if (!validated.live) return { released: false, reason: validated.reason, key: validated.key }
  const releasedAt = new Date(options.now ?? new Date()).toISOString()
  const value = { ...validated.value, status: 'released', releasedAt, expiresAt: releasedAt }
  const write = await (options.writeJson ?? writeBucketJson)(validated.key, value, {
    config: options.config ?? bucketConfigFromEnv(),
    client: options.client ?? createBucketClient(options.config ?? bucketConfigFromEnv()),
    ifMatch: validated.etag,
  })
  return write.written
    ? { released: true, key: validated.key, authority: value, etag: write.etag }
    : { released: false, reason: write.conflict ? 'stale-probe' : 'bucket-unavailable', key: validated.key }
}

export async function assertProbeCoordination(probeId, authority, options = {}) {
  const result = await currentProbeAuthority(probeId, authority, options)
  if (!result.live) throw new Error(`Rollout probe coordination is not authoritative: ${result.reason}`)
  return result
}

async function currentProbeAuthority(probeId, authority, {
  now = new Date(),
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
  readJson = readBucketJson,
} = {}) {
  const key = rolloutProbeKey(probeId)
  const current = await readJson(key, { config, client })
  const reason = !authority?.authority || !authority?.etag
    ? 'invalid-probe-authority'
    : !current.found
      ? 'probe-missing'
      : current.etag !== authority.etag
        ? 'stale-probe'
        : current.value?.owner !== authority.authority.owner
          ? 'owner-changed'
          : Number(current.value?.fencingToken) !== Number(authority.authority.fencingToken)
            ? 'fencing-token-changed'
            : current.value?.status !== 'active'
              ? 'probe-released'
              : Date.parse(current.value.expiresAt) <= new Date(now).getTime()
                ? 'probe-expired'
                : undefined
  return reason ? { live: false, reason, key } : { live: true, key, value: current.value, etag: current.etag }
}

function assertOwner(owner) {
  if (typeof owner !== 'string' || owner.trim() === '') throw new Error('Rollout probe coordination requires an owner')
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid ${label} fields`)
  }
}
