import assert from 'node:assert/strict'
import test from 'node:test'
import { filterPublishedRatingUniverseInput, matchBelongsToPublishedRatingUniverse } from '../src/lib/ratingUniverse.ts'
import type { MatchRecord, Region, TeamProfile } from '../src/types.ts'

test('published rating universe keeps only matches between rated domestic leagues', () => {
  const teams: Record<string, TeamProfile> = {
    'LCK Team': team('LCK Team', 'LCK', 'LCK'),
    'LEC Team': team('LEC Team', 'LEC', 'LEC'),
    'PCS Team': team('PCS Team', 'PCS', 'PCS'),
    'Legacy LCS Team': team('Legacy LCS Team', 'LCS', 'LCS'),
    'LCS Team': team('LCS Team', 'LCS', 'LCS'),
    'Idle LPL Team': team('Idle LPL Team', 'LPL', 'LPL'),
  }
  const matches = [
    match('lck-lec', 'LCK Team', 'LEC Team', 'LCK', 'LEC'),
    match('lck-pcs', 'LCK Team', 'PCS Team', 'LCK', 'PCS'),
    match('legacy-lta-n', 'Legacy LCS Team', 'LCS Team', 'LTA N', 'LCS'),
  ]

  const universe = filterPublishedRatingUniverseInput(matches, teams)

  assert.equal(matchBelongsToPublishedRatingUniverse(matches[0], teams), true)
  assert.equal(matchBelongsToPublishedRatingUniverse(matches[1], teams), false)
  assert.equal(matchBelongsToPublishedRatingUniverse(matches[2], teams), false)
  assert.deepEqual(universe.matches.map((entry) => entry.id), ['lck-lec'])
  assert.deepEqual(Object.keys(universe.teams).sort(), ['LCK Team', 'LEC Team'])
})

function team(name: string, league: string, region: Region): TeamProfile {
  return {
    name,
    code: name.slice(0, 3).toUpperCase(),
    league,
    region,
  }
}

function match(
  id: string,
  teamA: string,
  teamB: string,
  leagueA: string,
  leagueB: string,
): MatchRecord {
  return {
    id,
    sourceProvider: 'seed',
    dataCompleteness: 'complete',
    date: '2026-01-01',
    season: 2026,
    event: 'Universe Test',
    phase: 'Regular season',
    region: 'International',
    league: 'MSI',
    teamAHomeLeague: leagueA,
    teamBHomeLeague: leagueB,
    teamARegion: regionForLeague(leagueA),
    teamBRegion: regionForLeague(leagueB),
    patch: '26.1',
    bestOf: 1,
    tier: 'regional-regular',
    teamA,
    teamB,
    winner: teamA,
    teamAKills: 20,
    teamBKills: 12,
    teamAGold: 65000,
    teamBGold: 59000,
  }
}

function regionForLeague(league: string): Region {
  if (league === 'PCS') return 'PCS'
  if (league === 'LTA N') return 'LCS'
  return league as Region
}
