import assert from 'node:assert/strict'
import test from 'node:test'
import type { MatchRecord } from '../src/types.ts'
import { affectedPublicArtifacts, assertArtifactDependencyPlanMatchesSemanticChanges } from '../src/lib/incremental/artifactDependencies.ts'
import { compareSemanticArtifactMaps } from '../src/lib/incremental/semanticParity.ts'

test('semantic parity reports missing, unexpected, digest, and generation/provenance mismatches', () => {
  const report = compareSemanticArtifactMaps({
    missing: { digest: 'a' },
    digest: { digest: 'a' },
    provenance: { digest: 'same', generationId: 'g1', provenanceDigest: 'p1' },
  }, {
    unexpected: { digest: 'z' },
    digest: { digest: 'b' },
    provenance: { digest: 'same', generationId: 'g2', provenanceDigest: 'p2' },
  })
  assert.equal(report.equal, false)
  assert.deepEqual(report.mismatches.map((entry) => entry.kind).sort(), [
    'digest-mismatch',
    'generation-provenance-mismatch',
    'missing',
    'unexpected',
  ])
})

test('dependency graph covers global, season/checkpoint, team/player/tournament, match-page, rolling, and provenance changes', () => {
  const before = match({ id: 'old', sourceMatchId: 'series-1' })
  const after = { ...before, winner: 'Beta' }
  const plan = affectedPublicArtifacts({
    changes: [{ before, after, playerIds: ['player-a'], tournamentIds: ['msi'], rollingBaselineChanged: true }],
    inventory: {
      manifestPath: 'ranking-summary.json',
      playerDirectoryPath: 'entities/players.json',
      teamDirectoryPath: 'entities/teams.json',
      regionHistoryPath: 'history/regions.json',
      teamHistoryIndexPath: 'history/teams/index.json',
      tournamentMovementIndexPath: 'history/tournaments/index.json',
      matchHistoryIndexPath: 'matches/index.json',
      scopes: [{
        key: 'global',
        filter: { season: 'All', event: 'All', region: 'All' },
        rankingPath: 'scopes/global.json',
        matchCatalogPath: 'matches/global.json',
        matchPages: [
          { path: 'matches/pages/global-1.json', seriesIds: ['source-match\u00002026-01-01\u0000series-1\u0000Alpha\u0000Beta'], startUtcDate: '2026-01-01', endUtcDate: '2026-01-25' },
          { path: 'matches/pages/global-2.json', seriesIds: [], startUtcDate: '2026-01-26', endUtcDate: '2026-02-01' },
        ],
      }, {
        key: 'checkpoint',
        filter: { season: '2026', event: 'All', region: 'LCK', checkpoint: 'spring' },
        rankingPath: 'scopes/checkpoint.json',
        matchCatalogPath: 'matches/checkpoint.json',
        matchPages: [{ path: 'matches/pages/checkpoint-1.json', seriesIds: ['series-1'] }],
      }],
      teamHistoryPaths: { Alpha: ['history/team-alpha.json'], Beta: ['history/team-beta.json'] },
      playerPaths: { 'player-a': ['history/player-a.json'] },
      tournamentMovementPaths: { msi: 'history/tournaments/msi.json' },
    },
  })
  for (const path of [
    'ranking-summary.json',
    'scopes/global.json',
    'scopes/checkpoint.json',
    'history/team-alpha.json',
    'history/team-beta.json',
    'history/player-a.json',
    'history/tournaments/msi.json',
    'matches/pages/global-1.json',
    'matches/pages/global-2.json',
  ]) assert.equal(plan.logicalPaths.includes(path), true, path)
  const semanticPaths = ['ranking-summary.json', 'scopes/global.json', 'history/team-alpha.json', 'matches/pages/global-1.json']
  const previous = Object.fromEntries(semanticPaths.map((path) => [path, { digest: 'old' }]))
  const current = Object.fromEntries(semanticPaths.map((path) => [path, { digest: 'new' }]))
  const verifiedPlan = affectedPublicArtifacts({
    changes: [{ before, after }],
    inventory: {
      manifestPath: 'ranking-summary.json',
      playerDirectoryPath: 'entities/players.json',
      teamDirectoryPath: 'entities/teams.json',
      regionHistoryPath: 'history/regions.json',
      teamHistoryIndexPath: 'history/teams/index.json',
      tournamentMovementIndexPath: 'history/tournaments/index.json',
      matchHistoryIndexPath: 'matches/index.json',
      scopes: [],
      teamHistoryPaths: {},
      tournamentMovementPaths: {},
    },
    previousSemanticArtifacts: previous,
    currentSemanticArtifacts: current,
  })
  assert.deepEqual(verifiedPlan.logicalPaths, semanticPaths.toSorted())
  assert.doesNotThrow(() => assertArtifactDependencyPlanMatchesSemanticChanges(verifiedPlan, previous, current))
})

function match(overrides: Partial<MatchRecord>): MatchRecord {
  return {
    id: 'match',
    sourceProvider: 'oracles-elixir',
    sourceGameId: overrides.id ?? 'match',
    date: '2026-01-01',
    season: 2026,
    event: 'MSI 2026',
    phase: 'Bracket',
    region: 'LCK',
    league: 'LCK',
    patch: '26.1',
    bestOf: 1,
    tier: 'msi-bracket',
    teamA: 'Alpha',
    teamB: 'Beta',
    winner: 'Alpha',
    teamAKills: 10,
    teamBKills: 5,
    teamAGold: 60_000,
    teamBGold: 55_000,
    ...overrides,
  }
}
