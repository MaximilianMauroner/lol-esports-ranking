import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalSeriesForMatches, resolveCanonicalSeries } from '../src/lib/seriesResolver.ts'
import type { MatchRecord } from '../src/types.ts'

test('canonical resolver represents a trusted Bo2 tie as a completed neutral series', () => {
  const series = resolveCanonicalSeries([
    fixture({ id: 'bo2-game-2', sourceGameId: 'bo2_game_2', winner: 'Beta', bestOf: 2, bestOfBasis: 'provider' }),
    fixture({ id: 'bo2-game-1', sourceGameId: 'bo2_game_1', winner: 'Alpha', bestOf: 2, bestOfBasis: 'provider' }),
  ])[0]

  assert.ok(series)
  assert.equal(series.format, 2)
  assert.equal(series.formatBasis, 'provider')
  assert.equal(series.outcomeA, 0.5)
  assert.equal(series.state, 'completed')
  assert.deepEqual(series.games.map((match) => match.id), ['bo2-game-1', 'bo2-game-2'])
})

test('score inference overrides an untrusted playoff Bo5 fallback', () => {
  for (const winners of [['Alpha', 'Alpha'], ['Alpha', 'Beta', 'Alpha']]) {
    const series = resolveCanonicalSeries(winners.map((winner, index) => fixture({
      id: `fallback-${winners.length}-${index + 1}`,
      sourceGameId: `fallback-${winners.length}_game_${index + 1}`,
      winner,
      bestOf: 5,
      bestOfBasis: 'fallback',
    })))[0]
    assert.equal(series?.format, 3)
    assert.equal(series?.formatBasis, 'score-inferred')
    assert.equal(series?.state, 'completed')
  }
})

test('fallback Bo1 rows stay grouped so source scores can prove a series format', () => {
  const series = resolveCanonicalSeries([
    fixture({ id: 'fallback-bo1-2', sourceGameId: 'opaque-b', winner: 'Beta', bestOf: 1, bestOfBasis: 'fallback' }),
    fixture({ id: 'fallback-bo1-1', sourceGameId: 'opaque-a', winner: 'Alpha', bestOf: 1, bestOfBasis: 'fallback' }),
    fixture({ id: 'fallback-bo1-3', sourceGameId: 'opaque-c', winner: 'Alpha', bestOf: 1, bestOfBasis: 'fallback' }),
  ])[0]

  assert.equal(series?.format, 3)
  assert.equal(series?.formatBasis, 'score-inferred')
  assert.equal(series?.state, 'completed')
})

test('an ambiguous fallback 1-1 group is not treated as a completed Bo2', () => {
  const series = resolveCanonicalSeries([
    fixture({ id: 'fallback-tie-a', sourceGameId: 'opaque-tie-a', winner: 'Alpha', bestOf: 1, bestOfBasis: 'fallback' }),
    fixture({ id: 'fallback-tie-b', sourceGameId: 'opaque-tie-b', winner: 'Beta', bestOf: 1, bestOfBasis: 'fallback' }),
  ])[0]

  assert.equal(series?.format, 1)
  assert.equal(series?.formatBasis, 'fallback')
  assert.equal(series?.state, 'unknown')
})

test('canonical resolver distinguishes completed Bo3 and Bo5 scores from incomplete series', () => {
  const cases = [
    { id: 'bo3-2-1', bestOf: 3, winners: ['Alpha', 'Beta', 'Alpha'], state: 'completed' },
    { id: 'bo5-3-0', bestOf: 5, winners: ['Alpha', 'Alpha', 'Alpha'], state: 'completed' },
    { id: 'bo5-3-2', bestOf: 5, winners: ['Alpha', 'Beta', 'Alpha', 'Beta', 'Alpha'], state: 'completed' },
    { id: 'bo3-1-1', bestOf: 3, winners: ['Alpha', 'Beta'], state: 'ongoing' },
  ] as const

  for (const entry of cases) {
    const series = resolveCanonicalSeries(entry.winners.map((winner, index) => fixture({
      id: `${entry.id}-${index + 1}`,
      sourceGameId: `${entry.id}_game_${index + 1}`,
      winner,
      bestOf: entry.bestOf,
      bestOfBasis: 'provider',
    })))[0]
    assert.equal(series?.format, entry.bestOf)
    assert.equal(series?.state, entry.state)
  }
})

test('official ids separate same-team same-day series and orientation swaps stay canonical', () => {
  const matches = [
    fixture({ id: 'official-a', officialMatchId: 'series-a', winner: 'Alpha' }),
    fixture({ id: 'official-b', officialMatchId: 'series-b', teamA: 'Beta', teamB: 'Alpha', winner: 'Beta' }),
  ]
  const resolved = resolveCanonicalSeries(matches)

  assert.equal(resolved.length, 2)
  assert.deepEqual(resolved.map((series) => [series.teamA, series.teamB]), [['Alpha', 'Beta'], ['Alpha', 'Beta']])
  assert.notEqual(resolved[0]?.id, resolved[1]?.id)
})

test('one canonical series tolerates swapped raw sides and known team aliases', () => {
  const series = resolveCanonicalSeries([
    fixture({ id: 'swapped-1', officialMatchId: 'swapped-series', teamA: 'LYON (2024 American Team)', teamB: 'Beta', winner: 'LYON (2024 American Team)', bestOf: 3 }),
    fixture({ id: 'swapped-2', officialMatchId: 'swapped-series', teamA: 'Beta', teamB: 'LYON', winner: 'Beta', bestOf: 3 }),
    fixture({ id: 'swapped-3', officialMatchId: 'swapped-series', teamA: 'LYON', teamB: 'Beta', winner: 'LYON', bestOf: 3 }),
  ])[0]

  assert.ok(series)
  assert.equal(series.games.length, 3)
  assert.deepEqual([series.winsA, series.winsB].sort(), [1, 2])
  assert.equal(series.state, 'completed')
})

test('interleaved provider rows and every row permutation resolve identically', () => {
  const matches = [
    fixture({ id: 'a-2', sourceGameId: 'a_game_2', winner: 'Beta', bestOf: 3 }),
    fixture({ id: 'b-1', sourceGameId: 'b_game_1', teamA: 'Gamma', teamB: 'Delta', winner: 'Gamma', bestOf: 3 }),
    fixture({ id: 'a-1', sourceGameId: 'a_game_1', winner: 'Alpha', bestOf: 3 }),
    fixture({ id: 'b-2', sourceGameId: 'b_game_2', teamA: 'Gamma', teamB: 'Delta', winner: 'Gamma', bestOf: 3 }),
    fixture({ id: 'a-3', sourceGameId: 'a_game_3', winner: 'Alpha', bestOf: 3 }),
  ]
  const expected = JSON.stringify(resolveCanonicalSeries(matches))

  for (const permutation of permutations(matches)) {
    assert.equal(JSON.stringify(resolveCanonicalSeries(permutation)), expected)
  }
  assert.equal(canonicalSeriesForMatches(matches).size, matches.length)
})

function fixture(overrides: Partial<MatchRecord>): MatchRecord {
  return {
    id: 'game-1',
    sourceProvider: 'oracles-elixir',
    sourceGameId: 'series_game_1',
    date: '2026-07-01',
    season: 2026,
    event: 'Fixture',
    phase: 'Playoffs',
    region: 'LCK',
    league: 'LCK',
    patch: '26.13',
    bestOf: 1,
    bestOfBasis: 'provider',
    tier: 'regional-regular',
    teamA: 'Alpha',
    teamB: 'Beta',
    winner: 'Alpha',
    teamAKills: 10,
    teamBKills: 5,
    teamAGold: 50000,
    teamBGold: 45000,
    ...overrides,
  }
}

function permutations<T>(values: T[]): T[][] {
  if (values.length <= 1) return [values]
  return values.flatMap((value, index) => permutations([
    ...values.slice(0, index),
    ...values.slice(index + 1),
  ]).map((rest) => [value, ...rest]))
}
