import assert from 'node:assert/strict'
import test from 'node:test'
import { estimatePublicMatchup } from '../src/lib/publicMatchup.ts'
import type { RankingSummaryStanding } from '../src/lib/snapshot.ts'

test('public matchup defaults preserve game probability compatibility', () => {
  const estimate = estimatePublicMatchup(
    standing('Alpha', 1600, 40),
    standing('Beta', 1500, 40),
    { version: 'model-v1', configHash: 'hash-v1' },
  )

  assert.equal(estimate.bestOf, 1)
  assert.equal(estimate.sideAssumption, 'neutral')
  assert.equal(estimate.homeWinProbability, estimate.homeGameWinProbability)
  assert.equal(estimate.homeSeriesWinProbability, estimate.homeGameWinProbability)
  assert.equal(estimate.awaySeriesWinProbability, estimate.awayGameWinProbability)
  assert.equal(estimate.modelVersion, 'model-v1')
  assert.equal(estimate.modelConfigHash, 'hash-v1')
})

test('public matchup best-of options amplify a favorite edge', () => {
  const home = standing('Alpha', 1600, 40)
  const away = standing('Beta', 1500, 40)
  const bo1 = estimatePublicMatchup(home, away, { bestOf: 1 })
  const bo5 = estimatePublicMatchup(home, away, { bestOf: 5 })

  assert.equal(bo5.bestOf, 5)
  assert.equal(bo1.homeGameWinProbability, bo5.homeGameWinProbability)
  assert.ok(bo5.homeSeriesWinProbability > bo1.homeSeriesWinProbability)
})

test('public matchup applies explicit side assumptions as rating edge adjustments', () => {
  const home = standing('Alpha', 1500, 30)
  const away = standing('Beta', 1500, 30)
  const neutral = estimatePublicMatchup(home, away)
  const blue = estimatePublicMatchup(home, away, { sideAssumption: 'home-blue', blueSideRatingEdge: 50 })
  const red = estimatePublicMatchup(home, away, { sideAssumption: 'home-red', blueSideRatingEdge: 50 })

  assert.equal(neutral.homeGameWinProbability, 0.5)
  assert.equal(blue.homeSide, 'blue')
  assert.equal(red.homeSide, 'red')
  assert.ok(blue.homeGameWinProbability > neutral.homeGameWinProbability)
  assert.ok(red.homeGameWinProbability < neutral.homeGameWinProbability)
  assert.equal(blue.sideRatingEdge, 50)
  assert.equal(red.sideRatingEdge, -50)
})

test('public matchup uncertainty bands bracket game and series estimates', () => {
  const estimate = estimatePublicMatchup(
    standing('Alpha', 1610, 90),
    standing('Beta', 1500, 80),
    { bestOf: 5, uncertaintyBands: { sigma: 1 } },
  )

  assert.ok(estimate.uncertaintyBand)
  assert.ok(estimate.uncertaintyBand.homeGameWinProbability.lower < estimate.homeGameWinProbability)
  assert.equal(estimate.uncertaintyBand.homeGameWinProbability.estimate, estimate.homeGameWinProbability)
  assert.ok(estimate.uncertaintyBand.homeGameWinProbability.upper > estimate.homeGameWinProbability)
  assert.ok(estimate.uncertaintyBand.homeSeriesWinProbability.lower < estimate.homeSeriesWinProbability)
  assert.equal(estimate.uncertaintyBand.homeSeriesWinProbability.estimate, estimate.homeSeriesWinProbability)
  assert.ok(estimate.uncertaintyBand.homeSeriesWinProbability.upper > estimate.homeSeriesWinProbability)
  assert.equal(estimate.uncertaintyBand.awaySeriesWinProbability.estimate, estimate.awaySeriesWinProbability)
})

function standing(team: string, rating: number, uncertainty: number): RankingSummaryStanding {
  return {
    team,
    code: team.slice(0, 3).toUpperCase(),
    rating,
    uncertainty,
  } as RankingSummaryStanding
}
