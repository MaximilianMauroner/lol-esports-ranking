import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDeservedStandingRegionModel } from '../src/lib/deservedStandingRegions.ts'
import type { MatchRecord, Region, TeamProfile } from '../src/types.ts'

test('buildDeservedStandingRegionModel ranks regions from cross-region resume ledgers', () => {
  const model = buildDeservedStandingRegionModel([
    matchFixture({ id: 'alpha-win', teamA: 'Alpha', teamB: 'Beta', winner: 'Alpha', teamARegion: 'LCK', teamBRegion: 'LPL', teamAHomeLeague: 'LCK', teamBHomeLeague: 'LPL' }),
    matchFixture({ id: 'gamma-win', teamA: 'Gamma', teamB: 'Delta', winner: 'Gamma', teamARegion: 'LCK', teamBRegion: 'LPL', teamAHomeLeague: 'LCK', teamBHomeLeague: 'LPL' }),
  ], teamProfiles())
  const lck = regionFor(model, 'LCK')
  const lpl = regionFor(model, 'LPL')

  assert.equal(lck.rank, 1)
  assert.equal(lpl.rank, 2)
  assert.equal(model.ledgerEntries.length, 4)
  assert.equal(lck.internationalWins, 2)
  assert.equal(lck.internationalLosses, 0)
  assert.equal(lpl.internationalWins, 0)
  assert.equal(lpl.internationalLosses, 2)
  assert.ok(lck.internationalWinsAboveExpectation > 0)
  assert.ok(lck.dss > lpl.dss)
  assert.deepEqual(lck.topTeams.map((team) => team.team), ['Alpha', 'Gamma'])
})

test('buildDeservedStandingRegionModel applies roster validity, seed hooks, and stage caps', () => {
  const matches = Array.from({ length: 3 }, (_, index) => matchFixture({
    id: `worlds-bo5-${index + 1}`,
    sourceGameId: `worlds-bo5_${index + 1}`,
    gameNumber: index + 1,
    event: 'Worlds 2026',
    league: 'Worlds',
    region: 'International',
    tier: 'worlds-playoffs',
    bestOf: 5,
    teamA: 'Alpha',
    teamB: 'Beta',
    winner: 'Alpha',
    teamARegion: 'LCK',
    teamBRegion: 'LPL',
    teamAHomeLeague: 'LCK',
    teamBHomeLeague: 'LPL',
  }))
  const model = buildDeservedStandingRegionModel(matches, teamProfiles(), {
    rosterValidityFor: (entry) => entry.team === 'Alpha' ? 0.5 : 1,
    seedExpectedSeriesResultFor: ({ entry }) => entry.team === 'Alpha' ? 0.25 : 0.75,
    regionStagePointsFor: (region) => region === 'LCK' ? 20 : 0,
  })
  const lck = regionFor(model, 'LCK')

  near(lck.effectiveInternationalWeight, 22.5)
  near(lck.seedPerformanceRate, 0.75)
  assert.ok(lck.seedPerformancePoints > 0)
  assert.equal(lck.stagePoints, Math.abs(lck.internationalResumePoints) * 0.2)
  assert.equal(lck.bo5Record.wins, 1)
  assert.equal(lck.bo5Record.losses, 0)
})

test('buildDeservedStandingRegionModel keeps same-number seed baselines region-specific', () => {
  const model = buildDeservedStandingRegionModel([
    matchFixture({
      id: 'lpl-seed-one-vs-lcs-seed-one',
      teamA: 'Beta',
      teamB: 'Zeta',
      winner: 'Beta',
      teamARegion: 'LPL',
      teamBRegion: 'LCS',
      teamAHomeLeague: 'LPL',
      teamBHomeLeague: 'LCS',
      teamASeed: 1,
      teamBSeed: 1,
    }),
  ], teamProfiles(), {
    seedExpectedSeriesResultFor: ({ region, seed }) => {
      assert.equal(seed, 1)
      return region === 'LPL' ? 0.65 : 0.25
    },
  })
  const lpl = regionFor(model, 'LPL')
  const lcs = regionFor(model, 'LCS')

  near(lpl.ledgerEntries[0]?.seedExpectedSeriesResult ?? -1, 0.65)
  near(lcs.ledgerEntries[0]?.seedExpectedSeriesResult ?? -1, 0.25)
  assert.ok(lpl.seedPerformanceRate > 0)
  assert.ok(lcs.seedPerformanceRate < 0)
})

test('buildDeservedStandingRegionModel applies default region-specific seed expectations', () => {
  const model = buildDeservedStandingRegionModel([
    matchFixture({
      id: 'default-lpl-seed-one-vs-lcs-seed-one',
      teamA: 'Beta',
      teamB: 'Zeta',
      winner: 'Beta',
      teamARegion: 'LPL',
      teamBRegion: 'LCS',
      teamAHomeLeague: 'LPL',
      teamBHomeLeague: 'LCS',
      teamASeed: 1,
      teamBSeed: 1,
    }),
  ], teamProfiles())
  const lpl = regionFor(model, 'LPL')
  const lcs = regionFor(model, 'LCS')
  const lplExpectation = lpl.ledgerEntries[0]?.seedExpectedSeriesResult
  const lcsExpectation = lcs.ledgerEntries[0]?.seedExpectedSeriesResult

  assert.equal(lpl.ledgerEntries[0]?.teamSeed, 1)
  assert.equal(lcs.ledgerEntries[0]?.teamSeed, 1)
  assert.ok(typeof lplExpectation === 'number' && lplExpectation > 0.5)
  assert.ok(typeof lcsExpectation === 'number' && lcsExpectation < 0.5)
  assert.notEqual(lplExpectation, lcsExpectation)
})

test('buildDeservedStandingRegionModel keeps same-region games out of international resume and shrinks to prior', () => {
  const model = buildDeservedStandingRegionModel([
    matchFixture({
      id: 'lck-domestic',
      teamA: 'Alpha',
      teamB: 'Gamma',
      winner: 'Alpha',
      teamARegion: 'LCK',
      teamBRegion: 'LCK',
      teamAHomeLeague: 'LCK',
      teamBHomeLeague: 'LCK',
    }),
  ], teamProfiles(), {
    regionPriorFor: (region) => region === 'LCK' ? 1525 : 1500,
  })
  const lck = regionFor(model, 'LCK')

  assert.equal(model.ledgerEntries.length, 0)
  assert.equal(lck.effectiveInternationalWeight, 0)
  assert.equal(lck.connectivity, 0)
  assert.equal(lck.dss, 1525)
  assert.equal(lck.internationalWins, 0)
  assert.equal(lck.internationalLosses, 0)
})

test('buildDeservedStandingRegionModel uses team profiles for competition-only rows without side metadata', () => {
  const model = buildDeservedStandingRegionModel([
    matchFixture({
      id: 'profile-only-worlds',
      teamA: 'Alpha',
      teamB: 'Beta',
      winner: 'Alpha',
      teamAHomeLeague: undefined,
      teamBHomeLeague: undefined,
      teamARegion: undefined,
      teamBRegion: undefined,
    }),
  ], teamProfiles())
  const lck = regionFor(model, 'LCK')
  const lpl = regionFor(model, 'LPL')

  assert.equal(model.ledgerEntries.length, 2)
  assert.equal(lck.internationalWins, 1)
  assert.equal(lpl.internationalLosses, 1)
})

test('buildDeservedStandingRegionModel uses top two and top four eligible team residuals for region depth', () => {
  const model = buildDeservedStandingRegionModel([
    matchFixture({ id: 'alpha-win', teamA: 'Alpha', teamB: 'Beta', winner: 'Alpha', teamARegion: 'LCK', teamBRegion: 'LPL', teamAHomeLeague: 'LCK', teamBHomeLeague: 'LPL' }),
    matchFixture({ id: 'gamma-win', teamA: 'Gamma', teamB: 'Beta', winner: 'Gamma', teamARegion: 'LCK', teamBRegion: 'LPL', teamAHomeLeague: 'LCK', teamBHomeLeague: 'LPL', date: '2026-01-02' }),
    matchFixture({ id: 'epsilon-loss', teamA: 'Epsilon', teamB: 'Beta', winner: 'Beta', teamARegion: 'LCK', teamBRegion: 'LPL', teamAHomeLeague: 'LCK', teamBHomeLeague: 'LPL', date: '2026-01-03' }),
  ], teamProfiles(), {
    teamEligibleForDepth: (team) => team.team !== 'Epsilon',
  })
  const lck = regionFor(model, 'LCK')

  assert.deepEqual(lck.topTeams.map((team) => team.team), ['Alpha', 'Gamma'])
  near(lck.topEndScore, lck.depthScore)
  assert.ok(lck.topEndScore > 0)
})

function regionFor(model: ReturnType<typeof buildDeservedStandingRegionModel>, region: Region) {
  const row = model.regions.find((entry) => entry.region === region)
  assert.ok(row)
  return row
}

function teamProfiles(): Record<string, TeamProfile> {
  return {
    Alpha: teamProfile('Alpha', 'LCK'),
    Beta: teamProfile('Beta', 'LPL'),
    Gamma: teamProfile('Gamma', 'LCK'),
    Delta: teamProfile('Delta', 'LPL'),
    Epsilon: teamProfile('Epsilon', 'LCK'),
    Zeta: teamProfile('Zeta', 'LCS'),
  }
}

function teamProfile(name: string, region: Region): TeamProfile {
  return {
    name,
    code: name.slice(0, 3).toUpperCase(),
    region,
    league: region,
  }
}

function matchFixture(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    id: 'fixture',
    sourceProvider: 'seed',
    sourceGameId: 'fixture',
    dataCompleteness: 'scoreboard-game-stats',
    date: '2026-01-01',
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

function near(actual: number, expected: number, epsilon = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} should be within ${epsilon} of ${expected}`)
}
