import assert from 'node:assert/strict'
import test from 'node:test'
import { latestRosterByTeam, rosterBasisByTeam, rosterContinuity } from '../src/lib/rosters.ts'
import type { MatchRecord, MatchRosterSnapshot } from '../src/types.ts'

test('rosterBasisByTeam returns sourced for latest complete five-role roster', () => {
  const basis = rosterBasisByTeam([
    matchFixture({
      id: 'early',
      date: '2026-01-01',
      teamARoster: rosterFixture({ completeness: 'partial', players: playerList(['Top']) }),
    }),
    matchFixture({
      id: 'late',
      date: '2026-01-02',
      teamARoster: rosterFixture(),
    }),
  ])

  assert.equal(basis.get('T1'), 'sourced')
})

test('latestRosterByTeam chooses the newest roster by date and stable id order', () => {
  const rosters = latestRosterByTeam([
    matchFixture({
      id: 'b-match',
      date: '2026-01-02',
      teamARoster: rosterFixture({ teamId: 'older-same-day' }),
    }),
    matchFixture({
      id: 'a-match',
      date: '2026-01-02',
      teamARoster: rosterFixture({ teamId: 'first-same-day' }),
    }),
    matchFixture({
      id: 'future',
      date: '2026-01-03',
      teamARoster: rosterFixture({ teamId: 'latest' }),
    }),
  ])

  assert.equal(rosters.get('T1')?.teamId, 'latest')
})

test('partial-only sourced appearances become assumed-continuous', () => {
  const basis = rosterBasisByTeam([
    matchFixture({
      teamARoster: rosterFixture({ completeness: 'partial', players: playerList(['Top', 'Jungle']) }),
    }),
  ])

  assert.equal(basis.get('T1'), 'assumed-continuous')
})

test('matches without sourced roster rows leave teams unknown', () => {
  const basis = rosterBasisByTeam([matchFixture({ sourceProvider: 'leaguepedia-cargo' })])

  assert.equal(basis.get('T1'), undefined)
  assert.equal(basis.get('Gen.G'), undefined)
})

test('rosterContinuity uses role value instead of raw returning-player count', () => {
  const prior = rosterFixture()
  const identical = rosterFixture()
  const midSwap = rosterFixture({ players: playerList(['Top', 'Jungle', 'Mid', 'Bot', 'Support'], { Mid: 'new-mid' }) })
  const supportSwap = rosterFixture({ players: playerList(['Top', 'Jungle', 'Mid', 'Bot', 'Support'], { Support: 'new-support' }) })
  const fullSwap = rosterFixture({ players: playerList(['Top', 'Jungle', 'Mid', 'Bot', 'Support'], {
    Top: 'new-top',
    Jungle: 'new-jungle',
    Mid: 'new-mid',
    Bot: 'new-bot',
    Support: 'new-support',
  }) })

  assert.equal(rosterContinuity(prior, identical), 1)
  assert.equal(Number(rosterContinuity(prior, midSwap)?.toFixed(2)), 0.78)
  assert.equal(Number(rosterContinuity(prior, supportSwap)?.toFixed(2)), 0.82)
  assert.equal(rosterContinuity(prior, fullSwap), 0)
})

test('rosterContinuity skips missing or partial lineups', () => {
  const prior = rosterFixture()
  const partial = rosterFixture({ completeness: 'partial', players: playerList(['Top', 'Jungle']) })

  assert.equal(rosterContinuity(undefined, prior), undefined)
  assert.equal(rosterContinuity(prior, undefined), undefined)
  assert.equal(rosterContinuity(prior, partial), undefined)
})

function rosterFixture(overrides: Partial<MatchRosterSnapshot> = {}): MatchRosterSnapshot {
  return {
    sourceProvider: 'oracles-elixir',
    teamId: 'team-t1',
    observedAt: '2026-01-01',
    completeness: 'complete-five-role',
    players: playerList(['Top', 'Jungle', 'Mid', 'Bot', 'Support']),
    ...overrides,
  }
}

function playerList(
  roles: Array<MatchRosterSnapshot['players'][number]['role']>,
  overrides: Partial<Record<MatchRosterSnapshot['players'][number]['role'], string>> = {},
) {
  return roles.map((role) => ({
    id: overrides[role] ?? `player-${role.toLowerCase()}`,
    name: `${role} Player`,
    role,
  }))
}

function matchFixture(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    id: 'fixture',
    sourceProvider: 'oracles-elixir',
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
    bestOf: 1,
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
