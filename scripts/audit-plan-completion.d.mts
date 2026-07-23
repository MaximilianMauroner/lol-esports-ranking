export type PlanCompletionStatus = 'proved' | 'contradicted' | 'missing' | 'live-pending' | 'authorization-gated'
export type PlanCompletionAudit = {
  artifactKind: string
  schemaVersion: 1
  complete: boolean
  exitCode: 0 | 1
  counts: Record<PlanCompletionStatus, number>
  incompleteIds: string[]
  requirements: Array<{ id: string; required: boolean; status: PlanCompletionStatus; evidenceKind: string | null; evidenceId: string | null }>
}
export const PLAN_COMPLETION_STATUSES: readonly PlanCompletionStatus[]
export const PLAN_COMPLETION_REQUIREMENTS: readonly Record<string, unknown>[]
export function auditPlanCompletion(options: {
  acceptance: Record<string, unknown>
  evidence?: unknown[]
  expectedCommit?: string
  expectedDeploymentId?: string
  subjectCommit?: string
  implementationAuthorityDir?: string
  repositoryRoot?: string
  resolveReference?: (key: string) => Promise<unknown>
  now?: string | number | Date
}): Promise<PlanCompletionAudit>
