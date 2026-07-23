import assert from 'node:assert/strict'
import test from 'node:test'
import type { MatchRecord, MatchRosterSnapshot, TeamProfile } from '../src/types.ts'
import {
  buildRankingModel,
  createRatingReplayContext,
  materializeRankingModel,
  replayRatingDates,
} from '../src/lib/model.ts'
import { createRatingRunState } from '../src/lib/ratingRunState.ts'
import { replayRankingState } from '../src/lib/incremental/replayOrchestrator.ts'

const teams: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
  Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
  Gamma: { name: 'Gamma', code: 'GAM', region: 'LPL', league: 'LPL' },
}

test('legacy wrapper and reusable full replay remain exactly compatible', () => {
  const matches = corpus()
  const legacy = buildRankingModel(matches, structuredClone(teams))
  const context = createRatingReplayContext(matches, structuredClone(teams))
  const state = replayRatingDates({ context, replayMatches: context.authoritativeMatches })
  assert.deepEqual(materializeRankingModel({ context, state }), legacy)
})

test('resumed replay equals a full replay for append, same-day insertion, correction, roster substitution, and tournament placement', () => {
  const scenarios = [
    corpus(),
    [...corpus(), fixture({ id: 'same-day-insert', date: '2026-01-02', winner: 'Beta', teamARoster: roster('alpha-sub') })],
    corpus().map((match) => match.id === 'day-two' ? { ...match, winner: 'Beta', teamARoster: roster('alpha-sub') } : match),
    [...corpus(), fixture({ id: 'international-final', date: '2026-01-04', event: 'MSI 2026', tier: 'msi-bracket', teamB: 'Gamma', league: 'International', region: 'International' })],
  ]
  for (const authoritativeMatches of scenarios) {
    const replayFromUtcDate = '2026-01-02'
    const context = createRatingReplayContext(authoritativeMatches, structuredClone(teams))
    const checkpointState = createRatingRunState(
      context.authoritativeMatches,
      context.teams,
      context.eventWeightContext,
      context.tournamentLifecycles,
    )
    replayRatingDates({
      context,
      state: checkpointState,
      replayMatches: context.authoritativeMatches.filter((match) => match.date < replayFromUtcDate),
    })
    const resumed = replayRankingState({
      authoritativeMatches,
      teams: structuredClone(teams),
      checkpointState,
      replayFromUtcDate,
    })
    const full = replayRankingState({ authoritativeMatches, teams: structuredClone(teams) })
    assert.deepEqual(resumed.model, full.model)
    assert.deepEqual(resumed.state, full.state)
  }
})

test('replay rejects a partial UTC date and a checkpoint on the affected date', () => {
  const matches = [...corpus(), fixture({ id: 'day-two-extra', date: '2026-01-02' })]
  const context = createRatingReplayContext(matches, structuredClone(teams))
  assert.throws(
    () => replayRatingDates({ context, replayMatches: [matches.find((match) => match.id === 'day-two')!] }),
    /complete authoritative UTC date/,
  )
  const state = createRatingRunState(context.authoritativeMatches, context.teams, context.eventWeightContext)
  replayRatingDates({ context, state, replayMatches: context.authoritativeMatches.filter((match) => match.date <= '2026-01-02') })
  assert.throws(() => replayRankingState({
    authoritativeMatches: matches,
    teams: structuredClone(teams),
    checkpointState: state,
    replayFromUtcDate: '2026-01-02',
  }), /strictly earlier/)
})

function corpus() {
  return [
    fixture({ id: 'day-one', date: '2026-01-01' }),
    fixture({ id: 'day-two', date: '2026-01-02', winner: 'Beta' }),
    fixture({ id: 'day-three', date: '2026-01-03', event: 'MSI 2026', tier: 'msi-bracket', teamB: 'Gamma', league: 'International', region: 'International' }),
  ]
}

function fixture(overrides: Partial<MatchRecord>): MatchRecord {
  return {
    id: 'match',
    sourceProvider: 'oracles-elixir',
    sourceGameId: overrides.id ?? 'match',
    sourceMatchId: overrides.id ?? 'match',
    date: '2026-01-01',
    season: 2026,
    event: 'LCK 2026',
    phase: 'Regular season',
    region: 'LCK',
    league: 'LCK',
    patch: '26.1',
    bestOf: 1,
    tier: 'regional-regular',
    teamA: 'Alpha',
    teamB: 'Beta',
    winner: 'Alpha',
    teamAKills: 10,
    teamBKills: 5,
    teamAGold: 60_000,
    teamBGold: 55_000,
    teamARoster: roster('alpha'),
    teamBRoster: roster('beta'),
    ...overrides,
  }
}

function roster(prefix: string): MatchRosterSnapshot {
  return {
    sourceProvider: 'oracles-elixir',
    observedAt: '2026-01-01T00:00:00.000Z',
    completeness: 'complete-five-role',
    players: ['Top', 'Jungle', 'Mid', 'Bot', 'Support'].map((role) => ({
      id: `${prefix}-${role}`,
      name: `${prefix}-${role}`,
      role: role as 'Top' | 'Jungle' | 'Mid' | 'Bot' | 'Support',
    })),
  }
}
