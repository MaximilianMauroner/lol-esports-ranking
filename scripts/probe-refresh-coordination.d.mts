export type ProbeAuthority = {
  artifactKind: 'ranking-rollout-probe-coordination'
  schemaVersion: 1
  probeId: string
  owner: string
  fencingToken: number
  status: 'active' | 'released'
  acquiredAt: string
  expiresAt: string
  renewedAt?: string
  releasedAt?: string
}
export type ProbeCoordinationResult = { acquired?: boolean; renewed?: boolean; released?: boolean; reason?: string; key: string; authority?: ProbeAuthority; etag?: string }
export function rolloutProbeKey(probeId: string): string
export function acquireProbeCoordination(probeId: string, options: Record<string, unknown> & { owner: string }): Promise<ProbeCoordinationResult>
export function renewProbeCoordination(probeId: string, authority: ProbeCoordinationResult, options?: Record<string, unknown>): Promise<ProbeCoordinationResult>
export function releaseProbeCoordination(probeId: string, authority: ProbeCoordinationResult, options?: Record<string, unknown>): Promise<ProbeCoordinationResult>
export function assertProbeCoordination(probeId: string, authority: ProbeCoordinationResult, options?: Record<string, unknown>): Promise<Record<string, unknown>>
export function createProbeCoordinationEvidence(input?: Record<string, unknown>): Record<string, unknown>
export function parseProbeCoordinationEvidence(value: unknown): Record<string, unknown>
