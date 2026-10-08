import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateConditionalPowerReplay } from '../src/lib/conditionalPowerReplay'
import { legalConditionalScores, publicConditionalPowerPreview } from '../src/lib/conditionalPowerPreview'
import { materializeRankingModel, replayRatingDates } from '../src/lib/model'
import { publishedRating } from '../src/lib/publishedRatingArtifacts'
import { rosterBasisByTeam } from '../src/lib/rosters'
import { conditionalPowerFixture } from './fixtures/conditionalPowerFixtures'

test('conditional public points equal isolated production replay for every legal winner/score, event weight and compressed scale', () => {
  for (const bestOf of [1, 3, 5] as const) for (const winner of ['home', 'away'] as const) for (const loserWins of legalConditionalScores(bestOf)) {
    for (const tier of ['regional-regular', 'worlds-playoffs'] as const) for (const spreadMultiplier of [3.25, 0.25]) {
      const input = conditionalPowerFixture(bestOf, { winner, loserWins }, tier)
      input.basis.ratingScale = { ...input.basis.ratingScale, spreadMultiplier }
      const original = structuredClone(input)
      const before = materializeRankingModel({ context: structuredClone(input.basis.context), state: structuredClone(input.basis.state) })
      const context = structuredClone(input.basis.context)
      context.authoritativeMatches.push(...structuredClone(input.games))
      context.lastDate = input.games[0]!.date
      context.teamRosterBasis = rosterBasisByTeam(context.authoritativeMatches)
      for (const [id, edge] of input.playerEdges) context.pregamePlayerRatingEdges.set(id, structuredClone(edge))
      const state = replayRatingDates({ context, state: structuredClone(input.basis.state), replayMatches: structuredClone(input.games) })
      const after = materializeRankingModel({ context, state })
      const preview = evaluateConditionalPowerReplay(input)
      if (preview.status !== 'ready') throw new Error(preview.detail)
      for (const row of preview.teams) {
        const beforePower = publishedRating(before.standings.find((entry) => entry.team === row.team)!.rating, input.basis.ratingScale)
        const afterPower = publishedRating(after.standings.find((entry) => entry.team === row.team)!.rating, input.basis.ratingScale)
        assert.deepEqual(row, { team: row.team, before: beforePower, after: afterPower, delta: afterPower - beforePower })
        const newPoints = state.histories.get(row.team)!.slice(input.basis.state.histories.get(row.team)!.length)
        assert.equal(newPoints.filter((point) => point.ratingUpdate.updateUnit === 'series-atomic').length, 1)
        assert.ok(newPoints.slice(0, -1).every((point) => point.ratingUpdate.teamStableDelta === 0))
        assert.equal('rank' in row, false)
      }
      assert.equal(preview.hypothetical, true)
      assert.deepEqual(preview.pinnedInputs, original)
      assert.equal(preview.provenance.canonicalSeriesId, `official-match\u0000${input.series.id}`)
      assert.deepEqual(input, original)
    }
  }
})

test('preview clamps both public endpoints before subtracting, and invalidates changed inputs without a stale cache', () => {
  const input = conditionalPowerFixture()
  input.basis.ratingScale.publishedMaximum = 1850
  const preview = evaluateConditionalPowerReplay(input)
  if (preview.status !== 'ready') throw new Error(preview.detail)
  assert.equal(preview.teams[0]!.delta, 0)
  input.basis.state.ratings.set('Alpha', 1300)
  input.basis.preStateId = 'controlled-fixture/revised-state'
  const updated = evaluateConditionalPowerReplay(input)
  if (updated.status !== 'ready') throw new Error(updated.detail)
  assert.notDeepEqual(updated.teams, preview.teams)
  assert.equal(updated.provenance.preStateId, input.basis.preStateId)
  assert.equal(preview.pinnedInputs.basis!.state.ratings.get('Alpha'), 1950)
})

test('missing or unsupported inputs fail closed without changing canonical state or caller stores', () => {
  const mutations: Array<(input: ReturnType<typeof conditionalPowerFixture>) => void> = [
    (input) => { input.basis.modelConfigHash = 'other-config' },
    (input) => { input.basis.ratingScale.spreadMultiplier = 0 },
    (input) => { input.basis.state.ratings.delete('Alpha') },
    (input) => { input.basis.state.lastRosterByTeam.delete('Alpha') },
    (input) => { input.basis.state.teamLastRatedDates.delete('Alpha') },
    (input) => { input.basis.state.leagueLastSeasons.delete('LCK') },
    (input) => { input.basis.context.teamRosterBasis.delete('Alpha') },
    (input) => { input.basis.event.id = 'different-event' },
    (input) => { input.series.bestOf = 2 },
    (input) => { input.series.teams[0]!.gameWins = 1 },
    (input) => { input.outcome.loserWins = 3 },
    (input) => { input.games[0]!.teamATowers = undefined },
    (input) => { input.games[0]!.teamAGold = NaN },
    (input) => { input.games[0]!.teamARoster = undefined },
    (input) => { input.games[0]!.patch = '' },
    (input) => { input.games[0]!.bestOfBasis = 'fallback' },
    (input) => { input.games[0]!.officialMatchId = 'different-series' },
    (input) => { input.games[0]!.teamAHomeLeague = 'Unknown' },
    (input) => { input.games[0]!.sourceProvider = 'oracles-elixir' },
    (input) => { input.games[0]!.winner = 'Beta' },
    (input) => { input.playerEdges.clear() },
    (input) => { input.playerEdges.get(input.games[0]!.id)!.teamAEvidenceBasis = 'unavailable' },
    (input) => { input.series.status = 'live' },
    (input) => { input.now = Date.parse(input.series.startTime!) },
  ]
  for (const mutate of mutations) {
    const input = conditionalPowerFixture()
    mutate(input)
    const stores = { input, canonicalGames: input.basis.context.authoritativeMatches, triggerState: { acknowledged: ['prior-0'] }, artifacts: { published: 'unchanged' } }
    const original = structuredClone(stores)
    const result = evaluateConditionalPowerReplay(input)
    assert.equal(result.status, 'unavailable')
    assert.deepEqual(stores, original)
  }
  const input = conditionalPowerFixture()
  assert.equal(evaluateConditionalPowerReplay({ ...input, basis: null }).status, 'unavailable')
  assert.equal(evaluateConditionalPowerReplay({ ...input, games: null }).status, 'unavailable')
  assert.equal(evaluateConditionalPowerReplay({ ...input, playerEdges: null }).status, 'unavailable')
})

test('production replay errors and cancelled selections have no writes to input maps or provider calls', (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('provider call attempted') })
  const input = conditionalPowerFixture()
  const original = structuredClone(input)
  const rejectWrite = () => { throw new Error('canonical write attempted') }
  Object.defineProperty(input.basis.state.ratings, 'set', { value: rejectWrite, configurable: true })
  const ready = evaluateConditionalPowerReplay(input)
  assert.equal(ready.status, 'ready')
  input.outcome = { winner: 'away', loserWins: 1 }
  assert.equal(evaluateConditionalPowerReplay(input).status, 'unavailable')
  input.outcome = original.outcome
  assert.deepEqual(input, original)
  // A malformed event tracker fails inside the real replay, after cloning.
  input.basis.state.eventTrackers.set('malformed-fixture', null!)
  const invalid = structuredClone(input)
  const failed = evaluateConditionalPowerReplay(input)
  assert.equal(failed.status, 'unavailable')
  assert.deepEqual(input, invalid)
})

test('public inputs expose unavailability instead of probability-derived points', () => {
  const { series, outcome, now } = conditionalPowerFixture()
  assert.deepEqual(legalConditionalScores(1), [0])
  assert.deepEqual(legalConditionalScores(3), [0, 1])
  assert.deepEqual(legalConditionalScores(5), [0, 1, 2])
  assert.deepEqual(legalConditionalScores(2), [])
  const missing = publicConditionalPowerPreview(series, outcome, null, now)
  assert.equal(missing.reason, 'missing-public-basis')
})
