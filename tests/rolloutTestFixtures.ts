import { createHash } from 'node:crypto'
import { canonicalJsonFor } from '../scripts/public-artifact-storage.mjs'
import type { RolloutEvidence, RolloutScenario } from '../scripts/rollout-evidence.mjs'

export function rolloutEvidence(overrides: Partial<RolloutEvidence> = {}): RolloutEvidence {
  const scenario = overrides.scenario ?? 'latest-append'
  const cheapUnchanged = scenario === 'unchanged'
  const dailyAudit = scenario === 'daily-audit'
  const zeroMutation = cheapUnchanged || dailyAudit
  const base: RolloutEvidence = {
    artifactKind: 'ranking-rollout-run-evidence',
    schemaVersion: 1,
    evidenceClass: 'production-like-fixture',
    commit: 'abc123',
    runId: `${scenario}-run`,
    expiresAt: '2027-01-01T00:00:00Z',
    deployment: { deploymentId: 'deployment-1', environmentId: 'environment-1', serviceId: 'service-1' },
    execution: { result: 'completed', startedAt: '2026-07-01T00:00:00Z', finishedAt: '2026-07-01T00:00:01Z', durationMs: 1000, mode: 'shadow', cause: dailyAudit ? 'daily-audit' : 'production-like-fixture' },
    comparison: { authoritative: !cheapUnchanged, equal: !cheapUnchanged, partial: false },
    scenario,
    parity: {
      semantic: cheapUnchanged ? null : true,
      state: cheapUnchanged ? null : true,
      checkpoint: cheapUnchanged ? null : true,
    },
    classification: { kind: zeroMutation ? 'no-change' : scenario, addedCount: zeroMutation ? 0 : 1, changedCount: 0, removedCount: 0 },
    checkpoint: { applicable: !zeroMutation },
    timings: { totalMs: cheapUnchanged ? 1000 : 2000, stages: [] },
    freshness: { providerAvailableAt: null, detectedAt: null, publishedAt: cheapUnchanged ? null : '2026-07-01T00:00:01Z' },
    resources: {
      cpuSeconds: 1,
      memoryGbSeconds: 2,
      peakRssBytes: 3,
      processes: [{ processKey: 'fixture:worker', sampleCount: 3, cpuSeconds: 1, memoryGbSeconds: 2, peakRssBytes: 3 }],
    },
    work: {
      providerRequests: 1,
      providerRetries: 0,
      broadFetches: cheapUnchanged ? 0 : 1,
      fullBuilds: cheapUnchanged ? 0 : 1,
      incrementalBuilds: 0,
      bytesRead: cheapUnchanged ? 0 : 1,
      bytesWritten: cheapUnchanged ? 0 : 1,
      objectsRead: cheapUnchanged ? 0 : 1,
      objectsWritten: cheapUnchanged ? 0 : 1,
      uploads: cheapUnchanged ? 0 : 1,
    },
    fullSnapshot: { authoritative: !cheapUnchanged },
    lease: { applicable: true, owner: 'fixture-owner', fencingToken: 1, etag: 'fixture-etag' },
    fallback: null,
    audit: { due: dailyAudit, clean: dailyAudit },
    promotion: { completed: !cheapUnchanged },
    error: null,
  }
  return {
    ...base,
    ...overrides,
    deployment: { ...base.deployment, ...overrides.deployment },
    execution: { ...base.execution, ...overrides.execution },
    comparison: { ...base.comparison, ...overrides.comparison },
    parity: { ...base.parity, ...overrides.parity },
    classification: { ...base.classification, ...overrides.classification },
    checkpoint: { ...base.checkpoint, ...overrides.checkpoint },
    timings: { ...base.timings, ...overrides.timings },
    freshness: { ...base.freshness, ...overrides.freshness },
    resources: { ...base.resources, ...overrides.resources },
    work: { ...base.work, ...overrides.work },
    fullSnapshot: { ...base.fullSnapshot, ...overrides.fullSnapshot },
    lease: { ...base.lease, ...overrides.lease },
    audit: { ...base.audit, ...overrides.audit },
    promotion: { ...base.promotion, ...overrides.promotion },
  }
}

export function sevenDayEvidence(commit = 'abc123') {
  return Array.from({ length: 7 }, (_, index) => {
    const date = `2026-07-${String(index + 1).padStart(2, '0')}`
    const changedScenario = (['latest-append', 'same-day-insertion', 'historical-correction', 'tournament-transition'] as RolloutScenario[])[index % 4]
    return ([changedScenario, 'unchanged'] as RolloutScenario[]).map((scenario) => rolloutEvidence({
      commit,
      scenario,
      runId: `${scenario}-${date}`,
      execution: { result: 'completed', startedAt: `${date}T00:00:00Z`, finishedAt: `${date}T00:00:01Z`, durationMs: 1000 + index },
      timings: { totalMs: scenario === 'unchanged' ? 1000 + index : 2000 + index },
    }))
  }).flat()
}

export function evidenceAuthority(value: Record<string, unknown>, key = `ops/fixtures/${String(value.runId)}.json`) {
  return {
    key,
    sha256: createHash('sha256').update(canonicalJsonFor(value)).digest('hex'),
    commit: String(value.commit),
    deploymentId: String(value.deploymentId ?? (value.deployment as { deploymentId?: string })?.deploymentId),
    runId: String(value.runId),
    recordedAt: String((value.execution as { finishedAt?: string })?.finishedAt ?? value.recordedAt ?? value.evaluatedAt ?? value.issuedAt),
    expiresAt: String(value.expiresAt),
    evidenceClass: String(value.evidenceClass),
    value,
  }
}
