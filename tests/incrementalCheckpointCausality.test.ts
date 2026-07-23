import assert from 'node:assert/strict'
import test from 'node:test'
import type { MatchRecord, TeamProfile } from '../src/types.ts'
import { buildCausalContextIdentity, causalInputRow } from '../src/lib/causalRecompute.ts'
import { eventWeightContextForMatches } from '../src/lib/eventWeighting.ts'
import { buildExternalCausalBundle, reconcileExternalCausalBundle, REQUIRED_EXTERNAL_CAUSAL_SURFACES } from '../src/lib/incremental/externalCausalState.ts'
import { createRatingReplayContext, replayRatingDates } from '../src/lib/model.ts'
import { buildRatingCheckpointEventContract } from '../src/lib/ratingCheckpointInventory.ts'
import { encodeRatingCheckpoint, selectSafeCheckpoint, type SafeRatingCheckpointCandidate } from '../src/lib/ratingCheckpoint.ts'

const teams: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
  Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
}

test('external causal bundle accepts append, replays corrections, and fails closed without callback proof', () => {
  const first = match('first', '2026-01-01')
  const appended = match('second', '2026-01-02')
  const prefix = [first]
  const identity = buildCausalContextIdentity({ semanticId: 'test-v1', serializableInputs: { teams } })!
  const surfaces = REQUIRED_EXTERNAL_CAUSAL_SURFACES.map((surface) => ({
    surface,
    inputs: [causalInputRow(`match:${first.id}`, first.date, first)],
    contextIdentity: identity,
  }))
  const bundle = buildExternalCausalBundle({
    prefixMatches: prefix,
    processedThroughUtcDate: first.date,
    eventWeightContext: eventWeightContextForMatches(prefix),
    surfaces,
  })
  const appendedSurfaces = REQUIRED_EXTERNAL_CAUSAL_SURFACES.map((surface) => ({
    surface,
    inputs: [
      causalInputRow(`match:${first.id}`, first.date, first),
      causalInputRow(`match:${appended.id}`, appended.date, appended),
    ],
    contextIdentity: identity,
  }))
  assert.equal(reconcileExternalCausalBundle({
    bundle,
    authoritativeMatches: [first, appended],
    eventWeightContext: eventWeightContextForMatches([first, appended]),
    surfaces: appendedSurfaces,
  }).status, 'ready')

  const corrected = { ...first, winner: 'Beta' }
  const correctedSurfaces = REQUIRED_EXTERNAL_CAUSAL_SURFACES.map((surface) => ({
    surface,
    inputs: [causalInputRow(`match:${first.id}`, first.date, corrected)],
    contextIdentity: identity,
  }))
  const correction = reconcileExternalCausalBundle({
    bundle,
    authoritativeMatches: [corrected],
    eventWeightContext: eventWeightContextForMatches([corrected]),
    surfaces: correctedSurfaces,
  })
  assert.equal(correction.status, 'replay-required')
  if (correction.status === 'replay-required') assert.equal(correction.replayFromUtcDate, first.date)

  const unproven = reconcileExternalCausalBundle({
    bundle,
    authoritativeMatches: [first, appended],
    eventWeightContext: eventWeightContextForMatches([first, appended]),
    surfaces: appendedSurfaces.map((surface) => ({ surface: surface.surface, inputs: surface.inputs })),
  })
  assert.equal(unproven.status, 'replay-required')
  if (unproven.status === 'replay-required') assert.equal(unproven.requiresFullReplay, true)
})

test('safe checkpoint selection walks back past unsafe candidates and falls back fully when proof is missing or invalid', () => {
  const candidates = [candidate([match('first', '2026-01-01')], 'one'), candidate([
    match('first', '2026-01-01'),
    match('second', '2026-01-02'),
  ], 'two')]
  const selected = selectSafeCheckpoint({
    candidates,
    changedUtcDate: '2026-01-03',
    reconcileCausalProof: (checkpoint) => checkpoint.metadata.processedThroughUtcDate === '2026-01-02'
      ? { status: 'replay-required', replayFromUtcDate: '2026-01-02', requiresFullReplay: false, reason: 'external-prefix-changed' }
      : { status: 'ready' },
  })
  assert.equal(selected.status, 'selected')
  if (selected.status === 'selected') {
    assert.equal(selected.candidateId, 'one')
    assert.deepEqual(selected.rejectedCandidateIds, ['two'])
  }
  assert.deepEqual(selectSafeCheckpoint({ candidates, changedUtcDate: '2026-01-03' }), {
    status: 'full-replay',
    reason: 'external-causal-proof-missing',
    rejectedCandidateIds: [],
  })
  const full = selectSafeCheckpoint({
    candidates,
    changedUtcDate: '2026-01-03',
    reconcileCausalProof: () => ({
      status: 'replay-required',
      replayFromUtcDate: '2026-01-01',
      requiresFullReplay: true,
      reason: 'callback-unproven',
    }),
  })
  assert.equal(full.status, 'full-replay')
})

function candidate(matches: MatchRecord[], id: string): SafeRatingCheckpointCandidate {
  const context = createRatingReplayContext(matches, structuredClone(teams))
  const state = replayRatingDates({ context, replayMatches: context.authoritativeMatches })
  const terminal = matches.at(-1)!
  const identity = {
    importerVersion: 'importer-v1',
    identityTaxonomyHash: 'taxonomy-v1',
    rawLedgerPrefixHash: `raw-${id}`,
  }
  return {
    id,
    processedThroughUtcDate: terminal.date,
    expectedIdentity: identity,
    serialized: encodeRatingCheckpoint(
      state,
      identity,
      { processedThroughUtcDate: terminal.date, processedThroughMatchId: terminal.id },
      buildRatingCheckpointEventContract(matches, context.eventWeightContext),
    ),
  }
}

function match(id: string, date: string): MatchRecord {
  return {
    id,
    sourceProvider: 'oracles-elixir',
    sourceGameId: id,
    date,
    season: 2026,
    event: 'LCK 2026',
    phase: 'Regular season',
    region: 'LCK',
    league: 'LCK',
    patch: '26.1',
    bestOf: 1,
    tier: 'regional-regular',
    teamA: 'Alpha',
    teamB: 'Beta',
    winner: 'Alpha',
    teamAKills: 10,
    teamBKills: 5,
    teamAGold: 60_000,
    teamBGold: 55_000,
  }
}
