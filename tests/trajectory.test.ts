import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { deriveTrajectoryInsight, FACTOR_LABELS } from '../src/views/rankings/trajectory.ts'
import type { RankingSummaryStanding, TeamHistorySeries } from '../src/domains/rankings/internal/projections/snapshot.ts'

function standing(overrides: Partial<RankingSummaryStanding> = {}): RankingSummaryStanding {
  return {
    team: 'Test',
    code: 'TST',
    region: 'LCK',
    league: 'LCK',
    rosterBasis: 'sourced',
    baseRating: 1500,
    leagueScore: 0,
    leagueAdjustment: 0,
    leagueDelta: 0,
    rating: 1600,
    previousRating: 1590,
    delta: 10,
    rank: 1,
    previousRank: 2,
    movement: 1,
    wins: 4,
    losses: 1,
    confidence: 80,
    uncertainty: 50,
    form: ['W', 'W', 'L', 'W', 'W'],
    strongestFactor: 'execution',
    eligibility: { eligible: true } as RankingSummaryStanding['eligibility'],
    factors: { context: 0.1, recency: 0.2, execution: 0.5, opponent: 0.1, league: 0.1 },
    recentEvents: [],
    ...overrides,
  } as RankingSummaryStanding
}

function series(points: [string, number, number][]): TeamHistorySeries {
  const latest = points.at(-1) ?? ['2025-01-01', 1500, 1]
  return {
    team: 'Test',
    code: 'TST',
    region: 'LCK',
    points,
    currentStanding: {
      asOf: latest[0],
      rating: latest[1],
      rank: latest[2],
      lastMatchRating: latest[1],
      adjustment: 0,
    },
  }
}

test('returns null when there is not enough history to chart', () => {
  assert.equal(deriveTrajectoryInsight(standing(), undefined), null)
  assert.equal(deriveTrajectoryInsight(standing(), series([['2025-01-01', 1500, 5]])), null)
})

test('reports net change, peak, trough, and rank climb', () => {
  const insight = deriveTrajectoryInsight(
    standing(),
    series([
      ['2025-01-01', 1500, 5],
      ['2025-02-01', 1450, 8],
      ['2025-03-01', 1620, 1],
    ]),
  )
  assert.ok(insight)
  assert.equal(insight.start, 1500)
  assert.equal(insight.current, 1620)
  assert.equal(insight.netChange, 120)
  assert.equal(insight.peak.value, 1620)
  assert.equal(insight.trough.value, 1450)
  assert.equal(insight.bestRank, 1)
  assert.equal(insight.rankChange, 4) // started 5th, now 1st => climbed 4
})

test('summary describes the climb, rank gain, and form; driver is exposed separately', () => {
  const insight = deriveTrajectoryInsight(
    standing({ strongestFactor: 'opponent' }),
    series([
      ['2025-01-01', 1400, 9],
      ['2025-03-01', 1600, 2],
    ]),
  )
  assert.ok(insight)
  assert.match(insight.summary, /Up 200 from/)
  assert.match(insight.summary, /Up 7 places/)
  assert.match(insight.summary, /4-1 last 5/)
  assert.equal(insight.driver?.label, FACTOR_LABELS.opponent)
})

test('leads with the slide when a team has fallen off its peak', () => {
  const insight = deriveTrajectoryInsight(
    standing({ form: ['L', 'L', 'W', 'L', 'L'] }),
    series([
      ['2025-01-01', 1500, 3],
      ['2025-02-01', 1680, 1],
      ['2025-03-01', 1600, 4],
    ]),
  )
  assert.ok(insight)
  assert.match(insight.summary, /Down 80 from/)
})

test('trajectory peak and trough summaries keep calendar days west of UTC', () => {
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { deriveTrajectoryInsight } from './src/views/rankings/trajectory.ts'
    const standing = ${JSON.stringify(standing({ form: [] }))}
    const climb = ${JSON.stringify(series([['2026-06-01', 1400, 1], ['2026-06-30', 1600, 1]]))}
    const slide = ${JSON.stringify(series([['2026-05-01', 1500, 1], ['2026-06-01', 1680, 1], ['2026-06-30', 1600, 1]]))}
    console.log(JSON.stringify([climb, slide].map(series => deriveTrajectoryInsight(standing, series).summary)))
  `], { cwd: new URL('..', import.meta.url), env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8' })

  assert.deepEqual(JSON.parse(output), [
    'Up 200 from the low of 1400 on Jun 1 to 1600 (#1) on Jun 30.',
    'Down 80 from the peak of 1680 on Jun 1 to 1600 (#1) on Jun 30.',
  ])
})
