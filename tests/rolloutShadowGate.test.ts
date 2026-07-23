import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateRolloutShadowGate,
  parseRolloutShadowGateDecision,
} from '../scripts/rollout-shadow-gate.mjs'
import { rolloutEvidence, sevenDayEvidence } from './rolloutTestFixtures.ts'

test('production-like scenario fixtures establish coverage but never increase live counts', () => {
  const decision = evaluateRolloutShadowGate({
    evidence: sevenDayEvidence(),
    commit: 'abc123',
    now: '2026-07-23T00:00:00Z',
  })
  assert.equal(decision.allowed, false)
  assert.deepEqual(decision.counts, { changed: 0, unchanged: 0, live: 0 })
  assert.equal(decision.criteria.deterministicScenarioCoverage, true)
  assert.deepEqual(decision.scenarioCoverage, [
    'historical-correction',
    'latest-append',
    'same-day-insertion',
    'tournament-transition',
    'unchanged',
  ])
})

test('authoritative daily audits do not inflate changed or cheap unchanged shadow counts', () => {
  const comparisons = sevenDayEvidence().map((run) => rolloutEvidence({
    ...run,
    evidenceClass: 'live',
  }))
  const audits = Array.from({ length: 7 }, (_, index) => {
    const date = `2026-07-${String(index + 1).padStart(2, '0')}`
    return rolloutEvidence({
      evidenceClass: 'live',
      scenario: 'daily-audit',
      runId: `daily-audit-${date}`,
      execution: {
        result: 'completed',
        startedAt: `${date}T01:00:00Z`,
        finishedAt: `${date}T01:00:02Z`,
        durationMs: 2000,
      },
    })
  })
  const decision = evaluateRolloutShadowGate({
    evidence: [...comparisons, ...audits],
    commit: 'abc123',
    deploymentId: 'deployment-1',
    runId: 'native-shadow',
    evidenceClass: 'live',
    expiresAt: '2027-01-01T00:00:00Z',
    now: '2026-07-23T00:00:00Z',
  })
  assert.equal(decision.counts.changed, 7)
  assert.equal(decision.counts.unchanged, 7)
  assert.equal(decision.counts.live, 21)
  assert.equal(decision.criteria.deterministicScenarioCoverage, true)
  assert.equal(parseRolloutShadowGateDecision(decision), decision)
  assert.throws(() => parseRolloutShadowGateDecision({
    ...decision,
    criteria: { invented: true },
    allowed: true,
  }), /criteria/)
})

test('shadow gate rejects malformed parity and exact-commit/expiry mismatches', () => {
  assert.throws(() => evaluateRolloutShadowGate({
    evidence: [{ ...rolloutEvidence(), parity: {} }],
    commit: 'abc123',
  }), /parity.semantic/)
  const mismatch = evaluateRolloutShadowGate({
    evidence: [rolloutEvidence({ commit: 'different', expiresAt: '2026-07-01T00:00:00Z' })],
    commit: 'abc123',
    now: '2026-07-23T00:00:00Z',
  })
  assert.equal(mismatch.allowed, false)
  assert.equal(mismatch.criteria.exactCommit, false)
})
