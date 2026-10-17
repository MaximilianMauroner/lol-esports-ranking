import assert from 'node:assert/strict'
import test from 'node:test'
import { importLeaguepediaSnapshot } from '../src/lib/importers/leaguepedia.ts'
import { filterPublishedRatingUniverseInput } from '../src/lib/ratingUniverse.ts'

test('LCP Wildcard playoffs do not enter the flagship LCP rating universe', () => {
  const imported = importLeaguepediaSnapshot({ matches: [{
    id: 'LCP Wildcard/2026 Season/Playoffs_Grand Final_1_1',
    date: '2026-10-13', event: 'LCP Wildcard/2026 Season/Playoffs', patch: '26.19',
    teamA: 'Essences', teamB: "Nothin'Here", winner: 'Essences',
  }] })

  assert.equal(imported.matches[0].league, 'LCP Wildcard')
  assert.deepEqual(filterPublishedRatingUniverseInput(imported.matches, imported.teams), { matches: [], teams: {} })
})

test('flagship LCP games still enter the published rating universe', () => {
  const imported = importLeaguepediaSnapshot({ matches: [{
    id: 'LCP/2026 Season/Split 3_Week 1_1_1',
    date: '2026-07-23', event: 'LCP/2026 Season/Split 3', patch: '26.14',
    teamA: 'GAM Esports', teamB: 'CTBC Flying Oyster', winner: 'GAM Esports',
  }] })

  assert.equal(filterPublishedRatingUniverseInput(imported.matches, imported.teams).matches.length, 1)
})
