import assert from 'node:assert/strict'
import test from 'node:test'
import type { LeagueStrength, MatchRecord, MatchRosterSnapshot, Region, Role, Side, TeamProfile } from '../src/types.ts'
import type { CausalRecomputeDecision } from '../src/lib/causalRecompute.ts'
import {
  buildPlayerModel,
  buildPregamePlayerRatingEdges,
  buildSourcedPlayerCausalSummary,
  reconcileSourcedPlayerCausality,
  recomputeSourcedPlayerCausalOutputs,
} from '../src/lib/playerModel.ts'
import {
  buildDeservedStandingModel,
  buildDssTeamCausalSummary,
  reconcileDssTeamCausality,
  recomputeDssTeamCausalState,
} from '../src/lib/deservedStandingModel.ts'
import {
  buildDeservedStandingRegionModel,
  buildDssRegionCausalSummary,
  reconcileDssRegionCausality,
  recomputeDssRegionCausalState,
} from '../src/lib/deservedStandingRegions.ts'
import {
  buildDssRosterEraCausalSummary,
  buildDssRosterEras,
  reconcileDssRosterEraCausality,
  recomputeDssRosterEraCausalState,
} from '../src/lib/rosterEras.ts'
import {
  buildDssPlayerResumeCausalSummary,
  buildDssPlayerResumeLedgers,
  reconcileDssPlayerResumeCausality,
  recomputeDssPlayerResumeCausalState,
  type DssPlayerResumeSeriesInput,
} from '../src/lib/playerResumeLedger.ts'
import { ratingCheckpointInventory } from '../src/lib/ratingCheckpointInventory.ts'
import { snapshotExternalCausalSurfaces } from '../src/lib/snapshot.ts'

test('sourced-player causality accepts append and replays same-day inserts or source corrections', () => {
  const first = sourcedMatch({ id: 'first', date: '2026-01-02' })
  const ratingContext = {
    teams: teamProfiles(),
    leagueStrengths: [leagueStrength('LCK', 'LCK', 1600)],
    eventWeightContext: eventContext('2026-01-10'),
  }
  const causalContext = { rosters: {}, ratingContext }
  const summary = buildSourcedPlayerCausalSummary({
    prefixMatches: [first],
    processedThroughUtcDate: '2026-01-02',
    causalContext,
  })
  const appended = sourcedMatch({ id: 'appended', date: '2026-01-03', winner: 'Beta' })

  assert.deepEqual(reconcileSourcedPlayerCausality({ summary, freshMatches: [first, appended], causalContext }), {
    status: 'recompute-ready',
    surface: 'sourced-player',
    mode: 'full-authoritative-corpus',
    processedThroughUtcDate: '2026-01-02',
    requiresWholeUtcDateReplay: true,
  })

  const inserted = sourcedMatch({ id: 'same-day-insert', date: '2026-01-02' })
  const insertionDecision = reconcileSourcedPlayerCausality({
    summary,
    freshMatches: [first, inserted, appended],
    causalContext,
    availableProcessedThroughUtcDates: ['2026-01-01'],
  })
  assert.equal(insertionDecision.status, 'replay-required')
  if (insertionDecision.status === 'replay-required') {
    assert.equal(insertionDecision.replayFromUtcDate, '2026-01-02')
    assert.equal(insertionDecision.resumeAfterUtcDate, '2026-01-01')
  }

  const corrected = sourcedMatch({
    id: 'first',
    date: '2026-01-02',
    teamARoster: sourcedRoster('alpha', 'blue', true, { Bot: { kills: 20 } }),
  })
  const correctionDecision = reconcileSourcedPlayerCausality({
    summary,
    freshMatches: [corrected, appended],
    causalContext,
  })
  assert.equal(correctionDecision.status, 'replay-required')
  if (correctionDecision.status === 'replay-required') {
    assert.deepEqual(correctionDecision.changedKeys, ['match:first'])
  }

  const changedContexts = [
    { ...causalContext, rosters: { Alpha: [{ id: 'fallback', name: 'Fallback', team: 'Alpha', role: 'Mid' as const }] } },
    { ...causalContext, ratingContext: { ...ratingContext, teams: { ...ratingContext.teams, Alpha: { ...ratingContext.teams.Alpha, code: 'NEW' } } } },
    { ...causalContext, ratingContext: { ...ratingContext, leagueStrengths: [leagueStrength('LCK', 'LCK', 1500)] } },
    { ...causalContext, ratingContext: { ...ratingContext, eventWeightContext: eventContext('2026-01-11') } },
  ]
  for (const changedContext of changedContexts) {
    assertFullContextReplay(reconcileSourcedPlayerCausality({
      summary,
      freshMatches: [first, appended],
      causalContext: changedContext,
    }), 'context-changed')
  }
  assertFullContextReplay(
    reconcileSourcedPlayerCausality({ summary, freshMatches: [first, appended] }),
    'context-unproven',
  )

  assert.deepEqual(
    recomputeSourcedPlayerCausalOutputs([first, appended], causalContext),
    {
      players: buildPlayerModel([first, appended], causalContext.rosters, ratingContext),
      pregameEdges: buildPregamePlayerRatingEdges([first, appended], ratingContext),
    },
  )
})

test('DSS team causality covers append, synergy/config changes, and tournament completion boundaries', () => {
  const first = matchFixture({ id: 'series-one', date: '2026-01-02' })
  const options = {
    eventWeightContext: eventContext('2026-01-10'),
    baseScoreFor: (team: string) => team === 'Alpha' ? 1510 : 1490,
    rosterValidityFor: () => 0.9,
    stagePointsFor: () => 3,
    incomingPlayerBridgeCreditFor: () => 2,
    uncertaintyFor: () => 20,
  }
  const causalContext = {
    options,
    callbackSemanticIds: {
      baseScoreFor: 'team-base-v1',
      rosterValidityFor: 'synergy-and-roster-validity-v1',
      stagePointsFor: 'tournament-placement-v1',
      incomingPlayerBridgeCreditFor: 'resume-bridge-v1',
      uncertaintyFor: 'team-uncertainty-v1',
    },
  }
  const summary = buildDssTeamCausalSummary({
    prefixMatches: [first],
    processedThroughUtcDate: '2026-01-02',
    causalContext,
  })
  const appended = matchFixture({ id: 'series-two', date: '2026-01-03', winner: 'Beta' })

  assert.equal(reconcileDssTeamCausality({
    summary,
    freshMatches: [first, appended],
    causalContext,
  }).status, 'recompute-ready')

  const contextDecision = reconcileDssTeamCausality({
    summary,
    freshMatches: [first, appended],
    causalContext: {
      options: {
        ...options,
        rosterValidityFor: () => 0.5,
        stagePointsFor: () => 8,
        baseScoreFor: () => 1540,
        incomingPlayerBridgeCreditFor: () => 7,
        uncertaintyFor: () => 40,
      },
      callbackSemanticIds: {
        ...causalContext.callbackSemanticIds,
        rosterValidityFor: 'synergy-and-roster-validity-v2',
        stagePointsFor: 'tournament-placement-complete-v2',
        baseScoreFor: 'team-base-v2',
        incomingPlayerBridgeCreditFor: 'resume-bridge-v2',
        uncertaintyFor: 'team-uncertainty-v2',
      },
    },
  })
  assertFullContextReplay(contextDecision, 'context-changed')
  assertFullContextReplay(reconcileDssTeamCausality({
    summary,
    freshMatches: [first, appended],
    causalContext: {
      options,
      callbackSemanticIds: { ...causalContext.callbackSemanticIds, uncertaintyFor: undefined },
    },
  }), 'context-unproven')
  assertFullContextReplay(reconcileDssTeamCausality({
    summary,
    freshMatches: [first, appended],
    causalContext: {
      ...causalContext,
      options: { ...options, eventWeightContext: eventContext('2026-01-11') },
    },
  }), 'context-changed')

  assert.deepEqual(
    recomputeDssTeamCausalState([first, appended], causalContext),
    buildDeservedStandingModel([first, appended], options),
  )
})

test('DSS region causality replays historical team-region corrections and preserves clean output parity', () => {
  const matches = [matchFixture({ id: 'international', date: '2026-01-02' })]
  const teams = teamProfiles()
  const options = {
    eventWeightContext: eventContext('2026-01-10'),
    regionPriorFor: (region: Region) => region === 'LCK' ? 1520 : 1500,
    teamRegionFor: (team: string) => teams[team]?.region ?? 'International' as Region,
  }
  const causalContext = {
    options,
    callbackSemanticIds: {
      regionPriorFor: 'region-prior-v1',
      teamRegionFor: 'team-region-v1',
    },
  }
  const summary = buildDssRegionCausalSummary({
    prefixMatches: matches,
    teams,
    processedThroughUtcDate: '2026-01-02',
    causalContext,
  })
  const correctedTeams = { ...teams, Alpha: { ...teams.Alpha, region: 'LEC' as Region, league: 'LEC' } }
  const decision = reconcileDssRegionCausality({
    summary,
    freshMatches: matches,
    teams: correctedTeams,
    causalContext,
  })

  assertFullContextReplay(decision, 'context-changed')
  const changedRegionCallback = reconcileDssRegionCausality({
    summary,
    freshMatches: matches,
    teams,
    causalContext: {
      options: { ...options, regionPriorFor: () => 1600 },
      callbackSemanticIds: { ...causalContext.callbackSemanticIds, regionPriorFor: 'region-prior-v2' },
    },
  })
  assertFullContextReplay(changedRegionCallback, 'context-changed')
  assert.deepEqual(
    recomputeDssRegionCausalState(matches, teams, causalContext),
    buildDeservedStandingRegionModel(matches, teams, options),
  )
})

test('roster-era causality recomputes an appended open era from its start and replays same-day substitutions', () => {
  const first = matchFixture({
    id: 'roster-one',
    date: '2026-01-02',
    teamARoster: roster('alpha'),
    teamBRoster: roster('beta'),
  })
  const options = {
    coachIdFor: () => 'coach-a',
    resumeLedgerIdsFor: ({ matchId }: { matchId: string }) => [`resume:${matchId}`],
    uncertaintyFor: () => 10,
  }
  const causalContext = {
    options,
    callbackSemanticIds: {
      coachIdFor: 'coach-identity-v1',
      resumeLedgerIdsFor: 'resume-ledger-attribution-v1',
      uncertaintyFor: 'roster-era-uncertainty-v1',
    },
  }
  const summary = buildDssRosterEraCausalSummary({
    prefixMatches: [first],
    processedThroughUtcDate: '2026-01-02',
    causalContext,
  })
  const changedRoster = roster('alpha', { Mid: 'alpha-new-mid' })
  const appended = matchFixture({
    id: 'roster-two',
    date: '2026-01-03',
    teamARoster: changedRoster,
    teamBRoster: roster('beta'),
  })
  const appendDecision = reconcileDssRosterEraCausality({ summary, freshMatches: [first, appended], causalContext })
  assert.equal(appendDecision.status, 'recompute-ready')
  if (appendDecision.status === 'recompute-ready') {
    assert.equal(appendDecision.earliestRecomputeUtcDate, '2026-01-02')
  }

  const substitution = matchFixture({
    id: 'same-day-substitution',
    date: '2026-01-02',
    teamARoster: changedRoster,
    teamBRoster: roster('beta'),
  })
  const substitutionDecision = reconcileDssRosterEraCausality({
    summary,
    freshMatches: [first, substitution, appended],
    causalContext,
  })
  assert.equal(substitutionDecision.status, 'replay-required')
  if (substitutionDecision.status === 'replay-required') {
    assert.equal(substitutionDecision.replayFromUtcDate, '2026-01-02')
  }
  assertFullContextReplay(reconcileDssRosterEraCausality({
    summary,
    freshMatches: [first, appended],
    causalContext: {
      options: { ...options, coachIdFor: () => 'coach-b' },
      callbackSemanticIds: { ...causalContext.callbackSemanticIds, coachIdFor: 'coach-identity-v2' },
    },
  }), 'context-changed')
  assert.deepEqual(
    recomputeDssRosterEraCausalState([first, appended], causalContext),
    buildDssRosterEras([first, appended], options),
  )
})

test('player resume causality accepts append, catches historical series corrections, and preserves parity', () => {
  const first = resumeSeries({ seriesKey: 'first', date: '2026-01-02' })
  const options = {
    currentSeason: 2026,
    currentSplitId: 'spring',
    uncertaintyFor: () => 12,
  }
  const causalContext = { options, uncertaintyForSemanticId: 'resume-uncertainty-v1' }
  const summary = buildDssPlayerResumeCausalSummary({
    prefixSeries: [first],
    processedThroughUtcDate: '2026-01-02',
    causalContext,
  })
  const appended = resumeSeries({ seriesKey: 'second', date: '2026-01-03', weightedSeriesValue: -4 })

  assert.equal(reconcileDssPlayerResumeCausality({
    summary,
    freshSeries: [first, appended],
    causalContext,
  }).status, 'recompute-ready')
  const corrected = resumeSeries({ seriesKey: 'first', date: '2026-01-02', weightedSeriesValue: 22 })
  const correctionDecision = reconcileDssPlayerResumeCausality({
    summary,
    freshSeries: [corrected, appended],
    causalContext,
  })
  assert.equal(correctionDecision.status, 'replay-required')
  if (correctionDecision.status === 'replay-required') {
    assert.equal(correctionDecision.replayFromUtcDate, '2026-01-02')
  }
  assertFullContextReplay(reconcileDssPlayerResumeCausality({
    summary,
    freshSeries: [first, appended],
    causalContext: {
      options: { ...options, currentSplitId: 'summer', uncertaintyFor: () => 30 },
      uncertaintyForSemanticId: 'resume-uncertainty-v2',
    },
  }), 'context-changed')
  assertFullContextReplay(reconcileDssPlayerResumeCausality({
    summary,
    freshSeries: [first, appended],
    causalContext: { options },
  }), 'context-unproven')
  assert.deepEqual(
    recomputeDssPlayerResumeCausalState([corrected, appended], causalContext),
    buildDssPlayerResumeLedgers([corrected, appended], options),
  )
})

test('inventory exposes every external contract without activating production resume', () => {
  assert.deepEqual(snapshotExternalCausalSurfaces, [
    'sourced-player',
    'dss-team',
    'dss-region',
    'roster-era',
    'player-resume-ledger',
  ])
  assert.deepEqual(
    ratingCheckpointInventory.externalState.map((entry) => entry.status),
    [
      'causal-full-recompute',
      'causal-full-recompute',
      'causal-full-recompute',
      'causal-full-recompute',
      'causal-full-recompute',
      'checkpoint-reconciled',
    ],
  )
  assert.equal(ratingCheckpointInventory.activation, 'feature-gated-production-disabled')
})

function assertFullContextReplay(
  decision: CausalRecomputeDecision,
  reason: 'context-changed' | 'context-unproven',
) {
  assert.equal(decision.status, 'replay-required')
  if (decision.status !== 'replay-required') return
  assert.equal(decision.reason, reason)
  assert.equal(decision.requiresFullReplay, true)
  assert.equal(decision.requiresWholeUtcDateReplay, true)
  assert.deepEqual(decision.changedKeys, ['$context'])
}

function eventContext(worldsEndDate: string) {
  return { worldsEndDateByCalendarYear: new Map([[2026, worldsEndDate]]) }
}

function leagueStrength(league: string, region: Region, score: number): LeagueStrength {
  return {
    league,
    region,
    tier: 'tier-one',
    priorScore: score,
    rawScore: score,
    connectivity: 1,
    score,
    adjustment: score - 1500,
    delta: 0,
    wins: 0,
    losses: 0,
    internationalMatches: 0,
    form: [],
  }
}

function sourcedMatch(overrides: Partial<MatchRecord> = {}): MatchRecord {
  const winner = overrides.winner ?? 'Alpha'
  return matchFixture({
    sourceProvider: 'oracles-elixir',
    teamARoster: sourcedRoster('alpha', 'blue', winner === 'Alpha'),
    teamBRoster: sourcedRoster('beta', 'red', winner === 'Beta'),
    ...overrides,
  })
}

function sourcedRoster(
  prefix: string,
  side: Side,
  won: boolean,
  statOverrides: Partial<Record<Role, { kills?: number }>> = {},
): MatchRosterSnapshot {
  return {
    ...roster(prefix),
    players: roster(prefix).players.map((player) => ({
      ...player,
      stats: {
        side,
        won,
        kills: statOverrides[player.role]?.kills ?? (won ? 4 : 2),
        deaths: won ? 2 : 4,
        assists: won ? 9 : 5,
        damageShare: 0.2,
        earnedGoldShare: 0.2,
        vspm: player.role === 'Support' ? 2.2 : 1,
      },
    })),
  }
}

function roster(prefix: string, ids: Partial<Record<Role, string>> = {}): MatchRosterSnapshot {
  const roles: Role[] = ['Top', 'Jungle', 'Mid', 'Bot', 'Support']
  return {
    sourceProvider: 'oracles-elixir',
    teamId: prefix,
    observedAt: '2026-01-01',
    completeness: 'complete-five-role',
    players: roles.map((role) => ({
      id: ids[role] ?? `${prefix}-${role}`,
      name: `${prefix} ${role}`,
      role,
    })),
  }
}

function teamProfiles(): Record<string, TeamProfile> {
  return {
    Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
    Beta: { name: 'Beta', code: 'BET', region: 'LPL', league: 'LPL' },
  }
}

function resumeSeries(overrides: Partial<DssPlayerResumeSeriesInput> = {}): DssPlayerResumeSeriesInput {
  return {
    seriesKey: 'series',
    date: '2026-01-02',
    season: 2026,
    splitId: 'spring',
    event: 'Worlds 2026',
    tier: 'worlds-main',
    team: 'Alpha',
    weightedSeriesValue: 10,
    players: [
      { id: 'alpha-Mid', role: 'Mid', share: 0.5 },
      { id: 'alpha-Support', role: 'Support', share: 0.2 },
    ],
    ...overrides,
  }
}

function matchFixture(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    id: 'fixture',
    sourceProvider: 'seed',
    sourceGameId: overrides.id ?? 'fixture',
    dataCompleteness: 'scoreboard-game-stats',
    date: '2026-01-02',
    season: 2026,
    event: 'Worlds 2026',
    phase: 'Main event',
    region: 'International',
    league: 'Worlds',
    teamAHomeLeague: 'LCK',
    teamBHomeLeague: 'LPL',
    teamARegion: 'LCK',
    teamBRegion: 'LPL',
    patch: '26.1',
    bestOf: 1,
    tier: 'worlds-main',
    teamA: 'Alpha',
    teamB: 'Beta',
    winner: 'Alpha',
    teamAKills: 20,
    teamBKills: 12,
    teamAGold: 65000,
    teamBGold: 59000,
    ...overrides,
  }
}
