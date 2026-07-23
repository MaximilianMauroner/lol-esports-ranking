import type { RolloutEvidence } from './rollout-evidence.mjs'
export type RolloutShadowGateDecision = {
  artifactKind: 'ranking-rollout-shadow-gate-decision'
  schemaVersion: 1
  commit: string
  deploymentId?: string
  runId?: string
  evidenceClass?: string
  expiresAt?: string
  evaluatedAt: string
  recordedAt: string
  allowed: boolean
  criteria: Record<string, boolean> & { unchangedZeroBroadWork: boolean }
  consecutiveDates: string[]
  counts: { changed: number; unchanged: number; live: number }
  scenarioCoverage: string[]
  liveScenarioCoverage: string[]
  unchangedP50Ms: number | null
  unchangedP95Ms: number | null
}
export const ROLLOUT_SHADOW_GATE_DECISION_KIND: 'ranking-rollout-shadow-gate-decision'
export const ROLLOUT_SHADOW_GATE_CRITERIA: readonly string[]
export function evaluateRolloutShadowGate(options: {
  evidence?: unknown[]
  commit: string
  deploymentId?: string
  runId?: string
  evidenceClass?: string
  expiresAt?: string
  now?: string | number | Date
}): RolloutShadowGateDecision
export function parseRolloutShadowGateDecision(value: unknown): RolloutShadowGateDecision & {
  deploymentId: string
  runId: string
  evidenceClass: 'live' | 'production-like-fixture'
  expiresAt: string
}
