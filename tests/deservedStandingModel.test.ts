import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDeservedStandingModel } from '../src/lib/deservedStandingModel.ts'
import type { MatchRecord } from '../src/types.ts'

test('buildDeservedStandingModel ranks teams by Team DSS from series ledgers', () => {
  const model = buildDeservedStandingModel([
    matchFixture({ id: 'alpha-win-1', winner: 'Alpha' }),
    matchFixture({ id: 'alpha-win-2', date: '2026-01-02', winner: 'Alpha' }),
  ])
  const alpha = teamFor(model, 'Alpha')
  const beta = teamFor(model, 'Beta')

  assert.equal(alpha.rank, 1)
  assert.equal(beta.rank, 2)
  assert.equal(alpha.wins, 2)
  assert.equal(beta.losses, 2)
  assert.ok(alpha.dss > 1500)
  assert.ok(beta.dss < 1500)
})

test('buildDeservedStandingModel applies team-specific base scores', () => {
  const model = buildDeservedStandingModel([matchFixture({ id: 'alpha-win', winner: 'Alpha' })], {
    baseScoreFor: (team) => team === 'Alpha' ? 1400 : 1700,
  })
  const alpha = teamFor(model, 'Alpha')
  const beta = teamFor(model, 'Beta')

  assert.equal(alpha.components.baseScore, 1400)
  assert.equal(beta.components.baseScore, 1700)
  assert.ok(beta.dss > alpha.dss)
})

test('buildDeservedStandingModel prices wins above expectation through reference strengths', () => {
  const matches = [matchFixture({ id: 'alpha-upset', winner: 'Alpha' })]
  const favored = buildDeservedStandingModel(matches, {
    referenceStrengthFor: ({ team }) => team === 'Alpha' ? 1700 : 1400,
  })
  const upset = buildDeservedStandingModel(matches, {
    referenceStrengthFor: ({ team }) => team === 'Alpha' ? 1400 : 1700,
  })
  const favoredAlpha = teamFor(favored, 'Alpha')
  const upsetAlpha = teamFor(upset, 'Alpha')

  assert.ok(upsetAlpha.winsAboveExpectation > favoredAlpha.winsAboveExpectation)
  assert.ok(upsetAlpha.dss > favoredAlpha.dss)
})

test('buildDeservedStandingModel applies roster validity to current-roster resume and schedule components', () => {
  const matches = [matchFixture({ id: 'alpha-win', winner: 'Alpha' })]
  const fullCredit = buildDeservedStandingModel(matches)
  const halfCredit = buildDeservedStandingModel(matches, {
    rosterValidityFor: (entry) => entry.team === 'Alpha' ? 0.5 : 1,
  })
  const fullAlpha = teamFor(fullCredit, 'Alpha')
  const halfAlpha = teamFor(halfCredit, 'Alpha')

  assert.equal(fullAlpha.currentRosterValidity, 1)
  assert.equal(halfAlpha.currentRosterValidity, 0.5)
  assert.ok(fullAlpha.components.resumePoints > halfAlpha.components.resumePoints)
  assert.ok(halfAlpha.components.instabilityPenalty > fullAlpha.components.instabilityPenalty)
  assert.ok(fullAlpha.dss > halfAlpha.dss)
})

test('buildDeservedStandingModel carries optional stage, bridge, and conservative components', () => {
  const model = buildDeservedStandingModel([matchFixture({ id: 'alpha-win', winner: 'Alpha' })], {
    stagePointsFor: (team) => team === 'Alpha' ? 6 : 0,
    incomingPlayerBridgeCreditFor: (team) => team === 'Alpha' ? 4 : 0,
    uncertaintyFor: (team) => team === 'Alpha' ? 80 : undefined,
  })
  const alpha = teamFor(model, 'Alpha')

  assert.equal(alpha.components.stagePoints, 6)
  assert.equal(alpha.components.incomingPlayerBridgeCredit, 4)
  assert.equal(alpha.conservativeDss, alpha.dss - 28)
})

function teamFor(model: ReturnType<typeof buildDeservedStandingModel>, team: string) {
  const row = model.teams.find((entry) => entry.team === team)
  assert.ok(row)
  return row
}

function matchFixture(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    id: 'fixture',
    sourceProvider: 'seed',
    sourceGameId: 'fixture',
    dataCompleteness: 'scoreboard-game-stats',
    date: '2026-01-01',
    season: 2026,
    event: 'LCK 2026 Spring',
    phase: 'Regular season',
    region: 'LCK',
    league: 'LCK',
    teamAHomeLeague: 'LCK',
    teamBHomeLeague: 'LCK',
    teamARegion: 'LCK',
    teamBRegion: 'LCK',
    patch: '26.1',
    bestOf: 1,
    tier: 'regional-regular',
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
