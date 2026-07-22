import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acknowledgeMatches,
  applyScheduleProbe,
  assertRefreshCadence,
  completionEvidence,
  duePendingMatchIds,
  emptyTriggerState,
  recordPendingAttempt,
  retryDelayMs,
  shouldFetchScoredProviders,
} from '../scripts/refresh-trigger-state.mjs'

const completed = {
  matchId: 'match-1',
  state: 'completed',
  startTime: '2026-07-11T12:00:00Z',
  teams: [
    { id: 'a', outcome: 'win', gameWins: 2 },
    { id: 'b', outcome: 'loss', gameWins: 1 },
  ],
}

test('completion requires stable identity, two teams, terminal state, and final result', () => {
  assert.equal(completionEvidence(completed).complete, true)
  assert.deepEqual(completionEvidence({ ...completed, state: 'inProgress' }).reasons, ['non-terminal-state'])
  assert.deepEqual(completionEvidence({ ...completed, teams: completed.teams.map(({ id }) => ({ id })) }).reasons, ['missing-final-result'])
})

test('completion accepts a completed best-of-two tie with a final score', () => {
  assert.equal(completionEvidence({
    matchId: 'bo2-tie',
    state: 'completed',
    teams: [
      { id: 'blue', gameWins: 1 },
      { id: 'red', gameWins: 1 },
    ],
  }).complete, true)
})

test('schedule probes queue completions once and preserve watermark on incomplete coverage', () => {
  const first = applyScheduleProbe(emptyTriggerState('shadow'), {
    mode: 'shadow',
    checkedAt: '2026-07-11T13:00:00Z',
    coverageStart: '2026-07-11T00:00:00Z',
    coverageEnd: '2026-07-11T13:00:00Z',
    coverageComplete: true,
    events: [completed],
  })
  const second = applyScheduleProbe(first, {
    checkedAt: '2026-07-11T14:00:00Z',
    coverageStart: '2026-07-11T12:30:00Z',
    coverageEnd: '2026-07-11T14:00:00Z',
    coverageComplete: false,
    events: [completed],
  })

  assert.deepEqual(Object.keys(second.pending), ['match-1'])
  assert.equal(second.metrics.completedDetectedCount, 1)
  assert.equal(second.observationWatermark, '2026-07-11T13:00:00.000Z')
})

test('gated fetches occur only for due pending work, audits, or manual recovery', () => {
  const shadow = applyScheduleProbe(emptyTriggerState('shadow'), {
    checkedAt: '2026-07-11T13:00:00Z',
    coverageComplete: true,
    events: [completed],
  })
  assert.equal(shouldFetchScoredProviders(shadow, { now: '2026-07-11T13:00:00Z' }), false)
  assert.equal(shouldFetchScoredProviders({ ...shadow, mode: 'gated' }, { now: '2026-07-11T13:00:00Z' }), true)
  assert.equal(shouldFetchScoredProviders(emptyTriggerState('gated'), { correctionAuditDue: true }), true)
  assert.equal(shouldFetchScoredProviders(emptyTriggerState('legacy'), { manual: true }), true)
})

test('provider lag backs off and exact reconciliation alone acknowledges work', () => {
  const queued = applyScheduleProbe(emptyTriggerState('gated'), {
    checkedAt: '2026-07-11T13:00:00Z',
    coverageComplete: true,
    events: [completed],
  })
  const attempted = recordPendingAttempt(queued, ['match-1'], { attemptedAt: '2026-07-11T13:00:00Z' })
  assert.equal(retryDelayMs(1), 15 * 60_000)
  assert.deepEqual(duePendingMatchIds(attempted, '2026-07-11T13:14:59Z'), [])
  assert.deepEqual(duePendingMatchIds(attempted, '2026-07-11T13:15:00Z'), ['match-1'])
  assert.ok(acknowledgeMatches(attempted, [{ matchId: 'match-1', status: 'ambiguous' }]).pending['match-1'])
  const acknowledged = acknowledgeMatches(attempted, [{
    matchId: 'match-1',
    status: 'exact',
    canonicalSeriesId: 'series-1',
    scoredGameIds: ['game-1', 'game-2', 'game-3'],
  }])
  assert.equal(acknowledged.pending['match-1'], undefined)
  assert.equal(acknowledged.acknowledged['match-1'].canonicalSeriesId, 'series-1')
})

test('five-minute cadence is gated by cheap-exit and lease evidence', () => {
  assert.equal(assertRefreshCadence({ intervalMinutes: 5, mode: 'gated', cheapExitProven: true, leaseFencingConfigured: true }), true)
  assert.throws(() => assertRefreshCadence({ intervalMinutes: 5, mode: 'legacy', cheapExitProven: true, leaseFencingConfigured: true }), /gated-mode/)
  assert.throws(() => assertRefreshCadence({ intervalMinutes: 5, mode: 'gated', cheapExitProven: false, leaseFencingConfigured: true }), /proven-cheap-exit/)
  assert.throws(() => assertRefreshCadence({ intervalMinutes: 5, mode: 'gated', cheapExitProven: true, leaseFencingConfigured: false }), /lease-fencing/)
  assert.equal(assertRefreshCadence({ intervalMinutes: 360, mode: 'legacy' }), true)
})
