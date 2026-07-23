export const PRODUCTION_FRESHNESS_EVIDENCE_KIND = 'ranking-rollout-production-freshness-evidence'
export const LATEST_GAME_PERFORMANCE_EVIDENCE_KIND = 'ranking-rollout-latest-game-performance-evidence'
export const STORAGE_MEASUREMENT_EVIDENCE_KIND = 'ranking-rollout-storage-measurement-evidence'

const COMMON_KEYS = [
  'artifactKind', 'schemaVersion', 'evidenceClass', 'commit', 'deploymentId',
  'environmentId', 'runId', 'recordedAt', 'expiresAt', 'measurement',
]

export function createProductionFreshnessEvidence(input = {}) {
  return parseProductionFreshnessEvidence({
    ...commonEvidence(input, PRODUCTION_FRESHNESS_EVIDENCE_KIND),
    measurement: {
      sampleCount: input.measurement?.sampleCount,
      providerAvailabilityBasis: input.measurement?.providerAvailabilityBasis,
      upstreamDelayExcluded: input.measurement?.upstreamDelayExcluded,
      upstreamDelayP95Ms: input.measurement?.upstreamDelayP95Ms,
      p95FreshnessMs: input.measurement?.p95FreshnessMs,
    },
  })
}

export function parseProductionFreshnessEvidence(value) {
  parseCommon(value, PRODUCTION_FRESHNESS_EVIDENCE_KIND)
  assertExactKeys(value.measurement, [
    'sampleCount', 'providerAvailabilityBasis', 'upstreamDelayExcluded',
    'upstreamDelayP95Ms', 'p95FreshnessMs',
  ], 'production freshness measurement')
  positiveInteger(value.measurement.sampleCount, 'production freshness sampleCount')
  if (value.measurement.providerAvailabilityBasis !== 'scored-provider-first-capable-response'
    || value.measurement.upstreamDelayExcluded !== true) {
    throw new Error('Production freshness must separate upstream delay from scored-provider availability')
  }
  nonNegativeNumber(value.measurement.upstreamDelayP95Ms, 'production freshness upstreamDelayP95Ms')
  nonNegativeNumber(value.measurement.p95FreshnessMs, 'production freshness p95FreshnessMs')
  return value
}

export function isProductionFreshnessProof(value) {
  try {
    return parseProductionFreshnessEvidence(value).measurement.p95FreshnessMs <= 15 * 60_000
  } catch {
    return false
  }
}

export function createLatestGamePerformanceEvidence(input = {}) {
  return parseLatestGamePerformanceEvidence({
    ...commonEvidence(input, LATEST_GAME_PERFORMANCE_EVIDENCE_KIND),
    measurement: {
      sampleCount: input.measurement?.sampleCount,
      computeMs: input.measurement?.computeMs,
      peakRssBytes: input.measurement?.peakRssBytes,
      uploadedBytes: input.measurement?.uploadedBytes,
      fullSnapshotRewriteBytes: input.measurement?.fullSnapshotRewriteBytes,
    },
  })
}

export function parseLatestGamePerformanceEvidence(value) {
  parseCommon(value, LATEST_GAME_PERFORMANCE_EVIDENCE_KIND)
  assertExactKeys(value.measurement, [
    'sampleCount', 'computeMs', 'peakRssBytes', 'uploadedBytes', 'fullSnapshotRewriteBytes',
  ], 'latest-game performance measurement')
  positiveInteger(value.measurement.sampleCount, 'latest-game sampleCount')
  for (const field of ['computeMs', 'peakRssBytes', 'uploadedBytes', 'fullSnapshotRewriteBytes']) {
    nonNegativeNumber(value.measurement[field], `latest-game ${field}`)
  }
  return value
}

export function isLatestGamePerformanceProof(value) {
  try {
    const measurement = parseLatestGamePerformanceEvidence(value).measurement
    return measurement.computeMs < 15_000
      && measurement.peakRssBytes < 750 * 1024 * 1024
      && measurement.uploadedBytes < 2 * 1024 * 1024
      && measurement.fullSnapshotRewriteBytes === 0
  } catch {
    return false
  }
}

export function createStorageMeasurementEvidence(input = {}) {
  return parseStorageMeasurementEvidence({
    ...commonEvidence(input, STORAGE_MEASUREMENT_EVIDENCE_KIND),
    measurement: {
      fullLogicalGenerationCompressedBytes: input.measurement?.fullLogicalGenerationCompressedBytes,
      postMigration: input.measurement?.postMigration,
      bucketBytes: input.measurement?.bucketBytes,
      retainedManifestCount: input.measurement?.retainedManifestCount,
      retainedManifestsResolvable: input.measurement?.retainedManifestsResolvable,
    },
  })
}

export function parseStorageMeasurementEvidence(value) {
  parseCommon(value, STORAGE_MEASUREMENT_EVIDENCE_KIND)
  assertExactKeys(value.measurement, [
    'fullLogicalGenerationCompressedBytes', 'postMigration', 'bucketBytes',
    'retainedManifestCount', 'retainedManifestsResolvable',
  ], 'storage measurement')
  nonNegativeNumber(value.measurement.fullLogicalGenerationCompressedBytes, 'storage fullLogicalGenerationCompressedBytes')
  nonNegativeNumber(value.measurement.bucketBytes, 'storage bucketBytes')
  positiveInteger(value.measurement.retainedManifestCount, 'storage retainedManifestCount')
  if (typeof value.measurement.postMigration !== 'boolean'
    || typeof value.measurement.retainedManifestsResolvable !== 'boolean') {
    throw new Error('Storage migration/resolvability fields must be boolean')
  }
  return value
}

export function isStorageMeasurementProof(value) {
  try {
    const measurement = parseStorageMeasurementEvidence(value).measurement
    return measurement.fullLogicalGenerationCompressedBytes <= 2.5 * 1024 * 1024
      && measurement.postMigration === true
      && measurement.bucketBytes < 350 * 1024 * 1024
      && measurement.retainedManifestsResolvable === true
  } catch {
    return false
  }
}

function commonEvidence(input, artifactKind) {
  return {
    artifactKind,
    schemaVersion: 1,
    evidenceClass: 'live',
    commit: input.commit,
    deploymentId: input.deploymentId,
    environmentId: input.environmentId,
    runId: input.runId,
    recordedAt: input.recordedAt,
    expiresAt: input.expiresAt,
  }
}

function parseCommon(value, artifactKind) {
  assertRecord(value, 'production evidence')
  assertExactKeys(value, COMMON_KEYS, 'production evidence')
  if (value.artifactKind !== artifactKind || value.schemaVersion !== 1 || value.evidenceClass !== 'live') {
    throw new Error('Invalid production evidence identity')
  }
  for (const field of ['commit', 'deploymentId', 'environmentId', 'runId']) requireString(value[field], field)
  requiredIso(value.recordedAt, 'recordedAt')
  requiredIso(value.expiresAt, 'expiresAt')
  if (Date.parse(value.expiresAt) <= Date.parse(value.recordedAt)) throw new Error('Production evidence must expire after it is recorded')
  assertRecord(value.measurement, 'production evidence measurement')
}

function requiredIso(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`Invalid production evidence ${label}`)
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid production evidence ${label}`)
}

function nonNegativeNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}`)
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${label}`)
}

function assertRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
}

function assertExactKeys(value, keys, label) {
  assertRecord(value, label)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected or missing keys`)
  }
}
