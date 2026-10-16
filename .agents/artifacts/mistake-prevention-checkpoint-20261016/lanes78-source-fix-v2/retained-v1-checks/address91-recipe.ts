import type { MatchRecord, TeamProfile } from 'RUNTIME_TYPES_PATH'
const regions = ['LEC', 'LCS'] as const
const prefixes = { LEC: 'Euro', LCS: 'Amer' }
const teams: Record<string, TeamProfile> = Object.fromEntries(regions.flatMap((region) =>
  Array.from({ length: 10 }, (_, index) => {
    const number = String(index + 1).padStart(2, '0')
    const name = `${prefixes[region]} ${number}`
    return [name, { name, code: `${prefixes[region][0]}${number}`, league: region, region }]
  })))

function roundRobin(region: typeof regions[number]): MatchRecord[] {
  const names = Object.values(teams).filter((team) => team.region === region).map((team) => team.name)
  return names.flatMap((teamA, a) => names.slice(a + 1).map((teamB, offset) => {
    const date = `2026-0${1 + (a % 6)}-${String(offset + 1).padStart(2, '0')}`
    return { id: `${region}-${teamA}-${teamB}`, sourceProvider: 'oracles-elixir', date, datetimeUtc: `${date}T12:00:00.000Z`, season: 2026,
      event: `${region} 2026`, phase: 'Regular season', region, league: region, patch: '', bestOf: 1, bestOfBasis: 'provider',
      tier: 'regional-regular', teamA, teamB, winner: teamA, teamAKills: 15, teamBKills: 9, teamAGold: 60_000, teamBGold: 55_000 }
  }))
}

// One MSI series gives the board an `international` tournament option with two teams.
const msi: MatchRecord = { id: 'MSI-Euro 01-Amer 01', sourceProvider: 'oracles-elixir', date: '2026-06-20', datetimeUtc: '2026-06-20T12:00:00.000Z',
  season: 2026, event: 'MSI 2026', phase: 'Bracket', region: 'International', league: 'MSI', patch: '', bestOf: 1, bestOfBasis: 'provider',
  tier: 'msi-bracket', teamA: 'Euro 01', teamB: 'Amer 01', winner: 'Euro 01', teamAKills: 15, teamBKills: 9, teamAGold: 60_000, teamBGold: 55_000 }


const matches = [...regions.flatMap(roundRobin), msi]
const rosters = {}
export { matches, teams, rosters }
