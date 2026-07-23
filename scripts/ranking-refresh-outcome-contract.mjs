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
  'validatedExistingRawBaseline',
  'dataMode',
  'rankingChangeKind',
  'buildAction',
  'parity',
  'stateParity',
  'checkpointParity',
  'fallbackReason',
])
const INPUTS = new Set([
  'source-result',
  'provider-status',
  'force',
  'raw-recovery-authorization',
  'validated-existing-raw-baseline',
  'data-mode',
  'ranking-change-kind',
  'build-action',
  'parity',
  'state-parity',
  'checkpoint-parity',
  'fallback-reason',
])
const ARTIFACTS = new Set([
  'reconciliation',
  'incremental-candidate',
  'clean-full-replay',
  'provider-failure-manifest',
  'validated-existing-raw-baseline',
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
  'only-after-successful-clean-full-publication',
])
const RECONCILIATION_POLICIES = new Set([
  'not-consumed',
  'required-before-completion',
  'omitted',
  'not-consumed-unless-clean-full-comparison',
])
const AUDIT_POLICIES = new Set([
  'ineligible',
  'clean-full-replay-only',
  'clean-zero-mutation-full-replay-only',
])
const RETRY_POLICIES = new Set([
  'none',
  'pending-provider-backoff',
  'pending-publication-on-failure',
  'none-unless-publication-fails',
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
  'state-parity',
  'checkpoint-parity',
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
    requiredInputs: COMMON_PUBLISH_INPUTS,
    optionalArtifacts: ['clean-full-replay', 'reconciliation'],
    allowedWrites: COMMON_PUBLISH_WRITES,
    authorityAdvancement: 'only-after-successful-clean-full-publication',
    reconciliationBehavior: 'not-consumed-unless-clean-full-comparison',
    auditEligibility: 'clean-zero-mutation-full-replay-only',
    retryState: 'none-unless-publication-fails',
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
      'validated-existing-raw-baseline',
    ],
    optionalArtifacts: ['provider-failure-manifest', 'validated-existing-raw-baseline'],
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
      'validated-existing-raw-baseline',
      'data-mode',
      'build-action',
    ],
    optionalArtifacts: ['provider-failure-manifest', 'validated-existing-raw-baseline', 'clean-full-replay', 'reconciliation'],
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

const CANONICAL_OUTCOME_MATRIX = RANKING_REFRESH_OUTCOME_MATRIX
const ORDINARY_UNCHANGED_CONTRACT = deepFreeze({
  requiredInputs: COMMON_PUBLISH_INPUTS,
  optionalArtifacts: ['reconciliation'],
  allowedWrites: ['refresh-telemetry', 'refresh-state', 'trigger-state'],
  authorityAdvancement: 'never',
  reconciliationBehavior: 'not-consumed',
  auditEligibility: 'ineligible',
  retryState: 'none',
})
const CLEAN_FULL_UNCHANGED_CONTRACT = deepFreeze({
  requiredInputs: COMMON_PUBLISH_INPUTS,
  optionalArtifacts: ['clean-full-replay', 'reconciliation'],
  allowedWrites: COMMON_PUBLISH_WRITES,
  authorityAdvancement: 'after-successful-clean-full-publication',
  reconciliationBehavior: 'required-before-completion',
  auditEligibility: 'clean-zero-mutation-full-replay-only',
  retryState: 'pending-publication-on-failure',
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
    && observation.validatedExistingRawBaseline

  if (observation.providerStatus === 'failed') {
    if (!recoveryAuthorized) {
      requireObservation(observation, {
        sourceResult: 'stale-source',
        dataMode: null,
        rankingChangeKind: null,
        buildAction: null,
        parity: null,
        stateParity: null,
        checkpointParity: null,
        fallbackReason: null,
      }, 'stale-source')
      return contractFor('stale-source', 'standard')
    }
    requireObservation(observation, {
      sourceResult: 'completed',
      buildAction: 'publish-full',
      parity: null,
      stateParity: null,
      checkpointParity: null,
      fallbackReason: null,
    }, 'forced-verified-raw-rebuild')
    if (!DATA_MODES.has(observation.dataMode)) {
      throw new Error('forced-verified-raw-rebuild requires a usable validated existing raw baseline')
    }
    if (observation.rankingChangeKind !== 'full-invalidation') {
      throw new Error('forced-verified-raw-rebuild requires the current full-invalidation build classification')
    }
    return contractFor('forced-verified-raw-rebuild', 'standard')
  }

  if (observation.sourceResult === 'stale-source') {
    throw new Error('stale-source contradicts usable provider input')
  }
  if (observation.sourceResult === 'unchanged') {
    if (observation.force) throw new Error('Forced refresh cannot take an unchanged source exit')
    const earlySourceExit = observation.dataMode === null
      && observation.rankingChangeKind === null
      && observation.buildAction === null
    const canonicalNoChange = DATA_MODES.has(observation.dataMode)
      && observation.rankingChangeKind === 'no-change'
      && observation.buildAction === 'no-change'
    if ((!earlySourceExit && !canonicalNoChange)
      || observation.parity !== null
      || observation.stateParity !== null
      || observation.checkpointParity !== null
      || observation.fallbackReason !== null) {
      throw new Error('unchanged requires either the source fingerprint exit or canonical no-change build')
    }
    return contractFor('unchanged', 'ordinary')
  }

  if (!DATA_MODES.has(observation.dataMode)) {
    throw new Error('completed refresh requires a production data mode')
  }
  if (observation.rankingChangeKind === null || observation.buildAction === null) {
    throw new Error('completed refresh requires ranking classification and build action')
  }
  if (observation.rankingChangeKind === 'no-change') {
    if (observation.force) {
      throw new Error('Forced completed no-change must classify as full-invalidation')
    }
    if (observation.buildAction !== 'publish-full'
      || observation.parity !== true
      || observation.stateParity !== true
      || observation.checkpointParity !== true
      || observation.fallbackReason !== null) {
      throw new Error('completed no-change requires clean semantic, state, and checkpoint parity')
    }
    return contractFor('unchanged', 'clean-full-comparison')
  }
  if (observation.buildAction === 'no-change') {
    throw new Error('completed refresh contradicts no-change build action')
  }
  validateBuildRelationship(observation)

  if (observation.parity === false) return contractFor('parity-failure', 'standard')
  if (observation.dataMode === 'no-data') return contractFor('no-data', 'standard')
  if (observation.rankingChangeKind === 'full-invalidation') return contractFor('full-invalidation', 'standard')
  return contractFor(observation.rankingChangeKind, 'standard')
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
    const canonical = CANONICAL_OUTCOME_MATRIX[outcome]
    for (const dimension of OUTCOME_KEYS) {
      if (!samePolicy(row[dimension], canonical[dimension])) {
        throw new Error(`${outcome} ${dimension} does not match the canonical outcome policy`)
      }
    }
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
  for (const field of ['force', 'rawRecoveryAuthorized', 'validatedExistingRawBaseline']) {
    if (typeof value[field] !== 'boolean') throw new Error(`Invalid ranking refresh observation ${field}`)
  }
  assertNullableEnum(value.dataMode, DATA_MODES, 'dataMode')
  assertNullableEnum(value.rankingChangeKind, CHANGE_KINDS, 'rankingChangeKind')
  assertNullableEnum(value.buildAction, BUILD_ACTIONS, 'buildAction')
  if (value.parity !== null && typeof value.parity !== 'boolean') {
    throw new Error('Invalid ranking refresh observation parity')
  }
  for (const field of ['stateParity', 'checkpointParity']) {
    if (value[field] !== null && typeof value[field] !== 'boolean') {
      throw new Error(`Invalid ranking refresh observation ${field}`)
    }
  }
  if (value.fallbackReason !== null
    && (typeof value.fallbackReason !== 'string' || value.fallbackReason.length === 0)) {
    throw new Error('Invalid ranking refresh observation fallbackReason')
  }
  return value
}

function validateBuildRelationship(observation) {
  if (observation.parity === null
    && (observation.stateParity !== null || observation.checkpointParity !== null)) {
    throw new Error('State and checkpoint parity require a semantic comparison result')
  }
  if (observation.parity !== null
    && (observation.stateParity === null || observation.checkpointParity === null)) {
    throw new Error('Semantic comparison requires state and checkpoint parity results')
  }
  if (observation.parity === true
    && (observation.stateParity !== true || observation.checkpointParity !== true)) {
    throw new Error('Clean comparison requires semantic, state, and checkpoint parity')
  }
  if (observation.parity === false) {
    if (observation.buildAction !== 'publish-full' || observation.fallbackReason === null) {
      throw new Error('Parity failure requires a diagnosed clean full fallback')
    }
    return
  }
  if (observation.parity === true && observation.fallbackReason !== null) {
    throw new Error('Successful parity contradicts a fallback reason')
  }
  if (observation.parity === true && observation.buildAction !== 'publish-full') {
    throw new Error('Successful parity is valid only for a clean full comparison')
  }
  if (observation.buildAction === 'publish-incremental' && observation.fallbackReason !== null) {
    throw new Error('Incremental publication contradicts a fallback reason')
  }
  if (observation.buildAction === 'publish-full'
    && observation.rankingChangeKind !== 'full-invalidation'
    && observation.parity === null
    && observation.fallbackReason === null) {
    throw new Error('Full publication for an incremental change requires parity or a fallback reason')
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
  if ((row.auditEligibility === 'clean-full-replay-only'
      || row.auditEligibility === 'clean-zero-mutation-full-replay-only')
    && !row.optionalArtifacts.includes('clean-full-replay')) {
    throw new Error(`${outcome} audit eligibility requires a clean full replay`)
  }
}

function contractFor(outcome, mode) {
  const contract = outcome !== 'unchanged'
    ? RANKING_REFRESH_OUTCOME_MATRIX[outcome]
    : mode === 'clean-full-comparison'
      ? CLEAN_FULL_UNCHANGED_CONTRACT
      : ORDINARY_UNCHANGED_CONTRACT
  return { outcome, mode, contract }
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

function samePolicy(actual, expected) {
  return Array.isArray(actual) && Array.isArray(expected)
    ? actual.length === expected.length && actual.every((entry, index) => entry === expected[index])
    : actual === expected
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
