import assert from 'node:assert/strict'
import test from 'node:test'
import { inferEventTier } from '../src/data/competitionTaxonomy.ts'
import { dssSeriesWeight } from '../src/lib/deservedStanding.ts'
import { eventWeightContextForMatches, eventWeightForMatch } from '../src/lib/eventWeighting.ts'
import { mergeCommunityMatchSources } from '../src/lib/importers/communitySources.ts'
import { createRatingReplayContext, finalizeRatingRunStateAtUtcBoundary, replayRatingDates } from '../src/lib/model.ts'
import { playerResumeCreditEntries } from '../src/lib/playerResumeLedger.ts'
import { predictionSegmentsFor } from '../src/lib/predictionContext.ts'
import { isInternationalMatch } from '../src/lib/ratingCalculations.ts'
import type { MatchRecord, TeamProfile } from '../src/types.ts'

test('regional finals and play-ins override Worlds aliases and generic playoff flags', () => {
  assert.equal(inferEventTier({ league: 'WLDs', event: 'LPL/2025 Season/Regional Finals', phase: 'Final', playoffs: true }), 'major-playoffs')
  assert.equal(inferEventTier({ league: 'Worlds', event: 'Worlds 2025/Play-In', phase: 'Play-in', playoffs: true }), 'worlds-main')
  assert.equal(inferEventTier({ league: 'MSI', event: 'MSI 2025/Play-In', phase: 'Play-in', playoffs: true }), 'msi-play-in')
  assert.equal(inferEventTier({ league: 'EWC', event: 'EWC 2025/Online Qualifiers', playoffs: true }), 'qualifier')
})

test('First Stand and domestic cup weights follow the sourced phase', () => {
  const groups = fixture({ league: 'FST', event: 'First Stand 2025', phase: 'Group Stage' })
  const knockout = { ...groups, phase: 'Semifinal' }
  groups.tier = inferEventTier(groups)
  knockout.tier = inferEventTier(knockout)
  assert.equal(eventWeightForMatch(knockout), eventWeightForMatch(groups))
  assert.ok(eventWeightForMatch(groups) > eventWeightForMatch({ ...groups, league: 'MSI', event: 'MSI 2025' }))
  assert.ok(dssSeriesWeight(knockout.tier, 5) > dssSeriesWeight(groups.tier, 5))
  assert.equal(inferEventTier({ league: 'LCK', event: 'LCK 2025 Cup', phase: 'Grand Final', playoffs: false }), 'major-playoffs')
  assert.equal(inferEventTier({ league: 'CBLOL', event: 'CBLOL 2025 Cup', phase: 'Group Stage' }), 'regional-regular')
})

test('observed Worlds games, regional finals, upper finals and partial finals cannot start preseason', () => {
  const cup = fixture({ date: '2025-12-01', league: 'KeSPA', event: 'KeSPA 2025', tier: 'minor-international' })
  const rejected = [
    finalGames(1, { phase: 'Swiss', bestOf: 1 }),
    finalGames(3, { event: 'LPL/2025 Season/Regional Finals', phase: 'Regional Finals' }),
    finalGames(3, { phase: 'Upper Final' }),
    finalGames(3, { event: 'Worlds 2025/Play-in', tier: 'worlds-main' }),
    finalGames(2),
    finalGames(1, { bestOf: 1, bestOfBasis: 'fallback' }),
    finalGames(2, { bestOf: 5, bestOfBasis: 'fallback' }),
  ]
  for (const matches of rejected) {
    const context = eventWeightContextForMatches(matches)
    assert.equal(context.worldsEndDateByCalendarYear.size, 0)
    assert.equal(eventWeightForMatch(cup, context), eventWeightForMatch(cup))
  }
})

test('only a resolved Worlds best-of-five final enables the offseason discount', () => {
  const completed = finalGames(3)
  const context = eventWeightContextForMatches(completed)
  assert.equal(context.worldsEndDateByCalendarYear.get(2025), '2025-11-09')
  const cup = fixture({ date: '2025-12-01', league: 'KeSPA', event: 'KeSPA 2025', tier: 'minor-international' })
  assert.ok(eventWeightForMatch(cup, context) < eventWeightForMatch(cup))
  const playoffs = fixture({ date: '2025-12-01', tier: 'major-playoffs' })
  const regular = { ...playoffs, tier: 'regional-regular' as const }
  assert.equal(eventWeightForMatch(playoffs, context), eventWeightForMatch(playoffs))
  assert.equal(eventWeightForMatch(regular, context), eventWeightForMatch(regular))
  assert.equal(eventWeightForMatch({ ...cup, date: '2026-01-01' }, context), eventWeightForMatch(cup))
})

test('Demacia retains EWC evidence weight and domestic identity after completed Worlds', () => {
  const context = eventWeightContextForMatches(finalGames(3))
  const demacia = fixture({ date: '2025-12-20', event: 'DCup 2025', league: 'DCup', tier: 'minor-international', region: 'LPL' })
  const ewc = { ...demacia, date: '2025-07-20', event: 'EWC 2025', league: 'EWC', region: 'International' as const }
  assert.equal(eventWeightForMatch(demacia, context), eventWeightForMatch(ewc, context))
  assert.equal(dssSeriesWeight(demacia.tier, 5, demacia, context), dssSeriesWeight(ewc.tier, 5, ewc, context))
  assert.equal(isInternationalMatch(demacia), false)
  assert.equal(predictionSegmentsFor(demacia, {}, new Map(), new Map()).includes('international'), false)
  const credits = playerResumeCreditEntries([{
    seriesKey: 'demacia', date: demacia.date, season: 2025, event: demacia.event, tier: demacia.tier,
    team: demacia.teamA, weightedSeriesValue: 12, players: [{ id: 'mid', role: 'Mid', share: 1 }],
  }])
  assert.equal(credits[0].international, false)
  assert.equal(credits[0].resumeCredit, 12)
})

test('official playoff phase enrichment also updates the applied domestic cup tier', () => {
  const [match] = mergeCommunityMatchSources({
    oracleMatches: [fixture({ date: '2025-02-23', event: 'LCK 2025 Cup' })],
    leaguepediaMatches: [],
    lolEsportsReferences: [{
      sourceProvider: 'lol-esports-api', games: [],
      matchId: 'cup-final', gameIds: [], date: '2025-02-23', blockName: 'Grand Final',
      teams: [{ name: 'Alpha' }, { name: 'Beta' }], strategy: { count: 5 },
    }],
  })
  assert.equal(match.phase, 'Grand Final')
  assert.equal(match.tier, 'major-playoffs')
  assert.equal(match.bestOf, 5)
})

test('completed placement uses highest attainment, conserves the pool and applies only once', () => {
  const final = finalGames(3, { event: 'EWC 2025', league: 'EWC', tier: 'minor-international' })
  const earlier = final.map((match) => ({ ...match, id: `semi-${match.id}`, sourceMatchId: 'ewc-semifinal', date: '2025-11-08', phase: 'Semifinal' }))
  const onlyFinal = placementRun(final)
  const progressed = placementRun([...earlier, ...final])
  const tracker = progressed.eventTrackers.get('ewc:2025')
  const finalTracker = onlyFinal.eventTrackers.get('ewc:2025')
  assert.ok(tracker?.placementAudit && finalTracker?.placementAudit)
  assert.equal(tracker.placementAudit.actualPointPool, finalTracker.placementAudit.actualPointPool)
  assert.equal(tracker.placementAudit.expectedPointPool, tracker.placementAudit.actualPointPool)
  assert.equal(tracker.placementAudit.centeredDeltaTotal, 0)
  assert.ok([...progressed.leaguePlacementDeltas.values()].some((delta) => delta !== 0))
  const scores = new Map(progressed.leagueScores)
  finalizeRatingRunStateAtUtcBoundary(progressed, placementTeams)
  assert.deepEqual(progressed.leagueScores, scores)
})

test('a tied terminal series cannot grant champion placement evidence', () => {
  const tied = finalGames(2, { event: 'EWC 2025', league: 'EWC', tier: 'minor-international', bestOf: 2 })
  tied[1].winner = 'Beta'
  const state = placementRun(tied)
  assert.equal(state.eventTrackers.get('ewc:2025')?.placementAudit?.skipReason, 'unresolved-terminal-final')
  assert.equal(state.leaguePlacementDeltas.size, 0)
})

test('placement conserves the event pool after grouping several entrants into each league', () => {
  const final = finalGames(3, { event: 'EWC 2025', league: 'EWC', tier: 'minor-international' })
  const semifinalA = final.map((match) => ({ ...match, id: `semi-a-${match.id}`, sourceMatchId: 'ewc-semifinal-a',
    date: '2025-11-08', phase: 'Semifinal', teamB: 'Gamma' }))
  const semifinalB = final.map((match) => ({ ...match, id: `semi-b-${match.id}`, sourceMatchId: 'ewc-semifinal-b',
    date: '2025-11-08', phase: 'Semifinal', teamA: 'Beta', teamB: 'Delta', winner: 'Beta' }))
  const state = placementRun([...semifinalA, ...semifinalB, ...final], {
    ...placementTeams,
    Gamma: { name: 'Gamma', code: 'GAM', league: 'LCK', region: 'LCK' },
    Delta: { name: 'Delta', code: 'DEL', league: 'LPL', region: 'LPL' },
  })
  const audit = state.eventTrackers.get('ewc:2025')?.placementAudit
  assert.ok(audit)
  assert.equal(audit.actualPointPool, 29)
  assert.equal(audit.expectedPointPool, audit.actualPointPool)
  assert.equal(audit.centeredDeltaTotal, 0)
})

const placementTeams: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'ALP', league: 'LCK', region: 'LCK' },
  Beta: { name: 'Beta', code: 'BET', league: 'LPL', region: 'LPL' },
}

function placementRun(matches: MatchRecord[], teams = placementTeams) {
  const context = createRatingReplayContext(matches, teams, { tournamentLifecycles: new Map([['ewc:2025', {
    status: 'completed', boundaryDate: '2025-11-09', ratedThroughDate: '2025-11-09', dataLag: false, resultCoverageComplete: true,
  }]]) })
  const state = replayRatingDates({ context, replayMatches: matches })
  finalizeRatingRunStateAtUtcBoundary(state, teams)
  return state
}

function finalGames(count: number, overrides: Partial<MatchRecord> = {}) {
  return Array.from({ length: count }, (_, index) => fixture({
    id: `worlds-final-${index + 1}`, sourceMatchId: 'worlds-final', gameNumber: index + 1,
    date: '2025-11-09', event: 'WLDs 2025', league: 'WLDs', region: 'International',
    phase: 'Final', tier: 'worlds-playoffs', bestOf: 5, bestOfBasis: 'provider', ...overrides,
  }))
}

function fixture(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    id: 'fixture', sourceProvider: 'oracles-elixir', sourceGameId: 'fixture', patch: '25.1',
    date: '2025-01-01', season: 2025, event: 'LCK 2025 Spring',
    phase: 'Regular season', region: 'LCK', league: 'LCK', bestOf: 1, tier: 'regional-regular',
    teamA: 'Alpha', teamB: 'Beta', winner: 'Alpha', teamAKills: 20, teamBKills: 12,
    teamAGold: 65000, teamBGold: 59000, ...overrides,
  }
}
