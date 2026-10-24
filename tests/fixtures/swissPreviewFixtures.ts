import { createPublicArtifactWritePlan } from '../../src/domains/rankings/internal/published/writePlan'
import { createStaticRankingData } from '../../src/domains/rankings/internal/projections/snapshot'
import type { MatchRecord, TeamProfile } from '../../src/domains/rankings/types'

export const at = '2026-10-20T12:00:00.000Z'
export const mainId = '2026 Season World Championship/Main Event'
export const playInId = '2026 Season World Championship/Play-In'
const sizes = [8, 8, 8, 6, 3]
export const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa']

type FixtureTeam = { id: string | null; name: string | null; code: null; gameWins: number | null; outcome: string | null }
export function team(name: string | null, gameWins: number | null = null, outcome: string | null = null): FixtureTeam {
  return { id: name, name, code: null, gameWins, outcome }
}
export function swissSeries(round: number, slot: number, teams: FixtureTeam[] = [team(null), team(null)], status = 'upcoming') {
  return {
    id: `${mainId}_Round ${round}_${slot + 1}`, eventId: mainId, startTime: `2026-10-${22 + round}T${String(10 + slot).padStart(2, '0')}:00:00.000Z`,
    stage: `Round ${round}`, status, sourceState: status === 'completed' ? 'completed' : 'scheduled', bestOf: round > 3 ? 3 : 1, teams, vodUrls: [],
  }
}
/** Power ratings for the seeded field and Fnatic. Each team beats every team after it, so ratings fall down the list. */
export function rankingArtifacts() {
  const field: Array<[string, TeamProfile['region']]> = [['Gen.G', 'LCK'], ['Hanwha Life Esports', 'LCK'], ['T1', 'LCK'], ['Dplus KIA', 'LCK'], ["Anyone's Legend", 'LPL'],
    ['Bilibili Gaming', 'LPL'], ['Top Esports', 'LPL'], ['Invictus Gaming', 'LPL'], ['G2 Esports', 'LEC'], ['Movistar KOI', 'LEC'], ['Fnatic', 'LEC'],
    ['Team Liquid', 'LCS'], ['LYON', 'LCS'], ['Team Secret Whales', 'LCP'], ['CTBC Flying Oyster', 'LCP'], ['LØS', 'CBLOL']]
  const teams: Record<string, TeamProfile> = Object.fromEntries(field.map(([name, region]) => [name, { name, code: name.slice(0, 3), league: region, region }]))
  const matches = field.flatMap(([teamA], a) => field.slice(a + 1).map(([teamB], offset): MatchRecord => {
    const date = `2026-0${1 + (a % 8)}-${String(offset + 1).padStart(2, '0')}`
    return { id: `${teamA}-${teamB}`, sourceProvider: 'oracles-elixir', date, datetimeUtc: `${date}T12:00:00.000Z`, season: 2026, event: 'MSI 2026',
      phase: 'Bracket', region: 'International', league: 'MSI', patch: '', bestOf: 1, bestOfBasis: 'provider', tier: 'msi-bracket', teamA, teamB,
      winner: teamA, teamAKills: 15, teamBKills: 9, teamAGold: 60_000, teamBGold: 55_000 }
  }))
  const data = createStaticRankingData({ matches, teams, rosters: {}, generatedAt: '2026-10-01T00:00:00.000Z', dataMode: 'seeded-sample' })
  return new Map(createPublicArtifactWritePlan(data).writes.map((write) => [`/data/${write.relativePath}`, write.contents]))
}

export function fixtureFeed() {
  return {
    version: 1, source: 'leaguepedia-cargo', unsupportedApi: false, dataMode: 'synthetic-fixture', fetchedAt: at, sourceUpdatedAt: null,
    coverage: { start: '2026-10-06T00:00:00.000Z', end: '2026-12-05T23:59:59.999Z', complete: true, warnings: [] as string[] },
    events: [
      { id: mainId, sourceTournamentId: mainId, competition: 'worlds', label: 'Worlds 2026 Main Event', season: '2026',
        series: sizes.flatMap((size, index) => Array.from({ length: size }, (_, slot) => swissSeries(index + 1, slot))) },
      { id: playInId, sourceTournamentId: playInId, competition: 'worlds', label: 'Worlds 2026 Play-In', season: '2026',
        series: [{ ...swissSeries(1, 0, [team('Fnatic'), team('Tango')]), id: 'worlds-play-in', eventId: playInId, stage: 'Play-In', startTime: '2026-10-14T10:00:00.000Z' }] },
      { id: 'lcs:2027:promotion', sourceTournamentId: 'LCS/2027 Season/Promotion', competition: 'lcs', label: 'LCS 2027 Promotion', season: '2027',
        series: [{ ...swissSeries(1, 0, [team('Rook'), team('Pawn')]), id: 'lcs-promo', eventId: 'lcs:2027:promotion', stage: 'Finals', bestOf: 5 }] },
    ],
  }
}

