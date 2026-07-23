export type ImplementationRequirementId = 'provider-request-retry' | 'complete-immutable-receipts'
export type ImplementationCommandResult = {
  id: string
  argv: string[]
  exitCode: number
  passed: number
  failed: number
  cancelled: number
}
export type ImplementationEvidence = {
  artifactKind: 'ranking-rollout-implementation-test-evidence'
  schemaVersion: 1
  evidenceClass: 'repository-implementation'
  requirementId: ImplementationRequirementId
  contractId: string
  subjectCommit: string
  producerSourceCommit: string
  runId: string
  sourceDigests: Array<{ path: string; sha256: string }>
  commands: ImplementationCommandResult[]
  assertions: Array<{ id: string; passed: boolean }>
  result: 'proved' | 'contradicted'
}
export const IMPLEMENTATION_EVIDENCE_KIND: 'ranking-rollout-implementation-test-evidence'
export const IMPLEMENTATION_EVIDENCE_CLASS: 'repository-implementation'
export const IMPLEMENTATION_EVIDENCE_REQUIREMENTS: readonly ImplementationRequirementId[]
export const IMPLEMENTATION_EVIDENCE_CONTRACTS: Readonly<Record<ImplementationRequirementId, {
  contractId: string
  sourcePaths: readonly string[]
  commands: readonly Array<{ id: string; argv: readonly string[] }>
  assertionIds: readonly string[]
}>>
export function generateImplementationEvidence(options: {
  repositoryRoot: string
  subjectCommit: string
  runCommand?: (argv: readonly string[], options: { cwd: string }) => Promise<{
    exitCode: number
    passed: number
    failed: number
    cancelled: number
  }>
}): Promise<ImplementationEvidence[]>
export function parseImplementationEvidence(value: unknown): ImplementationEvidence
export function verifyImplementationEvidenceSources(value: unknown, options: { repositoryRoot: string }): Promise<ImplementationEvidence>
export function writeImplementationAuthority(values: unknown[], options: { authorityDir: string }): Promise<Record<string, unknown>>
export function resolveImplementationAuthority(options: {
  authorityDir: string
  subjectCommit: string
  repositoryRoot: string
}): Promise<ImplementationEvidence[]>
export function parseImplementationManifest(value: unknown): Record<string, unknown>
