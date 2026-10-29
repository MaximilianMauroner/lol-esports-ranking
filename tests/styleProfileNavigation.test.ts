import assert from 'node:assert/strict'
import test from 'node:test'
import { initialModeFromLocation } from '../src/browser/bootstrap.ts'
import { hashForModeAndScope } from '../src/browser/navigation.ts'
import { canonicalProfileQuery, profileSelection } from '../src/browser/style/navigation.ts'
import { buildStyleProfiles } from '../src/domains/style/build.ts'
import { styleGame } from './styleProfileFixtures.ts'

const artifact = buildStyleProfiles([styleGame()], 'a'.repeat(64))

test('Profiles owns its route and normalizes checkpoints without a ranking snapshot lookup', () => {
  assert.equal(initialModeFromLocation('#profiles?scope=season:2026', '/'), 'profiles')
  assert.equal(initialModeFromLocation('', '/profiles'), 'profiles')
  assert.equal(hashForModeAndScope('profiles', 'season:2025:checkpoint:split-2'), '#profiles?scope=season%3A2025')
  assert.equal(hashForModeAndScope('rankings', 'season:2025:checkpoint:split-2'), '#rankings?scope=season%3A2025%3Acheckpoint%3Asplit-2')
})

test('selection normalization is stable, preserves valid comparisons and unknown parameters, and corrects unavailable values', () => {
  const input = new URLSearchParams({ view: 'player', scope: 'season:2026:checkpoint:split-3', pa: 'a-4|Support', pb: 'b-4|Support',
    paxis: 'killParticipation', future: 'preserved', league: 'LCK' })
  const next = canonicalProfileQuery(artifact, input)
  assert.equal(next.get('scope'), 'season:2026')
  assert.equal(next.get('future'), 'preserved')
  assert.equal(next.get('pa'), 'a-4|Support')
  assert.equal(next.get('pb'), 'b-4|Support')
  assert.equal(next.get('role'), 'Support')
  assert.equal(next.get('paxis'), 'killParticipation')
  assert.equal(canonicalProfileQuery(artifact, next).toString(), next.toString())
  const invalid = canonicalProfileQuery(artifact, new URLSearchParams({ view: 'invalid', scope: 'event:unknown', role: 'invalid',
    league: 'unknown', pa: 'missing', pb: 'b-4|Support', ta: 'missing', tb: 'a', paxis: 'unknown', taxis: 'unknown', future: 'keep' }))
  const selected = profileSelection(artifact, invalid)
  assert.equal(selected.scope, 'season:2026')
  assert.equal(selected.view, 'player')
  assert.equal(selected.role, 'Jungle')
  assert.equal(selected.pb, undefined)
  assert.equal(selected.league, '')
  assert.equal(selected.tb, undefined)
  assert.equal(invalid.get('future'), 'keep')
  assert.equal(canonicalProfileQuery(artifact, invalid).toString(), invalid.toString())
})

test('league and scope changes correct both entity options and addressed comparisons', () => {
  const q = new URLSearchParams({ view: 'team', scope: 'all', ta: 'a', tb: 'b', league: 'LCK' })
  const state = profileSelection(artifact, q)
  assert.deepEqual(state.teams.map(t => t.id), ['a'])
  assert.equal(state.ta?.id, 'a')
  assert.equal(state.tb, undefined)
  q.set('scope', 'season:2025')
  const empty = canonicalProfileQuery(artifact, q)
  assert.equal(empty.get('pa'), null)
  assert.equal(empty.get('role'), null)
  assert.equal(empty.get('ta'), null)
  assert.equal(empty.get('tb'), null)
})
