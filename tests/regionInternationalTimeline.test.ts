import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { referencePublicDataDir } from '../scripts/reference-public-data.mjs'
import { parsePublicTeamDirectory, parsePublicTournamentMovementIndex, parsePublicTournamentMovementShard } from '../src/domains/rankings/published-read.ts'
import { isTierOneInternationalFamily, regionInternationalTimeline } from '../src/domains/rankings/read.ts'
import type { PublicTeamDirectory, PublicTeamHistoryPoint, PublicTournamentMovementShard } from '../src/domains/rankings/types.ts'

test('the bundled Worlds, MSI and EWC results give the reviewed series records per region', async () => {
  const read = async (url: string) => JSON.parse(await readFile(join(referencePublicDataDir, url.replace(/^\/?data\//, '').replace(/\?.*$/, '')), 'utf8'))
  const manifest = await read('ranking-summary.json')
  const index = parsePublicTournamentMovementIndex(await read(manifest.tournamentMovementIndexUrl))
  const directory = parsePublicTeamDirectory(await read(manifest.teamDirectoryUrl))
  const events = await Promise.all(index.tournaments.flatMap((entry) => isTierOneInternationalFamily(entry.family)
    ? [read(entry.url).then((value) => ({ family: entry.family, season: Number(entry.season), shard: parsePublicTournamentMovementShard(value) }))]
    : []))

  const timeline = regionInternationalTimeline({ generatedAt: manifest.generatedAt, directory, events })

  assert.deepEqual(timeline.seasons, [
    { season: 2025, events: ['msi', 'ewc', 'worlds'], absent: [], inProgress: false },
    { season: 2026, events: ['msi', 'ewc'], absent: ['worlds'], inProgress: true },
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
    directory: directory([['a1', 'LCK'], ['a2', 'LCK'], ['b1', 'LEC'], ['c1', 'LCS'], ['x', 'International']]),
    events: [{
      family: 'msi',
      season: 2026,
      shard: shard([
        ['a1', [['b1', 'W', 's1'], ['a2', 'L', 's2'], ['c1', 'T', 's3']]],
        ['a2', [['a1', 'W', 's2']]],
        ['b1', [['a1', 'L', 's1']]],
        ['c1', [['a1', 'T', 's3'], ['x', 'W', 's4']]],
        ['x', [['c1', 'L', 's4']]],
      ]),
    }],
  })
  const year = (region: string) => timeline.regions.find((entry) => entry.region === region)?.years[0]

  assert.deepEqual(year('LCK'), { season: 2026, wins: 1, losses: 0, ties: 1, winRate: 0.75 })
  assert.deepEqual(year('LEC'), { season: 2026, wins: 0, losses: 1, ties: 0, winRate: 0 })
  assert.deepEqual(year('LCS'), { season: 2026, wins: 0, losses: 0, ties: 1, winRate: 0.5 })
  assert.deepEqual(year('LPL'), { season: 2026, wins: 0, losses: 0, ties: 0, winRate: null })
  assert.equal(timeline.unresolvedSeries, 1)
  assert.deepEqual(timeline.seasons, [{ season: 2026, events: ['msi'], absent: ['worlds', 'ewc'], inProgress: true }])
})

function directory(teams: [string, string][]) {
  return { teams: teams.map(([teamId, region]) => ({ teamId, name: teamId, code: teamId, region, league: region, leagueId: region })) } as PublicTeamDirectory
}

function shard(teams: [string, [string, 'W' | 'L' | 'T', string][]][]) {
  return {
    id: 'msi:2026',
    startDate: '2026-06-01',
    teams: teams.map(([teamId, series]) => ({
      teamId,
      team: teamId,
      points: series.map(([opponent, result, seriesId]): PublicTeamHistoryPoint => ['2026-06-02', 1500, 1, { kind: 'match', opponent, result, seriesId }]),
    })),
  } as PublicTournamentMovementShard
}
