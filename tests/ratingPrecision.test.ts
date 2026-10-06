import assert from 'node:assert/strict'
import test from 'node:test'
import { createRatingReplayContext, replayRatingDates } from '../src/lib/model.ts'
import { ratingComponents, ratingFromComponents } from '../src/lib/ratingCalculations.ts'
import { neutralWinProbability } from '../src/lib/winProbability.ts'
import { sampleMatches, teams } from './fixtures/rankingFixtures.ts'

test('stable and execution state retain fractional evidence from a rated series', () => {
  const match = { ...sampleMatches[0], date: '2025-01-01' }
  const context = createRatingReplayContext([match], { ...teams })
  const state = replayRatingDates({ context, replayMatches: [match] })
  assert.ok(!Number.isInteger(state.ratings.get(match.teamA)))
  assert.ok(!Number.isInteger(state.executionRatings.get(match.teamA)))
  const history = state.histories.get(match.teamA)!.at(-1)!
  assert.equal(history.baseRating, state.ratings.get(match.teamA))
})

test('probability computation responds to rating changes smaller than four-decimal formatting', () => {
  const a = { team: 'A', rating: 1500, uncertainty: 20 }
  const b = { team: 'B', rating: 1500, uncertainty: 20 }
  const first = neutralWinProbability(a, b)
  const changed = neutralWinProbability({ ...a, rating: 1500.001 }, b)
  assert.ok(changed.teamAGameWinProbability > first.teamAGameWinProbability)
  assert.ok(changed.teamAGameWinProbability < .5001)
})

test('components used for inference preserve sub-point team and roster changes', () => {
  const components = ratingComponents({ teamRating: 1500.001, leagueScore: 1500.002,
    rosterPriorOffset: .003, momentum: .004, contextAdjustment: .005, uncertainty: 20.006 })
  assert.ok(Math.abs(ratingFromComponents(components) - 1500.015) < 1e-10)
  assert.equal(components.uncertainty, 20.006)
})
