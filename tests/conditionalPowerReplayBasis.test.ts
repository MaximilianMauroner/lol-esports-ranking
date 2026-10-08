import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareConditionalPowerReplayBasis } from '../src/lib/conditionalPowerReplayBasis'
import { evaluateConditionalPowerReplay } from '../src/lib/conditionalPowerReplay'
import { createRatingReplayContext, materializeRankingModel, replayRatingDates } from '../src/lib/model'
import { publishedRating } from '../src/lib/publishedRatingArtifacts'
import { rosterBasisByTeam } from '../src/lib/rosters'
import { conditionalPowerFixture } from './fixtures/conditionalPowerFixtures'

function sourceFixture() {
  const input = conditionalPowerFixture()
  return {
    modelVersion: input.basis.modelVersion, modelConfigHash: input.basis.modelConfigHash,
    ratingScale: input.basis.ratingScale, sourceTeamIds: input.basis.sourceTeamIds,
    teamNames: input.basis.teamNames, event: input.basis.event,
    corpusIdentity: { importerVersion: 'controlled-importer', identityTaxonomyHash: 'controlled-taxonomy', rawLedgerPrefixHash: 'controlled-prefix' },
    processedThroughUtcDate: input.basis.state.processedThroughUtcDate!,
    historicalMatches: input.basis.context.authoritativeMatches, teams: input.basis.context.teams,
    tournamentLifecycles: input.basis.context.tournamentLifecycles,
  }
}

test('corpus adapter reconstructs a detached production pre-state and preserves isolated replay parity', (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected provider access') })
  const source = sourceFixture()
  const original = structuredClone(source)
  const prepared = prepareConditionalPowerReplayBasis(source)
  if (prepared.status !== 'ready') throw new Error(prepared.detail)
  const context = createRatingReplayContext(structuredClone(source.historicalMatches), structuredClone(source.teams), { tournamentLifecycles: structuredClone(source.tournamentLifecycles) })
  const state = replayRatingDates({ context, replayMatches: context.authoritativeMatches })
  assert.deepEqual(prepared.basis.state, state)
  assert.deepEqual(prepared.provenance.corpusIdentity, source.corpusIdentity)
  assert.ok(prepared.basis.preStateId.includes(prepared.provenance.payloadDigest))
  assert.deepEqual(prepared.provenance.historicalUnavailablePlayerPriorGameIds, ['prior-0'])
  assert.match(prepared.assumptions.join(' '), /1 historical games have unavailable pregame player priors/)

  const input = { ...conditionalPowerFixture(), basis: prepared.basis }
  const result = evaluateConditionalPowerReplay(input)
  if (result.status !== 'ready') throw new Error(result.detail)
  const before = materializeRankingModel({ context, state: structuredClone(state) })
  const futureContext = {
    ...context, authoritativeMatches: [...context.authoritativeMatches, ...input.games], lastDate: input.games[0]!.date,
    pregamePlayerRatingEdges: new Map([...context.pregamePlayerRatingEdges, ...input.playerEdges]),
    teamRosterBasis: rosterBasisByTeam([...context.authoritativeMatches, ...input.games]),
  }
  const after = materializeRankingModel({ context: futureContext, state: replayRatingDates({ context: futureContext, state: structuredClone(state), replayMatches: input.games }) })
  for (const row of result.teams) {
    const beforePower = publishedRating(before.standings.find((team) => team.team === row.team)!.rating, source.ratingScale)
    const afterPower = publishedRating(after.standings.find((team) => team.team === row.team)!.rating, source.ratingScale)
    assert.deepEqual(row, { team: row.team, before: beforePower, after: afterPower, delta: afterPower - beforePower })
  }
  prepared.basis.state.ratings.set('Alpha', 0)
  prepared.basis.context.authoritativeMatches[0]!.winner = 'Beta'
  prepared.provenance.corpusIdentity.rawLedgerPrefixHash = 'changed-copy'
  assert.deepEqual(source, original)
})

test('corpus adapter rejects absent, incomplete or future historical evidence without writes', () => {
  const mutations: Array<(source: ReturnType<typeof sourceFixture>) => void> = [
    (source) => { source.historicalMatches = [] },
    (source) => { source.processedThroughUtcDate = '2026-02-30' },
    (source) => { source.processedThroughUtcDate = '2026-09-14' },
    (source) => { source.historicalMatches.push(structuredClone(source.historicalMatches[0]!)) },
    (source) => { source.historicalMatches[0]!.teamATowers = undefined },
    (source) => { source.historicalMatches[0]!.teamARoster = undefined },
    (source) => { source.historicalMatches[0]!.teamARoster!.observedAt = 'not-a-date' },
    (source) => { source.historicalMatches[0]!.teamARoster!.observedAt = '2026-09-16' },
    (source) => { source.historicalMatches[0]!.teamBRoster = structuredClone(source.historicalMatches[0]!.teamARoster) },
    (source) => { delete source.teams.Alpha },
    (source) => { source.corpusIdentity.rawLedgerPrefixHash = '' },
    (source) => { source.modelConfigHash = 'different-config' },
    (source) => { Reflect.deleteProperty(source, 'tournamentLifecycles') },
  ]
  for (const mutate of mutations) {
    const source = sourceFixture()
    mutate(source)
    const original = structuredClone(source)
    assert.equal(prepareConditionalPowerReplayBasis(source).status, 'unavailable')
    assert.deepEqual(source, original)
  }
})

test('adapter-produced checkpoint pins reject a changed rating without caller mutation', () => {
  const source = sourceFixture()
  const originalSource = structuredClone(source)
  const prepared = prepareConditionalPowerReplayBasis(source)
  if (prepared.status !== 'ready') throw new Error(prepared.detail)
  const control = { ...conditionalPowerFixture(), basis: prepared.basis }
  assert.equal(evaluateConditionalPowerReplay(control).status, 'ready')

  const input = { ...conditionalPowerFixture(), basis: structuredClone(prepared.basis) }
  const previous = input.basis.state.ratings.get('Alpha')
  assert.ok(previous !== undefined && Number.isFinite(previous))
  input.basis.state.ratings.set('Alpha', previous + 100)
  const original = structuredClone(input)
  const result = evaluateConditionalPowerReplay(input)
  assert.equal(result.status, 'unavailable')
  if (result.status === 'unavailable') assert.equal(result.reason, 'stale-pre-state-pin')
  assert.deepEqual(input, original)
  assert.equal(input.basis.preStateId, prepared.basis.preStateId)
  assert.deepEqual(source, originalSource)
})

test('corpus adapter requires complete legal historical series before production replay', () => {
  for (const bestOf of [3, 5]) for (const bestOfBasis of ['official', 'provider'] as const) {
    const incomplete = sourceFixture()
    Object.assign(incomplete.historicalMatches.at(-1)!, { bestOf, bestOfBasis, officialMatchId: 'historical-series', gameNumber: 1 })
    const original = structuredClone(incomplete)
    const rejected = prepareConditionalPowerReplayBasis(incomplete)
    assert.equal(rejected.status, 'unavailable', `${bestOfBasis} Bo${bestOf}`)
    if (rejected.status === 'unavailable') assert.equal(rejected.reason, 'incomplete-historical-inputs')
    assert.deepEqual(incomplete, original)

    const complete = sourceFixture()
    const winsNeeded = (bestOf + 1) / 2
    complete.historicalMatches.slice(-winsNeeded).forEach((game, index) => Object.assign(game, {
      date: complete.processedThroughUtcDate, bestOf, bestOfBasis, officialMatchId: 'historical-series',
      gameNumber: index + 1, winner: 'Alpha',
    }))
    const completedOriginal = structuredClone(complete)
    assert.equal(prepareConditionalPowerReplayBasis(complete).status, 'ready', `${bestOfBasis} completed Bo${bestOf}`)
    assert.deepEqual(complete, completedOriginal)
  }

  const illegal = sourceFixture()
  illegal.historicalMatches.slice(-3).forEach((game, index) => Object.assign(game, {
    date: illegal.processedThroughUtcDate, bestOf: 3, officialMatchId: 'historical-series', gameNumber: index + 1,
    winner: index < 2 ? 'Alpha' : 'Beta',
  }))
  const original = structuredClone(illegal)
  const result = prepareConditionalPowerReplayBasis(illegal)
  assert.equal(result.status, 'unavailable', 'The series continued after Alpha had already won.')
  assert.deepEqual(illegal, original)
})
