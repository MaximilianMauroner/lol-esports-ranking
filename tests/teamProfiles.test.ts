import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveTeamProfilesFromMatches, mergeTeamProfiles } from '../src/lib/teamProfiles.ts'
import type { MatchRecord, TeamProfile } from '../src/types.ts'

test('mergeTeamProfiles does not let later unknown profiles replace useful league identity', () => {
  const merged = mergeTeamProfiles([
    { 'Karmine Corp Blue': team('Karmine Corp Blue', 'LFL') },
    { 'Karmine Corp Blue': team('Karmine Corp Blue', 'Unknown') },
  ])

  assert.equal(merged['Karmine Corp Blue'].league, 'LFL')
})

test('deriveTeamProfilesFromMatches prefers dominant non-competition home league over file order', () => {
  const profiles = deriveTeamProfilesFromMatches([
    match({ id: 'lfl-1', teamAHomeLeague: 'LFL', teamARegion: 'LEC' }),
    match({ id: 'lfl-2', teamAHomeLeague: 'LFL', teamARegion: 'LEC' }),
    match({ id: 'lec-versus', teamAHomeLeague: 'LEC', teamARegion: 'LEC' }),
    match({ id: 'em-ignored', teamAHomeLeague: 'EM', teamARegion: 'LEC' }),
  ], {
    'Karmine Corp Blue': team('Karmine Corp Blue', 'LEC'),
  })

  assert.equal(profiles['Karmine Corp Blue'].league, 'LFL')
  assert.equal(profiles['Karmine Corp Blue'].region, 'LEC')
})

test('deriveTeamProfilesFromMatches follows latest explicit home league for moved teams', () => {
  const profiles = deriveTeamProfilesFromMatches([
    match({ id: 'old-lec-1', date: '2026-01-01', teamAHomeLeague: 'LEC', teamARegion: 'LEC' }),
    match({ id: 'old-lec-2', date: '2026-01-02', teamAHomeLeague: 'LEC', teamARegion: 'LEC' }),
    match({ id: 'new-lfl', date: '2026-03-01', teamAHomeLeague: 'LFL', teamARegion: 'LEC' }),
  ], {
    'Karmine Corp Blue': team('Karmine Corp Blue', 'LEC'),
  })

  assert.equal(profiles['Karmine Corp Blue'].league, 'LFL')
  assert.equal(profiles['Karmine Corp Blue'].region, 'LEC')
})

test('deriveTeamProfilesFromMatches ignores later unknown placeholders from competition rows', () => {
  const profiles = deriveTeamProfilesFromMatches([
    match({ id: 'lfl-source', date: '2026-05-29', teamAHomeLeague: 'LFL', teamARegion: 'LEC' }),
    match({ id: 'em-placeholder', date: '2026-06-13', teamAHomeLeague: 'Unknown', teamARegion: 'International', league: 'EMEA Masters' }),
  ], {
    'Karmine Corp Blue': team('Karmine Corp Blue', 'Unknown'),
  })

  assert.equal(profiles['Karmine Corp Blue'].league, 'LFL')
  assert.equal(profiles['Karmine Corp Blue'].region, 'LEC')
})

test('deriveTeamProfilesFromMatches ignores generic LTA rows after subleague observations', () => {
  const profiles = deriveTeamProfilesFromMatches([
    match({ id: 'lta-n', date: '2025-09-07', teamA: '100 Thieves', teamAHomeLeague: 'LTA N', teamARegion: 'LCS' }),
    match({ id: 'lta-championship', date: '2025-09-27', teamA: '100 Thieves', teamAHomeLeague: 'LTA', teamARegion: 'International' }),
  ])

  assert.equal(profiles['100 Thieves'].league, 'LTA N')
  assert.equal(profiles['100 Thieves'].region, 'LCS')
})

test('deriveTeamProfilesFromMatches keeps known identities authoritative', () => {
  const profiles = deriveTeamProfilesFromMatches([
    match({ id: 'bad-source', teamA: 'T1', teamAHomeLeague: 'LFL', teamARegion: 'LEC' }),
  ])

  assert.equal(profiles.T1.league, 'LCK')
  assert.equal(profiles.T1.region, 'LCK')
})

function team(name: string, league: string): TeamProfile {
  return {
    name,
    code: name.split(/\s+/).map((part) => part[0]).join('').slice(0, 4).toUpperCase(),
    region: league === 'LFL' || league === 'LEC' ? 'LEC' : 'International',
    league,
  }
}

function match(overrides: Partial<MatchRecord>): MatchRecord {
  return {
    id: overrides.id ?? 'match',
    date: '2026-01-01',
    season: 2026,
    event: 'Fixture',
    phase: 'Regular season',
    region: 'LEC',
    league: 'LFL',
    teamAHomeLeague: 'LFL',
    teamBHomeLeague: 'LFL',
    teamARegion: 'LEC',
    teamBRegion: 'LEC',
    patch: '26.1',
    bestOf: 1,
    tier: 'regional-regular',
    teamA: 'Karmine Corp Blue',
    teamB: 'Fixture Opponent',
    winner: 'Karmine Corp Blue',
    teamAKills: 10,
    teamBKills: 5,
    teamAGold: 50000,
    teamBGold: 45000,
    ...overrides,
  }
}
