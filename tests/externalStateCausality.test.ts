import assert from 'node:assert/strict'
import test from 'node:test'
import type { MatchRecord, MatchRosterSnapshot, Region, Role, Side, TeamProfile } from '../src/types.ts'
import { causalInputRow } from '../src/lib/causalRecompute.ts'
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
  const summary = buildSourcedPlayerCausalSummary({
    prefixMatches: [first],
    processedThroughUtcDate: '2026-01-02',
  })
  const appended = sourcedMatch({ id: 'appended', date: '2026-01-03', winner: 'Beta' })

  assert.deepEqual(reconcileSourcedPlayerCausality({ summary, freshMatches: [first, appended] }), {
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
  const correctionDecision = reconcileSourcedPlayerCausality({ summary, freshMatches: [corrected, appended] })
  assert.equal(correctionDecision.status, 'replay-required')
  if (correctionDecision.status === 'replay-required') {
    assert.deepEqual(correctionDecision.changedKeys, ['match:first'])
  }

  assert.deepEqual(
    recomputeSourcedPlayerCausalOutputs([first, appended], {}),
    {
      players: buildPlayerModel([first, appended], {}),
      pregameEdges: buildPregamePlayerRatingEdges([first, appended]),
    },
  )
})

test('DSS team causality covers append, synergy/config changes, and tournament completion boundaries', () => {
  const first = matchFixture({ id: 'series-one', date: '2026-01-02' })
  const synergyV1 = causalInputRow('synergy-policy', '2026-01-02', { version: 1 })
  const lifecycleOpen = causalInputRow('event:worlds-2026', '2026-01-02', { lifecycle: 'open' })
  const summary = buildDssTeamCausalSummary({
    prefixMatches: [first],
    processedThroughUtcDate: '2026-01-02',
    contextInputs: [synergyV1, lifecycleOpen],
  })
  const appended = matchFixture({ id: 'series-two', date: '2026-01-03', winner: 'Beta' })

  assert.equal(reconcileDssTeamCausality({
    summary,
    freshMatches: [first, appended],
    contextInputs: [synergyV1, lifecycleOpen],
  }).status, 'recompute-ready')

  const contextDecision = reconcileDssTeamCausality({
    summary,
    freshMatches: [first, appended],
    contextInputs: [
      causalInputRow('synergy-policy', '2026-01-02', { version: 2 }),
      causalInputRow('event:worlds-2026', '2026-01-02', { lifecycle: 'complete', placements: ['Alpha'] }),
    ],
  })
  assert.equal(contextDecision.status, 'replay-required')
  if (contextDecision.status === 'replay-required') {
    assert.equal(contextDecision.replayFromUtcDate, '2026-01-02')
    assert.deepEqual(contextDecision.changedKeys, ['event:worlds-2026', 'synergy-policy'])
  }

  assert.deepEqual(
    recomputeDssTeamCausalState([first, appended]),
    buildDeservedStandingModel([first, appended]),
  )
})

test('DSS region causality replays historical team-region corrections and preserves clean output parity', () => {
  const matches = [matchFixture({ id: 'international', date: '2026-01-02' })]
  const teams = teamProfiles()
  const summary = buildDssRegionCausalSummary({
    prefixMatches: matches,
    teams,
    processedThroughUtcDate: '2026-01-02',
  })
  const correctedTeams = { ...teams, Alpha: { ...teams.Alpha, region: 'LEC' as Region, league: 'LEC' } }
  const decision = reconcileDssRegionCausality({ summary, freshMatches: matches, teams: correctedTeams })

  assert.equal(decision.status, 'replay-required')
  if (decision.status === 'replay-required') {
    assert.equal(decision.replayFromUtcDate, '2026-01-02')
    assert.deepEqual(decision.changedKeys, ['team-profile:Alpha'])
  }
  assert.deepEqual(
    recomputeDssRegionCausalState(matches, correctedTeams),
    buildDeservedStandingRegionModel(matches, correctedTeams),
  )
})

test('roster-era causality recomputes an appended open era from its start and replays same-day substitutions', () => {
  const first = matchFixture({
    id: 'roster-one',
    date: '2026-01-02',
    teamARoster: roster('alpha'),
    teamBRoster: roster('beta'),
  })
  const summary = buildDssRosterEraCausalSummary({
    prefixMatches: [first],
    processedThroughUtcDate: '2026-01-02',
  })
  const changedRoster = roster('alpha', { Mid: 'alpha-new-mid' })
  const appended = matchFixture({
    id: 'roster-two',
    date: '2026-01-03',
    teamARoster: changedRoster,
    teamBRoster: roster('beta'),
  })
  const appendDecision = reconcileDssRosterEraCausality({ summary, freshMatches: [first, appended] })
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
  })
  assert.equal(substitutionDecision.status, 'replay-required')
  if (substitutionDecision.status === 'replay-required') {
    assert.equal(substitutionDecision.replayFromUtcDate, '2026-01-02')
  }
  assert.deepEqual(
    recomputeDssRosterEraCausalState([first, appended]),
    buildDssRosterEras([first, appended]),
  )
})

test('player resume causality accepts append, catches historical series corrections, and preserves parity', () => {
  const first = resumeSeries({ seriesKey: 'first', date: '2026-01-02' })
  const summary = buildDssPlayerResumeCausalSummary({
    prefixSeries: [first],
    processedThroughUtcDate: '2026-01-02',
  })
  const appended = resumeSeries({ seriesKey: 'second', date: '2026-01-03', weightedSeriesValue: -4 })

  assert.equal(reconcileDssPlayerResumeCausality({ summary, freshSeries: [first, appended] }).status, 'recompute-ready')
  const corrected = resumeSeries({ seriesKey: 'first', date: '2026-01-02', weightedSeriesValue: 22 })
  const correctionDecision = reconcileDssPlayerResumeCausality({
    summary,
    freshSeries: [corrected, appended],
  })
  assert.equal(correctionDecision.status, 'replay-required')
  if (correctionDecision.status === 'replay-required') {
    assert.equal(correctionDecision.replayFromUtcDate, '2026-01-02')
  }
  assert.deepEqual(
    recomputeDssPlayerResumeCausalState([corrected, appended]),
    buildDssPlayerResumeLedgers([corrected, appended]),
  )
})

test('inventory exposes every external contract without activating production resume', () => {
  assert.deepEqual(snapshotExternalCausalSurfaces, ['sourced-player', 'dss-team', 'dss-region'])
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
  assert.equal(ratingCheckpointInventory.activation, 'foundation-only-production-disabled')
})

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
