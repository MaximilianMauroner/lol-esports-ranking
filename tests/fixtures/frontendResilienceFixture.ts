import { createStaticRankingData } from '../../src/domains/rankings/internal/projections/snapshot'
import { createPublicArtifactWritePlan } from '../../src/domains/rankings/internal/published/writePlan'
import type { MatchRecord } from '../../src/domains/rankings/types'

export function frontendResilienceFixture() {
  const matches: MatchRecord[] = [
    { id: 'draw-1', officialMatchId: 'draw', gameNumber: 1, teamA: 'T1', teamB: 'G2', winner: 'T1' },
    { id: 'draw-2', officialMatchId: 'draw', gameNumber: 2, teamA: 'T1', teamB: 'G2', winner: 'G2' },
    { id: 'domestic', officialMatchId: 'domestic', gameNumber: 1, teamA: 'T1', teamB: 'Gen.G', winner: 'T1' },
  ].map((match, index) => ({
    ...match, sourceProvider: 'seed', date: '2026-07-01',
    datetimeUtc: `2026-07-01T${String(10 + index).padStart(2, '0')}:00:00.000Z`,
    season: 2026, event: index < 2 ? 'Synthetic international draw' : 'Synthetic domestic match',
    league: index < 2 ? 'MSI' : 'LCK', region: index < 2 ? 'International' : 'LCK',
    phase: 'Regular season', patch: '', bestOf: index < 2 ? 2 : 1,
    bestOfBasis: 'provider', tier: index < 2 ? 'msi-bracket' : 'regional-regular',
    teamAKills: 10, teamBKills: 5, teamAGold: 60_000, teamBGold: 55_000,
  }))
  const data = createStaticRankingData({
    matches, teams: {
      T1: { name: 'T1', code: 'T1', league: 'LCK', region: 'LCK' },
      G2: { name: 'G2', code: 'G2', league: 'LEC', region: 'LEC' },
      'Gen.G': { name: 'Gen.G', code: 'GEN', league: 'LCK', region: 'LCK' },
    }, rosters: {}, generatedAt: '2026-07-02T00:00:00.000Z', dataMode: 'seeded-sample',
    materializeSnapshotKeys: new Set(['All__All__All']), materializeTournamentIds: new Set(),
  })
  const plan = createPublicArtifactWritePlan(data)
  const bodies = new Map(plan.writes.map((write) => [`/data/${write.relativePath}`, write.contents]))
  const pagePaths = new Set([...bodies.keys()].filter((path) => path.startsWith('/data/matches/pages/')))
  return { plan, bodies, pagePaths }
}
