import assert from 'node:assert/strict'
import test from 'node:test'
import { effectiveLeagueRating, leagueEffectiveRatingCapsByTier } from '../src/data/leagueTiers.ts'
import { preseasonEventWeightMultiplier } from '../src/data/rankingConfig.ts'
import {
  eventKFactorForMatch,
  eventWeightContextForMatches,
  eventWeightForMatch,
  isPostWorldsPreseasonMatch,
  leagueKFactorForMatch,
} from '../src/lib/eventWeighting.ts'
import { ensureLeague, updateLeagueStrengthForSeries } from '../src/lib/leagueRatings.ts'
import { buildPlayerModel, buildRankingModel } from '../src/lib/model.ts'
import { publishedLeagueAnchorContextAdjustment, publishedRosterPriorOffset, publishedTeamStableOffset } from '../src/lib/ratingCalculations.ts'
import { compactPlayerRecentMatches } from '../src/lib/snapshot.ts'
import type { LeagueStrength, MatchRecord, PlayerProfile, Region, Role, Side, TeamProfile } from '../src/types.ts'

const teams: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
  Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
  Gamma: { name: 'Gamma', code: 'GAM', region: 'LPL', league: 'LPL' },
}

test('team latent strength is result-only and allocates evidence across stable and form', () => {
  const dominantWin = buildRankingModel([matchFixture({
    id: 'dominant-win',
    teamAKills: 35,
    teamBKills: 2,
    teamAGold: 80000,
    teamBGold: 43000,
  })], { ...teams })
  const narrowWin = buildRankingModel([matchFixture({
    id: 'narrow-win',
    teamAKills: 10,
    teamBKills: 9,
    teamAGold: 50100,
    teamBGold: 49900,
  })], { ...teams })
  const bo5Win = buildRankingModel(seriesFixture({
    id: 'bo5-win',
    bestOf: 5,
    winners: ['Alpha', 'Alpha', 'Alpha'],
  }), { ...teams })

  const dominantAlpha = standingFor(dominantWin, 'Alpha')
  const narrowAlpha = standingFor(narrowWin, 'Alpha')
  const bo5Alpha = standingFor(bo5Win, 'Alpha')

  assert.equal(dominantAlpha.baseRating, narrowAlpha.baseRating)
  assert.equal(dominantAlpha.rating, narrowAlpha.rating)
  assert.ok(bo5Alpha.baseRating > dominantAlpha.baseRating)
  assert.ok(bo5Alpha.baseRating > 1500)
  assert.equal(dominantAlpha.ratingUpdate.teamStableShare, 0.9)
  assert.equal(dominantAlpha.ratingUpdate.teamFormShare, 0.1)
  assert.ok((dominantAlpha.ratingUpdate.resultEvidence ?? 0) > dominantAlpha.ratingUpdate.teamStableDelta)
  assert.ok(dominantAlpha.ratingUpdate.momentumDelta > 0)
  assert.equal(dominantAlpha.ratingUpdate.neutralResultResidual, 0.5)
  assert.equal(dominantAlpha.ratingUpdate.updateUnit, 'series-atomic')
})

test('series rows publish one atomic team and league strength update', () => {
  const extendedTeams: Record<string, TeamProfile> = {
    ...teams,
    Delta: { name: 'Delta', code: 'DEL', region: 'LCS', league: 'LCS' },
  }
  const model = buildRankingModel(seriesFixture({
    id: 'msi-alpha-delta',
    date: '2026-02-01',
    event: 'MSI Fixture',
    region: 'International',
    league: 'MSI',
    tier: 'msi-bracket',
    teamA: 'Alpha',
    teamB: 'Delta',
    teamBHomeLeague: 'LCS',
    teamBRegion: 'LCS',
    winners: ['Alpha', 'Alpha', 'Alpha'],
  }), { ...extendedTeams })
  const alphaHistory = standingFor(model, 'Alpha').history.filter((point) => point.event === 'MSI Fixture')

  assert.equal(model.predictions.filter((prediction) => prediction.event === 'MSI Fixture').length, 3)
  assert.equal(alphaHistory.length, 3)
  assert.deepEqual(alphaHistory.map((point) => point.ratingUpdate.updateUnit), [
    'series-member-no-team-update',
    'series-member-no-team-update',
    'series-atomic',
  ])
  assert.deepEqual(alphaHistory.slice(0, 2).map((point) => point.delta), [0, 0])
  assert.ok((alphaHistory.at(-1)?.ratingUpdate.teamStableDelta ?? 0) > 0)
  assert.equal(leagueFor(model, 'LCK').internationalMatches, 1)
  assert.equal(leagueFor(model, 'LCS').internationalMatches, 1)
})

test('a completed Bo2 tie is neutral in ratings, provenance, and head-to-head context', () => {
  const model = buildRankingModel(seriesFixture({
    id: 'bo2-tie',
    bestOf: 2,
    bestOfBasis: 'provider',
    winners: ['Alpha', 'Beta'],
  }), { ...teams })
  const alpha = standingFor(model, 'Alpha')
  const beta = standingFor(model, 'Beta')
  const alphaFinal = alpha.history.at(-1)

  assert.equal(alpha.baseRating, 1500)
  assert.equal(beta.baseRating, 1500)
  assert.equal(alpha.rating, beta.rating)
  assert.equal(alphaFinal?.ratingUpdate.updateUnit, 'series-atomic')
  assert.equal(alphaFinal?.ratingUpdate.neutralResultResidual, 0)
  assert.equal(alphaFinal?.source.seriesOutcome, 0.5)
  assert.equal(alphaFinal?.source.bestOf, 2)
  assert.equal(alphaFinal?.source.formatBasis, 'provider')
  assert.equal(model.predictions.every((prediction) => prediction.seriesId === alphaFinal?.source.seriesId), true)
  assert.equal(model.predictions.every((prediction) => prediction.bestOf === 2), true)
})

test('sourced player histories retain a completed Bo2 tie through public compaction', () => {
  const matches = seriesFixture({
    id: 'player-bo2-tie',
    bestOf: 2,
    bestOfBasis: 'provider',
    winners: ['Alpha', 'Beta'],
  }).map((match, index) => ({
    ...match,
    teamARoster: sourcedRosterFixture('alpha', 'blue', index === 0),
    teamBRoster: sourcedRosterFixture('beta', 'red', index === 1),
  }))
  const players = buildPlayerModel(matches, {})
  const alphaMid = players.find((player) => player.id === 'alpha-Mid')

  assert.ok(alphaMid)
  const recent = compactPlayerRecentMatches(alphaMid)
  assert.equal(recent?.length, 1)
  assert.equal(recent?.[0]?.result, 'T')
  assert.equal(recent?.[0]?.seriesId, alphaMid.history[0]?.source?.seriesId)
  assert.equal(alphaMid.history.every((entry) => entry.source?.seriesOutcome === 0.5), true)
})

test('an ambiguous fallback 1-1 prefix stays incomplete and does not count for eligibility', () => {
  const model = buildRankingModel([
    matchFixture({ id: 'fallback-prefix-a', sourceGameId: 'opaque-prefix-a', bestOf: 1, bestOfBasis: 'fallback', winner: 'Alpha' }),
    matchFixture({ id: 'fallback-prefix-b', sourceGameId: 'opaque-prefix-b', bestOf: 1, bestOfBasis: 'fallback', winner: 'Beta' }),
  ], { ...teams })
  const alpha = standingFor(model, 'Alpha')

  assert.equal(alpha.baseRating, 1500)
  assert.equal(alpha.eligibility.totalGames, 0)
  assert.equal(alpha.history.every((point) => point.source.seriesState === 'unknown'), true)
  assert.equal(alpha.history.every((point) => point.source.seriesOutcome === undefined), true)
  assert.equal(alpha.history.every((point) => point.ratingUpdate.updateUnit === 'series-member-no-team-update'), true)
})

test('an unequal Bo3 prefix stays ongoing and does not count for eligibility', () => {
  const model = buildRankingModel([
    matchFixture({ id: 'bo3-prefix-1', sourceGameId: 'bo3-prefix-game-1', bestOf: 3, bestOfBasis: 'provider', winner: 'Alpha' }),
  ], { ...teams })
  const alpha = standingFor(model, 'Alpha')

  assert.equal(alpha.baseRating, 1500)
  assert.equal(alpha.eligibility.totalGames, 0)
  assert.equal(alpha.history[0]?.source.seriesState, 'ongoing')
  assert.equal(alpha.history[0]?.source.seriesOutcome, undefined)
})

test('an international Bo2 tie assigns half a league result without inventing league history wins', () => {
  const setup = Array.from({ length: 8 }, (_, index) => matchFixture({
    id: `bo2-league-setup-${index}`,
    date: `2026-01-${String(index + 1).padStart(2, '0')}`,
    winner: 'Alpha',
  }))
  const tie = seriesFixture({
    id: 'international-bo2-tie',
    date: '2026-02-01',
    event: 'MSI Bo2 Fixture',
    region: 'International',
    league: 'MSI',
    tier: 'msi-bracket',
    teamA: 'Alpha',
    teamB: 'Gamma',
    teamAHomeLeague: 'LCK',
    teamBHomeLeague: 'LPL',
    teamARegion: 'LCK',
    teamBRegion: 'LPL',
    bestOf: 2,
    bestOfBasis: 'provider',
    winners: ['Alpha', 'Gamma'],
  })
  const model = buildRankingModel([...setup, ...tie], { ...teams })
  const lck = leagueFor(model, 'LCK')
  const lpl = leagueFor(model, 'LPL')

  assert.equal(lck.wins, 0.5)
  assert.equal(lck.losses, 0.5)
  assert.equal(lpl.wins, 0.5)
  assert.equal(lpl.losses, 0.5)
  assert.equal(Number(((lck.winsOverExpected ?? 0) + (lpl.winsOverExpected ?? 0)).toFixed(6)), 0)
  assert.equal(model.leagueHistory.some((point) => point.event === 'MSI Bo2 Fixture'), false)
})

test('interleaved same-date series rows still publish one atomic team update', () => {
  const extendedTeams: Record<string, TeamProfile> = {
    ...teams,
    Delta: { name: 'Delta', code: 'DEL', region: 'LCS', league: 'LCS' },
  }
  const series = seriesFixture({
    id: 'interleaved-alpha-delta',
    date: '2026-02-01',
    event: 'MSI Interleaved Fixture',
    region: 'International',
    league: 'MSI',
    tier: 'msi-bracket',
    bestOf: 5,
    teamA: 'Alpha',
    teamB: 'Delta',
    teamBHomeLeague: 'LCS',
    teamBRegion: 'LCS',
    winners: ['Alpha', 'Delta', 'Alpha', 'Delta', 'Delta'],
  })
  const model = buildRankingModel([
    series[0],
    matchFixture({
      id: 'same-day-beta-gamma-1',
      sourceGameId: 'same-day-beta-gamma-1',
      date: '2026-02-01',
      event: 'LCK Same Day Fixture',
      teamA: 'Beta',
      teamB: 'Gamma',
      winner: 'Beta',
    }),
    series[1],
    matchFixture({
      id: 'same-day-beta-gamma-2',
      sourceGameId: 'same-day-beta-gamma-2',
      date: '2026-02-01',
      event: 'LCK Same Day Fixture',
      teamA: 'Beta',
      teamB: 'Gamma',
      winner: 'Gamma',
    }),
    series[2],
    series[3],
    series[4],
  ], { ...extendedTeams })
  const alphaHistory = standingFor(model, 'Alpha').history.filter((point) => point.event === 'MSI Interleaved Fixture')

  assert.equal(alphaHistory.length, 5)
  assert.deepEqual(alphaHistory.map((point) => point.ratingUpdate.updateUnit), [
    'series-member-no-team-update',
    'series-member-no-team-update',
    'series-member-no-team-update',
    'series-member-no-team-update',
    'series-atomic',
  ])
  assert.deepEqual(alphaHistory.slice(0, 4).map((point) => point.delta), [0, 0, 0, 0])
  assert.equal(alphaHistory.at(-1)?.result, 'L')
  assert.ok((alphaHistory.at(-1)?.ratingUpdate.teamStableDelta ?? 0) < 0)
  assert.ok((alphaHistory.at(-1)?.delta ?? 0) < 0)
})

test('official match ids keep independent same-day team-pair matches separate', () => {
  const model = buildRankingModel([
    matchFixture({
      id: 'same-day-official-1',
      sourceProvider: 'oracles-elixir',
      officialMatchId: 'official-series-1',
      date: '2026-02-01',
      event: 'LCK Same Day Fixture',
      teamA: 'Alpha',
      teamB: 'Beta',
      winner: 'Alpha',
    }),
    matchFixture({
      id: 'same-day-official-2',
      sourceProvider: 'oracles-elixir',
      officialMatchId: 'official-series-2',
      date: '2026-02-01',
      event: 'LCK Same Day Fixture',
      teamA: 'Alpha',
      teamB: 'Beta',
      winner: 'Beta',
    }),
  ], { ...teams })
  const alphaHistory = standingFor(model, 'Alpha').history.filter((point) => point.event === 'LCK Same Day Fixture')

  assert.deepEqual(alphaHistory.map((point) => point.ratingUpdate.updateUnit), ['series-atomic', 'series-atomic'])
  assert.notEqual(alphaHistory[0]?.delta, 0)
  assert.notEqual(alphaHistory[1]?.delta, 0)
})

test('team history points use global ranks instead of match-local ranks', () => {
  const model = buildRankingModel([
    ...Array.from({ length: 24 }, (_, index) => matchFixture({
      id: `gamma-setup-${index}`,
      date: dateInJanuary(index + 1),
      teamA: 'Gamma',
      teamB: 'Beta',
      winner: 'Gamma',
    })),
    matchFixture({
      id: 'alpha-history-rank',
      sourceGameId: 'alpha-history-rank',
      date: '2026-02-01',
      teamA: 'Alpha',
      teamB: 'Beta',
      winner: 'Alpha',
    }),
  ], { ...teams })
  const alpha = standingFor(model, 'Alpha')
  const gamma = standingFor(model, 'Gamma')
  const alphaPoint = alpha.history.find((point) => point.source.gameId === 'alpha-history-rank')

  assert.ok(gamma.rating > alpha.rating)
  assert.ok((alphaPoint?.rank ?? 0) > 1)
})

test('series expectation can value an elite win above an expected sweep', () => {
  const extendedTeams: Record<string, TeamProfile> = {
    Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
    Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
    Gamma: { name: 'Gamma', code: 'GAM', region: 'LCK', league: 'LCK' },
    Delta: { name: 'Delta', code: 'DEL', region: 'LCS', league: 'LCS' },
    Epsilon: { name: 'Epsilon', code: 'EPS', region: 'LCS', league: 'LCS' },
  }
  const setup = [
    ...Array.from({ length: 24 }, (_, index) => matchFixture({
      id: `gamma-setup-${index}`,
      date: dateInJanuary(index + 1),
      teamA: 'Gamma',
      teamB: 'Beta',
      winner: 'Gamma',
    })),
    ...Array.from({ length: 8 }, (_, index) => matchFixture({
      id: `alpha-setup-${index}`,
      date: dateInJanuary(index + 25),
      teamA: 'Alpha',
      teamB: 'Beta',
      winner: 'Alpha',
    })),
    ...Array.from({ length: 24 }, (_, index) => matchFixture({
      id: `delta-setup-${index}`,
      date: dateInJanuary(index + 33),
      event: 'LCS 2026 Spring',
      region: 'LCS',
      league: 'LCS',
      teamAHomeLeague: 'LCS',
      teamBHomeLeague: 'LCS',
      teamARegion: 'LCS',
      teamBRegion: 'LCS',
      teamA: 'Epsilon',
      teamB: 'Delta',
      winner: 'Epsilon',
    })),
  ]
  const eliteWin = buildRankingModel([
    ...setup,
    ...seriesFixture({
      id: 'alpha-gamma-series',
      date: '2026-03-01',
      sourceProvider: 'leaguepedia-cargo',
      sourceMatchIdPrefix: 'LCK/2026 Season/Road to MSI_Round 4_1',
      event: 'LCK 2026 Road to MSI',
      teamA: 'Alpha',
      teamB: 'Gamma',
      bestOf: 5,
      winners: ['Alpha', 'Gamma', 'Alpha', 'Gamma', 'Alpha'],
    }),
  ], { ...extendedTeams })
  const expectedSweep = buildRankingModel([
    ...setup,
    ...seriesFixture({
      id: 'alpha-delta-series',
      date: '2026-03-01',
      sourceProvider: 'oracles-elixir',
      event: 'MSI 2026',
      region: 'International',
      league: 'MSI',
      tier: 'msi-bracket',
      teamA: 'Alpha',
      teamB: 'Delta',
      teamBHomeLeague: 'LCS',
      teamBRegion: 'LCS',
      winners: ['Alpha', 'Alpha', 'Alpha'],
    }),
  ], { ...extendedTeams })
  const eliteHistory = standingFor(eliteWin, 'Alpha').history.filter((point) => point.event === 'LCK 2026 Road to MSI')
  const sweepHistory = standingFor(expectedSweep, 'Alpha').history.filter((point) => point.event === 'MSI 2026')
  const eliteDelta = eliteHistory.reduce((total, point) => total + point.delta, 0)
  const sweepDelta = sweepHistory.reduce((total, point) => total + point.delta, 0)

  assert.equal(eliteWin.predictions.filter((prediction) => prediction.event === 'LCK 2026 Road to MSI').length, 5)
  assert.equal(eliteHistory.filter((point) => point.ratingUpdate.updateUnit === 'series-atomic').length, 1)
  assert.equal(sweepHistory.filter((point) => point.ratingUpdate.updateUnit === 'series-atomic').length, 1)
  assert.ok(eliteDelta > sweepDelta, `expected elite delta ${eliteDelta} to beat expected sweep delta ${sweepDelta}`)
})

test('domestic stable gains in weaker leagues are shrunk before global publication', () => {
  const extendedTeams: Record<string, TeamProfile> = {
    ...teams,
    LecLeader: { name: 'LecLeader', code: 'LEA', region: 'LEC', league: 'LEC' },
    LecRival: { name: 'LecRival', code: 'LER', region: 'LEC', league: 'LEC' },
  }
  const model = buildRankingModel([
    ...Array.from({ length: 12 }, (_, index) => matchFixture({
      id: `lck-domestic-${index}`,
      date: dateInJanuary(index + 1),
      teamA: 'Alpha',
      teamB: 'Beta',
      winner: 'Alpha',
    })),
    ...Array.from({ length: 12 }, (_, index) => matchFixture({
      id: `lec-domestic-${index}`,
      date: dateInJanuary(index + 1),
      event: 'LEC 2026 Spring',
      league: 'LEC',
      region: 'LEC',
      teamAHomeLeague: 'LEC',
      teamBHomeLeague: 'LEC',
      teamARegion: 'LEC',
      teamBRegion: 'LEC',
      teamA: 'LecLeader',
      teamB: 'LecRival',
      winner: 'LecLeader',
    })),
  ], { ...extendedTeams })

  const lckLeader = standingFor(model, 'Alpha')
  const lecLeader = standingFor(model, 'LecLeader')

  assert.equal(lckLeader.ratingUpdate.teamStableShare, 0.9)
  assert.equal(lecLeader.ratingUpdate.teamStableShare, 0.59)
  assert.ok(lckLeader.ratingComponents.teamStableOffset > lecLeader.ratingComponents.teamStableOffset)
  assert.ok(lckLeader.rating - lecLeader.rating > 55)
  assert.equal(lecLeader.ratingUpdate.unavailableChannels?.includes('domestic-relative-strength:global-transfer-shrunk'), true)
})

test('published roster prior caps positive player signal for sustained losing records', () => {
  assert.equal(publishedRosterPriorOffset(24, 3, 8), 24)
  assert.equal(publishedRosterPriorOffset(24, 12, 12), 24)
  assert.equal(publishedRosterPriorOffset(24, 9, 21), 6)
  assert.equal(publishedRosterPriorOffset(24, 5, 7), 14)
  assert.equal(publishedRosterPriorOffset(-24, 9, 21), -24)
})

test('published team stable offset compresses only the elite positive tail', () => {
  assert.equal(publishedTeamStableOffset(45), 45)
  assert.equal(publishedTeamStableOffset(70), 70)
  assert.equal(publishedTeamStableOffset(100), 79)
  assert.equal(publishedTeamStableOffset(-40), -40)
})

test('post-Worlds preseason games use discounted event weight until the next calendar year', () => {
  const worldsFinal = matchFixture({
    id: 'worlds-final',
    date: '2025-11-09',
    season: 2025,
    event: 'WLDs 2025',
    league: 'WLDs',
    region: 'International',
    tier: 'worlds-main',
  })
  const demaciaCup = matchFixture({
    id: 'demacia-cup',
    date: '2025-12-20',
    season: 2025,
    event: 'DCup 2025',
    league: 'DCup',
    tier: 'regional-regular',
  })
  const kespaCup = matchFixture({
    id: 'kespa-cup',
    date: '2025-12-06',
    season: 2026,
    event: 'KeSPA 2026',
    league: 'KeSPA',
    region: 'International',
    tier: 'minor-international',
    teamB: 'Gamma',
    teamBHomeLeague: 'LPL',
    teamBRegion: 'LPL',
  })
  const nextYearMatch = matchFixture({
    id: 'next-year',
    date: '2026-01-01',
    season: 2026,
    event: 'LCK 2026 Spring',
  })
  const context = eventWeightContextForMatches([worldsFinal, demaciaCup, kespaCup, nextYearMatch])

  assert.equal(isPostWorldsPreseasonMatch(worldsFinal, context), false)
  assert.equal(isPostWorldsPreseasonMatch(demaciaCup, context), true)
  assert.equal(isPostWorldsPreseasonMatch(kespaCup, context), true)
  assert.equal(isPostWorldsPreseasonMatch(nextYearMatch, context), false)
  assert.equal(eventKFactorForMatch(demaciaCup, context), 14 * preseasonEventWeightMultiplier)
  assert.equal(eventWeightForMatch(demaciaCup, context), preseasonEventWeightMultiplier)
  assert.equal(leagueKFactorForMatch(kespaCup, context), 12 * preseasonEventWeightMultiplier)

  const ranking = buildRankingModel([worldsFinal, demaciaCup], { ...teams })
  const demaciaHistory = standingFor(ranking, 'Alpha').history.find((point) => point.event === demaciaCup.event)
  assert.equal(demaciaHistory?.ratingUpdate.eventWeight, preseasonEventWeightMultiplier)
})

test('Esports World Cup does not start the post-Worlds preseason window', () => {
  const esportsWorldCup = matchFixture({
    id: 'ewc',
    date: '2025-07-20',
    season: 2025,
    event: 'Esports World Cup 2025',
    league: 'EWC',
    region: 'International',
    tier: 'minor-international',
  })
  const summerMatch = matchFixture({
    id: 'summer',
    date: '2025-08-01',
    season: 2025,
    event: 'LCK 2025 Summer',
  })
  const context = eventWeightContextForMatches([esportsWorldCup, summerMatch])

  assert.equal(isPostWorldsPreseasonMatch(summerMatch, context), false)
  assert.equal(eventWeightForMatch(summerMatch, context), 1)
})

test('league Elo only updates from international cross-league games with smaller K', () => {
  const domesticCrossLeague = buildRankingModel([matchFixture({
    id: 'domestic-cross-league',
    teamB: 'Gamma',
    league: 'LCK',
    region: 'LCK',
    teamBHomeLeague: 'LPL',
    teamBRegion: 'LPL',
    tier: 'regional-regular',
  })], { ...teams })
  const internationalCrossLeague = buildRankingModel([matchFixture({
    id: 'international-cross-league',
    teamB: 'Gamma',
    league: 'MSI',
    region: 'International',
    teamBHomeLeague: 'LPL',
    teamBRegion: 'LPL',
    tier: 'msi-play-in',
  })], { ...teams })

  assert.equal(leagueFor(domesticCrossLeague, 'LCK').score, 1500)
  assert.equal(leagueFor(domesticCrossLeague, 'LPL').score, 1500)
  assert.notEqual(leagueFor(internationalCrossLeague, 'LCK').score, 1500)
  assert.notEqual(leagueFor(internationalCrossLeague, 'LPL').score, 1500)
  assert.ok(Math.abs(leagueFor(internationalCrossLeague, 'LCK').score - 1500) < Math.abs(standingFor(internationalCrossLeague, 'Alpha').baseRating - 1500))
})

test('league Elo preserves fractional international residual evidence', () => {
  const leagueScores = new Map<string, number>()
  const previousLeagueScores = new Map<string, number>()
  const leagueWins = new Map<string, number>()
  const leagueLosses = new Map<string, number>()
  const leagueExpectedWins = new Map<string, number>()
  const leagueOpponentRatingSums = new Map<string, number>()
  const leagueForms = new Map<string, string[]>()
  const leagueMatchCounts = new Map<string, number>()
  const leagueLastEvents = new Map<string, string>()
  const leagueLastUpdated = new Map<string, string>()
  for (const league of ['LCK', 'LPL']) {
    ensureLeague(league, leagueScores, previousLeagueScores, leagueWins, leagueLosses, leagueExpectedWins, leagueOpponentRatingSums, leagueForms, leagueMatchCounts)
  }

  const delta = updateLeagueStrengthForSeries({
    match: matchFixture({
      id: 'fractional-league-evidence',
      event: 'MSI Fractional Fixture',
      region: 'International',
      league: 'MSI',
      tier: 'msi-bracket',
      teamB: 'Gamma',
      teamBHomeLeague: 'LPL',
      teamBRegion: 'LPL',
    }),
    leagueA: 'LCK',
    leagueB: 'LPL',
    leagueScoreA: 1500,
    leagueScoreB: 1500,
    leagueExpectedRatingA: 1500,
    leagueExpectedRatingB: 1500,
    expectedOutcomeA: 0.563,
    expectedOutcomeB: 0.437,
    observedOutcomeA: 1,
    observedOutcomeB: 0,
    strengthSignal: 1,
    recency: 0.83,
    leagueScores,
    previousLeagueScores,
    leagueWins,
    leagueLosses,
    leagueExpectedWins,
    leagueOpponentRatingSums,
    leagueForms,
    leagueMatchCounts,
    leagueLastEvents,
    leagueLastUpdated,
  })

  assert.equal(delta.deltaA, 8.705)
  assert.equal(delta.deltaB, -8.705)
  assert.equal(leagueScores.get('LCK'), 1508.705)
  assert.equal(leagueScores.get('LPL'), 1491.295)
})

test('emerging league effective ratings cannot publish above tier-three baseline', () => {
  assert.equal(effectiveLeagueRating('LFL', 1450, 200), leagueEffectiveRatingCapsByTier.emerging)
  assert.equal(effectiveLeagueRating('Unknown', 1400, 200), leagueEffectiveRatingCapsByTier.unknown)
  assert.ok(effectiveLeagueRating('LCK', 1600, 200) > 1500)
})

test('league adjustment preserves same-league base-rating gaps before momentum', () => {
  const model = buildRankingModel([
    matchFixture({
      id: 'alpha-cross-region-win',
      date: '2026-01-01',
      league: 'MSI',
      region: 'International',
      event: 'MSI 2026 Bracket',
      tier: 'msi-bracket',
      teamA: 'Alpha',
      teamB: 'Gamma',
      teamBHomeLeague: 'LPL',
      teamBRegion: 'LPL',
      winner: 'Alpha',
    }),
    matchFixture({
      id: 'beta-cross-region-loss',
      date: '2026-01-02',
      league: 'MSI',
      region: 'International',
      event: 'MSI 2026 Bracket',
      tier: 'msi-bracket',
      teamA: 'Beta',
      teamB: 'Gamma',
      teamBHomeLeague: 'LPL',
      teamBRegion: 'LPL',
      winner: 'Gamma',
    }),
  ], { ...teams })

  const alpha = standingFor(model, 'Alpha')
  const beta = standingFor(model, 'Beta')

  assert.equal(alpha.league, beta.league)
  assert.equal(alpha.leagueAdjustment, beta.leagueAdjustment)
  assert.equal(alpha.ratingComponents.leagueAnchor, beta.ratingComponents.leagueAnchor)
  assert.equal(alpha.ratingComponents.teamStableOffset - beta.ratingComponents.teamStableOffset, alpha.baseRating - beta.baseRating)
  assert.equal(alpha.rating, componentRating(alpha))
  assert.equal(beta.rating, componentRating(beta))
  assert.equal(typeof alpha.ratingUpdate.teamStableDelta, 'number')
  assert.equal(typeof alpha.ratingUpdate.leagueGameDelta, 'number')
  assert.equal(typeof alpha.ratingUpdate.leaguePlacementDelta, 'number')
  assert.equal(typeof alpha.ratingUpdate.resultEvidence, 'number')
  assert.equal(typeof alpha.ratingUpdate.neutralResultResidual, 'number')
  assert.equal(typeof alpha.ratingUpdate.seriesStrengthSignal, 'number')
  assert.equal(alpha.history.at(-1)?.rating, componentRating(alpha.history.at(-1) ?? alpha))
  assert.equal(typeof alpha.history.at(-1)?.ratingUpdate.momentumDelta, 'number')
})

test('published league anchor relief is gated by sourced team evidence', () => {
  assert.equal(publishedLeagueAnchorContextAdjustment({
    leagueScore: 1417,
    teamRating: 1529,
    wins: 19,
    losses: 8,
    uncertainty: 30,
    rosterBasis: 'sourced',
  }), 20)
  assert.equal(publishedLeagueAnchorContextAdjustment({
    leagueScore: 1536,
    teamRating: 1470,
    wins: 11,
    losses: 20,
    uncertainty: 32,
    rosterBasis: 'sourced',
  }), -12.6)
  assert.equal(publishedLeagueAnchorContextAdjustment({
    leagueScore: 1540,
    teamRating: 1480,
    wins: 14,
    losses: 20,
    uncertainty: 30,
    rosterBasis: 'sourced',
  }), -14)
  assert.equal(publishedLeagueAnchorContextAdjustment({
    leagueScore: 1465,
    teamRating: 1506,
    wins: 16,
    losses: 14,
    uncertainty: 30,
    rosterBasis: 'sourced',
  }), 0)
  assert.equal(publishedLeagueAnchorContextAdjustment({
    leagueScore: 1417,
    teamRating: 1529,
    wins: 19,
    losses: 8,
    uncertainty: 30,
    rosterBasis: 'unknown',
  }), 0)
})

test('international league resume accounts for participating opponent strength', () => {
  const extendedTeams: Record<string, TeamProfile> = {
    ...teams,
    Delta: { name: 'Delta', code: 'DEL', region: 'LPL', league: 'LPL' },
  }

  const strongLplOpponent = buildRankingModel([
    ...lplSetupMatches('strong', 'Gamma'),
    internationalVsGamma('strong-opponent'),
  ], { ...extendedTeams })
  const weakLplOpponent = buildRankingModel([
    ...lplSetupMatches('weak', 'Delta'),
    internationalVsGamma('weak-opponent'),
  ], { ...extendedTeams })

  const strongLck = leagueFor(strongLplOpponent, 'LCK')
  const weakLck = leagueFor(weakLplOpponent, 'LCK')

  assert.ok((strongLck.averageOpponentRating ?? 0) > (weakLck.averageOpponentRating ?? 0))
  assert.ok((strongLck.expectedWins ?? 1) < (weakLck.expectedWins ?? 0))
  assert.ok((strongLck.winsOverExpected ?? 0) > (weakLck.winsOverExpected ?? 0))
  assert.ok(strongLck.score > weakLck.score)
})

test('new season roster rebuild starts from league anchor instead of full old team rating', () => {
  const priorAlphaWins = Array.from({ length: 10 }, (_, index) => matchFixture({
    id: `alpha-prior-${index}`,
    date: `2025-01-${String(index + 1).padStart(2, '0')}`,
    season: 2025,
    winner: 'Alpha',
    teamARoster: rosterFixture('alpha-old'),
    teamBRoster: rosterFixture('beta'),
  }))
  const stableModel = buildRankingModel([
    ...priorAlphaWins,
    matchFixture({
      id: 'stable-season-start',
      date: '2026-01-01',
      season: 2026,
      winner: 'Alpha',
      teamARoster: rosterFixture('alpha-old'),
      teamBRoster: rosterFixture('beta'),
    }),
  ], { ...teams })
  const rebuiltModel = buildRankingModel([
    ...priorAlphaWins,
    matchFixture({
      id: 'rebuilt-season-start',
      date: '2026-01-01',
      season: 2026,
      winner: 'Alpha',
      teamARoster: rosterFixture('alpha-new'),
      teamBRoster: rosterFixture('beta'),
    }),
  ], { ...teams })
  const stablePrediction = stableModel.predictions.find((prediction) => prediction.id === 'stable-season-start')
  const rebuiltPrediction = rebuiltModel.predictions.find((prediction) => prediction.id === 'rebuilt-season-start')

  assert.ok(stablePrediction)
  assert.ok(rebuiltPrediction)
  assert.equal(stablePrediction.teamARosterContinuity, 1)
  assert.equal(rebuiltPrediction.teamARosterContinuity, 0)
  assert.ok(rebuiltPrediction.teamARating < stablePrediction.teamARating)
  assert.ok(Math.abs(rebuiltPrediction.teamARating - 1500) < Math.abs(stablePrediction.teamARating - 1500))
  assert.ok(rebuiltPrediction.teamAUncertainty > stablePrediction.teamAUncertainty)
})

test('same-region Worlds final skips league game delta while placement residual rewards two finalists', () => {
  const extendedTeams: Record<string, TeamProfile> = {
    ...teams,
    Delta: { name: 'Delta', code: 'DEL', region: 'LPL', league: 'LPL' },
  }
  const pathMatches = [
    matchFixture({
      id: 'worlds-alpha-quarter',
      date: '2026-10-20',
      event: 'Worlds 2026 Playoffs',
      phase: 'Quarterfinals',
      region: 'International',
      league: 'Worlds',
      tier: 'worlds-playoffs',
      teamA: 'Alpha',
      teamB: 'Gamma',
      teamBHomeLeague: 'LPL',
      teamBRegion: 'LPL',
      winner: 'Alpha',
    }),
    matchFixture({
      id: 'worlds-beta-quarter',
      date: '2026-10-21',
      event: 'Worlds 2026 Playoffs',
      phase: 'Quarterfinals',
      region: 'International',
      league: 'Worlds',
      tier: 'worlds-playoffs',
      teamA: 'Beta',
      teamB: 'Delta',
      teamBHomeLeague: 'LPL',
      teamBRegion: 'LPL',
      winner: 'Beta',
    }),
  ]
  const completedWorlds = {
    tournamentLifecycles: new Map([['worlds:2026', {
      status: 'completed' as const,
      boundaryDate: '2026-11-02',
      ratedThroughDate: '2026-11-02',
      dataLag: false,
      resultCoverageComplete: true,
    }]]),
  }
  const pathOnly = buildRankingModel(pathMatches, { ...extendedTeams })
  const withSameRegionFinal = buildRankingModel([
    ...pathMatches,
    matchFixture({
      id: 'worlds-lck-final',
      date: '2026-11-02',
      event: 'Worlds 2026 Playoffs',
      phase: 'Final',
      region: 'International',
      league: 'Worlds',
      tier: 'worlds-playoffs',
      teamA: 'Alpha',
      teamB: 'Beta',
      teamAHomeLeague: 'LCK',
      teamBHomeLeague: 'LCK',
      teamARegion: 'LCK',
      teamBRegion: 'LCK',
      winner: 'Alpha',
    }),
  ], { ...extendedTeams }, completedWorlds)
  const lck = leagueFor(withSameRegionFinal, 'LCK')

  assert.equal(lck.internationalMatches, 2)
  assert.ok(lck.score > leagueFor(pathOnly, 'LCK').score)
  assert.ok(standingFor(withSameRegionFinal, 'Alpha').ratingUpdate.leaguePlacementDelta > 0)
})

test('ongoing tournaments keep match movement but do not apply placement residuals', () => {
  const match = matchFixture({
    id: 'ongoing-worlds-match',
    date: '2026-10-20',
    event: 'Worlds 2026 Playoffs',
    phase: 'Quarterfinals',
    region: 'International',
    league: 'Worlds',
    tier: 'worlds-playoffs',
    teamA: 'Alpha',
    teamB: 'Gamma',
    teamBHomeLeague: 'LPL',
    teamBRegion: 'LPL',
    winner: 'Alpha',
  })
  const model = buildRankingModel([match], { ...teams }, {
    tournamentLifecycles: new Map([['worlds:2026', {
      status: 'ongoing',
      boundaryDate: '2026-10-20',
      ratedThroughDate: '2026-10-20',
      dataLag: false,
      resultCoverageComplete: false,
    }]]),
  })

  assert.notEqual(standingFor(model, 'Alpha').ratingUpdate.teamStableDelta, 0)
  assert.equal(standingFor(model, 'Alpha').ratingUpdate.leaguePlacementDelta, 0)
})

test('completed tournaments wait for official result coverage before placement residuals', () => {
  const match = matchFixture({
    id: 'worlds-final-retained',
    officialMatchId: 'worlds-bronze-match',
    date: '2026-11-02',
    event: 'Worlds 2026 Playoffs',
    phase: 'Final',
    region: 'International',
    league: 'Worlds',
    tier: 'worlds-playoffs',
    teamA: 'Alpha',
    teamB: 'Gamma',
    teamBHomeLeague: 'LPL',
    teamBRegion: 'LPL',
    winner: 'Alpha',
  })
  const model = buildRankingModel([match], { ...teams }, {
    tournamentLifecycles: new Map([['worlds:2026', {
      status: 'completed',
      boundaryDate: '2026-11-02',
      ratedThroughDate: '2026-11-02',
      dataLag: false,
      resultCoverageComplete: false,
    }]]),
  })

  assert.notEqual(standingFor(model, 'Alpha').ratingUpdate.teamStableDelta, 0)
  assert.equal(standingFor(model, 'Alpha').ratingUpdate.leaguePlacementDelta, 0)
})

test('disconnected unknown-league teams stay provisional instead of topping the eligible board', () => {
  const model = buildRankingModel([
    ...Array.from({ length: 30 }, (_, index) => matchFixture({
      id: `major-${index}`,
      date: `2026-03-${String(index + 1).padStart(2, '0')}`,
      teamA: 'Alpha',
      teamB: 'Beta',
      winner: index % 2 === 0 ? 'Alpha' : 'Beta',
    })),
    ...Array.from({ length: 30 }, (_, index) => matchFixture({
      id: `isolated-${index}`,
      date: `2026-04-${String(index + 1).padStart(2, '0')}`,
      event: 'Isolated Cup',
      region: 'International',
      league: 'Unknown',
      teamA: 'Isolated Kings',
      teamB: 'Local Rival',
      teamAHomeLeague: 'Unknown',
      teamBHomeLeague: 'Unknown',
      teamARegion: 'International',
      teamBRegion: 'International',
      winner: 'Isolated Kings',
    })),
  ], { ...teams })
  const isolated = standingFor(model, 'Isolated Kings')
  const eligible = model.standings.filter((standing) => standing.eligibility.eligible)

  assert.equal(isolated.eligibility.eligible, false)
  assert.equal(isolated.eligibility.reasons.includes('unanchored-league'), true)
  assert.equal(eligible.some((standing) => standing.team === 'Alpha' || standing.team === 'Beta'), true)
  assert.equal(eligible.some((standing) => standing.team === 'Isolated Kings'), false)
  assert.equal(model.standings.every((standing, index) => standing.rank === index + 1), true)
  assert.equal(model.standings.every((standing) => standing.movement === standing.previousRank - standing.rank), true)
})

test('league priors separate unknown leagues from major leagues without international signal', () => {
  const model = buildRankingModel([matchFixture({
    id: 'unknown-prior',
    teamA: 'Mystery A',
    teamB: 'Mystery B',
    teamAHomeLeague: 'Unknown',
    teamBHomeLeague: 'Unknown',
    league: 'Unknown',
    region: 'International',
    teamARegion: 'International',
    teamBRegion: 'International',
  })], {
    ...teams,
    'Mystery A': { name: 'Mystery A', code: 'MYA', region: 'International', league: 'Unknown' },
    'Mystery B': { name: 'Mystery B', code: 'MYB', region: 'International', league: 'Unknown' },
  })

  assert.equal(leagueFor(model, 'Unknown').score, 1250)
  assert.equal(leagueFor(model, 'LCK').score, 1500)
})

test('standings expose uncertainty bands', () => {
  const model = buildRankingModel([matchFixture({ id: 'uncertainty' })], { ...teams })
  const alpha = standingFor(model, 'Alpha')
  const gamma = standingFor(model, 'Gamma')

  assert.ok(alpha.uncertainty > 0)
  assert.ok(alpha.uncertainty < gamma.uncertainty)
})

test('standings expose sourced roster basis from observed Oracle rosters', () => {
  const model = buildRankingModel([
    matchFixture({
      id: 'roster-basis',
      sourceProvider: 'oracles-elixir',
      teamARoster: rosterFixture('alpha'),
      teamBRoster: rosterFixture('beta', 'partial'),
    }),
  ], { ...teams })

  assert.equal(standingFor(model, 'Alpha').rosterBasis, 'sourced')
  assert.equal(standingFor(model, 'Beta').rosterBasis, 'assumed-continuous')
  assert.equal(standingFor(model, 'Gamma').rosterBasis, 'unknown')
})

test('dynamic player shares can make a high-impact support more important than an average mid', () => {
  const rosters: Record<string, PlayerProfile[]> = {
    Alpha: [
      { id: 'alpha-top', name: 'Alpha Top', team: 'Alpha', role: 'Top' },
      { id: 'alpha-jungle', name: 'Alpha Jungle', team: 'Alpha', role: 'Jungle' },
      { id: 'alpha-mid', name: 'Alpha Mid', team: 'Alpha', role: 'Mid' },
      { id: 'alpha-bot', name: 'Alpha Bot', team: 'Alpha', role: 'Bot' },
      {
        id: 'alpha-support',
        name: 'Alpha Support',
        team: 'Alpha',
        role: 'Support',
        impactSignals: {
          objectiveImpactZ: 2,
          awardResidualZ: 1.5,
          recentFormZ: 1,
        },
      },
    ],
    Beta: [
      { id: 'beta-top', name: 'Beta Top', team: 'Beta', role: 'Top' },
      { id: 'beta-jungle', name: 'Beta Jungle', team: 'Beta', role: 'Jungle' },
      { id: 'beta-mid', name: 'Beta Mid', team: 'Beta', role: 'Mid' },
      { id: 'beta-bot', name: 'Beta Bot', team: 'Beta', role: 'Bot' },
      { id: 'beta-support', name: 'Beta Support', team: 'Beta', role: 'Support' },
    ],
  }
  const players = buildPlayerModel([matchFixture({ id: 'support-impact' })], rosters)
  const support = playerFor(players, 'alpha-support')
  const mid = playerFor(players, 'alpha-mid')
  const alphaShareTotal = players.filter((player) => player.team === 'Alpha').reduce((total, player) => total + player.playerShare, 0)

  assert.ok(support.playerShare > support.baseShare)
  assert.ok(support.playerShare > mid.playerShare)
  assert.ok(support.impactMultiplier > 1)
  assert.ok(Math.abs(alphaShareTotal - 1) < 0.002)
})

test('sourced Oracle player stats produce player ratings without checked-in rosters', () => {
  const players = buildPlayerModel([
    matchFixture({
      id: 'sourced-player-stats',
      sourceProvider: 'oracles-elixir',
      sourceGameId: 'oe-sourced-player-stats',
      sourceFileName: 'oracle-fixture.csv',
      teamARoster: sourcedRosterFixture('alpha', 'blue', true, {
        Bot: { kills: 12, deaths: 1, assists: 8, damageShare: 0.38, earnedGoldShare: 0.31, vspm: 0.9 },
      }),
      teamBRoster: sourcedRosterFixture('beta', 'red', false, {
        Bot: { kills: 1, deaths: 6, assists: 2, damageShare: 0.15, earnedGoldShare: 0.17, vspm: 0.55 },
      }),
    }),
  ], {})
  const alphaBot = playerFor(players, 'alpha-Bot')
  const betaBot = playerFor(players, 'beta-Bot')

  assert.equal(players.length, 10)
  assert.equal(alphaBot.ratingBasis, 'sourced-player-stats')
  assert.equal(alphaBot.games, 1)
  assert.equal(alphaBot.form.join(''), 'W')
  assert.equal(alphaBot.history.length, 1)
  assert.equal(alphaBot.source?.provider, 'oracles-elixir')
  assert.equal(alphaBot.source?.fileName, 'oracle-fixture.csv')
  assert.ok(alphaBot.rating > betaBot.rating)
  assert.ok(alphaBot.playerShare > 0)
})

test('sourced Oracle player diagnostics summarize same-role stat context', () => {
  const players = buildPlayerModel([
    matchFixture({
      id: 'sourced-player-diagnostics',
      sourceProvider: 'oracles-elixir',
      sourceGameId: 'oe-sourced-player-diagnostics',
      sourceFileName: 'oracle-fixture.csv',
      teamARoster: sourcedRosterFixture('alpha', 'blue', true, {
        Bot: { kills: 12, deaths: 1, assists: 8, damageShare: 0.38, earnedGoldShare: 0.31, vspm: 0.9 },
      }),
      teamBRoster: sourcedRosterFixture('beta', 'red', false, {
        Bot: { kills: 1, deaths: 6, assists: 2, damageShare: 0.15, earnedGoldShare: 0.17, vspm: 0.55 },
      }),
    }),
  ], {})
  const diagnostics = playerFor(players, 'alpha-Bot').diagnostics

  assert.ok(diagnostics)
  assert.equal(diagnostics.sourceProvider, 'oracles-elixir')
  assert.equal(diagnostics.scope, 'rated-complete-role-matchups')
  assert.equal(diagnostics.sampleGames, 1)
  assert.equal(diagnostics.wins, 1)
  assert.equal(diagnostics.losses, 0)
  assert.equal(diagnostics.winRate, 1)
  assert.equal(diagnostics.damageShare.value, 0.38)
  assert.equal(diagnostics.earnedGoldShare.value, 0.31)
  assert.equal(diagnostics.kda.value, 20)
  assert.equal(diagnostics.vspm.value, 0.9)
  assert.equal(diagnostics.visionScore.value, null)
  assert.equal(diagnostics.visionScore.missing, 1)
  assert.ok((diagnostics.noWinStatScore.value ?? 0) > 0.8)
  assert.ok((diagnostics.sameRoleMatchupDiff.value ?? 0) > 0.65)

  const residual = playerFor(players, 'alpha-Bot').individualResidual
  assert.ok(residual)
  assert.equal(residual.sourceProvider, 'oracles-elixir')
  assert.equal(residual.metricVersion, 'individual-residual-v0')
  assert.equal(residual.scope, 'shadow-rated-complete-role-matchups')
  assert.equal(residual.sampleGames, 1)
  assert.equal(residual.confidence, 1.7)
  assert.equal(residual.explanation.teamWinRate, 1)
  assert.equal(residual.controls.role, 'Bot')
  assert.equal(residual.controls.primaryLeague, 'LCK')
  assert.equal(residual.controls.leagueGames, 1)
  assert.ok((residual.adjustedSameRoleDiff.value ?? 0) > 0.2)
  assert.ok(residual.score > 120)
})

test('sourced Oracle player diagnostics preserve missing optional stat fields', () => {
  const players = buildPlayerModel([
    matchFixture({
      id: 'sourced-player-diagnostics-missing',
      sourceProvider: 'oracles-elixir',
      sourceGameId: 'oe-sourced-player-diagnostics-missing',
      sourceFileName: 'oracle-fixture.csv',
      teamARoster: sourcedRosterFixture('alpha', 'blue', true, {
        Mid: { damageShare: undefined, earnedGoldShare: undefined, vspm: undefined },
      }),
      teamBRoster: sourcedRosterFixture('beta', 'red', false),
    }),
  ], {})
  const diagnostics = playerFor(players, 'alpha-Mid').diagnostics

  assert.ok(diagnostics)
  assert.equal(diagnostics.sampleGames, 1)
  assert.deepEqual(diagnostics.damageShare, { value: null, games: 0, missing: 1 })
  assert.deepEqual(diagnostics.earnedGoldShare, { value: null, games: 0, missing: 1 })
  assert.deepEqual(diagnostics.vspm, { value: null, games: 0, missing: 1 })
  assert.equal(diagnostics.kda.value, 6.5)
  assert.equal(diagnostics.noWinStatScore.games, 1)

  const residual = playerFor(players, 'alpha-Mid').individualResidual
  assert.ok(residual)
  assert.equal(residual.sampleGames, 1)
  assert.equal(residual.adjustedSameRoleDiff.games, 1)
  assert.equal(residual.explanation.noWinStatScore.games, 1)
  assert.equal(residual.expectedNoWinStatScore.games, 1)
  assert.equal(residual.confidence, 1.7)
  assert.equal(Number.isFinite(residual.score), true)
})

test('same-day rating updates use match-local roster prior offsets', () => {
  const model = buildRankingModel([
    matchFixture({
      id: 'player-history',
      date: '2026-01-01',
      sourceProvider: 'oracles-elixir',
      sourceGameId: 'player-history',
      teamARoster: sourcedRosterFixture('alpha', 'blue', true, {
        Bot: { kills: 18, deaths: 0, assists: 9, damageShare: 0.44, earnedGoldShare: 0.36 },
      }),
      teamBRoster: sourcedRosterFixture('beta', 'red', false, {
        Bot: { kills: 0, deaths: 7, assists: 1, damageShare: 0.12, earnedGoldShare: 0.12 },
      }),
    }),
    matchFixture({
      id: 'same-day-no-roster',
      date: '2026-01-02',
      sourceProvider: 'oracles-elixir',
      sourceGameId: 'same-day-no-roster',
      winner: 'Alpha',
    }),
    matchFixture({
      id: 'same-day-sourced-roster',
      date: '2026-01-02',
      sourceProvider: 'oracles-elixir',
      sourceGameId: 'same-day-sourced-roster',
      teamA: 'Alpha',
      teamB: 'Gamma',
      teamBHomeLeague: 'LPL',
      teamBRegion: 'LPL',
      winner: 'Alpha',
      teamARoster: sourcedRosterFixture('alpha', 'blue', true),
      teamBRoster: sourcedRosterFixture('gamma', 'red', false),
    }),
  ], { ...teams })
  const noRosterPrediction = model.predictions.find((prediction) => prediction.id === 'same-day-no-roster')
  const sourcedRosterPrediction = model.predictions.find((prediction) => prediction.id === 'same-day-sourced-roster')
  const noRosterPoint = standingFor(model, 'Alpha').history.find((point) => point.source.gameId === 'same-day-no-roster')
  const sourcedRosterPoint = standingFor(model, 'Alpha').history.find((point) => point.source.gameId === 'same-day-sourced-roster')

  assert.equal(noRosterPrediction?.teamAPlayerRatingAdjustment, 0)
  assert.ok((sourcedRosterPrediction?.teamAPlayerRatingAdjustment ?? 0) > 0)
  assert.equal(noRosterPoint?.ratingComponents.rosterPriorOffset, 0)
  assert.ok((sourcedRosterPoint?.ratingComponents.rosterPriorOffset ?? 0) > 0)
})

test('matches missing roster snapshots carry the last known roster prior', () => {
  const model = buildRankingModel([
    matchFixture({
      id: 'player-history',
      date: '2026-01-01',
      sourceProvider: 'oracles-elixir',
      sourceGameId: 'player-history',
      teamARoster: sourcedRosterFixture('alpha', 'blue', true, {
        Bot: { kills: 18, deaths: 0, assists: 9, damageShare: 0.44, earnedGoldShare: 0.36 },
      }),
      teamBRoster: sourcedRosterFixture('beta', 'red', false, {
        Bot: { kills: 0, deaths: 7, assists: 1, damageShare: 0.12, earnedGoldShare: 0.12 },
      }),
    }),
    matchFixture({
      id: 'sourced-roster-prior',
      date: '2026-01-02',
      sourceProvider: 'oracles-elixir',
      sourceGameId: 'sourced-roster-prior',
      winner: 'Alpha',
      teamARoster: sourcedRosterFixture('alpha', 'blue', true),
      teamBRoster: sourcedRosterFixture('beta', 'red', false),
    }),
    matchFixture({
      id: 'missing-roster-gap-fill',
      date: '2026-01-03',
      sourceProvider: 'leaguepedia-cargo',
      sourceGameId: 'missing-roster-gap-fill',
      winner: 'Alpha',
    }),
  ], { ...teams })
  const sourcedPoint = standingFor(model, 'Alpha').history.find((point) => point.source.gameId === 'sourced-roster-prior')
  const missingRosterPoint = standingFor(model, 'Alpha').history.find((point) => point.source.gameId === 'missing-roster-gap-fill')

  assert.ok((sourcedPoint?.ratingComponents.rosterPriorOffset ?? 0) > 0)
  assert.equal(missingRosterPoint?.ratingComponents.rosterPriorOffset, sourcedPoint?.ratingComponents.rosterPriorOffset)
})

test('individual residual separates same-team players with identical team win rate', () => {
  const matches = Array.from({ length: 60 }, (_, index) => matchFixture({
    id: `high-team-win-residual-${index}`,
    date: dateInJanuary(index + 1),
    sourceProvider: 'oracles-elixir',
    sourceGameId: `high-team-win-residual-${index}`,
    sourceFileName: 'oracle-fixture.csv',
    winner: 'Alpha',
    teamARoster: sourcedRosterFixture('alpha', 'blue', true, {
      Top: { kills: 0, deaths: 5, assists: 3, damageShare: 0.13, earnedGoldShare: 0.14, vspm: 0.55 },
      Jungle: { kills: 3, deaths: 3, assists: 8, damageShare: 0.15, earnedGoldShare: 0.17, vspm: 1.05 },
      Mid: { kills: 9, deaths: 1, assists: 8, damageShare: 0.36, earnedGoldShare: 0.29, vspm: 1.2 },
      Bot: { kills: 10, deaths: 1, assists: 5, damageShare: 0.4, earnedGoldShare: 0.33, vspm: 0.95 },
      Support: { kills: 1, deaths: 1, assists: 16, damageShare: 0.08, earnedGoldShare: 0.09, vspm: 3.1 },
    }),
    teamBRoster: sourcedRosterFixture('beta', 'red', false, {
      Top: { kills: 5, deaths: 2, assists: 6, damageShare: 0.27, earnedGoldShare: 0.24, vspm: 0.95 },
      Jungle: { kills: 2, deaths: 4, assists: 5, damageShare: 0.15, earnedGoldShare: 0.17, vspm: 1 },
      Mid: { kills: 1, deaths: 5, assists: 3, damageShare: 0.18, earnedGoldShare: 0.18, vspm: 0.8 },
      Bot: { kills: 1, deaths: 6, assists: 2, damageShare: 0.15, earnedGoldShare: 0.17, vspm: 0.6 },
      Support: { kills: 0, deaths: 6, assists: 4, damageShare: 0.05, earnedGoldShare: 0.08, vspm: 1.6 },
    }),
  }))
  const players = buildPlayerModel(matches, {}, { teams })
  const alphaTop = playerFor(players, 'alpha-Top')
  const alphaMid = playerFor(players, 'alpha-Mid')
  const alphaBot = playerFor(players, 'alpha-Bot')
  const alphaPlayers = (['Top', 'Jungle', 'Mid', 'Bot', 'Support'] as const).map((role) => playerFor(players, `alpha-${role}`))
  const residualScores = alphaPlayers.map((player) => player.individualResidual?.score)

  assert.equal(alphaPlayers.every((player) => player.individualResidual?.sampleGames === 60), true)
  assert.equal(alphaPlayers.every((player) => player.individualResidual?.confidence === 100), true)
  assert.equal(alphaPlayers.every((player) => player.individualResidual?.explanation.teamWinRate === 1), true)
  assert.ok(new Set(residualScores).size > 1)
  assert.ok((alphaMid.individualResidual?.score ?? 0) > (alphaTop.individualResidual?.score ?? 0) + 10)
  assert.ok((alphaBot.individualResidual?.score ?? 0) > (alphaTop.individualResidual?.score ?? 0) + 10)
  assert.ok(typeof alphaMid.individualResidual?.rank === 'number')
})

test('sourced player ratings do not inject role-specific mass on balanced schedules', () => {
  const matches = Array.from({ length: 90 }, (_, index) => {
    const alphaWon = index % 2 === 0
    return matchFixture({
      id: `balanced-player-${index}`,
      date: dateInJanuary(index + 1),
      winner: alphaWon ? 'Alpha' : 'Beta',
      teamARoster: sourcedRosterFixture('alpha', 'blue', alphaWon),
      teamBRoster: sourcedRosterFixture('beta', 'red', !alphaWon),
    })
  })
  const players = buildPlayerModel(matches, {}, { teams })
  const alphaRoleRatings = (['Top', 'Jungle', 'Mid', 'Bot', 'Support'] as const)
    .map((role) => playerFor(players, `alpha-${role}`).rating)
  const ratingSpread = Math.max(...alphaRoleRatings) - Math.min(...alphaRoleRatings)

  assert.ok(ratingSpread < 4)
})

test('sourced player ratings use league baselines for global comparability', () => {
  const extendedTeams: Record<string, TeamProfile> = {
    ...teams,
    MinorA: { name: 'MinorA', code: 'MIA', region: 'LCS', league: 'NACL' },
    MinorB: { name: 'MinorB', code: 'MIB', region: 'LCS', league: 'NACL' },
  }
  const players = buildPlayerModel([
    matchFixture({
      id: 'lck-player-baseline',
      teamA: 'Alpha',
      teamB: 'Beta',
      winner: 'Alpha',
      teamARoster: sourcedRosterFixture('lck-alpha', 'blue', true),
      teamBRoster: sourcedRosterFixture('lck-beta', 'red', false),
    }),
    matchFixture({
      id: 'nacl-player-baseline',
      teamA: 'MinorA',
      teamB: 'MinorB',
      winner: 'MinorA',
      league: 'NACL',
      event: 'NACL 2026 Spring',
      region: 'LCS',
      teamAHomeLeague: 'NACL',
      teamBHomeLeague: 'NACL',
      teamARegion: 'LCS',
      teamBRegion: 'LCS',
      teamARoster: sourcedRosterFixture('nacl-alpha', 'blue', true),
      teamBRoster: sourcedRosterFixture('nacl-beta', 'red', false),
    }),
  ], {}, {
    teams: extendedTeams,
    leagueStrengths: [
      leagueStrengthFixture('LCK', 'LCK', 'tier-one', 1515),
      leagueStrengthFixture('NACL', 'LCS', 'emerging', 1300),
    ],
  })

  assert.ok(playerFor(players, 'lck-alpha-Top').rating > playerFor(players, 'nacl-alpha-Top').rating + 35)
})

test('sourced player ratings shrink emerging-league domestic edges on the global board', () => {
  const extendedTeams: Record<string, TeamProfile> = {
    ...teams,
    LflA: { name: 'LflA', code: 'LFA', region: 'LEC', league: 'LFL' },
    LflB: { name: 'LflB', code: 'LFB', region: 'LEC', league: 'LFL' },
  }
  const players = buildPlayerModel([
    matchFixture({
      id: 'lck-reference-win',
      teamA: 'Alpha',
      teamB: 'Beta',
      winner: 'Alpha',
      teamARoster: sourcedRosterFixture('lck-alpha', 'blue', true),
      teamBRoster: sourcedRosterFixture('lck-beta', 'red', false),
    }),
    ...Array.from({ length: 60 }, (_, index) => matchFixture({
      id: `lfl-domestic-win-${index}`,
      date: dateInJanuary(index + 2),
      event: 'LFL 2026 Spring',
      league: 'LFL',
      region: 'LEC',
      teamAHomeLeague: 'LFL',
      teamBHomeLeague: 'LFL',
      teamARegion: 'LEC',
      teamBRegion: 'LEC',
      teamA: 'LflA',
      teamB: 'LflB',
      winner: 'LflA',
      teamARoster: sourcedRosterFixture('lfl-alpha', 'blue', true),
      teamBRoster: sourcedRosterFixture('lfl-beta', 'red', false),
    })),
  ], {}, {
    teams: extendedTeams,
    leagueStrengths: [
      leagueStrengthFixture('LCK', 'LCK', 'tier-one', 1515),
      leagueStrengthFixture('LFL', 'LEC', 'emerging', 1413),
    ],
  })

  assert.ok(playerFor(players, 'lck-alpha-Jungle').rating > playerFor(players, 'lfl-alpha-Jungle').rating)
  assert.ok(playerFor(players, 'lfl-alpha-Jungle').rating < 95)
})

test('sourced player ratings ignore incomplete role matchups', () => {
  const partialRoster = sourcedRosterFixture('alpha', 'blue', true)
  partialRoster.completeness = 'partial'
  partialRoster.players = partialRoster.players.slice(0, 1)
  const players = buildPlayerModel([
    matchFixture({
      id: 'partial-player-stats',
      sourceProvider: 'oracles-elixir',
      sourceGameId: 'partial-player-stats',
      teamARoster: partialRoster,
      teamBRoster: sourcedRosterFixture('beta', 'red', false),
    }),
  ], {})

  assert.equal(players.length, 0)
})

test('sourced player appearance audit separates career games from latest rated team', () => {
  const alphaRoster = sourcedRosterFixture('alpha', 'blue', true)
  const gammaRoster = sourcedRosterFixture('gamma', 'blue', true)
  const deltaPartialRoster = sourcedRosterFixture('delta', 'blue', true)
  useSharedBotId(alphaRoster, 'shared-bot')
  useSharedBotId(gammaRoster, 'shared-bot')
  useSharedBotId(deltaPartialRoster, 'shared-bot')
  deltaPartialRoster.completeness = 'partial'
  deltaPartialRoster.players = deltaPartialRoster.players.filter((player) => player.role === 'Bot')

  const players = buildPlayerModel([
    matchFixture({
      id: 'shared-bot-alpha',
      date: '2026-01-01',
      teamA: 'Alpha',
      teamB: 'Beta',
      winner: 'Alpha',
      teamARoster: alphaRoster,
      teamBRoster: sourcedRosterFixture('beta', 'red', false),
    }),
    matchFixture({
      id: 'shared-bot-gamma',
      date: '2026-01-02',
      teamA: 'Gamma',
      teamB: 'Beta',
      winner: 'Gamma',
      teamARoster: gammaRoster,
      teamBRoster: sourcedRosterFixture('beta-later', 'red', false),
    }),
    matchFixture({
      id: 'shared-bot-partial-latest-row',
      date: '2026-01-03',
      teamA: 'Delta',
      teamB: 'Beta',
      winner: 'Delta',
      teamARoster: deltaPartialRoster,
      teamBRoster: sourcedRosterFixture('beta-partial-opponent', 'red', false),
    }),
  ], {})
  const sharedBot = playerFor(players, 'shared-bot')

  assert.equal(sharedBot.name, 'Shared Bot')
  assert.equal(sharedBot.team, 'Gamma')
  assert.equal(sharedBot.role, 'Bot')
  assert.equal(sharedBot.games, 2)
  assert.equal(sharedBot.source?.date, '2026-01-02')
  assert.equal(sharedBot.appearance?.latestTeamGames, 1)
  assert.equal(sharedBot.appearance?.latestTeamShare, 0.5)
  assert.equal(sharedBot.appearance?.roleGames, 2)
  assert.equal(sharedBot.appearance?.roleShare, 1)
  assert.equal(sharedBot.appearance?.teamsPlayed, 2)
  assert.equal(sharedBot.appearance?.rolesPlayed, 1)
  assert.deepEqual(sharedBot.appearance?.teamHistory.map((entry) => [entry.team, entry.games]), [
    ['Gamma', 1],
    ['Alpha', 1],
  ])
  assert.deepEqual(sharedBot.appearance?.roleHistory, [{ role: 'Bot', games: 2 }])
  assert.equal(sharedBot.appearance?.flags.includes('multi-team-career'), true)
  assert.equal(sharedBot.appearance?.flags.includes('thin-latest-team-sample'), true)
})

function standingFor(model: ReturnType<typeof buildRankingModel>, team: string) {
  const standing = model.standings.find((candidate) => candidate.team === team)
  assert.ok(standing)
  return standing
}

function componentRating(standing: { ratingComponents: ReturnType<typeof standingFor>['ratingComponents'] }) {
  const components = standing.ratingComponents
  return Math.round(
    components.leagueAnchor
    + components.teamStableOffset
    + components.rosterPriorOffset
    + components.momentum
    + components.contextAdjustment,
  )
}

function leagueFor(model: ReturnType<typeof buildRankingModel>, league: string) {
  const standing = model.leagues.find((candidate) => candidate.league === league)
  assert.ok(standing)
  return standing
}

function rosterFixture(prefix: string, completeness: 'complete-five-role' | 'partial' = 'complete-five-role'): MatchRecord['teamARoster'] {
  const roles = completeness === 'complete-five-role'
    ? ['Top', 'Jungle', 'Mid', 'Bot', 'Support'] as const
    : ['Top', 'Jungle'] as const
  return {
    sourceProvider: 'oracles-elixir',
    teamId: prefix,
    observedAt: '2026-01-01',
    completeness,
    players: roles.map((role) => ({
      id: `${prefix}-${role}`,
      name: `${prefix} ${role}`,
      role,
    })),
  }
}

function sourcedRosterFixture(
  prefix: string,
  side: Side,
  won: boolean,
  statOverrides: Partial<Record<Role, Partial<NonNullable<MatchRecord['teamARoster']>['players'][number]['stats']>>> = {},
): NonNullable<MatchRecord['teamARoster']> {
  const roles = ['Top', 'Jungle', 'Mid', 'Bot', 'Support'] as const
  return {
    sourceProvider: 'oracles-elixir',
    teamId: prefix,
    observedAt: '2026-01-01',
    completeness: 'complete-five-role',
    players: roles.map((role) => ({
      id: `${prefix}-${role}`,
      name: `${prefix} ${role}`,
      role,
      stats: {
        side,
        won,
        kills: won ? 4 : 2,
        deaths: won ? 2 : 4,
        assists: won ? 9 : 5,
        damageShare: 0.2,
        earnedGoldShare: 0.2,
        vspm: role === 'Support' ? 2.2 : 1,
        ...statOverrides[role],
      },
    })),
  }
}

function useSharedBotId(roster: NonNullable<MatchRecord['teamARoster']>, id: string) {
  roster.players = roster.players.map((player) =>
    player.role === 'Bot' ? { ...player, id, name: 'Shared Bot' } : player,
  )
}

function playerFor(players: ReturnType<typeof buildPlayerModel>, playerId: string) {
  const player = players.find((candidate) => candidate.id === playerId)
  assert.ok(player)
  return player
}

function leagueStrengthFixture(
  league: string,
  region: Region,
  tier: LeagueStrength['tier'],
  score: number,
): LeagueStrength {
  return {
    league,
    region,
    tier,
    priorScore: score,
    rawScore: score,
    connectivity: 1,
    score,
    adjustment: Math.round(score - 1500),
    delta: 0,
    wins: 0,
    losses: 0,
    internationalMatches: 0,
    form: [],
  }
}

function dateInJanuary(dayOffset: number) {
  return new Date(Date.UTC(2026, 0, dayOffset)).toISOString().slice(0, 10)
}

function lplSetupMatches(prefix: string, winner: 'Gamma' | 'Delta') {
  return Array.from({ length: 16 }, (_, index) => matchFixture({
    id: `${prefix}-lpl-${index}`,
    date: `2026-01-${String(index + 1).padStart(2, '0')}`,
    event: 'LPL 2026 Spring',
    region: 'LPL',
    league: 'LPL',
    teamAHomeLeague: 'LPL',
    teamBHomeLeague: 'LPL',
    teamARegion: 'LPL',
    teamBRegion: 'LPL',
    teamA: 'Gamma',
    teamB: 'Delta',
    winner,
  }))
}

function internationalVsGamma(id: string) {
  return matchFixture({
    id,
    date: '2026-01-20',
    event: 'Worlds 2026 Main',
    region: 'International',
    league: 'Worlds',
    teamB: 'Gamma',
    teamBHomeLeague: 'LPL',
    teamBRegion: 'LPL',
    tier: 'worlds-main',
  })
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

function matchFixture(overrides: Partial<MatchRecord>): MatchRecord {
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
