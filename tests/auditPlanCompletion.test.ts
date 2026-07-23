import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { auditPlanCompletion, PLAN_COMPLETION_REQUIREMENTS } from '../scripts/audit-plan-completion.mjs'
import { createRailwayCostReport } from '../scripts/railway-cost-report.mjs'
import { writeImplementationAuthority } from '../scripts/rollout-implementation-evidence.mjs'
import {
  createProductionActionReceipt,
  PRODUCTION_ACTION_IDS,
  type ProductionActionId,
} from '../scripts/rollout-production-action.mjs'
import {
  createLatestGamePerformanceEvidence,
  createProductionFreshnessEvidence,
  createStorageMeasurementEvidence,
} from '../scripts/rollout-production-evidence.mjs'
import { immutableReference } from '../scripts/rollout-gate.mjs'
import { evaluateRolloutShadowGate } from '../scripts/rollout-shadow-gate.mjs'
import {
  createImplementationRepositoryFixture,
  generateNativeImplementationEvidence,
} from './implementationEvidenceTestFixtures.ts'
import { rolloutEvidence, sevenDayEvidence } from './rolloutTestFixtures.ts'

function implementationProof(runId: string, tests: string[], result: 'proved' | 'contradicted') {
  return {
    artifactKind: 'ranking-rollout-implementation-test-evidence',
    schemaVersion: 1,
    evidenceClass: 'production-like-fixture',
    commit: 'abc123',
    deploymentId: 'fixture-deployment',
    runId,
    recordedAt: '2026-07-23T00:00:00Z',
    expiresAt: '2027-01-01T00:00:00Z',
    result,
    tests,
  }
}

test('completion audit ignores caller acceptance IDs, inline proof, and never-written attachments', async () => {
  const acceptance = JSON.parse(await readFile(new URL('../docs/rollout-acceptance.json', import.meta.url), 'utf8'))
  const fake = implementationProof('fake', ['provider-request-retry'], 'proved')
  const result = await auditPlanCompletion({
    acceptance: { ...acceptance, requirements: [{ id: 'caller-invented', required: true }] },
    evidence: [
      fake,
      immutableReference(fake, 'ops/rollout-tests/never-written.json'),
    ],
    expectedCommit: 'abc123',
    expectedDeploymentId: 'fixture-deployment',
    resolveReference: async () => ({ found: false }),
    now: '2026-07-23T01:00:00Z',
  })
  assert.equal(result.complete, false)
  assert.equal(result.requirements.some((entry) => entry.id === 'caller-invented'), false)
  assert.equal(result.requirements.find((entry) => entry.id === 'provider-request-retry')?.status, 'missing')
  assert.equal(result.exitCode, 1)
})

test('descriptive acceptance mirror stays aligned with script-owned completion contracts', async () => {
  const acceptance = JSON.parse(await readFile(new URL('../docs/rollout-acceptance.json', import.meta.url), 'utf8'))
  assert.deepEqual(
    acceptance.requirements.map((entry: { id: string }) => entry.id),
    PLAN_COMPLETION_REQUIREMENTS.map((entry) => entry.id),
  )
})

test('completion audit proves seven repository requirements only from explicit commit-bound local authority', async () => {
  const acceptance = JSON.parse(await readFile(new URL('../docs/rollout-acceptance.json', import.meta.url), 'utf8'))
  const fixture = await createImplementationRepositoryFixture()
  const authority = join(fixture.root, '.rollout-evidence')
  try {
    const values = await generateNativeImplementationEvidence(fixture.root, fixture.commit)
    assert.deepEqual(values.map((value) => [value.requirementId, value.result]), [
      ['provider-request-retry', 'proved'],
      ['complete-immutable-receipts', 'proved'],
      ['storage-delivery-contract', 'proved'],
      ['retention-safety-contract', 'proved'],
      ['authoritative-full-fallback', 'proved'],
      ['atomic-generation-publication', 'proved'],
      ['ranking-provenance-contract', 'proved'],
    ])
    await writeImplementationAuthority(values, { authorityDir: authority, repositoryRoot: fixture.root })
    const forgedBucket = immutableReference(values[0], 'ops/rollout-tests/forged-local-proof.json')
    const bucketOnly = await auditPlanCompletion({
      acceptance,
      evidence: [forgedBucket],
      expectedCommit: fixture.commit,
      expectedDeploymentId: 'fixture-deployment',
      subjectCommit: fixture.commit,
      resolveReference: async () => ({ found: true, value: values[0] }),
      now: '2026-07-23T01:00:00Z',
    })
    assert.equal(bucketOnly.requirements.find((entry) => entry.id === 'provider-request-retry')?.status, 'missing')

    const result = await auditPlanCompletion({
      acceptance,
      expectedCommit: fixture.commit,
      subjectCommit: fixture.commit,
      implementationAuthorityDir: authority,
      repositoryRoot: fixture.root,
      now: '2026-07-23T01:00:00Z',
    })
    assert.equal(result.requirements.find((entry) => entry.id === 'provider-request-retry')?.status, 'proved')
    assert.equal(result.requirements.find((entry) => entry.id === 'complete-immutable-receipts')?.status, 'proved')
    assert.deepEqual(result.counts, {
      proved: 7,
      contradicted: 0,
      missing: 0,
      'live-pending': 8,
      'authorization-gated': 5,
    })
    assert.equal(result.exitCode, 1)

    await assert.rejects(auditPlanCompletion({
      acceptance,
      subjectCommit: '0'.repeat(40),
      implementationAuthorityDir: authority,
      repositoryRoot: fixture.root,
    }), /ENOENT|subject/)
  } finally {
    await fixture.cleanup()
  }
})

test('measured production usage requires a strict native report resolved from authoritative storage', async () => {
  const acceptance = JSON.parse(await readFile(new URL('../docs/rollout-acceptance.json', import.meta.url), 'utf8'))
  const report = createRailwayCostReport({
    commit: 'abc123',
    deploymentId: 'deployment-1',
    runId: 'live-cost',
    evidenceClass: 'live',
    recordedAt: '2026-07-23T00:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
    measured: { cpuSeconds: 1, memoryGbSeconds: 2, volumeGbSeconds: 0, serviceEgressGb: 3, bucketGbMonths: 4 },
    measurement: { publicTrafficExcluded: true },
  })
  const inline = await auditPlanCompletion({
    acceptance,
    evidence: [report],
    expectedCommit: 'abc123',
    expectedDeploymentId: 'deployment-1',
    resolveReference: async () => ({ found: false }),
    now: '2026-07-23T01:00:00Z',
  })
  assert.equal(inline.requirements.find((entry) => entry.id === 'railway-nontraffic-monthly-under-five')?.status, 'live-pending')

  const incomplete = createRailwayCostReport({
    commit: 'abc123',
    deploymentId: 'deployment-1',
    runId: 'incomplete-cost',
    evidenceClass: 'live',
    recordedAt: '2026-07-23T00:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
    measured: { cpuSeconds: 1, memoryGbSeconds: 2, serviceEgressGb: 3 },
  })
  const incompleteReference = immutableReference(incomplete, 'ops/rollout-cost/incomplete-cost.json')
  const incompleteAudit = await auditPlanCompletion({
    acceptance,
    evidence: [incompleteReference],
    expectedCommit: 'abc123',
    expectedDeploymentId: 'deployment-1',
    resolveReference: async () => ({ found: true, value: incomplete }),
    now: '2026-07-23T01:00:00Z',
  })
  assert.equal(incompleteAudit.requirements.find((entry) => entry.id === 'railway-nontraffic-monthly-under-five')?.status, 'live-pending')

  const reference = immutableReference(report, 'ops/rollout-cost/live-cost.json')
  const stored = await auditPlanCompletion({
    acceptance,
    evidence: [reference],
    expectedCommit: 'abc123',
    expectedDeploymentId: 'deployment-1',
    resolveReference: async (key: string) => key === reference.key
      ? { found: true, value: report }
      : { found: false },
    now: '2026-07-23T01:00:00Z',
  })
  assert.equal(stored.requirements.find((entry) => entry.id === 'railway-nontraffic-monthly-under-five')?.status, 'proved')
})

test('completion audit accepts a native shadow decision and rejects stored invented criteria', async () => {
  const acceptance = JSON.parse(await readFile(new URL('../docs/rollout-acceptance.json', import.meta.url), 'utf8'))
  const liveRuns = sevenDayEvidence().map((run) => rolloutEvidence({ ...run, evidenceClass: 'live' }))
  const nativeShadow = evaluateRolloutShadowGate({
    evidence: liveRuns,
    commit: 'abc123',
    deploymentId: 'deployment-1',
    runId: 'native-shadow',
    evidenceClass: 'live',
    expiresAt: '2027-01-01T00:00:00Z',
    now: '2026-07-23T00:00:00Z',
  })
  assert.equal(nativeShadow.allowed, true)
  const nativeReference = immutableReference(nativeShadow, 'ops/rollout-gates/native-shadow.json')
  const nativeAudit = await auditPlanCompletion({
    acceptance,
    evidence: [nativeReference],
    expectedCommit: 'abc123',
    expectedDeploymentId: 'deployment-1',
    resolveReference: async (key: string) => key === nativeReference.key
      ? { found: true, value: nativeShadow }
      : { found: false },
    now: '2026-07-23T01:00:00Z',
  })
  assert.equal(nativeAudit.requirements.find((entry) => entry.id === 'seven-day-live-shadow')?.status, 'proved')

  const forgedShadow = { ...nativeShadow, criteria: { invented: true }, allowed: true }
  const forgedShadowReference = immutableReference(forgedShadow, 'ops/rollout-gates/forged-shadow.json')
  const forgedShadowAudit = await auditPlanCompletion({
    acceptance,
    evidence: [forgedShadowReference],
    expectedCommit: 'abc123',
    expectedDeploymentId: 'deployment-1',
    resolveReference: async () => ({ found: true, value: forgedShadow }),
    now: '2026-07-23T01:00:00Z',
  })
  assert.equal(forgedShadowAudit.requirements.find((entry) => entry.id === 'seven-day-live-shadow')?.status, 'live-pending')

  const forgedGate = {
    artifactKind: 'ranking-five-minute-rollout-gate-decision',
    schemaVersion: 1,
    evidenceClass: 'live',
    runId: 'forged-gate',
    expiresAt: '2027-01-01T00:00:00Z',
    affected: true,
    allowed: true,
    evaluatedAt: '2026-07-23T00:00:00.000Z',
    recordedAt: '2026-07-23T00:00:00.000Z',
    commit: 'abc123',
    deploymentId: 'deployment-1',
    criteria: { invented: true },
    shadow: nativeShadow,
  }
  const forgedGateReference = immutableReference(forgedGate, 'ops/rollout-gates/forged-gate.json')
  const forgedGateAudit = await auditPlanCompletion({
    acceptance,
    evidence: [forgedGateReference],
    expectedCommit: 'abc123',
    expectedDeploymentId: 'deployment-1',
    resolveReference: async () => ({ found: true, value: forgedGate }),
    now: '2026-07-23T01:00:00Z',
  })
  assert.equal(forgedGateAudit.requirements.find((entry) => entry.id === 'deployment-bound-gate')?.status, 'live-pending')
})

test('storage-resolved native live measurements and action-specific receipts can prove every pending row', async () => {
  const acceptance = JSON.parse(await readFile(new URL('../docs/rollout-acceptance.json', import.meta.url), 'utf8'))
  const common = {
    commit: 'abc123',
    deploymentId: 'deployment-1',
    environmentId: 'environment-1',
    recordedAt: '2026-07-23T02:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
  }
  const live = [
    createProductionFreshnessEvidence({
      ...common,
      runId: 'freshness',
      measurement: {
        sampleCount: 10,
        providerAvailabilityBasis: 'scored-provider-first-capable-response',
        upstreamDelayExcluded: true,
        upstreamDelayP95Ms: 1000,
        p95FreshnessMs: 10000,
      },
    }),
    createLatestGamePerformanceEvidence({
      ...common,
      runId: 'latest-game',
      measurement: {
        sampleCount: 10,
        computeMs: 1000,
        peakRssBytes: 1024,
        uploadedBytes: 1024,
        fullSnapshotRewriteBytes: 0,
      },
    }),
    createStorageMeasurementEvidence({
      ...common,
      runId: 'storage',
      measurement: {
        fullLogicalGenerationCompressedBytes: 1024,
        postMigration: true,
        bucketBytes: 2048,
        retainedManifestCount: 50,
        retainedManifestsResolvable: true,
      },
    }),
  ]
  const actions = PRODUCTION_ACTION_IDS.map(nativeActionReceipt)
  const all = [...live, ...actions]
  const references = all.map((value) => immutableReference(value, `ops/completion/${value.runId}.json`))
  const stored = new Map(references.map((reference, index) => [reference.key, all[index]]))
  const audit = await auditPlanCompletion({
    acceptance,
    evidence: references,
    expectedCommit: 'abc123',
    expectedDeploymentId: 'deployment-1',
    resolveReference: async (key: string) => ({ found: stored.has(key), value: stored.get(key) }),
    now: '2026-07-23T03:00:00.000Z',
  })
  for (const id of [
    'production-freshness-p95-15m',
    'latest-game-performance-bounds',
    'compressed-generation-storage-bounds',
    ...PRODUCTION_ACTION_IDS,
  ]) {
    assert.equal(audit.requirements.find((entry) => entry.id === id)?.status, 'proved')
  }

  const cadence = actions[0]
  const cadenceReference = references[live.length]
  const crossAction = await auditPlanCompletion({
    acceptance,
    evidence: [cadenceReference],
    expectedCommit: 'abc123',
    expectedDeploymentId: 'deployment-1',
    resolveReference: async () => ({ found: true, value: cadence }),
    now: '2026-07-23T03:00:00.000Z',
  })
  assert.equal(crossAction.requirements.find((entry) => entry.id === 'five-minute-cadence')?.status, 'proved')
  assert.equal(crossAction.requirements.find((entry) => entry.id === 'production-config-change')?.status, 'authorization-gated')

  const genericGate = {
    artifactKind: 'ranking-five-minute-rollout-gate-decision',
    schemaVersion: 1,
    commit: 'abc123',
    deploymentId: 'deployment-1',
    runId: 'generic-gate',
    evidenceClass: 'live',
    recordedAt: '2026-07-23T02:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
    allowed: true,
    criteria: { invented: true },
  }
  const genericReference = immutableReference(genericGate, 'ops/completion/generic-gate.json')
  const genericAudit = await auditPlanCompletion({
    acceptance,
    evidence: [genericReference, ...actions],
    expectedCommit: 'abc123',
    expectedDeploymentId: 'deployment-1',
    resolveReference: async (key: string) => key === genericReference.key
      ? { found: true, value: genericGate }
      : { found: false },
    now: '2026-07-23T03:00:00.000Z',
  })
  assert.equal(genericAudit.requirements.find((entry) => entry.id === 'five-minute-cadence')?.status, 'authorization-gated')
})

function nativeActionReceipt(actionId: ProductionActionId) {
  const digest = 'a'.repeat(64)
  return createProductionActionReceipt({
    commit: 'abc123',
    deploymentId: 'deployment-1',
    environmentId: 'environment-1',
    runId: `action-${actionId}`,
    recordedAt: '2026-07-23T02:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
    actionId,
    approval: {
      approvalId: `approval-${actionId}`,
      approvedBy: 'human@example.invalid',
      approvedAt: '2026-07-23T00:00:00.000Z',
      inventorySha256: actionId === 'retention-delete-execution' ? digest : null,
    },
    execution: {
      environment: 'production',
      executedAt: '2026-07-23T01:00:00.000Z',
      succeeded: true,
    },
    assertions: {
      'five-minute-cadence': { active: true, intervalMinutes: 5, mode: 'gated' },
      'production-config-change': { applied: true },
      'incremental-cutover': { active: true },
      'storage-delivery-production-cutover': { presignedDeliveryActive: true, proxyFallbackActive: true },
      'retention-delete-execution': { deleteCompleted: true, inventorySha256: digest },
    }[actionId],
  })
}
