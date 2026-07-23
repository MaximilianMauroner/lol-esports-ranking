export const RANKING_REFRESH_OUTCOMES = Object.freeze([
  'unchanged',
  'latest-append',
  'same-day-insertion',
  'historical-correction',
  'metadata-only',
  'stale-source',
  'no-data',
  'forced-verified-raw-rebuild',
  'parity-failure',
  'full-invalidation',
])

const OUTCOME_KEYS = Object.freeze([
  'requiredInputs',
  'optionalArtifacts',
  'allowedWrites',
  'authorityAdvancement',
  'reconciliationBehavior',
  'auditEligibility',
  'retryState',
])
const OBSERVATION_KEYS = Object.freeze([
  'sourceResult',
  'providerStatus',
  'force',
  'rawRecoveryAuthorized',
  'verifiedRawAuthority',
  'dataMode',
  'rankingChangeKind',
  'buildAction',
  'parity',
  'fallbackReason',
])
const INPUTS = new Set([
  'source-result',
  'provider-status',
  'force',
  'raw-recovery-authorization',
  'verified-raw-authority',
  'data-mode',
  'ranking-change-kind',
  'build-action',
  'parity',
  'fallback-reason',
])
const ARTIFACTS = new Set([
  'reconciliation',
  'incremental-candidate',
  'clean-full-replay',
  'provider-failure-manifest',
  'verified-raw-authority',
])
const WRITES = new Set([
  'refresh-telemetry',
  'refresh-state',
  'trigger-state',
  'reconciliation',
  'raw-authority',
  'semantic-artifacts',
  'incremental-state',
  'active-authority',
])
const AUTHORITY_POLICIES = new Set([
  'never',
  'after-successful-publication',
  'after-successful-clean-full-publication',
])
const RECONCILIATION_POLICIES = new Set([
  'not-consumed',
  'required-before-completion',
  'omitted',
])
const AUDIT_POLICIES = new Set(['ineligible', 'clean-full-replay-only'])
const RETRY_POLICIES = new Set([
  'none',
  'pending-provider-backoff',
  'pending-publication-on-failure',
])
const SOURCE_RESULTS = new Set(['unchanged', 'completed', 'stale-source'])
const PROVIDER_STATUSES = new Set(['usable', 'failed'])
const DATA_MODES = new Set(['scheduled-public-data', 'no-data'])
const CHANGE_KINDS = new Set([
  'no-change',
  'metadata-only',
  'latest-append',
  'same-day-insertion',
  'historical-correction',
  'full-invalidation',
])
const BUILD_ACTIONS = new Set(['no-change', 'publish-incremental', 'publish-full'])

const COMMON_PUBLISH_INPUTS = Object.freeze([
  'source-result',
  'provider-status',
  'data-mode',
  'ranking-change-kind',
  'build-action',
  'parity',
  'fallback-reason',
])
const COMMON_PUBLISH_WRITES = Object.freeze([
  'refresh-telemetry',
  'refresh-state',
  'trigger-state',
  'reconciliation',
  'raw-authority',
  'semantic-artifacts',
  'incremental-state',
  'active-authority',
])

export const RANKING_REFRESH_OUTCOME_MATRIX = deepFreeze({
  unchanged: {
    requiredInputs: ['source-result', 'provider-status'],
    optionalArtifacts: ['reconciliation'],
    allowedWrites: ['refresh-telemetry', 'refresh-state', 'trigger-state'],
    authorityAdvancement: 'never',
    reconciliationBehavior: 'not-consumed',
    auditEligibility: 'ineligible',
    retryState: 'none',
  },
  'latest-append': publishRow(),
  'same-day-insertion': publishRow(),
  'historical-correction': publishRow(),
  'metadata-only': publishRow(),
  'stale-source': {
    requiredInputs: [
      'source-result',
      'provider-status',
      'force',
      'raw-recovery-authorization',
      'verified-raw-authority',
    ],
    optionalArtifacts: ['provider-failure-manifest', 'verified-raw-authority'],
    allowedWrites: ['refresh-telemetry', 'refresh-state', 'trigger-state'],
    authorityAdvancement: 'never',
    reconciliationBehavior: 'omitted',
    auditEligibility: 'ineligible',
    retryState: 'pending-provider-backoff',
  },
  'no-data': publishRow(),
  'forced-verified-raw-rebuild': {
    requiredInputs: [
      'source-result',
      'provider-status',
      'force',
      'raw-recovery-authorization',
      'verified-raw-authority',
      'data-mode',
      'build-action',
    ],
    optionalArtifacts: ['provider-failure-manifest', 'verified-raw-authority', 'clean-full-replay', 'reconciliation'],
    allowedWrites: COMMON_PUBLISH_WRITES,
    authorityAdvancement: 'after-successful-clean-full-publication',
    reconciliationBehavior: 'required-before-completion',
    auditEligibility: 'ineligible',
    retryState: 'pending-publication-on-failure',
  },
  'parity-failure': {
    requiredInputs: COMMON_PUBLISH_INPUTS,
    optionalArtifacts: ['incremental-candidate', 'clean-full-replay', 'reconciliation'],
    allowedWrites: COMMON_PUBLISH_WRITES,
    authorityAdvancement: 'after-successful-clean-full-publication',
    reconciliationBehavior: 'required-before-completion',
    auditEligibility: 'ineligible',
    retryState: 'pending-publication-on-failure',
  },
  'full-invalidation': {
    requiredInputs: COMMON_PUBLISH_INPUTS,
    optionalArtifacts: ['clean-full-replay', 'reconciliation'],
    allowedWrites: COMMON_PUBLISH_WRITES,
    authorityAdvancement: 'after-successful-clean-full-publication',
    reconciliationBehavior: 'required-before-completion',
    auditEligibility: 'clean-full-replay-only',
    retryState: 'pending-publication-on-failure',
  },
})

parseRankingRefreshOutcomeMatrix(RANKING_REFRESH_OUTCOME_MATRIX)

/**
 * Strictly binds the existing refresh terminal result, RankingChangeKind, and
 * incremental build action vocabularies to one canonical outcome.
 */
export function normalizeRankingRefreshOutcome(value) {
  const observation = parseObservation(value)
  const recoveryAuthorized = observation.force
    && observation.rawRecoveryAuthorized
    && observation.verifiedRawAuthority

  if (observation.providerStatus === 'failed') {
    if (!recoveryAuthorized) {
      requireObservation(observation, {
        sourceResult: 'stale-source',
        dataMode: null,
        rankingChangeKind: null,
        buildAction: null,
        parity: null,
        fallbackReason: null,
      }, 'stale-source')
      return contractFor('stale-source')
    }
    requireObservation(observation, {
      sourceResult: 'completed',
      buildAction: 'publish-full',
      parity: null,
      fallbackReason: null,
    }, 'forced-verified-raw-rebuild')
    if (!DATA_MODES.has(observation.dataMode)) {
      throw new Error('forced-verified-raw-rebuild requires a usable verified raw data mode')
    }
    if (observation.rankingChangeKind !== 'full-invalidation') {
      throw new Error('forced-verified-raw-rebuild requires the current full-invalidation build classification')
    }
    return contractFor('forced-verified-raw-rebuild')
  }

  if (observation.sourceResult === 'stale-source') {
    throw new Error('stale-source contradicts usable provider input')
  }
  if (observation.sourceResult === 'unchanged') {
    const earlySourceExit = observation.dataMode === null
      && observation.rankingChangeKind === null
      && observation.buildAction === null
    const canonicalNoChange = DATA_MODES.has(observation.dataMode)
      && observation.rankingChangeKind === 'no-change'
      && observation.buildAction === 'no-change'
    if ((!earlySourceExit && !canonicalNoChange)
      || observation.parity !== null
      || observation.fallbackReason !== null) {
      throw new Error('unchanged requires either the source fingerprint exit or canonical no-change build')
    }
    return contractFor('unchanged')
  }

  if (!DATA_MODES.has(observation.dataMode)) {
    throw new Error('completed refresh requires a production data mode')
  }
  if (observation.rankingChangeKind === null || observation.buildAction === null) {
    throw new Error('completed refresh requires ranking classification and build action')
  }
  if (observation.rankingChangeKind === 'no-change' || observation.buildAction === 'no-change') {
    throw new Error('completed refresh contradicts no-change classification or action')
  }
  validateBuildRelationship(observation)

  if (observation.parity === false) return contractFor('parity-failure')
  if (observation.dataMode === 'no-data') return contractFor('no-data')
  if (observation.rankingChangeKind === 'full-invalidation') return contractFor('full-invalidation')
  return contractFor(observation.rankingChangeKind)
}

export function parseRankingRefreshOutcomeMatrix(value) {
  assertRecord(value, 'ranking refresh outcome matrix')
  assertExactKeys(value, RANKING_REFRESH_OUTCOMES, 'ranking refresh outcome matrix')
  for (const outcome of RANKING_REFRESH_OUTCOMES) {
    const row = value[outcome]
    assertRecord(row, `${outcome} outcome`)
    assertExactKeys(row, OUTCOME_KEYS, `${outcome} outcome`)
    assertEnumArray(row.requiredInputs, INPUTS, `${outcome} requiredInputs`)
    assertEnumArray(row.optionalArtifacts, ARTIFACTS, `${outcome} optionalArtifacts`)
    assertEnumArray(row.allowedWrites, WRITES, `${outcome} allowedWrites`)
    assertEnum(row.authorityAdvancement, AUTHORITY_POLICIES, `${outcome} authorityAdvancement`)
    assertEnum(row.reconciliationBehavior, RECONCILIATION_POLICIES, `${outcome} reconciliationBehavior`)
    assertEnum(row.auditEligibility, AUDIT_POLICIES, `${outcome} auditEligibility`)
    assertEnum(row.retryState, RETRY_POLICIES, `${outcome} retryState`)
    validateRowRelationships(row, outcome)
  }
  return value
}

function publishRow() {
  return {
    requiredInputs: COMMON_PUBLISH_INPUTS,
    optionalArtifacts: ['incremental-candidate', 'clean-full-replay', 'reconciliation'],
    allowedWrites: COMMON_PUBLISH_WRITES,
    authorityAdvancement: 'after-successful-publication',
    reconciliationBehavior: 'required-before-completion',
    auditEligibility: 'ineligible',
    retryState: 'pending-publication-on-failure',
  }
}

function parseObservation(value) {
  assertRecord(value, 'ranking refresh observation')
  assertExactKeys(value, OBSERVATION_KEYS, 'ranking refresh observation')
  assertEnum(value.sourceResult, SOURCE_RESULTS, 'sourceResult')
  assertEnum(value.providerStatus, PROVIDER_STATUSES, 'providerStatus')
  for (const field of ['force', 'rawRecoveryAuthorized', 'verifiedRawAuthority']) {
    if (typeof value[field] !== 'boolean') throw new Error(`Invalid ranking refresh observation ${field}`)
  }
  assertNullableEnum(value.dataMode, DATA_MODES, 'dataMode')
  assertNullableEnum(value.rankingChangeKind, CHANGE_KINDS, 'rankingChangeKind')
  assertNullableEnum(value.buildAction, BUILD_ACTIONS, 'buildAction')
  if (value.parity !== null && typeof value.parity !== 'boolean') {
    throw new Error('Invalid ranking refresh observation parity')
  }
  if (value.fallbackReason !== null
    && (typeof value.fallbackReason !== 'string' || value.fallbackReason.length === 0)) {
    throw new Error('Invalid ranking refresh observation fallbackReason')
  }
  return value
}

function validateBuildRelationship(observation) {
  if (observation.parity === false) {
    if (observation.buildAction !== 'publish-full' || observation.fallbackReason === null) {
      throw new Error('Parity failure requires a diagnosed clean full fallback')
    }
    return
  }
  if (observation.parity === true && observation.fallbackReason !== null) {
    throw new Error('Successful parity contradicts a fallback reason')
  }
  if (observation.buildAction === 'publish-incremental' && observation.fallbackReason !== null) {
    throw new Error('Incremental publication contradicts a fallback reason')
  }
  if (observation.rankingChangeKind === 'full-invalidation'
    && observation.buildAction !== 'publish-full') {
    throw new Error('full-invalidation requires a clean full replay')
  }
}

function validateRowRelationships(row, outcome) {
  if (row.authorityAdvancement === 'never' && row.allowedWrites.includes('active-authority')) {
    throw new Error(`${outcome} cannot write active authority when advancement is forbidden`)
  }
  if (row.authorityAdvancement !== 'never' && !row.allowedWrites.includes('active-authority')) {
    throw new Error(`${outcome} authority advancement requires an allowed active-authority write`)
  }
  if (row.reconciliationBehavior === 'omitted'
    && (row.optionalArtifacts.includes('reconciliation') || row.allowedWrites.includes('reconciliation'))) {
    throw new Error(`${outcome} omitted reconciliation cannot be produced`)
  }
  if (row.reconciliationBehavior === 'required-before-completion'
    && !row.allowedWrites.includes('reconciliation')) {
    throw new Error(`${outcome} required reconciliation must be an allowed write`)
  }
  if (row.auditEligibility === 'clean-full-replay-only'
    && !row.optionalArtifacts.includes('clean-full-replay')) {
    throw new Error(`${outcome} audit eligibility requires a clean full replay`)
  }
}

function contractFor(outcome) {
  return { outcome, contract: RANKING_REFRESH_OUTCOME_MATRIX[outcome] }
}

function requireObservation(observation, expected, outcome) {
  for (const [field, value] of Object.entries(expected)) {
    if (observation[field] !== value) {
      throw new Error(`${outcome} contradicts ${field}`)
    }
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected or missing keys`)
  }
}

function assertRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

function assertEnum(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`Invalid ${label}`)
}

function assertNullableEnum(value, allowed, label) {
  if (value !== null) assertEnum(value, allowed, label)
}

function assertEnumArray(value, allowed, label) {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length
    || value.some((entry) => !allowed.has(entry))) {
    throw new Error(`Invalid ${label}`)
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
