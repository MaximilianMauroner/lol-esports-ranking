export const PRODUCTION_FRESHNESS_EVIDENCE_KIND: 'ranking-rollout-production-freshness-evidence'
export const LATEST_GAME_PERFORMANCE_EVIDENCE_KIND: 'ranking-rollout-latest-game-performance-evidence'
export const STORAGE_MEASUREMENT_EVIDENCE_KIND: 'ranking-rollout-storage-measurement-evidence'

export interface ProductionEvidenceInput<Measurement> {
  commit: string
  deploymentId: string
  environmentId: string
  runId: string
  recordedAt: string
  expiresAt: string
  measurement: Measurement
}

export interface ProductionEvidence<Kind extends string, Measurement>
  extends ProductionEvidenceInput<Measurement> {
  artifactKind: Kind
  schemaVersion: 1
  evidenceClass: 'live'
}

export interface ProductionFreshnessMeasurement {
  sampleCount: number
  providerAvailabilityBasis: 'scored-provider-first-capable-response'
  upstreamDelayExcluded: true
  upstreamDelayP95Ms: number
  p95FreshnessMs: number
}

export interface LatestGamePerformanceMeasurement {
  sampleCount: number
  computeMs: number
  peakRssBytes: number
  uploadedBytes: number
  fullSnapshotRewriteBytes: number
}

export interface StorageMeasurement {
  fullLogicalGenerationCompressedBytes: number
  postMigration: boolean
  bucketBytes: number
  retainedManifestCount: number
  retainedManifestsResolvable: boolean
}

export type ProductionFreshnessEvidence = ProductionEvidence<
  typeof PRODUCTION_FRESHNESS_EVIDENCE_KIND,
  ProductionFreshnessMeasurement
>
export type LatestGamePerformanceEvidence = ProductionEvidence<
  typeof LATEST_GAME_PERFORMANCE_EVIDENCE_KIND,
  LatestGamePerformanceMeasurement
>
export type StorageMeasurementEvidence = ProductionEvidence<
  typeof STORAGE_MEASUREMENT_EVIDENCE_KIND,
  StorageMeasurement
>

export function createProductionFreshnessEvidence(
  input: ProductionEvidenceInput<ProductionFreshnessMeasurement>,
): ProductionFreshnessEvidence
export function parseProductionFreshnessEvidence(value: unknown): ProductionFreshnessEvidence
export function isProductionFreshnessProof(value: unknown): boolean
export function createLatestGamePerformanceEvidence(
  input: ProductionEvidenceInput<LatestGamePerformanceMeasurement>,
): LatestGamePerformanceEvidence
export function parseLatestGamePerformanceEvidence(value: unknown): LatestGamePerformanceEvidence
export function isLatestGamePerformanceProof(value: unknown): boolean
export function createStorageMeasurementEvidence(
  input: ProductionEvidenceInput<StorageMeasurement>,
): StorageMeasurementEvidence
export function parseStorageMeasurementEvidence(value: unknown): StorageMeasurementEvidence
export function isStorageMeasurementProof(value: unknown): boolean
