import assert from 'node:assert/strict'
import test from 'node:test'
import { replayOfflineSeriesCohort, type SyntheticSeriesOutcome } from '../src/lib/offlineForecastCohort.ts'
import { isForecastLedger, type ForecastReceipt } from '../src/lib/tournamentForecast.ts'

const before = '2026-09-01T11:00:00Z'
const start = '2026-09-01T12:00:00Z'
const completed = '2026-09-01T15:00:00Z'
const outcome: SyntheticSeriesOutcome = { matchId: 'fixture-match', eventId: 'fixture-event',
  teamIds: ['alpha', 'beta'], bestOf: 5, status: 'completed', startedAt: start,
  completedAt: completed, observedAt: completed, gameWins: [3, 1] }

function receipt(revision = '1', publishedAt = before, bestOf: 1 | 3 | 5 = 5): ForecastReceipt {
  const eventStateVersion = JSON.stringify(['fixture-match', 'fixture-event', start, 'upcoming', 'unstarted', bestOf,
    [['alpha', null, null], ['beta', null, null]]])
  const team = (id: string): ForecastReceipt['teams'][number] => ({ sourceTeamId: id, teamId: id,
    name: id, rating: 1500, uncertainty: 100, rosterBasis: 'unknown' })
  return { status: 'ready', matchId: 'fixture-match', eventId: 'fixture-event', bestOf,
    sideAssumption: 'neutral', sideBasis: 'synthetic fixture', blueSideRatingEdge: 0,
    teams: [team('alpha'), team('beta')],
    homeGameWinProbability: 0.5, awayGameWinProbability: 0.5,
    homeSeriesWinProbability: 0.5, awaySeriesWinProbability: 0.5,
    modelVersion: 'fixture-model', modelConfigHash: 'fixture-config', snapshotId: 'fixture-snapshot',
    ratingDataAsOf: before, ratingPublishedAt: before, identityRevision: 'fixture-identities',
    dataMode: 'seeded-sample', warnings: ['Synthetic fixture'],
    receiptKey: JSON.stringify(['fixture-match', eventStateVersion, revision]), eventStateVersion,
    forecastRevision: revision, generatedAt: before, publishedAt, sourceObservedAt: before,
    scheduledStartAt: start, evaluationEligible: false }
}
function replay(receipts = [receipt()], outcomes = [outcome], more: Partial<Parameters<typeof replayOfflineSeriesCohort>[0]> = {}) {
  return replayOfflineSeriesCohort({ ledger: { version: 1,
    receipts: Object.fromEntries(receipts.map((row) => [row.receiptKey, row])), pinned: {} },
    outcomes, evidence: { kind: 'synthetic-fixture', reference: 'tests/offlineForecastCohort.test.ts' },
    asOf: '2026-09-02T00:00:00Z', modelVersion: 'fixture-model', modelConfigHash: 'fixture-config', ...more })
}

test('latest compatible pre-start receipt supplies one series row with explicit offline ineligibility', () => {
  const receipts = [receipt(), receipt('2', '2026-09-01T11:30:00Z')]
  const original = structuredClone({ receipts, outcome })
  const result = replay(receipts, [outcome, structuredClone(outcome)])
  assert.equal(result.status, 'replayed')
  if (result.status !== 'replayed') return
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].receiptKey, receipts[1].receiptKey)
  assert.equal(result.rows[0].homeWinProbability, 0.5)
  assert.equal(result.rows[0].homeWon, true)
  assert.equal(result.duplicateOutcomeRows, 1)
  assert.equal(result.evaluationEligible, false)
  assert.equal(result.calibration.reason, 'published-evaluation-receipts-unavailable')
  assert.deepEqual(replay([...receipts].reverse(), [outcome, structuredClone(outcome)]), result)
  assert.deepEqual({ receipts, outcome }, original)
})

test('conflicting outcomes cannot be selected by input order', () => {
  const conflicting = { ...outcome, gameWins: [1, 3] as [number, number] }
  const a = replay(undefined, [outcome, outcome, conflicting])
  assert.deepEqual(a, replay(undefined, [conflicting, outcome, outcome]))
  assert.equal(a.status, 'replayed')
  if (a.status === 'replayed') {
    assert.deepEqual(a.rows, [])
    assert.deepEqual(a.exclusions, [{ matchId: outcome.matchId, reason: 'conflicting-outcomes' }])
  }
})

test('Bo1 and Bo3 remain series targets and same-time revisions have deterministic ordering', () => {
  for (const bestOf of [1, 3] as const) {
    const a = receipt('1', before, bestOf)
    const b = receipt('2', before, bestOf)
    const observed = { ...outcome, bestOf, gameWins: [0, Math.floor(bestOf / 2) + 1] as [number, number] }
    const result = replay([a, b], [observed])
    assert.equal(result.status, 'replayed')
    if (result.status !== 'replayed') continue
    assert.equal(result.rows[0].bestOf, bestOf)
    assert.equal(result.rows[0].receiptKey, b.receiptKey)
    assert.equal(result.rows[0].homeWon, false)
    assert.deepEqual(result, replay([b, a], [observed]))
  }
})

test('actual early start excludes a receipt even when its scheduled-start contract is valid', () => {
  const candidate = receipt('2', '2026-09-01T11:30:00Z')
  assert.ok(isForecastLedger({ version: 1, receipts: { [candidate.receiptKey]: candidate }, pinned: {} }))
  const result = replay([candidate], [{ ...outcome, startedAt: candidate.publishedAt }])
  assert.equal(result.status, 'replayed')
  if (result.status === 'replayed') assert.equal(result.exclusions[0].reason, 'no-prestart-receipt')
})

test('a future correction cannot rewrite or conflict with an in-window cohort', () => {
  const future = { ...outcome, observedAt: '2026-09-03T00:00:00Z', gameWins: [1, 3] as [number, number] }
  const baseline = replay()
  const result = replay(undefined, [future, outcome])
  assert.equal(result.status, 'replayed')
  if (result.status !== 'replayed' || baseline.status !== 'replayed') return
  assert.deepEqual(result.rows, baseline.rows)
  assert.deepEqual(result.exclusions, [])
  assert.equal(result.afterCutoffOutcomeRows, 1)
  assert.deepEqual(result, replay(undefined, [outcome, future]))
})

test('missing, incompatible and changed participant receipts are excluded separately', () => {
  for (const [result, reason] of [
    [replay([]), 'missing-receipt'],
    [replay(undefined, undefined, { modelConfigHash: 'new-config' }), 'incompatible-model'],
    [replay(undefined, [{ ...outcome, teamIds: ['beta', 'alpha'] }]), 'mismatched-series'],
  ] as const) {
    assert.equal(result.status, 'replayed')
    if (result.status === 'replayed') assert.equal(result.exclusions[0].reason, reason)
  }
})

test('cancellations, unresolved results, invalid terminal scores and future observations are excluded', () => {
  for (const [changes, reason] of [
    [{ status: 'cancelled' }, 'cancelled'], [{ status: 'unresolved' }, 'unresolved'],
    [{ gameWins: [3, 3] }, 'invalid-outcome'], [{ gameWins: [2, 1] }, 'invalid-outcome'],
    [{ observedAt: '2026-09-03T00:00:00Z' }, 'outcome-after-cutoff'],
    [{ observedAt: before }, 'invalid-outcome'],
  ] as Array<[Partial<SyntheticSeriesOutcome>, string]>) {
    const result = replay(undefined, [{ ...outcome, ...changes }])
    assert.equal(result.status, 'replayed')
    if (result.status === 'replayed') assert.equal(result.exclusions[0].reason, reason)
  }
})

test('invalid ledger or policy never becomes an evaluation cohort', () => {
  assert.deepEqual(replay(undefined, undefined, { ledger: {} }), { status: 'unsupported', reason: 'invalid-ledger' })
  assert.deepEqual(replay(undefined, undefined, { asOf: 'invalid' }), { status: 'unsupported', reason: 'invalid-policy' })
  assert.deepEqual(replay(undefined, undefined, { evidence: { kind: 'synthetic-fixture', reference: '' } }),
    { status: 'unsupported', reason: 'synthetic-evidence-required' })
  const corrupted = { ...receipt(), evaluationEligible: true } as unknown as ForecastReceipt
  assert.deepEqual(replay([corrupted]), { status: 'unsupported', reason: 'invalid-ledger' })
})
