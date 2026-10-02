import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveSpicyTakeConfidence } from '../src/lib/rankingFlair.ts'
import { createStaticRankingData, createStaticRankingSummaryData, snapshotKey } from '../src/lib/snapshot.ts'
import type { MatchRecord, TeamProfile } from '../src/types.ts'

const teams: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
  Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
}

test('filtered rolling endpoint is truncated at its latest rated match', () => {
  const matches = [
    match('baseline', '2026-01-01', 'Target Cup', 'Alpha'),
    match('endpoint', '2026-02-01', 'Target Cup', 'Alpha'),
    match('later', '2026-03-01', 'Other Cup', 'Beta'),
  ]
  const full = createStaticRankingData({ matches, teams, rosters: {} })
  const truncated = createStaticRankingData({ matches: matches.slice(0, 2), teams, rosters: {} })
  const event = full.snapshots[snapshotKey({ season: 'All', event: 'Target Cup', region: 'All' })]
  const expected = truncated.snapshots[truncated.defaultSnapshotKey].standings.find((standing) => standing.team === 'Alpha')
  const alpha = event.standings.find((standing) => standing.team === 'Alpha')

  assert.equal(event.rollingWindow?.endDate, '2026-02-01')
  assert.equal(alpha?.rollingMovement?.currentRating, expected?.rating)
  assert.notEqual(alpha?.rollingMovement?.currentRating, alpha?.rating)
  assert.deepEqual(
    alpha?.rollingMovement?.rankPoints.map(([date]) => date),
    ['2026-01-02', '2026-02-01'],
  )
})

test('rolling ranks end at the published board for every scope, including filtered history', () => {
  const data = createStaticRankingData({
    matches: [
      match('baseline', '2026-01-01', 'Target Cup', 'Alpha'),
      match('endpoint', '2026-02-01', 'Target Cup', 'Alpha'),
      ...Array.from({ length: 15 }, (_, index) => match(`later-${index}`, `2026-03-${String(index + 1).padStart(2, '0')}`, 'Other Cup', 'Beta')),
    ],
    teams,
    rosters: {},
  })
  const event = data.snapshots[snapshotKey({ season: 'All', event: 'Target Cup', region: 'All' })]
  const alpha = event.standings.find((standing) => standing.team === 'Alpha')!
  const historicalEndpoint = alpha.history.at(-1)!
  assert.notEqual(historicalEndpoint.rank, alpha.rank, 'fixture must expose the history/board disagreement')

  for (const snapshot of Object.values(createStaticRankingSummaryData(data).snapshots)) {
    for (const standing of snapshot.standings) {
      const movement = standing.rollingMovement
      if (!movement) continue
      assert.equal(movement.currentRank, standing.rank)
      assert.deepEqual(movement.rankPoints.at(-1), [snapshot.rollingWindow?.endDate, standing.rank])
      if (movement.baselineRank !== undefined) {
        assert.equal(movement.rankMovement, movement.baselineRank - standing.rank)
      }
    }
  }
})

test('teams without a rolling baseline still end at their published rank', () => {
  const data = createStaticRankingData({
    matches: [
      match('baseline', '2026-01-01', 'Target Cup', 'Alpha'),
      { ...match('new-team', '2026-02-01', 'Target Cup', 'Alpha'), teamB: 'Gamma' },
    ],
    teams: { ...teams, Gamma: { name: 'Gamma', code: 'GAM', region: 'LCK', league: 'LCK' } },
    rosters: {},
  })
  const snapshot = createStaticRankingSummaryData(data).snapshots[data.defaultSnapshotKey]
  const gamma = snapshot.standings.find((standing) => standing.team === 'Gamma')!
  assert.equal(gamma.rollingMovement?.status, 'missing-baseline')
  assert.equal(gamma.rollingMovement?.currentRank, gamma.rank)
  assert.deepEqual(gamma.rollingMovement?.rankPoints.at(-1), [snapshot.rollingWindow?.endDate, gamma.rank])
  assert.equal(gamma.rollingMovement?.rankMovement, undefined)
})

test('rolling summaries cover upset and evidence beyond the 25 recent-match display cap', () => {
  const baseline = Array.from({ length: 10 }, (_, index) => (
    match(`baseline-${index}`, `2026-01-${String(index + 1).padStart(2, '0')}`, 'Long Split', 'Beta')
  ))
  const window = Array.from({ length: 27 }, (_, index) => (
    match(`window-${index}`, `2026-02-${String(index + 1).padStart(2, '0')}`, 'Long Split', index === 0 ? 'Alpha' : 'Beta')
  ))
  const data = createStaticRankingData({ matches: [...baseline, ...window], teams, rosters: {} })
  const { snapshots } = createStaticRankingSummaryData(data)
  const alpha = snapshots[data.defaultSnapshotKey].standings.find((standing) => standing.team === 'Alpha')

  assert.equal(alpha?.recentMatches.length, 25)
  assert.equal(alpha?.rollingMovement?.scoredSeries, 27)
  assert.equal(alpha?.rollingMovement?.biggestUpsetWin?.date, '2026-02-01')
  assert.equal(deriveSpicyTakeConfidence(alpha!, snapshots[data.defaultSnapshotKey].rollingWindow).recentMatchCount, 27)
})

function match(id: string, date: string, event: string, winner: 'Alpha' | 'Beta'): MatchRecord {
  return {
    id,
    sourceProvider: 'seed',
    sourceMatchId: id,
    dataCompleteness: 'complete',
    date,
    season: 2026,
    event,
    phase: 'Regular season',
    region: 'LCK',
    league: 'LCK',
    patch: '26.1',
    bestOf: 1,
    tier: 'regional-regular',
    teamA: 'Alpha',
    teamB: 'Beta',
    winner,
    teamAKills: winner === 'Alpha' ? 20 : 5,
    teamBKills: winner === 'Beta' ? 20 : 5,
    teamAGold: winner === 'Alpha' ? 65000 : 50000,
    teamBGold: winner === 'Beta' ? 65000 : 50000,
  }
}
