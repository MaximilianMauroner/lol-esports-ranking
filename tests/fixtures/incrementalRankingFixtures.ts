import { knownTeamIdentities } from '../../src/data/teamIdentity.ts'
import type { TournamentScheduleReference } from '../../src/lib/internationalTournaments.ts'
import type { MatchRecord, TeamProfile } from '../../src/types.ts'

export type IncrementalFixture = {
  matches: MatchRecord[]
  teams: Record<string, TeamProfile>
  scheduleReferences: TournamentScheduleReference[]
  compatibility: {
    modelVersion: string
    calendarVersion: string
  }
}

export type IncrementalMutation =
  | 'append'
  | 'same-day-series-addition'
  | 'correction'
  | 'deletion'
  | 'provider-replacement'
  | 'identity-change'
  | 'tournament-completion'
  | 'compatibility-change'

export function fixedIncrementalFixture(): IncrementalFixture {
  return {
    matches: [
      fixtureMatch('incremental-001', '2026-01-10', 'Gen.G', 'T1', 'Gen.G'),
      fixtureMatch('incremental-002', '2026-01-17', 'T1', 'Gen.G', 'T1'),
      {
        ...fixtureMatch('incremental-msi-001', '2026-05-10', 'Gen.G', 'T1', 'Gen.G'),
        event: 'MSI 2026',
        league: 'MSI',
        region: 'International',
        phase: 'Bracket',
        tier: 'msi-bracket',
      },
    ],
    teams: {
      'Gen.G': { ...knownTeamIdentities['Gen.G'] },
      T1: { ...knownTeamIdentities.T1 },
    },
    scheduleReferences: [{
      matchId: 'msi-bracket-2026',
      tournamentId: 'msi-2026',
      leagueName: 'Mid-Season Invitational',
      leagueSlug: 'msi',
      startTime: '2026-05-10T12:00:00.000Z',
      date: '2026-05-10',
      state: 'inProgress',
      retrievedAt: '2026-05-10T18:00:00.000Z',
      coverageStart: '2026-05-01',
      coverageEnd: '2026-05-10',
      coverageEndComplete: false,
    }],
    compatibility: {
      modelVersion: 'fixture-model-v1',
      calendarVersion: 'fixture-calendar-v1',
    },
  }
}

export function mutateIncrementalFixture(
  input: IncrementalFixture,
  mutation: IncrementalMutation,
): IncrementalFixture {
  const fixture = cloneFixture(input)
  if (mutation === 'append') {
    fixture.matches.push(fixtureMatch('incremental-003', '2026-01-24', 'Gen.G', 'T1', 'Gen.G'))
  } else if (mutation === 'same-day-series-addition') {
    fixture.matches.push(fixtureMatch('incremental-003', '2026-01-17', 'Gen.G', 'T1', 'Gen.G'))
  } else if (mutation === 'correction') {
    fixture.matches[0] = { ...fixture.matches[0], winner: 'T1', teamAKills: 11, teamBKills: 17 }
  } else if (mutation === 'deletion') {
    fixture.matches.splice(0, 1)
  } else if (mutation === 'provider-replacement') {
    fixture.matches[0] = {
      ...fixture.matches[0],
      id: 'leaguepedia-replacement-001',
      sourceProvider: 'leaguepedia-cargo',
      sourceGameId: 'replacement-001',
    }
  } else if (mutation === 'identity-change') {
    const profile = fixture.teams['Gen.G']
    if (!profile) throw new Error('Fixture is missing Gen.G')
    fixture.teams['Gen.G Esports'] = { ...profile, name: 'Gen.G Esports', code: 'GENX' }
    delete fixture.teams['Gen.G']
    fixture.matches = fixture.matches.map((match) => ({
      ...match,
      teamA: match.teamA === 'Gen.G' ? 'Gen.G Esports' : match.teamA,
      teamB: match.teamB === 'Gen.G' ? 'Gen.G Esports' : match.teamB,
      winner: match.winner === 'Gen.G' ? 'Gen.G Esports' : match.winner,
    }))
  } else if (mutation === 'tournament-completion') {
    fixture.scheduleReferences = fixture.scheduleReferences.map((reference) => ({
      ...reference,
      state: 'completed',
      retrievedAt: '2026-05-19T00:00:00.000Z',
      coverageEnd: '2026-05-18',
      coverageEndComplete: true,
    }))
  } else {
    fixture.compatibility.modelVersion = 'fixture-model-v2'
  }
  return fixture
}

function cloneFixture(input: IncrementalFixture): IncrementalFixture {
  return {
    matches: input.matches.map((match) => ({ ...match })),
    teams: Object.fromEntries(Object.entries(input.teams).map(([name, team]) => [name, { ...team }])),
    scheduleReferences: input.scheduleReferences.map((reference) => ({ ...reference })),
    compatibility: { ...input.compatibility },
  }
}

function fixtureMatch(id: string, date: string, teamA: string, teamB: string, winner: string): MatchRecord {
  return {
    id,
    sourceProvider: 'oracles-elixir',
    sourceGameId: id,
    dataCompleteness: 'complete',
    date,
    season: 2026,
    event: 'LCK 2026 Regular Season',
    phase: 'Regular season',
    region: 'LCK',
    league: 'LCK',
    patch: '26.1',
    bestOf: 1,
    tier: 'regional-regular',
    teamA,
    teamB,
    winner,
    teamAKills: winner === teamA ? 17 : 11,
    teamBKills: winner === teamB ? 17 : 11,
    teamAGold: winner === teamA ? 64_000 : 58_000,
    teamBGold: winner === teamB ? 64_000 : 58_000,
  }
}
