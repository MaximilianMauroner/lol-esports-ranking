import { knownTeamIdentities } from '../../src/data/teamIdentity.ts'
import type { MatchRecord, PlayerProfile, TeamProfile } from '../../src/types.ts'

export const teams: Record<string, TeamProfile> = knownTeamIdentities

export const rosters: Record<string, PlayerProfile[]> = {
  'Gen.G': [
    { id: 'kiin-gen-fixture', name: 'Kiin', team: 'Gen.G', role: 'Top' },
    { id: 'canyon-gen-fixture', name: 'Canyon', team: 'Gen.G', role: 'Jungle' },
    { id: 'chovy-gen-fixture', name: 'Chovy', team: 'Gen.G', role: 'Mid' },
    { id: 'ruler-gen-fixture', name: 'Ruler', team: 'Gen.G', role: 'Bot' },
    { id: 'duro-gen-fixture', name: 'Duro', team: 'Gen.G', role: 'Support' },
  ],
  T1: [
    { id: 'doran-t1-fixture', name: 'Doran', team: 'T1', role: 'Top' },
    { id: 'oner-t1-fixture', name: 'Oner', team: 'T1', role: 'Jungle' },
    { id: 'faker-t1-fixture', name: 'Faker', team: 'T1', role: 'Mid' },
    { id: 'gumayusi-t1-fixture', name: 'Gumayusi', team: 'T1', role: 'Bot' },
    { id: 'keria-t1-fixture', name: 'Keria', team: 'T1', role: 'Support' },
  ],
}

export const sampleMatches: MatchRecord[] = [
  seededMatch({
    id: 'fixture-seed-001',
    date: '2026-01-17',
    event: 'LCK 2026 Spring',
    region: 'LCK',
    league: 'LCK',
    teamA: 'Gen.G',
    teamB: 'T1',
    winner: 'Gen.G',
    teamAKills: 18,
    teamBKills: 12,
  }),
  seededMatch({
    id: 'fixture-seed-002',
    date: '2026-01-24',
    event: 'LCK 2026 Spring',
    region: 'LCK',
    league: 'LCK',
    teamA: 'T1',
    teamB: 'Gen.G',
    winner: 'T1',
    teamAKills: 16,
    teamBKills: 11,
  }),
  seededMatch({
    id: 'fixture-seed-003',
    date: '2026-02-01',
    event: 'LEC 2026 Winter',
    region: 'LEC',
    league: 'LEC',
    teamA: 'G2 Esports',
    teamB: 'Fnatic',
    winner: 'G2 Esports',
    teamAKills: 19,
    teamBKills: 13,
    tier: 'regional-regular',
  }),
  seededMatch({
    id: 'fixture-seed-004',
    date: '2026-05-01',
    event: 'MSI 2026',
    phase: 'Bracket',
    region: 'International',
    league: 'MSI',
    teamA: 'Gen.G',
    teamB: 'G2 Esports',
    winner: 'Gen.G',
    teamAKills: 21,
    teamBKills: 14,
    tier: 'msi-bracket',
    bestOf: 5,
  }),
  seededMatch({
    id: 'fixture-seed-005',
    date: '2026-05-02',
    event: 'MSI 2026',
    phase: 'Bracket',
    region: 'International',
    league: 'MSI',
    teamA: 'T1',
    teamB: 'Bilibili Gaming',
    winner: 'Bilibili Gaming',
    teamAKills: 13,
    teamBKills: 20,
    tier: 'msi-bracket',
    bestOf: 5,
  }),
]

function seededMatch(overrides: Partial<MatchRecord> & Pick<MatchRecord, 'id' | 'date' | 'event' | 'region' | 'league' | 'teamA' | 'teamB' | 'winner'>): MatchRecord {
  return {
    sourceProvider: 'seed',
    dataCompleteness: 'complete',
    season: Number(overrides.date.slice(0, 4)),
    phase: 'Regular season',
    patch: '26.1',
    bestOf: 1,
    tier: 'regional-regular',
    teamAKills: 15,
    teamBKills: 12,
    teamAGold: 62000,
    teamBGold: 59000,
    ...overrides,
  }
}
