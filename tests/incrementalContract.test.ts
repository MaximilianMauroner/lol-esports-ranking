import assert from 'node:assert/strict'
import test from 'node:test'
import { stableHash, stableSerialize, sha256Hex } from '../src/lib/incremental/hash.ts'
import { compareCrunchOutputs } from '../src/lib/incremental/parity.ts'
import { createStaticRankingData, type StaticRankingData } from '../src/lib/snapshot.ts'
import { createPublicArtifactWritePlan } from '../src/lib/publicArtifacts/writePlan.ts'
import { runIdForArtifact } from '../src/lib/publicArtifacts/schema.ts'
import { transparentGprModelMetadata } from '../src/lib/model.ts'
import { fixedIncrementalFixture, mutateIncrementalFixture } from './fixtures/incrementalRankingFixtures.ts'

const generatedAt = '2026-07-18T00:00:00.000Z'

test('stable serialization and SHA-256 are deterministic and browser-safe', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(stableSerialize({ z: 1, a: { y: 2, x: undefined }, list: [undefined, Number.NaN] }), '{"a":{"y":2},"list":[null,null],"z":1}')
  assert.equal(stableHash({ b: 2, a: 1 }), stableHash({ a: 1, b: 2 }))
})

test('identical reference runs with identical metadata have byte-identical outputs', () => {
  const runMetadata = { generatedAt, runId: 'run_20260718000000_incremental_contract' }
  const first = createStaticRankingData({ matches: [], teams: {}, rosters: {}, runMetadata })
  const second = createStaticRankingData({ matches: [], teams: {}, rosters: {}, runMetadata })
  const firstPlan = createPublicArtifactWritePlan(first, { runMetadata })
  const secondPlan = createPublicArtifactWritePlan(second, { runMetadata })

  assert.deepEqual(compareCrunchOutputs(
    { fullSnapshot: first, publicWrites: firstPlan.writes },
    { fullSnapshot: second, publicWrites: secondPlan.writes },
  ), { equal: true })
  assert.equal(JSON.stringify(first), JSON.stringify(second))
  assert.equal(firstPlan.writes.every((write) => {
    const value = write.value as { artifactMeta?: { runId?: string } }
    return value.artifactMeta?.runId === runMetadata.runId
  }), true)
  assert.equal(JSON.stringify(first).includes('runMetadata'), false)
})

test('legacy generatedAt callers retain the existing derived run ID', () => {
  const snapshot = createStaticRankingData({ matches: [], teams: {}, rosters: {}, generatedAt })
  const plan = createPublicArtifactWritePlan(snapshot)
  const expectedRunId = runIdForArtifact({
    generatedAt,
    modelVersion: transparentGprModelMetadata.version,
    modelConfigHash: transparentGprModelMetadata.configHash,
  })
  assert.ok(plan.manifest.artifactMeta)
  assert.equal(plan.manifest.artifactMeta.runId, expectedRunId)
})

test('parity comparator reports the first sorted artifact path and byte offset', () => {
  const result = compareCrunchOutputs(
    {
      fullSnapshot: '{}\n',
      publicWrites: [
        { relativePath: 'z.json', contents: 'same' },
        { relativePath: 'a.json', contents: 'before' },
      ],
    },
    {
      fullSnapshot: '{}\n',
      publicWrites: [
        { relativePath: 'a.json', contents: 'beXore' },
        { relativePath: 'z.json', contents: 'different' },
      ],
    },
  )
  assert.deepEqual(result, {
    equal: false,
    artifact: 'public-artifact',
    path: 'a.json',
    byteOffset: 2,
    expectedByte: 102,
    actualByte: 88,
    expectedLength: 6,
    actualLength: 6,
  })
})

test('parity comparator distinguishes missing empty artifacts and rejects duplicate paths', () => {
  assert.deepEqual(compareCrunchOutputs(
    { fullSnapshot: '{}\n', publicWrites: [{ relativePath: 'empty.json', contents: '' }] },
    { fullSnapshot: '{}\n', publicWrites: [] },
  ), {
    equal: false,
    artifact: 'public-artifact',
    path: 'empty.json',
    byteOffset: 0,
    expectedLength: 0,
    actualLength: 0,
    missing: 'actual',
  })
  assert.throws(() => compareCrunchOutputs(
    {
      fullSnapshot: '{}\n',
      publicWrites: [
        { relativePath: 'duplicate.json', contents: 'first' },
        { relativePath: 'duplicate.json', contents: 'second' },
      ],
    },
    { fullSnapshot: '{}\n', publicWrites: [] },
  ), /Duplicate expected public artifact path/)
})

test('custom run metadata remains explicit after a full snapshot serialization round trip', () => {
  const fixture = fixedIncrementalFixture()
  const runMetadata = { generatedAt, runId: 'run_custom_serialized' }
  const snapshot = createStaticRankingData({
    matches: fixture.matches,
    teams: fixture.teams,
    rosters: {},
    tournamentScheduleReferences: fixture.scheduleReferences,
    runMetadata,
  })
  assert.ok(Object.keys(snapshot.tournamentMovements).length > 0)
  const reloaded = JSON.parse(JSON.stringify(snapshot)) as StaticRankingData

  assert.throws(() => createPublicArtifactWritePlan(reloaded), /Crunch runId mismatch/)
  const plan = createPublicArtifactWritePlan(reloaded, { runMetadata })
  assert.equal(plan.writes.every((write) => {
    const value = write.value as { artifactMeta?: { runId?: string } }
    return value.artifactMeta?.runId === runMetadata.runId
  }), true)
})

test('fixed mutation helpers express each Phase-1 change class without mutating the base', () => {
  const fixture = fixedIncrementalFixture()
  const append = mutateIncrementalFixture(fixture, 'append')
  assert.equal(append.matches.length, fixture.matches.length + 1)
  assert.equal(append.matches.at(-1)?.date, '2026-01-24')
  const sameDay = mutateIncrementalFixture(fixture, 'same-day-series-addition')
  assert.equal(sameDay.matches.filter((match) => match.date === '2026-01-17').length, 2)
  const correction = mutateIncrementalFixture(fixture, 'correction')
  assert.equal(correction.matches[0]?.winner, 'T1')
  assert.equal(correction.matches[0]?.teamBKills, 17)
  assert.equal(mutateIncrementalFixture(fixture, 'deletion').matches.length, fixture.matches.length - 1)
  assert.equal(mutateIncrementalFixture(fixture, 'provider-replacement').matches[0]?.sourceProvider, 'leaguepedia-cargo')
  const identity = mutateIncrementalFixture(fixture, 'identity-change')
  assert.equal(identity.teams['Gen.G'], undefined)
  assert.ok(identity.matches.some((match) => match.teamA === 'Gen.G Esports' || match.teamB === 'Gen.G Esports'))
  const completed = mutateIncrementalFixture(fixture, 'tournament-completion')
  assert.equal(completed.matches.length, fixture.matches.length)
  assert.equal(completed.scheduleReferences.length, fixture.scheduleReferences.length)
  assert.equal(completed.scheduleReferences[0]?.state, 'completed')
  assert.equal(completed.scheduleReferences[0]?.coverageEndComplete, true)
  const compatibility = mutateIncrementalFixture(fixture, 'compatibility-change')
  assert.equal(compatibility.compatibility.modelVersion, 'fixture-model-v2')
  assert.equal(compatibility.compatibility.calendarVersion, fixture.compatibility.calendarVersion)
  assert.equal(fixture.matches.length, 3)
  assert.equal(fixture.scheduleReferences[0]?.state, 'inProgress')
  assert.equal(fixture.compatibility.modelVersion, 'fixture-model-v1')
})
