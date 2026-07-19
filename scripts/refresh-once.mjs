import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  acquireBucketLease,
  bucketConfigFromEnv,
  createBucketClient,
  readBucketJson,
  releaseBucketLease,
  writeBucketJson,
} from './railway-bucket.mjs'
import { fetchScheduleProbe } from './lolesports-schedule-probe.mjs'
import {
  acknowledgeMatches,
  applyProbeFailure,
  applyScheduleProbe,
  duePendingMatchIds,
  emptyTriggerState,
  parseTriggerState,
  recordPendingAttempt,
  shouldFetchScoredProviders,
} from './refresh-trigger-state.mjs'

const mode = refreshMode(process.env.RANKING_REFRESH_MODE)
const statePath = resolve(process.env.RANKING_TRIGGER_STATE ?? 'data/raw/refresh-trigger-state.json')
const reconciliationPath = resolve(process.env.RANKING_RECONCILIATION_OUTPUT ?? 'data/raw/reconciliation.json')
const stateKey = process.env.RANKING_TRIGGER_STATE_KEY ?? 'raw/refresh-trigger-state.json'
const leaseKey = process.env.RANKING_REFRESH_LEASE_KEY ?? 'ops/refresh-lease.json'
const owner = `${process.env.RAILWAY_DEPLOYMENT_ID ?? 'local'}:${process.pid}:${randomUUID()}`
const bucketConfig = bucketConfigFromEnv()
const bucketClient = createBucketClient(bucketConfig)

if (mode === 'legacy') {
  await runRefreshChild()
  process.exit(0)
}

if (!bucketConfig.enabled || !bucketClient) {
  throw new Error(`Bucket configuration is required in ${mode} mode: ${(bucketConfig.missing ?? []).join(', ')}`)
}

const lease = await acquireBucketLease(leaseKey, {
  owner,
  ttlMs: numberEnv('RANKING_REFRESH_LEASE_TTL_MS', 45 * 60_000),
  config: bucketConfig,
  client: bucketClient,
})
if (!lease.acquired) {
  console.log(`Refresh skipped: ${lease.reason}`)
  process.exit(0)
}

const remoteState = await readBucketJson(stateKey, { config: bucketConfig, client: bucketClient })
let state = parseTriggerState(remoteState.found ? remoteState.value : await readLocalState(), { mode })
state.mode = mode
state.fencingToken = lease.lease.fencingToken
let stateEtag = remoteState.etag

try {
  try {
    const probe = await fetchScheduleProbe({
      watermark: state.observationWatermark,
      recoveryHours: numberEnv('RANKING_SCHEDULE_RECOVERY_HOURS', 48),
      maxOlderPages: numberEnv('RANKING_SCHEDULE_MAX_OLDER_PAGES', 16),
      requestTimeoutMs: numberEnv('RANKING_SCHEDULE_REQUEST_TIMEOUT_MS', 15_000),
    })
    state = applyScheduleProbe(state, { ...probe, mode })
    state.fencingToken = lease.lease.fencingToken
    stateEtag = await persistState(state, stateEtag)
  } catch (error) {
    state = applyProbeFailure(state, { checkedAt: new Date(), reason: errorMessage(error) })
    state.fencingToken = lease.lease.fencingToken
    await persistState(state, stateEtag)
    await sendAlert('schedule-probe-failed', errorMessage(error))
    throw error
  }

  const correctionAuditDue = auditDue(state, new Date())
  if (!shouldFetchScoredProviders(state, { correctionAuditDue })) {
    console.log(`Refresh probe complete: mode=${mode} pending=${Object.keys(state.pending).length}; scored providers skipped`)
  } else {
    const dueMatchIds = duePendingMatchIds(state)
    try {
      await runRefreshChild(lease)
      state = recordPendingAttempt(state, dueMatchIds, { attemptedAt: new Date() })
      const ledger = await readJson(reconciliationPath)
      state = acknowledgeMatches(state, ledger?.matches ?? [])
      if (correctionAuditDue) state.lastCorrectionAuditAt = new Date().toISOString()
      state.fencingToken = lease.lease.fencingToken
      await persistState(state, stateEtag)
      console.log(`Refresh ingestion complete: attempted=${dueMatchIds.length} remaining=${Object.keys(state.pending).length}`)
      await alertIfPendingIsOld(state)
    } catch (error) {
      state = recordPendingAttempt(state, dueMatchIds, { attemptedAt: new Date(), reason: errorMessage(error) })
      state.fencingToken = lease.lease.fencingToken
      await persistState(state, stateEtag)
      await sendAlert('refresh-ingestion-failed', errorMessage(error))
      throw error
    }
  }
} finally {
  const released = await releaseBucketLease(leaseKey, lease, { config: bucketConfig, client: bucketClient })
  if (!released.released) console.warn(`Refresh lease release skipped: ${released.reason}`)
}

async function persistState(nextState, etag) {
  await writeLocalState(nextState)
  const result = await writeBucketJson(stateKey, nextState, {
    config: bucketConfig,
    client: bucketClient,
    ...(etag ? { ifMatch: etag } : { ifNoneMatch: '*' }),
  })
  if (!result.written) throw new Error(result.conflict ? 'Trigger state changed concurrently' : 'Unable to persist trigger state')
  return result.etag
}

async function runRefreshChild(refreshLease) {
  await run(process.execPath, ['scripts/refresh-data-if-changed.mjs'], numberEnv('RANKING_REFRESH_JOB_TIMEOUT_MS', 30 * 60_000), refreshLease)
}

async function run(command, args, timeoutMs, refreshLease) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        RANKING_RECONCILIATION_OUTPUT: reconciliationPath,
        ...(refreshLease?.lease ? {
          RANKING_REFRESH_FENCING_TOKEN: String(refreshLease.lease.fencingToken),
          RANKING_REFRESH_LEASE_KEY: leaseKey,
          RANKING_REFRESH_LEASE_OWNER: refreshLease.lease.owner,
          RANKING_REFRESH_LEASE_ETAG: refreshLease.etag,
          RANKING_REFRESH_LEASE_EXPIRES_AT: refreshLease.lease.expiresAt,
        } : {}),
      },
      stdio: 'inherit',
    })
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      rejectRun(new Error(`Refresh job exceeded ${timeoutMs}ms`))
    }, timeoutMs)
    timeout.unref()
    child.on('error', (error) => {
      clearTimeout(timeout)
      rejectRun(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0) resolveRun()
      else rejectRun(new Error(`Refresh job exited with ${code ?? signal}`))
    })
  })
}

async function readLocalState() {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'))
  } catch {
    return emptyTriggerState(mode)
  }
}

async function writeLocalState(value) {
  await mkdir(dirname(statePath), { recursive: true })
  const temporaryPath = `${statePath}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporaryPath, statePath)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function auditDue(value, now) {
  if (process.env.RANKING_CORRECTION_AUDIT_ENABLED !== 'true') return false
  const intervalMs = numberEnv('RANKING_CORRECTION_AUDIT_INTERVAL_MS', 24 * 60 * 60_000)
  return now.getTime() - new Date(value.lastCorrectionAuditAt ?? 0).getTime() >= intervalMs
}

function refreshMode(value) {
  return value === 'shadow' || value === 'gated' ? value : 'legacy'
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function alertIfPendingIsOld(value) {
  const oldest = Object.values(value.pending ?? {}).map((entry) => new Date(entry.detectedAt).getTime()).filter(Number.isFinite).sort()[0]
  if (!oldest || Date.now() - oldest < numberEnv('RANKING_PENDING_ALERT_AGE_MS', 48 * 60 * 60_000)) return
  await sendAlert('pending-match-overdue', `${Object.keys(value.pending).length} match(es) remain unresolved`)
}

async function sendAlert(kind, message) {
  const url = process.env.RANKING_ALERT_WEBHOOK_URL
  if (!url) {
    console.warn(`Alert ${kind}: ${message}`)
    return
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, message, service: 'lol-esports-ranking', at: new Date().toISOString() }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) console.error(`Alert webhook failed with ${response.status}`)
  } catch (error) {
    console.error(`Alert webhook failed: ${errorMessage(error)}`)
  }
}
