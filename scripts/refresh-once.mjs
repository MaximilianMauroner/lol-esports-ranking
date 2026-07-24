import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  acquireBucketLease,
  assertBucketLease,
  bucketKey,
  bucketConfigFromEnv,
  createBucketClient,
  readBucketJson,
  releaseBucketLease,
  renewBucketLease,
  writeBucketJson,
} from './railway-bucket.mjs'
import {
  parseRankingSourceAuthorityEvidence,
  parseRankingSourceAuthorityEvidenceEnvelope,
  rankingSourceAuthorityEvidenceDigest,
} from './ranking-source-authority.mjs'
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
import { completeRefreshMetrics, createRefreshMetrics, mergeRefreshMetrics, readRefreshMetrics, writeRefreshMetrics } from './refresh-metrics.mjs'
import { refreshWorkerArgs } from './refresh-worker-memory.mjs'
import { readRolloutGateReceipt } from './validate-rollout-gate.mjs'
import {
  createRefreshRolloutEvidence,
  publishRolloutEvidence,
} from './rollout-evidence.mjs'

export async function runRefreshOnce(options = {}) {
  const env = options.env ?? process.env
  const now = options.now ?? (() => new Date())
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const rss = options.rss ?? (() => process.memoryUsage().rss)
  const logger = options.logger ?? console
  const mode = refreshMode(env.RANKING_REFRESH_MODE)
  const runId = options.runId ?? randomUUID()
  const statePath = resolve(env.RANKING_TRIGGER_STATE ?? 'data/raw/refresh-trigger-state.json')
  const refreshStatePath = resolve(env.RANKING_REFRESH_STATE ?? 'data/raw/refresh-state.json')
  const reconciliationPath = resolve(env.RANKING_RECONCILIATION_OUTPUT ?? 'data/raw/reconciliation.json')
  const childMetricsPath = resolve(env.RANKING_REFRESH_METRICS_PATH ?? `data/.refresh-metrics-${runId}.json`)
  const stateKey = env.RANKING_TRIGGER_STATE_KEY ?? 'raw/refresh-trigger-state.json'
  const leaseKey = env.RANKING_REFRESH_LEASE_KEY ?? 'ops/refresh-lease.json'
  const owner = options.owner ?? `${env.RAILWAY_DEPLOYMENT_ID ?? 'local'}:${process.pid}:${runId}`
  const config = options.bucketConfig ?? bucketConfigFromEnv(env)
  const client = options.bucketClient ?? createBucketClient(config)
  const launchChild = options.runChild
    ?? ((input) => defaultRunChild(input, { runProcess: options.runChildProcess }))
  const ttlMs = numberEnv(env, 'RANKING_REFRESH_LEASE_TTL_MS', 45 * 60_000)
  const jobTimeoutMs = numberEnv(env, 'RANKING_REFRESH_JOB_TIMEOUT_MS', 30 * 60_000)
  const manual = env.RANKING_FORCE_REFRESH === 'true'
  const tracker = createRefreshMetrics({
    runId,
    mode,
    cause: manual ? 'manual-force' : 'unchanged-scheduled-probe',
    now: () => new Date(now()).getTime(),
    monotonicNow,
    rss,
  })
  let finalRecord
  const finalizePreRunTerminal = async ({ result, error } = {}) => {
    finalRecord = completeRefreshMetrics(tracker.snapshot({ result, ...(error ? { error } : {}) }))
    if (!config.enabled || !client) return { status: 'storage-unavailable' }
    try {
      return await publishRefreshRolloutEvidence(finalRecord, {
        env,
        now: now(),
        runId,
        config,
        client,
        publish: options.publishRolloutEvidence ?? publishRolloutEvidence,
      })
    } catch (publicationError) {
      logger.warn(`Rollout evidence publication failed: ${errorMessage(publicationError)}`)
      return { status: 'publication-failed' }
    }
  }

  const intervalMinutes = numberEnv(env, 'RANKING_REFRESH_INTERVAL_MINUTES', 360)
  const resolveGateReference = options.readBucketJson ?? readBucketJson
  try {
    const rolloutGateReceipt = intervalMinutes <= 5
      ? await readRolloutGateReceipt(env.RANKING_ROLLOUT_GATE_RECEIPT, { config, client, readJson: resolveGateReference })
      : undefined
    await assertRefreshCadence({
      intervalMinutes,
      mode,
      commit: env.RAILWAY_GIT_COMMIT_SHA ?? env.GIT_COMMIT_SHA,
      deploymentId: env.RAILWAY_DEPLOYMENT_ID,
      receiptAuthority: rolloutGateReceipt,
      resolveReference: (key) => resolveGateReference(key, { config, client }),
      now: now(),
    })
  } catch (error) {
    await finalizePreRunTerminal({ result: 'failed', error })
    throw error
  }
  if (ttlMs <= jobTimeoutMs + 60_000) {
    const error = new Error('Refresh lease TTL must exceed the child timeout by at least 60000ms')
    await finalizePreRunTerminal({ result: 'failed', error })
    throw error
  }

  if (!config.enabled || !client) {
    const error = new Error(`Bucket configuration is required in ${mode} mode: ${(config.missing ?? []).join(', ')}`)
    await finalizePreRunTerminal({ result: 'failed', error })
    throw error
  }

  let acquired
  try {
    acquired = await (options.acquireLease ?? acquireBucketLease)(leaseKey, {
      owner,
      ttlMs,
      now: now(),
      config,
      client,
    })
  } catch (error) {
    await finalizePreRunTerminal({ result: 'failed', error })
    throw error
  }
  if (!acquired.acquired) {
    await finalizePreRunTerminal({ result: 'skipped' })
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

    const persistRefreshTelemetry = async (record) => {
      await assertLive()
      const sourceAuthorityEvidence = record?.sourceAuthorityEvidence
        ? parseRankingSourceAuthorityEvidenceEnvelope(record.sourceAuthorityEvidence)
        : undefined
      let sourceAuthorityEvidenceAuthority
      if (sourceAuthorityEvidence) {
        const relativeKey = `raw/source-authority-evidence/sha256/${sourceAuthorityEvidence.evidenceDigest}.json`
        const write = await writeRemote(relativeKey, sourceAuthorityEvidence.evidence, {
          config,
          client,
          ifNoneMatch: '*',
        })
        if (!write.written) {
          if (!write.conflict) throw new Error('Unable to persist immutable source authority evidence')
          const existing = await readRemote(relativeKey, { config, client })
          const parsedExisting = existing.found
            ? parseRankingSourceAuthorityEvidence(existing.value)
            : undefined
          if (!parsedExisting
            || rankingSourceAuthorityEvidenceDigest(parsedExisting) !== sourceAuthorityEvidence.evidenceDigest) {
            throw new Error('Immutable source authority evidence conflicted with different content')
          }
        }
        sourceAuthorityEvidenceAuthority = {
          key: bucketKey(config, relativeKey),
          sha256: sourceAuthorityEvidence.evidenceDigest,
          bytes: sourceAuthorityEvidence.bytes,
          runId: sourceAuthorityEvidence.evidence.runId,
          mode: sourceAuthorityEvidence.evidence.mode,
        }
      }
      const local = await readJsonIfExists(refreshStatePath) ?? { schemaVersion: 1, status: 'failed' }
      local.lastRun = record
      if (sourceAuthorityEvidence) local.sourceAuthorityEvidence = sourceAuthorityEvidence
      if (sourceAuthorityEvidenceAuthority) local.sourceAuthorityEvidenceAuthority = sourceAuthorityEvidenceAuthority
      await writeLocalState(refreshStatePath, local)
      const remote = await readRemote('raw/refresh-state.json', { config, client })
      const remoteValue = {
        ...(remote.found && remote.value && typeof remote.value === 'object' ? remote.value : local),
        lastRun: record,
        ...(sourceAuthorityEvidence ? { sourceAuthorityEvidence } : {}),
        ...(sourceAuthorityEvidenceAuthority ? { sourceAuthorityEvidenceAuthority } : {}),
      }
      const result = await writeRemote('raw/refresh-state.json', remoteValue, {
        config,
        client,
        ...(remote.found ? { ifMatch: remote.etag } : { ifNoneMatch: '*' }),
      })
      if (!result.written) throw new Error(result.conflict ? 'Refresh state changed concurrently' : 'Unable to persist refresh telemetry')
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
      tracker.recordWork({
        providerRequests: Number.isFinite(probe.requestCount) ? probe.requestCount : Number.isFinite(probe.pageCount) ? probe.pageCount : null,
        providerRetries: Number.isFinite(probe.retryCount) ? probe.retryCount : null,
      })
      state.fencingToken = authority.lease.fencingToken
      await persistState(state)
    } catch (error) {
      const retryTelemetry = error?.telemetry
      const providerRequests = Number.isFinite(retryTelemetry?.requests) ? retryTelemetry.requests : null
      const providerRetries = Number.isFinite(retryTelemetry?.retryCount)
        ? retryTelemetry.retryCount
        : Array.isArray(retryTelemetry?.retries) ? retryTelemetry.retries.length : null
      tracker.recordStage('probe', {
        durationMs: monotonicNow() - probeStarted,
        result: 'failed',
        output: { providerRequests, providerRetries },
      })
      tracker.recordWork({ providerRequests, providerRetries })
      finalRecord = completeRefreshMetrics(tracker.snapshot({ result: 'failed', error }))
      state = applyProbeFailure(state, { checkedAt: now(), reason: errorMessage(error) })
      state.fencingToken = authority.lease.fencingToken
      state.lastRun = finalRecord
      const persistenceErrors = []
      try {
        await writeRefreshMetrics(childMetricsPath, finalRecord)
      } catch (persistenceError) {
        persistenceErrors.push(`metrics: ${errorMessage(persistenceError)}`)
      }
      try {
        await persistRefreshTelemetry(finalRecord)
      } catch (persistenceError) {
        persistenceErrors.push(`refresh-state: ${errorMessage(persistenceError)}`)
      }
      try {
        await persistState(state)
      } catch (persistenceError) {
        persistenceErrors.push(`trigger-state: ${errorMessage(persistenceError)}`)
      }
      if (persistenceErrors.length > 0) logger.warn(`Unable to persist canonical probe failure: ${persistenceErrors.join('; ')}`)
      await (options.sendAlert ?? defaultSendAlert)(env, 'schedule-probe-failed', errorMessage(error), now, logger)
      if (error instanceof Error) error.refreshMetrics = finalRecord
      throw error
    }

    const dailyAuditDue = isDailyAuditDue(env, state, now())
    const cause = refreshTriggerCause(state, { correctionAuditDue: dailyAuditDue, manual, now: now() })
    const affectedIds = duePendingMatchIds(state, now())
    const affectedDate = pendingAffectedDate(state, affectedIds)
    tracker.setContext({ cause, affectedIds, affectedDate })

    if (!shouldFetchScoredProviders(state, {
      correctionAuditDue: dailyAuditDue,
      manual,
      now: now(),
      shadowIngestionEnabled: env.RANKING_INCREMENTAL_SHADOW_ENABLED === 'true',
    })) {
      tracker.recordWork({ broadFetches: 0, fullBuilds: 0, incrementalBuilds: 0, uploads: 0, bytesWritten: 0, objectsWritten: 0 })
      logger.log(`Refresh probe complete: mode=${mode} pending=${Object.keys(state.pending).length}; scored providers skipped`)
    } else {
      const dueMatchIds = duePendingMatchIds(state, now())
      const finishProviderFetch = tracker.startStage('provider-fetch', { pendingMatchCount: dueMatchIds.length })
      let childMetrics
      try {
        await assertLive()
        await writeRefreshMetrics(childMetricsPath, completeRefreshMetrics(tracker.snapshot({
          result: 'running',
          freshness: { detectedAt: pendingDetectedAt(state, dueMatchIds) },
        })))
        await heartbeat.runExclusive(async () => {
          if (heartbeat.error) throw heartbeat.error
          const renewed = await (options.renewLease ?? renewBucketLease)(leaseKey, authority, {
            ttlMs,
            now: now(),
            config,
            client,
          })
          if (!renewed.renewed) throw new Error(`Refresh lease renewal before child failed: ${renewed.reason}`)
          authority.lease = renewed.lease
          authority.etag = renewed.etag
          authority.promotionEtag = renewed.promotionEtag ?? renewed.etag
          const remainingMs = new Date(authority.lease.expiresAt).getTime() - new Date(now()).getTime()
          if (remainingMs < jobTimeoutMs + 60_000) {
            throw new Error(`Renewed refresh lease has only ${remainingMs}ms remaining; ${jobTimeoutMs + 60_000}ms required`)
          }
          let childError
          try {
            await launchChild({
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
          } catch (error) {
            childError = error
          }
          childMetrics = await readRefreshMetrics(childMetricsPath)
          installChildCoordination(authority, childMetrics)
          const live = await (options.assertLease ?? assertBucketLease)(leaseKey, authority, {
            now: now(),
            config,
            client,
            requireEtag: false,
          })
          if (live?.etag) {
            if (childMetrics?.coordination?.etag && childMetrics.coordination.etag !== live.etag) {
              throw new Error('Child coordination ETag does not match the authoritative lease record')
            }
            authority.etag = live.etag
            authority.promotionEtag = live.etag
          }
          if (childError) throw childError
        })
        await assertLive()
        finishProviderFetch('completed')
        for (const stage of childMetrics?.stages ?? []) {
          if (stage.result !== 'not-applicable') tracker.recordStage(stage.name, stage)
        }
        state = recordPendingAttempt(state, dueMatchIds, { attemptedAt: now() })
        const ledger = await readReconciliationLedger(
          reconciliationPath,
          childMetrics,
          options.readJson ?? readJson,
        )
        state = acknowledgeMatches(state, ledger?.matches ?? [], now())
        if (dailyAuditDue && successfulDailyAudit(childMetrics)) {
          state.lastSuccessfulDailyAuditAt = new Date(now()).toISOString()
        }
        state.fencingToken = authority.lease.fencingToken
        if (childMetrics && childMetrics.result !== 'running') finalRecord = childMetrics
        await persistState(state)
        logger.log(`Refresh ingestion complete: attempted=${dueMatchIds.length} remaining=${Object.keys(state.pending).length}`)
        await (options.alertIfPendingIsOld ?? defaultAlertIfPendingIsOld)(env, state, now(), logger)
      } catch (error) {
        finishProviderFetch('failed')
        childMetrics ??= await readRefreshMetrics(childMetricsPath)
        const failure = canonicalChildFailure(
          childMetrics,
          completeRefreshMetrics(tracker.snapshot({ result: 'failed', error })),
          error,
        )
        finalRecord = failure.record
        try {
          await assertLive()
          state = recordPendingAttempt(state, dueMatchIds, { attemptedAt: now(), reason: failure.primaryError })
          state.fencingToken = authority.lease.fencingToken
          state.lastRun = finalRecord
          await persistRefreshTelemetry(finalRecord)
          await writeRefreshMetrics(childMetricsPath, finalRecord)
          await persistState(state)
        } catch (persistenceError) {
          logger.warn(`Unable to persist canonical refresh failure: ${errorMessage(persistenceError)}`)
        }
        await (options.sendAlert ?? defaultSendAlert)(env, 'refresh-ingestion-failed', failure.primaryError, now, logger)
        throw failure.error
      }
    }

    finalRecord ??= completeRefreshMetrics(tracker.snapshot({
      result: 'completed',
      freshness: { detectedAt: pendingDetectedAt(state, affectedIds), publishedAt: null },
    }))
    state.lastRun = finalRecord
    if (finalRecord.result === 'unchanged' || finalRecord.result === 'stale-source') {
      await persistRefreshTelemetry(finalRecord)
    }
    await persistState(state)
    return { status: 'completed', state, metrics: finalRecord }
  } catch (error) {
    finalRecord ??= completeRefreshMetrics(tracker.snapshot({ result: 'failed', error }))
    if (error instanceof Error) error.refreshMetrics = finalRecord
    throw error
  } finally {
    const finalizationErrors = []
    try {
      await publishRefreshRolloutEvidence(finalRecord, {
        env,
        now: now(),
        runId,
        config,
        client,
        publish: options.publishRolloutEvidence ?? publishRolloutEvidence,
      })
    } catch (error) {
      finalizationErrors.push(`rollout-evidence: ${errorMessage(error)}`)
      logger.warn(`Rollout evidence publication failed: ${errorMessage(error)}`)
    }
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
      logger.log(`REFRESH_RUN_METRIC ${JSON.stringify(finalRecord)}`)
      if (finalizationErrors.length > 0) {
        logger.error(`REFRESH_FINALIZATION_ERROR ${JSON.stringify({
          schemaVersion: 1,
          runId,
          at: new Date(now()).toISOString(),
          errors: finalizationErrors,
        })}`)
      }
    }
  }
}

export async function publishRefreshRolloutEvidence(metrics, {
  env = process.env,
  now = new Date(),
  runId,
  config,
  client,
  evidenceClass = 'live',
  publish = publishRolloutEvidence,
} = {}) {
  if (env.RANKING_ROLLOUT_EVIDENCE_ENABLED !== 'true' || !metrics) return { status: 'disabled' }
  const commit = env.RAILWAY_GIT_COMMIT_SHA ?? env.GIT_COMMIT_SHA
  const deploymentId = env.RAILWAY_DEPLOYMENT_ID
  const environmentId = env.RAILWAY_ENVIRONMENT_ID
  const serviceId = env.RAILWAY_SERVICE_ID
  if (![commit, deploymentId, environmentId, serviceId].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new Error('Rollout evidence requires commit, deployment, environment, and service authority')
  }
  const ttlMs = numberEnv(env, 'RANKING_ROLLOUT_EVIDENCE_TTL_MS', 14 * 24 * 60 * 60_000)
  const evidence = createRefreshRolloutEvidence({ ...metrics, runId: metrics.runId ?? runId }, {
    evidenceClass,
    commit,
    expiresAt: new Date(new Date(now).getTime() + ttlMs).toISOString(),
    deployment: { deploymentId, environmentId, serviceId },
    ...(env.RANKING_ROLLOUT_EVIDENCE_SCENARIO
      ? { scenario: env.RANKING_ROLLOUT_EVIDENCE_SCENARIO }
      : {}),
  })
  return publish(evidence, { config, client })
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

function installChildCoordination(authority, metrics) {
  const promoted = metrics?.stages?.some((stage) => stage.name === 'promotion' && stage.result === 'completed')
  if (!promoted) return
  const coordination = metrics?.coordination
  if (!coordination
    || coordination.owner !== authority.lease.owner
    || Number(coordination.fencingToken) !== Number(authority.lease.fencingToken)
    || typeof coordination.etag !== 'string'
    || coordination.etag.length === 0) {
    throw new Error('Promoted child did not return valid lease coordination')
  }
  authority.etag = coordination.etag
  authority.promotionEtag = coordination.etag
}

export async function defaultRunChild({ env, reconciliationPath, metricsPath, runId, leaseKey, owner, fencingToken, promotionEtag, cause, affectedIds, affectedDate }, options = {}) {
  await (options.runProcess ?? runChildProcess)(process.execPath, refreshWorkerArgs('scripts/refresh-data-if-changed.mjs'), numberEnv(env, 'RANKING_REFRESH_JOB_TIMEOUT_MS', 30 * 60_000), {
    ...env,
    RANKING_RECONCILIATION_OUTPUT: reconciliationPath,
    RANKING_REFRESH_METRICS_PATH: metricsPath,
    RANKING_REFRESH_RUN_ID: runId,
    RANKING_REFRESH_CAUSE: cause,
    ...(cause === 'daily-audit' ? { RANKING_FORCE_REFRESH: 'true' } : {}),
    RANKING_REFRESH_AFFECTED_IDS: JSON.stringify(affectedIds ?? []),
    ...(affectedDate ? { RANKING_REFRESH_AFFECTED_DATE: affectedDate } : {}),
    ...(fencingToken ? {
      RANKING_REFRESH_FENCING_TOKEN: String(fencingToken),
      RANKING_REFRESH_LEASE_KEY: leaseKey,
      RANKING_REFRESH_LEASE_OWNER: owner,
      RANKING_REFRESH_PROMOTION_ETAG: promotionEtag,
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

async function readJsonIfExists(path) {
  try {
    return await readJson(path)
  } catch {
    return undefined
  }
}

async function readReconciliationLedger(path, childMetrics, reader) {
  if (childMetrics?.result === 'stale-source') return { matches: [] }
  try {
    return await reader(path)
  } catch (error) {
    if (childMetrics?.result === 'unchanged' && error?.code === 'ENOENT') return { matches: [] }
    throw error
  }
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

export function isDailyAuditDue(env, value, now) {
  if (env.RANKING_DAILY_AUDIT_ENABLED !== 'true') return false
  const intervalMs = numberEnv(env, 'RANKING_DAILY_AUDIT_INTERVAL_MS', 24 * 60 * 60_000)
  return new Date(now).getTime() - new Date(value.lastSuccessfulDailyAuditAt ?? 0).getTime() >= intervalMs
}

function successfulDailyAudit(metrics) {
  if (!metrics || metrics.result !== 'completed') return false
  const stages = new Map((metrics.stages ?? []).map((stage) => [stage.name, stage]))
  const parity = stages.get('semantic-parity')
  return stages.get('promotion')?.result === 'completed'
    && stages.get('full-audit-receipt')?.result === 'completed'
    && parity?.result === 'completed'
    && parity.output?.parity === true && parity.output?.stateParity === true && parity.output?.checkpointParity === true
}

function refreshMode(value) {
  return value === 'shadow' ? 'shadow' : 'gated'
}

function numberEnv(env, name, fallback) {
  const value = Number(env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function canonicalChildFailure(childMetrics, parentFailure, error) {
  const processError = errorMessage(error)
  const childPrimaryError = childMetrics?.result === 'failed' && typeof childMetrics.error === 'string' && childMetrics.error.trim()
    ? childMetrics.error
    : undefined
  const primaryError = childPrimaryError ?? processError
  const base = childMetrics && childMetrics.result === 'failed'
    ? childMetrics
    : childMetrics ? completeRefreshMetrics(mergeRefreshMetrics(parentFailure, childMetrics)) : parentFailure
  const record = {
    ...base,
    result: 'failed',
    error: primaryError,
    ...(childPrimaryError && childPrimaryError !== processError ? { processError } : {}),
  }
  return {
    record,
    primaryError,
    error: childPrimaryError && childPrimaryError !== processError
      ? new Error(childPrimaryError, { cause: error })
      : error,
  }
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
