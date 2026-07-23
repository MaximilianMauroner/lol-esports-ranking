import { createHash } from 'node:crypto'
import { parseFullAuditReceipt } from './full-audit-storage.mjs'
import { canonicalJsonFor } from './public-artifact-storage.mjs'
import { parseProbeCoordinationEvidence } from './probe-refresh-coordination.mjs'
import { parseRolloutEvidence } from './rollout-evidence.mjs'
import {
  evaluateRolloutShadowGate,
  parseRolloutShadowGateDecision,
} from './rollout-shadow-gate.mjs'

export const ROLLOUT_GATE_KIND = 'ranking-five-minute-rollout-gate-receipt'
export const ROLLOUT_GATE_DECISION_KIND = 'ranking-five-minute-rollout-gate-decision'
export const ROLLOUT_GATE_DECISION_CRITERIA = [
  'gatedMode',
  'liveAuthority',
  'exactCommit',
  'exactDeployment',
  'unexpired',
  'authorityBoundRuns',
  'shadowEvidence',
  'sevenChangedAndUnchanged',
  'unchangedP95UnderTenSeconds',
  'unchangedZeroBroadWork',
  'latestAppendExact',
  'recentAudit',
  'liveCoordination',
  'rollbackRehearsal',
  'leaseFencing',
]
export const AUDIT_GATE_EVIDENCE_KIND = 'ranking-rollout-audit-evidence'
export const ROLLBACK_EVIDENCE_KIND = 'ranking-rollout-rollback-rehearsal'

export async function evaluateRolloutGate({
  intervalMinutes,
  mode,
  commit,
  deploymentId,
  receiptAuthority,
  resolveReference,
  now = new Date(),
} = {}) {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes > 5) return { allowed: true, affected: false, criteria: {} }
  if (typeof resolveReference !== 'function') throw new Error('Five-minute gate requires immutable storage resolution')
  const outer = parseResolvedAuthority(receiptAuthority, ROLLOUT_GATE_KIND, 'ops/rollout-gates/')
  const receipt = parseRolloutGateReceipt(outer.value)
  const nowMs = new Date(now).getTime()
  const runProofs = await Promise.all(receipt.proofs.runs.map((reference) => resolveImmutableReference(
    reference,
    { kind: 'ranking-rollout-run-evidence', keyPrefix: 'ops/rollout-evidence/runs/', resolveReference },
  )))
  const runs = runProofs.map((proof) => parseRolloutEvidence(proof.value))
  const auditProof = await resolveImmutableReference(receipt.proofs.auditEvidence, {
    kind: AUDIT_GATE_EVIDENCE_KIND,
    keyPrefix: 'ops/rollout-audits/',
    resolveReference,
  })
  const audit = parseAuditGateEvidence(auditProof.value)
  const auditReceiptProof = await resolveImmutableReference(audit.auditReceipt, {
    kind: 'full-ranking-audit-receipt',
    keyPrefix: 'audits/days/',
    resolveReference,
  })
  const auditReceipt = parseFullAuditReceipt(auditReceiptProof.value)
  const coordinationProof = await resolveImmutableReference(receipt.proofs.coordination, {
    kind: 'ranking-rollout-probe-coordination-evidence',
    keyPrefix: 'ops/rollout-probes/evidence/',
    resolveReference,
  })
  const coordination = parseProbeCoordinationEvidence(coordinationProof.value)
  const rollbackProof = await resolveImmutableReference(receipt.proofs.rollback, {
    kind: ROLLBACK_EVIDENCE_KIND,
    keyPrefix: 'ops/rollout-rollback/',
    resolveReference,
  })
  const rollback = parseRollbackRehearsalEvidence(rollbackProof.value)
  const shadow = evaluateRolloutShadowGate({
    evidence: runs,
    commit,
    deploymentId,
    runId: receipt.runId,
    evidenceClass: receipt.evidenceClass,
    expiresAt: receipt.expiresAt,
    now,
  })
  const append = runs.find((run) => run.runId === receipt.proofs.latestAppendRunId)
  const auditRun = runs.find((run) => run.runId === receipt.proofs.auditRunId)
  const recentAuditMaxAgeMs = Number.isFinite(receipt.policy?.recentAuditMaxAgeMs)
    ? receipt.policy.recentAuditMaxAgeMs
    : 36 * 60 * 60_000
  const auditAge = nowMs - Date.parse(auditRun?.execution.finishedAt ?? '')
  const boundRun = (run) => run.commit === commit
    && run.deployment.deploymentId === deploymentId
    && Date.parse(run.expiresAt) > nowMs
  const liveRuns = runs.filter((run) => run.evidenceClass === 'live')
  const commonLive = (value) => value.commit === commit
    && value.deploymentId === deploymentId
    && value.evidenceClass === 'live'
    && Date.parse(value.expiresAt) > nowMs
  const criteria = {
    gatedMode: mode === 'gated',
    liveAuthority: outer.evidenceClass === 'live' && receipt.evidenceClass === 'live',
    exactCommit: outer.commit === commit && receipt.commit === commit,
    exactDeployment: outer.deploymentId === deploymentId && receipt.deploymentId === deploymentId,
    unexpired: Date.parse(outer.expiresAt) > nowMs && Date.parse(receipt.expiresAt) > nowMs,
    authorityBoundRuns: liveRuns.length >= 14 && runs.every(boundRun),
    shadowEvidence: shadow.allowed,
    sevenChangedAndUnchanged: shadow.counts.changed >= 7 && shadow.counts.unchanged >= 7,
    unchangedP95UnderTenSeconds: shadow.unchangedP95Ms !== null && shadow.unchangedP95Ms < 10_000,
    unchangedZeroBroadWork: shadow.criteria.unchangedZeroBroadWork,
    latestAppendExact: Boolean(append && append.evidenceClass === 'live' && boundRun(append)
      && append.scenario === 'latest-append'
      && append.classification.addedCount === 1
      && append.classification.changedCount === 0
      && append.classification.removedCount === 0
      && append.parity.semantic === true && append.parity.state === true && append.parity.checkpoint === true),
    recentAudit: Boolean(auditRun && auditRun.evidenceClass === 'live' && boundRun(auditRun)
      && auditRun.scenario === 'daily-audit'
      && commonLive(audit) && auditAge >= 0 && auditAge <= recentAuditMaxAgeMs
      && audit.clean === true && auditRun.audit.clean === true
      && audit.generationId === auditRun.promotion.generationId
      && auditReceipt.generationId === audit.generationId),
    liveCoordination: commonLive(coordination) && coordination.status === 'completed',
    rollbackRehearsal: commonLive(rollback)
      && rollback.completed === true
      && rollback.restoredGenerationId === rollback.expectedGenerationId,
    leaseFencing: coordination.lease.monotonic === true && coordination.lease.staleRejected === true,
  }
  const evaluatedAt = new Date(now).toISOString()
  return {
    artifactKind: ROLLOUT_GATE_DECISION_KIND,
    schemaVersion: 1,
    evidenceClass: receipt.evidenceClass,
    runId: receipt.runId,
    expiresAt: receipt.expiresAt,
    affected: true,
    allowed: Object.values(criteria).every(Boolean),
    evaluatedAt,
    recordedAt: evaluatedAt,
    commit,
    deploymentId,
    criteria,
    shadow,
  }
}

export function parseRolloutGateDecision(value) {
  assertExactKeys(value, [
    'artifactKind', 'schemaVersion', 'evidenceClass', 'runId', 'expiresAt', 'affected',
    'allowed', 'evaluatedAt', 'recordedAt', 'commit', 'deploymentId', 'criteria', 'shadow',
  ], 'rollout gate decision')
  assertCommonEvidence(value, ROLLOUT_GATE_DECISION_KIND)
  if (value.affected !== true) throw new Error('Rollout gate decision must be cadence-affected')
  requireString(value.evaluatedAt, 'rollout gate evaluatedAt')
  if (!Number.isFinite(Date.parse(value.evaluatedAt)) || value.recordedAt !== value.evaluatedAt) {
    throw new Error('Rollout gate recordedAt must equal evaluatedAt')
  }
  parseDecisionCriteria(value.criteria)
  if (typeof value.allowed !== 'boolean' || value.allowed !== Object.values(value.criteria).every(Boolean)) {
    throw new Error('Rollout gate allowed must equal the criteria conjunction')
  }
  const shadow = parseRolloutShadowGateDecision(value.shadow)
  for (const field of ['commit', 'deploymentId', 'runId', 'evidenceClass', 'expiresAt', 'evaluatedAt']) {
    if (shadow[field] !== value[field]) throw new Error(`Rollout gate shadow ${field} mismatch`)
  }
  if (value.criteria.liveAuthority !== (value.evidenceClass === 'live')
    || value.criteria.shadowEvidence !== shadow.allowed
    || value.criteria.sevenChangedAndUnchanged !== (shadow.counts.changed >= 7 && shadow.counts.unchanged >= 7)
    || value.criteria.unchangedP95UnderTenSeconds !== (shadow.unchangedP95Ms !== null && shadow.unchangedP95Ms < 10_000)
    || value.criteria.unchangedZeroBroadWork !== shadow.criteria.unchangedZeroBroadWork) {
    throw new Error('Rollout gate criteria do not match the shadow summary')
  }
  return value
}

export function createRolloutGateReceipt(input = {}) {
  return parseRolloutGateReceipt({
    artifactKind: ROLLOUT_GATE_KIND,
    schemaVersion: 1,
    evidenceClass: input.evidenceClass,
    commit: input.commit,
    deploymentId: input.deploymentId,
    runId: input.runId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    proofs: input.proofs,
    policy: input.policy ?? {},
  })
}

export function parseRolloutGateReceipt(value) {
  assertCommonEvidence(value, ROLLOUT_GATE_KIND, { recordedAtField: 'issuedAt' })
  assertExactKeys(value, ['artifactKind', 'schemaVersion', 'evidenceClass', 'commit', 'deploymentId', 'runId', 'issuedAt', 'expiresAt', 'proofs', 'policy'], 'rollout gate receipt')
  if (!record(value.proofs) || !Array.isArray(value.proofs.runs)) throw new Error('Rollout gate receipt proofs are invalid')
  assertExactKeys(value.proofs, ['runs', 'latestAppendRunId', 'auditRunId', 'auditEvidence', 'coordination', 'rollback'], 'rollout gate proofs')
  value.proofs.runs.forEach((reference) => parseImmutableReference(reference))
  for (const field of ['latestAppendRunId', 'auditRunId']) requireString(value.proofs[field], `proofs.${field}`)
  for (const field of ['auditEvidence', 'coordination', 'rollback']) parseImmutableReference(value.proofs[field])
  if (!record(value.policy)) throw new Error('Rollout gate policy must be an object')
  const policyKeys = Object.keys(value.policy)
  if (policyKeys.some((key) => key !== 'recentAuditMaxAgeMs')
    || ('recentAuditMaxAgeMs' in value.policy
      && (!Number.isFinite(value.policy.recentAuditMaxAgeMs) || value.policy.recentAuditMaxAgeMs <= 0))) {
    throw new Error('Rollout gate policy is invalid')
  }
  return value
}

export function createAuditGateEvidence(input = {}) {
  return parseAuditGateEvidence({
    artifactKind: AUDIT_GATE_EVIDENCE_KIND,
    schemaVersion: 1,
    evidenceClass: input.evidenceClass,
    commit: input.commit,
    deploymentId: input.deploymentId,
    runId: input.runId,
    recordedAt: input.recordedAt,
    expiresAt: input.expiresAt,
    generationId: input.generationId,
    clean: input.clean,
    comparison: input.comparison,
    auditReceipt: input.auditReceipt,
  })
}

export function parseAuditGateEvidence(value) {
  assertCommonEvidence(value, AUDIT_GATE_EVIDENCE_KIND)
  assertExactKeys(value, ['artifactKind', 'schemaVersion', 'evidenceClass', 'commit', 'deploymentId', 'runId', 'recordedAt', 'expiresAt', 'generationId', 'clean', 'comparison', 'auditReceipt'], 'audit gate evidence')
  requireString(value.generationId, 'audit generationId')
  if (value.clean !== true || !record(value.comparison)
    || !['semantic', 'state', 'checkpoint'].every((field) => value.comparison[field] === true)) {
    throw new Error('Audit gate evidence requires exact clean comparison')
  }
  assertExactKeys(value.comparison, ['semantic', 'state', 'checkpoint'], 'audit gate comparison')
  parseImmutableReference(value.auditReceipt)
  return value
}

export function createRollbackRehearsalEvidence(input = {}) {
  return parseRollbackRehearsalEvidence({
    artifactKind: ROLLBACK_EVIDENCE_KIND,
    schemaVersion: 1,
    evidenceClass: input.evidenceClass,
    commit: input.commit,
    deploymentId: input.deploymentId,
    runId: input.runId,
    recordedAt: input.recordedAt,
    expiresAt: input.expiresAt,
    completed: input.completed,
    expectedGenerationId: input.expectedGenerationId,
    restoredGenerationId: input.restoredGenerationId,
  })
}

export function parseRollbackRehearsalEvidence(value) {
  assertCommonEvidence(value, ROLLBACK_EVIDENCE_KIND)
  assertExactKeys(value, ['artifactKind', 'schemaVersion', 'evidenceClass', 'commit', 'deploymentId', 'runId', 'recordedAt', 'expiresAt', 'completed', 'expectedGenerationId', 'restoredGenerationId'], 'rollback rehearsal evidence')
  if (value.completed !== true) throw new Error('Rollback rehearsal must be completed')
  requireString(value.expectedGenerationId, 'rollback expectedGenerationId')
  requireString(value.restoredGenerationId, 'rollback restoredGenerationId')
  return value
}

export function immutableReference(value, key) {
  return parseImmutableReference({
    key,
    sha256: createHash('sha256').update(canonicalJsonFor(value)).digest('hex'),
  })
}

export function parseImmutableReference(reference) {
  if (!record(reference) || Object.keys(reference).sort().join(',') !== 'key,sha256') {
    throw new Error('Immutable proof must contain only key and sha256')
  }
  requireString(reference.key, 'proof key')
  if (!/^[a-f0-9]{64}$/.test(reference.sha256)) throw new Error('Immutable proof digest is invalid')
  return reference
}

export async function resolveImmutableReference(reference, {
  kind,
  keyPrefix,
  resolveReference,
} = {}) {
  const parsed = parseImmutableReference(reference)
  if (!parsed.key.startsWith(keyPrefix)) throw new Error('Immutable proof key is outside its authority prefix')
  const result = await resolveReference(parsed.key)
  const found = result?.found === undefined ? result !== undefined : result.found
  const value = result?.found === undefined ? result : result.value
  if (!found || !record(value)) throw new Error(`Immutable proof is missing from storage: ${parsed.key}`)
  const digest = createHash('sha256').update(canonicalJsonFor(value)).digest('hex')
  if (digest !== parsed.sha256) throw new Error(`Immutable proof digest mismatch: ${parsed.key}`)
  if (value.artifactKind !== kind) throw new Error(`Immutable proof kind mismatch: ${parsed.key}`)
  return { ...parsed, value }
}

export function parseResolvedAuthority(authority, kind, keyPrefix) {
  if (!record(authority) || !record(authority.value)) throw new Error('Resolved immutable outer authority is required')
  const reference = parseImmutableReference({ key: authority.key, sha256: authority.sha256 })
  if (!reference.key.startsWith(keyPrefix)) throw new Error('Resolved outer authority key is invalid')
  if (createHash('sha256').update(canonicalJsonFor(authority.value)).digest('hex') !== reference.sha256) {
    throw new Error('Resolved outer authority digest mismatch')
  }
  if (authority.value.artifactKind !== kind) throw new Error('Resolved outer authority kind mismatch')
  const value = parseRolloutGateReceipt(authority.value)
  for (const field of ['commit', 'deploymentId', 'runId', 'expiresAt', 'evidenceClass']) {
    if (authority[field] !== value[field]) throw new Error(`Resolved outer authority ${field} mismatch`)
  }
  if (authority.recordedAt !== value.issuedAt) throw new Error('Resolved outer authority timestamp mismatch')
  return authority
}

export async function assertFiveMinuteRolloutGate(options) {
  const decision = await evaluateRolloutGate(options)
  if (!decision.allowed) {
    throw new Error(`Refresh cadence of five minutes or less requires ${Object.entries(decision.criteria)
      .filter(([, ok]) => !ok).map(([key]) => key).join(', ')}`)
  }
  return true
}

function assertCommonEvidence(value, kind, { recordedAtField = 'recordedAt' } = {}) {
  if (!record(value) || value.artifactKind !== kind || value.schemaVersion !== 1) throw new Error(`Invalid ${kind}`)
  for (const field of ['commit', 'deploymentId', 'runId', recordedAtField, 'expiresAt', 'evidenceClass']) {
    requireString(value[field], `${kind}.${field}`)
  }
  if (!['live', 'production-like-fixture'].includes(value.evidenceClass)) throw new Error(`Invalid ${kind} evidence class`)
  const recordedAt = Date.parse(value[recordedAtField])
  const expiresAt = Date.parse(value.expiresAt)
  if (!Number.isFinite(recordedAt) || !Number.isFinite(expiresAt) || expiresAt <= recordedAt) {
    throw new Error(`Invalid ${kind} evidence dates`)
  }
  return value
}

function parseDecisionCriteria(value) {
  assertExactKeys(value, ROLLOUT_GATE_DECISION_CRITERIA, 'rollout gate criteria')
  for (const key of ROLLOUT_GATE_DECISION_CRITERIA) {
    if (typeof value[key] !== 'boolean') throw new Error(`Invalid rollout gate criteria.${key}`)
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a string`)
}

function assertExactKeys(value, keys, label) {
  if (!record(value)) throw new Error(`Invalid ${label}`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid ${label} fields`)
  }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
