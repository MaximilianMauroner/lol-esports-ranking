import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const REFRESH_STAGE_NAMES = [
  'restore',
  'probe',
  'provider-fetch',
  'fingerprint-import',
  'raw-authority-read',
  'raw-prepare',
  'raw-materialization',
  'classification',
  'checkpoint-restore',
  'checkpoint-validation',
  'replay',
  'external-causal-recompute',
  'player-build',
  'player-compaction',
  'dependency-materialization',
  'semantic-parity',
  'state-persistence',
  'full-audit-object',
  'crunch',
  'public-serialization',
  'hashing',
  'raw-synchronization',
  'artifact-upload',
  'promotion',
  'full-audit-receipt',
]

export function createRefreshMetrics({
  runId,
  mode,
  cause,
  affectedIds = [],
  affectedDate,
  now = Date.now,
  monotonicNow = () => performance.now(),
  rss = () => Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024),
} = {}) {
  const startedAtMs = now()
  const startedMs = monotonicNow()
  let peakRssBytes = rss()
  let currentCause = cause
  let currentAffectedIds = affectedIds
  let currentAffectedDate = affectedDate
  let checkpoint = { applicable: false, reason: 'incremental-disabled-or-not-classified' }
  const stages = []

  function sampleRss() {
    peakRssBytes = Math.max(peakRssBytes, rss())
    return peakRssBytes
  }

  return {
    setContext({ cause: nextCause, affectedIds: nextAffectedIds, affectedDate: nextAffectedDate } = {}) {
      if (nextCause) currentCause = nextCause
      if (nextAffectedIds) currentAffectedIds = nextAffectedIds
      if (nextAffectedDate) currentAffectedDate = nextAffectedDate
    },
    setCheckpoint(nextCheckpoint = {}) {
      checkpoint = { ...nextCheckpoint }
    },
    startStage(name, input = {}) {
      const stageStartedAtMs = now()
      const stageStartedMs = monotonicNow()
      sampleRss()
      return (result = 'completed', output = {}) => {
        const finishedAtMs = now()
        const finishedMs = monotonicNow()
        sampleRss()
        stages.push({
          name,
          startedAt: new Date(stageStartedAtMs).toISOString(),
          finishedAt: new Date(finishedAtMs).toISOString(),
          durationMs: Math.max(0, finishedMs - stageStartedMs),
          result,
          input,
          output,
        })
      }
    },
    recordStage(name, { startedAt, finishedAt, durationMs, result = 'completed', input = {}, output = {} } = {}) {
      stages.push({
        name,
        ...(startedAt ? { startedAt } : {}),
        ...(finishedAt ? { finishedAt } : {}),
        durationMs: Math.max(0, Number(durationMs) || 0),
        result,
        input,
        output,
      })
      sampleRss()
    },
    snapshot({ result = 'running', freshness = {}, error } = {}) {
      const finishedAtMs = now()
      const finishedMs = monotonicNow()
      sampleRss()
      return {
        schemaVersion: 1,
        runId,
        mode,
        cause: currentCause,
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: result === 'running' ? null : new Date(finishedAtMs).toISOString(),
        durationMs: Math.max(0, finishedMs - startedMs),
        result,
        peakRssBytes,
        affected: {
          matchIds: [...new Set(currentAffectedIds)].sort(),
          ...(currentAffectedDate ? { date: currentAffectedDate } : {}),
        },
        freshness: {
          providerAvailableAt: freshness.providerAvailableAt ?? null,
          detectedAt: freshness.detectedAt ?? null,
          publishedAt: freshness.publishedAt ?? null,
        },
        checkpoint,
        stages: stages.map((stage) => ({ ...stage })),
        ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
      }
    },
  }
}

export function mergeRefreshMetrics(parent, child) {
  if (!child || child.runId !== parent.runId) return parent
  const byName = new Map(parent.stages.map((stage) => [stage.name, stage]))
  for (const stage of child.stages ?? []) {
    const current = byName.get(stage.name)
    if (stage.result === 'not-applicable' && current && current.result !== 'not-applicable') continue
    byName.set(stage.name, stage)
  }
  const startedAt = earliestTimestamp(parent.startedAt, child.startedAt)
  const finishedAt = latestTimestamp(parent.finishedAt, child.finishedAt)
  const promotion = [...(parent.stages ?? []), ...(child.stages ?? [])]
    .findLast((stage) => stage.name === 'promotion' && stage.result === 'completed')
  const publishedAt = promotion?.output?.promotedAt
    ?? (promotion ? latestTimestamp(parent.freshness?.publishedAt, child.freshness?.publishedAt) : null)
  return {
    ...parent,
    ...child,
    cause: parent.cause,
    startedAt,
    finishedAt,
    durationMs: startedAt && finishedAt
      ? Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime())
      : Math.max(Number(parent.durationMs) || 0, Number(child.durationMs) || 0),
    peakRssBytes: Math.max(Number(parent.peakRssBytes) || 0, Number(child.peakRssBytes) || 0),
    affected: {
      matchIds: [...new Set([...(parent.affected?.matchIds ?? []), ...(child.affected?.matchIds ?? [])])].sort(),
      ...(parent.affected?.date ?? child.affected?.date ? { date: parent.affected?.date ?? child.affected?.date } : {}),
    },
    freshness: {
      providerAvailableAt: earliestTimestamp(parent.freshness?.providerAvailableAt, child.freshness?.providerAvailableAt),
      detectedAt: earliestTimestamp(parent.freshness?.detectedAt, child.freshness?.detectedAt),
      publishedAt,
    },
    checkpoint: child.checkpoint?.applicable ? child.checkpoint : parent.checkpoint,
    stages: [...byName.values()],
  }
}

function earliestTimestamp(...values) {
  return values.filter(Boolean).sort()[0] ?? null
}

function latestTimestamp(...values) {
  return values.filter(Boolean).sort().at(-1) ?? null
}

export function completeRefreshMetrics(record) {
  const stages = new Map((record.stages ?? []).map((stage) => [stage.name, stage]))
  for (const name of REFRESH_STAGE_NAMES) {
    if (!stages.has(name)) stages.set(name, { name, durationMs: 0, result: 'not-applicable', input: {}, output: {} })
  }
  return { ...record, stages: REFRESH_STAGE_NAMES.map((name) => stages.get(name)) }
}

export async function readRefreshMetrics(path) {
  if (!path) return undefined
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

export async function writeRefreshMetrics(path, record) {
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`)
  await rename(temporaryPath, path)
}

export async function appendRefreshStages(path, record) {
  if (!path) return
  const current = await readRefreshMetrics(path)
  await writeRefreshMetrics(path, current ? mergeRefreshMetrics(current, record) : record)
}
