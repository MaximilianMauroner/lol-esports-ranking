import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createProductionActionReceipt,
  isProductionActionProof,
  parseProductionActionReceipt,
  PRODUCTION_ACTION_IDS,
  type ProductionActionId,
} from '../scripts/rollout-production-action.mjs'

test('each production action has one strict native successful receipt', () => {
  for (const actionId of PRODUCTION_ACTION_IDS) {
    const receipt = actionReceipt(actionId)
    assert.equal(parseProductionActionReceipt(receipt), receipt)
    assert.equal(isProductionActionProof(receipt, actionId), true)
    for (const other of PRODUCTION_ACTION_IDS.filter((value) => value !== actionId)) {
      assert.equal(isProductionActionProof(receipt, other), false)
    }
  }
})

test('production action receipts reject generic, cross-action, failed, and forged approval claims', () => {
  const cadence = actionReceipt('five-minute-cadence')
  assert.throws(() => parseProductionActionReceipt({ ...cadence, assertions: { applied: true } }), /unexpected|five-minute/)
  assert.throws(() => parseProductionActionReceipt({
    ...cadence,
    execution: { ...cadence.execution, succeeded: false },
  }), /successful production/)
  assert.throws(() => parseProductionActionReceipt({
    ...cadence,
    approval: { ...cadence.approval, approvedBy: '' },
  }), /approvedBy/)
  assert.throws(() => parseProductionActionReceipt({ ...cadence, invented: true }), /unexpected or missing/)
  const retention = actionReceipt('retention-delete-execution')
  assert.throws(() => parseProductionActionReceipt({
    ...retention,
    assertions: { ...retention.assertions, inventorySha256: 'b'.repeat(64) },
  }), /human-approved inventory/)
})

export function actionReceipt(actionId: ProductionActionId) {
  const digest = 'a'.repeat(64)
  const assertions = {
    'five-minute-cadence': { active: true, intervalMinutes: 5, mode: 'gated' },
    'production-config-change': { applied: true },
    'incremental-cutover': { active: true },
    'storage-delivery-production-cutover': { presignedDeliveryActive: true, proxyFallbackActive: true },
    'retention-delete-execution': { deleteCompleted: true, inventorySha256: digest },
  }[actionId]
  return createProductionActionReceipt({
    commit: 'abc123',
    deploymentId: 'deployment-1',
    environmentId: 'environment-1',
    runId: `action-${actionId}`,
    recordedAt: '2026-07-23T02:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
    actionId,
    approval: {
      approvalId: `approval-${actionId}`,
      approvedBy: 'human@example.invalid',
      approvedAt: '2026-07-23T00:00:00.000Z',
      inventorySha256: actionId === 'retention-delete-execution' ? digest : null,
    },
    execution: {
      environment: 'production',
      executedAt: '2026-07-23T01:00:00.000Z',
      succeeded: true,
    },
    assertions,
  })
}
