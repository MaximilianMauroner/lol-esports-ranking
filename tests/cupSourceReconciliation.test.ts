import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { importRankingSourceData } from '../scripts/rankings/source-input.ts'
import { inferEventTier, knownTeamIdentities } from '../src/domains/rankings/evidence.ts'
import { eventKFactorForMatch, eventWeightForMatch } from '../src/domains/rankings/internal/replay/eventWeighting.ts'
import { groupedMatchEvents } from '../src/domains/rankings/read.ts'
import { createMatchHistoryArtifacts, createStaticRankingData } from '../src/domains/rankings/internal/projections/snapshot.ts'

for (const cup of [
  { league: 'DCGI', event: '2026 Demacia Cup Global Invitational', homeLeague: 'LCS', opponent: 'Cloud9' },
  { league: 'KeSPA Cup', event: 'KeSPA Cup 2026', homeLeague: 'LCK', opponent: 'Gen.G' },
]) {
  test(`${cup.league} Oracle games survive overlapping Leaguepedia sources with domestic identities and one series impact`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'cup-source-reconciliation-'))
    try {
      const unknownTeam = 'Unlisted Cup Team'
      assert.equal(knownTeamIdentities[unknownTeam], undefined)
      const oracle = join(root, 'oracle.csv')
      const leaguepedia = [join(root, 'cup.json'), join(root, 'overlap.json')]
      const games = [1, 2].map((game) => ({
        id: `${cup.event}_Final_1_${game}`,
        date: '2026-10-03', event: cup.event, bestOf: 3,
        teamA: 'KT Rolster', teamB: unknownTeam, winner: 'KT Rolster',
        teamAKills: 20 + game, teamBKills: 10 + game,
        teamAGold: 60000 + game, teamBGold: 55000 + game,
      }))
      await writeFile(oracle, [
        'gameid,date,year,league,split,playoffs,game,position,side,teamname,result,kills,totalgold',
        `prior,2026-07-26,2026,${cup.homeLeague},,0,1,team,Blue,${unknownTeam},1,18,62000`,
        `prior,2026-07-26,2026,${cup.homeLeague},,0,1,team,Red,${cup.opponent},0,12,59000`,
        ...games.flatMap((game, index) => [
          `cup-${index + 1},${game.date},2026,${cup.league},,0,${index + 1},team,Blue,${game.teamA},1,${game.teamAKills},${game.teamAGold}`,
          `cup-${index + 1},${game.date},2026,${cup.league},,0,${index + 1},team,Red,${game.teamB},0,${game.teamBKills},${game.teamBGold}`,
        ]),
      ].join('\n'))
      for (const path of leaguepedia) await writeFile(path, JSON.stringify({ matches: games }))

      const imported = await importRankingSourceData({ oracleCsvPaths: [oracle], leaguepediaJsonPaths: leaguepedia })
      assert.equal(imported.importedMatches.length, 3)
      assert.equal(imported.matches.length, 3, 'both retained Oracle cup games must enter the rating run')
      const cupGames = imported.matches.filter((match) => match.league === cup.league)
      assert.deepEqual(cupGames.map((match) => match.id), ['oe-cup-1', 'oe-cup-2'])
      assert.ok(cupGames.every((match) => match.sourceProvider === 'oracles-elixir'
        && match.event === `${cup.league} 2026`
        && match.teamAHomeLeague === 'LCK' && match.teamBHomeLeague === cup.homeLeague
        && match.teamARegion === 'LCK' && match.teamBRegion === cup.homeLeague))
      assert.equal(imported.teams[unknownTeam].league, cup.homeLeague)
      assert.deepEqual(imported.externalSources.map((source) => source.rowCount), [3, 0, 0])

      const data = createStaticRankingData({ ...imported, rosters: {}, generatedAt: '2026-10-04T00:00:00.000Z' })
      const history = createMatchHistoryArtifacts(data)
      const catalog = history.catalogs[data.defaultSnapshotKey]
      assert.equal(catalog.gameCount, 3)
      assert.equal(catalog.seriesCount, 2)
      assert.deepEqual(catalog.series.filter((series) => series.league === cup.league).map((series) => series.gameCount), [2])
      const publishedGames = Object.values(history.pages[data.defaultSnapshotKey]).flatMap((page) => page.matches)
        .filter((match) => match.league === cup.league).toSorted((left, right) => left.gameNumber - right.gameNumber)
      assert.deepEqual(publishedGames.map((match) => [match.seriesWinsA, match.seriesWinsB]), [[1, 0], [2, 0]])
      assert.ok(publishedGames.every((match) => match.teamA.name === 'KT Rolster'
        && match.teamB.name === unknownTeam && match.bestOf === 3 && match.seriesState === 'completed'))
      assert.deepEqual(publishedGames.map((match) => match.impact.unit), ['held', 'series-applied'])
      assert.ok((publishedGames[1].impact.teamA ?? 0) > 0)
      assert.ok((publishedGames[1].impact.teamB ?? 0) < 0)
      const standing = data.snapshots[data.defaultSnapshotKey].standings.find((row) => row.team === 'KT Rolster')!
      assert.equal(standing.wins, 2)
      assert.equal(standing.losses, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('provider cup names group under their existing competition families', () => {
  assert.deepEqual(groupedMatchEvents([
    { league: 'DCGI', event: 'DCGI 2026' },
    { league: 'KeSPA Cup', event: 'KeSPA Cup 2026' },
  ], 'All'), [
    { label: 'Demacia Cup', events: ['DCGI 2026'] },
    { label: 'KeSPA Cup', events: ['KeSPA Cup 2026'] },
  ])
})

test('DCGI uses the existing Demacia evidence weight without a post-Worlds discount', () => {
  const input = { date: '2026-12-20', league: 'DCGI', event: 'DCGI 2026', phase: 'Final' }
  const match = { ...input, tier: inferEventTier(input) }
  const context = { worldsEndDateByCalendarYear: new Map([[2026, '2026-11-09']]) }
  assert.equal(match.tier, 'minor-international')
  const demacia = { ...match, league: 'DCup', event: 'DCup 2026' }
  const ewc = { ...match, date: '2026-07-20', league: 'EWC', event: 'EWC 2026' }
  assert.equal(eventWeightForMatch(match, context), eventWeightForMatch(demacia, context))
  assert.equal(eventWeightForMatch(match, context), eventWeightForMatch(ewc, context))
  assert.equal(eventKFactorForMatch(match, context), eventKFactorForMatch(demacia, context))
  assert.ok(eventWeightForMatch({ ...match, league: 'KeSPA Cup', event: 'KeSPA Cup 2026' }, context)
    < eventWeightForMatch(match, context))
})
