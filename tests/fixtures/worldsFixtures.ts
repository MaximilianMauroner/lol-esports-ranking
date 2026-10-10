import { publishedRatingScale } from '../../src/lib/modelConfig'
import type { ForecastBasis } from '../../src/lib/tournamentForecast'
import type { PublicTeamStanding } from '../../src/lib/publicArtifacts/schema'
import { WORLDS_2026_PLAY_IN_RULES } from '../../src/lib/worlds2026PlayIn'
import { WORLDS_2026_SWISS_RULES, type SwissRound, type Worlds2026SwissEntrant } from '../../src/lib/worlds2026Swiss'
import { WORLDS_2026_KNOCKOUT_RULES } from '../../src/lib/worlds2026Knockout'
import type { Worlds2026EventInput } from '../../src/lib/worldsSimulation'
import { worldsFeedEventKey, type WorldsArtifact, type HistoricalWorldsInput } from '../../src/lib/worldsArtifacts'
import type { TournamentEvent, TournamentFeed } from '../../src/lib/tournamentFeed'

export const worldsEvidence = { kind: 'synthetic-fixture', reference: 'tests/fixtures/worldsFixtures.ts; fictional teams and results' } as const
export const worldsAsOf = '2026-10-31T23:00:00Z'
export const worldsEventId = 'fixture:worlds-2026'
const directEntrants: Worlds2026SwissEntrant[] = WORLDS_2026_SWISS_RULES.pools.flat().filter((seed) => seed !== 'PLAYIN')
  .map((seed) => ({ id: seed, seed, region: seed.replace(/\d+$/, '') }))
const field = [...directEntrants.map((team) => team.id), 'CBLOL2', 'LCS3', 'LEC3', 'LCP3']

/** Fixed reference draws. No production draw algorithm constructs these fixtures. First team wins. */
const referencePairs: [string, string][][] = [
  [['LCK1', 'LCP2'], ['LPL1', 'LCK4'], ['LCS1', 'LPL4'], ['LEC1', 'LCP3'], ['LCP1', 'LCS2'], ['CBLOL1', 'LPL3'], ['LCK2', 'LEC2'], ['LPL2', 'LCK3']],
  [['LCK1', 'LPL1'], ['LCS1', 'LEC1'], ['LCP1', 'CBLOL1'], ['LCK2', 'LPL2'], ['LCP2', 'LCK4'], ['LPL4', 'LCP3'], ['LCS2', 'LPL3'], ['LEC2', 'LCK3']],
  [['LCK1', 'LCS1'], ['LCP1', 'LCK2'], ['LCK4', 'LCP3'], ['LPL3', 'LCK3'], ['LPL1', 'LCP2'], ['LEC1', 'LCS2'], ['CBLOL1', 'LEC2'], ['LPL2', 'LPL4']],
  [['LCS1', 'LCK2'], ['LPL1', 'CBLOL1'], ['LEC1', 'LPL2'], ['LCP2', 'LCS2'], ['LPL4', 'LEC2'], ['LCK4', 'LPL3']],
  [['LCK2', 'CBLOL1'], ['LPL2', 'LCP2'], ['LPL4', 'LCK4']],
]
export function worldsFixture(stage: 'play-in' | 'swiss-5' | 'knockout' | 'completed' = 'swiss-5'): Worlds2026EventInput {
  const context = { eventId: worldsEventId, stateVersion: `fixture-${stage}`, asOf: worldsAsOf }
  const playPairs: [string, string][] = [['CBLOL2', 'LCS3'], ['LEC3', 'LCP3'], ['LCS3', 'LCP3'], ['CBLOL2', 'LEC3'], ['LCS3', 'LEC3'], ['LCP3', 'LCS3']]
  const winners = [1, 1, 1, 1, 0, 0]
  const playIn = { ...context, rulesId: WORLDS_2026_PLAY_IN_RULES.id,
    entrants: WORLDS_2026_PLAY_IN_RULES.entrantSeeds.map((seed) => ({ id: seed, seed })),
    slots: ['CBLOL2', 'LCS3', 'LEC3', 'LCP3'], evidence: { entrants: worldsEvidence, draw: worldsEvidence, results: worldsEvidence },
    results: stage === 'play-in' ? [] : WORLDS_2026_PLAY_IN_RULES.matches.map((match, slot) => ({ slot: match.id,
      matchId: `play-${slot}`, teamIds: playPairs[slot], gameWins: (winners[slot] ? [1, 3] : [3, 1]) as [number, number], observedAt: `2026-10-18T${String(slot + 12).padStart(2, '0')}:00:00Z` })),
  }
  const rounds: SwissRound[] = referencePairs.map((pairs, index) => {
    const date = ['23', '24', '26', '30', '31'][index]
    return { round: index + 1, pairs: structuredClone(pairs), drawnAt: `2026-10-${date}T10:00:00Z`, drawEvidence: worldsEvidence, rematchWaivers: [],
      results: index === 4 && stage === 'swiss-5' ? [] : pairs.map((teamIds, slot) => ({ slot, matchId: `swiss-${index}-${slot}`, teamIds,
        gameWins: [index < 2 || (index === 2 && slot >= 4) ? 1 : 2, 0], observedAt: `2026-10-${date}T12:00:00Z` })) }
  })
  const swiss = { ...context, rulesId: WORLDS_2026_SWISS_RULES.id,
    entrants: [...structuredClone(directEntrants), { id: 'LCP3', seed: 'PLAYIN' as const, region: 'LCP' }],
    evidence: { entrants: worldsEvidence, results: worldsEvidence }, rounds }
  const qualifiers = [
    { id: 'LCK1', swissWins: 3 as const, swissLosses: 0 as const }, { id: 'LCP1', swissWins: 3 as const, swissLosses: 0 as const },
    ...['LCS1', 'LPL1', 'LEC1'].map((id) => ({ id, swissWins: 3 as const, swissLosses: 1 as const })),
    ...['LCK2', 'LPL2', 'LPL4'].map((id) => ({ id, swissWins: 3 as const, swissLosses: 2 as const })),
  ]
  const knockoutPairs: [string, string][] = [['LCK1', 'LCK2'], ['LCS1', 'LPL1'], ['LCP1', 'LPL2'], ['LEC1', 'LPL4'], ['LCK1', 'LCS1'], ['LCP1', 'LEC1'], ['LCK1', 'LCP1']]
  const knockout = { ...context, rulesId: WORLDS_2026_KNOCKOUT_RULES.id, qualifiers, slots: knockoutPairs.slice(0, 4).flat(),
    evidence: { qualifiers: worldsEvidence, draw: worldsEvidence, results: worldsEvidence },
    results: stage === 'completed' ? knockoutPairs.map((teamIds, slot) => ({ slot, matchId: `knockout-${slot}`, teamIds, gameWins: [3, 0] as [number, number], observedAt: worldsAsOf })) : [] }
  return { format: 'worlds-2026', directEntrants: structuredClone(directEntrants), playIn, swiss: stage === 'play-in' ? null : swiss,
    knockout: stage === 'knockout' || stage === 'completed' ? knockout : null }
}
function standing(id: string): PublicTeamStanding {
  return { teamId: `fixture:${id}`, leagueId: 'synthetic', team: `Fixture ${id}`, code: id, region: 'LCK', league: 'synthetic',
    rosterBasis: 'sourced', baseRating: 1800, leagueScore: 100, leagueAdjustment: 0, leagueDelta: 0,
    ratingComponents: { leagueAnchor: 1800, teamStableOffset: 0, rosterPriorOffset: 0, momentum: 0, contextAdjustment: 0, uncertainty: 30 },
    rating: 1800, previousRating: 1800, delta: 0, rank: 1, previousRank: 1, movement: 0, wins: 20, losses: 10,
    recordBasis: 'standing-record-from-ranking-model', scoreFamily: 'power-index', confidence: 1, uncertainty: 30, form: [], strongestFactor: 'context',
    eligibility: { eligible: true, reasons: [] }, factors: { context: 0, recency: 0, execution: 0, opponent: 0, league: 0 }, recentEvents: [], recentMatches: [] }
}
export function worldsBasis(): ForecastBasis {
  return { snapshotId: 'synthetic-worlds-snapshot', ratingDataAsOf: '2026-10-17T00:00:00Z', ratingPublishedAt: '2026-10-17T01:00:00Z', dataMode: 'seeded-sample',
    model: { name: 'Synthetic model', version: 'fixture-v1', configHash: 'fixture-worlds-config', ratingScale: publishedRatingScale,
      parameters: { winProbabilityEloScale: 400, winProbabilityUncertaintyScale: 400, winProbabilityUncertaintyFloor: 0.2 } },
    identityMap: { version: 1, source: 'lolesports-persisted-site-api', revision: 'fixture-worlds-identities', mappings: field.map((id) => ({ sourceTeamId: id, teamId: `fixture:${id}` })) },
    snapshot: { artifactKind: 'public-snapshot-shard', filter: { region: 'All', event: 'All', season: 'All' }, ratingScale: publishedRatingScale,
      modelVersion: 'fixture-v1', modelConfigHash: 'fixture-worlds-config', matchCount: 0, sourceBreakdown: [], scoreFamilies: [], standings: field.map(standing), leagues: [], regions: [] } }
}
export function worldsEvent(input = worldsFixture()): TournamentEvent {
  return { id: input.playIn.eventId, sourceTournamentId: 'fictional-worlds', competition: 'worlds', label: 'Worlds 2026 · synthetic verification', season: '2026',
    series: field.map((id, slot) => ({ id: `name-${slot}`, eventId: input.playIn.eventId, startTime: null, stage: 'Synthetic participant identity',
      status: 'unknown', sourceState: 'fixture-only', bestOf: null, teams: [{ id, name: `Fixture ${id}`, code: id, gameWins: null, outcome: null }], vodUrls: [] })) }
}
export function worldsArtifact(input = worldsFixture(), event = worldsEvent(input)): WorldsArtifact {
  return { version: 1, eventId: event.id, feedEventKey: worldsFeedEventKey(event), dataMode: 'synthetic-fixture', state: input }
}
export function worldsFeed(event = worldsEvent()): TournamentFeed {
  return { version: 1, source: 'lolesports-persisted-site-api', unsupportedApi: true, dataMode: 'synthetic-fixture', fetchedAt: worldsAsOf,
    sourceUpdatedAt: null, coverage: { start: worldsAsOf, end: worldsAsOf, complete: true, warnings: ['Synthetic offline verification.'] }, events: [event] }
}
export function historicalWorldsFixture(): HistoricalWorldsInput {
  const ids = ['past-alpha', 'past-beta', 'past-gamma', 'past-delta']
  const games = []
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) for (let leg = 0; leg < 2; leg++) games.push({ id: `past-${a}-${b}-${leg}`, teamAId: ids[a], teamBId: ids[b], winnerId: ids[a] })
  return { format: 'worlds-2022-group', eventId: 'fixture:worlds-2022', stateVersion: 'fixture-past-group', asOf: '2022-10-16T23:00:00Z',
    group: { season: 2022, groupId: 'A', entrants: [
      { id: ids[0], region: 'LCK', pool: 'A' }, { id: ids[1], region: 'LPL', pool: 'B' }, { id: ids[2], region: 'LEC', pool: 'C' }, { id: ids[3], region: 'LCS', pool: 'play-in' },
    ], games, entrantEvidence: worldsEvidence, gameEvidence: worldsEvidence } }
}
