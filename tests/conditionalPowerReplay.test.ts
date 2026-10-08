import assert from 'node:assert/strict'
import test from 'node:test'
import { conditionalPowerBasisProblem, evaluateConditionalPowerReplay } from '../src/lib/conditionalPowerReplay'
import { prepareConditionalPowerReplayBasis } from '../src/lib/conditionalPowerReplayBasis'
import { legalConditionalScores, publicConditionalPowerPreview } from '../src/lib/conditionalPowerPreview'
import { createRatingReplayContext, materializeRankingModel, replayRatingDates } from '../src/lib/model'
import { eventTrackerKey } from '../src/lib/placementResiduals'
import { playerModelParameters } from '../src/lib/playerModel'
import { publishedRating } from '../src/lib/publishedRatingArtifacts'
import { rosterBasisByTeam } from '../src/lib/rosters'
import { resolveCanonicalSeries } from '../src/lib/seriesResolver'
import { conditionalPowerFixture, pinControlledConditionalPowerBasis } from './fixtures/conditionalPowerFixtures'

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
  assert.equal(evaluateConditionalPowerReplay(input).status, 'unavailable')
  pinControlledConditionalPowerBasis(input.basis)
  const updated = evaluateConditionalPowerReplay(input)
  if (updated.status !== 'ready') throw new Error(updated.detail)
  assert.notDeepEqual(updated.teams, preview.teams)
  assert.equal(updated.provenance.preStateId, input.basis.preStateId)
  assert.equal(preview.pinnedInputs.basis!.state.ratings.get('Alpha'), 1950)
})

test('finite state edits require a new payload pin before a conditional replay can run', () => {
  const mutations: Array<(input: ReturnType<typeof conditionalPowerFixture>) => void> = [
    (input) => { input.basis.state.ratings.set('Alpha', 1800) },
    (input) => { input.basis.state.leagueScores.set('LCK', 1650) },
    (input) => { input.basis.state.uncertainties.set('Alpha', 90) },
    (input) => { input.basis.state.momentums.set('Alpha', 75) },
    (input) => { input.basis.state.rosterPriorOffsets.set('Alpha', 3) },
    (input) => { input.basis.state.executionRatings.set('Alpha', 1800) },
  ]
  for (const mutate of mutations) {
    const input = conditionalPowerFixture()
    const originalPin = input.basis.preStateId
    mutate(input)
    const changed = structuredClone(input)
    const result = evaluateConditionalPowerReplay(input)
    assert.equal(result.status, 'unavailable')
    if (result.status === 'unavailable') assert.equal(result.reason, 'stale-pre-state-pin')
    assert.deepEqual(input, changed)
    pinControlledConditionalPowerBasis(input.basis)
    assert.notEqual(input.basis.preStateId, originalPin)
    const repinned = evaluateConditionalPowerReplay(input)
    if (repinned.status !== 'ready') throw new Error(repinned.detail)
    assert.equal(repinned.provenance.preStateId, input.basis.preStateId)
    assert.deepEqual(repinned.pinnedInputs, input)
  }
})

function threeTeamConditionalPowerFixture() {
  const input = conditionalPowerFixture()
  const matches = structuredClone(input.basis.context.authoritativeMatches)
  for (const gameNumber of [1, 2]) {
    const game = structuredClone(matches[0]!)
    game.id = `prior-gamma-${gameNumber}`
    game.date = '2026-09-14'
    game.datetimeUtc = `2026-09-14T0${4 + gameNumber}:00:00.000Z`
    game.officialMatchId = 'historical-gamma-series'
    game.bestOf = 3
    game.gameNumber = gameNumber
    game.event = 'Controlled Gamma fixture'
    game.league = 'International'
    game.region = 'International'
    game.tier = 'minor-international'
    game.phase = 'Quarterfinals'
    game.teamA = 'Gamma'
    game.teamAHomeLeague = 'LEC'
    game.teamB = 'Alpha'
    game.teamBHomeLeague = 'LCK'
    game.winner = 'Gamma'
    game.teamARoster!.observedAt = game.date
    game.teamARoster!.players = game.teamARoster!.players.map((player) => ({ ...player, id: `fixture-Gamma-${player.role}` }))
    game.teamBRoster = structuredClone(matches[0]!.teamARoster)
    game.teamBRoster!.observedAt = game.date
    matches.push(game)
  }
  const teams = { ...structuredClone(input.basis.context.teams), Gamma: { name: 'Gamma', code: 'GAM', region: 'LEC' as const, league: 'LEC' } }
  const prepared = prepareConditionalPowerReplayBasis({
    modelVersion: input.basis.modelVersion, modelConfigHash: input.basis.modelConfigHash, ratingScale: input.basis.ratingScale,
    sourceTeamIds: input.basis.sourceTeamIds, teamNames: input.basis.teamNames, event: input.basis.event,
    historicalMatches: matches, teams, tournamentLifecycles: new Map(), processedThroughUtcDate: '2026-09-15',
    corpusIdentity: { importerVersion: 'three-team-fixture/importer', identityTaxonomyHash: 'three-team-fixture/taxonomy', rawLedgerPrefixHash: 'three-team-fixture/prefix' },
  })
  if (prepared.status !== 'ready') throw new Error(prepared.detail)
  input.basis = prepared.basis
  return input
}

test('the full historical roster-basis map matches the producer for third teams and ignores insertion order', () => {
  const input = threeTeamConditionalPowerFixture()
  assert.equal(input.basis.context.teamRosterBasis.size, 3)
  assert.equal(input.basis.context.teamRosterBasis.get('Gamma'), 'sourced')
  const original = structuredClone(input)
  const baseline = evaluateConditionalPowerReplay(input)
  if (baseline.status !== 'ready') throw new Error(baseline.detail)
  assert.deepEqual(input, original)
  const mutations: Array<(scenario: typeof input) => void> = [
    (scenario) => { scenario.basis.context.teamRosterBasis.delete('Gamma') },
    (scenario) => { scenario.basis.context.teamRosterBasis.set('Gamma', 'assumed-continuous') },
    (scenario) => { scenario.basis.context.teamRosterBasis.set('Extra team', 'sourced') },
    (scenario) => { scenario.basis.context.teamRosterBasis.delete('Gamma'); scenario.basis.context.teamRosterBasis.set('Extra team', 'sourced') },
  ]
  for (const mutate of mutations) {
    const scenario = structuredClone(input)
    mutate(scenario)
    const changed = structuredClone(scenario)
    const result = evaluateConditionalPowerReplay(scenario)
    assert.equal(result.status, 'unavailable')
    if (result.status === 'unavailable') assert.equal(result.reason, 'roster-basis-mismatch')
    assert.equal(scenario.basis.preStateId, original.basis.preStateId)
    assert.deepEqual(scenario, changed)
  }
  const reversed = structuredClone(input)
  reversed.basis.context.teamRosterBasis = new Map([...reversed.basis.context.teamRosterBasis].reverse())
  const reverseResult = evaluateConditionalPowerReplay(reversed)
  if (reverseResult.status !== 'ready') throw new Error(reverseResult.detail)
  assert.deepEqual(reverseResult.teams, baseline.teams)

  // An observed partial third-team roster retains the production classification instead of becoming sourced.
  const partial = structuredClone(input)
  for (const game of partial.basis.context.authoritativeMatches) if (game.teamA === 'Gamma') {
    game.teamARoster!.completeness = 'partial'
    game.teamARoster!.players = game.teamARoster!.players.slice(0, 4)
  }
  const context = createRatingReplayContext(partial.basis.context.authoritativeMatches, partial.basis.context.teams)
  partial.basis.context = context
  partial.basis.state = replayRatingDates({ context, replayMatches: context.authoritativeMatches })
  pinControlledConditionalPowerBasis(partial.basis)
  assert.equal(context.teamRosterBasis.get('Gamma'), 'assumed-continuous')
  const originalPartial = structuredClone(partial)
  assert.equal(evaluateConditionalPowerReplay(partial).status, 'ready')
  assert.deepEqual(partial, originalPartial)
})

test('fresh pins cannot hide missing scoring state for any historical team or home league', () => {
  const input = threeTeamConditionalPowerFixture()
  const original = structuredClone(input)
  assert.equal(evaluateConditionalPowerReplay(input).status, 'ready')
  const teamFields = ['ratings', 'executionRatings', 'previousDisplayRatings', 'rosterPriorOffsets', 'momentums',
    'uncertainties', 'wins', 'losses', 'factorCounts', 'teamLastSeasons', 'teamLastRatedDates', 'histories', 'forms',
    'factorSums', 'latestRatingUpdates', 'lastPatchByTeam', 'lastRosterByTeam', 'lastRosterFingerprintByTeam'] as const
  const leagueFields = ['leagueScores', 'previousLeagueScores', 'leagueMatchCounts', 'leagueWins', 'leagueLosses',
    'leagueExpectedWins', 'leagueOpponentRatingSums', 'leagueLastSeasons', 'leagueLastRatedDates', 'leagueForms'] as const
  const omissions = [
    ...teamFields.map((field) => ({ field, entity: 'Gamma' })),
    ...leagueFields.map((field) => ({ field, entity: 'LEC' })),
  ]
  for (const { field, entity } of omissions) {
    const scenario = structuredClone(input)
    assert.equal(scenario.basis.state[field].delete(entity), true, field)
    pinControlledConditionalPowerBasis(scenario.basis)
    const changed = structuredClone(scenario)
    const result = evaluateConditionalPowerReplay(scenario)
    assert.equal(result.status, 'unavailable', `${entity}/${field}`)
    if (result.status === 'unavailable') assert.equal(result.reason, 'missing-pre-state', `${entity}/${field}`)
    assert.deepEqual(scenario, changed)
  }
  assert.deepEqual(input, original)
})

test('all historical home leagues retain scoring coverage after a team changes league', () => {
  const input = threeTeamConditionalPowerFixture()
  const prior = structuredClone(input.basis.context.authoritativeMatches.find((match) => match.teamA === 'Gamma')!)
  Object.assign(prior, { id: 'prior-gamma-lcs', date: '2026-09-13', datetimeUtc: '2026-09-13T05:00:00.000Z',
    officialMatchId: 'historical-gamma-lcs', bestOf: 1, gameNumber: 1, teamAHomeLeague: 'LCS' })
  prior.teamARoster!.observedAt = prior.date
  prior.teamBRoster!.observedAt = prior.date
  const context = createRatingReplayContext([...input.basis.context.authoritativeMatches, prior], input.basis.context.teams)
  input.basis.context = context
  input.basis.state = replayRatingDates({ context, replayMatches: context.authoritativeMatches })
  pinControlledConditionalPowerBasis(input.basis)
  assert.equal(input.basis.context.teams.Gamma!.league, 'LEC')
  const original = structuredClone(input)
  assert.equal(evaluateConditionalPowerReplay(input).status, 'ready')
  for (const field of ['leagueScores', 'leagueLastSeasons', 'leagueLastRatedDates', 'leagueForms'] as const) {
    const scenario = structuredClone(input)
    assert.equal(scenario.basis.state[field].delete('LCS'), true)
    pinControlledConditionalPowerBasis(scenario.basis)
    const changed = structuredClone(scenario)
    const result = evaluateConditionalPowerReplay(scenario)
    assert.equal(result.status, 'unavailable', field)
    if (result.status === 'unavailable') assert.equal(result.reason, 'missing-pre-state', field)
    assert.deepEqual(scenario, changed)
  }
  assert.deepEqual(input, original)
})

test('producer-absent optional context and an unobserved third team remain supported', () => {
  const input = threeTeamConditionalPowerFixture()
  for (const game of input.basis.context.authoritativeMatches) if (game.teamA === 'Gamma') {
    delete game.teamARoster
    game.patch = ''
  }
  const teams = { ...input.basis.context.teams, Delta: { name: 'Delta', code: 'DEL', region: 'LEC' as const, league: 'LEC' } }
  const context = createRatingReplayContext(input.basis.context.authoritativeMatches, teams)
  input.basis.context = context
  input.basis.state = replayRatingDates({ context, replayMatches: context.authoritativeMatches })
  pinControlledConditionalPowerBasis(input.basis)
  assert.equal(context.teamRosterBasis.has('Gamma'), false)
  for (const field of ['lastPatchByTeam', 'teamLastSplits', 'lastRosterByTeam', 'lastRosterFingerprintByTeam', 'currentRosterContinuity'] as const) {
    assert.equal(input.basis.state[field].has('Gamma'), false, field)
  }
  assert.equal(input.basis.state.teamLastRatedDates.has('Delta'), false)
  const original = structuredClone(input)
  assert.equal(evaluateConditionalPowerReplay(input).status, 'ready')
  assert.deepEqual(input, original)
})

test('direct bases validate historical UTC timestamps without rewriting or re-pinning state', () => {
  const input = threeTeamConditionalPowerFixture()
  assert.ok(input.basis.context.authoritativeMatches.some((match) => match.datetimeUtc === undefined))
  const original = structuredClone(input)
  assert.equal(evaluateConditionalPowerReplay(input).status, 'ready')
  const variants = [
    { timestamp: '', reason: 'invalid-historical-timestamp' },
    { timestamp: 'invalid timestamp', reason: 'invalid-historical-timestamp' },
    { timestamp: '2026-09-30T05:00:00.000Z', reason: 'invalid-historical-timestamp' },
    { timestamp: '2026-09-14T23:30:00-05:00', reason: 'invalid-historical-timestamp' },
    { timestamp: '2026-09-14T05:00:00Z', reason: 'historical-timestamp-normalization-required' },
    { timestamp: '2026-09-14T01:00:00-04:00', reason: 'historical-timestamp-normalization-required' },
  ]
  for (const { timestamp, reason } of variants) {
    const scenario = structuredClone(input)
    scenario.basis.context.authoritativeMatches.find((match) => match.id === 'prior-gamma-1')!.datetimeUtc = timestamp
    pinControlledConditionalPowerBasis(scenario.basis)
    const changed = structuredClone(scenario)
    const result = evaluateConditionalPowerReplay(scenario)
    assert.equal(result.status, 'unavailable', timestamp)
    if (result.status === 'unavailable') assert.equal(result.reason, reason, timestamp)
    assert.deepEqual(scenario, changed)
  }
  assert.deepEqual(input, original)
})

test('pre-state pins require structured source identities and the exact checkpoint payload digest', () => {
  const identity = { importerVersion: 'controlled-importer', identityTaxonomyHash: 'controlled-taxonomy', rawLedgerPrefixHash: 'controlled-prefix' }
  const malformed = [
    'controlled-fixture/legacy-string', '{}', '[]', 'null', '42', '"plain-string"',
    JSON.stringify({ ...identity, importerVersion: 42, payloadDigest: 'some-digest' }),
    JSON.stringify({ ...identity, identityTaxonomyHash: ' \t ', payloadDigest: 'some-digest' }),
    JSON.stringify({ ...identity, rawLedgerPrefixHash: null, payloadDigest: 'some-digest' }),
    JSON.stringify({ ...identity, payloadDigest: '' }),
    JSON.stringify({ ...identity, payloadDigest: 42 }),
  ]
  for (const pin of malformed) {
    const input = conditionalPowerFixture()
    input.basis.preStateId = pin
    const original = structuredClone(input)
    const result = evaluateConditionalPowerReplay(input)
    assert.equal(result.status, 'unavailable', pin)
    if (result.status === 'unavailable') assert.equal(result.reason, 'invalid-pre-state-pin')
    assert.deepEqual(input, original)
  }
  for (const pin of [undefined, '', ' \t ']) {
    const input = conditionalPowerFixture()
    Reflect.set(input.basis, 'preStateId', pin)
    const original = structuredClone(input)
    assert.equal(evaluateConditionalPowerReplay(input).status, 'unavailable')
    assert.deepEqual(input, original)
  }
  const input = conditionalPowerFixture()
  input.basis.preStateId = JSON.stringify({ ...identity, payloadDigest: 'fnv1a64-0000000000000000' })
  const original = structuredClone(input)
  const result = evaluateConditionalPowerReplay(input)
  assert.equal(result.status, 'unavailable')
  if (result.status === 'unavailable') assert.equal(result.reason, 'stale-pre-state-pin')
  assert.deepEqual(input, original)
})

test('offset timestamps use their UTC calendar date and preserve isolated production parity', () => {
  const utcInput = conditionalPowerFixture()
  utcInput.now = Date.parse('2026-09-17T04:00:00Z')
  utcInput.series.startTime = '2026-09-17T04:30:00Z'
  for (const [index, game] of utcInput.games.entries()) {
    game.date = '2026-09-17'
    game.datetimeUtc = `2026-09-17T04:${35 + index * 5}:00Z`
    game.teamARoster!.observedAt = game.date
    game.teamBRoster!.observedAt = game.date
  }
  const before = materializeRankingModel({ context: structuredClone(utcInput.basis.context), state: structuredClone(utcInput.basis.state) })
  const replayContext = structuredClone(utcInput.basis.context)
  replayContext.authoritativeMatches.push(...structuredClone(utcInput.games))
  replayContext.lastDate = utcInput.games[0]!.date
  replayContext.teamRosterBasis = rosterBasisByTeam(replayContext.authoritativeMatches)
  for (const [id, edge] of utcInput.playerEdges) replayContext.pregamePlayerRatingEdges.set(id, structuredClone(edge))
  const state = replayRatingDates({ context: replayContext, state: structuredClone(utcInput.basis.state), replayMatches: structuredClone(utcInput.games) })
  const after = materializeRankingModel({ context: replayContext, state })
  const expectedTeams = utcInput.basis.teamNames.map((team) => {
    const beforePower = publishedRating(before.standings.find((row) => row.team === team)!.rating, utcInput.basis.ratingScale)
    const afterPower = publishedRating(after.standings.find((row) => row.team === team)!.rating, utcInput.basis.ratingScale)
    return { team, before: beforePower, after: afterPower, delta: afterPower - beforePower }
  })
  const variants = [
    { start: '2026-09-17T04:30:00Z', gamePrefix: '2026-09-17T04:', offset: 'Z' },
    { start: '2026-09-16T23:30:00-05:00', gamePrefix: '2026-09-16T23:', offset: '-05:00' },
    { start: '2026-09-17T04:30:00+00:00', gamePrefix: '2026-09-17T04:', offset: '+00:00' },
    { start: '2026-09-17T06:30:00+02:00', gamePrefix: '2026-09-17T06:', offset: '+02:00' },
  ]
  for (const variant of variants) {
    const input = structuredClone(utcInput)
    input.series.startTime = variant.start
    for (const [index, game] of input.games.entries()) game.datetimeUtc = `${variant.gamePrefix}${35 + index * 5}:00${variant.offset}`
    const original = structuredClone(input)
    const result = evaluateConditionalPowerReplay(input)
    if (result.status !== 'ready') throw new Error(`${variant.start}: ${result.detail}`)
    assert.deepEqual(result.teams, expectedTeams)
    assert.deepEqual(input, original)
    if (variant.gamePrefix.startsWith('2026-09-16')) {
      const wrongLocalDate = structuredClone(input)
      for (const game of wrongLocalDate.games) game.date = '2026-09-16'
      const originalWrongDate = structuredClone(wrongLocalDate)
      const rejected = evaluateConditionalPowerReplay(wrongLocalDate)
      assert.equal(rejected.status, 'unavailable')
      if (rejected.status === 'unavailable') assert.equal(rejected.reason, 'unsupported-scenario')
      assert.deepEqual(wrongLocalDate, originalWrongDate)
    }
  }
  const crossesUtcDate = structuredClone(utcInput)
  crossesUtcDate.games.at(-1)!.date = '2026-09-18'
  crossesUtcDate.games.at(-1)!.datetimeUtc = '2026-09-18T04:45:00Z'
  assert.equal(evaluateConditionalPowerReplay(crossesUtcDate).status, 'unavailable')
})

test('mixed timestamp offsets preserve decisive-game player priors and pin the original inputs', () => {
  const utcInput = conditionalPowerFixture(5, { winner: 'home', loserWins: 1 })
  utcInput.now = Date.parse('2026-09-17T04:00:00Z')
  utcInput.series.startTime = '2026-09-17T04:30:00Z'
  for (const [index, game] of utcInput.games.entries()) {
    game.date = '2026-09-17'
    game.datetimeUtc = `2026-09-17T04:${35 + index * 5}:00.000Z`
    game.teamARoster!.observedAt = game.date
    game.teamBRoster!.observedAt = game.date
    const edge = utcInput.playerEdges.get(game.id)!
    edge.teamAAdjustment = [12, 7, 2, -3][index]!
    edge.teamBAdjustment = [-3, -2, 4, 12][index]!
  }
  const before = materializeRankingModel({ context: structuredClone(utcInput.basis.context), state: structuredClone(utcInput.basis.state) })
  const context = structuredClone(utcInput.basis.context)
  context.authoritativeMatches.push(...structuredClone(utcInput.games))
  context.lastDate = utcInput.games[0]!.date
  context.teamRosterBasis = rosterBasisByTeam(context.authoritativeMatches)
  for (const [id, edge] of utcInput.playerEdges) context.pregamePlayerRatingEdges.set(id, structuredClone(edge))
  const state = replayRatingDates({ context, state: structuredClone(utcInput.basis.state), replayMatches: structuredClone(utcInput.games) })
  assert.equal(state.previousMatch!.id, utcInput.games.at(-1)!.id)
  assert.equal(state.rosterPriorOffsets.get('Alpha'), -3)
  assert.equal(state.rosterPriorOffsets.get('Beta'), 12)
  const after = materializeRankingModel({ context, state })
  const expectedTeams = utcInput.basis.teamNames.map((team) => {
    const beforePower = publishedRating(before.standings.find((row) => row.team === team)!.rating, utcInput.basis.ratingScale)
    const afterPower = publishedRating(after.standings.find((row) => row.team === team)!.rating, utcInput.basis.ratingScale)
    return { team, before: beforePower, after: afterPower, delta: afterPower - beforePower }
  })
  const mixed = structuredClone(utcInput)
  mixed.series.startTime = '2026-09-16T23:30:00-05:00'
  const originalTimestamps = [
    '2026-09-17T06:35:00+02:00', '2026-09-16T23:40:00-05:00',
    '2026-09-17T04:45:00.000Z', '2026-09-17T04:50:00.000Z',
  ]
  for (const [index, game] of mixed.games.entries()) game.datetimeUtc = originalTimestamps[index]!
  const original = structuredClone(mixed)
  for (const input of [utcInput, mixed]) {
    const result = evaluateConditionalPowerReplay(input)
    if (result.status !== 'ready') throw new Error(result.detail)
    assert.deepEqual(result.teams, expectedTeams)
    assert.deepEqual(result.pinnedInputs, input)
    if (input === mixed) assert.deepEqual(result.pinnedInputs.games!.map((game) => game.datetimeUtc), originalTimestamps)
  }
  assert.deepEqual(mixed, original)
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

test('conditional replay requires identified series, games and pinned event metadata without fallback provenance', () => {
  type Fixture = ReturnType<typeof conditionalPowerFixture>
  const cases: Array<{ label: string; reason: string; mutate: (input: Fixture, value: string | undefined) => void }> = [
    { label: 'series identity', reason: 'missing-series-identity', mutate: (input, value) => {
      Reflect.set(input.series, 'id', value)
      for (const game of input.games) game.officialMatchId = value
    } },
    { label: 'event identity', reason: 'missing-series-identity', mutate: (input, value) => {
      Reflect.set(input.series, 'eventId', value)
      Reflect.set(input.basis.event, 'id', value)
      for (const game of input.games) game.officialEventId = value
    } },
    { label: 'pinned event identity', reason: 'missing-event-context', mutate: (input, value) => { Reflect.set(input.basis.event, 'id', value) } },
    { label: 'event name', reason: 'missing-event-context', mutate: (input, value) => {
      Reflect.set(input.basis.event, 'name', value)
      for (const game of input.games) Reflect.set(game, 'event', value)
    } },
    { label: 'event phase', reason: 'missing-event-context', mutate: (input, value) => {
      Reflect.set(input.basis.event, 'phase', value)
      for (const game of input.games) Reflect.set(game, 'phase', value)
    } },
    { label: 'event league', reason: 'missing-event-context', mutate: (input, value) => {
      Reflect.set(input.basis.event, 'league', value)
      for (const game of input.games) Reflect.set(game, 'league', value)
    } },
    { label: 'game identity with matching prior key', reason: 'missing-game-identity', mutate: (input, value) => {
      const game = input.games[0]!
      const edge = input.playerEdges.get(game.id)!
      input.playerEdges.delete(game.id)
      // Corrupt the required runtime ID and keep its prior keyed identically to exercise the old bypass.
      Reflect.set(game, 'id', value)
      input.playerEdges.set(game.id, edge)
    } },
  ]
  for (const { label, reason, mutate } of cases) for (const value of ['', undefined, ' \t\n ']) {
    const input = conditionalPowerFixture()
    mutate(input, value)
    const original = structuredClone(input)
    const result = evaluateConditionalPowerReplay(input)
    assert.equal(result.status, 'unavailable', `${label}: ${value}`)
    if (result.status === 'unavailable') assert.equal(result.reason, reason, label)
    assert.deepEqual(input, original)
  }
  for (const officialGameId of ['', ' \t\n ']) {
    const input = conditionalPowerFixture()
    input.games[0]!.officialGameId = officialGameId
    const result = evaluateConditionalPowerReplay(input)
    assert.equal(result.status, 'unavailable')
    if (result.status === 'unavailable') assert.equal(result.reason, 'missing-game-identity')
  }
  for (const tier of ['', undefined, ' \t\n ', 'unsupported-tier', '__proto__']) {
    const input = conditionalPowerFixture()
    Reflect.set(input.basis.event, 'tier', tier)
    for (const game of input.games) Reflect.set(game, 'tier', tier)
    const result = evaluateConditionalPowerReplay(input)
    assert.equal(result.status, 'unavailable')
    if (result.status === 'unavailable') assert.equal(result.reason, 'missing-event-context')
  }
})

test('hypothetical game and series identities cannot alias the historical prefix', () => {
  type Fixture = ReturnType<typeof conditionalPowerFixture>
  const renameGame = (input: Fixture, id: string) => {
    const game = input.games[0]!
    const edge = input.playerEdges.get(game.id)!
    input.playerEdges.delete(game.id)
    game.id = id
    input.playerEdges.set(id, edge)
  }
  const renameSeries = (input: Fixture, id: string) => {
    input.series.id = id
    for (const game of input.games) game.officialMatchId = id
  }
  const cases: Array<{
    label: string; reason: string; seedHistory?: (game: Fixture['games'][number]) => void
    mutate: (input: Fixture) => void
  }> = [
    { label: 'raw game ID', reason: 'reused-game-identity', mutate: (input) => renameGame(input, 'prior-0') },
    { label: 'official game ID aliases a raw ID', reason: 'reused-game-identity', mutate: (input) => { input.games[0]!.officialGameId = 'prior-0' } },
    { label: 'source game ID aliases a raw ID', reason: 'reused-game-identity', mutate: (input) => { input.games[0]!.sourceGameId = 'prior-0' } },
    { label: 'raw game ID aliases a source ID', reason: 'reused-game-identity', seedHistory: (game) => { game.sourceGameId = 'historical-source-game' },
      mutate: (input) => renameGame(input, 'historical-source-game') },
    { label: 'source game ID aliases an official ID', reason: 'reused-game-identity', seedHistory: (game) => { game.officialGameId = 'historical-official-game' },
      mutate: (input) => { input.games[0]!.sourceGameId = 'historical-official-game' } },
    { label: 'official series ID', reason: 'reused-series-identity', seedHistory: (game) => { game.officialMatchId = 'historical-official-series' },
      mutate: (input) => renameSeries(input, 'historical-official-series') },
    { label: 'raw source series ID', reason: 'reused-series-identity', seedHistory: (game) => { game.sourceMatchId = 'historical-source-series_game1' },
      mutate: (input) => renameSeries(input, 'historical-source-series_game1') },
    { label: 'resolved source series alias', reason: 'reused-series-identity', seedHistory: (game) => { game.sourceMatchId = 'historical-source-series_game1' },
      mutate: (input) => renameSeries(input, 'historical-source-series') },
    { label: 'resolved source-game series alias', reason: 'reused-series-identity', seedHistory: (game) => { game.sourceGameId = 'historical-source-series_game1' },
      mutate: (input) => renameSeries(input, 'historical-source-series') },
    { label: 'canonical source series ID', reason: 'reused-series-identity', seedHistory: (game) => { game.sourceMatchId = 'historical-source-series_game1' },
      mutate: (input) => renameSeries(input, resolveCanonicalSeries([input.basis.context.authoritativeMatches[0]!])[0]!.id) },
    { label: 'canonical fallback series ID', reason: 'reused-series-identity',
      mutate: (input) => renameSeries(input, resolveCanonicalSeries([input.basis.context.authoritativeMatches[0]!])[0]!.id) },
    { label: 'scenario source series alias', reason: 'reused-series-identity', seedHistory: (game) => { game.sourceMatchId = 'historical-source-series' },
      mutate: (input) => { input.games[0]!.sourceMatchId = 'historical-source-series' } },
    { label: 'different source-match suffix hidden by future official ID', reason: 'reused-series-identity',
      seedHistory: (game) => { game.sourceMatchId = 'historical-source-series_game1' },
      mutate: (input) => { input.games[0]!.sourceMatchId = 'historical-source-series_game2' } },
    { label: 'different source-match suffix hidden by both official IDs', reason: 'reused-series-identity',
      seedHistory: (game) => { game.sourceMatchId = 'historical-source-series_game1'; game.officialMatchId = 'higher-priority-history-series' },
      mutate: (input) => { input.games[0]!.sourceMatchId = 'historical-source-series_game2' } },
    { label: 'different source-game suffix hidden by source-match IDs', reason: 'reused-series-identity',
      seedHistory: (game) => { game.sourceGameId = 'historical-source-series_game1'; game.sourceMatchId = 'higher-priority-history-series_game1' },
      mutate: (input) => { input.games[0]!.sourceGameId = 'historical-source-series_game2'; input.games[0]!.sourceMatchId = 'distinct-future-source-series_game2' } },
    { label: 'different source-game suffix hidden by official and source-match IDs', reason: 'reused-series-identity',
      seedHistory: (game) => {
        game.sourceGameId = 'historical-source-series_game1'; game.sourceMatchId = 'higher-priority-history-series_game1'; game.officialMatchId = 'historical-official-series'
      },
      mutate: (input) => { input.games[0]!.sourceGameId = 'historical-source-series_game2'; input.games[0]!.sourceMatchId = 'distinct-future-source-series_game2' } },
  ]
  for (const { label, reason, seedHistory, mutate } of cases) {
    const input = conditionalPowerFixture()
    if (seedHistory) {
      seedHistory(input.basis.context.authoritativeMatches[0]!)
      const context = createRatingReplayContext(input.basis.context.authoritativeMatches, structuredClone(input.basis.context.teams))
      input.basis.context = context
      input.basis.state = replayRatingDates({ context, replayMatches: context.authoritativeMatches })
      pinControlledConditionalPowerBasis(input.basis)
    }
    assert.equal(evaluateConditionalPowerReplay(input).status, 'ready', `control: ${label}`)
    mutate(input)
    const original = structuredClone(input)
    const result = evaluateConditionalPowerReplay(input)
    assert.equal(result.status, 'unavailable', label)
    if (result.status === 'unavailable') assert.equal(result.reason, reason, label)
    assert.deepEqual(input, original)
  }
})

test('latest historical home-league evidence must be explicit and agree across a UTC date and the directory', () => {
  const mutations: Array<(input: ReturnType<typeof conditionalPowerFixture>) => void> = [
    (input) => { input.basis.context.authoritativeMatches.at(-1)!.teamAHomeLeague = undefined },
    (input) => { input.basis.context.authoritativeMatches.at(-1)!.teamBHomeLeague = undefined },
    (input) => { input.basis.context.authoritativeMatches.at(-1)!.teamAHomeLeague = '' },
    (input) => { input.basis.context.authoritativeMatches.at(-1)!.teamAHomeLeague = 'Worlds' },
    (input) => { input.basis.context.teams.Alpha!.league = 'LPL' },
    (input) => {
      const matches = input.basis.context.authoritativeMatches
      matches.push({ ...matches.at(-1)!, id: 'conflicting-latest-home-league', teamAHomeLeague: 'LPL' })
      const context = createRatingReplayContext(matches, structuredClone(input.basis.context.teams))
      input.basis.context = context
      input.basis.state = replayRatingDates({ context, replayMatches: context.authoritativeMatches })
    },
  ]
  for (const mutate of mutations) {
    const input = conditionalPowerFixture()
    mutate(input)
    const original = structuredClone(input)
    const result = evaluateConditionalPowerReplay(input)
    assert.equal(result.status, 'unavailable')
    if (result.status === 'unavailable') assert.equal(result.reason, 'missing-home-league-context')
    assert.deepEqual(input, original)
  }
})

test('event region and supplied team region overrides must match the pinned event and directory', () => {
  for (const region of [undefined, '', ' \t ', 'Unknown']) {
    const input = conditionalPowerFixture()
    Reflect.set(input.basis.event, 'region', region)
    const original = structuredClone(input)
    const result = evaluateConditionalPowerReplay(input)
    assert.equal(result.status, 'unavailable')
    if (result.status === 'unavailable') assert.equal(result.reason, 'missing-event-context')
    assert.deepEqual(input, original)
  }
  const mutations: Array<(input: ReturnType<typeof conditionalPowerFixture>) => void> = [
    (input) => { input.games[0]!.region = 'International' },
    (input) => { input.basis.event.region = 'International' },
    (input) => { input.games[0]!.teamARegion = 'LPL' },
    (input) => { input.games[0]!.teamBRegion = 'LCK' },
  ]
  for (const mutate of mutations) {
    const input = conditionalPowerFixture()
    mutate(input)
    const original = structuredClone(input)
    const result = evaluateConditionalPowerReplay(input)
    assert.equal(result.status, 'unavailable')
    if (result.status === 'unavailable') assert.equal(result.reason, 'unsupported-scenario')
    assert.deepEqual(input, original)
  }
  const input = conditionalPowerFixture()
  for (const game of input.games) {
    game.teamARegion = 'LCK'
    game.teamBRegion = 'LPL'
  }
  assert.equal(evaluateConditionalPowerReplay(input).status, 'ready')
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
  pinControlledConditionalPowerBasis(input.basis)
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
  pinControlledConditionalPowerBasis(historical.basis)
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
    edge.teamAAdjustment = 0
    edge.teamBAdjustment = 0
  }
  assert.equal(evaluateConditionalPowerReplay(input).status, 'ready')
})

test('player prior adjustments obey production caps and zero-evidence invariants on both sides', () => {
  const cap = playerModelParameters.playerPregameEdgeCap
  const minimumCoverage = playerModelParameters.playerPregameMinCoverage
  const sides = [
    ['teamAAdjustment', 'teamACoverage', 'teamAFreshnessWeight'],
    ['teamBAdjustment', 'teamBCoverage', 'teamBFreshnessWeight'],
  ] as const
  const invalid = [
    { adjustment: cap + 1, coverage: 1, freshness: 1 },
    { adjustment: -cap - 1, coverage: 1, freshness: 1 },
    { adjustment: cap, coverage: minimumCoverage - 0.01, freshness: 1 },
    { adjustment: -cap, coverage: minimumCoverage - 0.01, freshness: 1 },
    { adjustment: cap, coverage: 1, freshness: 0 },
    { adjustment: -cap, coverage: 1, freshness: 0 },
  ]
  for (const [adjustmentField, coverageField, freshnessField] of sides) for (const values of invalid) {
    const input = conditionalPowerFixture()
    const edge = input.playerEdges.get(input.games[0]!.id)!
    edge[adjustmentField] = values.adjustment
    edge[coverageField] = values.coverage
    edge[freshnessField] = values.freshness
    const original = structuredClone(input)
    const result = evaluateConditionalPowerReplay(input)
    assert.equal(result.status, 'unavailable', `${adjustmentField}: ${JSON.stringify(values)}`)
    if (result.status === 'unavailable') assert.equal(result.reason, 'missing-player-priors')
    assert.deepEqual(input, original)
  }
  const supported = [
    { adjustment: cap, coverage: minimumCoverage, freshness: 1 },
    { adjustment: -cap, coverage: minimumCoverage, freshness: 1 },
    { adjustment: 0, coverage: minimumCoverage - 0.04, freshness: 0.992 },
    { adjustment: 0, coverage: 1, freshness: 0 },
  ]
  for (const values of supported) {
    const input = conditionalPowerFixture()
    for (const edge of input.playerEdges.values()) {
      edge.teamAAdjustment = values.adjustment
      edge.teamBAdjustment = -values.adjustment
      edge.teamACoverage = edge.teamBCoverage = values.coverage
      edge.teamAFreshnessWeight = edge.teamBFreshnessWeight = values.freshness
    }
    const original = structuredClone(input)
    const result = evaluateConditionalPowerReplay(input)
    if (result.status !== 'ready') throw new Error(`${JSON.stringify(values)}: ${result.detail}`)
    assert.deepEqual(result.pinnedInputs, original)
    assert.deepEqual(input, original)
  }
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
