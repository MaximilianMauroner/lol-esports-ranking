export const PRODUCTION_ACTION_RECEIPT_KIND = 'ranking-rollout-production-action-receipt'
export const PRODUCTION_ACTION_IDS = Object.freeze([
  'five-minute-cadence',
  'production-config-change',
  'incremental-cutover',
  'storage-delivery-production-cutover',
  'retention-delete-execution',
])

const TOP_KEYS = [
  'artifactKind', 'schemaVersion', 'evidenceClass', 'commit', 'deploymentId',
  'environmentId', 'runId', 'recordedAt', 'expiresAt', 'actionId',
  'approval', 'execution', 'assertions',
]
const APPROVAL_KEYS = ['approvalId', 'approvedBy', 'approvedAt', 'inventorySha256']
const EXECUTION_KEYS = ['environment', 'executedAt', 'succeeded']

export function createProductionActionReceipt(input = {}) {
  return parseProductionActionReceipt({
    artifactKind: PRODUCTION_ACTION_RECEIPT_KIND,
    schemaVersion: 1,
    evidenceClass: 'live',
    commit: input.commit,
    deploymentId: input.deploymentId,
    environmentId: input.environmentId,
    runId: input.runId,
    recordedAt: input.recordedAt,
    expiresAt: input.expiresAt,
    actionId: input.actionId,
    approval: {
      approvalId: input.approval?.approvalId,
      approvedBy: input.approval?.approvedBy,
      approvedAt: input.approval?.approvedAt,
      inventorySha256: input.approval?.inventorySha256 ?? null,
    },
    execution: {
      environment: input.execution?.environment,
      executedAt: input.execution?.executedAt,
      succeeded: input.execution?.succeeded,
    },
    assertions: input.assertions,
  })
}

export function parseProductionActionReceipt(value) {
  assertRecord(value, 'production action receipt')
  assertExactKeys(value, TOP_KEYS, 'production action receipt')
  if (value.artifactKind !== PRODUCTION_ACTION_RECEIPT_KIND || value.schemaVersion !== 1
    || value.evidenceClass !== 'live' || !PRODUCTION_ACTION_IDS.includes(value.actionId)) {
    throw new Error('Invalid production action receipt identity')
  }
  for (const field of ['commit', 'deploymentId', 'environmentId', 'runId']) requireString(value[field], field)
  requiredIso(value.recordedAt, 'recordedAt')
  requiredIso(value.expiresAt, 'expiresAt')
  assertRecord(value.approval, 'production action approval')
  assertExactKeys(value.approval, APPROVAL_KEYS, 'production action approval')
  requireString(value.approval.approvalId, 'approvalId')
  requireString(value.approval.approvedBy, 'approvedBy')
  requiredIso(value.approval.approvedAt, 'approvedAt')
  if (value.approval.inventorySha256 !== null && !/^[a-f0-9]{64}$/.test(value.approval.inventorySha256)) {
    throw new Error('Invalid production action inventory digest')
  }
  assertRecord(value.execution, 'production action execution')
  assertExactKeys(value.execution, EXECUTION_KEYS, 'production action execution')
  if (value.execution.environment !== 'production' || value.execution.succeeded !== true) {
    throw new Error('Production action must have a successful production execution')
  }
  requiredIso(value.execution.executedAt, 'executedAt')
  if (!(Date.parse(value.approval.approvedAt) <= Date.parse(value.execution.executedAt)
    && Date.parse(value.execution.executedAt) <= Date.parse(value.recordedAt)
    && Date.parse(value.recordedAt) < Date.parse(value.expiresAt))) {
    throw new Error('Invalid production action receipt chronology')
  }
  parseActionAssertions(value)
  return value
}

export function isProductionActionProof(value, expectedActionId) {
  try {
    return parseProductionActionReceipt(value).actionId === expectedActionId
  } catch {
    return false
  }
}

function parseActionAssertions(value) {
  const assertions = value.assertions
  assertRecord(assertions, 'production action assertions')
  switch (value.actionId) {
    case 'five-minute-cadence':
      assertExactKeys(assertions, ['active', 'intervalMinutes', 'mode'], 'five-minute cadence assertions')
      if (assertions.active !== true || assertions.intervalMinutes !== 5 || assertions.mode !== 'gated') {
        throw new Error('Five-minute cadence must be active in gated mode')
      }
      requireNoInventory(value)
      break
    case 'production-config-change':
      assertExactKeys(assertions, ['applied'], 'production config assertions')
      if (assertions.applied !== true) throw new Error('Production configuration must be applied')
      requireNoInventory(value)
      break
    case 'incremental-cutover':
      assertExactKeys(assertions, ['active'], 'incremental cutover assertions')
      if (assertions.active !== true) throw new Error('Incremental cutover must be active')
      requireNoInventory(value)
      break
    case 'storage-delivery-production-cutover':
      assertExactKeys(assertions, ['presignedDeliveryActive', 'proxyFallbackActive'], 'storage delivery assertions')
      if (assertions.presignedDeliveryActive !== true || assertions.proxyFallbackActive !== true) {
        throw new Error('Presigned delivery and proxy fallback must both be active')
      }
      requireNoInventory(value)
      break
    case 'retention-delete-execution':
      assertExactKeys(assertions, ['deleteCompleted', 'inventorySha256'], 'retention delete assertions')
      if (assertions.deleteCompleted !== true || !/^[a-f0-9]{64}$/.test(assertions.inventorySha256)
        || assertions.inventorySha256 !== value.approval.inventorySha256) {
        throw new Error('Retention deletion must bind the human-approved inventory digest')
      }
      break
    default:
      throw new Error('Unsupported production action')
  }
}

function requireNoInventory(value) {
  if (value.approval.inventorySha256 !== null) throw new Error('Inventory approval is valid only for retention deletion')
}

function requiredIso(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`Invalid production action ${label}`)
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid production action ${label}`)
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
