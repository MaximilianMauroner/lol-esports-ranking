import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { auditPlanCompletion, PLAN_COMPLETION_REQUIREMENTS } from '../scripts/audit-plan-completion.mjs'
import { createRailwayCostReport } from '../scripts/railway-cost-report.mjs'
import { writeImplementationAuthority } from '../scripts/rollout-implementation-evidence.mjs'
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
