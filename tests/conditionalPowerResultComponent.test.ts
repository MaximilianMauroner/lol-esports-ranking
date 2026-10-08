import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateConditionalPowerResultComponent } from '../src/lib/conditionalPowerResultComponent'
import { legalConditionalScores } from '../src/lib/conditionalPowerPreview'
import { materializeRankingModel } from '../src/lib/model'
import { playerRatingPredictionWeight } from '../src/lib/modelConfig'
import { publishedRating } from '../src/lib/publishedRatingArtifacts'
import { processRatingSeriesForDate } from '../src/lib/ratingSeriesEngine'
import { conditionalPowerFixture, pinControlledConditionalPowerBasis } from './fixtures/conditionalPowerFixtures'

test('result component matches production stable updates and frozen-state public projection for every legal outcome', () => {
  for (const bestOf of [1, 3, 5] as const) for (const winner of ['home', 'away'] as const) {
    for (const loserWins of legalConditionalScores(bestOf)) for (const tier of ['regional-regular', 'worlds-playoffs'] as const) {
      for (const spreadMultiplier of [1, 3]) {
        const fixture = conditionalPowerFixture(bestOf, { winner, loserWins }, tier)
        fixture.basis.ratingScale.spreadMultiplier = spreadMultiplier
        const untouched = structuredClone(fixture)
        const component = evaluateConditionalPowerResultComponent(fixture)
        if (component.status !== 'partial') throw new Error(component.detail)
        assert.equal(component.status, 'partial')

        // The reference runs the actual production member path with explicit controlled stats.
        // Priors are fixed to the pinned snapshot, matching this component's declared policy.
        const production = structuredClone(fixture.basis.state)
        const edges = new Map(fixture.games.map((game) => [game.id, {
          ...fixture.playerEdges.get(game.id)!,
          teamAAdjustment: fixture.basis.state.rosterPriorOffsets.get(game.teamA)! / playerRatingPredictionWeight,
          teamBAdjustment: fixture.basis.state.rosterPriorOffsets.get(game.teamB)! / playerRatingPredictionWeight,
        }]))
        processRatingSeriesForDate({
          matches: structuredClone(fixture.games), teams: structuredClone(fixture.basis.context.teams), state: production,
          sideAdjustments: new Map(), lastDate: fixture.games[0]!.date, pregamePlayerRatingEdges: edges,
        })
        const projected = structuredClone(fixture.basis.state)
        for (const team of fixture.basis.teamNames) {
          assert.equal(production.histories.get(team)!.filter((point) => point.date === fixture.games[0]!.date && point.ratingUpdate?.teamStableDelta !== 0).length, 1)
          projected.ratings.set(team, production.ratings.get(team)!)
        }
        const before = materializeRankingModel({ context: structuredClone(fixture.basis.context), state: structuredClone(fixture.basis.state) })
        const after = materializeRankingModel({ context: structuredClone(fixture.basis.context), state: projected })
        assert.deepEqual(component.teams.map((entry) => entry.delta), fixture.basis.teamNames.map((team) =>
          publishedRating(after.standings.find((entry) => entry.team === team)!.rating, fixture.basis.ratingScale)
          - publishedRating(before.standings.find((entry) => entry.team === team)!.rating, fixture.basis.ratingScale)))
        assert.equal(component.fullDelta, 'unavailable')
        assert.match(component.assumptions.join(' '), /statistics.*unavailable.*not invented/)
        assert.deepEqual(fixture, untouched)
      }
    }
  }
})

test('result component needs no hypothetical games or future statistics and preserves all input stores', () => {
  const fixture = conditionalPowerFixture()
  const input = { series: fixture.series, outcome: fixture.outcome, now: fixture.now, basis: fixture.basis }
  const before = structuredClone(input)
  const result = evaluateConditionalPowerResultComponent(input)
  assert.equal(result.status, 'partial')
  assert.deepEqual(input, before)
  assert.equal('games' in input, false)
  assert.equal('playerEdges' in input, false)
})

test('missing pinned raw result state stays unavailable even under a fresh state pin', () => {
  const fixture = conditionalPowerFixture()
  fixture.basis.state.currentRosterContinuity.delete('Alpha')
  pinControlledConditionalPowerBasis(fixture.basis)
  const result = evaluateConditionalPowerResultComponent(fixture)
  assert.equal(result.status, 'unavailable')
  if (result.status !== 'unavailable') throw new Error('Expected unavailable')
  assert.equal(result.reason, 'missing-result-state')
})

test('result component rejects stale pins, event mismatches, illegal scores and started series without mutation', () => {
  const fixtures = [conditionalPowerFixture(), conditionalPowerFixture(), conditionalPowerFixture(), conditionalPowerFixture()]
  fixtures[0]!.basis.state.ratings.set('Alpha', 2000)
  fixtures[1]!.series.eventId = 'different-event'
  fixtures[2]!.outcome.loserWins = 3
  fixtures[3]!.series.status = 'live'
  for (const fixture of fixtures) {
    const before = structuredClone(fixture)
    assert.equal(evaluateConditionalPowerResultComponent(fixture).status, 'unavailable')
    assert.deepEqual(fixture, before)
  }
})
