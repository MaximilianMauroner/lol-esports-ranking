import assert from 'node:assert/strict'
import test from 'node:test'
import { conditionalPowerBasisProblem, evaluateConditionalPowerReplay } from '../src/lib/conditionalPowerReplay'
import { legalConditionalScores, publicConditionalPowerPreview } from '../src/lib/conditionalPowerPreview'
import { createRatingReplayContext, materializeRankingModel, replayRatingDates } from '../src/lib/model'
import { eventTrackerKey } from '../src/lib/placementResiduals'
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

test('incomplete or inconsistent pre-state evidence is unavailable instead of producing a numeric delta', () => {
  const mutations: Array<(input: ReturnType<typeof conditionalPowerFixture>) => void> = [
    (input) => { input.basis.state.processedThroughUtcDate = '2026-02-30'; input.basis.context.lastDate = '2026-02-30' },
    (input) => { input.basis.state.teamLastRatedDates.set('Alpha', 'not-a-date') },
    (input) => { input.basis.state.teamLastRatedDates.set('Alpha', '2026-10-15') },
    (input) => { input.basis.state.teamLastRatedDates.set('Alpha', '2026-06-15') },
    (input) => { input.basis.state.leagueLastRatedDates.set('LCK', '2026-02-30') },
    (input) => { input.basis.state.leagueLastRatedDates.set('LCK', '2026-10-15') },
    (input) => { input.basis.state.histories.set('Alpha', []) },
    (input) => { input.basis.state.histories.get('Alpha')![0]!.opponent = 'Unrelated opponent' },
    (input) => { input.basis.state.wins.set('Alpha', 0) },
    (input) => { input.basis.state.processedThroughUtcDateMatchIds = [] },
    (input) => { input.basis.state.processedThroughUtcDateMatchIds.push('unobserved-terminal-game') },
    (input) => { input.basis.state.previousMatch = input.basis.context.authoritativeMatches[0] },
    (input) => { input.basis.state.previousMatch = { ...input.basis.state.previousMatch!, id: 'unobserved-terminal-game' } },
    (input) => { input.basis.state.processedMatchCount -= 1 },
    (input) => { input.basis.context.authoritativeMatches = [] },
    (input) => { input.basis.context.authoritativeMatches.push({ ...input.basis.context.authoritativeMatches.at(-1)!, id: 'omitted-game-on-terminal-date' }) },
    (input) => { input.basis.context.authoritativeMatches.pop(); input.basis.state.processedMatchCount -= 1 },
    (input) => { input.basis.context.eventWeightContext.worldsEndDateByCalendarYear = new Map([[2026, '2026-09-10']]) },
    (input) => { input.basis.state.eventWeightContext = { worldsEndDateByCalendarYear: new Map([[2026, '2026-09-10']]) } },
  ]
  assert.equal(conditionalPowerBasisProblem(conditionalPowerFixture().basis), null)
  for (const mutate of mutations) {
    const input = conditionalPowerFixture()
    mutate(input)
    const original = structuredClone(input)
    const result = evaluateConditionalPowerReplay(input)
    assert.equal(result.status, 'unavailable', mutate.toString())
    assert.deepEqual(input, original)
  }
})

test('pre-state event trackers must prove the same corpus and lifecycle as the replay context', () => {
  const input = conditionalPowerFixture()
  const matches = input.basis.context.authoritativeMatches.map((match) => ({
    ...match, tier: 'worlds-main' as const, event: 'Controlled Worlds history', league: 'Worlds',
  }))
  input.basis.context = createRatingReplayContext(matches, structuredClone(input.basis.context.teams))
  input.basis.state = replayRatingDates({ context: input.basis.context, replayMatches: matches })
  assert.equal(evaluateConditionalPowerReplay(input).status, 'ready')
  const [eventId, tracker] = input.basis.state.eventTrackers.entries().next().value!
  const mutations: Array<(scenario: typeof input) => void> = [
    (scenario) => { scenario.basis.state.eventTrackers.clear() },
    (scenario) => { scenario.basis.state.eventTrackers.get(eventId)!.matches.pop() },
    (scenario) => { scenario.basis.state.eventTrackers.get(eventId)!.preEventPowers.clear() },
    (scenario) => { scenario.basis.context.tournamentLifecycles = new Map([[eventId, {
      status: 'completed', boundaryDate: tracker.endDate, ratedThroughDate: tracker.endDate,
      dataLag: false, resultCoverageComplete: true,
    }]]) },
  ]
  for (const mutate of mutations) {
    const scenario = structuredClone(input)
    mutate(scenario)
    const original = structuredClone(scenario)
    assert.equal(evaluateConditionalPowerReplay(scenario).status, 'unavailable')
    assert.deepEqual(scenario, original)
  }
})

test('completed future placement boundaries are unsupported while historical pending placement retains production parity', () => {
  const future = conditionalPowerFixture()
  future.basis.context.tournamentLifecycles = new Map([[eventTrackerKey(future.games[0]!), {
    status: 'completed', boundaryDate: future.games[0]!.date, ratedThroughDate: future.games[0]!.date,
    dataLag: false, resultCoverageComplete: true,
  }]])
  const originalFuture = structuredClone(future)
  const unavailable = evaluateConditionalPowerReplay(future)
  assert.equal(unavailable.status, 'unavailable')
  if (unavailable.status === 'unavailable') assert.equal(unavailable.reason, 'unsupported-future-placement')
  assert.deepEqual(future, originalFuture)

  const historical = conditionalPowerFixture()
  const matches = historical.basis.context.authoritativeMatches.map((match, index) => index < 3 ? match : {
    ...match, event: 'Controlled historical Worlds', league: 'Worlds', tier: 'worlds-playoffs' as const, phase: 'Finals',
    bestOf: 5, bestOfBasis: 'official' as const, officialMatchId: 'historical-worlds-final', gameNumber: index - 2,
    winner: 'Alpha',
  })
  const boundary = matches.at(-1)!.date
  const historicalEventId = eventTrackerKey(matches.at(-1)!)
  const context = createRatingReplayContext(matches, structuredClone(historical.basis.context.teams), { tournamentLifecycles: new Map([[historicalEventId, {
    status: 'completed', boundaryDate: boundary, ratedThroughDate: boundary, dataLag: false, resultCoverageComplete: true,
  }]]) })
  historical.basis.context = context
  historical.basis.state = replayRatingDates({ context, replayMatches: matches })
  assert.equal(historical.basis.state.eventTrackers.get(historicalEventId)!.applied, false)
  const originalHistorical = structuredClone(historical)
  const beforeState = structuredClone(historical.basis.state)
  const before = materializeRankingModel({ context: structuredClone(context), state: beforeState })
  assert.equal(beforeState.eventTrackers.get(historicalEventId)!.applied, true)
  assert.ok([...beforeState.leaguePlacementDeltas.values()].some((delta) => delta !== 0))
  const replayContext = structuredClone(context)
  replayContext.authoritativeMatches.push(...structuredClone(historical.games))
  replayContext.lastDate = historical.games[0]!.date
  replayContext.teamRosterBasis = rosterBasisByTeam(replayContext.authoritativeMatches)
  for (const [id, edge] of historical.playerEdges) replayContext.pregamePlayerRatingEdges.set(id, structuredClone(edge))
  const afterState = replayRatingDates({ context: replayContext, state: structuredClone(historical.basis.state), replayMatches: structuredClone(historical.games) })
  const after = materializeRankingModel({ context: replayContext, state: afterState })
  const preview = evaluateConditionalPowerReplay(historical)
  if (preview.status !== 'ready') throw new Error(preview.detail)
  for (const team of preview.teams) {
    const beforePower = publishedRating(before.standings.find((row) => row.team === team.team)!.rating, historical.basis.ratingScale)
    const afterPower = publishedRating(after.standings.find((row) => row.team === team.team)!.rating, historical.basis.ratingScale)
    assert.deepEqual(team, { team: team.team, before: beforePower, after: afterPower, delta: afterPower - beforePower })
  }
  assert.deepEqual(historical, originalHistorical)
})

test('malformed required state maps and clone errors return unavailable without throwing', () => {
  for (const field of ['ratings', 'lastRosterByTeam', 'leagueScores', 'latestRatingUpdates', 'factorCounts'] as const) {
    const input = conditionalPowerFixture()
    Reflect.deleteProperty(input.basis.state, field)
    const original = structuredClone(input)
    const result = evaluateConditionalPowerReplay(input)
    assert.equal(result.status, 'unavailable', field)
    assert.deepEqual(input, original)
  }
  const input = conditionalPowerFixture()
  Reflect.set(input.basis.state, 'ratings', () => new Map())
  assert.equal(evaluateConditionalPowerReplay(input).status, 'unavailable')
})

test('a player cannot appear in both opposing lineups in one hypothetical game', () => {
  const input = conditionalPowerFixture()
  input.games[0]!.teamBRoster = structuredClone(input.games[0]!.teamARoster)
  const original = structuredClone(input)
  const result = evaluateConditionalPowerReplay(input)
  assert.equal(result.status, 'unavailable')
  if (result.status === 'unavailable') assert.equal(result.reason, 'unsupported-scenario')
  assert.deepEqual(input, original)
})

test('future player priors require explicit valid evidence, coverage and freshness rather than production defaults', () => {
  for (const field of ['teamAEvidenceBasis', 'teamBEvidenceBasis'] as const) {
    for (const value of [undefined, 'unavailable', 'unsupported-evidence']) {
      const input = conditionalPowerFixture()
      Reflect.set(input.playerEdges.get(input.games[0]!.id)!, field, value)
      const original = structuredClone(input)
      const result = evaluateConditionalPowerReplay(input)
      assert.equal(result.status, 'unavailable', `${field}: ${value}`)
      if (result.status === 'unavailable') assert.equal(result.reason, 'missing-player-priors')
      assert.deepEqual(input, original)
    }
  }
  for (const field of ['teamACoverage', 'teamBCoverage', 'teamAFreshnessWeight', 'teamBFreshnessWeight'] as const) {
    for (const value of [undefined, NaN, -0.1, 1.1]) {
      const input = conditionalPowerFixture()
      Reflect.set(input.playerEdges.get(input.games[0]!.id)!, field, value)
      const original = structuredClone(input)
      const result = evaluateConditionalPowerReplay(input)
      assert.equal(result.status, 'unavailable', `${field}: ${value}`)
      if (result.status === 'unavailable') assert.equal(result.reason, 'missing-player-priors')
      assert.deepEqual(input, original)
    }
  }
  const input = conditionalPowerFixture()
  for (const edge of input.playerEdges.values()) {
    edge.teamAEvidenceBasis = 'prior-observed'
    edge.teamBEvidenceBasis = 'prior-observed'
    edge.teamACoverage = 0
    edge.teamBFreshnessWeight = 0
  }
  assert.equal(evaluateConditionalPowerReplay(input).status, 'ready')
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
