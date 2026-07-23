import assert from 'node:assert/strict'
import test from 'node:test'
import { createProbeCoordinationEvidence } from '../scripts/probe-refresh-coordination.mjs'
import {
  createAuditGateEvidence,
  createRollbackRehearsalEvidence,
  createRolloutGateReceipt,
  evaluateRolloutGate,
  immutableReference,
  parseImmutableReference,
  parseRolloutGateDecision,
  ROLLOUT_GATE_KIND,
} from '../scripts/rollout-gate.mjs'
import { readRolloutGateReceipt } from '../scripts/validate-rollout-gate.mjs'
import { evidenceAuthority, rolloutEvidence, sevenDayEvidence } from './rolloutTestFixtures.ts'

const missing = (key: string) => ({ key, sha256: '0'.repeat(64) })

function fixtureGateAuthority() {
  const value = createRolloutGateReceipt({
    artifactKind: ROLLOUT_GATE_KIND,
    evidenceClass: 'production-like-fixture',
    commit: 'abc123',
    deploymentId: 'deployment-1',
    runId: 'fixture-gate',
    issuedAt: '2026-07-22T00:00:00Z',
    expiresAt: '2026-08-01T00:00:00Z',
    proofs: {
      runs: [missing('ops/rollout-evidence/runs/abc123/missing.json')],
      latestAppendRunId: 'fixture-append',
      auditRunId: 'fixture-audit',
      auditEvidence: missing('ops/rollout-audits/missing.json'),
      coordination: missing('ops/rollout-probes/evidence/missing.json'),
      rollback: missing('ops/rollout-rollback/missing.json'),
    },
  })
  return evidenceAuthority(value, 'ops/rollout-gates/fixture-gate.json')
}

test('cadence above five minutes is unaffected and inline outer proof is forbidden', async () => {
  assert.equal((await evaluateRolloutGate({ intervalMinutes: 6 })).allowed, true)
  await assert.rejects(evaluateRolloutGate({
    intervalMinutes: 5,
    mode: 'gated',
    commit: 'abc123',
    deploymentId: 'deployment-1',
    receiptAuthority: fixtureGateAuthority().value,
    resolveReference: async () => ({ found: false }),
  }), /outer authority/)
})

test('nested proof references are re-read and a never-written key fails closed', async () => {
  await assert.rejects(evaluateRolloutGate({
    intervalMinutes: 5,
    mode: 'gated',
    commit: 'abc123',
    deploymentId: 'deployment-1',
    receiptAuthority: fixtureGateAuthority(),
    resolveReference: async () => ({ found: false }),
    now: '2026-07-23T00:00:00Z',
  }), /missing from storage/)
  assert.throws(() => parseImmutableReference({
    ...missing('ops/rollout-evidence/runs/abc123/fake.json'),
    value: { proved: true },
  }), /only key and sha256/)
})

test('native coordination, rollback, audit, and gate constructors align on strict schemas', () => {
  const common = {
    evidenceClass: 'production-like-fixture',
    commit: 'abc123',
    deploymentId: 'deployment-1',
    runId: 'fixture-proof',
    recordedAt: '2026-07-22T00:00:00Z',
    expiresAt: '2026-08-01T00:00:00Z',
  }
  const coordination = createProbeCoordinationEvidence({
    ...common,
    observations: {
      acquire: { acquired: true },
      exclusion: { reason: 'active-probe' },
      renew: { renewed: true },
      takeover: { acquired: true },
      staleAttempt: { reason: 'stale-probe' },
      release: { released: true },
      concurrentResults: [{ acquired: true }, { acquired: false }],
      fencingTokens: [1, 2],
    },
  })
  const rollback = createRollbackRehearsalEvidence({
    ...common,
    completed: true,
    expectedGenerationId: 'generation-1',
    restoredGenerationId: 'generation-1',
  })
  const audit = createAuditGateEvidence({
    ...common,
    generationId: 'generation-1',
    clean: true,
    comparison: { semantic: true, state: true, checkpoint: true },
    auditReceipt: missing('audits/days/2026-07-22.json'),
  })
  assert.equal(coordination.artifactKind, 'ranking-rollout-probe-coordination-evidence')
  assert.equal(rollback.artifactKind, 'ranking-rollout-rollback-rehearsal')
  assert.equal(audit.artifactKind, 'ranking-rollout-audit-evidence')
  assert.deepEqual(immutableReference(rollback, 'ops/rollout-rollback/fixture.json'), {
    key: 'ops/rollout-rollback/fixture.json',
    sha256: immutableReference(rollback, 'ops/rollout-rollback/fixture.json').sha256,
  })
})

test('all canonical nested proof kinds resolve from storage without trusting inline bodies', async () => {
  const digest = 'a'.repeat(64)
  const objectReference = { key: `raw/objects/sha256/${digest}`, sha256: digest, bytes: 10, compressedBytes: 20, storageEncoding: 'gzip' }
  const comparisonRuns = sevenDayEvidence().map((run) => rolloutEvidence({ ...run, evidenceClass: 'live' }))
  const appendRun = comparisonRuns.find((run) => run.runId === 'latest-append-2026-07-05')
  assert.ok(appendRun)
  const auditRun = rolloutEvidence({
    evidenceClass: 'live',
    scenario: 'daily-audit',
    runId: 'fixture-audit',
    execution: {
      result: 'completed', startedAt: '2026-07-07T01:00:00Z',
      finishedAt: '2026-07-07T01:00:01Z', durationMs: 1000,
    },
    audit: { due: true, clean: true },
    promotion: { completed: true, generationId: 'generation-1' },
  })
  const fullAudit = {
    artifactKind: 'full-ranking-audit-receipt',
    schemaVersion: 1,
    auditDate: '2026-07-07',
    cause: 'daily-audit',
    generationId: 'generation-1',
    runId: 'generation-1',
    fencingToken: 1,
    promotedAt: '2026-07-07T01:00:00.000Z',
    model: { version: 'model-1', configHash: digest },
    sourceReceipt: objectReference,
    rawLedger: { ...objectReference, key: `state/objects/sha256/${digest}` },
    fullSnapshot: { ...objectReference, key: `audits/objects/sha256/${digest}` },
  }
  const common = {
    evidenceClass: 'live',
    commit: 'abc123',
    deploymentId: 'deployment-1',
    runId: 'fixture-proof',
    recordedAt: '2026-07-07T01:00:00Z',
    expiresAt: '2027-01-01T00:00:00Z',
  }
  const audit = createAuditGateEvidence({
    ...common,
    generationId: 'generation-1',
    clean: true,
    comparison: { semantic: true, state: true, checkpoint: true },
    auditReceipt: immutableReference(fullAudit, 'audits/days/2026-07-07.json'),
  })
  const coordination = createProbeCoordinationEvidence({
    ...common,
    observations: {
      acquire: { acquired: true }, exclusion: { reason: 'active-probe' }, renew: { renewed: true },
      takeover: { acquired: true }, staleAttempt: { reason: 'stale-probe' }, release: { released: true },
      concurrentResults: [{ acquired: true }, { acquired: false }], fencingTokens: [1, 2],
    },
  })
  const rollback = createRollbackRehearsalEvidence({
    ...common,
    completed: true,
    expectedGenerationId: 'generation-1',
    restoredGenerationId: 'generation-1',
  })
  const stored = new Map<string, Record<string, unknown>>([
    ...comparisonRuns.map((run) => [`ops/rollout-evidence/runs/abc123/${run.runId}.json`, run] as const),
    ['ops/rollout-evidence/runs/abc123/fixture-audit.json', auditRun],
    ['ops/rollout-audits/fixture.json', audit],
    ['audits/days/2026-07-07.json', fullAudit],
    ['ops/rollout-probes/evidence/fixture.json', coordination],
    ['ops/rollout-rollback/fixture.json', rollback],
  ])
  const receipt = createRolloutGateReceipt({
    evidenceClass: 'live',
    commit: 'abc123',
    deploymentId: 'deployment-1',
    runId: 'fixture-gate',
    issuedAt: '2026-07-07T01:00:00Z',
    expiresAt: '2027-01-01T00:00:00Z',
    proofs: {
      runs: [
        ...comparisonRuns.map((run) => immutableReference(run, `ops/rollout-evidence/runs/abc123/${run.runId}.json`)),
        immutableReference(auditRun, 'ops/rollout-evidence/runs/abc123/fixture-audit.json'),
      ],
      latestAppendRunId: appendRun.runId,
      auditRunId: 'fixture-audit',
      auditEvidence: immutableReference(audit, 'ops/rollout-audits/fixture.json'),
      coordination: immutableReference(coordination, 'ops/rollout-probes/evidence/fixture.json'),
      rollback: immutableReference(rollback, 'ops/rollout-rollback/fixture.json'),
    },
  })
  const decision = await evaluateRolloutGate({
    intervalMinutes: 5,
    mode: 'gated',
    commit: 'abc123',
    deploymentId: 'deployment-1',
    receiptAuthority: evidenceAuthority(receipt, 'ops/rollout-gates/fixture-resolved.json'),
    resolveReference: async (key: string) => stored.has(key)
      ? { found: true, value: stored.get(key) }
      : { found: false },
    now: '2026-07-08T00:00:00Z',
  })
  assert.equal(decision.allowed, true)
  assert.equal(decision.criteria.authorityBoundRuns, true)
  assert.equal(decision.criteria.latestAppendExact, true)
  assert.equal(decision.criteria.recentAudit, true)
  assert.equal(parseRolloutGateDecision(decision), decision)
  assert.throws(() => parseRolloutGateDecision({
    ...decision,
    criteria: { invented: true },
    allowed: true,
  }), /criteria/)

  const fixtureReceipt = createRolloutGateReceipt({
    ...receipt,
    evidenceClass: 'production-like-fixture',
  })
  const fixtureDecision = await evaluateRolloutGate({
    intervalMinutes: 5,
    mode: 'gated',
    commit: 'abc123',
    deploymentId: 'deployment-1',
    receiptAuthority: evidenceAuthority(fixtureReceipt, 'ops/rollout-gates/fixture-class.json'),
    resolveReference: async (key: string) => stored.has(key)
      ? { found: true, value: stored.get(key) }
      : { found: false },
    now: '2026-07-08T00:00:00Z',
  })
  assert.equal(fixtureDecision.criteria.liveAuthority, false)
  assert.equal(fixtureDecision.allowed, false)
})

test('gate receipt loader accepts only a digest-bound bucket reference', async () => {
  const authority = fixtureGateAuthority()
  await assert.rejects(readRolloutGateReceipt(JSON.stringify(authority.value), {
    config: {},
    client: {},
    readJson: async () => ({ found: false }),
  }), /inline\/local receipts are forbidden/)
  await assert.rejects(readRolloutGateReceipt({
    key: authority.key,
    sha256: authority.sha256,
    value: authority.value,
  }, {
    config: {},
    client: {},
    readJson: async () => ({ found: true, value: authority.value }),
  }), /inline\/local receipts are forbidden/)
  const loaded = await readRolloutGateReceipt(JSON.stringify({ key: authority.key, sha256: authority.sha256 }), {
    config: {},
    client: {},
    readJson: async () => ({ found: true, value: authority.value }),
  })
  assert.equal(loaded?.sha256, authority.sha256)
})
