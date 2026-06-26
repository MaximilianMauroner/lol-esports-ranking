import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPlayerModel, buildRankingModel } from '../src/lib/model.ts'
import type { MatchRecord, PlayerProfile, TeamProfile } from '../src/types.ts'

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

test('standings expose uncertainty bands', () => {
  const model = buildRankingModel([matchFixture({ id: 'uncertainty' })], { ...teams })
  const alpha = standingFor(model, 'Alpha')
  const gamma = standingFor(model, 'Gamma')

  assert.ok(alpha.uncertainty > 0)
  assert.ok(alpha.uncertainty < gamma.uncertainty)
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

function standingFor(model: ReturnType<typeof buildRankingModel>, team: string) {
  const standing = model.standings.find((candidate) => candidate.team === team)
  assert.ok(standing)
  return standing
}

function leagueFor(model: ReturnType<typeof buildRankingModel>, league: string) {
  const standing = model.leagues.find((candidate) => candidate.league === league)
  assert.ok(standing)
  return standing
}

function playerFor(players: ReturnType<typeof buildPlayerModel>, playerId: string) {
  const player = players.find((candidate) => candidate.id === playerId)
  assert.ok(player)
  return player
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
