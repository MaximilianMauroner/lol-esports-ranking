import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const REFRESH_STAGE_NAMES = [
  'restore',
  'probe',
  'provider-fetch',
  'fingerprint-import',
  'raw-authority-read',
  'raw-recovery-validation',
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
  'post-commit-operations',
]

export function createRefreshMetrics({
  runId,
  mode,
  cause,
  affectedIds = [],
  affectedDate,
  now = Date.now,
  monotonicNow = () => performance.now(),
  rss = () => process.memoryUsage().rss,
  cpuUsage = () => process.cpuUsage(),
  processKey = `${process.pid}:${runId ?? 'refresh'}`,
  sampleIntervalMs = 250,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const startedAtMs = now()
  const startedMs = monotonicNow()
  const initialRssBytes = rss()
  let peakRssBytes = initialRssBytes
  let lastRssBytes = initialRssBytes
  let lastSampleMs = startedMs
  let memoryByteMilliseconds = 0
  let sampleCount = 1
  let stopped = false
  const initialCpu = cpuUsage()
  let currentCause = cause
  let currentAffectedIds = affectedIds
  let currentAffectedDate = affectedDate
  let checkpoint = { applicable: false, reason: 'incremental-disabled-or-not-classified' }
  let evidence = {}
  let work = emptyRefreshWork()
  const additionalProcesses = []
  const stages = []

  function sampleRss(atMs = monotonicNow()) {
    const current = rss()
    const elapsedMs = Math.max(0, atMs - lastSampleMs)
    memoryByteMilliseconds += ((lastRssBytes + current) / 2) * elapsedMs
    lastRssBytes = current
    lastSampleMs = atMs
    peakRssBytes = Math.max(peakRssBytes, current)
    sampleCount += 1
    return peakRssBytes
  }
  const sampler = setIntervalFn(() => sampleRss(), Math.max(25, sampleIntervalMs))
  sampler?.unref?.()

  return {
    setContext({ cause: nextCause, affectedIds: nextAffectedIds, affectedDate: nextAffectedDate } = {}) {
      if (nextCause) currentCause = nextCause
      if (nextAffectedIds) currentAffectedIds = nextAffectedIds
      if (nextAffectedDate) currentAffectedDate = nextAffectedDate
    },
    setCheckpoint(nextCheckpoint = {}) {
      checkpoint = { ...nextCheckpoint }
    },
    setEvidence(nextEvidence = {}) {
      evidence = { ...evidence, ...nextEvidence }
    },
    recordWork(nextWork = {}) {
      work = mergeRefreshWork(work, nextWork)
    },
    recordProcessResource(resource) {
      additionalProcesses.push(normalizeProcessResource(resource))
    },
    startStage(name, input = {}) {
      const stageStartedAtMs = now()
      const stageStartedMs = monotonicNow()
      sampleRss(stageStartedMs)
      return (result = 'completed', output = {}) => {
        const finishedAtMs = now()
        const finishedMs = monotonicNow()
        sampleRss(finishedMs)
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
      sampleRss(finishedMs)
      const finishedCpu = cpuUsage()
      const cpuSeconds = cpuDeltaSeconds(initialCpu, finishedCpu)
      const memoryGbSeconds = memoryByteMilliseconds / (1024 ** 3) / 1000
      const processResource = {
        processKey: String(processKey),
        cpuSeconds,
        memoryGbSeconds,
        peakRssBytes,
        sampleCount,
      }
      const resources = aggregateProcessResources([processResource, ...additionalProcesses])
      if (result !== 'running' && !stopped) { stopped = true; clearIntervalFn(sampler) }
      return {
        schemaVersion: 2,
        runId,
        mode,
        cause: currentCause,
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: result === 'running' ? null : new Date(finishedAtMs).toISOString(),
        durationMs: Math.max(0, finishedMs - startedMs),
        result,
        peakRssBytes,
        resources,
        work: { ...work },
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
        ...evidence,
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
    if (current?.result === 'failed' && stage.result !== 'failed') continue
    byName.set(stage.name, stage)
  }
  const startedAt = earliestTimestamp(parent.startedAt, child.startedAt)
  const finishedAt = latestTimestamp(parent.finishedAt, child.finishedAt)
  const promotion = [...(parent.stages ?? []), ...(child.stages ?? [])]
    .findLast((stage) => stage.name === 'promotion' && stage.result === 'completed')
  const publishedAt = promotion?.output?.promotedAt
    ?? (promotion ? latestTimestamp(parent.freshness?.publishedAt, child.freshness?.publishedAt) : null)
  const processes = mergeProcessResources(parent.resources?.processes, child.resources?.processes)
  const sameProcessSnapshot = processIds(child.resources?.processes).size > 0
    && [...processIds(child.resources?.processes)].every((id) => processIds(parent.resources?.processes).has(id))
  const errors = [...new Set([
    ...(parent.errors ?? []),
    ...(child.errors ?? []),
    parent.error,
    child.error,
  ].filter((value) => typeof value === 'string' && value.length > 0))]
  return {
    ...parent,
    ...child,
    cause: parent.cause,
    startedAt,
    finishedAt,
    durationMs: startedAt && finishedAt
      ? Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime())
      : Math.max(Number(parent.durationMs) || 0, Number(child.durationMs) || 0),
    peakRssBytes: maximumKnown([parent.peakRssBytes, child.peakRssBytes]),
    resources: aggregateProcessResources(processes),
    work: sameProcessSnapshot ? maxRefreshWork(parent.work, child.work) : mergeRefreshWork(parent.work, child.work),
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
    ...(errors.length > 0 ? { error: errors[0], errors } : {}),
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
  return {
    ...record,
    resources: record.resources ?? { cpuSeconds: null, memoryGbSeconds: null, peakRssBytes: record.peakRssBytes ?? null, processes: [] },
    work: mergeRefreshWork(emptyRefreshWork(), record.work),
    stages: REFRESH_STAGE_NAMES.map((name) => stages.get(name)),
  }
}

export function emptyRefreshWork() {
  return {
    providerRequests: null,
    providerRetries: null,
    broadFetches: null,
    fullBuilds: null,
    incrementalBuilds: null,
    bytesRead: null,
    bytesWritten: null,
    objectsRead: null,
    objectsWritten: null,
    uploads: null,
  }
}

export function mergeRefreshWork(left = {}, right = {}) {
  const merged = {}
  for (const key of Object.keys(emptyRefreshWork())) {
    const leftValue = finiteOrNull(left?.[key])
    const rightValue = finiteOrNull(right?.[key])
    merged[key] = leftValue === null ? rightValue : rightValue === null ? leftValue : leftValue + rightValue
  }
  return merged
}

function maxRefreshWork(left = {}, right = {}) {
  const merged = {}
  for (const key of Object.keys(emptyRefreshWork())) {
    const values = [finiteOrNull(left?.[key]), finiteOrNull(right?.[key])].filter((value) => value !== null)
    merged[key] = values.length > 0 ? Math.max(...values) : null
  }
  return merged
}

function cpuDeltaSeconds(initial, finished) {
  const initialMicros = Number(initial?.user) + Number(initial?.system)
  const finishedMicros = Number(finished?.user) + Number(finished?.system)
  return Number.isFinite(initialMicros) && Number.isFinite(finishedMicros)
    ? Math.max(0, finishedMicros - initialMicros) / 1_000_000
    : null
}

function mergeProcessResources(left = [], right = []) {
  const processes = new Map()
  for (const entry of [...left, ...right]) {
    if (!entry || typeof entry.processKey !== 'string') continue
    const current = processes.get(entry.processKey)
    if (!current) processes.set(entry.processKey, { ...entry })
    else processes.set(entry.processKey, {
      processKey: entry.processKey,
      cpuSeconds: maxKnown(current.cpuSeconds, entry.cpuSeconds),
      memoryGbSeconds: maxKnown(current.memoryGbSeconds, entry.memoryGbSeconds),
      peakRssBytes: maxKnown(current.peakRssBytes, entry.peakRssBytes),
      sampleCount: maxKnown(current.sampleCount, entry.sampleCount),
    })
  }
  return [...processes.values()]
}

function processIds(values = []) {
  return new Set(values.filter((entry) => entry && typeof entry.processKey === 'string').map((entry) => entry.processKey))
}

function aggregateProcessResources(processes) {
  return {
    cpuSeconds: sumAllKnown(processes.map((entry) => entry.cpuSeconds)),
    memoryGbSeconds: sumAllKnown(processes.map((entry) => entry.memoryGbSeconds)),
    peakRssBytes: maximumKnown(processes.map((entry) => entry.peakRssBytes)),
    processes,
  }
}

function finiteOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : null
}

function sumAllKnown(values) {
  const known = values.map(finiteOrNull).filter((value) => value !== null)
  return known.length === values.length && values.length > 0
    ? known.reduce((sum, value) => sum + value, 0)
    : null
}

function maximumKnown(values) {
  const known = values.map(finiteOrNull).filter((value) => value !== null)
  return known.length > 0 ? Math.max(...known) : null
}

function maxKnown(...values) {
  const known = values.map(finiteOrNull).filter((value) => value !== null)
  return known.length > 0 ? Math.max(...known) : null
}

function normalizeProcessResource(resource = {}) {
  if (typeof resource.processKey !== 'string' || resource.processKey.length === 0) throw new Error('Process resource requires processKey')
  return {
    processKey: resource.processKey,
    cpuSeconds: finiteOrNull(resource.cpuSeconds),
    memoryGbSeconds: finiteOrNull(resource.memoryGbSeconds),
    peakRssBytes: finiteOrNull(resource.peakRssBytes),
    sampleCount: finiteOrNull(resource.sampleCount),
  }
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
