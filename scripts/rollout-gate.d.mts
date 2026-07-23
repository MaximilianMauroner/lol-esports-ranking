export type ImmutableReference = { key: string; sha256: string }
export type RolloutGateDecision = {
  artifactKind: 'ranking-five-minute-rollout-gate-decision'
  schemaVersion: 1
  evidenceClass: 'live' | 'production-like-fixture'
  runId: string
  expiresAt: string
  affected: true
  allowed: boolean
  evaluatedAt: string
  recordedAt: string
  commit: string
  deploymentId: string
  criteria: Record<string, boolean>
  shadow: import('./rollout-shadow-gate.mjs').RolloutShadowGateDecision & {
    deploymentId: string
    runId: string
    evidenceClass: 'live' | 'production-like-fixture'
    expiresAt: string
  }
}
export type RolloutGateReceipt = {
  artifactKind: 'ranking-five-minute-rollout-gate-receipt'
  schemaVersion: 1
  commit: string
  deploymentId: string
  runId: string
  issuedAt: string
  expiresAt: string
  evidenceClass: 'live' | 'production-like-fixture'
  proofs: {
    runs: ImmutableReference[]
    latestAppendRunId: string
    auditRunId: string
    auditEvidence: ImmutableReference
    coordination: ImmutableReference
    rollback: ImmutableReference
  }
  policy: { recentAuditMaxAgeMs?: number }
}
export const ROLLOUT_GATE_KIND: string
export const ROLLOUT_GATE_DECISION_KIND: 'ranking-five-minute-rollout-gate-decision'
export const ROLLOUT_GATE_DECISION_CRITERIA: readonly string[]
export const AUDIT_GATE_EVIDENCE_KIND: string
export const ROLLBACK_EVIDENCE_KIND: string
export function createRolloutGateReceipt(input?: Record<string, unknown>): RolloutGateReceipt
export function parseRolloutGateReceipt(value: unknown): RolloutGateReceipt
export function parseRolloutGateDecision(value: unknown): RolloutGateDecision
export function createAuditGateEvidence(input?: Record<string, unknown>): Record<string, unknown>
export function parseAuditGateEvidence(value: unknown): Record<string, unknown>
export function createRollbackRehearsalEvidence(input?: Record<string, unknown>): Record<string, unknown>
export function parseRollbackRehearsalEvidence(value: unknown): Record<string, unknown>
export function immutableReference(value: unknown, key: string): ImmutableReference
export function parseImmutableReference(value: unknown): ImmutableReference
export function resolveImmutableReference(reference: unknown, options: {
  kind: string
  keyPrefix: string
  resolveReference: (key: string) => Promise<unknown>
}): Promise<ImmutableReference & { value: Record<string, unknown> }>
export function evaluateRolloutGate(options: {
  intervalMinutes: number
  mode?: string
  commit?: string
  deploymentId?: string
  receiptAuthority?: unknown
  resolveReference?: (key: string) => Promise<unknown>
  now?: string | number | Date
}): Promise<{ allowed: boolean; affected: boolean; criteria: Record<string, boolean>; [key: string]: unknown }>
export function assertFiveMinuteRolloutGate(options: Parameters<typeof evaluateRolloutGate>[0]): Promise<true>
