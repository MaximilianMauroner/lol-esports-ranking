import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  acquireBucketLease,
  assertBucketLease,
  bucketConfigFromEnv,
  createBucketClient,
  readBucketJson,
  releaseBucketLease,
  renewBucketLease,
  writeBucketJson,
} from './railway-bucket.mjs'
import { fetchScheduleProbe } from './lolesports-schedule-probe.mjs'
import {
  acknowledgeMatches,
  applyProbeFailure,
  applyScheduleProbe,
  assertRefreshCadence,
  duePendingMatchIds,
  emptyTriggerState,
  parseTriggerState,
  recordPendingAttempt,
  refreshTriggerCause,
  shouldFetchScoredProviders,
} from './refresh-trigger-state.mjs'
import { completeRefreshMetrics, createRefreshMetrics, readRefreshMetrics, writeRefreshMetrics } from './refresh-metrics.mjs'

export async function runRefreshOnce(options = {}) {
  const env = options.env ?? process.env
  const now = options.now ?? (() => new Date())
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const rss = options.rss ?? (() => Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024))
  const logger = options.logger ?? console
  const mode = refreshMode(env.RANKING_REFRESH_MODE)
  const runId = options.runId ?? randomUUID()
  const statePath = resolve(env.RANKING_TRIGGER_STATE ?? 'data/raw/refresh-trigger-state.json')
  const reconciliationPath = resolve(env.RANKING_RECONCILIATION_OUTPUT ?? 'data/raw/reconciliation.json')
  const childMetricsPath = resolve(env.RANKING_REFRESH_METRICS_PATH ?? `data/.refresh-metrics-${runId}.json`)
  const stateKey = env.RANKING_TRIGGER_STATE_KEY ?? 'raw/refresh-trigger-state.json'
  const leaseKey = env.RANKING_REFRESH_LEASE_KEY ?? 'ops/refresh-lease.json'
  const owner = options.owner ?? `${env.RAILWAY_DEPLOYMENT_ID ?? 'local'}:${process.pid}:${runId}`
  const config = options.bucketConfig ?? bucketConfigFromEnv(env)
  const client = options.bucketClient ?? createBucketClient(config)
  const ttlMs = numberEnv(env, 'RANKING_REFRESH_LEASE_TTL_MS', 45 * 60_000)
  const manual = env.RANKING_FORCE_REFRESH === 'true'
  const tracker = createRefreshMetrics({
    runId,
    mode,
    cause: manual ? 'manual-force' : mode === 'legacy' ? 'daily-audit' : 'unchanged-scheduled-probe',
    now: () => new Date(now()).getTime(),
    monotonicNow,
    rss,
  })
  let finalRecord

  assertRefreshCadence({
    intervalMinutes: numberEnv(env, 'RANKING_REFRESH_INTERVAL_MINUTES', 360),
    mode,
    cheapExitProven: env.RANKING_CHEAP_EXIT_PROVEN === 'true',
    leaseFencingConfigured: env.RANKING_LEASE_FENCING_ENABLED === 'true',
  })

  if (mode === 'legacy') {
    const finish = tracker.startStage('provider-fetch')
    try {
      await (options.runChild ?? defaultRunChild)({ env, reconciliationPath, metricsPath: childMetricsPath, runId })
      finish('completed')
      finalRecord = completeRefreshMetrics(tracker.snapshot({ result: 'completed' }))
      logger.log(`REFRESH_RUN_METRIC ${JSON.stringify(finalRecord)}`)
      return { status: 'completed', metrics: finalRecord }
    } catch (error) {
      finish('failed')
      finalRecord = completeRefreshMetrics(tracker.snapshot({ result: 'failed', error }))
      logger.log(`REFRESH_RUN_METRIC ${JSON.stringify(finalRecord)}`)
      throw error
    }
  }

  if (!config.enabled || !client) {
    throw new Error(`Bucket configuration is required in ${mode} mode: ${(config.missing ?? []).join(', ')}`)
  }

  const acquired = await (options.acquireLease ?? acquireBucketLease)(leaseKey, {
    owner,
    ttlMs,
    now: now(),
    config,
    client,
  })
  if (!acquired.acquired) {
    finalRecord = completeRefreshMetrics(tracker.snapshot({ result: 'skipped' }))
    logger.log(`Refresh skipped: ${acquired.reason}`)
    logger.log(`REFRESH_RUN_METRIC ${JSON.stringify(finalRecord)}`)
    return { status: 'skipped', reason: acquired.reason, metrics: finalRecord }
  }

  const authority = { lease: { ...acquired.lease }, etag: acquired.etag, promotionEtag: acquired.promotionEtag }
  const heartbeat = startLeaseHeartbeat({
    authority,
    leaseKey,
    ttlMs,
    now,
    renew: options.renewLease ?? renewBucketLease,
    config,
    client,
    setIntervalFn: options.setInterval ?? setInterval,
    clearIntervalFn: options.clearInterval ?? clearInterval,
  })
  const assertLive = async () => {
    await heartbeat.runExclusive(async () => {
      if (heartbeat.error) throw heartbeat.error
      await (options.assertLease ?? assertBucketLease)(leaseKey, authority, { now: now(), config, client })
    })
  }

  try {
    const readRemote = options.readBucketJson ?? readBucketJson
    const writeRemote = options.writeBucketJson ?? writeBucketJson
    const remoteState = await readRemote(stateKey, { config, client })
    let state = parseTriggerState(remoteState.found
      ? remoteState.value
      : await (options.readLocalState ?? readLocalState)(statePath, mode), { mode })
    state.mode = mode
    state.fencingToken = authority.lease.fencingToken
    let stateEtag = remoteState.etag

    const persistState = async (nextState) => {
      await assertLive()
      await (options.writeLocalState ?? writeLocalState)(statePath, nextState)
      const result = await writeRemote(stateKey, nextState, {
        config,
        client,
        ...(stateEtag ? { ifMatch: stateEtag } : { ifNoneMatch: '*' }),
      })
      if (!result.written) throw new Error(result.conflict ? 'Trigger state changed concurrently' : 'Unable to persist trigger state')
      stateEtag = result.etag
    }

    const probeStarted = monotonicNow()
    try {
      const probe = await (options.fetchProbe ?? fetchScheduleProbe)({
        watermark: state.observationWatermark,
        recoveryHours: numberEnv(env, 'RANKING_SCHEDULE_RECOVERY_HOURS', 48),
        maxOlderPages: numberEnv(env, 'RANKING_SCHEDULE_MAX_OLDER_PAGES', 16),
        requestTimeoutMs: numberEnv(env, 'RANKING_SCHEDULE_REQUEST_TIMEOUT_MS', 15_000),
      })
      state = applyScheduleProbe(state, { ...probe, mode })
      tracker.recordStage('probe', {
        durationMs: monotonicNow() - probeStarted,
        result: 'completed',
        output: { eventCount: probe.events?.length ?? 0, detectedCount: state.lastProbe?.detected ?? 0 },
      })
      state.fencingToken = authority.lease.fencingToken
      await persistState(state)
    } catch (error) {
      tracker.recordStage('probe', { durationMs: monotonicNow() - probeStarted, result: 'failed' })
      state = applyProbeFailure(state, { checkedAt: now(), reason: errorMessage(error) })
      state.fencingToken = authority.lease.fencingToken
      await persistState(state)
      await (options.sendAlert ?? defaultSendAlert)(env, 'schedule-probe-failed', errorMessage(error), now, logger)
      throw error
    }

    const correctionAuditDue = auditDue(env, state, now())
    const cause = refreshTriggerCause(state, { correctionAuditDue, manual, now: now() })
    const affectedIds = duePendingMatchIds(state, now())
    const affectedDate = pendingAffectedDate(state, affectedIds)
    tracker.setContext({ cause, affectedIds, affectedDate })

    if (!shouldFetchScoredProviders(state, { correctionAuditDue, manual, now: now() })) {
      logger.log(`Refresh probe complete: mode=${mode} pending=${Object.keys(state.pending).length}; scored providers skipped`)
    } else {
      const dueMatchIds = duePendingMatchIds(state, now())
      const finishProviderFetch = tracker.startStage('provider-fetch', { pendingMatchCount: dueMatchIds.length })
      try {
        await assertLive()
        await writeRefreshMetrics(childMetricsPath, completeRefreshMetrics(tracker.snapshot({
          result: 'running',
          freshness: { detectedAt: pendingDetectedAt(state, dueMatchIds) },
        })))
        await (options.runChild ?? defaultRunChild)({
          env,
          reconciliationPath,
          metricsPath: childMetricsPath,
          runId,
          leaseKey,
          owner: authority.lease.owner,
          fencingToken: authority.lease.fencingToken,
          promotionEtag: authority.promotionEtag,
          cause,
          affectedIds: dueMatchIds,
          affectedDate,
        })
        await assertLive()
        finishProviderFetch('completed')
        const childMetrics = await readRefreshMetrics(childMetricsPath)
        for (const stage of childMetrics?.stages ?? []) {
          if (stage.result !== 'not-applicable') tracker.recordStage(stage.name, stage)
        }
        state = recordPendingAttempt(state, dueMatchIds, { attemptedAt: now() })
        const ledger = await (options.readJson ?? readJson)(reconciliationPath)
        state = acknowledgeMatches(state, ledger?.matches ?? [], now())
        if (correctionAuditDue) state.lastCorrectionAuditAt = new Date(now()).toISOString()
        state.fencingToken = authority.lease.fencingToken
        if (childMetrics && childMetrics.result !== 'running') finalRecord = childMetrics
        await persistState(state)
        logger.log(`Refresh ingestion complete: attempted=${dueMatchIds.length} remaining=${Object.keys(state.pending).length}`)
        await (options.alertIfPendingIsOld ?? defaultAlertIfPendingIsOld)(env, state, now(), logger)
      } catch (error) {
        finishProviderFetch('failed')
        await assertLive()
        state = recordPendingAttempt(state, dueMatchIds, { attemptedAt: now(), reason: errorMessage(error) })
        state.fencingToken = authority.lease.fencingToken
        await persistState(state)
        await (options.sendAlert ?? defaultSendAlert)(env, 'refresh-ingestion-failed', errorMessage(error), now, logger)
        throw error
      }
    }

    finalRecord ??= completeRefreshMetrics(tracker.snapshot({
      result: 'completed',
      freshness: { detectedAt: pendingDetectedAt(state, affectedIds), publishedAt: null },
    }))
    state.lastRun = finalRecord
    await persistState(state)
    return { status: 'completed', state, metrics: finalRecord }
  } catch (error) {
    finalRecord = completeRefreshMetrics(tracker.snapshot({ result: 'failed', error }))
    throw error
  } finally {
    const finalizationErrors = []
    try {
      await heartbeat.stop()
    } catch (error) {
      finalizationErrors.push(`heartbeat-stop: ${errorMessage(error)}`)
    }
    try {
      const released = await (options.releaseLease ?? releaseBucketLease)(leaseKey, authority, { now: now(), config, client })
      if (!released.released) {
        finalizationErrors.push(`lease-release: ${released.reason}`)
        logger.warn(`Refresh lease release skipped: ${released.reason}`)
      }
    } catch (error) {
      finalizationErrors.push(`lease-release: ${errorMessage(error)}`)
      logger.warn(`Refresh lease release failed: ${errorMessage(error)}`)
    } finally {
      if (!finalRecord) finalRecord = completeRefreshMetrics(tracker.snapshot({ result: 'failed' }))
      if (finalizationErrors.length > 0) finalRecord = { ...finalRecord, finalizationErrors }
      logger.log(`REFRESH_RUN_METRIC ${JSON.stringify(finalRecord)}`)
    }
  }
}

export function startLeaseHeartbeat({ authority, leaseKey, ttlMs, now, renew, config, client, setIntervalFn, clearIntervalFn }) {
  let queue = Promise.resolve()
  let stopped = false
  const runExclusive = (operation) => {
    const result = queue.then(operation, operation)
    queue = result.catch(() => undefined)
    return result
  }
  const heartbeat = {
    error: undefined,
    runExclusive,
    async stop() {
      stopped = true
      clearIntervalFn(timer)
      await queue
    },
  }
  const tick = () => {
    if (stopped || heartbeat.error) return
    void runExclusive(async () => {
      if (heartbeat.error) return
      const result = await renew(leaseKey, authority, { ttlMs, now: now(), config, client })
      if (!result.renewed) {
        heartbeat.error = new Error(`Refresh lease renewal failed: ${result.reason}`)
        return
      }
      authority.lease = result.lease
      authority.etag = result.etag
      authority.promotionEtag = result.promotionEtag ?? authority.promotionEtag
    }).catch((error) => {
      heartbeat.error = error instanceof Error ? error : new Error(String(error))
    })
  }
  const timer = setIntervalFn(tick, Math.max(1_000, Math.floor(ttlMs / 3)))
  timer?.unref?.()
  return heartbeat
}

async function defaultRunChild({ env, reconciliationPath, metricsPath, runId, leaseKey, owner, fencingToken, promotionEtag, cause, affectedIds, affectedDate }) {
  await runChildProcess(process.execPath, ['scripts/refresh-data-if-changed.mjs'], numberEnv(env, 'RANKING_REFRESH_JOB_TIMEOUT_MS', 30 * 60_000), {
    ...env,
    RANKING_RECONCILIATION_OUTPUT: reconciliationPath,
    RANKING_REFRESH_METRICS_PATH: metricsPath,
    RANKING_REFRESH_RUN_ID: runId,
    ...(fencingToken ? {
      RANKING_REFRESH_FENCING_TOKEN: String(fencingToken),
      RANKING_REFRESH_LEASE_KEY: leaseKey,
      RANKING_REFRESH_LEASE_OWNER: owner,
      RANKING_REFRESH_PROMOTION_ETAG: promotionEtag,
      RANKING_REFRESH_CAUSE: cause,
      RANKING_REFRESH_AFFECTED_IDS: JSON.stringify(affectedIds ?? []),
      ...(affectedDate ? { RANKING_REFRESH_AFFECTED_DATE: affectedDate } : {}),
    } : {}),
  })
}

export async function runChildProcess(command, args, timeoutMs, env, options = {}) {
  const spawnFn = options.spawn ?? spawn
  const setTimeoutFn = options.setTimeout ?? setTimeout
  const clearTimeoutFn = options.clearTimeout ?? clearTimeout
  await new Promise((resolveRun, rejectRun) => {
    const child = spawnFn(command, args, {
      env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    })
    let timedOut = false
    let killTimeout
    const timeout = setTimeoutFn(() => {
      timedOut = true
      terminateProcessTree(child, 'SIGTERM')
      killTimeout = setTimeoutFn(() => terminateProcessTree(child, 'SIGKILL'), 5_000)
      killTimeout?.unref?.()
    }, timeoutMs)
    timeout.unref()
    child.on('error', (error) => {
      clearTimeoutFn(timeout)
      if (killTimeout) clearTimeoutFn(killTimeout)
      rejectRun(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeoutFn(timeout)
      if (killTimeout) clearTimeoutFn(killTimeout)
      if (timedOut) rejectRun(new Error(`Refresh job exceeded ${timeoutMs}ms; process tree exited with ${code ?? signal}`))
      else if (code === 0) resolveRun()
      else rejectRun(new Error(`Refresh job exited with ${code ?? signal}`))
    })
  })
}

function terminateProcessTree(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall back to the direct child if the process group is already gone.
    }
  }
  child.kill(signal)
}

async function readLocalState(path, mode) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return emptyTriggerState(mode)
  }
}

async function writeLocalState(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporaryPath, path)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function pendingAffectedDate(state, matchIds) {
  const completed = matchIds
    .map((matchId) => state.pending?.[matchId]?.completedAt)
    .filter(Boolean)
    .sort()[0]
  return completed?.slice(0, 10)
}

function pendingDetectedAt(state, matchIds) {
  return matchIds
    .map((matchId) => state.pending?.[matchId]?.detectedAt)
    .filter(Boolean)
    .sort()[0] ?? null
}

function auditDue(env, value, now) {
  if (env.RANKING_CORRECTION_AUDIT_ENABLED !== 'true') return false
  const intervalMs = numberEnv(env, 'RANKING_CORRECTION_AUDIT_INTERVAL_MS', 24 * 60 * 60_000)
  return new Date(now).getTime() - new Date(value.lastCorrectionAuditAt ?? 0).getTime() >= intervalMs
}

function refreshMode(value) {
  return value === 'shadow' || value === 'gated' ? value : 'legacy'
}

function numberEnv(env, name, fallback) {
  const value = Number(env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function defaultAlertIfPendingIsOld(env, value, now, logger) {
  const oldest = Object.values(value.pending ?? {}).map((entry) => new Date(entry.detectedAt).getTime()).filter(Number.isFinite).sort()[0]
  if (!oldest || new Date(now).getTime() - oldest < numberEnv(env, 'RANKING_PENDING_ALERT_AGE_MS', 48 * 60 * 60_000)) return
  await defaultSendAlert(env, 'pending-match-overdue', `${Object.keys(value.pending).length} match(es) remain unresolved`, () => now, logger)
}

async function defaultSendAlert(env, kind, message, now, logger) {
  const url = env.RANKING_ALERT_WEBHOOK_URL
  if (!url) {
    logger.warn(`Alert ${kind}: ${message}`)
    return
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, message, service: 'lol-esports-ranking', at: new Date(now()).toISOString() }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) logger.error(`Alert webhook failed with ${response.status}`)
  } catch (error) {
    logger.error(`Alert webhook failed: ${errorMessage(error)}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runRefreshOnce()
}
