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
