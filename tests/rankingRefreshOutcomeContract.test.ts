import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeRankingRefreshOutcome,
  parseRankingRefreshOutcomeMatrix,
  RANKING_REFRESH_OUTCOME_MATRIX,
  RANKING_REFRESH_OUTCOMES,
} from '../scripts/ranking-refresh-outcome-contract.mjs'
import type { RankingRefreshObservation, RankingRefreshOutcome } from '../scripts/ranking-refresh-outcome-contract.mjs'

const expectedOutcomes: RankingRefreshOutcome[] = [
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
]
const dimensions = [
  'requiredInputs',
  'optionalArtifacts',
  'allowedWrites',
  'authorityAdvancement',
  'reconciliationBehavior',
  'auditEligibility',
  'retryState',
]

test('canonical matrix is closed, frozen, and specifies all seven dimensions for every outcome', () => {
  assert.deepEqual(RANKING_REFRESH_OUTCOMES, expectedOutcomes)
  assert.equal(parseRankingRefreshOutcomeMatrix(structuredClone(RANKING_REFRESH_OUTCOME_MATRIX)) !== null, true)
  assert.equal(Object.isFrozen(RANKING_REFRESH_OUTCOME_MATRIX), true)
  for (const outcome of expectedOutcomes) {
    const row = RANKING_REFRESH_OUTCOME_MATRIX[outcome]
    assert.deepEqual(Object.keys(row), dimensions, outcome)
    assert.equal(Object.isFrozen(row), true, outcome)
    assert.equal(Object.isFrozen(row.requiredInputs), true, outcome)
    assert.equal(Object.isFrozen(row.optionalArtifacts), true, outcome)
    assert.equal(Object.isFrozen(row.allowedWrites), true, outcome)
  }
})

test('normalization binds all ten canonical outcomes to current runtime vocabularies', () => {
  const observations: Record<RankingRefreshOutcome, RankingRefreshObservation> = {
    unchanged: observation({
      sourceResult: 'unchanged',
      dataMode: null,
      rankingChangeKind: null,
      buildAction: null,
    }),
    'latest-append': changeObservation('latest-append'),
    'same-day-insertion': changeObservation('same-day-insertion'),
    'historical-correction': changeObservation('historical-correction'),
    'metadata-only': changeObservation('metadata-only'),
    'stale-source': observation({
      sourceResult: 'stale-source',
      providerStatus: 'failed',
      dataMode: null,
      rankingChangeKind: null,
      buildAction: null,
    }),
    'no-data': observation({
      dataMode: 'no-data',
      rankingChangeKind: 'full-invalidation',
      buildAction: 'publish-full',
    }),
    'forced-verified-raw-rebuild': observation({
      providerStatus: 'failed',
      force: true,
      rawRecoveryAuthorized: true,
      verifiedRawAuthority: true,
      rankingChangeKind: 'full-invalidation',
      buildAction: 'publish-full',
    }),
    'parity-failure': observation({
      rankingChangeKind: 'latest-append',
      buildAction: 'publish-full',
      parity: false,
      fallbackReason: 'semantic-parity-mismatch',
    }),
    'full-invalidation': observation({
      rankingChangeKind: 'full-invalidation',
      buildAction: 'publish-full',
    }),
  }

  for (const outcome of expectedOutcomes) {
    assert.equal(normalizeRankingRefreshOutcome(observations[outcome]).outcome, outcome)
  }
})

test('matrix and observations reject missing, extra, unknown, and contradictory states', () => {
  const matrix = Object.fromEntries(
    Object.entries(RANKING_REFRESH_OUTCOME_MATRIX).filter(([outcome]) => outcome !== 'unchanged'),
  )
  assert.throws(() => parseRankingRefreshOutcomeMatrix(matrix), /unexpected or missing keys/)
  assert.throws(
    () => parseRankingRefreshOutcomeMatrix({ ...RANKING_REFRESH_OUTCOME_MATRIX, invented: RANKING_REFRESH_OUTCOME_MATRIX.unchanged }),
    /unexpected or missing keys/,
  )
  assert.throws(
    () => parseRankingRefreshOutcomeMatrix({
      ...RANKING_REFRESH_OUTCOME_MATRIX,
      unchanged: { ...RANKING_REFRESH_OUTCOME_MATRIX.unchanged, retryState: 'invented' },
    }),
    /retryState/,
  )
  assert.throws(
    () => parseRankingRefreshOutcomeMatrix({
      ...RANKING_REFRESH_OUTCOME_MATRIX,
      unchanged: {
        ...RANKING_REFRESH_OUTCOME_MATRIX.unchanged,
        allowedWrites: [...RANKING_REFRESH_OUTCOME_MATRIX.unchanged.allowedWrites, 'active-authority'],
      },
    }),
    /advancement is forbidden/,
  )
  assert.throws(() => normalizeRankingRefreshOutcome({ ...changeObservation('latest-append'), invented: true }), /unexpected or missing keys/)
  assert.throws(() => normalizeRankingRefreshOutcome({
    ...changeObservation('latest-append'),
    sourceResult: 'stale-source',
  }), /contradicts usable provider/)
  assert.throws(() => normalizeRankingRefreshOutcome({
    ...changeObservation('latest-append'),
    buildAction: 'publish-incremental',
    parity: false,
    fallbackReason: 'semantic-parity-mismatch',
  }), /clean full fallback/)
  assert.throws(() => normalizeRankingRefreshOutcome({
    ...observation({ rankingChangeKind: 'full-invalidation' }),
    buildAction: 'publish-incremental',
  }), /clean full replay/)
})

test('verified raw recovery requires force, separate authorization, and verified prior authority', () => {
  for (const [force, rawRecoveryAuthorized, verifiedRawAuthority] of [
    [false, false, true],
    [true, false, true],
    [false, true, true],
    [true, true, false],
  ] as const) {
    const normalized = normalizeRankingRefreshOutcome(observation({
      sourceResult: 'stale-source',
      providerStatus: 'failed',
      force,
      rawRecoveryAuthorized,
      verifiedRawAuthority,
      dataMode: null,
      rankingChangeKind: null,
      buildAction: null,
    }))
    assert.equal(normalized.outcome, 'stale-source')
    assert.equal(normalized.contract.authorityAdvancement, 'never')
  }

  assert.equal(normalizeRankingRefreshOutcome(observation({
    providerStatus: 'failed',
    force: true,
    rawRecoveryAuthorized: true,
    verifiedRawAuthority: true,
    rankingChangeKind: 'full-invalidation',
    buildAction: 'publish-full',
  })).outcome, 'forced-verified-raw-rebuild')
})

function changeObservation(kind: Exclude<RankingRefreshObservation['rankingChangeKind'], 'no-change' | 'full-invalidation' | null>) {
  return observation({ rankingChangeKind: kind })
}

function observation(overrides: Partial<RankingRefreshObservation>): RankingRefreshObservation {
  return {
    sourceResult: 'completed',
    providerStatus: 'usable',
    force: false,
    rawRecoveryAuthorized: false,
    verifiedRawAuthority: false,
    dataMode: 'scheduled-public-data',
    rankingChangeKind: 'latest-append',
    buildAction: 'publish-incremental',
    parity: null,
    fallbackReason: null,
    ...overrides,
  }
}
