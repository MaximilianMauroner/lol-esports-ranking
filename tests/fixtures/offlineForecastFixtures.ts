import { replayOfflineSeriesCohort, type SyntheticSeriesOutcome } from '../../src/lib/offlineForecastCohort.ts'
import type { ForecastReceipt } from '../../src/lib/tournamentForecast.ts'

export const before = '2026-09-01T11:00:00Z'
export const start = '2026-09-01T12:00:00Z'
export const completed = '2026-09-01T15:00:00Z'
export const outcome: SyntheticSeriesOutcome = { matchId: 'fixture-match', eventId: 'fixture-event',
  teamIds: ['alpha', 'beta'], bestOf: 5, status: 'completed', startedAt: start,
  completedAt: completed, observedAt: completed, gameWins: [3, 1] }

export function receipt(revision = '1', publishedAt = before, bestOf: 1 | 3 | 5 = 5): ForecastReceipt {
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
export function replay(receipts = [receipt()], outcomes = [outcome], more: Partial<Parameters<typeof replayOfflineSeriesCohort>[0]> = {}) {
  return replayOfflineSeriesCohort({ ledger: { version: 1,
    receipts: Object.fromEntries(receipts.map((row) => [row.receiptKey, row])), pinned: {} },
    outcomes, evidence: { kind: 'synthetic-fixture', reference: 'tests/fixtures/offlineForecastFixtures.ts' },
    asOf: '2026-09-02T00:00:00Z', modelVersion: 'fixture-model', modelConfigHash: 'fixture-config', ...more })
}
