import assert from 'node:assert/strict'
import test from 'node:test'
import { effectiveLeagueRating, leagueEffectiveRatingCapsByTier } from '../src/data/leagueTiers.ts'
import { buildPlayerModel, buildRankingModel } from '../src/lib/model.ts'
import type { LeagueStrength, MatchRecord, PlayerProfile, Region, Role, Side, TeamProfile } from '../src/types.ts'

const teams: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
  Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
  Gamma: { name: 'Gamma', code: 'GAM', region: 'LPL', league: 'LPL' },
}

test('team Elo is result-only and series-damped per game', () => {
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
  const bo5Win = buildRankingModel([matchFixture({
    id: 'bo5-win',
    bestOf: 5,
  })], { ...teams })

  const dominantAlpha = standingFor(dominantWin, 'Alpha')
  const narrowAlpha = standingFor(narrowWin, 'Alpha')
  const bo5Alpha = standingFor(bo5Win, 'Alpha')

  assert.equal(dominantAlpha.baseRating, narrowAlpha.baseRating)
  assert.equal(dominantAlpha.rating, narrowAlpha.rating)
  assert.ok(bo5Alpha.baseRating - 1500 < dominantAlpha.baseRating - 1500)
  assert.ok(bo5Alpha.baseRating > 1500)
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
  assert.equal(alpha.history.at(-1)?.rating, componentRating(alpha.history.at(-1) ?? alpha))
  assert.equal(typeof alpha.history.at(-1)?.ratingUpdate.momentumDelta, 'number')
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
  ], { ...extendedTeams })
  const lck = leagueFor(withSameRegionFinal, 'LCK')

  assert.equal(lck.internationalMatches, 2)
  assert.ok(lck.score > leagueFor(pathOnly, 'LCK').score)
  assert.ok(standingFor(withSameRegionFinal, 'Alpha').ratingUpdate.leaguePlacementDelta > 0)
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
