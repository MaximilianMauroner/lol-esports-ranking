export type ProductionActionId =
  | 'five-minute-cadence'
  | 'production-config-change'
  | 'incremental-cutover'
  | 'storage-delivery-production-cutover'
  | 'retention-delete-execution'

export interface ProductionActionApproval {
  approvalId: string
  approvedBy: string
  approvedAt: string
  inventorySha256: string | null
}

export interface ProductionActionExecution {
  environment: 'production'
  executedAt: string
  succeeded: true
}

export interface ProductionActionReceiptInput {
  commit: string
  deploymentId: string
  environmentId: string
  runId: string
  recordedAt: string
  expiresAt: string
  actionId: ProductionActionId
  approval: ProductionActionApproval
  execution: ProductionActionExecution
  assertions: Record<string, unknown>
}

export interface ProductionActionReceipt extends ProductionActionReceiptInput {
  artifactKind: typeof PRODUCTION_ACTION_RECEIPT_KIND
  schemaVersion: 1
  evidenceClass: 'live'
}

export const PRODUCTION_ACTION_RECEIPT_KIND: 'ranking-rollout-production-action-receipt'
export const PRODUCTION_ACTION_IDS: readonly ProductionActionId[]
export function createProductionActionReceipt(input: ProductionActionReceiptInput): ProductionActionReceipt
export function parseProductionActionReceipt(value: unknown): ProductionActionReceipt
export function isProductionActionProof(value: unknown, expectedActionId: ProductionActionId): boolean
