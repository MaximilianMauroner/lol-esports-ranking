import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCurrentPredictor, buildWalkForwardBacktest, summarizePredictions } from '../src/lib/predictionModel.ts'
import type { MatchRecord, PregamePrediction, Role, Side, TeamProfile } from '../src/types.ts'

const teams: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
  Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
  Gamma: { name: 'Gamma', code: 'GAM', region: 'LPL', league: 'LPL' },
}

test('walk-forward predictions are recorded before each match update', () => {
  const backtest = buildWalkForwardBacktest([
    matchFixture({ id: 'm1', date: '2026-01-01', winner: 'Alpha' }),
    matchFixture({ id: 'm2', date: '2026-01-02', winner: 'Alpha' }),
    matchFixture({ id: 'm3', date: '2026-01-03', winner: 'Beta' }),
  ], { ...teams })

  assert.equal(backtest.predictions.length, 3)
  assert.equal(backtest.predictions[0]?.trainingMatchCount, 0)
  assert.equal(backtest.predictions[1]?.trainingMatchCount, 1)
  assert.equal(backtest.predictions[0]?.teamAPregameWins, 0)
  assert.equal(backtest.predictions[1]?.teamAPregameWins, 1)
  assert.equal(backtest.predictions[2]?.teamAPregameWins, 2)
  assert.equal(backtest.metrics.target, 'published-game')
  assert.equal(backtest.metrics.predictionCount, 3)
  assert.ok(backtest.metrics.brierScore >= 0)
  assert.ok(backtest.metrics.logLoss >= 0)
})

test('future match result and stats do not change earlier pre-game predictions', () => {
  const baseMatches = [
    matchFixture({ id: 'm1', date: '2026-01-01', winner: 'Alpha' }),
    matchFixture({ id: 'm2', date: '2026-01-02', winner: 'Alpha' }),
    matchFixture({ id: 'future', date: '2026-01-03', winner: 'Beta', teamAKills: 10, teamBKills: 20, teamAGold: 55000, teamBGold: 65000 }),
  ]
  const mutatedFuture = [
    baseMatches[0],
    baseMatches[1],
    matchFixture({ id: 'future', date: '2026-01-03', winner: 'Alpha', teamAKills: 40, teamBKills: 1, teamAGold: 90000, teamBGold: 30000 }),
  ]

  const base = buildWalkForwardBacktest(baseMatches, { ...teams }).predictions[1]
  const mutated = buildWalkForwardBacktest(mutatedFuture, { ...teams }).predictions[1]

  assert.deepEqual(
    predictionComparable(base),
    predictionComparable(mutated),
  )
})

test('appending a later match does not change earlier pre-game predictions', () => {
  const baseMatches = [
    matchFixture({ id: 'm1', date: '2026-01-01', winner: 'Alpha' }),
    matchFixture({ id: 'm2', date: '2026-01-02', winner: 'Alpha' }),
  ]

  const base = buildWalkForwardBacktest(baseMatches, { ...teams }).predictions[1]
  const appended = buildWalkForwardBacktest([
    ...baseMatches,
    matchFixture({ id: 'future', date: '2026-04-01', winner: 'Beta', teamAKills: 1, teamBKills: 40 }),
  ], { ...teams }).predictions[1]

  assert.deepEqual(
    predictionComparable(base),
    predictionComparable(appended),
  )
})

test('future roster observations do not change earlier pre-game predictions', () => {
  const baseMatches = [
    matchFixture({ id: 'm1', date: '2026-01-01', winner: 'Alpha' }),
    matchFixture({ id: 'm2', date: '2026-01-02', winner: 'Alpha' }),
    matchFixture({
      id: 'future',
      date: '2026-01-03',
      winner: 'Beta',
      teamARoster: rosterFixture('alpha-old'),
      teamBRoster: rosterFixture('beta-old'),
    }),
  ]
  const mutatedFuture = [
    baseMatches[0],
    baseMatches[1],
    matchFixture({
      id: 'future',
      date: '2026-01-03',
      winner: 'Beta',
      teamARoster: rosterFixture('alpha-new'),
      teamBRoster: rosterFixture('beta-new'),
    }),
  ]

  const base = buildWalkForwardBacktest(baseMatches, { ...teams }).predictions[1]
  const mutated = buildWalkForwardBacktest(mutatedFuture, { ...teams }).predictions[1]

  assert.deepEqual(
    predictionComparable(base),
    predictionComparable(mutated),
  )
})

test('roster continuity regresses ratings and raises uncertainty before the roster-change prediction', () => {
  const unchanged = buildWalkForwardBacktest([
    matchFixture({ id: 'm1', date: '2026-01-01', winner: 'Alpha', teamARoster: rosterFixture('alpha'), teamBRoster: rosterFixture('beta') }),
    matchFixture({ id: 'm2', date: '2026-01-02', winner: 'Alpha', teamARoster: rosterFixture('alpha'), teamBRoster: rosterFixture('beta') }),
    matchFixture({ id: 'm3', date: '2026-01-03', winner: 'Alpha', teamARoster: rosterFixture('alpha'), teamBRoster: rosterFixture('beta') }),
  ], { ...teams }).predictions[2]
  const changed = buildWalkForwardBacktest([
    matchFixture({ id: 'm1', date: '2026-01-01', winner: 'Alpha', teamARoster: rosterFixture('alpha'), teamBRoster: rosterFixture('beta') }),
    matchFixture({ id: 'm2', date: '2026-01-02', winner: 'Alpha', teamARoster: rosterFixture('alpha'), teamBRoster: rosterFixture('beta') }),
    matchFixture({ id: 'm3', date: '2026-01-03', winner: 'Alpha', teamARoster: rosterFixture('alpha-new'), teamBRoster: rosterFixture('beta') }),
  ], { ...teams }).predictions[2]

  assert.ok(unchanged)
  assert.ok(changed)
  assert.equal(unchanged.teamARosterContinuity, 1)
  assert.equal(changed.teamARosterContinuity, 0)
  assert.ok(changed.teamARating < unchanged.teamARating)
  assert.ok(changed.teamAUncertainty > unchanged.teamAUncertainty)
})

test('result of a roster-change match does not alter its pre-game continuity prediction', () => {
  const baseMatches = [
    matchFixture({ id: 'm1', date: '2026-01-01', winner: 'Alpha', teamARoster: rosterFixture('alpha'), teamBRoster: rosterFixture('beta') }),
    matchFixture({ id: 'm2', date: '2026-01-02', winner: 'Alpha', teamARoster: rosterFixture('alpha'), teamBRoster: rosterFixture('beta') }),
    matchFixture({ id: 'm3', date: '2026-01-03', winner: 'Alpha', teamARoster: rosterFixture('alpha-new'), teamBRoster: rosterFixture('beta') }),
  ]
  const mutatedResult = [
    baseMatches[0],
    baseMatches[1],
    matchFixture({ id: 'm3', date: '2026-01-03', winner: 'Beta', teamARoster: rosterFixture('alpha-new'), teamBRoster: rosterFixture('beta') }),
  ]

  const base = buildWalkForwardBacktest(baseMatches, { ...teams }).predictions[2]
  const mutated = buildWalkForwardBacktest(mutatedResult, { ...teams }).predictions[2]

  assert.deepEqual(
    predictionComparable(base),
    predictionComparable(mutated),
  )
})

test('same-day matches are predicted as one batch before any same-day update', () => {
  const backtest = buildWalkForwardBacktest([
    matchFixture({ id: 'm1', date: '2026-01-01', winner: 'Alpha' }),
    matchFixture({ id: 'm2', date: '2026-01-01', winner: 'Alpha' }),
    matchFixture({ id: 'm3', date: '2026-01-02', winner: 'Alpha' }),
  ], { ...teams })
  const first = backtest.predictions[0]
  const second = backtest.predictions[1]
  const nextDay = backtest.predictions[2]

  assert.equal(first?.trainingMatchCount, 0)
  assert.equal(second?.trainingMatchCount, 0)
  assert.equal(nextDay?.trainingMatchCount, 2)
  assert.equal(second?.dataCutoff, undefined)
  assert.equal(second?.teamAGameWinProbability, first?.teamAGameWinProbability)
  assert.equal(second?.teamARating, first?.teamARating)
})

test('side priors are prior-only and published predictions are side-aware', () => {
  const backtest = buildWalkForwardBacktest([
    matchFixture({ id: 'same-day-side-1', date: '2026-01-01', teamASide: 'blue', teamBSide: 'red', winner: 'Alpha' }),
    matchFixture({ id: 'same-day-side-2', date: '2026-01-01', teamASide: 'blue', teamBSide: 'red', winner: 'Alpha' }),
    matchFixture({ id: 'blue-side-prediction', date: '2026-01-02', teamASide: 'blue', teamBSide: 'red', winner: 'Alpha' }),
    matchFixture({ id: 'red-side-prediction', date: '2026-01-02', teamASide: 'red', teamBSide: 'blue', winner: 'Alpha' }),
  ], { ...teams })
  const first = backtest.predictions[0]
  const second = backtest.predictions[1]
  const bluePrediction = backtest.predictions[2]
  const redPrediction = backtest.predictions[3]

  assert.ok(first)
  assert.ok(second)
  assert.ok(bluePrediction)
  assert.ok(redPrediction)
  assert.equal(first.teamASideAdjustment, 0)
  assert.equal(second.teamASideAdjustment, 0)
  assert.equal(second.teamAGameWinProbability, first.teamAGameWinProbability)
  assert.equal(bluePrediction.trainingMatchCount, redPrediction.trainingMatchCount)
  assert.equal(bluePrediction.teamASide, 'blue')
  assert.equal(redPrediction.teamASide, 'red')
  for (const key of ['team-only', 'player-adjusted', 'execution-baseline', 'execution-adjusted'] as const) {
    assert.equal(
      bluePrediction.variants[key].teamAGameWinProbability,
      redPrediction.variants[key].teamAGameWinProbability,
    )
  }
  assert.ok((bluePrediction.teamASideAdjustment ?? 0) > 0)
  assert.ok((bluePrediction.teamBSideAdjustment ?? 0) < 0)
  assert.equal(bluePrediction.variants.published.teamAGameWinProbability, bluePrediction.teamAGameWinProbability)
  assert.ok(bluePrediction.teamAGameWinProbability > bluePrediction.variants['player-adjusted'].teamAGameWinProbability)
  assert.ok((redPrediction.teamASideAdjustment ?? 0) < 0)
  assert.ok((redPrediction.teamBSideAdjustment ?? 0) > 0)
  assert.equal(redPrediction.variants.published.teamAGameWinProbability, redPrediction.teamAGameWinProbability)
  assert.ok(redPrediction.teamAGameWinProbability < redPrediction.variants['player-adjusted'].teamAGameWinProbability)
  assert.ok(bluePrediction.teamAGameWinProbability > redPrediction.teamAGameWinProbability)
})

test('current game player stats do not affect their own pre-game player edge', () => {
  const prediction = buildWalkForwardBacktest([
    matchFixture({
      id: 'first-player-game',
      date: '2026-01-01',
      sourceProvider: 'oracles-elixir',
      teamARoster: sourcedRosterFixture('alpha', 'blue', true, {
        Bot: { kills: 18, deaths: 0, assists: 8, damageShare: 0.45, earnedGoldShare: 0.35 },
      }),
      teamBRoster: sourcedRosterFixture('beta', 'red', false),
    }),
  ], { ...teams }).predictions[0]

  assert.equal(prediction?.teamAPlayerRatingAdjustment, 0)
  assert.equal(prediction?.teamBPlayerRatingAdjustment, 0)
  assert.equal(prediction?.teamAPlayerRatingCoverage, 0)
  assert.equal(prediction?.teamAGameWinProbabilityPlayerAdjusted, prediction?.teamAGameWinProbability)
})

test('prior sourced player ratings feed gated player-adjusted probabilities', () => {
  const sourcedMatches = [
    matchFixture({
      id: 'player-history',
      date: '2026-01-01',
      sourceProvider: 'oracles-elixir',
      teamARoster: sourcedRosterFixture('alpha', 'blue', true),
      teamBRoster: sourcedRosterFixture('beta', 'red', false),
    }),
    matchFixture({
      id: 'player-shadow',
      date: '2026-01-02',
      sourceProvider: 'oracles-elixir',
      teamARoster: sourcedRosterFixture('alpha', 'blue', true),
      teamBRoster: sourcedRosterFixture('beta', 'red', false),
    }),
  ]
  const withPlayerRatings = buildWalkForwardBacktest(sourcedMatches, { ...teams }).predictions[1]
  const withoutPlayerRatings = buildWalkForwardBacktest(sourcedMatches.map(stripRosters), { ...teams }).predictions[1]

  assert.ok(withPlayerRatings)
  assert.ok(withoutPlayerRatings)
  assert.equal(withPlayerRatings.playerRatingPredictionWeight, 1)
  assert.equal(withPlayerRatings.teamAGameWinProbabilityTeamOnly, withoutPlayerRatings.teamAGameWinProbabilityTeamOnly)
  assert.equal(withPlayerRatings.variants?.['team-only']?.teamAGameWinProbability, withoutPlayerRatings.variants?.['team-only']?.teamAGameWinProbability)
  assert.ok((withPlayerRatings.teamAPlayerRatingAdjustment ?? 0) > 0)
  assert.ok((withPlayerRatings.teamBPlayerRatingAdjustment ?? 0) < 0)
  assert.equal(withPlayerRatings.teamAPlayerRatingCoverage, 1)
  assert.equal(withPlayerRatings.teamBPlayerRatingCoverage, 1)
  assert.equal(withPlayerRatings.teamASideAdjustment, 0)
  assert.equal(withPlayerRatings.variants?.['player-adjusted']?.teamAGameWinProbability, withPlayerRatings.teamAGameWinProbabilityPlayerAdjusted)
  assert.ok(withPlayerRatings.teamAGameWinProbability > (withPlayerRatings.teamAGameWinProbabilityTeamOnly ?? 0))
  assert.ok((withPlayerRatings.teamAGameWinProbabilityPlayerAdjusted ?? 0) > (withPlayerRatings.teamAGameWinProbabilityTeamOnly ?? 0))
})

test('future player stats do not change earlier player-shadow predictions', () => {
  const baseMatches = [
    matchFixture({
      id: 'player-history',
      date: '2026-01-01',
      sourceProvider: 'oracles-elixir',
      teamARoster: sourcedRosterFixture('alpha', 'blue', true),
      teamBRoster: sourcedRosterFixture('beta', 'red', false),
    }),
    matchFixture({
      id: 'player-prediction',
      date: '2026-01-02',
      sourceProvider: 'oracles-elixir',
      teamARoster: sourcedRosterFixture('alpha', 'blue', true),
      teamBRoster: sourcedRosterFixture('beta', 'red', false),
    }),
    matchFixture({
      id: 'future-player-game',
      date: '2026-01-03',
      sourceProvider: 'oracles-elixir',
      winner: 'Beta',
      teamARoster: sourcedRosterFixture('alpha', 'blue', false),
      teamBRoster: sourcedRosterFixture('beta', 'red', true),
    }),
  ]
  const mutatedFuture = [
    baseMatches[0],
    baseMatches[1],
    matchFixture({
      id: 'future-player-game',
      date: '2026-01-03',
      sourceProvider: 'oracles-elixir',
      winner: 'Alpha',
      teamARoster: sourcedRosterFixture('alpha', 'blue', true, {
        Bot: { kills: 24, deaths: 0, assists: 10, damageShare: 0.55, earnedGoldShare: 0.4 },
      }),
      teamBRoster: sourcedRosterFixture('beta', 'red', false, {
        Bot: { kills: 0, deaths: 12, assists: 1, damageShare: 0.08, earnedGoldShare: 0.1 },
      }),
    }),
  ]

  const base = buildWalkForwardBacktest(baseMatches, { ...teams }).predictions[1]
  const mutated = buildWalkForwardBacktest(mutatedFuture, { ...teams }).predictions[1]

  assert.deepEqual(
    predictionComparable(base),
    predictionComparable(mutated),
  )
})

test('same-day player ratings are frozen before all same-day predictions', () => {
  const backtest = buildWalkForwardBacktest([
    matchFixture({
      id: 'same-day-1',
      date: '2026-01-01',
      sourceProvider: 'oracles-elixir',
      teamARoster: sourcedRosterFixture('alpha', 'blue', true),
      teamBRoster: sourcedRosterFixture('beta', 'red', false),
    }),
    matchFixture({
      id: 'same-day-2',
      date: '2026-01-01',
      sourceProvider: 'oracles-elixir',
      teamARoster: sourcedRosterFixture('alpha', 'blue', true),
      teamBRoster: sourcedRosterFixture('beta', 'red', false),
    }),
    matchFixture({
      id: 'next-day',
      date: '2026-01-02',
      sourceProvider: 'oracles-elixir',
      teamARoster: sourcedRosterFixture('alpha', 'blue', true),
      teamBRoster: sourcedRosterFixture('beta', 'red', false),
    }),
  ], { ...teams })
  const first = backtest.predictions[0]
  const second = backtest.predictions[1]
  const nextDay = backtest.predictions[2]

  assert.equal(first?.teamAPlayerRatingAdjustment, 0)
  assert.equal(second?.teamAPlayerRatingAdjustment, 0)
  assert.equal(second?.teamAGameWinProbabilityPlayerAdjusted, first?.teamAGameWinProbabilityPlayerAdjusted)
  assert.ok((nextDay?.teamAPlayerRatingAdjustment ?? 0) > 0)
})

test('current game execution stats do not affect their own pre-game execution shadow', () => {
  const base = buildWalkForwardBacktest([
    matchFixture({ id: 'execution-current', date: '2026-01-01', winner: 'Alpha', teamAKills: 5, teamBKills: 4, teamAGold: 50200, teamBGold: 49800 }),
  ], { ...teams }).predictions[0]
  const mutated = buildWalkForwardBacktest([
    matchFixture({ id: 'execution-current', date: '2026-01-01', winner: 'Alpha', teamAKills: 40, teamBKills: 1, teamAGold: 90000, teamBGold: 30000 }),
  ], { ...teams }).predictions[0]

  assert.equal(base?.teamAExecutionResidualAdjustment, 0)
  assert.equal(base?.teamBExecutionResidualAdjustment, 0)
  assert.deepEqual(
    executionPredictionComparable(base),
    executionPredictionComparable(mutated),
  )
})

test('future execution stats do not change earlier execution-shadow predictions', () => {
  const baseMatches = [
    matchFixture({ id: 'execution-history', date: '2026-01-01', winner: 'Alpha', teamAKills: 30, teamBKills: 2, teamAGold: 76000, teamBGold: 42000 }),
    matchFixture({ id: 'execution-prediction', date: '2026-01-02', winner: 'Alpha' }),
    matchFixture({ id: 'execution-future', date: '2026-01-03', winner: 'Beta', teamAKills: 3, teamBKills: 30, teamAGold: 42000, teamBGold: 76000 }),
  ]
  const mutatedFuture = [
    baseMatches[0],
    baseMatches[1],
    matchFixture({ id: 'execution-future', date: '2026-01-03', winner: 'Alpha', teamAKills: 45, teamBKills: 1, teamAGold: 91000, teamBGold: 31000 }),
  ]

  const base = buildWalkForwardBacktest(baseMatches, { ...teams }).predictions[1]
  const mutated = buildWalkForwardBacktest(mutatedFuture, { ...teams }).predictions[1]

  assert.deepEqual(
    predictionComparable(base),
    predictionComparable(mutated),
  )
})

test('same-day execution ratings are frozen before all same-day predictions', () => {
  const backtest = buildWalkForwardBacktest([
    matchFixture({ id: 'execution-same-day-1', date: '2026-01-01', winner: 'Alpha', teamAKills: 35, teamBKills: 2, teamAGold: 78000, teamBGold: 40000 }),
    matchFixture({ id: 'execution-same-day-2', date: '2026-01-01', winner: 'Alpha', teamAKills: 35, teamBKills: 2, teamAGold: 78000, teamBGold: 40000 }),
    matchFixture({ id: 'execution-next-day', date: '2026-01-02', winner: 'Alpha' }),
  ], { ...teams })
  const first = backtest.predictions[0]
  const second = backtest.predictions[1]
  const nextDay = backtest.predictions[2]

  assert.equal(first?.teamAExecutionResidualAdjustment, 0)
  assert.equal(second?.teamAExecutionResidualAdjustment, 0)
  assert.equal(second?.teamAGameWinProbabilityExecutionAdjusted, first?.teamAGameWinProbabilityExecutionAdjusted)
  assert.notEqual(nextDay?.teamAExecutionResidualAdjustment, 0)
})

test('walk-forward predictions label validation segments from prior state only', () => {
  const backtest = buildWalkForwardBacktest([
    matchFixture({ id: 'm1', date: '2026-01-01', patch: '26.1', winner: 'Alpha', teamARoster: rosterFixture('alpha'), teamBRoster: rosterFixture('beta') }),
    matchFixture({
      id: 'm2',
      date: '2026-01-02',
      patch: '26.2',
      bestOf: 5,
      winner: 'Alpha',
      region: 'International',
      league: 'MSI',
      teamB: 'Gamma',
      teamBHomeLeague: 'LPL',
      teamBRegion: 'LPL',
      teamASide: 'blue',
      teamBSide: 'red',
      tier: 'msi-play-in',
      teamARoster: rosterFixture('alpha-new'),
      teamBRoster: rosterFixture('gamma'),
    }),
  ], { ...teams })
  const first = backtest.predictions[0]
  const second = backtest.predictions[1]

  assert.ok(first)
  assert.ok(second)
  assert.deepEqual(first.segments, ['bo1'])
  assert.equal(second.segments.includes('bo3-bo5'), true)
  assert.equal(second.segments.includes('international'), true)
  assert.equal(second.segments.includes('cross-region'), true)
  assert.equal(second.segments.includes('side-known'), true)
  assert.equal(second.segments.includes('patch-transition'), true)
  assert.equal(second.segments.includes('roster-change'), true)
})

test('walk-forward metrics score game probabilities because rows are games', () => {
  const metrics = summarizePredictions([
    predictionFixture({
      actualWinner: 'Alpha',
      predictedWinner: 'Alpha',
      teamAGameWinProbability: 0.6,
      teamBGameWinProbability: 0.4,
      teamASeriesWinProbability: 0.9,
      teamBSeriesWinProbability: 0.1,
    }),
    predictionFixture({
      id: 'p2',
      actualWinner: 'Beta',
      predictedWinner: 'Alpha',
      teamAGameWinProbability: 0.6,
      teamBGameWinProbability: 0.4,
      teamASeriesWinProbability: 0.9,
      teamBSeriesWinProbability: 0.1,
    }),
  ])

  assert.equal(metrics.brierScore, 0.26)
  assert.equal(metrics.accuracy, 0.5)
})

test('walk-forward metrics compare published predictions to pre-game baselines', () => {
  const metrics = summarizePredictions([
    predictionFixture({
      id: 'baseline-alpha',
      actualWinner: 'Alpha',
      teamAGameWinProbability: 0.7,
      teamBGameWinProbability: 0.3,
      teamAGameWinProbabilityTeamOnly: 0.6,
      teamBGameWinProbabilityTeamOnly: 0.4,
      teamAPregameWins: 8,
      teamAPregameLosses: 2,
      teamBPregameWins: 1,
      teamBPregameLosses: 7,
      segments: ['bo1', 'international'],
    }),
    predictionFixture({
      id: 'baseline-beta',
      actualWinner: 'Beta',
      teamAGameWinProbability: 0.3,
      teamBGameWinProbability: 0.7,
      teamAGameWinProbabilityTeamOnly: 0.4,
      teamBGameWinProbabilityTeamOnly: 0.6,
      teamAPregameWins: 0,
      teamAPregameLosses: 4,
      teamBPregameWins: 6,
      teamBPregameLosses: 1,
      segments: ['bo3-bo5', 'cross-region'],
    }),
  ])
  const coinFlip = baselineComparison(metrics, 'coin-flip')
  const pregameWinRate = baselineComparison(metrics, 'pregame-win-rate')
  const teamOnly = baselineComparison(metrics, 'team-only')

  assert.equal(metrics.baselineComparisons.length, 3)
  assert.equal(coinFlip.predictionCount, 2)
  assert.equal(coinFlip.accuracy, 0.5)
  assert.equal(coinFlip.publishedBrierDelta, 0.16)
  assert.equal(pregameWinRate.predictionCount, 2)
  assert.equal(pregameWinRate.accuracy, 1)
  assert.deepEqual(pregameWinRate.segments.map((segment) => segment.key), ['bo1', 'bo3-bo5', 'international', 'cross-region'])
  assert.equal(baselineSegment(pregameWinRate, 'international').predictionCount, 1)
  assert.equal(teamOnly.predictionCount, 2)
  assert.equal(teamOnly.accuracy, 1)
  assert.equal(teamOnly.publishedBrierDelta, 0.07)
  assert.equal(baselineSegment(teamOnly, 'bo1').publishedBrierDelta, 0.07)
})

test('walk-forward metrics summarize segment performance', () => {
  const metrics = summarizePredictions([
    predictionFixture({ id: 'bo1', segments: ['bo1'], actualWinner: 'Alpha', predictedWinner: 'Alpha', teamAGameWinProbability: 0.6, teamBGameWinProbability: 0.4 }),
    predictionFixture({ id: 'series', segments: ['bo3-bo5', 'international', 'cross-region', 'side-known'], actualWinner: 'Beta', predictedWinner: 'Alpha', teamAGameWinProbability: 0.6, teamBGameWinProbability: 0.4 }),
    predictionFixture({ id: 'transition', segments: ['patch-transition', 'roster-change'], actualWinner: 'Alpha', predictedWinner: 'Alpha', teamAGameWinProbability: 0.7, teamBGameWinProbability: 0.3 }),
  ])

  assert.equal(segmentCount(metrics, 'bo1'), 1)
  assert.equal(segmentCount(metrics, 'bo3-bo5'), 1)
  assert.equal(segmentCount(metrics, 'international'), 1)
  assert.equal(segmentCount(metrics, 'cross-region'), 1)
  assert.equal(segmentCount(metrics, 'side-known'), 1)
  assert.equal(segmentCount(metrics, 'patch-transition'), 1)
  assert.equal(segmentCount(metrics, 'roster-change'), 1)
})

test('walk-forward metrics score the player-rating shadow variant separately', () => {
  const metrics = summarizePredictions([
    predictionFixture({
      id: 'shadow-alpha',
      segments: ['roster-change'],
      actualWinner: 'Alpha',
      teamAGameWinProbability: 0.6,
      teamBGameWinProbability: 0.4,
      teamAGameWinProbabilityPlayerAdjusted: 0.7,
      teamBGameWinProbabilityPlayerAdjusted: 0.3,
      playerRatingPredictionWeight: 0,
    }),
    predictionFixture({
      id: 'shadow-beta',
      segments: ['patch-transition'],
      actualWinner: 'Beta',
      teamAGameWinProbability: 0.6,
      teamBGameWinProbability: 0.4,
      teamAGameWinProbabilityPlayerAdjusted: 0.4,
      teamBGameWinProbabilityPlayerAdjusted: 0.6,
      playerRatingPredictionWeight: 0,
    }),
  ])

  assert.equal(metrics.playerRatingShadow.enabled, false)
  assert.equal(metrics.playerRatingShadow.predictionCount, 2)
  assert.equal(metrics.playerRatingShadow.accuracy, 1)
  assert.equal(metrics.playerRatingShadow.brierScore, 0.125)
  assert.equal(metrics.playerRatingShadow.brierDelta, 0.135)
  assert.ok(metrics.playerRatingShadow.logLossDelta > 0)
  assert.ok(metrics.playerRatingShadow.rosterChangeBrierDelta > 0)
  assert.ok(metrics.playerRatingShadow.patchTransitionBrierDelta > 0)
})

test('walk-forward metrics score the execution-residual shadow variant separately', () => {
  const metrics = summarizePredictions([
    predictionFixture({
      id: 'execution-alpha',
      segments: ['cross-region'],
      actualWinner: 'Alpha',
      teamAGameWinProbability: 0.6,
      teamBGameWinProbability: 0.4,
      teamAGameWinProbabilityExecutionBaseline: 0.6,
      teamBGameWinProbabilityExecutionBaseline: 0.4,
      teamAGameWinProbabilityExecutionAdjusted: 0.7,
      teamBGameWinProbabilityExecutionAdjusted: 0.3,
      executionResidualPredictionWeight: 0,
    }),
    predictionFixture({
      id: 'execution-beta',
      segments: ['patch-transition'],
      actualWinner: 'Beta',
      teamAGameWinProbability: 0.6,
      teamBGameWinProbability: 0.4,
      teamAGameWinProbabilityExecutionBaseline: 0.6,
      teamBGameWinProbabilityExecutionBaseline: 0.4,
      teamAGameWinProbabilityExecutionAdjusted: 0.4,
      teamBGameWinProbabilityExecutionAdjusted: 0.6,
      executionResidualPredictionWeight: 0,
    }),
  ])

  assert.equal(metrics.executionResidualShadow.enabled, false)
  assert.equal(metrics.executionResidualShadow.predictionCount, 2)
  assert.equal(metrics.executionResidualShadow.accuracy, 1)
  assert.equal(metrics.executionResidualShadow.brierScore, 0.125)
  assert.equal(metrics.executionResidualShadow.brierDelta, 0.135)
  assert.ok(metrics.executionResidualShadow.logLossDelta > 0)
  assert.ok(metrics.executionResidualShadow.crossRegionBrierDelta > 0)
  assert.ok(metrics.executionResidualShadow.patchTransitionBrierDelta > 0)
})

test('current neutral predictor favors the stronger trained team without side conditions', () => {
  const predictor = buildCurrentPredictor([
    matchFixture({ id: 'm1', date: '2026-01-01', winner: 'Alpha' }),
    matchFixture({ id: 'm2', date: '2026-01-02', winner: 'Alpha' }),
    matchFixture({ id: 'm3', date: '2026-01-03', winner: 'Alpha', teamB: 'Gamma', teamBHomeLeague: 'LPL', teamBRegion: 'LPL', league: 'International', region: 'International', tier: 'msi-play-in' }),
  ], { ...teams })
  const prediction = predictor.predictNeutral('Alpha', 'Beta', 5)

  assert.equal(prediction.teamA, 'Alpha')
  assert.equal(prediction.teamB, 'Beta')
  assert.ok(prediction.teamASeriesWinProbability > 0.5)
  assert.equal(prediction.modelVersion.startsWith('transparent-gpr-v'), true)
})

function predictionComparable(prediction: ReturnType<typeof buildWalkForwardBacktest>['predictions'][number] | undefined) {
  assert.ok(prediction)
  return {
    teamA: prediction.teamA,
    teamB: prediction.teamB,
    teamASide: prediction.teamASide,
    teamBSide: prediction.teamBSide,
    teamAGameWinProbability: prediction.teamAGameWinProbability,
    teamASeriesWinProbability: prediction.teamASeriesWinProbability,
    teamAGameWinProbabilityTeamOnly: prediction.teamAGameWinProbabilityTeamOnly,
    teamBGameWinProbabilityTeamOnly: prediction.teamBGameWinProbabilityTeamOnly,
    teamAGameWinProbabilityPlayerAdjusted: prediction.teamAGameWinProbabilityPlayerAdjusted,
    teamBGameWinProbabilityPlayerAdjusted: prediction.teamBGameWinProbabilityPlayerAdjusted,
    teamAGameWinProbabilityExecutionBaseline: prediction.teamAGameWinProbabilityExecutionBaseline,
    teamBGameWinProbabilityExecutionBaseline: prediction.teamBGameWinProbabilityExecutionBaseline,
    teamAExecutionResidualAdjustment: prediction.teamAExecutionResidualAdjustment,
    teamBExecutionResidualAdjustment: prediction.teamBExecutionResidualAdjustment,
    teamAGameWinProbabilityExecutionAdjusted: prediction.teamAGameWinProbabilityExecutionAdjusted,
    teamBGameWinProbabilityExecutionAdjusted: prediction.teamBGameWinProbabilityExecutionAdjusted,
    teamARating: prediction.teamARating,
    teamBRating: prediction.teamBRating,
    teamAUncertainty: prediction.teamAUncertainty,
    teamBUncertainty: prediction.teamBUncertainty,
    teamARosterContinuity: prediction.teamARosterContinuity,
    teamBRosterContinuity: prediction.teamBRosterContinuity,
    teamAPlayerRatingAdjustment: prediction.teamAPlayerRatingAdjustment,
    teamBPlayerRatingAdjustment: prediction.teamBPlayerRatingAdjustment,
    teamASideAdjustment: prediction.teamASideAdjustment,
    teamBSideAdjustment: prediction.teamBSideAdjustment,
    teamAPlayerRatingCoverage: prediction.teamAPlayerRatingCoverage,
    teamBPlayerRatingCoverage: prediction.teamBPlayerRatingCoverage,
    trainingMatchCount: prediction.trainingMatchCount,
    dataCutoff: prediction.dataCutoff,
  }
}

function executionPredictionComparable(prediction: ReturnType<typeof buildWalkForwardBacktest>['predictions'][number] | undefined) {
  assert.ok(prediction)
  return {
    teamAExecutionResidualAdjustment: prediction.teamAExecutionResidualAdjustment,
    teamBExecutionResidualAdjustment: prediction.teamBExecutionResidualAdjustment,
    teamAGameWinProbabilityExecutionBaseline: prediction.teamAGameWinProbabilityExecutionBaseline,
    teamBGameWinProbabilityExecutionBaseline: prediction.teamBGameWinProbabilityExecutionBaseline,
    teamAGameWinProbabilityExecutionAdjusted: prediction.teamAGameWinProbabilityExecutionAdjusted,
    teamBGameWinProbabilityExecutionAdjusted: prediction.teamBGameWinProbabilityExecutionAdjusted,
  }
}

function rosterFixture(prefix: string): MatchRecord['teamARoster'] {
  return {
    sourceProvider: 'oracles-elixir',
    teamId: prefix,
    observedAt: '2026-01-03',
    completeness: 'complete-five-role',
    players: ['Top', 'Jungle', 'Mid', 'Bot', 'Support'].map((role) => ({
      id: `${prefix}-${role}`,
      name: `${prefix} ${role}`,
      role: role as 'Top' | 'Jungle' | 'Mid' | 'Bot' | 'Support',
    })),
  }
}

function sourcedRosterFixture(
  prefix: string,
  side: Side,
  won: boolean,
  statOverrides: Partial<Record<Role, Partial<NonNullable<MatchRecord['teamARoster']>['players'][number]['stats']>>> = {},
): NonNullable<MatchRecord['teamARoster']> {
  const roles = ['Top', 'Jungle', 'Mid', 'Bot', 'Support'] as const satisfies readonly Role[]
  return {
    sourceProvider: 'oracles-elixir',
    teamId: prefix,
    observedAt: '2026-01-01',
    completeness: 'complete-five-role',
    players: roles.map((role) => ({
      id: `${prefix}-${role}`,
      name: `${prefix} ${role}`,
      role,
      stats: {
        side,
        won,
        kills: won ? 6 : 1,
        deaths: won ? 1 : 5,
        assists: won ? 10 : 3,
        damageShare: won ? 0.24 : 0.14,
        earnedGoldShare: won ? 0.23 : 0.16,
        vspm: role === 'Support' ? (won ? 2.8 : 1.8) : (won ? 1.2 : 0.7),
        ...statOverrides[role],
      },
    })),
  }
}

function stripRosters(match: MatchRecord): MatchRecord {
  const { teamARoster, teamBRoster, ...withoutRosters } = match
  void teamARoster
  void teamBRoster
  return withoutRosters
}

function segmentCount(metrics: ReturnType<typeof summarizePredictions>, key: string) {
  return metrics.segments.find((segment) => segment.key === key)?.predictionCount
}

function baselineComparison(metrics: ReturnType<typeof summarizePredictions>, key: string) {
  const comparison = metrics.baselineComparisons.find((candidate) => candidate.key === key)
  assert.ok(comparison)
  return comparison
}

function baselineSegment(comparison: ReturnType<typeof baselineComparison>, key: string) {
  const segment = comparison.segments.find((candidate) => candidate.key === key)
  assert.ok(segment)
  return segment
}

function predictionFixture(overrides: Partial<PregamePrediction>): PregamePrediction {
  const prediction = {
    id: 'p1',
    date: '2026-01-01',
    event: 'LCK 2026 Spring',
    patch: '26.1',
    bestOf: 1,
    teamA: 'Alpha',
    teamB: 'Beta',
    actualWinner: 'Alpha',
    predictedWinner: 'Alpha',
    teamAGameWinProbability: 0.5,
    teamBGameWinProbability: 0.5,
    teamASeriesWinProbability: 0.5,
    teamBSeriesWinProbability: 0.5,
    uncertaintyPenalty: 0,
    teamARating: 1500,
    teamBRating: 1500,
    teamAUncertainty: 140,
    teamBUncertainty: 140,
    teamAPregameWins: 0,
    teamAPregameLosses: 0,
    teamBPregameWins: 0,
    teamBPregameLosses: 0,
    segments: [],
    trainingMatchCount: 0,
    modelVersion: 'test',
    modelConfigHash: 'test',
    source: {},
    ...overrides,
  } as Omit<PregamePrediction, 'variants'> & Partial<Pick<PregamePrediction, 'variants'>>

  return {
    ...prediction,
    variants: prediction.variants ?? predictionVariantsFixture(prediction),
  }
}

function predictionVariantsFixture(
  prediction: Omit<PregamePrediction, 'variants'>,
): PregamePrediction['variants'] {
  return {
    published: predictionVariantFixture(
      prediction.teamAGameWinProbability,
      prediction.teamBGameWinProbability,
      prediction.teamASeriesWinProbability,
      prediction.teamBSeriesWinProbability,
      prediction.teamARating,
      prediction.teamBRating,
    ),
    'team-only': predictionVariantFixture(
      prediction.teamAGameWinProbabilityTeamOnly ?? prediction.teamAGameWinProbability,
      prediction.teamBGameWinProbabilityTeamOnly ?? prediction.teamBGameWinProbability,
      prediction.teamASeriesWinProbabilityTeamOnly ?? prediction.teamASeriesWinProbability,
      prediction.teamBSeriesWinProbabilityTeamOnly ?? prediction.teamBSeriesWinProbability,
      prediction.teamARating,
      prediction.teamBRating,
    ),
    'player-adjusted': predictionVariantFixture(
      prediction.teamAGameWinProbabilityPlayerAdjusted ?? prediction.teamAGameWinProbability,
      prediction.teamBGameWinProbabilityPlayerAdjusted ?? prediction.teamBGameWinProbability,
      prediction.teamASeriesWinProbabilityPlayerAdjusted ?? prediction.teamASeriesWinProbability,
      prediction.teamBSeriesWinProbabilityPlayerAdjusted ?? prediction.teamBSeriesWinProbability,
      prediction.teamARating,
      prediction.teamBRating,
    ),
    'execution-baseline': predictionVariantFixture(
      prediction.teamAGameWinProbabilityExecutionBaseline ?? prediction.teamAGameWinProbability,
      prediction.teamBGameWinProbabilityExecutionBaseline ?? prediction.teamBGameWinProbability,
      prediction.teamASeriesWinProbabilityExecutionBaseline ?? prediction.teamASeriesWinProbability,
      prediction.teamBSeriesWinProbabilityExecutionBaseline ?? prediction.teamBSeriesWinProbability,
      prediction.teamARating,
      prediction.teamBRating,
    ),
    'execution-adjusted': predictionVariantFixture(
      prediction.teamAGameWinProbabilityExecutionAdjusted ?? prediction.teamAGameWinProbability,
      prediction.teamBGameWinProbabilityExecutionAdjusted ?? prediction.teamBGameWinProbability,
      prediction.teamASeriesWinProbabilityExecutionAdjusted ?? prediction.teamASeriesWinProbability,
      prediction.teamBSeriesWinProbabilityExecutionAdjusted ?? prediction.teamBSeriesWinProbability,
      prediction.teamARating,
      prediction.teamBRating,
    ),
  }
}

function predictionVariantFixture(
  teamAGameWinProbability: number,
  teamBGameWinProbability: number,
  teamASeriesWinProbability: number,
  teamBSeriesWinProbability: number,
  teamARating: number,
  teamBRating: number,
): PregamePrediction['variants']['published'] {
  return {
    teamAGameWinProbability,
    teamBGameWinProbability,
    teamASeriesWinProbability,
    teamBSeriesWinProbability,
    teamARating,
    teamBRating,
  }
}

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
    bestOf: 1,
    tier: 'regional-regular',
    teamA: 'Alpha',
    teamB: 'Beta',
    winner: 'Alpha',
    teamAKills: 20,
    teamBKills: 12,
    teamAGold: 65000,
    teamBGold: 59000,
    ...overrides,
  }
}
