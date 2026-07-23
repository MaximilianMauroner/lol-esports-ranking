export type RolloutEvidenceClass = 'live' | 'production-like-fixture'
export type RolloutScenario = 'latest-append' | 'unchanged' | 'daily-audit' | 'same-day-insertion' | 'historical-correction' | 'tournament-transition'
export type RolloutEvidence = {
  artifactKind: 'ranking-rollout-run-evidence'
  schemaVersion: 1
  evidenceClass: RolloutEvidenceClass
  commit: string
  runId: string
  expiresAt: string
  deployment: Record<string, unknown>
  execution: Record<string, unknown> & { result: string; finishedAt?: string; durationMs?: number }
  comparison: Record<string, unknown> & { equal: boolean; partial: boolean }
  scenario: RolloutScenario
  parity: Record<string, unknown>
  classification: Record<string, unknown>
  checkpoint: Record<string, unknown>
  timings: Record<string, unknown> & { totalMs?: number }
  freshness: Record<string, unknown>
  resources: Record<string, unknown>
  work: Record<string, number | null>
  fullSnapshot: Record<string, unknown>
  lease: Record<string, unknown>
  fallback: Record<string, unknown> | null
  audit: Record<string, unknown>
  promotion: Record<string, unknown>
  error: Record<string, unknown> | string | null
}
export const ROLLOUT_EVIDENCE_KIND: string
export const ROLLOUT_EVIDENCE_CLASSES: readonly RolloutEvidenceClass[]
export const ROLLOUT_EVIDENCE_SCENARIOS: readonly RolloutScenario[]
export const ROLLOUT_SHADOW_SCENARIOS: readonly RolloutScenario[]
export const ROLLOUT_CHANGED_SCENARIOS: readonly RolloutScenario[]
export const REQUIRED_ROLLOUT_EVIDENCE_FIELDS: readonly string[]
export function parseRolloutEvidence(value: unknown): RolloutEvidence
export function createRolloutEvidence(input?: Record<string, unknown>): RolloutEvidence
export function createRefreshRolloutEvidence(metrics: Record<string, unknown>, input?: Record<string, unknown>): RolloutEvidence
export function rolloutEvidenceKey(value: unknown): string
export function rolloutEvidenceDigest(value: unknown): string
export function createEvidenceAuthority(value: unknown, key?: string): Record<string, unknown> & { value: RolloutEvidence; sha256: string }
export function parseEvidenceAuthority(value: unknown, options?: { kind?: string; keyPrefix?: string }): Record<string, unknown> & { value: RolloutEvidence }
export function publishRolloutEvidence(value: unknown, options?: Record<string, unknown>): Promise<Record<string, unknown>>
export function aggregateRolloutEvidence(values: unknown[]): Record<string, unknown> & { runs: RolloutEvidence[] }
export function hasRolloutFailure(run: RolloutEvidence): boolean
export function hasZeroBroadWork(run: RolloutEvidence): boolean
export function percentile(values: number[], quantile: number): number | null
