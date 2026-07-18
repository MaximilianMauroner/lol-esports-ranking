import assert from 'node:assert/strict'
import test from 'node:test'
import { knownTeamIdentities } from '../src/data/teamIdentity.ts'
import { mergeCommunityMatchSources } from '../src/lib/importers/communitySources.ts'
import { reconcileCanonicalObservations } from '../src/lib/incremental/canonicalReconciler.ts'
import { matchObservation } from '../src/lib/incremental/providerLedger.ts'
import { filterPublishedRatingUniverseInput } from '../src/lib/ratingUniverse.ts'
import { deriveTeamProfilesFromMatches, mergeTeamProfiles } from '../src/lib/teamProfiles.ts'
import { fixedIncrementalFixture, mutateIncrementalFixture } from './fixtures/incrementalRankingFixtures.ts'

test('canonical observation reconciliation is deeply equal to the direct full source path', () => {
  for (const mutation of [undefined, 'append', 'same-day-series-addition', 'correction', 'deletion'] as const) {
    const fixture = mutation ? mutateIncrementalFixture(fixedIncrementalFixture(), mutation) : fixedIncrementalFixture()
    const observations = fixture.matches.map((match) => matchObservation({
      provider: 'oracles-elixir',
      fileId: '2026.csv',
      groupHash: `group:${match.id}`,
      match,
    }))
    const incremental = reconcileCanonicalObservations({ observations, importedTeams: fixture.teams })

    const importedMatches = mergeCommunityMatchSources({ oracleMatches: fixture.matches, leaguepediaMatches: [] })
    const importedTeams = mergeTeamProfiles([fixture.teams])
    const mergedTeams = importedMatches.length > 0
      ? { ...deriveTeamProfilesFromMatches(importedMatches, importedTeams), ...knownTeamIdentities }
      : {}
    const full = { ...filterPublishedRatingUniverseInput(importedMatches, mergedTeams), importedMatches }
    assert.deepEqual(incremental, full, mutation ?? 'unchanged')
  }
})

test('Oracle provider promotion preserves current precedence exactly', () => {
  const fixture = fixedIncrementalFixture()
  const source = fixture.matches[0]!
  const leaguepediaMatch = { ...source, id: 'lp-duplicate', sourceProvider: 'leaguepedia-cargo' as const, sourceGameId: 'lp-duplicate' }
  const oracle = matchObservation({ provider: 'oracles-elixir', fileId: 'oracle.csv', groupHash: 'oracle', match: source })
  const leaguepedia = matchObservation({ provider: 'leaguepedia-cargo', fileId: 'lp.json', groupHash: 'lp', match: leaguepediaMatch })
  const promoted = reconcileCanonicalObservations({ observations: [leaguepedia, oracle], importedTeams: fixture.teams })
  assert.equal(promoted.importedMatches[0]?.sourceProvider, 'oracles-elixir')
  const fallback = reconcileCanonicalObservations({ observations: [leaguepedia], importedTeams: fixture.teams })
  assert.equal(fallback.importedMatches[0]?.sourceProvider, 'leaguepedia-cargo')
})
