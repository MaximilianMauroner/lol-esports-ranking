import { ROLES } from '../src/domains/style/profile.ts'
import type { MatchRecord } from '../src/domains/rankings/types.ts'

export function styleGame(id = 'one', season = 2026): MatchRecord {
  const roster = (team: string) => ({ sourceProvider: 'oracles-elixir' as const, teamId: team, observedAt: `${season}-06-01`,
    completeness: 'complete-five-role' as const, players: ROLES.map((role, i) => ({ id: `${team}-${i}`, name: i === 0 ? 'Same name' : `${team}-${i}`, role,
      stats: { side: 'blue' as const, won: true, kills: 0, deaths: 0, assists: 0, damageShare: 0.2, earnedGoldShare: 0.1,
        goldDiffAt15: 10, damagePerMinute: 100, csPerMinute: 0, killParticipation: 0, wardsPlacedPerMinute: 0, wardsClearedPerMinute: 0 } })) })
  return { id, sourceProvider: 'oracles-elixir', date: `${season}-06-01`, season, event: 'MSI', phase: 'Final', region: 'International', league: 'MSI',
    teamAHomeLeague: 'LCK', teamBHomeLeague: 'LPL', patch: '', bestOf: 1, tier: 'msi-bracket',
    teamA: 'Alpha', teamB: 'Beta', winner: 'Alpha', teamAKills: 0, teamBKills: 10, teamAGold: 10, teamBGold: 20,
    teamATowers: 0, teamBTowers: 5, teamADragons: 0, teamBDragons: 4, teamABarons: 0, teamBBarons: 1, gameLengthSeconds: 1800,
    teamARoster: roster('a'), teamBRoster: roster('b') }
}

