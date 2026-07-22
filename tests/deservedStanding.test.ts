import assert from 'node:assert/strict'
import test from 'node:test'
import { kespaCupEventWeightMultiplier, preseasonEventWeightMultiplier } from '../src/data/rankingConfig.ts'
import {
  deservedStandingModelParameters,
  dssConservativeScore,
  dssCurrentRosterValidity,
  dssCurrentRosterResume,
  dssEffectiveRegionDepthTerm,
  dssEventWeight,
  dssExpectedSeriesResult,
  dssFormatMultiplier,
  dssGameWinProbability,
  dssInactivityPenalty,
  dssIncomingCreditRaw,
  dssIncomingPlayerBridgeCredit,
  dssIntegrationFactor,
  dssPlayerAsset,
  dssInstabilityPenalty,
  dssPlayerContributionShares,
  dssRawSeriesValue,
  dssRegionConnectivity,
  dssRegionRawSeriesValue,
  dssRegionScore,
  dssRegionStagePoints,
  dssRegionWeightedSeriesValue,
  dssRosterValidity,
  dssScheduleStrength,
  dssSeriesLedgerEntriesForMatches,
  dssSeriesWeight,
  dssSeriesWinProbability,
  dssStageAchievementPoints,
  dssTeamComponentsFromSeries,
  dssTeamScore,
  dssTeamUncertainty,
  dssWeightedSeriesFromLedgerEntry,
  dssWeightedSeriesValue,
} from '../src/lib/deservedStanding.ts'
import type { MatchRecord } from '../src/types.ts'

test('DSS defaults mirror the PDF constants', () => {
  assert.equal(deservedStandingModelParameters.baseScore, 1500)
  assert.equal(deservedStandingModelParameters.resumeScale, 420)
  assert.equal(deservedStandingModelParameters.scheduleScale, 90)
  assert.equal(deservedStandingModelParameters.volumePrior, 120)
  assert.deepEqual(deservedStandingModelParameters.resumeWeights, {
    actual: 0.5,
    winsAboveExpectation: 0.35,
    gameDifferentialAboveExpectation: 0.15,
  })
  assert.deepEqual(deservedStandingModelParameters.roleShares, {
    Top: 0.18,
    Jungle: 0.22,
    Mid: 0.23,
    Bot: 0.21,
    Support: 0.16,
  })
})

test('DSS event weights and format multipliers produce PDF series weights', () => {
  assert.equal(dssEventWeight('worlds-playoffs'), 36)
  assert.equal(dssEventWeight('msi-bracket'), 34)
  assert.equal(dssEventWeight('regional-regular'), 12)
  assert.equal(dssFormatMultiplier(1), 1)
  assert.equal(dssFormatMultiplier(2), 1.05)
  assert.equal(dssFormatMultiplier(3), 1.12)
  assert.equal(dssFormatMultiplier(5), 1.25)
  assert.equal(dssSeriesWeight('worlds-playoffs', 5), 45)
  near(dssSeriesWeight('regional-regular', 3), 13.44)
})

test('DSS discounts post-Worlds preseason series weight', () => {
  const ledger = dssSeriesLedgerEntriesForMatches([
    ...seriesFixture({
      id: 'worlds-final',
      winners: ['Alpha', 'Alpha', 'Alpha'],
      date: '2025-11-09',
      season: 2025,
      event: 'WLDs 2025',
      league: 'WLDs',
      region: 'International',
      tier: 'worlds-main',
      bestOf: 5,
    }),
    ...seriesFixture({
      id: 'demacia-cup',
      winners: ['Alpha', 'Alpha'],
      date: '2025-12-20',
      season: 2025,
      event: 'DCup 2025',
      league: 'DCup',
      tier: 'regional-regular',
      bestOf: 3,
    }),
  ])
  const demaciaCup = ledger.find((entry) => entry.finalMatchId === 'demacia-cup-game-2')

  assert.ok(demaciaCup)
  near(demaciaCup.seriesWeight, dssSeriesWeight('regional-regular', 3) * preseasonEventWeightMultiplier)
})

test('DSS composes KeSPA Cup and post-Worlds discounts without changing unrelated minor events', () => {
  const worlds = seriesFixture({
    id: 'worlds-final-before-kespa',
    winners: ['Alpha', 'Alpha', 'Alpha'],
    date: '2025-11-09',
    season: 2025,
    event: 'Worlds 2025',
    league: 'Worlds',
    region: 'International',
    tier: 'worlds-main',
    bestOf: 5,
  })
  const ordinaryKespa = seriesFixture({
    id: 'ordinary-kespa',
    winners: ['Alpha', 'Alpha'],
    date: '2026-07-20',
    event: 'KeSPA 2026',
    league: 'KeSPA',
    region: 'International',
    tier: 'minor-international',
    bestOf: 3,
  })
  const preseasonKespa = seriesFixture({
    id: 'preseason-kespa',
    winners: ['Alpha', 'Alpha'],
    date: '2025-12-06',
    season: 2025,
    event: 'KeSPA 2025',
    league: 'KeSPA',
    region: 'International',
    tier: 'minor-international',
    bestOf: 3,
  })
  const unrelatedMinor = seriesFixture({
    id: 'unrelated-minor',
    winners: ['Alpha', 'Alpha'],
    date: '2026-07-21',
    event: 'Esports World Cup 2026',
    league: 'EWC',
    region: 'International',
    tier: 'minor-international',
    bestOf: 3,
  })
  const ledger = dssSeriesLedgerEntriesForMatches([
    ...worlds,
    ...ordinaryKespa,
    ...preseasonKespa,
    ...unrelatedMinor,
  ])
  const weightFor = (finalMatchId: string) => ledger.find((entry) => entry.finalMatchId === finalMatchId)?.seriesWeight ?? 0
  const minorBo3 = dssSeriesWeight('minor-international', 3)

  near(weightFor('ordinary-kespa-game-2'), minorBo3 * kespaCupEventWeightMultiplier)
  near(weightFor('preseason-kespa-game-2'), minorBo3 * kespaCupEventWeightMultiplier * preseasonEventWeightMultiplier)
  near(weightFor('unrelated-minor-game-2'), minorBo3)
})

test('DSS probability helpers implement the PDF logistic and series formulas', () => {
  near(dssGameWinProbability({
    referenceStrength: 1500,
    opponentReferenceStrength: 1500,
  }), 0.5)
  assert.ok(dssGameWinProbability({
    referenceStrength: 1500,
    opponentReferenceStrength: 1500,
    contextAdjustment: 30,
  }) > 0.5)

  near(dssSeriesWinProbability(0.6, 1), 0.6)
  near(dssSeriesWinProbability(0.6, 2), 0.36)
  near(dssSeriesWinProbability(0.6, 3), 0.648)
  near(dssSeriesWinProbability(0.6, 5), 0.68256)
  near(dssExpectedSeriesResult(0.6, 2), 0.6)
  near(dssExpectedSeriesResult(0.6, 3), 0.648)
})

test('DSS raw and weighted series value reward upset and margin signals', () => {
  const sweep = dssRawSeriesValue({
    observedSeriesResult: 1,
    observedGameWinRate: 1,
    expectedSeriesResult: 0.7,
    expectedGameWinRate: 0.55,
  })
  const closeWin = dssRawSeriesValue({
    observedSeriesResult: 1,
    observedGameWinRate: 0.6,
    expectedSeriesResult: 0.7,
    expectedGameWinRate: 0.55,
  })
  const upset = dssRawSeriesValue({
    observedSeriesResult: 1,
    observedGameWinRate: 0.6,
    expectedSeriesResult: 0.3,
    expectedGameWinRate: 0.45,
  })

  near(sweep, 0.4225)
  near(closeWin, 0.3625)
  assert.ok(sweep > closeWin)
  assert.ok(upset > closeWin)
  near(dssWeightedSeriesValue({
    observedSeriesResult: 1,
    observedGameWinRate: 1,
    expectedSeriesResult: 0.7,
    expectedGameWinRate: 0.55,
    eventTier: 'worlds-playoffs',
    bestOf: 5,
  }), 19.0125)
})

test('DSS roster validity and instability follow the PDF clamps', () => {
  assert.equal(dssRosterValidity({
    retainedPlayerContributionShare: 1,
    retainedSynergy: 1,
    orgCoachContinuity: 1,
  }), 1)
  assert.equal(dssRosterValidity({
    retainedPlayerContributionShare: 0,
    retainedSynergy: 0,
    orgCoachContinuity: 0,
  }), 0.05)
  near(dssRosterValidity({
    retainedPlayerContributionShare: 0.4,
    retainedSynergy: 0.4,
    orgCoachContinuity: 1,
  }), 0.46)
  assert.equal(dssInstabilityPenalty(0.9), 0)
  near(dssInstabilityPenalty(0.5), 3)
  near(dssInstabilityPenalty(0.25), 8)
})

test('DSS current-roster resume and schedule strength use roster validity weighted denominators', () => {
  const series = [
    {
      weightedSeriesValue: 10,
      seriesWeight: 20,
      rosterValidity: 1,
      opponentReferenceStrength: 1600,
      standardOpponentReferenceStrength: 1500,
    },
    {
      weightedSeriesValue: -2,
      seriesWeight: 10,
      rosterValidity: 0.5,
      opponentReferenceStrength: 1400,
      standardOpponentReferenceStrength: 1500,
    },
  ]
  const resume = dssCurrentRosterResume(series)
  const schedule = dssScheduleStrength(series, resume.volumeReliability)

  near(resume.numerator, 9)
  near(resume.denominator, 25)
  near(resume.resumeRate, 0.36)
  near(resume.volumeReliability, Math.sqrt(25 / 145))
  near(resume.resumePoints, 420 * 0.36 * Math.sqrt(25 / 145))
  near(schedule.scheduleRate, 0.15)
  near(schedule.scheduleStrengthPoints, 90 * 0.15 * Math.sqrt(25 / 145))
})

test('DSS team score, conservative score, bridge credit, and uncertainty are composable', () => {
  const score = dssTeamScore({
    resumePoints: 32.6,
    scheduleStrengthPoints: 12.6,
    stagePoints: 7,
    incomingPlayerBridgeCredit: 4.5,
    instabilityPenalty: 1.5,
  })
  near(score, 1555.2)
  near(dssConservativeScore(score, 80), 1527.2)
  assert.equal(dssIncomingPlayerBridgeCredit(100, 0, 1), 30)
  assert.ok(dssIncomingPlayerBridgeCredit(20, 80, 1) < dssIncomingPlayerBridgeCredit(20, 0, 1))
  assert.equal(dssInactivityPenalty(30), 0)
  assert.equal(dssInactivityPenalty(60), 5)
  assert.equal(dssInactivityPenalty(90), 10)
  assert.equal(dssInactivityPenalty(91), 20)
  assert.ok(dssTeamUncertainty({ currentEraWeight: 0, currentRosterValidity: 0.5 }) > dssTeamUncertainty({ currentEraWeight: 200, currentRosterValidity: 1 }))
})

test('DSS incoming player bridge helpers use PDF asset weights and integration factors', () => {
  const asset = dssPlayerAsset({
    playerSkillOffset: 20,
    playerResumeOffset: 10,
    internationalTranslationOffset: 5,
  })
  const raw = dssIncomingCreditRaw([
    {
      role: 'Mid',
      playerSkillOffset: 20,
      playerResumeOffset: 10,
      internationalTranslationOffset: 5,
    },
    {
      role: 'Support',
      playerSkillOffset: -10,
      playerResumeOffset: -4,
      internationalTranslationOffset: 0,
    },
  ], 2)

  near(asset, 15)
  near(raw, 2 + 0.23 * 15 + 0.16 * -6.9)
  assert.equal(dssIntegrationFactor('sameRoleSameLeagueSameLanguage'), 0.9)
  assert.equal(dssIntegrationFactor('sameRoleSameRegion'), 0.8)
  assert.equal(dssIntegrationFactor('crossRegionImportSameRole'), 0.7)
  assert.equal(dssIntegrationFactor('emergencySubstitute'), 0.55)
  assert.equal(dssIntegrationFactor('offRolePlayer'), 0.45)
  assert.equal(dssIncomingPlayerBridgeCredit(100, 0, dssIntegrationFactor('sameRoleSameRegion')), 30)
  assert.ok(dssIncomingPlayerBridgeCredit(20, 80, dssIntegrationFactor('sameRoleSameRegion')) < dssIncomingPlayerBridgeCredit(20, 0, dssIntegrationFactor('sameRoleSameRegion')))
})

test('DSS stage achievement points apply roster validity and event resume cap', () => {
  assert.equal(dssStageAchievementPoints({ category: 'worlds', achievement: 'final' }), 14)
  assert.equal(dssStageAchievementPoints({ category: 'msi', achievement: 'semifinal' }), 9)
  assert.equal(dssStageAchievementPoints({ category: 'majorRegion', achievement: 'firstRound' }), 5)
  assert.equal(dssStageAchievementPoints({ category: 'minorInternational', achievement: 'qualified' }), 3)
  assert.equal(dssStageAchievementPoints({ category: 'worlds', achievement: 'final', rosterValidity: 0.5 }), 7)
  assert.equal(dssStageAchievementPoints({ category: 'worlds', achievement: 'final', eventResumePoints: 40 }), 6)
  assert.equal(dssStageAchievementPoints({ category: 'worlds', achievement: 'final', eventResumePoints: 0 }), 0)
})

test('DSS player contribution shares use base role shares and performance z clamps', () => {
  const baseShares = dssPlayerContributionShares([
    { id: 'top', role: 'Top' },
    { id: 'jungle', role: 'Jungle' },
    { id: 'mid', role: 'Mid' },
    { id: 'bot', role: 'Bot' },
    { id: 'support', role: 'Support' },
  ])
  const boosted = dssPlayerContributionShares([
    { id: 'top', role: 'Top', performanceZ: -3 },
    { id: 'jungle', role: 'Jungle' },
    { id: 'mid', role: 'Mid', performanceZ: 4 },
    { id: 'bot', role: 'Bot' },
    { id: 'support', role: 'Support' },
  ])

  near(baseShares.reduce((sum, player) => sum + player.share, 0), 1)
  near(baseShares.find((player) => player.id === 'mid')?.share ?? 0, 0.23)
  near(boosted.reduce((sum, player) => sum + player.share, 0), 1)
  assert.ok((boosted.find((player) => player.id === 'mid')?.share ?? 0) > (boosted.find((player) => player.id === 'top')?.share ?? 0))
})

test('DSS region helpers implement the PDF region resume frame', () => {
  const raw = dssRegionRawSeriesValue({
    observedSeriesResult: 1,
    observedGameWinRate: 0.6,
    expectedSeriesResult: 0.4,
    expectedGameWinRate: 0.45,
  })
  const connectivity = dssRegionConnectivity(160)
  const depth = dssEffectiveRegionDepthTerm({
    topEndScore: 70,
    depthScore: 40,
    connectivity,
  })
  const score = dssRegionScore({
    internationalResumeRate: 0.1,
    seedPerformanceRate: 0.05,
    regionStagePoints: 8,
    topEndScore: 70,
    depthScore: 40,
    connectivity,
    regionPrior: 1500,
  })

  near(raw, 0.4875)
  near(dssRegionWeightedSeriesValue({
    observedSeriesResult: 1,
    observedGameWinRate: 0.6,
    expectedSeriesResult: 0.4,
    expectedGameWinRate: 0.45,
    eventTier: 'worlds-playoffs',
    bestOf: 5,
    rosterValidity: 0.5,
  }), raw * 45 * 0.5)
  assert.equal(deservedStandingModelParameters.region.stagePointEventCapShare, 0.2)
  assert.equal(dssRegionStagePoints(12, 40), 8)
  assert.equal(dssRegionStagePoints(12, 0), 0)
  near(connectivity, 0.5)
  near(depth, 29)
  near(score, 1529.125)
})

test('DSS series ledger groups source match rows and emits one entry per team', () => {
  const matches = seriesFixture({
    id: 'alpha-beta-bo3',
    bestOf: 3,
    winners: ['Alpha', 'Beta', 'Alpha'],
    sourceMatchIdPrefix: 'LCK/2026/Spring_Playoffs_Round_1',
  })
  const ledger = dssSeriesLedgerEntriesForMatches(matches, {
    referenceStrengthFor: ({ team }) => team === 'Alpha' ? 1600 : 1500,
  })
  const alpha = ledger.find((entry) => entry.team === 'Alpha')
  const beta = ledger.find((entry) => entry.team === 'Beta')

  assert.equal(ledger.length, 2)
  assert.ok(alpha)
  assert.ok(beta)
  assert.equal(alpha.seriesKey, beta.seriesKey)
  assert.equal(alpha.finalMatchId, 'alpha-beta-bo3-game-3')
  assert.equal(alpha.bestOf, 3)
  assert.equal(alpha.teamLeague, 'LCK')
  assert.equal(alpha.opponentLeague, 'LCK')
  assert.equal(alpha.teamRegion, 'LCK')
  assert.equal(alpha.opponentRegion, 'LCK')
  assert.equal(alpha.gamesWon, 2)
  assert.equal(alpha.gamesLost, 1)
  assert.equal(alpha.observedSeriesResult, 1)
  near(alpha.observedGameWinRate, 2 / 3)
  assert.ok(alpha.expectedSeriesResult > 0.5)
  assert.ok(alpha.weightedSeriesValue > 0)
  assert.ok(beta.weightedSeriesValue < 0)
})

test('DSS series ledger infers same-day series when source match ids are absent', () => {
  const ledger = dssSeriesLedgerEntriesForMatches([
    matchFixture({ id: 'same-day-1', bestOf: 3, winner: 'Alpha' }),
    matchFixture({ id: 'same-day-2', bestOf: 3, winner: 'Alpha' }),
  ])
  const alpha = ledger.find((entry) => entry.team === 'Alpha')

  assert.equal(ledger.length, 2)
  assert.ok(alpha)
  assert.equal(alpha.bestOf, 3)
  assert.equal(alpha.gamesWon, 2)
  assert.equal(alpha.gamesPlayed, 2)
  assert.equal(alpha.observedSeriesResult, 1)
  assert.equal(alpha.seriesWeight, dssSeriesWeight('regional-regular', 3))
})

test('DSS series ledger treats Bo2 ties as split expected series points', () => {
  const ledger = dssSeriesLedgerEntriesForMatches([
    matchFixture({ id: 'bo2-game-1', bestOf: 2, winner: 'Alpha' }),
    matchFixture({ id: 'bo2-game-2', bestOf: 2, winner: 'Beta' }),
  ])
  const alpha = ledger.find((entry) => entry.team === 'Alpha')
  const beta = ledger.find((entry) => entry.team === 'Beta')

  assert.equal(ledger.length, 2)
  assert.ok(alpha)
  assert.ok(beta)
  assert.equal(alpha.bestOf, 2)
  assert.equal(alpha.observedSeriesResult, 0.5)
  assert.equal(beta.observedSeriesResult, 0.5)
  near(alpha.expectedSeriesResult, 0.5)
  near(beta.expectedSeriesResult, 0.5)
})

test('DSS series ledger freezes expectation inputs through callbacks', () => {
  const ledger = dssSeriesLedgerEntriesForMatches([
    matchFixture({ id: 'context-game', winner: 'Alpha' }),
  ], {
    referenceStrengthFor: () => 1500,
    contextAdjustmentFor: ({ team }) => team === 'Alpha' ? 30 : 0,
  })
  const alpha = ledger.find((entry) => entry.team === 'Alpha')
  const beta = ledger.find((entry) => entry.team === 'Beta')

  assert.ok(alpha)
  assert.ok(beta)
  assert.ok(alpha.expectedGameWinRate > 0.5)
  near(alpha.expectedGameWinRate, 1 - beta.expectedGameWinRate)
  assert.equal(alpha.contextAdjustment, 30)
  assert.equal(beta.contextAdjustment, -30)
})

test('DSS weighted series conversion preserves ledger values and explicit roster validity', () => {
  const ledger = dssSeriesLedgerEntriesForMatches([matchFixture({ id: 'single-game' })])
  const alpha = ledger.find((entry) => entry.team === 'Alpha')
  assert.ok(alpha)

  const weighted = dssWeightedSeriesFromLedgerEntry(alpha, {
    rosterValidity: 0.6,
    standardOpponentReferenceStrength: 1520,
  })

  assert.equal(weighted.weightedSeriesValue, alpha.weightedSeriesValue)
  assert.equal(weighted.seriesWeight, alpha.seriesWeight)
  assert.equal(weighted.rosterValidity, 0.6)
  assert.equal(weighted.opponentReferenceStrength, alpha.opponentReferenceStrength)
  assert.equal(weighted.standardOpponentReferenceStrength, 1520)
})

test('DSS team component aggregation produces the public component contract', () => {
  const series = [
    {
      weightedSeriesValue: 10,
      seriesWeight: 20,
      rosterValidity: 1,
      opponentReferenceStrength: 1600,
      standardOpponentReferenceStrength: 1500,
    },
    {
      weightedSeriesValue: -2,
      seriesWeight: 10,
      rosterValidity: 0.5,
      opponentReferenceStrength: 1400,
      standardOpponentReferenceStrength: 1500,
    },
  ]
  const components = dssTeamComponentsFromSeries({
    series,
    stagePoints: 7,
    incomingPlayerBridgeCredit: 4.5,
    uncertainty: 80,
  })

  near(dssCurrentRosterValidity(series), 25 / 30)
  near(components.resumeRate, 0.36)
  near(components.scheduleRate, 0.15)
  near(components.instabilityPenalty, 0)
  near(components.dss, 1500 + components.resumePoints + components.scheduleStrengthPoints + 7 + 4.5)
  near(components.conservativeDss ?? 0, components.dss - 28)
})

function near(actual: number, expected: number, epsilon = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} should be within ${epsilon} of ${expected}`)
}

function seriesFixture({
  id,
  winners,
  sourceMatchIdPrefix,
  ...overrides
}: Partial<MatchRecord> & {
  id: string
  winners: string[]
  sourceMatchIdPrefix?: string
}): MatchRecord[] {
  return winners.map((winner, index) => matchFixture({
    ...overrides,
    id: `${id}-game-${index + 1}`,
    sourceGameId: `${id}-game-${index + 1}`,
    ...(sourceMatchIdPrefix ? { sourceMatchId: `${sourceMatchIdPrefix}_${index + 1}` } : {}),
    winner,
  }))
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
