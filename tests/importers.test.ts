import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeCommunityMatchSources } from '../src/lib/importers/communitySources.ts'
import { importLeaguepediaSnapshot } from '../src/lib/importers/leaguepedia.ts'
import { importOraclesElixirCsv } from '../src/lib/importers/oraclesElixir.ts'
import { buildRankingModel } from '../src/lib/model.ts'
import type { MatchRecord, TeamProfile } from '../src/types.ts'

test('Leaguepedia international rows use known team home leagues when explicit fields are absent', () => {
  const result = importLeaguepediaSnapshot({
    source: 'fixture',
    fetchedAt: '2026-06-26T00:00:00.000Z',
    matches: [
      {
        id: 'lp-1',
        date: '2026-05-01',
        event: 'Mid-Season Invitational 2026',
        patch: '26.9',
        teamA: 'T1',
        teamB: 'Bilibili Gaming',
        winner: 'T1',
        teamAKills: 18,
        teamBKills: 12,
        teamAGold: 62000,
        teamBGold: 59000,
        bestOf: 5,
      },
    ],
  })

  const match = result.matches[0]
  assert.equal(match.teamAHomeLeague, 'LCK')
  assert.equal(match.teamBHomeLeague, 'LPL')
  assert.equal(result.teams.T1.league, 'LCK')
  assert.equal(result.teams['Bilibili Gaming'].league, 'LPL')

  const model = buildRankingModel(result.matches, result.teams)
  const lck = model.leagues.find((league) => league.league === 'LCK')
  const lpl = model.leagues.find((league) => league.league === 'LPL')
  assert.ok(lck)
  assert.ok(lpl)
  assert.equal(lck.internationalMatches, 1)
  assert.equal(lpl.internationalMatches, 1)
  assert.notEqual(lck.delta, 0)
  assert.notEqual(lpl.delta, 0)
})

test('community merge keeps same-day scored series games but drops incomplete Leaguepedia duplicates after Oracle', () => {
  const teams: Record<string, TeamProfile> = {
    T1: { name: 'T1', code: 'T1', region: 'LCK', league: 'LCK' },
    'Gen.G': { name: 'Gen.G', code: 'GEN', region: 'LCK', league: 'LCK' },
  }
  const oracleMatch: MatchRecord = matchFixture({
    id: 'oe-1',
    sourceProvider: 'oracles-elixir',
    sourceGameId: 'oe-game-1',
    teamAKills: 20,
    teamBKills: 12,
    teamAGold: 65000,
    teamBGold: 59000,
  })
  const leaguepediaDuplicate: MatchRecord = matchFixture({
    id: 'lp-duplicate',
    sourceProvider: 'leaguepedia-cargo',
    sourceGameId: 'different-lp-id',
    dataCompleteness: 'match-result-only',
    teamAKills: 0,
    teamBKills: 0,
    teamAGold: 0,
    teamBGold: 0,
  })
  const leaguepediaSecondGame: MatchRecord = matchFixture({
    id: 'lp-game-2',
    sourceProvider: 'leaguepedia-cargo',
    sourceGameId: 'lp-game-2',
    dataCompleteness: 'scoreboard-game-stats',
    teamAKills: 14,
    teamBKills: 21,
    teamAGold: 60200,
    teamBGold: 67100,
    winner: 'Gen.G',
  })

  const merged = mergeCommunityMatchSources({
    oracleMatches: [oracleMatch],
    leaguepediaMatches: [leaguepediaDuplicate, leaguepediaSecondGame],
  })

  assert.deepEqual(merged.map((match) => match.id), ['oe-1', 'lp-game-2'])
  assert.equal(buildRankingModel(merged, teams).standings.length, 2)
})

test('Oracle import preserves blue and red side metadata', () => {
  const result = importOraclesElixirCsv([
    'gameid,date,year,league,split,playoffs,patch,position,side,teamname,result,kills,totalgold',
    'oe-side-1,2026-01-01,2026,LCK,Spring,0,26.1,team,Blue,T1,1,20,65000',
    'oe-side-1,2026-01-01,2026,LCK,Spring,0,26.1,team,Red,Gen.G,0,12,59000',
  ].join('\n'))

  assert.equal(result.matches[0]?.teamASide, 'blue')
  assert.equal(result.matches[0]?.teamBSide, 'red')
})

function matchFixture(overrides: Partial<MatchRecord>): MatchRecord {
  return {
    id: 'fixture',
    sourceProvider: 'seed',
    sourceGameId: 'fixture',
    dataCompleteness: 'scoreboard-game-stats',
    date: '2026-01-01',
    season: 2026,
    event: 'LCK 2026 Spring',
    phase: 'Regular season',
    region: 'LCK',
    league: 'LCK',
    teamAHomeLeague: 'LCK',
    teamBHomeLeague: 'LCK',
    teamARegion: 'LCK',
    teamBRegion: 'LCK',
    patch: '26.1',
    bestOf: 3,
    tier: 'regional-regular',
    teamA: 'T1',
    teamB: 'Gen.G',
    winner: 'T1',
    teamAKills: 20,
    teamBKills: 12,
    teamAGold: 65000,
    teamBGold: 59000,
    ...overrides,
  }
}
