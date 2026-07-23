import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createLatestGamePerformanceEvidence,
  createProductionFreshnessEvidence,
  createStorageMeasurementEvidence,
  isLatestGamePerformanceProof,
  isProductionFreshnessProof,
  isStorageMeasurementProof,
  parseLatestGamePerformanceEvidence,
  parseProductionFreshnessEvidence,
  parseStorageMeasurementEvidence,
} from '../scripts/rollout-production-evidence.mjs'

const common = {
  commit: 'abc123',
  deploymentId: 'deployment-1',
  environmentId: 'environment-1',
  recordedAt: '2026-07-23T01:00:00.000Z',
  expiresAt: '2026-08-01T00:00:00.000Z',
}

test('native live production measurements strictly prove all three plan thresholds', () => {
  const freshness = createProductionFreshnessEvidence({
    ...common,
    runId: 'freshness',
    measurement: {
      sampleCount: 20,
      providerAvailabilityBasis: 'scored-provider-first-capable-response',
      upstreamDelayExcluded: true,
      upstreamDelayP95Ms: 120000,
      p95FreshnessMs: 899999,
    },
  })
  const latest = createLatestGamePerformanceEvidence({
    ...common,
    runId: 'latest-game',
    measurement: {
      sampleCount: 10,
      computeMs: 14999,
      peakRssBytes: (750 * 1024 * 1024) - 1,
      uploadedBytes: (2 * 1024 * 1024) - 1,
      fullSnapshotRewriteBytes: 0,
    },
  })
  const storage = createStorageMeasurementEvidence({
    ...common,
    runId: 'storage',
    measurement: {
      fullLogicalGenerationCompressedBytes: 2.5 * 1024 * 1024,
      postMigration: true,
      bucketBytes: (350 * 1024 * 1024) - 1,
      retainedManifestCount: 50,
      retainedManifestsResolvable: true,
    },
  })
  assert.equal(parseProductionFreshnessEvidence(freshness), freshness)
  assert.equal(parseLatestGamePerformanceEvidence(latest), latest)
  assert.equal(parseStorageMeasurementEvidence(storage), storage)
  assert.equal(isProductionFreshnessProof(freshness), true)
  assert.equal(isLatestGamePerformanceProof(latest), true)
  assert.equal(isStorageMeasurementProof(storage), true)
})

test('production measurement thresholds and forged schemas fail closed', () => {
  const freshness = createProductionFreshnessEvidence({
    ...common,
    runId: 'freshness-limit',
    measurement: {
      sampleCount: 1,
      providerAvailabilityBasis: 'scored-provider-first-capable-response',
      upstreamDelayExcluded: true,
      upstreamDelayP95Ms: 0,
      p95FreshnessMs: 900001,
    },
  })
  assert.equal(isProductionFreshnessProof(freshness), false)

  const latest = createLatestGamePerformanceEvidence({
    ...common,
    runId: 'latest-limit',
    measurement: {
      sampleCount: 1,
      computeMs: 15000,
      peakRssBytes: 750 * 1024 * 1024,
      uploadedBytes: 2 * 1024 * 1024,
      fullSnapshotRewriteBytes: 1,
    },
  })
  assert.equal(isLatestGamePerformanceProof(latest), false)

  const storage = createStorageMeasurementEvidence({
    ...common,
    runId: 'storage-limit',
    measurement: {
      fullLogicalGenerationCompressedBytes: (2.5 * 1024 * 1024) + 1,
      postMigration: false,
      bucketBytes: 350 * 1024 * 1024,
      retainedManifestCount: 1,
      retainedManifestsResolvable: false,
    },
  })
  assert.equal(isStorageMeasurementProof(storage), false)
  assert.throws(() => parseProductionFreshnessEvidence({ ...freshness, invented: true }), /unexpected or missing/)
  assert.throws(() => parseLatestGamePerformanceEvidence({ ...latest, evidenceClass: 'production-like-fixture' }), /identity/)
  assert.throws(() => parseStorageMeasurementEvidence({
    ...storage,
    measurement: { ...storage.measurement, invented: true },
  }), /unexpected or missing/)
})
