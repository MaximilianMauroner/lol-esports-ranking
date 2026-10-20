import type { MatchRecord, TeamProfile } from '../../src/domains/rankings/types.ts'
import type { mergeCommunityMatchSources } from '../../src/domains/rankings/internal/evidence/communitySources.ts'
import { importLeaguepediaSnapshot } from '../../scripts/rankings/providers/leaguepedia.ts'

type Sources = Parameters<typeof mergeCommunityMatchSources>[0]

export const crossMidnightTeams: Record<string, TeamProfile> = Object.fromEntries(
  ['Alpha', 'Beta'].map((name) => [name, { name, code: name, league: 'LCK', region: 'LCK' }]),
)

export type CrossMidnightReviewCase = {
  name: string
  partial: Sources
  complete: Sources
  sameDate: Sources
  seriesDates: string[]
  seriesGameCounts: number[]
  season: number
}

function game(id: string, datetimeUtc: string, overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    id, sourceGameId: id, sourceProvider: 'oracles-elixir', dataCompleteness: 'scoreboard-game-stats',
    date: datetimeUtc.slice(0, 10), datetimeUtc, season: Number(datetimeUtc.slice(0, 4)),
    event: 'Synthetic regional series', phase: 'Regular season', league: 'LCK', region: 'LCK',
    tier: 'regional-regular', bestOf: 3, bestOfBasis: 'provider', patch: '26.1',
    teamA: 'Alpha', teamB: 'Beta', winner: 'Alpha', teamAHomeLeague: 'LCK', teamBHomeLeague: 'LCK',
    teamAKills: 20, teamBKills: 10, teamAGold: 60_000, teamBGold: 55_000,
    ...overrides,
  }
}

export function crossMidnightReviewCases(): CrossMidnightReviewCase[] {
  const gap = (lastDate: string, complete = true): Sources => {
    const games = [1, 2, 3].map((number) => game(`oracle-gap-${number}`,
      number === 3 ? `${lastDate}T${lastDate === '2026-07-11' ? '00:30' : '23:55'}:00Z` : `2026-07-10T23:${number * 10}:00Z`,
      { bestOf: 5, gameNumber: number, teamAKills: 20 + number, teamAGold: 60_000 + number }))
    return {
      oracleMatches: games.slice(0, 2),
      leaguepediaMatches: games.slice(0, complete ? 3 : 2).flatMap((match, index) => ['first', 'overlap'].map((snapshot) => ({
        ...match, id: `lp-${snapshot}-${index + 1}`, sourceProvider: 'leaguepedia-cargo',
        sourceGameId: `Synthetic regional series_Round 1_1_${index + 1}`,
      }))),
    }
  }
  const rematch = (complete = true): Sources => ({
    oracleMatches: [1, 2].flatMap((round) => [1, 2].map((number) => game(`opaque-round-${round}-${number}`,
      `2026-07-${9 + round}T18:${number * 10}:00Z`, { sourceMatchId: `round_${round}`, gameNumber: number })))
      .slice(0, complete ? 4 : 3),
    leaguepediaMatches: [],
    lolEsportsReferences: [1, 2].map((round) => ({
      sourceProvider: 'lol-esports-api', matchId: `synthetic-official-round-${round}`,
      date: `2026-07-${9 + round}`, startTime: `2026-07-${9 + round}T18:00:00Z`,
      strategy: { type: 'bestOf', count: 3 },
      teams: [{ name: 'Alpha', outcome: 'win', gameWins: 2 }, { name: 'Beta', outcome: 'loss', gameWins: 0 }],
      gameIds: [], games: [],
    })),
  })
  const newYear = (lastDatetime: string, complete = true): Sources => ({
    oracleMatches: [],
    leaguepediaMatches: importLeaguepediaSnapshot({
      source: 'synthetic New Year review fixture',
      matches: ['2025-12-31T23:30:00Z', lastDatetime].slice(0, complete ? 2 : 1).map((datetimeUtc, index) => ({
        id: `LCK 2025 Winter_Round 1_1_${index + 1}`, date: datetimeUtc.slice(0, 10), datetimeUtc,
        event: 'LCK 2025 Winter', matchBestOf: 3, teamA: 'Alpha', teamB: 'Beta', winner: 'Alpha',
        teamAKills: 20 + index, teamBKills: 10, teamAGold: 60_000 + index, teamBGold: 55_000,
      })),
    }).matches,
  })
  return [
    { name: 'provider-gap', partial: gap('2026-07-11', false), complete: gap('2026-07-11'), sameDate: gap('2026-07-10'),
      seriesDates: ['2026-07-10'], seriesGameCounts: [3], season: 2026 },
    { name: 'ordinal-rematch', partial: rematch(false), complete: rematch(), sameDate: rematch(),
      seriesDates: ['2026-07-10', '2026-07-11'], seriesGameCounts: [2, 2], season: 2026 },
    { name: 'new-year', partial: newYear('2026-01-01T00:30:00Z', false), complete: newYear('2026-01-01T00:30:00Z'),
      sameDate: newYear('2025-12-31T23:55:00Z'), seriesDates: ['2025-12-31'], seriesGameCounts: [2], season: 2025 },
  ]
}
