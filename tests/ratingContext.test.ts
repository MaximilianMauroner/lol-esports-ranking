import assert from 'node:assert/strict'
import test from 'node:test'
import { leaguePriorFor } from '../src/data/leagueTiers.ts'
import {
  momentumPatchRetention,
  momentumSplitRetention,
  normalPatchTeamRetention,
  recencyHalfLifeDays,
  seasonStartLeagueRetention,
  seasonStartTeamRetention,
  splitBreakLeagueRetention,
  splitBreakMinimumGapDays,
  splitBreakTeamRetention,
} from '../src/lib/modelConfig.ts'
import {
  applyEntityLocalContextDecayForDate,
  type EntityLocalRatingContext,
} from '../src/lib/ratingContext.ts'
import type { MatchRecord, TeamProfile } from '../src/types.ts'

const teams: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
  Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
  Gamma: { name: 'Gamma', code: 'GAM', region: 'LPL', league: 'LPL' },
  Delta: { name: 'Delta', code: 'DEL', region: 'LPL', league: 'LPL' },
}

const config = {
  initialTeamRating: 1500,
  recencyHalfLifeDays,
  normalPatchTeamRetention,
  splitBreakTeamRetention,
  seasonStartTeamRetention,
  splitBreakLeagueRetention,
  seasonStartLeagueRetention,
  splitBreakMinimumGapDays,
  momentumSplitRetention,
  momentumPatchRetention,
}

test('target decay is unchanged by unrelated matches inserted inside the gap', () => {
  const direct = scenarioState()
  const inserted = scenarioState()
  initializeTarget(direct)
  initializeTarget(inserted)

  applyEntityLocalContextDecayForDate([match('target-later', '2026-06-30')], teams, [direct.ratings], direct.momentums, direct.leagues, direct.context, config)
  for (let day = 1; day <= 179; day += 1) {
    const date = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10)
    applyEntityLocalContextDecayForDate([match(`other-${day}`, date, 'Gamma', 'Delta')], teams, [inserted.ratings], inserted.momentums, inserted.leagues, inserted.context, config)
  }
  applyEntityLocalContextDecayForDate([match('target-later', '2026-06-30')], teams, [inserted.ratings], inserted.momentums, inserted.leagues, inserted.context, config)

  assert.ok(Math.abs(direct.ratings.get('Alpha')! - inserted.ratings.get('Alpha')!) < 0.001)
  assert.ok(Math.abs(direct.leagues.get('LCK')! - inserted.leagues.get('LCK')!) < 0.001)
})

test('patch and split boundaries apply only to the participating team and league', () => {
  const state = scenarioState()
  initializeTarget(state)
  const alphaBefore = state.ratings.get('Alpha')!
  const lckBefore = state.leagues.get('LCK')!

  applyEntityLocalContextDecayForDate([
    match('unrelated-boundary', '2026-02-15', 'Gamma', 'Delta', { event: 'LPL Summer 2026', patch: '26.4' }),
  ], teams, [state.ratings], state.momentums, state.leagues, state.context, config)

  assert.equal(state.ratings.get('Alpha'), alphaBefore)
  assert.equal(state.leagues.get('LCK'), lckBefore)

  const own = match('own-boundary', '2026-02-15', 'Alpha', 'Beta', { event: 'LCK Summer 2026', patch: '26.4' })
  applyEntityLocalContextDecayForDate([own], teams, [state.ratings], state.momentums, state.leagues, state.context, config)
  const timeRetention = 2 ** (-45 / recencyHalfLifeDays)
  const expectedTeam = 1500 + (alphaBefore - 1500) * timeRetention * splitBreakTeamRetention
  const lckPrior = leaguePriorFor('LCK')
  const expectedLeague = lckPrior + (lckBefore - lckPrior) * timeRetention * splitBreakLeagueRetention

  assert.ok(Math.abs(state.ratings.get('Alpha')! - expectedTeam) < 0.001)
  assert.ok(Math.abs(state.leagues.get('LCK')! - expectedLeague) < 0.001)
})

function scenarioState() {
  return {
    ratings: new Map([['Alpha', 1600], ['Beta', 1400], ['Gamma', 1550], ['Delta', 1450]]),
    momentums: new Map([['Alpha', 20], ['Beta', -20], ['Gamma', 10], ['Delta', -10]]),
    leagues: new Map([['LCK', 1600], ['LPL', 1500]]),
    context: emptyContext(),
  }
}

function initializeTarget(state: ReturnType<typeof scenarioState>) {
  state.context.teamLastRatedDates.set('Alpha', '2026-01-01')
  state.context.teamLastRatedDates.set('Beta', '2026-01-01')
  state.context.teamLastSeasons.set('Alpha', 2026)
  state.context.teamLastSeasons.set('Beta', 2026)
  state.context.teamLastSplits.set('Alpha', '2026:spring')
  state.context.teamLastSplits.set('Beta', '2026:spring')
  state.context.lastPatchByTeam.set('Alpha', '26.1')
  state.context.lastPatchByTeam.set('Beta', '26.1')
  state.context.leagueLastRatedDates.set('LCK', '2026-01-01')
  state.context.leagueLastSeasons.set('LCK', 2026)
  state.context.leagueLastSplits.set('LCK', '2026:spring')
}

function emptyContext(): EntityLocalRatingContext {
  return {
    teamLastRatedDates: new Map(),
    teamLastSeasons: new Map(),
    teamLastSplits: new Map(),
    leagueLastRatedDates: new Map(),
    leagueLastSeasons: new Map(),
    leagueLastSplits: new Map(),
    lastPatchByTeam: new Map(),
  }
}

function match(
  id: string,
  date: string,
  teamA = 'Alpha',
  teamB = 'Beta',
  overrides: Partial<MatchRecord> = {},
): MatchRecord {
  return {
    id,
    date,
    season: 2026,
    event: 'LCK Spring 2026',
    phase: 'Regular Season',
    region: teamA === 'Alpha' ? 'LCK' : 'LPL',
    league: teamA === 'Alpha' ? 'LCK' : 'LPL',
    patch: '26.1',
    bestOf: 3,
    tier: 'regional-regular',
    teamA,
    teamB,
    winner: teamA,
    teamAKills: 10,
    teamBKills: 5,
    teamAGold: 50_000,
    teamBGold: 45_000,
    ...overrides,
  }
}
