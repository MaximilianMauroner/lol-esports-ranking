import assert from 'node:assert/strict'
import test from 'node:test'
import { compactStanding } from '../src/lib/publicArtifacts/schema.ts'
import { compactPlayerRecentMatches } from '../src/lib/snapshot.ts'
import type { PlayerStanding, TeamHistoryPoint, TeamStanding } from '../src/types.ts'

test('public recent matches retain completed Bo2 ties and canonical provenance', () => {
  const compact = compactStanding({
    team: 'Alpha',
    code: 'ALP',
    region: 'LCK',
    league: 'LCK',
    wins: 0,
    losses: 0,
    form: [],
    history: [
      historyPoint({ id: 'tie-series', game: 1, result: 'W', outcome: 0.5, state: 'completed' }),
      historyPoint({ id: 'tie-series', game: 2, result: 'L', outcome: 0.5, state: 'completed' }),
      historyPoint({ id: 'ongoing-series', game: 1, result: 'W', state: 'ongoing' }),
    ],
  } as unknown as TeamStanding)

  assert.equal(compact.wins, 0)
  assert.equal(compact.losses, 0)
  assert.deepEqual(compact.form, ['T'])
  assert.equal(compact.recentMatches.length, 1)
  assert.deepEqual(compact.recentMatches[0], {
    date: '2026-07-01',
    event: 'Fixture',
    opponent: 'Beta',
    result: 'T',
    rating: 1500,
    delta: 0,
    wins: 1,
    losses: 1,
    games: 2,
    bestOf: 2,
    seriesId: 'tie-series',
    formatBasis: 'provider',
    formatConfidence: 'high',
  })
})

test('player recent matches retain canonical Bo2 ties and separate same-day series ids', () => {
  const history = [
    playerHistoryPoint('tie-series', 1, 'W', 0.5),
    playerHistoryPoint('tie-series', 2, 'L', 0.5),
    playerHistoryPoint('official-series-2', 1, 'W', 1),
  ]
  const recent = compactPlayerRecentMatches({ history } as unknown as PlayerStanding)

  assert.equal(recent?.length, 2)
  assert.deepEqual(recent?.map((match) => ({
    result: match.result,
    games: match.games,
    seriesId: match.seriesId,
    formatBasis: match.formatBasis,
    formatConfidence: match.formatConfidence,
  })), [
    { result: 'T', games: 2, seriesId: 'tie-series', formatBasis: 'provider', formatConfidence: 'high' },
    { result: 'W', games: 1, seriesId: 'official-series-2', formatBasis: 'official', formatConfidence: 'high' },
  ])
})

test('public match delta follows visible rating movement between series', () => {
  const first = historyPoint({ id: 'first-series', game: 1, result: 'W', outcome: 1, state: 'completed' })
  const second = historyPoint({ id: 'second-series', game: 1, result: 'W', outcome: 1, state: 'completed' })
  first.rating = 1510
  first.delta = -40
  second.rating = 1525
  second.delta = -55

  const compact = compactStanding({
    team: 'Alpha',
    code: 'ALP',
    region: 'LCK',
    league: 'LCK',
    history: [first, second],
  } as unknown as TeamStanding)

  assert.deepEqual(compact.recentMatches.map((match) => match.delta), [-40, 15])
})

function playerHistoryPoint(seriesId: string, game: number, result: 'W' | 'L', outcome: 0 | 0.5 | 1) {
  return {
    date: '2026-07-01',
    event: 'Fixture',
    opponent: 'Beta',
    playerTeam: 'Alpha',
    result,
    bestOf: seriesId === 'tie-series' ? 2 : 1,
    rating: 100,
    delta: 0,
    source: {
      provider: 'oracles-elixir' as const,
      seriesId,
      bestOf: seriesId === 'tie-series' ? 2 : 1,
      formatBasis: seriesId === 'tie-series' ? 'provider' as const : 'official' as const,
      formatConfidence: 'high' as const,
      seriesState: 'completed' as const,
      seriesOutcome: outcome,
      gameId: `${seriesId}-game-${game}`,
    },
  }
}

function historyPoint({
  id,
  game,
  result,
  outcome,
  state,
}: {
  id: string
  game: number
  result: 'W' | 'L'
  outcome?: 0 | 0.5 | 1
  state: 'ongoing' | 'completed'
}): TeamHistoryPoint {
  return {
    date: '2026-07-01',
    event: 'Fixture',
    opponent: 'Beta',
    rating: 1500,
    baseRating: 1500,
    leagueAdjustment: 0,
    sideAdjustment: 0,
    ratingComponents: {
      leagueAnchor: 1500,
      teamStableOffset: 0,
      rosterPriorOffset: 0,
      momentum: 0,
      contextAdjustment: 0,
      uncertainty: 100,
    },
    ratingUpdate: {
      teamStableDelta: 0,
      leagueGameDelta: 0,
      leaguePlacementDelta: 0,
      momentumDelta: 0,
      rosterPriorDelta: 0,
      uncertaintyDelta: 0,
      sideAdjustment: 0,
      patchAdjustment: 0,
      updateUnit: state === 'completed' && game === 2 ? 'series-atomic' : 'series-member-no-team-update',
    },
    rank: 1,
    delta: 0,
    tier: 'regional-regular',
    result,
    source: {
      provider: 'oracles-elixir',
      gameId: `${id}-game-${game}`,
      seriesId: id,
      bestOf: state === 'completed' ? 2 : 3,
      formatBasis: 'provider',
      formatConfidence: 'high',
      seriesState: state,
      seriesOutcome: outcome,
    },
  }
}
