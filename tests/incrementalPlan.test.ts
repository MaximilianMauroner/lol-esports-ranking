import assert from 'node:assert/strict'
import test from 'node:test'
import { planIncrementalCrunch, type IncrementalChange } from '../src/lib/incremental/changePlanner.ts'
import { fixedIncrementalFixture } from './fixtures/incrementalRankingFixtures.ts'

const matches = fixedIncrementalFixture().matches

test('row changes rewind to the earliest old/new atomic date', () => {
  const changes: IncrementalChange[] = [
    { kind: 'canonical-row', operation: 'add', newDate: '2026-01-10' },
    { kind: 'canonical-row', operation: 'delete', oldDate: '2026-01-10' },
    { kind: 'canonical-row', operation: 'edit', oldDate: '2026-01-17', newDate: '2026-01-10' },
    { kind: 'canonical-row', operation: 'provider-promotion', oldDate: '2026-01-17', newDate: '2026-01-10' },
  ]
  for (const change of changes) {
    const plan = planIncrementalCrunch({
      matches,
      changes: [change],
    })
    assert.equal(plan.canonical.replayFrom, '2026-01-10')
    assert.equal(plan.team.replayFrom, '2026-01-10')
  }
})

test('identity, profile, home-league, alias and rating-universe changes use earliest affected evidence', () => {
  for (const dependency of ['identity', 'profile', 'home-league', 'alias'] as const) {
    const plan = planIncrementalCrunch({ matches, changes: [{ kind: 'identity-context', dependency, identities: ['Gen.G'], closureComplete: true }] })
    assert.equal(plan.canonical.replayFrom, '2026-01-10')
  }
  const universe = planIncrementalCrunch({
    matches,
    changes: [{ kind: 'rating-universe', oldDate: '2026-01-17', newDate: '2026-01-10', membershipKnown: true }],
  })
  assert.equal(universe.canonical.replayFrom, '2026-01-10')
  assert.equal(planIncrementalCrunch({
    matches,
    changes: [{ kind: 'rating-universe', membershipKnown: false }],
  }).kind, 'full-fallback')
})

test('Worlds weighting and tournament completion choose conservative boundaries', () => {
  const worlds = planIncrementalCrunch({
    matches,
    changes: [{ kind: 'worlds-context', affectedDates: ['2026-11-20', '2026-11-15'], complete: true }],
  })
  assert.equal(worlds.team.replayFrom, '2026-11-15')
  assert.equal(worlds.canonical.mode, 'reuse')

  const tournament = planIncrementalCrunch({
    matches,
    changes: [{ kind: 'tournament-context', tournamentStart: '2026-05-01', checkpointDates: ['2026-05-01', '2026-04-30', '2026-03-01'], complete: true }],
  })
  assert.equal(tournament.team.replayFrom, '2026-05-01')
  assert.equal(tournament.checkpointBefore, '2026-04-30')
})

test('metadata-only skips reducers while compatibility and ambiguity force full replay', () => {
  const unchanged = planIncrementalCrunch({ matches, changes: [] })
  assert.equal(unchanged.kind, 'no-change')
  assert.equal(unchanged.artifacts.mode, 'reuse')

  const metadata = planIncrementalCrunch({ matches, changes: [{ kind: 'metadata-only' }] })
  assert.equal(metadata.kind, 'metadata-only')
  assert.equal(metadata.team.mode, 'reuse')
  assert.equal(metadata.artifacts.mode, 'envelope-only')

  for (const dependency of ['calendar', 'model', 'config', 'pipeline', 'code', 'private-schema'] as const) {
    const change: IncrementalChange = { kind: 'compatibility', dependency, expected: 'new', actual: 'old' }
    const plan = planIncrementalCrunch({ matches, changes: [change] })
    assert.equal(plan.kind, 'full-fallback')
    assert.equal(plan.fallback?.kind, 'compatibility-hash-mismatch')
  }
  assert.equal(planIncrementalCrunch({ matches, changes: [{ kind: 'unknown', dependency: 'mystery' }] }).kind, 'full-fallback')
  assert.equal(planIncrementalCrunch({
    matches,
    changes: [{ kind: 'identity-context', dependency: 'alias', identities: ['T1'], closureComplete: false }],
  }).kind, 'full-fallback')
})

test('player dependencies are independent and pending live-edge comparison is conservative', () => {
  const player = planIncrementalCrunch({ matches, changes: [{ kind: 'player-league-strength', identities: ['T1'] }] })
  assert.equal(player.player.replayFrom, '2026-01-10')
  assert.equal(player.team.mode, 'reuse')
  const pending = planIncrementalCrunch({ matches, changes: [{ kind: 'team-player-edge', status: 'pending' }] })
  assert.equal(pending.team.replayFrom, '2026-01-10')
})

test('malformed but type-valid changes fall back instead of silently reusing reducers', () => {
  const malformed: IncrementalChange[][] = [
    [{ kind: 'canonical-row', operation: 'add', newDate: '' }],
    [{ kind: 'canonical-row', operation: 'edit', oldDate: '2026-01-10', newDate: 'tomorrow' }],
    [{ kind: 'canonical-row', operation: 'add', newDate: '2026-99-99' }],
    [{ kind: 'rating-universe', membershipKnown: true }],
    [{ kind: 'identity-context', dependency: 'alias', identities: [], closureComplete: true }],
    [{ kind: 'worlds-context', affectedDates: [], complete: true }],
    [{ kind: 'tournament-context', tournamentStart: '2026-05-01', checkpointDates: ['2026-05-01'], complete: true }],
    [{ kind: 'tournament-context', tournamentStart: 'not-a-date', checkpointDates: ['2026-04-01'], complete: true }],
    [{ kind: 'player-league-strength', identities: [] }],
    [{ kind: 'team-player-edge', status: 'changed', earliestDate: '' }],
    [{ kind: 'team-player-edge', status: 'changed', earliestDate: 'tomorrow' }],
  ]
  for (const changes of malformed) {
    assert.equal(planIncrementalCrunch({ matches, changes }).kind, 'full-fallback')
  }
})
