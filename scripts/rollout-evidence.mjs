import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { canonicalJsonFor } from './public-artifact-storage.mjs'
import { bucketConfigFromEnv, createBucketClient, readBucketJson, safeObjectPath, writeBucketJson } from './railway-bucket.mjs'

export const ROLLOUT_EVIDENCE_KIND = 'ranking-rollout-run-evidence'
export const ROLLOUT_EVIDENCE_CLASSES = ['live', 'production-like-fixture']
export const ROLLOUT_EVIDENCE_SCENARIOS = ['latest-append', 'unchanged', 'daily-audit', 'same-day-insertion', 'historical-correction', 'tournament-transition']
export const ROLLOUT_SHADOW_SCENARIOS = ROLLOUT_EVIDENCE_SCENARIOS.filter((scenario) => scenario !== 'daily-audit')
export const ROLLOUT_CHANGED_SCENARIOS = ROLLOUT_EVIDENCE_SCENARIOS.filter((scenario) => scenario !== 'unchanged' && scenario !== 'daily-audit')
export const REQUIRED_ROLLOUT_EVIDENCE_FIELDS = [
  'deployment',
  'execution',
  'comparison',
  'scenario',
  'parity',
  'classification',
  'checkpoint',
  'timings',
  'freshness',
  'resources',
  'work',
  'fullSnapshot',
  'lease',
  'fallback',
  'audit',
  'promotion',
  'error',
]

export function parseRolloutEvidence(value) {
  if (!isRecord(value)) throw new Error('Rollout evidence must be an object')
  if (value.artifactKind !== ROLLOUT_EVIDENCE_KIND || value.schemaVersion !== 1) throw new Error('Invalid rollout evidence identity')
  if (!ROLLOUT_EVIDENCE_CLASSES.includes(value.evidenceClass)) throw new Error('Invalid rollout evidence class')
  assertSafeId(value.commit, 'commit')
  assertSafeId(value.runId, 'runId')
  requiredIso(value.expiresAt, 'expiresAt')
  for (const field of REQUIRED_ROLLOUT_EVIDENCE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) throw new Error(`Rollout evidence is missing ${field}`)
  }
  if (!ROLLOUT_EVIDENCE_SCENARIOS.includes(value.scenario)) throw new Error('Invalid rollout evidence scenario')
  for (const field of ['deployment', 'execution', 'comparison', 'parity', 'classification', 'checkpoint', 'timings', 'freshness', 'resources', 'work', 'fullSnapshot', 'lease', 'audit', 'promotion']) {
    if (!isRecord(value[field])) throw new Error(`Rollout evidence ${field} must be an object`)
  }
  if (value.fallback !== null && !isRecord(value.fallback)) throw new Error('Rollout evidence fallback must be an object or null')
  if (value.error !== null && !isRecord(value.error) && typeof value.error !== 'string') throw new Error('Rollout evidence error must be an object, string, or null')
  if (typeof value.comparison.equal !== 'boolean') throw new Error('Rollout evidence comparison.equal must be boolean')
  if (typeof value.comparison.partial !== 'boolean') throw new Error('Rollout evidence comparison.partial must be boolean')
  requireStrings(value.deployment, ['deploymentId', 'environmentId', 'serviceId'], 'deployment')
  requireStrings(value.execution, ['startedAt', 'finishedAt', 'result', 'mode', 'cause'], 'execution')
  requiredIso(value.execution.startedAt, 'execution.startedAt')
  requiredIso(value.execution.finishedAt, 'execution.finishedAt')
  requireNonNegativeNumber(value.execution.durationMs, 'execution.durationMs')
  if (typeof value.comparison.authoritative !== 'boolean') throw new Error('Rollout evidence comparison.authoritative must be boolean')
  for (const field of ['semantic', 'state', 'checkpoint']) requireBooleanOrNull(value.parity[field], `parity.${field}`)
  if (typeof value.classification.kind !== 'string') throw new Error('Rollout evidence classification.kind must be a string')
  for (const field of ['addedCount', 'changedCount', 'removedCount']) requireNonNegative(value.classification[field], `classification.${field}`)
  if (typeof value.checkpoint.applicable !== 'boolean') throw new Error('Rollout evidence checkpoint.applicable must be boolean')
  requireNonNegativeNumber(value.timings.totalMs, 'timings.totalMs')
  for (const field of ['cpuSeconds', 'memoryGbSeconds', 'peakRssBytes']) requireNumberOrNull(value.resources[field], `resources.${field}`)
  if (!Array.isArray(value.resources.processes)) throw new Error('Rollout evidence resources.processes must be an array')
  for (const [index, process] of value.resources.processes.entries()) {
    if (!isRecord(process) || typeof process.processKey !== 'string' || process.processKey.length === 0) {
      throw new Error(`Rollout evidence resources.processes[${index}] is invalid`)
    }
    requireNonNegative(process.sampleCount, `resources.processes[${index}].sampleCount`)
    for (const field of ['cpuSeconds', 'memoryGbSeconds', 'peakRssBytes']) {
      requireNumberOrNull(process[field], `resources.processes[${index}].${field}`)
    }
  }
  for (const field of ['providerRequests', 'providerRetries', 'broadFetches', 'fullBuilds', 'incrementalBuilds', 'bytesRead', 'bytesWritten', 'objectsRead', 'objectsWritten', 'uploads']) {
    requireNumberOrNull(value.work[field], `work.${field}`)
  }
  if (typeof value.fullSnapshot.authoritative !== 'boolean') throw new Error('Rollout evidence fullSnapshot.authoritative must be boolean')
  if (!Array.isArray(value.timings.stages)) throw new Error('Rollout evidence timings.stages must be an array')
  for (const field of ['providerAvailableAt', 'detectedAt', 'publishedAt']) requireIsoOrNull(value.freshness[field], `freshness.${field}`)
  if (typeof value.lease.applicable !== 'boolean') throw new Error('Rollout evidence lease.applicable must be boolean')
  if (value.lease.applicable) {
    requireStrings(value.lease, ['owner', 'etag'], 'lease')
    requireNonNegative(value.lease.fencingToken, 'lease.fencingToken')
  }
  if (typeof value.promotion.completed !== 'boolean') throw new Error('Rollout evidence promotion.completed must be boolean')
  if (typeof value.audit.due !== 'boolean' || typeof value.audit.clean !== 'boolean') throw new Error('Rollout evidence audit due/clean must be boolean')
  if (value.execution.result === 'completed' && value.error !== null) throw new Error('Completed rollout evidence cannot contain an error')
  if (value.comparison.equal && value.comparison.partial) throw new Error('Equal rollout evidence cannot be partial')
  if (value.comparison.equal && (!value.comparison.authoritative
    || value.parity.semantic !== true || value.parity.state !== true || value.parity.checkpoint !== true)) {
    throw new Error('Equal rollout evidence requires authoritative exact parity')
  }
  if (value.execution.result === 'completed' && value.scenario === 'unchanged' && value.promotion.completed) {
    throw new Error('Unchanged rollout evidence cannot contain a promotion')
  } else if (value.execution.result === 'completed' && value.scenario === 'daily-audit'
    && (value.execution.cause !== 'daily-audit'
      || value.classification.kind !== 'no-change'
      || value.classification.addedCount + value.classification.changedCount + value.classification.removedCount !== 0
      || value.comparison.authoritative !== true || value.comparison.equal !== true
      || value.parity.semantic !== true || value.parity.state !== true || value.parity.checkpoint !== true
      || value.fullSnapshot.authoritative !== true || value.promotion.completed !== true
      || value.audit.due !== true || value.audit.clean !== true || value.fallback !== null)) {
    throw new Error('Daily audit rollout evidence requires zero mutations and an exact authoritative full promotion')
  } else if (value.execution.result === 'completed' && value.comparison.authoritative
    && ROLLOUT_CHANGED_SCENARIOS.includes(value.scenario)
    && value.classification.addedCount + value.classification.changedCount + value.classification.removedCount < 1) {
    throw new Error('Changed rollout evidence requires at least one classified mutation')
  }
  return value
}

export function createRefreshRolloutEvidence(metrics, input = {}) {
  const classification = stageOutput(metrics, 'classification')
  const parity = stageOutput(metrics, 'semantic-parity')
  const promotion = lastStage(metrics, 'promotion')
  const auditReceipt = lastStage(metrics, 'full-audit-receipt')
  const fullAudit = stageOutput(metrics, 'full-audit-object')
  const crunch = stageOutput(metrics, 'crunch')
  const result = metrics?.result === 'completed' || metrics?.result === 'unchanged'
    ? 'completed'
    : String(metrics?.result ?? 'failed')
  const scenario = input.scenario ?? scenarioForClassification(classification.classification, metrics?.cause)
  const semantic = booleanOrNull(parity.parity)
  const state = booleanOrNull(parity.stateParity)
  const checkpointParity = booleanOrNull(parity.checkpointParity)
  const authoritative = semantic !== null && state !== null && checkpointParity !== null
  return createRolloutEvidence({
    metrics,
    evidenceClass: input.evidenceClass,
    commit: input.commit,
    expiresAt: input.expiresAt,
    deployment: input.deployment,
    execution: {
      result,
      startedAt: metrics.startedAt,
      finishedAt: metrics.finishedAt,
      durationMs: metrics.durationMs,
      mode: metrics.mode,
      cause: metrics.cause,
    },
    comparison: {
      authoritative,
      equal: authoritative && semantic === true && state === true && checkpointParity === true,
      partial: [semantic, state, checkpointParity].some((value) => value !== null)
        && !authoritative,
    },
    scenario,
    parity: { semantic, state, checkpoint: checkpointParity },
    classification: {
      kind: String(classification.classification ?? 'unclassified'),
      addedCount: nonNegativeInteger(classification.addedCount),
      changedCount: nonNegativeInteger(classification.changedCount),
      removedCount: nonNegativeInteger(classification.removedCount),
    },
    checkpoint: {
      applicable: Boolean(metrics?.checkpoint?.applicable),
      ...metrics?.checkpoint,
    },
    timings: { totalMs: nonNegativeNumber(metrics?.durationMs), stages: metrics?.stages ?? [] },
    freshness: metrics?.freshness ?? {},
    resources: {
      cpuSeconds: numberOrNull(metrics?.resources?.cpuSeconds),
      memoryGbSeconds: numberOrNull(metrics?.resources?.memoryGbSeconds),
      peakRssBytes: numberOrNull(metrics?.resources?.peakRssBytes),
      processes: Array.isArray(metrics?.resources?.processes) ? metrics.resources.processes : [],
    },
    work: normalizedWork(metrics?.work),
    fullSnapshot: {
      authoritative: Boolean(crunch.fullSnapshotWritten),
      ...fullAudit,
    },
    lease: {
      applicable: Boolean(metrics?.coordination),
      ...(metrics?.coordination ?? {}),
    },
    fallback: metrics?.checkpoint?.fallbackReason
      ? { reason: String(metrics.checkpoint.fallbackReason) }
      : null,
    audit: {
      due: metrics?.cause === 'daily-audit',
      clean: metrics?.cause === 'daily-audit'
        && semantic === true && state === true && checkpointParity === true
        && auditReceipt?.result === 'completed',
      ...auditReceipt?.output,
    },
    promotion: {
      completed: promotion?.result === 'completed',
      ...(promotion?.output ?? {}),
    },
    error: metrics?.error
      ? { message: String(metrics.error), errors: Array.isArray(metrics.errors) ? metrics.errors : [String(metrics.error)] }
      : null,
  })
}

export function createRolloutEvidence(input = {}) {
  const metrics = input.metrics ?? {}
  return parseRolloutEvidence({
    artifactKind: ROLLOUT_EVIDENCE_KIND,
    schemaVersion: 1,
    evidenceClass: input.evidenceClass,
    commit: input.commit,
    runId: input.runId ?? metrics.runId,
    expiresAt: input.expiresAt,
    deployment: input.deployment ?? {},
    execution: input.execution ?? {
      result: metrics.result,
      startedAt: metrics.startedAt,
      finishedAt: metrics.finishedAt,
      durationMs: metrics.durationMs,
      mode: metrics.mode,
      cause: metrics.cause,
    },
    comparison: input.comparison ?? {},
    scenario: input.scenario,
    parity: input.parity ?? stageOutput(metrics, 'semantic-parity'),
    classification: input.classification ?? stageOutput(metrics, 'classification'),
    checkpoint: input.checkpoint ?? metrics.checkpoint ?? {},
    timings: input.timings ?? { totalMs: metrics.durationMs, stages: metrics.stages ?? [] },
    freshness: input.freshness ?? metrics.freshness ?? {},
    resources: input.resources ?? metrics.resources ?? {},
    work: input.work ?? metrics.work ?? {},
    fullSnapshot: input.fullSnapshot ?? stageOutput(metrics, 'full-audit-object'),
    lease: input.lease ?? {
      applicable: Boolean(metrics.coordination),
      ...(metrics.coordination ?? {}),
    },
    fallback: input.fallback ?? null,
    audit: input.audit ?? stageOutput(metrics, 'full-audit-receipt'),
    promotion: input.promotion ?? stageOutput(metrics, 'promotion'),
    error: Object.prototype.hasOwnProperty.call(input, 'error') ? input.error : metrics.error ?? null,
  })
}

export function rolloutEvidenceKey(value) {
  const evidence = parseRolloutEvidence(value)
  return `ops/rollout-evidence/runs/${safeObjectPath(evidence.commit)}/${safeObjectPath(evidence.runId)}.json`
}

export function rolloutEvidenceDigest(value) {
  return createHash('sha256').update(canonicalJsonFor(parseRolloutEvidence(value))).digest('hex')
}

export function createEvidenceAuthority(value, key = rolloutEvidenceKey(value)) {
  const evidence = parseRolloutEvidence(value)
  return {
    key,
    sha256: rolloutEvidenceDigest(evidence),
    commit: evidence.commit,
    deploymentId: evidence.deployment.deploymentId,
    runId: evidence.runId,
    recordedAt: evidence.execution.finishedAt,
    expiresAt: evidence.expiresAt,
    evidenceClass: evidence.evidenceClass,
    value: evidence,
  }
}

export function parseEvidenceAuthority(authority, { kind = ROLLOUT_EVIDENCE_KIND, keyPrefix = 'ops/rollout-evidence/runs/' } = {}) {
  if (!isRecord(authority) || !isRecord(authority.value)) throw new Error('Evidence authority must bind an immutable value')
  requireStrings(authority, ['key', 'sha256', 'commit', 'deploymentId', 'runId', 'recordedAt', 'expiresAt', 'evidenceClass'], 'authority')
  if (!authority.key.startsWith(keyPrefix) || !/^[a-f0-9]{64}$/.test(authority.sha256)) throw new Error('Evidence authority key or digest is invalid')
  if (!Number.isFinite(Date.parse(authority.recordedAt)) || !Number.isFinite(Date.parse(authority.expiresAt))
    || Date.parse(authority.expiresAt) <= Date.parse(authority.recordedAt)
    || !ROLLOUT_EVIDENCE_CLASSES.includes(authority.evidenceClass)) throw new Error('Evidence authority metadata is invalid')
  if (authority.value.artifactKind !== kind) throw new Error(`Evidence authority kind must be ${kind}`)
  const digest = createHash('sha256').update(canonicalJsonFor(authority.value)).digest('hex')
  if (digest !== authority.sha256) throw new Error('Evidence authority digest mismatch')
  if (authority.value.commit !== authority.commit || authority.value.runId !== authority.runId
    || authority.value.expiresAt !== authority.expiresAt || authority.value.evidenceClass !== authority.evidenceClass
    || authority.value.deployment?.deploymentId !== authority.deploymentId) throw new Error('Evidence authority metadata mismatch')
  return authority
}

export async function publishRolloutEvidence(value, {
  config = bucketConfigFromEnv(),
  client = createBucketClient(config),
  readJson = readBucketJson,
  writeJson = writeBucketJson,
} = {}) {
  const evidence = parseRolloutEvidence(value)
  const key = rolloutEvidenceKey(evidence)
  const write = await writeJson(key, evidence, { config, client, ifNoneMatch: '*' })
  const authority = createEvidenceAuthority(evidence, key)
  if (write.written) return { status: 'uploaded', key, etag: write.etag, evidence, authority, sha256: authority.sha256 }
  if (!write.conflict) throw new Error('Unable to write rollout evidence')
  const existing = await readJson(key, { config, client })
  if (!existing.found) throw new Error('Rollout evidence conflicted but could not be read')
  const parsed = parseRolloutEvidence(existing.value)
  if (canonicalJsonFor(parsed) !== canonicalJsonFor(evidence)) throw new Error(`Conflicting immutable rollout evidence for ${evidence.runId}`)
  return { status: 'unchanged', key, etag: existing.etag, evidence: parsed, authority, sha256: authority.sha256 }
}

export function aggregateRolloutEvidence(values) {
  if (!Array.isArray(values)) throw new Error('Rollout evidence aggregation input must be an array')
  const byRun = new Map()
  for (const raw of values) {
    const evidence = parseRolloutEvidence(raw)
    const existing = byRun.get(evidence.runId)
    if (existing && canonicalJsonFor(existing) !== canonicalJsonFor(evidence)) {
      throw new Error(`Conflicting rollout evidence for duplicate runId ${evidence.runId}`)
    }
    byRun.set(evidence.runId, evidence)
  }
  const runs = [...byRun.values()].sort((left, right) => executionDate(left).localeCompare(executionDate(right)) || left.runId.localeCompare(right.runId))
  const live = runs.filter((run) => run.evidenceClass === 'live')
  const changed = live.filter((run) => ROLLOUT_CHANGED_SCENARIOS.includes(run.scenario))
  const unchanged = live.filter((run) => run.scenario === 'unchanged')
  const dailyAudits = live.filter((run) => run.scenario === 'daily-audit')
  const failures = runs.filter(hasRolloutFailure)
  const unchangedDurations = unchanged.map((run) => knownNumber(run.timings.totalMs ?? run.execution.durationMs)).filter((value) => value !== null)
  return {
    schemaVersion: 1,
    runCount: runs.length,
    liveRunCount: live.length,
    changedCount: changed.length,
    unchangedCount: unchanged.length,
    dailyAuditCount: dailyAudits.length,
    failureCount: failures.length,
    failureRunIds: failures.map((run) => run.runId),
    scenarioCoverage: [...new Set(runs.map((run) => run.scenario))].sort(),
    liveScenarioCoverage: [...new Set(live.map((run) => run.scenario))].sort(),
    unchangedZeroWorkCount: unchanged.filter(hasZeroBroadWork).length,
    unchangedTimingsMs: {
      p50: percentile(unchangedDurations, 0.50),
      p95: percentile(unchangedDurations, 0.95),
    },
    runs,
  }
}

export function hasRolloutFailure(run) {
  if (run.scenario === 'unchanged') {
    return run.error !== null
      || run.execution.result !== 'completed'
      || run.comparison.authoritative !== false
      || run.comparison.equal !== false
      || run.comparison.partial !== false
      || run.parity.semantic !== null
      || run.parity.state !== null
      || run.parity.checkpoint !== null
      || run.fallback !== null
      || run.promotion.completed
      || !hasZeroBroadWork(run)
  }
  return run.error !== null
    || run.execution.result !== 'completed'
    || run.comparison.equal !== true
    || run.comparison.partial === true
    || run.fallback !== null
}

export function hasZeroBroadWork(run) {
  const work = run.work ?? {}
  return ['broadFetches', 'fullBuilds', 'incrementalBuilds', 'uploads', 'bytesWritten', 'objectsWritten']
    .every((field) => work[field] === 0)
}

export function percentile(values, quantile) {
  if (!Array.isArray(values) || values.length === 0) return null
  const sorted = values.toSorted((left, right) => left - right)
  const rank = Math.max(0, Math.ceil(quantile * sorted.length) - 1)
  return sorted[rank]
}

function executionDate(run) {
  return typeof run.execution?.finishedAt === 'string' ? run.execution.finishedAt : ''
}

function stageOutput(metrics, name) {
  return metrics?.stages?.findLast?.((stage) => stage.name === name)?.output ?? {}
}

function lastStage(metrics, name) {
  return metrics?.stages?.findLast?.((stage) => stage.name === name)
}

function scenarioForClassification(classification, cause) {
  if (classification === 'no-change' && cause === 'daily-audit') return 'daily-audit'
  if (classification === 'no-change' || classification === undefined) return 'unchanged'
  if (classification === 'latest-append') return 'latest-append'
  if (classification === 'same-day-insertion') return 'same-day-insertion'
  if (classification === 'historical-correction') return 'historical-correction'
  return 'historical-correction'
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null
}

function numberOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : null
}

function nonNegativeNumber(value) {
  return numberOrNull(value) ?? 0
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function normalizedWork(work = {}) {
  return Object.fromEntries(
    ['providerRequests', 'providerRetries', 'broadFetches', 'fullBuilds', 'incrementalBuilds', 'bytesRead', 'bytesWritten', 'objectsRead', 'objectsWritten', 'uploads']
      .map((field) => [field, numberOrNull(work?.[field])]),
  )
}

function knownNumber(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : null
}

function requiredIso(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid rollout evidence ${label}`)
  return value
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(value)) throw new Error(`Invalid rollout evidence ${label}`)
}

function requireStrings(value, fields, label) {
  for (const field of fields) if (typeof value?.[field] !== 'string' || value[field].length === 0) throw new Error(`Rollout evidence ${label}.${field} must be a string`)
}

function requireNonNegative(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Rollout evidence ${label} must be a non-negative integer`)
}

function requireNonNegativeNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Rollout evidence ${label} must be a non-negative number`)
}

function requireNumberOrNull(value, label) {
  if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error(`Rollout evidence ${label} must be a number or null`)
}

function requireBooleanOrNull(value, label) {
  if (value !== null && typeof value !== 'boolean') throw new Error(`Rollout evidence ${label} must be boolean or null`)
}

function requireIsoOrNull(value, label) {
  if (value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) {
    throw new Error(`Rollout evidence ${label} must be an ISO date or null`)
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function main(args) {
  if (args.length === 0) throw new Error('Provide one or more rollout evidence JSON files')
  const values = []
  for (const path of args) {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    values.push(...(Array.isArray(parsed) ? parsed : [parsed]))
  }
  process.stdout.write(`${JSON.stringify(aggregateRolloutEvidence(values), null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2))
