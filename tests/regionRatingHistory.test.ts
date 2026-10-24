import assert from 'node:assert/strict'
import test from 'node:test'
import { regionRatingHistory } from '../src/domains/rankings/read.ts'
import type { PublicRegionHistoryPoint, PublicRegionHistoryScope } from '../src/domains/rankings/types.ts'

function checkpoint(date: string, score: number, teams: string[]): PublicRegionHistoryPoint {
  return [date, score, 1, { event: 'Eligible top-team power checkpoint', source: 'region-power-history', contributingTeams: teams }]
}

function scope(series: Record<string, PublicRegionHistoryPoint[]>): PublicRegionHistoryScope {
  return {
    filter: { season: '2026', event: 'All', region: 'All' },
    regionCount: Object.keys(series).length,
    pointCount: Object.values(series).flat().length,
    leagueStrengthSeries: {},
    regionPowerSeries: Object.fromEntries(Object.entries(series).map(([region, points]) => [region, { region, points }])),
    metricDefinitions: { leagueStrength: 'League strength.', regionPower: 'Top three team average.' },
  }
}

const history = scope({
  LCK: [
    checkpoint('2026-01-10', 1800, ['Gen.G', 'T1', 'KT Rolster']),
    checkpoint('2026-01-12', 1810, ['T1', 'Gen.G', 'KT Rolster']),
  ],
  LEC: [
    checkpoint('2026-01-11', 1700, ['G2 Esports', 'Fnatic']),
    checkpoint('2026-01-14', 1690, ['G2 Esports', 'Fnatic', 'Team Vitality']),
  ],
  LPL: [checkpoint('2026-01-09', 1900, ['Bilibili Gaming', 'Top Esports', 'JD Gaming'])],
})

test('each shown region has a value on every day from its first update to the last update of the shown regions', () => {
  assert.deepEqual(regionRatingHistory(history, ['LEC', 'LCK']), [
    {
      region: 'LEC',
      points: [
        { date: '2026-01-11', meanTop3: 1700, teams: ['G2 Esports', 'Fnatic'] },
        { date: '2026-01-12', meanTop3: 1700, teams: ['G2 Esports', 'Fnatic'] },
        { date: '2026-01-13', meanTop3: 1700, teams: ['G2 Esports', 'Fnatic'] },
        { date: '2026-01-14', meanTop3: 1690, teams: ['G2 Esports', 'Fnatic', 'Team Vitality'] },
      ],
    },
    {
      region: 'LCK',
      points: [
        { date: '2026-01-10', meanTop3: 1800, teams: ['Gen.G', 'T1', 'KT Rolster'] },
        { date: '2026-01-11', meanTop3: 1800, teams: ['Gen.G', 'T1', 'KT Rolster'] },
        { date: '2026-01-12', meanTop3: 1810, teams: ['T1', 'Gen.G', 'KT Rolster'] },
        { date: '2026-01-13', meanTop3: 1810, teams: ['T1', 'Gen.G', 'KT Rolster'] },
        { date: '2026-01-14', meanTop3: 1810, teams: ['T1', 'Gen.G', 'KT Rolster'] },
      ],
    },
  ])
})

test('a region that is not shown adds no days', () => {
  assert.deepEqual(regionRatingHistory(history, ['LPL']), [
    { region: 'LPL', points: [{ date: '2026-01-09', meanTop3: 1900, teams: ['Bilibili Gaming', 'Top Esports', 'JD Gaming'] }] },
  ])
})

test('a region without published history has no points', () => {
  assert.deepEqual(regionRatingHistory(history, ['LCS', 'LPL']), [
    { region: 'LCS', points: [] },
    { region: 'LPL', points: [{ date: '2026-01-09', meanTop3: 1900, teams: ['Bilibili Gaming', 'Top Esports', 'JD Gaming'] }] },
  ])
  assert.deepEqual(regionRatingHistory(history, ['LCS']), [{ region: 'LCS', points: [] }])
})
