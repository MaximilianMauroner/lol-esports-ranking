import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPlayerModel, buildRankingModel } from '../src/lib/model.ts'
import type { MatchRecord, PlayerProfile, Role, Side, TeamProfile } from '../src/types.ts'

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
    ...Array.from({ length: 8 }, (_, index) => matchFixture({
      id: `major-${index}`,
      date: `2026-03-${String(index + 1).padStart(2, '0')}`,
      teamA: 'Alpha',
      teamB: 'Beta',
      winner: index % 2 === 0 ? 'Alpha' : 'Beta',
    })),
    ...Array.from({ length: 10 }, (_, index) => matchFixture({
      id: `isolated-${index}`,
      date: `2026-03-${String(index + 11).padStart(2, '0')}`,
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

function playerFor(players: ReturnType<typeof buildPlayerModel>, playerId: string) {
  const player = players.find((candidate) => candidate.id === playerId)
  assert.ok(player)
  return player
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
