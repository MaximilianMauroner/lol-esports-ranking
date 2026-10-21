import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { referencePublicDataDir } from '../scripts/reference-public-data.mjs'
import { parsePublicTeamDirectory, parsePublicTournamentMovementIndex, parsePublicTournamentMovementShard } from '../src/domains/rankings/published-read.ts'
import { isTierOneInternationalFamily, regionInternationalTimeline } from '../src/domains/rankings/read.ts'
import type { PublicTeamDirectory, PublicTeamHistoryPoint, PublicTeamHistoryPointContext, PublicTournamentMovementShard } from '../src/domains/rankings/types.ts'

test('the bundled Worlds, MSI and EWC results give the reviewed series records per region', async () => {
  const read = async (url: string) => JSON.parse(await readFile(join(referencePublicDataDir, url.replace(/^\/?data\//, '').replace(/\?.*$/, '')), 'utf8'))
  const manifest = await read('ranking-summary.json')
  const index = parsePublicTournamentMovementIndex(await read(manifest.tournamentMovementIndexUrl))
  const directory = parsePublicTeamDirectory(await read(manifest.teamDirectoryUrl))
  const entries = index.tournaments.flatMap(({ family, season, url }) => isTierOneInternationalFamily(family) ? [{ family, season: Number(season), url }] : [])
  const events = await Promise.all(entries.map(async ({ family, season, url }) => ({ family, season, shard: parsePublicTournamentMovementShard(await read(url)) })))

  const timeline = regionInternationalTimeline({ generatedAt: manifest.generatedAt, directory, events })

  assert.deepEqual(timeline.seasons, [
    { season: 2025, events: ['msi', 'ewc', 'worlds'], notYetPublished: [], inProgress: false },
    { season: 2026, events: ['msi', 'ewc'], notYetPublished: ['worlds'], inProgress: true },
  ])
  assert.deepEqual(
    Object.fromEntries(timeline.regions.map(({ region, years }) => [region, years.map((year) => `${year.wins}-${year.losses}-${year.ties}`)])),
    {
      LCK: ['22-5-0', '15-5-0'],
      LPL: ['14-11-0', '8-4-0'],
      LEC: ['6-14-0', '6-9-0'],
      LCS: ['2-6-0', '6-7-0'],
      LCP: ['5-11-0', '2-8-0'],
      CBLOL: ['0-2-0', '1-5-0'],
    },
  )
  assert.equal(timeline.regions.find((entry) => entry.region === 'LCK')?.years[0].winRate, 22 / 27)
  assert.equal(timeline.unresolvedSeries, 0)
})

test('series inside one region do not count, a tie is half a win, and no series is no value', () => {
  const timeline = regionInternationalTimeline({
    generatedAt: '2026-03-01T00:00:00.000Z',
    directory: directory([['a1', 'LCK'], ['a2', 'LCK'], ['b1', 'LEC'], ['b2', ' lec'], ['c1', 'LCS'], ['x', 'International']]),
    events: [{
      family: 'msi',
      season: 2026,
      shard: shard([
        ['a1', [['b1', 'W', 's1'], ['a2', 'L', 's2'], ['c1', 'T', 's3'], ['b1', 'W', 's5', 'ongoing'], ['y', 'W']]],
        ['a2', [['a1', 'W', 's2']]],
        ['b1', [['a1', 'L', 's1'], ['a1', 'L', 's5', 'ongoing']]],
        ['b2', [['c1', 'W', 's6', 'completed']]],
        ['c1', [['a1', 'T', 's3'], ['x', 'W', 's4'], ['b2', 'L', 's6', 'completed']]],
        ['x', [['c1', 'L', 's4']]],
        ['y', [['a1', 'L']]],
      ]),
    }],
  })
  const year = (region: string) => timeline.regions.find((entry) => entry.region === region)?.years[0]

  assert.deepEqual(year('LCK'), { season: 2026, wins: 1, losses: 0, ties: 1, winRate: 0.75 })
  assert.deepEqual(year('LEC'), { season: 2026, wins: 1, losses: 1, ties: 0, winRate: 0.5 })
  assert.deepEqual(year('LCS'), { season: 2026, wins: 0, losses: 1, ties: 1, winRate: 0.25 })
  assert.deepEqual(year('LPL'), { season: 2026, wins: 0, losses: 0, ties: 0, winRate: null })
  // s4 against a team outside the six regions, and one series without an id against a team the directory does not know.
  assert.equal(timeline.unresolvedSeries, 2)
  assert.deepEqual(timeline.seasons, [{ season: 2026, events: ['msi'], notYetPublished: ['worlds', 'ewc'], inProgress: true }])
})

test('a year without events has no value, and the in-progress year shows before its first event', () => {
  const timeline = regionInternationalTimeline({
    generatedAt: '2026-01-15T00:00:00.000Z',
    directory: directory([['a1', 'LCK'], ['b1', 'LEC']]),
    events: [
      { family: 'msi', season: 2023, shard: shard([['a1', [['b1', 'W', 's1']]], ['b1', [['a1', 'L', 's1']]]]) },
      { family: 'msi', season: 2025, shard: shard([['a1', [['b1', 'L', 's2']]], ['b1', [['a1', 'W', 's2']]]]) },
    ],
  })

  assert.deepEqual(timeline.seasons, [
    { season: 2023, events: ['msi'], notYetPublished: [], inProgress: false },
    { season: 2024, events: [], notYetPublished: [], inProgress: false },
    { season: 2025, events: ['msi'], notYetPublished: [], inProgress: false },
    { season: 2026, events: [], notYetPublished: ['worlds', 'msi', 'ewc'], inProgress: true },
  ])
  assert.deepEqual(timeline.regions.find((entry) => entry.region === 'LCK')?.years.map((year) => year.winRate), [1, null, 0, null])
  assert.deepEqual(timeline.regions.find((entry) => entry.region === 'LEC')?.years[1], { season: 2024, wins: 0, losses: 0, ties: 0, winRate: null })
})

function directory(teams: [string, string][]) {
  return { teams: teams.map(([teamId, region]) => ({ teamId, name: teamId, code: teamId, region, league: region, leagueId: region })) } as PublicTeamDirectory
}

type FixtureSeries = [opponent: string, result: 'W' | 'L' | 'T', seriesId?: string, seriesState?: PublicTeamHistoryPointContext['seriesState']]

// The fixture has only the shard fields that the timeline reads.
function shard(teams: [string, FixtureSeries[]][]) {
  return {
    id: 'msi:2026',
    startDate: '2026-06-01',
    teams: teams.map(([teamId, series]) => ({
      teamId,
      team: teamId,
      points: series.map(([opponent, result, seriesId, seriesState]): PublicTeamHistoryPoint => ['2026-06-02', 1500, 1, { kind: 'match', opponent, result, seriesId, seriesState }]),
    })),
  } as unknown as PublicTournamentMovementShard
}
