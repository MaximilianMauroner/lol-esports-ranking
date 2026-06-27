import assert from 'node:assert/strict'
import test from 'node:test'
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
