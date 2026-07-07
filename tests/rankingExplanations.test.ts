import assert from 'node:assert/strict'
import test from 'node:test'
import {
  describeRosterBasis,
  describeUncertainty,
  formatWalkForwardMetrics,
  rankingTargetExplanations,
} from '../src/lib/rankingExplanations.ts'

test('ranking explanations cover all public model components', () => {
  assert.deepEqual(
    rankingTargetExplanations.map((item) => item.target).sort(),
    [
      'execution-residuals',
      'league-strength',
      'player-ratings',
      'recent-form',
      'roster-basis',
      'seasonal-anchoring',
      'team-result',
      'uncertainty',
      'walk-forward-metrics',
    ],
  )
})

test('roster and uncertainty helpers describe compact standing fields', () => {
  assert.match(describeRosterBasis('sourced'), /Oracle/)
  assert.match(describeRosterBasis('assumed-continuous'), /partial/)
  assert.match(describeRosterBasis('unknown'), /No sourced/)
  assert.match(describeUncertainty(40), /Low/)
  assert.match(describeUncertainty(90), /Moderate/)
  assert.match(describeUncertainty(130), /High/)
})

test('walk-forward helper formats compact manifest metrics', () => {
  const description = formatWalkForwardMetrics({
    target: 'published-game',
    modelVersion: 'transparent-gpr-v-test',
    modelConfigHash: 'fnv1a-test',
    predictionCount: 1234,
    accuracy: 0.6123,
    brierScore: 0.2379,
    logLoss: 0.6684,
    calibration: [],
    segments: [],
    baselineComparisons: [
      {
        key: 'pregame-win-rate',
        label: 'Pre-game win rate',
        description: 'Uses each team cumulative pre-game record.',
        predictionCount: 1234,
        accuracy: 0.5,
        brierScore: 0.25,
        logLoss: 0.6931,
        publishedAccuracyDelta: 0.1123,
        publishedBrierDelta: 0.0121,
        publishedLogLossDelta: 0.0247,
        segments: [],
      },
    ],
    playerRatingShadow: {
      enabled: false,
      predictionCount: 1234,
      accuracy: 0.6123,
      brierScore: 0.238,
      logLoss: 0.668,
      brierDelta: 0,
      logLossDelta: 0,
      rosterChangeBrierDelta: 0,
      patchTransitionBrierDelta: 0,
    },
    executionResidualShadow: {
      enabled: false,
      predictionCount: 1234,
      accuracy: 0.6123,
      brierScore: 0.238,
      logLoss: 0.668,
      brierDelta: 0,
      logLossDelta: 0,
      crossRegionBrierDelta: 0,
      patchTransitionBrierDelta: 0,
    },
  })

  assert.match(description, /1,234 published game-level predictions/)
  assert.match(description, /61.2% accuracy/)
  assert.match(description, /Brier 0.238/)
  assert.match(description, /log loss 0.668/)
  assert.match(description, /\+0.012 Brier vs pre-game win rate/)
})

test('walk-forward helper tolerates metrics without baseline comparisons', () => {
  const description = formatWalkForwardMetrics({
    target: 'published-game',
    modelVersion: 'transparent-gpr-v-test',
    modelConfigHash: 'fnv1a-test',
    predictionCount: 1234,
    accuracy: 0.6123,
    brierScore: 0.2379,
    logLoss: 0.6684,
    calibration: [],
    segments: [],
    baselineComparisons: [],
    playerRatingShadow: {
      enabled: false,
      predictionCount: 1234,
      accuracy: 0.6123,
      brierScore: 0.238,
      logLoss: 0.668,
      brierDelta: 0,
      logLossDelta: 0,
      rosterChangeBrierDelta: 0,
      patchTransitionBrierDelta: 0,
    },
    executionResidualShadow: {
      enabled: false,
      predictionCount: 1234,
      accuracy: 0.6123,
      brierScore: 0.238,
      logLoss: 0.668,
      brierDelta: 0,
      logLossDelta: 0,
      crossRegionBrierDelta: 0,
      patchTransitionBrierDelta: 0,
    },
  } as Parameters<typeof formatWalkForwardMetrics>[0])

  assert.match(description, /1,234 published game-level predictions/)
  assert.doesNotMatch(description, /Brier vs pre-game win rate/)
})
