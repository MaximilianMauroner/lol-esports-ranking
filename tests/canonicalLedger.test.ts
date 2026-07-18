import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCanonicalLedger, affectedObservationClosure } from '../src/lib/incremental/canonicalLedger.ts'
import { canonicalContextDigests } from '../src/lib/incremental/dependencyDigests.ts'
import { reconcileCanonicalObservations } from '../src/lib/incremental/canonicalReconciler.ts'
import { matchObservation, scheduleObservation } from '../src/lib/incremental/providerLedger.ts'
import { fixedIncrementalFixture } from './fixtures/incrementalRankingFixtures.ts'

test('canonical ledger creates deterministic date hashes and prefix roots', () => {
  const fixture = fixedIncrementalFixture()
  const observations = fixture.matches.map((match) => matchObservation({
    provider: 'oracles-elixir',
    fileId: '2026.csv',
    groupHash: `group:${match.id}`,
    match,
  }))
  const canonical = reconcileCanonicalObservations({ observations, importedTeams: fixture.teams })
  const contextDigests = canonicalContextDigests({ identities: fixture.teams, profiles: fixture.teams, eventWeightContext: {}, schedules: fixture.scheduleReferences })
  const first = buildCanonicalLedger({ canonical, observations, contextDigests })
  const second = buildCanonicalLedger({ canonical, observations, contextDigests })
  assert.deepEqual(first, second)
  assert.equal(new Set(first.partitions.map((partition) => partition.prefixRoot)).size, first.partitions.length)
  assert.ok(first.rootHash)
})

test('affected closure includes related provider observations and falls back when unknowable', () => {
  const fixture = fixedIncrementalFixture()
  const oracle = matchObservation({ provider: 'oracles-elixir', fileId: 'oracle.csv', groupHash: 'oracle', match: fixture.matches[0]! })
  const leaguepedia = matchObservation({
    provider: 'leaguepedia-cargo',
    fileId: 'lp.json',
    groupHash: 'lp',
    match: { ...fixture.matches[0]!, id: 'lp-same', sourceProvider: 'leaguepedia-cargo', sourceGameId: 'lp-same' },
  })
  const observations = [oracle, leaguepedia]
  const canonical = reconcileCanonicalObservations({ observations, importedTeams: fixture.teams })
  const contextDigests = canonicalContextDigests({ identities: {}, profiles: fixture.teams, eventWeightContext: {}, schedules: [] })
  const ledger = buildCanonicalLedger({ canonical, observations, contextDigests })
  const closure = affectedObservationClosure({ previous: ledger, changedObservationIds: [leaguepedia.id], currentObservations: observations })
  assert.deepEqual(closure.observationIds, [leaguepedia.id, oracle.id].sort())
  assert.equal(closure.fallback, undefined)
  assert.equal(affectedObservationClosure({ previous: ledger, changedObservationIds: ['missing'], currentObservations: observations }).fallback?.kind, 'dependency-unknown')
})

test('duplicate natural observation IDs union all canonical groups bidirectionally', () => {
  const fixture = fixedIncrementalFixture()
  const first = matchObservation({ provider: 'oracles-elixir', fileId: 'oracle.csv', groupHash: 'first', match: fixture.matches[0]! })
  const duplicate = matchObservation({
    provider: 'oracles-elixir',
    fileId: 'oracle.csv',
    groupHash: 'second',
    match: { ...fixture.matches[0]!, event: `${fixture.matches[0]!.event} corrected` },
  })
  assert.equal(first.id, duplicate.id)
  const observations = [first, duplicate]
  const canonical = reconcileCanonicalObservations({ observations, importedTeams: fixture.teams })
  const contextDigests = canonicalContextDigests({ identities: {}, profiles: fixture.teams, eventWeightContext: {}, schedules: [] })
  const ledger = buildCanonicalLedger({ canonical, observations, contextDigests })
  const groups = ledger.observationToGroups[first.id]
  assert.ok(groups)
  assert.equal(new Set(groups).size, groups.length)
  assert.ok(groups.length >= 2)
  for (const group of groups) assert.deepEqual(ledger.groupToObservations[group], [first.id])
})

test('canonical root covers imported matches and audit indexes', () => {
  const fixture = fixedIncrementalFixture()
  const observations = fixture.matches.map((match) => matchObservation({ provider: 'oracles-elixir', fileId: '2026.csv', groupHash: `group:${match.id}`, match }))
  const canonical = reconcileCanonicalObservations({ observations, importedTeams: fixture.teams })
  const contextDigests = canonicalContextDigests({ identities: {}, profiles: fixture.teams, eventWeightContext: {}, schedules: [] })
  const baseline = buildCanonicalLedger({ canonical, observations, contextDigests })
  const withoutImportedMatch = buildCanonicalLedger({ canonical: { ...canonical, importedMatches: canonical.importedMatches.slice(1) }, observations, contextDigests })
  assert.notEqual(withoutImportedMatch.rootHash, baseline.rootHash)

  const withoutObservation = buildCanonicalLedger({ canonical, observations: observations.slice(1), contextDigests })
  assert.notEqual(withoutObservation.rootHash, baseline.rootHash)
})

test('current duplicate IDs union every influence group independent of ordering', () => {
  const event = (matchId: string, date: string, teamA: string, teamB: string) => ({
    sourceProvider: 'lol-esports-api' as const,
    matchId,
    date,
    teams: [{ name: teamA }, { name: teamB }],
    gameIds: [],
    games: [],
  })
  const relatedA = scheduleObservation('schedule.json', event('related-a', '2026-01-10', 'Gen.G', 'T1'))
  const relatedB = scheduleObservation('schedule.json', event('related-b', '2026-01-11', 'G2 Esports', 'FlyQuest'))
  const duplicateA = scheduleObservation('schedule.json', event('duplicate', '2026-01-10', 'Gen.G', 'T1'))
  const duplicateB = scheduleObservation('schedule.json', event('duplicate', '2026-01-11', 'G2 Esports', 'FlyQuest'))
  assert.equal(duplicateA.id, duplicateB.id)
  const previousObservations = [relatedA, relatedB]
  const canonical = reconcileCanonicalObservations({ observations: previousObservations, importedTeams: {} })
  const contextDigests = canonicalContextDigests({ identities: {}, profiles: {}, eventWeightContext: {}, schedules: [] })
  const previous = buildCanonicalLedger({ canonical, observations: previousObservations, contextDigests })

  for (const currentObservations of [
    [duplicateA, relatedA, duplicateB, relatedB],
    [relatedB, duplicateB, relatedA, duplicateA],
  ]) {
    const closure = affectedObservationClosure({ previous, changedObservationIds: [duplicateA.id], currentObservations })
    assert.equal(closure.fallback, undefined)
    assert.deepEqual(closure.observationIds, [duplicateA.id, relatedA.id, relatedB.id].sort())
  }
})
