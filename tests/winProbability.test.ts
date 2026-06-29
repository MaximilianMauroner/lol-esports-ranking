import assert from 'node:assert/strict'
import test from 'node:test'
import { seriesSwingStateProbability } from '../src/lib/matchupMath.ts'
import { neutralWinProbability, seriesWinProbability } from '../src/lib/winProbability.ts'

test('neutral win probability is symmetric for equal ratings', () => {
  const prediction = neutralWinProbability(
    { team: 'Alpha', rating: 1500, uncertainty: 50 },
    { team: 'Beta', rating: 1500, uncertainty: 50 },
    5,
  )

  assert.equal(prediction.teamAGameWinProbability, 0.5)
  assert.equal(prediction.teamASeriesWinProbability, 0.5)
  assert.equal(prediction.teamBSeriesWinProbability, 0.5)
})

test('uncertainty shrinks a rating edge toward fifty percent', () => {
  const lowUncertainty = neutralWinProbability(
    { team: 'Alpha', rating: 1600, uncertainty: 30 },
    { team: 'Beta', rating: 1500, uncertainty: 30 },
  )
  const highUncertainty = neutralWinProbability(
    { team: 'Alpha', rating: 1600, uncertainty: 140 },
    { team: 'Beta', rating: 1500, uncertainty: 140 },
  )

  assert.ok(lowUncertainty.teamAGameWinProbability > highUncertainty.teamAGameWinProbability)
  assert.ok(highUncertainty.teamAGameWinProbability > 0.5)
})

test('series probability amplifies a single-game edge', () => {
  assert.ok(seriesWinProbability(0.6, 5) > seriesWinProbability(0.6, 1))
})

test('series swing states price current Bo3 and Bo5 scores', () => {
  const bo3Lead = seriesSwingStateProbability({
    bestOf: 3,
    teamAWins: 1,
    teamBWins: 0,
    teamAGameWinProbability: 0.6,
  })
  const bo5Deficit = seriesSwingStateProbability({
    bestOf: 5,
    teamAWins: 1,
    teamBWins: 2,
    teamAGameWinProbability: 0.6,
  })
  const bo5Terminal = seriesSwingStateProbability({
    bestOf: 5,
    teamAWins: 3,
    teamBWins: 1,
    teamAGameWinProbability: 0.6,
  })

  assert.equal(bo3Lead.teamASeriesWinProbability, 0.84)
  assert.equal(bo5Deficit.teamASeriesWinProbability, 0.36)
  assert.equal(bo5Terminal.teamASeriesWinProbability, 1)
  assert.equal(bo5Terminal.terminal, true)
})
