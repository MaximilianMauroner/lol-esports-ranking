import assert from 'node:assert/strict'
import test from 'node:test'
import { initialModeFromLocation, showsManifestErrorInAppShell } from '../src/browser/bootstrap.ts'
import { hashForModeAndScope } from '../src/browser/navigation.ts'
import { playerLeaderboardForScope, playerLeaderboardScore, resolvePlayerScope } from '../src/domains/rankings/read.ts'
import type { CompactPlayer, PlayerStatsPower, PublicPlayerDirectory, SnapshotFilter } from '../src/domains/rankings/types.ts'

const all: SnapshotFilter = { season: 'All', event: 'All', region: 'All' }
const season: SnapshotFilter = { ...all, season: '2026' }

function player(id: string, rating: number, rank: number, team = 'Fixture Team'): CompactPlayer {
  return { id, name: id, team, role: 'Mid', rating, rank, games: 30, delta: 0, impactMultiplier: 1 }
}

function statsPower(score: number): PlayerStatsPower {
  const evidence = { observed: 24, missing: 6, effectiveGames: 22.5 }
  return {
    version: 'stats-power-v3', score, role: 'Mid', sampleGames: 24, eligibleGames: 30, priorOnly: false, leagueAnchor: 100,
    evidenceThrough: '2026-10-01', metrics: { goldDiffAt15: evidence, xpDiffAt15: evidence, csDiffAt15: evidence },
  }
}

function directory(): PublicPlayerDirectory {
  return {
    artifactKind: 'player-directory', generatedAt: '2026-10-27T00:00:00Z', modelVersion: 'synthetic-fixture',
    modelConfigHash: 'synthetic-fixture', sourceProvider: 'synthetic-fixture',
    metric: { id: 'role-power', label: 'Fixture score', shortLabel: 'Score', description: 'Synthetic test score', interpretation: 'Higher first', teamResultSignal: 'included', independentSkillClaim: false },
    ratedPlayerCount: 1, ratedTeamCount: 1, roles: ['Mid'], currentLineups: {},
    players: [player('Previous season only', 900, 1, 'Legacy Team')],
    scopedPlayers: {
      '2026__All__All': [player('Third', 100, 3), player('First', 300, 1), player('Second', 200, 2)],
      '2025__All__All': [player('Previous season only', 900, 1, 'Legacy Team')],
    },
  }
}

test('player leaderboard reads only the selected source scope and orders by the published primary rating', () => {
  const data = directory()
  const before = structuredClone(data)
  const rows = playerLeaderboardForScope(data, season)
  assert.deepEqual(rows.map(({ id, rating, rank, games }) => ({ id, rating, rank, games })), [
    { id: 'First', rating: 300, rank: 1, games: 30 },
    { id: 'Second', rating: 200, rank: 2, games: 30 },
    { id: 'Third', rating: 100, rank: 3, games: 30 },
  ])
  assert.deepEqual(data, before, 'Reading a leaderboard must preserve stored rows and their history')
  assert.equal(rows.filter((row) => row.name === 'Third')[0].rank, 3, 'Filtering keeps source-scope rank')
  assert.deepEqual(playerLeaderboardForScope(data, all).map((row) => row.id), ['Previous season only'])
})

test('missing and explicitly empty exact scopes never borrow season or all-season rows', () => {
  const data = directory()
  assert.deepEqual(playerLeaderboardForScope(undefined, season), [])
  assert.deepEqual(playerLeaderboardForScope(data, { ...season, season: '2024' }), [])
  assert.deepEqual(playerLeaderboardForScope(data, { ...season, checkpoint: 'split-2' }), [])
  assert.deepEqual(playerLeaderboardForScope(data, { ...season, event: 'Synthetic event' }), [])
  assert.deepEqual(playerLeaderboardForScope(data, { ...all, region: 'LCK' }), [])
  data.scopedPlayers!['2026__All__All'] = []
  assert.deepEqual(playerLeaderboardForScope(data, season), [])
})

test('team drawers keep their real fallback while the leaderboard stays exact', () => {
  const data = directory()
  assert.deepEqual(resolvePlayerScope(data, season).players.map((row) => row.id), [
    'Third', 'First', 'Second', 'Previous season only',
  ])
  assert.match(resolvePlayerScope(data, season).label, /all-season sources/)
})

test('equal ratings use source rank and stable identity without changing either score or rank', () => {
  const data = directory()
  data.scopedPlayers!['2026__All__All'] = [player('B', 100, 2), player('C', 100, 1), player('A', 100, 2)]
  assert.deepEqual(playerLeaderboardForScope(data, season).map((row) => [row.id, row.rank, row.rating, row.leaderboardRank]), [
    ['C', 1, 100, 1], ['A', 2, 100, 1], ['B', 2, 100, 1],
  ])
})

test('Stats Power orders the leaderboard against Role Power, and only exact selected-score ties share a rank', () => {
  const data = directory()
  data.scopedPlayers!['2026__All__All'] = [
    { ...player('Ash', 300, 1), statsPower: statsPower(101.25) },
    { ...player('Birch', 200, 2), statsPower: statsPower(104.5) },
    { ...player('Cypress', 100, 3), statsPower: statsPower(104.5) },
    player('Dune', 50, 4),
    { ...player('Elm', 10, 5), statsPower: statsPower(104.5 + 1e-12) },
  ]
  const before = structuredClone(data)
  const rows = playerLeaderboardForScope(data, season)
  assert.deepEqual(rows.map((row) => [row.id, row.leaderboardRank, row.leaderboardScore.kind, row.leaderboardScore.value, row.rank, row.rating]), [
    ['Elm', 1, 'stats-power', 104.5 + 1e-12, 5, 10],
    ['Birch', 2, 'stats-power', 104.5, 2, 200],
    ['Cypress', 2, 'stats-power', 104.5, 3, 100],
    ['Ash', 4, 'stats-power', 101.25, 1, 300],
    ['Dune', 5, 'role-power', 50, 4, 50],
  ])
  assert.deepEqual(data, before, 'Selecting a score must not rewrite stored rows')
  assert.deepEqual(playerLeaderboardScore({ rating: 80, statsPower: { ...statsPower(120), score: Number.NaN } }), { kind: 'role-power', value: 80 })
  assert.deepEqual(playerLeaderboardScore({ rating: 80, statsPower: statsPower(-3) }), { kind: 'stats-power', value: -3 })
})

test('Players addresses select the Players shell and preserve its query when the scope changes', () => {
  assert.equal(initialModeFromLocation('#players?scope=season%3A2026&player=Cedar&role=Mid', '/'), 'players')
  assert.equal(initialModeFromLocation('', '/players'), 'players')
  assert.equal(initialModeFromLocation('#teams', '/'), 'rankings')
  assert.equal(showsManifestErrorInAppShell('players'), true)
  assert.equal(hashForModeAndScope('players', 'season:2025', 'players?scope=season%3A2026&player=Cedar&role=Mid'),
    '#players?scope=season%3A2025&player=Cedar&role=Mid')
})
