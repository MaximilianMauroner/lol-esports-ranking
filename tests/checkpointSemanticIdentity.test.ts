import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { canonicalJsonFor, canonicalJsonIdentity } from '../scripts/public-artifact-storage.mjs'
import { prepareStateCheckpoint, stateCheckpointIdentityFor, type StateCompatibility } from '../scripts/incremental-state-storage.mjs'

const compatibility: StateCompatibility = {
  modelVersion: 'test-model', modelConfigHash: 'test-config', importerVersion: 'test-importer',
  taxonomyVersion: 'test-taxonomy', ratingCheckpointSchemaVersion: 1,
  causalPrefixSchemaVersion: 1, publicArtifactSchemaVersion: 1,
}

function checkpoint() {
  return {
    boundary: { date: '2026-01-01', matchId: 'match-1' },
    rawPrefix: { matchCount: 1, digest: 'a'.repeat(64) },
    ratingCheckpoint: { teams: [{ id: 'team-😀', rating: 1.25 }], nullable: [undefined, null] },
    causalSummaries: { sourcedPlayer: {}, dssTeam: {}, dssRegion: {}, rosterEra: {}, playerResume: {} },
  }
}

test('streamed identity matches the existing stored canonical bytes across flush and UTF-16 boundaries', () => {
  const values: unknown[] = [
    null, undefined, [undefined, null, -0], Array(2),
    { '\ue000': 1, '😀': 2, '\ud800': '\udfff', omitted: undefined, date: new Date(0) },
    Array.from({ length: 2_000 }, (_, index) => ({ index, value: '😀\ud800'.repeat(20) })),
  ]
  for (const value of values) {
    const encoded = Buffer.from(canonicalJsonFor(value))
    assert.deepEqual(canonicalJsonIdentity(value), {
      sha256: createHash('sha256').update(encoded).digest('hex'), bytes: encoded.byteLength,
    })
  }
  assert.throws(() => canonicalJsonIdentity(1n), /BigInt/)
  for (const value of [NaN, Infinity, -Infinity, { value: Infinity }]) {
    assert.throws(() => canonicalJsonIdentity(value), /non-finite/)
  }
})

test('inline and retained legacy references identify the same actual persisted checkpoint', () => {
  const inline = checkpoint()
  const { candidate, prepared } = prepareStateCheckpoint(inline, compatibility)
  assert.ok(prepared)
  const expected = stateCheckpointIdentityFor(inline, compatibility)
  assert.equal(expected.object.sha256, prepared.digest)
  assert.equal(expected.object.bytes, prepared.bytes)
  const compact = { boundary: candidate.boundary, rawPrefix: candidate.rawPrefix, storedObjectReference: candidate.object }
  assert.deepEqual(stateCheckpointIdentityFor(compact, compatibility), expected)
  assert.deepEqual(stateCheckpointIdentityFor({ ...compact, storedObjectReference: {
    ...candidate.object, key: 'state/legacy/checkpoint.json', compressedBytes: prepared.compressedBytes + 10,
  } }, compatibility), expected)
})

test('semantic comparison retains body, boundary, raw-prefix, compatibility and reference-size distinctions', () => {
  const inline = checkpoint()
  const original = stateCheckpointIdentityFor(inline, compatibility)
  for (const changed of [
    { ...inline, ratingCheckpoint: { ...inline.ratingCheckpoint, changedRating: 10 } },
    { ...inline, causalSummaries: { ...inline.causalSummaries, rosterEra: { changed: true } } },
    { ...inline, boundary: { ...inline.boundary, matchId: 'different-match' } },
    { ...inline, rawPrefix: { ...inline.rawPrefix, digest: 'b'.repeat(64) } },
  ]) assert.notDeepEqual(stateCheckpointIdentityFor(changed, compatibility), original)
  assert.notDeepEqual(stateCheckpointIdentityFor(inline, { ...compatibility, modelConfigHash: 'different-config' }), original)
  const { candidate } = prepareStateCheckpoint(inline, compatibility)
  const compact = { boundary: candidate.boundary, rawPrefix: candidate.rawPrefix, storedObjectReference: candidate.object }
  for (const object of [
    { ...candidate.object, sha256: 'b'.repeat(64) },
    { ...candidate.object, bytes: candidate.object.bytes + 1 },
  ]) assert.notDeepEqual(stateCheckpointIdentityFor({ ...compact, storedObjectReference: object }, compatibility), original)
  assert.throws(() => stateCheckpointIdentityFor({ ...compact, storedObjectReference: { ...candidate.object, bytes: 0 } }, compatibility), /byte sizes/)
  assert.throws(() => stateCheckpointIdentityFor({ ...inline, compatibility: { ...compatibility, modelConfigHash: 'mismatch' } }, compatibility), /compatibility differs/)
  assert.throws(() => stateCheckpointIdentityFor({ ...inline, ratingCheckpoint: { invalidRating: Infinity } }, compatibility), /non-finite/)
})
