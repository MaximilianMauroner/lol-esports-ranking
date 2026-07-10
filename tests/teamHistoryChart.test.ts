import assert from 'node:assert/strict'
import test from 'node:test'
import { chartPointFromHistoryPoint, dailyChartPointsFromHistoryPoints } from '../src/lib/teamHistoryChart.ts'
import { formatChartInfluence } from '../src/lib/chartPoints.ts'
import type { TeamHistorySeries } from '../src/lib/snapshot.ts'

type HistoryPoint = TeamHistorySeries['points'][number]

test('chart point conversion expands compact model context for tooltip display', () => {
  const point = chartPointFromHistoryPoint([
    '2026-06-14',
    1612,
    2,
    {
      event: 'LCK 2026 Rounds 1-2',
      opponent: 'Gen.G',
      result: 'W',
      wins: 3,
      losses: 2,
      delta: 11,
      model: {
        e: 0.778,
        r: 0.222,
        v: 4.8,
        s: 1.12,
        a: [['s', 4], ['l', 2], ['p', -4.9], ['f', 0.4]],
        c: [1509, 57, 40, 1.1, 0],
      },
    },
  ])

  assert.equal(point.detail?.model?.expectedWinProbability, 0.778)
  assert.equal(point.detail?.model?.residual, 0.222)
  assert.equal(point.detail?.model?.attribution?.[0]?.label, 'Team strength')
  assert.equal(point.detail?.model?.attribution?.[1]?.label, 'League strength')
  assert.deepEqual(point.detail?.model?.attribution?.map((entry) => [entry.key, entry.value]), [
    ['stable', 4],
    ['league', 2],
    ['placement', -4.9],
    ['form', 0.4],
  ])
  assert.deepEqual(point.detail?.model?.components?.map((entry) => [entry.key, entry.value]), [
    ['league', 1509],
    ['stable', 57],
    ['roster', 40],
    ['form', 1.1],
    ['context', 0],
  ])
  assert.equal(point.detail?.model?.components?.[0]?.label, 'League strength')
})

test('daily chart aggregation preserves same-day matches and reconciles visible movement', () => {
  const points: HistoryPoint[] = [
    [
      '2026-06-01',
      1500,
      4,
      { event: 'Opening', opponent: 'Alpha', result: 'W', wins: 1, losses: 0, delta: 3, model: { a: [['s', 3]], c: [1500, 0, 40, 0, 0] } },
    ],
    [
      '2026-06-02',
      1510,
      3,
      { event: 'Cup', opponent: 'Beta', result: 'W', wins: 1, losses: 0, delta: 10, model: { a: [['s', 6], ['f', 4]], c: [1500, 6, 40, 4, 0] } },
    ],
    [
      '2026-06-02',
      1507,
      4,
      { event: 'Cup', opponent: 'Gamma', result: 'L', wins: 0, losses: 1, delta: -3, model: { a: [['s', -2], ['f', -1]], c: [1500, 4, 40, 3, 0] } },
    ],
  ]

  const daily = dailyChartPointsFromHistoryPoints(points)

  assert.equal(daily.length, 2)
  assert.equal(daily[1].y, 1507)
  assert.equal(daily[1].detail?.visibleDelta, 7)
  assert.equal(daily[1].detail?.delta, 7)
  assert.equal(daily[1].detail?.dayMatchCount, 2)
  assert.equal(daily[1].detail?.dayMatches?.map((match) => match.opponent).join(','), 'Beta,Gamma')
  assert.deepEqual(daily[1].detail?.model?.attribution?.map((entry) => [entry.key, entry.value]), [
    ['stable', 4],
    ['form', 3],
  ])
  assert.deepEqual(daily[1].detail?.model?.componentAttribution?.map((entry) => [entry.key, entry.value]), [
    ['stable', 4],
    ['form', 3],
  ])
})

test('daily chart aggregation separates final standing adjustment from the match result', () => {
  const points: HistoryPoint[] = [
    [
      '2026-06-01',
      1500,
      4,
      { event: 'Opening', opponent: 'Alpha', result: 'W', wins: 1, losses: 0, delta: 3, model: { c: [1500, 0, 40, 0, 0] } },
    ],
    [
      '2026-06-02',
      1510,
      3,
      { event: 'MSI 2026', opponent: 'Team Liquid', result: 'W', wins: 3, losses: 0, delta: 6, model: { e: 0.778, c: [1500, 6, 40, 4, 0] } },
    ],
    [
      '2026-06-02',
      1506,
      3,
      { kind: 'standing-adjustment', event: 'Published standing adjustment', delta: -4, model: { c: [1496, 6, 40, 4, 0] } },
    ],
  ]

  const daily = dailyChartPointsFromHistoryPoints(points)

  assert.equal(daily[1].y, 1506)
  assert.equal(daily[1].detail?.visibleDelta, 6)
  assert.equal(daily[1].detail?.kind, 'standing-adjustment')
  assert.equal(daily[1].detail?.delta, -4)
  assert.equal(daily[1].detail?.dayMatchCount, 1)
  assert.equal(daily[1].detail?.dayMatches?.[0]?.opponent, 'Team Liquid')
  assert.equal(daily[1].detail?.dayMatches?.[1]?.event, 'Published standing adjustment')
  assert.equal(daily[1].detail?.model?.expectedWinProbability, 0.778)
  assert.deepEqual(daily[1].detail?.model?.componentAttribution?.map((entry) => [entry.key, entry.value]), [
    ['league', -4],
    ['stable', 6],
    ['form', 4],
  ])
  assert.equal(daily[1].detail?.model?.componentAttribution?.[0]?.label, 'League strength')
})

test('tournament boundaries remain annotations instead of counted match results', () => {
  const points: HistoryPoint[] = [
    ['2026-07-01', 1500, 4, { kind: 'tournament-start', event: 'MSI 2026 start' }],
    ['2026-07-01', 1512, 3, { kind: 'match', event: 'MSI 2026', opponent: 'Alpha', result: 'W', delta: 12 }],
    ['2026-07-10', 1520, 2, { kind: 'tournament-today', event: 'MSI 2026 today' }],
  ]

  const daily = dailyChartPointsFromHistoryPoints(points)

  assert.equal(daily[0]?.detail?.dayMatchCount, 1)
  assert.equal(daily[0]?.detail?.dayMatches?.[0]?.kind, 'tournament-start')
  assert.equal(daily[1]?.detail?.kind, 'tournament-today')
  assert.equal(formatChartInfluence(daily[1]?.detail), 'MSI 2026 today')
})
