import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlayerDirectory, createRegionHistory, createStaticRankingData, createStaticRankingSummaryData, createTeamHistory, createTeamHistoryArtifacts, snapshotKey, teamStandingKey } from '../src/lib/snapshot.ts'
import { emptyRatingUpdateLedger } from '../src/lib/ratingCalculations.ts'
import { PUBLIC_ARTIFACT_SCHEMA_VERSION, compactStanding } from '../src/lib/publicArtifacts/schema.ts'
import type { StaticRankingData } from '../src/lib/snapshot.ts'
import type { LeagueStrengthHistoryPoint, MatchRecord, PlayerStanding, Region, Role, Side, TeamProfile, TeamStanding } from '../src/types.ts'
import { rosters, sampleMatches, teams } from './fixtures/rankingFixtures.ts'

function sourcedPlayer(overrides: Partial<PlayerStanding> & Pick<PlayerStanding, 'id' | 'name' | 'team' | 'role' | 'rank'>): PlayerStanding {
  return {
    games: 100,
    ratingBasis: 'sourced-player-stats',
    rating: 150,
    delta: 1,
    baseShare: 0.2,
    playerShare: 0.2,
    impactMultiplier: 1,
    availability: 1,
    roleCertainty: 1,
    impactDrivers: { objectiveImpactZ: 0, awardResidualZ: 0, recentFormZ: 0 },
    form: ['W', 'L'],
    history: [],
    ...overrides,
  }
}

function diagnosticMetric(value: number | null, games = value === null ? 0 : 100, missing = value === null ? 100 : 0) {
  return { value, games, missing }
}

test('createPlayerDirectory flattens sourced players and joins region/league from standings', () => {
  const standing = {
    team: 'Gen.G',
    code: 'GEN',
    region: 'LCK',
    league: 'LCK',
  } as unknown as TeamStanding
  const data = {
    generatedAt: '2026-06-26T00:00:00.000Z',
    model: { version: 'transparent-power-index-vT', configHash: 'fnv1a-test' },
    defaultSnapshotKey: 'key',
    teams: {},
    snapshots: {
      key: {
        standings: [standing],
        players: [
          sourcedPlayer({
            id: 'p1',
            name: 'Chovy',
            team: 'Gen.G',
            role: 'Mid',
            rank: 1,
            rating: 200,
            source: {
              provider: 'oracles-elixir',
              gameId: 'oe-player-proof',
              fileName: 'oracle-fixture.csv',
              date: '2026-06-26',
              event: 'LCK 2026 Rounds 1-2',
            },
            history: [{
              date: '2026-06-26',
              event: 'LCK 2026 Rounds 1-2',
              opponent: 'T1',
              opponentTeamCode: 'T1',
              playerTeam: 'Gen.G',
              playerTeamCode: 'GEN',
              result: 'W',
              teamKills: 16,
              opponentKills: 8,
              rating: 200,
              delta: 1,
              source: {
                provider: 'oracles-elixir',
                gameId: 'oe-player-proof',
                fileName: 'oracle-fixture.csv',
                date: '2026-06-26',
                event: 'LCK 2026 Rounds 1-2',
              },
            }],
            appearance: {
              primaryTeam: 'Gen.G',
              primaryTeamGames: 100,
              primaryTeamShare: 1,
              latestTeamGames: 100,
              latestTeamShare: 1,
              roleGames: 100,
              roleShare: 1,
              teamsPlayed: 1,
              rolesPlayed: 1,
              teamHistory: [{
                team: 'Gen.G',
                games: 100,
                latestObservedAt: '2026-06-26',
                latestObservedEvent: 'LCK 2026 Rounds 1-2',
              }],
              roleHistory: [{ role: 'Mid', games: 100 }],
              flags: [],
            },
            diagnostics: {
              sourceProvider: 'oracles-elixir',
              scope: 'rated-complete-role-matchups',
              sampleGames: 100,
              wins: 68,
              losses: 32,
              winRate: 0.68,
              noWinStatScore: diagnosticMetric(0.61),
              sameRoleMatchupDiff: diagnosticMetric(0.08),
              damageShare: diagnosticMetric(0.27),
              earnedGoldShare: diagnosticMetric(0.22),
              kda: diagnosticMetric(4.2),
              visionScore: diagnosticMetric(null),
              vspm: diagnosticMetric(1.05),
            },
            individualResidual: {
              sourceProvider: 'oracles-elixir',
              metricVersion: 'individual-residual-v0',
              scope: 'shadow-rated-complete-role-matchups',
              score: 113.4,
              rank: 4,
              rolePowerRank: 1,
              rankDelta: -3,
              confidence: 96.5,
              sampleGames: 100,
              adjustedSameRoleDiff: diagnosticMetric(0.134),
              expectedNoWinStatScore: diagnosticMetric(0.59),
              opponentStrengthProxy: diagnosticMetric(0.025),
              controls: {
                role: 'Mid',
                primaryLeague: 'LCK',
                leagueGames: 100,
                sideGames: { blue: 52, red: 48 },
                patchCount: 5,
                eventTierCounts: { 'regional-regular': 100 },
              },
              explanation: {
                noWinStatScore: diagnosticMetric(0.61),
                sameRoleMatchupDiff: diagnosticMetric(0.08),
                rolePowerRating: 200,
                teamWinRate: 0.68,
              },
            },
          }),
          sourcedPlayer({ id: 'p2', name: 'Demo', team: 'Gen.G', role: 'Top', rank: 2, ratingBasis: 'seeded-demo-rosters' }),
          sourcedPlayer({ id: 'p3', name: 'Zero', team: 'Gen.G', role: 'Jungle', rank: 3, games: 0 }),
        ],
      },
    },
  } as unknown as StaticRankingData

  const directory = createPlayerDirectory(data)

  assert.equal(directory.artifactKind, 'player-directory')
  assert.equal(directory.metric.id, 'role-power')
  assert.equal(directory.metric.teamResultSignal, 'included')
  assert.equal(directory.metric.independentSkillClaim, false)
  assert.equal(directory.comparisonMetrics?.[0]?.id, 'individual-residual')
  assert.equal(directory.comparisonMetrics?.[0]?.teamResultSignal, 'reduced')
  assert.equal(directory.comparisonMetrics?.[0]?.independentSkillClaim, false)
  assert.equal(directory.diagnostics?.sameTeamTopFiveClustering.status, 'diagnostic-not-failure')
  assert.deepEqual(directory.diagnostics?.sameTeamTopFiveClustering.teams, [])
  assert.equal(directory.ratedPlayerCount, 1)
  assert.equal(directory.ratedTeamCount, 1)
  assert.deepEqual(directory.roles, ['Mid'])
  const [chovy] = directory.players
  assert.equal(chovy.name, 'Chovy')
  assert.equal(chovy.region, 'LCK')
  assert.equal(chovy.league, 'LCK')
  assert.equal(chovy.teamCode, 'GEN')
  assert.equal(chovy.teamGames, 100)
  assert.equal(chovy.teamShare, 1)
  assert.equal(chovy.sourceProvider, 'oracles-elixir')
  assert.equal(chovy.latestObservedAt, '2026-06-26')
  assert.equal(chovy.latestObservedEvent, 'LCK 2026 Rounds 1-2')
  assert.equal(chovy.diagnostics, undefined)
  assert.equal(chovy.individualResidual?.sourceProvider, 'oracles-elixir')
  assert.equal(chovy.individualResidual?.metricVersion, 'individual-residual-v0')
  assert.equal(chovy.individualResidual?.score, 113.4)
  assert.equal(chovy.individualResidual?.rank, 1)
  assert.equal(chovy.individualResidual?.rolePowerRank, 1)
  assert.equal(chovy.individualResidual?.rankDelta, 0)
  assert.equal(chovy.individualResidual?.confidence, 96.5)
  assert.equal(chovy.individualResidual?.controls, undefined)
  assert.deepEqual(chovy.recentMatches, [{
    date: '2026-06-26',
    event: 'LCK 2026 Rounds 1-2',
    opponent: 'T1',
    opponentTeamCode: 'T1',
    playerTeam: 'Gen.G',
    playerTeamCode: 'GEN',
    result: 'W',
    wins: 1,
    losses: 0,
    games: 1,
    bestOf: 1,
  }])
  assert.equal(chovy.appearance?.latestTeamGames, 100)
  assert.equal(chovy.appearance?.roleGames, 100)
  assert.deepEqual(chovy.appearance?.teamHistory, [{
    team: 'Gen.G',
    games: 100,
    latestObservedAt: '2026-06-26',
    latestObservedEvent: 'LCK 2026 Rounds 1-2',
  }])
  assert.equal(directory.modelVersion, 'transparent-power-index-vT')
})

test('createPlayerDirectory groups recent player game rows into match series', () => {
  const standing = {
    team: 'Bilibili Gaming',
    code: 'BLG',
    region: 'LPL',
    league: 'LPL',
  } as unknown as TeamStanding
  const appearance = {
    primaryTeam: 'Bilibili Gaming',
    primaryTeamGames: 100,
    primaryTeamShare: 1,
    latestTeamGames: 100,
    latestTeamShare: 1,
    roleGames: 100,
    roleShare: 1,
    teamsPlayed: 1,
    rolesPlayed: 1,
    teamHistory: [{
      team: 'Bilibili Gaming',
      games: 100,
      latestObservedAt: '2026-06-14',
      latestObservedEvent: 'LPL 2026 Split 2',
    }],
    roleHistory: [{ role: 'Mid', games: 100 }],
    flags: [],
  } satisfies PlayerStanding['appearance']
  const seriesGame = (gameId: string, gameNumber: number): PlayerStanding['history'][number] => ({
    date: '2026-06-14',
    event: 'LPL 2026 Split 2',
    opponent: 'Top Esports',
    opponentTeamCode: 'TES',
    playerTeam: 'Bilibili Gaming',
    playerTeamCode: 'BLG',
    result: 'W',
    bestOf: 1,
    rating: 205,
    delta: 1,
    source: {
      provider: 'oracles-elixir',
      gameId,
      matchId: `LPL 2026 Split 2_Finals_1_${gameNumber}`,
      fileName: 'oracle-fixture.csv',
      date: '2026-06-14',
      event: 'LPL 2026 Split 2',
      bestOf: 1,
    },
  })
  const data = {
    generatedAt: '2026-06-26T00:00:00.000Z',
    model: { version: 'transparent-power-index-vT', configHash: 'fnv1a-test' },
    defaultSnapshotKey: 'key',
    teams: {},
    snapshots: {
      key: {
        standings: [standing],
        players: [
          sourcedPlayer({
            id: 'knight',
            name: 'Knight',
            team: 'Bilibili Gaming',
            role: 'Mid',
            rank: 1,
            rating: 210,
            source: {
              provider: 'oracles-elixir',
              gameId: 'tes-game-3',
              fileName: 'oracle-fixture.csv',
              date: '2026-06-14',
              event: 'LPL 2026 Split 2',
            },
            history: [
              {
                date: '2026-06-13',
                event: 'LPL 2026 Split 2',
                opponent: 'Team WE',
                opponentTeamCode: 'WE',
                playerTeam: 'Bilibili Gaming',
                playerTeamCode: 'BLG',
                result: 'W',
                bestOf: 3,
                rating: 202,
                delta: 1,
                source: {
                  provider: 'oracles-elixir',
                  gameId: 'we-game-1',
                  fileName: 'oracle-fixture.csv',
                  date: '2026-06-13',
                  event: 'LPL 2026 Split 2',
                  bestOf: 3,
                },
              },
              seriesGame('tes-game-1', 1),
              seriesGame('tes-game-2', 2),
              seriesGame('tes-game-3', 3),
            ],
            appearance,
          }),
        ],
      },
    },
  } as unknown as StaticRankingData

  const directory = createPlayerDirectory(data)

  assert.deepEqual(directory.players[0]?.recentMatches?.map((match) => ({
    opponent: match.opponentTeamCode,
    result: match.result,
    wins: match.wins,
    losses: match.losses,
    games: match.games,
    bestOf: match.bestOf,
    sourceGameIds: match.sourceGameIds,
  })), [
    {
      opponent: 'WE',
      result: 'W',
      wins: 1,
    losses: 0,
    games: 1,
    bestOf: 1,
    sourceGameIds: undefined,
  },
    {
      opponent: 'TES',
      result: 'W',
      wins: 3,
    losses: 0,
    games: 3,
    bestOf: 5,
    sourceGameIds: undefined,
  },
  ])
})

test('public team standing records count matches instead of source game rows', () => {
  const historyPoint = (
    opponent: string,
    result: 'W' | 'L',
    gameId: string,
    bestOf: number,
    delta: number,
  ): TeamStanding['history'][number] => ({
    date: opponent === 'Top Esports' ? '2026-06-14' : '2026-06-20',
    event: 'LPL 2026 Split 2',
    opponent,
    rating: 1800 + delta,
    baseRating: 1700,
    leagueAdjustment: 100,
    sideAdjustment: 0,
    ratingComponents: {
      leagueAnchor: 1700,
      teamStableOffset: 0,
      rosterPriorOffset: 0,
      momentum: 0,
      contextAdjustment: 0,
      uncertainty: 40,
    },
    ratingUpdate: {
      teamStableDelta: delta,
      leagueGameDelta: 0,
      leaguePlacementDelta: 0,
      momentumDelta: 0,
      rosterPriorDelta: 0,
      uncertaintyDelta: 0,
      sideAdjustment: 0,
      patchAdjustment: 0,
    },
    rank: 1,
    delta,
    tier: 'major-playoffs',
    result,
    source: {
      provider: 'oracles-elixir',
      gameId,
      fileName: 'oracle-fixture.csv',
      bestOf,
    },
  })
  const standing = {
    team: 'Bilibili Gaming',
    code: 'BLG',
    region: 'LPL',
    league: 'LPL',
    wins: 4,
    losses: 2,
    form: ['W', 'W', 'W', 'W', 'L'],
    history: [
      historyPoint('Top Esports', 'W', 'tes-game-1', 5, 5),
      historyPoint('Top Esports', 'W', 'tes-game-2', 5, 7),
      historyPoint('Top Esports', 'W', 'tes-game-3', 5, 6),
      historyPoint('JD Gaming', 'W', 'jdg-game-1', 3, 3),
      historyPoint('JD Gaming', 'L', 'jdg-game-2', 3, -8),
      historyPoint('JD Gaming', 'L', 'jdg-game-3', 3, -6),
    ],
  } as unknown as Parameters<typeof compactStanding>[0]

  const compact = compactStanding(standing)

  assert.equal(compact.wins, 1)
  assert.equal(compact.losses, 1)
  assert.deepEqual(compact.form, ['W', 'L'])
  assert.deepEqual(compact.recentMatches.map((match) => ({
    opponent: match.opponent,
    result: match.result,
    wins: match.wins,
    losses: match.losses,
    games: match.games,
    bestOf: match.bestOf,
  })), [
    {
      opponent: 'Top Esports',
      result: 'W',
      wins: 3,
      losses: 0,
      games: 3,
      bestOf: 5,
    },
    {
      opponent: 'JD Gaming',
      result: 'L',
      wins: 1,
      losses: 2,
      games: 3,
      bestOf: 3,
    },
  ])
})

test('public team recent match bestOf follows the observed decisive score', () => {
  const historyPoint = (
    opponent: string,
    result: 'W' | 'L',
    gameId: string,
    bestOf: number,
    delta: number,
  ): TeamStanding['history'][number] => ({
    date: '2026-05-27',
    event: 'Playoffs',
    opponent,
    rating: 1700 + delta,
    baseRating: 1650,
    leagueAdjustment: 50,
    sideAdjustment: 0,
    ratingComponents: {
      leagueAnchor: 1650,
      teamStableOffset: 0,
      rosterPriorOffset: 0,
      momentum: 0,
      contextAdjustment: 0,
      uncertainty: 40,
    },
    ratingUpdate: {
      teamStableDelta: delta,
      leagueGameDelta: 0,
      leaguePlacementDelta: 0,
      momentumDelta: 0,
      rosterPriorDelta: 0,
      uncertaintyDelta: 0,
      sideAdjustment: 0,
      patchAdjustment: 0,
    },
    rank: 1,
    delta,
    tier: 'major-playoffs',
    result,
    source: {
      provider: 'oracles-elixir',
      gameId,
      fileName: 'oracle-fixture.csv',
      bestOf,
    },
  })
  const compact = compactStanding({
    team: 'Bilibili Gaming',
    code: 'BLG',
    region: 'LPL',
    league: 'LPL',
    wins: 4,
    losses: 0,
    form: ['W', 'W', 'W', 'W'],
    history: [
      historyPoint('Top Esports', 'W', 'tes-game-1', 5, 6),
      historyPoint('Top Esports', 'W', 'tes-game-2', 5, 7),
      historyPoint('Team WE', 'W', 'we-game-1', 2, 4),
      historyPoint('Team WE', 'W', 'we-game-2', 2, 5),
    ],
  } as unknown as Parameters<typeof compactStanding>[0])

  assert.deepEqual(compact.recentMatches.map((match) => ({
    opponent: match.opponent,
    wins: match.wins,
    losses: match.losses,
    bestOf: match.bestOf,
  })), [
    {
      opponent: 'Top Esports',
      wins: 2,
      losses: 0,
      bestOf: 3,
    },
    {
      opponent: 'Team WE',
      wins: 2,
      losses: 0,
      bestOf: 2,
    },
  ])
})

test('public team standing records infer match series when source rows say bo1', () => {
  const historyPoint = (
    result: 'W' | 'L',
    gameId: string,
    delta: number,
  ): TeamStanding['history'][number] => ({
    date: '2025-11-09',
    event: 'WLDs 2025',
    opponent: 'KT Rolster',
    rating: 1700 + delta,
    baseRating: 1650,
    leagueAdjustment: 50,
    sideAdjustment: 0,
    ratingComponents: {
      leagueAnchor: 1650,
      teamStableOffset: 0,
      rosterPriorOffset: 0,
      momentum: 0,
      contextAdjustment: 0,
      uncertainty: 40,
    },
    ratingUpdate: {
      teamStableDelta: delta,
      leagueGameDelta: 0,
      leaguePlacementDelta: 0,
      momentumDelta: 0,
      rosterPriorDelta: 0,
      uncertaintyDelta: 0,
      sideAdjustment: 0,
      patchAdjustment: 0,
    },
    rank: 1,
    delta,
    tier: 'worlds-playoffs',
    result,
    source: {
      provider: 'oracles-elixir',
      gameId,
      fileName: 'oracle-fixture.csv',
      bestOf: 1,
    },
  })
  const compact = compactStanding({
    team: 'T1',
    code: 'T1',
    region: 'LCK',
    league: 'LCK',
    wins: 2,
    losses: 1,
    form: ['L', 'W', 'W'],
    history: [
      historyPoint('L', 'worlds-final-game-1', -8),
      historyPoint('W', 'worlds-final-game-2', 5),
      historyPoint('W', 'worlds-final-game-3', 6),
    ],
  } as unknown as Parameters<typeof compactStanding>[0])

  assert.equal(compact.wins, 1)
  assert.equal(compact.losses, 0)
  assert.deepEqual(compact.form, ['W'])
  assert.deepEqual(compact.recentMatches.map((match) => ({
    opponent: match.opponent,
    result: match.result,
    wins: match.wins,
    losses: match.losses,
    games: match.games,
    bestOf: match.bestOf,
  })), [{
    opponent: 'KT Rolster',
    result: 'W',
    wins: 2,
    losses: 1,
    games: 3,
    bestOf: 3,
  }])
})

test('public compact standings retain a paginatable recent match window', () => {
  const history: TeamStanding['history'] = Array.from({ length: 30 }, (_, index) => {
    const matchNumber = index + 1
    const date = `2026-05-${String(matchNumber).padStart(2, '0')}`
    return {
      date,
      event: 'LCK 2026',
      opponent: `Opponent ${matchNumber}`,
      rating: 1700 + matchNumber,
      baseRating: 1650,
      leagueAdjustment: 50,
      sideAdjustment: 0,
      ratingComponents: {
        leagueAnchor: 1650,
        teamStableOffset: 0,
        rosterPriorOffset: 0,
        momentum: 0,
        contextAdjustment: 0,
        uncertainty: 40,
      },
      ratingUpdate: emptyRatingUpdateLedger(),
      rank: 1,
      delta: 1,
      tier: 'regional-regular',
      result: matchNumber % 4 === 0 ? 'L' : 'W',
      source: {
        provider: 'oracles-elixir',
        gameId: `lck-fixture-${matchNumber}`,
        fileName: 'oracle-fixture.csv',
        bestOf: 1,
      },
    }
  })
  const compact = compactStanding({
    team: 'T1',
    code: 'T1',
    region: 'LCK',
    league: 'LCK',
    wins: 23,
    losses: 7,
    form: ['W', 'L', 'W', 'W', 'W'],
    history,
  } as unknown as Parameters<typeof compactStanding>[0])

  assert.equal(compact.recentMatches.length, 25)
  assert.equal(compact.recentMatches[0]?.opponent, 'Opponent 6')
  assert.equal(compact.recentMatches.at(-1)?.opponent, 'Opponent 30')
})

test('event-scoped public standings keep same-day Bo-series siblings across source event labels', () => {
  const splitTeams: Record<string, TeamProfile> = {
    'Karmine Corp': { name: 'Karmine Corp', code: 'KC', region: 'LEC', league: 'LEC' },
    Fnatic: { name: 'Fnatic', code: 'FNC', region: 'LEC', league: 'LEC' },
  }
  const splitSeriesGame = (
    id: string,
    event: string,
    sourceProvider: NonNullable<MatchRecord['sourceProvider']>,
    winner: 'Karmine Corp' | 'Fnatic',
    gameNumber: number,
  ): MatchRecord => ({
    id,
    sourceProvider,
    sourceGameId: id,
    sourceFileName: `${sourceProvider}.fixture`,
    dataCompleteness: sourceProvider === 'oracles-elixir' ? 'complete' : 'scoreboard-game-stats',
    date: '2025-09-26',
    season: 2025,
    event,
    phase: 'Round 2',
    region: 'LEC',
    league: 'LEC',
    teamAHomeLeague: 'LEC',
    teamBHomeLeague: 'LEC',
    teamARegion: 'LEC',
    teamBRegion: 'LEC',
    patch: '25.18',
    bestOf: 5,
    tier: 'major-playoffs',
    teamA: 'Karmine Corp',
    teamB: 'Fnatic',
    winner,
    teamAKills: winner === 'Karmine Corp' ? 20 + gameNumber : 4 + gameNumber,
    teamBKills: winner === 'Fnatic' ? 13 + gameNumber : 7 + gameNumber,
    teamAGold: winner === 'Karmine Corp' ? 71000 + gameNumber : 54000 + gameNumber,
    teamBGold: winner === 'Fnatic' ? 73000 + gameNumber : 70000 + gameNumber,
  })
  const data = createStaticRankingData({
    matches: [
      splitSeriesGame('oracle-game-1', 'LEC 2025 Summer', 'oracles-elixir', 'Fnatic', 1),
      splitSeriesGame('oracle-game-2', 'LEC 2025 Summer', 'oracles-elixir', 'Fnatic', 2),
      splitSeriesGame('leaguepedia-game-3', 'LEC/2025 Season/Summer Playoffs', 'leaguepedia-cargo', 'Karmine Corp', 3),
      splitSeriesGame('leaguepedia-game-4', 'LEC/2025 Season/Summer Playoffs', 'leaguepedia-cargo', 'Fnatic', 4),
    ],
    teams: splitTeams,
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
  })

  const { snapshots } = createStaticRankingSummaryData(data)
  const eventKey = snapshotKey({ season: 'All', event: 'LEC/2025 Season/Summer Playoffs', region: 'All' })
  assert.equal(snapshots[eventKey], undefined)
  const internalSnapshot = data.snapshots[eventKey]
  assert.ok(internalSnapshot)
  const shard = {
    standings: internalSnapshot.standings.map((standing) => compactStanding(standing, { includeRatingUpdate: false })),
  }
  const karmine = shard.standings.find((standing) => standing.team === 'Karmine Corp')
  const fnatic = shard.standings.find((standing) => standing.team === 'Fnatic')

  assert.equal(karmine?.wins, 0)
  assert.equal(karmine?.losses, 1)
  assert.deepEqual(karmine?.recentMatches.map((match) => ({
    event: match.event,
    opponent: match.opponent,
    result: match.result,
    wins: match.wins,
    losses: match.losses,
    games: match.games,
    bestOf: match.bestOf,
  })), [{
    event: 'LEC/2025 Season/Summer Playoffs',
    opponent: 'Fnatic',
    result: 'L',
    wins: 1,
    losses: 3,
    games: 4,
    bestOf: 5,
  }])
  assert.equal(fnatic?.wins, 1)
  assert.equal(fnatic?.losses, 0)
  assert.equal(
    shard.standings
      .flatMap((standing) => standing.recentMatches)
      .some((match) => match.games && match.games > 1 && match.wins === match.losses),
    false,
  )
})

test('createPlayerDirectory credits season rows to the primary scoped team', () => {
  const hleStanding = {
    team: 'Hanwha Life Esports',
    code: 'HLE',
    region: 'LCK',
    league: 'LCK',
    eligibility: {
      eligible: true,
      reasons: [],
      currentWindowGames: 40,
      minCurrentWindowGames: 6,
      windowDays: 90,
    },
  } as unknown as TeamStanding
  const blgStanding = {
    team: 'Bilibili Gaming',
    code: 'BLG',
    region: 'LPL',
    league: 'LPL',
    eligibility: {
      eligible: true,
      reasons: [],
      currentWindowGames: 40,
      minCurrentWindowGames: 6,
      windowDays: 90,
    },
  } as unknown as TeamStanding
  const seasonKey = snapshotKey({ season: '2025', event: 'All', region: 'All' })
  const transferredPlayer = sourcedPlayer({
    id: 'viper-transfer',
    name: 'Viper',
    team: 'Bilibili Gaming',
    role: 'Bot',
    rank: 1,
    games: 161,
    rating: 140,
    appearance: {
      primaryTeam: 'Hanwha Life Esports',
      primaryTeamGames: 152,
      primaryTeamShare: 0.944,
      latestTeamGames: 9,
      latestTeamShare: 0.056,
      roleGames: 161,
      roleShare: 1,
      teamsPlayed: 2,
      rolesPlayed: 1,
      teamHistory: [
        { team: 'Hanwha Life Esports', games: 152, latestObservedAt: '2025-11-01', latestObservedEvent: 'WLDs 2025' },
        { team: 'Bilibili Gaming', games: 9, latestObservedAt: '2025-12-15', latestObservedEvent: 'Demacia Cup 2025' },
      ],
      roleHistory: [{ role: 'Bot', games: 161 }],
      flags: ['multi-team-career'],
    },
  })
  const data = {
    generatedAt: '2026-06-26T00:00:00.000Z',
    model: { version: 'transparent-power-index-vT', configHash: 'fnv1a-test' },
    defaultSnapshotKey: 'All__All__All',
    teams: {},
    snapshots: {
      All__All__All: {
        filter: { season: 'All', event: 'All', region: 'All' },
        standings: [hleStanding, blgStanding],
        players: [transferredPlayer],
      },
      [seasonKey]: {
        filter: { season: '2025', event: 'All', region: 'All' },
        standings: [hleStanding, blgStanding],
        players: [transferredPlayer],
      },
    },
  } as unknown as StaticRankingData

  const directory = createPlayerDirectory(data)
  const seasonViper = directory.scopedPlayers?.[seasonKey]?.[0]

  assert.deepEqual(directory.players, [])
  assert.equal(seasonViper?.team, 'Hanwha Life Esports')
  assert.equal(seasonViper?.teamCode, 'HLE')
  assert.equal(seasonViper?.region, 'LCK')
  assert.equal(seasonViper?.teamGames, 152)
  assert.equal(seasonViper?.teamShare, 0.944)
})

test('createPlayerDirectory gates low-sample sourced players from ranked public rows', () => {
  const standing = {
    team: 'Gen.G',
    code: 'GEN',
    region: 'LCK',
    league: 'LCK',
  } as unknown as TeamStanding
  const seasonKey = snapshotKey({ season: '2026', event: 'All', region: 'All' })
  const players = [
    sourcedPlayer({ id: 'thin', name: 'Thin Sample', team: 'Gen.G', role: 'Jungle', rank: 1, games: 19, rating: 240 }),
    sourcedPlayer({ id: 'ready', name: 'Ready Sample', team: 'Gen.G', role: 'Mid', rank: 2, games: 20, rating: 220 }),
  ]
  const data = {
    generatedAt: '2026-06-26T00:00:00.000Z',
    model: { version: 'transparent-power-index-vT', configHash: 'fnv1a-test' },
    defaultSnapshotKey: 'All__All__All',
    teams: {},
    snapshots: {
      All__All__All: {
        filter: { season: 'All', event: 'All', region: 'All' },
        standings: [standing],
        players,
      },
      [seasonKey]: {
        filter: { season: '2026', event: 'All', region: 'All' },
        standings: [standing],
        players,
      },
    },
  } as unknown as StaticRankingData

  const directory = createPlayerDirectory(data)

  assert.deepEqual(directory.players.map((player) => player.name), ['Ready Sample'])
  assert.equal(directory.players[0]?.rank, 1)
  assert.deepEqual(directory.scopedPlayers?.[seasonKey]?.map((player) => player.name), ['Ready Sample'])
  assert.equal(directory.scopedPlayers?.[seasonKey]?.[0]?.rank, 1)
})

test('createPlayerDirectory gates unanchored-league teams from ranked public player rows', () => {
  const majorStanding = {
    team: 'Gen.G',
    code: 'GEN',
    region: 'LCK',
    league: 'LCK',
    eligibility: {
      eligible: true,
      reasons: [],
      currentWindowGames: 12,
      minCurrentWindowGames: 6,
      windowDays: 90,
    },
  } as unknown as TeamStanding
  const emergingStanding = {
    team: 'Galions',
    code: 'GALI',
    region: 'LEC',
    league: 'LFL',
    eligibility: {
      eligible: false,
      reasons: ['unanchored-league'],
      currentWindowGames: 20,
      minCurrentWindowGames: 6,
      windowDays: 90,
    },
  } as unknown as TeamStanding
  const data = {
    generatedAt: '2026-06-26T00:00:00.000Z',
    model: { version: 'transparent-power-index-vT', configHash: 'fnv1a-test' },
    defaultSnapshotKey: 'All__All__All',
    teams: {},
    snapshots: {
      All__All__All: {
        filter: { season: 'All', event: 'All', region: 'All' },
        standings: [majorStanding, emergingStanding],
        players: [
          sourcedPlayer({ id: 'major-player', name: 'Major Player', team: 'Gen.G', role: 'Mid', rank: 2, games: 40, rating: 120 }),
          sourcedPlayer({ id: 'emerging-player', name: 'Emerging Player', team: 'Galions', role: 'Jungle', rank: 1, games: 94, rating: 130 }),
        ],
      },
    },
  } as unknown as StaticRankingData

  const directory = createPlayerDirectory(data)

  assert.deepEqual(directory.players.map((player) => player.name), ['Major Player'])
  assert.equal(directory.players[0]?.rank, 1)
})

test('createTeamHistory reports omitted standings with fewer than two points', () => {
  const includedStanding = {
    team: 'Alpha',
    code: 'ALP',
    region: 'LCK',
    history: [
      {
        date: '2026-01-01',
        event: 'LCK Cup',
        opponent: 'Beta',
        rating: 1500,
        baseRating: 1500,
        leagueAdjustment: 0,
        ratingComponents: {},
        ratingUpdate: {},
        rank: 2,
        delta: 0,
        tier: 'regional-regular',
        result: 'W',
        source: { provider: 'oracles-elixir', gameId: 'g1', fileName: 'fixture.csv' },
      },
      {
        date: '2026-01-02',
        event: 'LCK Cup',
        opponent: 'Gamma',
        rating: 1510,
        baseRating: 1510,
        leagueAdjustment: 0,
        ratingComponents: {},
        ratingUpdate: {},
        rank: 1,
        delta: 10,
        tier: 'regional-regular',
        result: 'W',
        source: { provider: 'oracles-elixir', gameId: 'g2', fileName: 'fixture.csv' },
      },
    ],
  } as unknown as TeamStanding
  const omittedStanding = {
    team: 'Beta',
    code: 'BET',
    region: 'LCK',
    history: [
      { date: '2026-01-01', rating: 1490, rank: 2 },
    ],
  } as unknown as TeamStanding
  const data = {
    generatedAt: '2026-06-26T00:00:00.000Z',
    model: { version: 'transparent-power-index-vT', configHash: 'fnv1a-test' },
    defaultSnapshotKey: 'key',
    teams: {},
    snapshots: {
      key: {
        standings: [includedStanding, omittedStanding],
      },
    },
  } as unknown as StaticRankingData

  const history = createTeamHistory(data)

  assert.equal(history.artifactKind, 'team-history')
  assert.equal(history.teamCount, 1)
  assert.equal(history.pointCount, 2)
  assert.equal(history.omissionPolicy.minimumPointsPerSeries, 2)
  assert.equal(history.omissionPolicy.omittedSeriesCount, 1)
  assert.match(history.omissionPolicy.reason, /fewer than two/)
  assert.ok(history.series[teamStandingKey(includedStanding)])
  assert.equal(history.series[teamStandingKey(includedStanding)].points[1][3]?.event, 'LCK Cup')
  assert.equal(history.series[teamStandingKey(includedStanding)].points[1][3]?.opponent, 'Gamma')
  assert.equal(history.series[teamStandingKey(includedStanding)].points[1][3]?.delta, 33)
  assert.equal(history.series[teamStandingKey(includedStanding)].points[1][3]?.sourceProvider, 'oracles-elixir')
  assert.equal(history.series[teamStandingKey(omittedStanding)], undefined)
})

test('createTeamHistory publishes match-level history points for multi-game series', () => {
  const standing = {
    team: 'Hanwha Life Esports',
    code: 'HLE',
    region: 'LCK',
    history: [
      {
        date: '2026-05-20',
        event: 'LCK 2026 Rounds 1-2',
        opponent: 'T1',
        rating: 1639,
        baseRating: 1639,
        leagueAdjustment: 0,
        ratingComponents: {},
        ratingUpdate: {},
        rank: 1,
        delta: 7,
        tier: 'regional-regular',
        result: 'W',
        source: { provider: 'oracles-elixir', gameId: 'warmup-game', fileName: 'fixture.csv', bestOf: 1 },
      },
      {
        date: '2026-05-27',
        event: 'LCK 2026 Rounds 1-2',
        opponent: 'Gen.G',
        rating: 1635,
        baseRating: 1635,
        leagueAdjustment: 0,
        ratingComponents: {},
        ratingUpdate: {},
        rank: 1,
        delta: 10,
        tier: 'regional-regular',
        result: 'W',
        source: {
          provider: 'oracles-elixir',
          gameId: 'hle-gen-game-1',
          matchId: 'LCK 2026 Rounds 1-2_Round 1_1_1',
          fileName: 'fixture.csv',
          bestOf: 3,
        },
      },
      {
        date: '2026-05-27',
        event: 'LCK 2026 Rounds 1-2',
        opponent: 'Gen.G',
        rating: 1622,
        baseRating: 1622,
        leagueAdjustment: 0,
        ratingComponents: {},
        ratingUpdate: {},
        rank: 2,
        delta: -13,
        tier: 'regional-regular',
        result: 'L',
        source: {
          provider: 'oracles-elixir',
          gameId: 'hle-gen-game-2',
          matchId: 'LCK 2026 Rounds 1-2_Round 1_1_2',
          fileName: 'fixture.csv',
          bestOf: 3,
        },
      },
      {
        date: '2026-05-27',
        event: 'LCK 2026 Rounds 1-2',
        opponent: 'Gen.G',
        rating: 1611,
        baseRating: 1611,
        leagueAdjustment: 0,
        ratingComponents: {},
        ratingUpdate: {},
        rank: 2,
        delta: -11,
        tier: 'regional-regular',
        result: 'L',
        source: {
          provider: 'oracles-elixir',
          gameId: 'hle-gen-game-3',
          matchId: 'LCK 2026 Rounds 1-2_Round 1_1_3',
          fileName: 'fixture.csv',
          bestOf: 3,
        },
      },
    ],
  } as unknown as TeamStanding
  const data = {
    generatedAt: '2026-06-26T00:00:00.000Z',
    model: { version: 'transparent-power-index-vT', configHash: 'fnv1a-test' },
    defaultSnapshotKey: 'key',
    teams: {},
    snapshots: {
      key: {
        standings: [standing],
      },
    },
  } as unknown as StaticRankingData

  const history = createTeamHistory(data)
  const points = history.series[teamStandingKey(standing)].points
  const seriesPoint = points[1]

  assert.equal(points.length, 2)
  assert.equal(history.pointCount, 2)
  assert.equal(seriesPoint[1], 2161)
  assert.equal(seriesPoint[3]?.result, 'L')
  assert.equal(seriesPoint[3]?.wins, 1)
  assert.equal(seriesPoint[3]?.losses, 2)
  assert.equal(seriesPoint[3]?.games, 3)
  assert.equal(seriesPoint[3]?.bestOf, 3)
  assert.equal(seriesPoint[3]?.delta, -45)
  assert.deepEqual(seriesPoint[3]?.sourceGameIds, ['hle-gen-game-1', 'hle-gen-game-2', 'hle-gen-game-3'])
})

test('createTeamHistory keeps independent official same-day matches separate', () => {
  const historyPoint = (
    gameId: string,
    officialMatchId: string,
    rating: number,
    delta: number,
  ): TeamStanding['history'][number] => ({
    date: '2026-05-27',
    event: 'LCK 2026 Rounds 1-2',
    opponent: 'Gen.G',
    rating,
    baseRating: rating,
    leagueAdjustment: 0,
    sideAdjustment: 0,
    ratingComponents: {
      leagueAnchor: 1500,
      teamStableOffset: rating - 1500,
      rosterPriorOffset: 0,
      momentum: 0,
      contextAdjustment: 0,
      uncertainty: 40,
    },
    ratingUpdate: emptyRatingUpdateLedger(),
    rank: 1,
    delta,
    tier: 'regional-regular',
    result: 'W',
    source: {
      provider: 'oracles-elixir',
      gameId,
      officialMatchId,
      officialGameId: `${officialMatchId}-game-1`,
      fileName: 'fixture.csv',
      bestOf: 1,
    },
  })
  const standing = {
    team: 'T1',
    code: 'T1',
    region: 'LCK',
    history: [
      {
        date: '2026-05-20',
        event: 'LCK 2026 Rounds 1-2',
        opponent: 'KT Rolster',
        rating: 1600,
        baseRating: 1600,
        leagueAdjustment: 0,
        ratingComponents: {},
        ratingUpdate: {},
        rank: 1,
        delta: 5,
        tier: 'regional-regular',
        result: 'W',
        source: { provider: 'oracles-elixir', gameId: 'warmup-game', fileName: 'fixture.csv', bestOf: 1 },
      },
      historyPoint('t1-gen-series-1', 'official-match-1', 1610, 10),
      historyPoint('t1-gen-series-2', 'official-match-2', 1620, 10),
    ],
  } as unknown as TeamStanding
  const data = {
    generatedAt: '2026-06-26T00:00:00.000Z',
    model: { version: 'transparent-power-index-vT', configHash: 'fnv1a-test' },
    defaultSnapshotKey: 'key',
    teams: {},
    snapshots: {
      key: {
        standings: [standing],
      },
    },
  } as unknown as StaticRankingData

  const history = createTeamHistory(data)
  const points = history.series[teamStandingKey(standing)].points

  assert.equal(points.length, 3)
  assert.deepEqual(points.slice(1).map((point) => point[3]?.officialMatchId), ['official-match-1', 'official-match-2'])
  assert.deepEqual(points.slice(1).map((point) => point[3]?.games), [1, 1])
})

test('createTeamHistory preserves the final atomic delta for model-correct series rows', () => {
  const standing = {
    team: 'Karmine Corp',
    code: 'KC',
    region: 'LEC',
    history: [
      {
        date: '2026-05-30',
        event: 'LEC 2026 Spring',
        opponent: 'Natus Vincere',
        rating: 1545,
        baseRating: 1540,
        leagueAdjustment: 0,
        ratingComponents: {},
        ratingUpdate: { updateUnit: 'series-atomic' },
        rank: 2,
        delta: 9,
        tier: 'major-playoffs',
        result: 'W',
        source: { provider: 'oracles-elixir', gameId: 'kc-warmup-game', fileName: 'fixture.csv', bestOf: 1 },
      },
      ...[
        { gameId: 'LOLTMNT05_195683', result: 'W', rating: 1554, delta: 0, updateUnit: 'series-member-no-team-update' },
        { gameId: 'LOLTMNT05_196635', result: 'L', rating: 1554, delta: 0, updateUnit: 'series-member-no-team-update' },
        { gameId: 'LOLTMNT05_196637', result: 'W', rating: 1554, delta: 0, updateUnit: 'series-member-no-team-update' },
        { gameId: 'LOLTMNT05_195687', result: 'L', rating: 1554, delta: 0, updateUnit: 'series-member-no-team-update' },
        { gameId: 'LOLTMNT05_196638', result: 'L', rating: 1546, delta: -9, updateUnit: 'series-atomic' },
      ].map(({ gameId, result, rating, delta, updateUnit }) => ({
        date: '2026-06-07',
        event: 'LEC 2026 Spring',
        opponent: 'G2 Esports',
        rating,
        baseRating: rating,
        leagueAdjustment: 0,
        ratingComponents: {},
        ratingUpdate: gameId === 'LOLTMNT05_196638'
          ? {
              updateUnit,
              teamStableDelta: -7.2,
              leagueGameDelta: -0.7,
              leaguePlacementDelta: 0.2,
              momentumDelta: -0.9,
              rosterPriorDelta: -1.1,
              uncertaintyDelta: 0,
              resultEvidence: -8.8,
              neutralResultResidual: -0.43,
              seriesStrengthSignal: -1.12,
            }
          : { updateUnit },
        rank: 2,
        delta,
        tier: 'major-playoffs',
        result,
        source: { provider: 'oracles-elixir', gameId, fileName: 'fixture.csv', bestOf: 5 },
      })),
    ],
  } as unknown as TeamStanding
  const data = {
    generatedAt: '2026-06-26T00:00:00.000Z',
    model: { version: 'transparent-power-index-vT', configHash: 'fnv1a-test' },
    defaultSnapshotKey: 'key',
    teams: {},
    snapshots: {
      key: {
        standings: [standing],
      },
    },
  } as unknown as StaticRankingData

  const history = createTeamHistory(data)
  const points = history.series[teamStandingKey(standing)].points
  const seriesPoint = points[1]

  assert.equal(points.length, 2)
  assert.equal(seriesPoint[3]?.result, 'L')
  assert.equal(seriesPoint[3]?.wins, 2)
  assert.equal(seriesPoint[3]?.losses, 3)
  assert.equal(seriesPoint[3]?.games, 5)
  assert.equal(seriesPoint[3]?.bestOf, 5)
  assert.equal(seriesPoint[3]?.delta, -29)
  assert.deepEqual(seriesPoint[3]?.model, {
    e: 0.43,
  })
  assert.deepEqual(seriesPoint[3]?.sourceGameIds, [
    'LOLTMNT05_195683',
    'LOLTMNT05_196635',
    'LOLTMNT05_196637',
    'LOLTMNT05_195687',
    'LOLTMNT05_196638',
  ])
})

test('createTeamHistory final point matches published standing rating', () => {
  const standing = {
    team: 'Bilibili Gaming',
    code: 'BLG',
    region: 'LPL',
    league: 'LPL',
    rating: 1699,
    rank: 1,
    history: [
      {
        date: '2026-06-13',
        event: 'LPL 2026 Split 2',
        opponent: 'Team WE',
        rating: 1685,
        rank: 1,
        delta: -13,
        tier: 'major-playoffs',
        result: 'W',
        source: { provider: 'oracles-elixir', gameId: 'blg-we-game-5', fileName: 'fixture.csv', bestOf: 5 },
      },
      {
        date: '2026-06-14',
        event: 'LPL 2026 Split 2',
        opponent: 'Top Esports',
        rating: 1704,
        rank: 1,
        delta: 21,
        tier: 'major-playoffs',
        result: 'W',
        source: { provider: 'oracles-elixir', gameId: 'blg-tes-game-3', fileName: 'fixture.csv', bestOf: 5 },
      },
    ],
  } as unknown as TeamStanding
  const data = {
    generatedAt: '2026-06-28T00:00:00.000Z',
    model: { version: 'transparent-power-index-vT', configHash: 'fnv1a-test' },
    defaultSnapshotKey: 'key',
    teams: {},
    snapshots: {
      key: {
        standings: [standing],
      },
    },
  } as unknown as StaticRankingData

  const history = createTeamHistory(data)
  const points = history.series[teamStandingKey(standing)].points
  const matchPoint = points.at(-2)
  const latest = points.at(-1)

  assert.equal(points.length, 3)
  assert.equal(matchPoint?.[1], 2463)
  assert.equal(matchPoint?.[3]?.opponent, 'Top Esports')
  assert.equal(matchPoint?.[3]?.result, 'W')
  assert.equal(latest?.[1], 2447)
  assert.equal(latest?.[2], 1)
  assert.equal(latest?.[3]?.kind, 'standing-adjustment')
  assert.equal(latest?.[3]?.event, 'Published standing adjustment')
  assert.equal(latest?.[3]?.delta, -16)
})

test('createTeamHistory skips unresolved tied match groups', () => {
  const historyPoint = (
    date: string,
    opponent: string,
    result: 'W' | 'L',
    gameId: string,
    bestOf: number,
    delta: number,
  ): TeamStanding['history'][number] => ({
    date,
    event: 'LCK 2026 Rounds 1-2',
    opponent,
    rating: 1600 + delta,
    baseRating: 1600,
    leagueAdjustment: 0,
    sideAdjustment: 0,
    ratingComponents: {
      leagueAnchor: 1500,
      teamStableOffset: 100,
      rosterPriorOffset: 0,
      momentum: 0,
      contextAdjustment: 0,
      uncertainty: 50,
    },
    ratingUpdate: emptyRatingUpdateLedger(),
    rank: 1,
    delta,
    tier: 'regional-regular',
    result,
    source: { provider: 'oracles-elixir', gameId, fileName: 'fixture.csv', bestOf },
  })
  const standing = {
    team: 'T1',
    code: 'T1',
    region: 'LCK',
    history: [
      historyPoint('2026-05-20', 'Gen.G', 'W', 'decisive-1', 3, 8),
      historyPoint('2026-05-20', 'Gen.G', 'W', 'decisive-2', 3, 5),
      historyPoint('2026-05-27', 'Hanwha Life Esports', 'W', 'tied-1', 3, 7),
      historyPoint('2026-05-27', 'Hanwha Life Esports', 'L', 'tied-2', 3, -9),
      historyPoint('2026-06-03', 'Dplus KIA', 'W', 'single-1', 1, 4),
    ],
  } as unknown as TeamStanding
  const data = {
    generatedAt: '2026-06-26T00:00:00.000Z',
    model: { version: 'transparent-power-index-vT', configHash: 'fnv1a-test' },
    defaultSnapshotKey: 'key',
    teams: {},
    snapshots: {
      key: {
        standings: [standing],
      },
    },
  } as unknown as StaticRankingData

  const history = createTeamHistory(data)
  const points = history.series[teamStandingKey(standing)].points

  assert.equal(history.pointCount, 2)
  assert.deepEqual(points.map((point) => point[3]?.opponent), ['Gen.G', 'Dplus KIA'])
  assert.equal(points.some((point) => point[3]?.wins === point[3]?.losses), false)
})

test('createTeamHistoryArtifacts slices default and season scopes into indexed shards', () => {
  const data = createStaticRankingData({
    matches: sampleMatches,
    teams,
    rosters,
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
  const seasonKey = snapshotKey({ season: '2026', event: 'All', region: 'All' })
  const history = createTeamHistoryArtifacts(data, {
    teamHistoryUrlForKey: (key) => `/history/${key}.json`,
  })
  const defaultEntry = history.index.scopeIndex[data.defaultSnapshotKey]
  const seasonEntry = history.index.scopeIndex[seasonKey]
  const seasonShard = history.shards[seasonKey]

  assert.equal(history.index.artifactKind, 'team-history-index')
  assert.equal(history.index.defaultScopeKey, data.defaultSnapshotKey)
  assert.ok(defaultEntry)
  assert.ok(seasonEntry)
  assert.ok(seasonShard)
  assert.equal(seasonEntry.url, `/history/${seasonKey}.json`)
  assert.deepEqual(seasonEntry.filter, { season: '2026', event: 'All', region: 'All' })
  assert.deepEqual(seasonShard.filter, seasonEntry.filter)
  assert.equal(seasonEntry.teamCount, seasonShard.teamCount)
  assert.equal(seasonEntry.pointCount, seasonShard.pointCount)
  assert.equal(history.shards[data.defaultSnapshotKey].pointCount, defaultEntry.pointCount)
})

test('season checkpoint scopes publish movement and companion history artifacts', () => {
  const checkpointMatches: MatchRecord[] = [
    checkpointMatch('lck-opener', '2026-01-17', 'LCK 2026 Spring', 'LCK', 'Gen.G', 'T1', 'Gen.G'),
    checkpointMatch('fst-final', '2026-03-22', 'FST 2026', 'FST', 'Gen.G', 'G2 Esports', 'Gen.G'),
    checkpointMatch('ewc-match', '2026-05-14', 'EWC 2026', 'EWC', 'G2 Esports', 'T1', 'T1'),
    checkpointMatch('msi-final', '2026-06-28', 'MSI 2026', 'MSI', 'T1', 'Gen.G', 'T1'),
    checkpointMatch('worlds-final', '2026-11-08', 'WLDs 2026', 'WLDs', 'T1', 'Bilibili Gaming', 'T1'),
  ]
  const data = createStaticRankingData({
    matches: checkpointMatches,
    teams,
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
  const checkpoints = data.filterOptions.checkpoints?.['2026'] ?? []
  const [split1, split2, split3] = checkpoints
  assert.ok(split1)
  assert.ok(split2)
  assert.ok(split3)
  const checkpointFilter = { season: '2026', event: 'All', region: 'All', checkpoint: split2.id } as const
  const checkpointKey = snapshotKey(checkpointFilter)
  const checkpointSnapshot = data.snapshots[checkpointKey]
  const worldsSnapshot = data.snapshots[snapshotKey({ season: '2026', event: 'All', region: 'All', checkpoint: split3.id })]
  const summary = createStaticRankingSummaryData(data)
  const teamHistory = createTeamHistoryArtifacts(data)
  const regionHistory = createRegionHistory(data)

  assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.id), ['split-1', 'split-2', 'split-3'])
  assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.boundaryEvent), ['FST 2026', 'MSI 2026', 'WLDs 2026'])
  assert.equal(checkpoints.some((checkpoint) => checkpoint.boundaryEvent === 'EWC 2026'), false)
  assert.deepEqual(
    checkpoints.map(({ startDate, endDate, previousEndDate }) => ({ startDate, endDate, previousEndDate })),
    [
      { startDate: '2026-01-01', endDate: '2026-03-22', previousEndDate: undefined },
      { startDate: '2026-03-23', endDate: '2026-06-28', previousEndDate: '2026-03-22' },
      { startDate: '2026-06-29', endDate: '2026-11-08', previousEndDate: '2026-06-28' },
    ],
  )
  assert.ok(checkpointSnapshot)
  assert.ok(worldsSnapshot)
  assert.deepEqual(checkpointSnapshot.filter, checkpointFilter)
  assert.equal(checkpointSnapshot.matchCount, 2)
  assert.equal(worldsSnapshot.matchCount, 1)
  assert.equal(checkpointSnapshot.events.map((event) => event.event).includes('EWC 2026'), true)
  assert.equal(checkpointSnapshot.standings.some((standing) => standing.movement !== 0 || standing.delta !== 0), true)
  assert.ok(summary.manifest.snapshotIndex[checkpointKey])
  assert.ok(summary.snapshots[checkpointKey])
  assert.ok(teamHistory.index.scopeIndex[checkpointKey])
  assert.ok(teamHistory.shards[checkpointKey])
  assert.ok(regionHistory.scopes[checkpointKey])
})

test('season checkpoint boundaries ignore domestic Road to MSI and Esports World Cup labels', () => {
  const data = createStaticRankingData({
    matches: [
      checkpointMatch('fst-final', '2026-03-22', 'FST 2026', 'FST', 'Gen.G', 'G2 Esports', 'Gen.G'),
      checkpointMatch('road-to-msi', '2026-06-13', 'LCK/2026 Season/Road to MSI', 'LCK', 'Gen.G', 'T1', 'Gen.G'),
      checkpointMatch('ewc-full-name', '2026-07-05', 'Esports World Cup 2026', 'EWC', 'G2 Esports', 'T1', 'T1'),
    ],
    teams,
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
  const checkpoints = data.filterOptions.checkpoints?.['2026'] ?? []

  assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.id), ['split-1'])
  assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.boundaryEvent), ['FST 2026'])
})

function checkpointMatch(
  id: string,
  date: string,
  event: string,
  league: string,
  teamA: string,
  teamB: string,
  winner: string,
): MatchRecord {
  return {
    id,
    sourceProvider: 'seed',
    dataCompleteness: 'complete',
    season: Number(date.slice(0, 4)),
    date,
    event,
    phase: 'Bracket',
    region: league === 'LCK' ? 'LCK' : 'International',
    league,
    patch: '26.1',
    bestOf: league === 'LCK' ? 1 : 5,
    tier: checkpointTier(league),
    teamA,
    teamB,
    winner,
    teamAKills: winner === teamA ? 20 : 12,
    teamBKills: winner === teamB ? 20 : 12,
    teamAGold: winner === teamA ? 70000 : 58000,
    teamBGold: winner === teamB ? 70000 : 58000,
  }
}

function checkpointTier(league: string): MatchRecord['tier'] {
  if (league === 'LCK') return 'regional-regular'
  if (league === 'EWC') return 'minor-international'
  if (league === 'WLDs') return 'worlds-main'
  return 'msi-bracket'
}

test('createRegionHistory publishes first-class region timelines from league-strength history', () => {
  const data = createStaticRankingData({
    matches: sampleMatches,
    teams,
    rosters,
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
  const seasonKey = snapshotKey({ season: '2026', event: 'All', region: 'All' })
  const history = createRegionHistory(data)
  const defaultScope = history.scopes[history.defaultScopeKey]
  const seasonScope = history.scopes[seasonKey]
  const sourcePoints = Object.values(defaultScope?.series ?? {})
    .flatMap((series) => series.points)
    .filter((point) => point[3]?.source === 'league-strength-history')

  assert.equal(history.artifactKind, 'region-history')
  assert.equal(history.defaultScopeKey, data.defaultSnapshotKey)
  assert.ok(defaultScope)
  assert.ok(seasonScope)
  assert.equal(defaultScope.regionCount, Object.keys(defaultScope.series).length)
  assert.ok(defaultScope.pointCount > 0)
  assert.ok(sourcePoints.length > 0)
  assert.equal(sourcePoints.some((point) => (point[3]?.opponentRegions?.length ?? 0) > 0), true)
})

test('createRegionHistory context only describes leagues used for region power scores', () => {
  const filter = { season: 'All', event: 'All', region: 'All' } as const
  const key = snapshotKey(filter)
  const data = {
    generatedAt: '2026-06-26T00:00:00.000Z',
    model: { version: 'transparent-power-index-test', configHash: 'fnv1a-test' },
    defaultSnapshotKey: key,
    snapshots: {
      [key]: {
        filter,
        regions: [
          {
            region: 'LEC',
            rank: 1,
            score: 1460,
            topTeamRating: 1540,
            teamCount: 1,
            ecosystemTeamCount: 2,
            leagueCount: 1,
            ecosystemLeagueCount: 2,
            flagshipLeagues: ['LEC'],
            connectivity: 0.8,
            internationalWins: 1,
            internationalLosses: 0,
            flagshipLeague: 'LEC',
            tier: 'tier-two',
            topTeams: [{ team: 'G2 Esports', code: 'G2', rating: 1540, rank: 1 }],
          },
        ],
        leagueHistory: [
          leagueHistoryPoint({ league: 'LEC', region: 'LEC', opponentLeague: 'LCK', opponentRegion: 'LCK', score: 1460 }),
          leagueHistoryPoint({ league: 'PRM', region: 'LEC', opponentLeague: 'LCK', opponentRegion: 'LCK', score: 1390 }),
        ],
      },
    },
  } as unknown as StaticRankingData

  const history = createRegionHistory(data)
  const context = history.scopes[key]?.series.LEC?.points.find((point) => point[3]?.source === 'league-strength-history')?.[3]

  assert.deepEqual(context?.leagues, ['LEC'])
  assert.equal(context?.leagues?.includes('PRM'), false)
})

test('generated snapshots carry model and source provenance', () => {
  const data = createStaticRankingData({
    matches: sampleMatches,
    teams,
    rosters,
    generatedAt: '2026-06-26T00:00:00.000Z',
  })

  assert.equal(data.dataMode, 'seeded-sample')
  assert.equal(data.artifactKind, 'full-ranking-artifact')
  assert.equal(data.schemaVersion, PUBLIC_ARTIFACT_SCHEMA_VERSION)
  assert.equal(data.coverage.seededSample, true)
  assert.equal(data.coverage.sourceProviders.includes('seed'), true)
  assert.equal(data.dataQuality.matchCount, sampleMatches.length)
  assert.equal(data.dataQuality.sourceProviderCounts.seed, sampleMatches.length)
  assert.equal(typeof data.dataQuality.missing.patchCount, 'number')
  assert.equal(typeof data.dataQuality.rosterCoverage.missingRosterSides, 'number')
  assert.equal(Array.isArray(data.dataQuality.identityCoverage.unresolvedLeagueSummaries), true)
  assert.equal(data.sources.some((source) => source.kind === 'seed'), true)
  assert.equal(data.model.version, 'transparent-power-index-v0.0.0')
  assert.match(data.model.configHash, /^fnv1a-/)
  assert.equal(data.snapshots[data.defaultSnapshotKey].artifactKind, 'full-ranking-snapshot')
  assert.equal(data.snapshots[data.defaultSnapshotKey].modelVersion, data.model.version)
  assert.equal(data.snapshots[data.defaultSnapshotKey].regions.every((region) => typeof region.score === 'number'), true)
  assert.equal(data.snapshots[data.defaultSnapshotKey].modelConfigHash, data.model.configHash)
  assert.equal(data.walkForward.metrics.modelVersion, data.model.version)
  assert.equal(data.walkForward.metrics.modelConfigHash, data.model.configHash)
  assert.equal(data.walkForward.metrics.target, 'published-game')
  assert.deepEqual(data.walkForward.metrics.baselineComparisons.map((baseline) => baseline.key), ['coin-flip', 'pregame-win-rate', 'team-only'])
  assert.equal(data.walkForward.metrics.baselineComparisons.every((baseline) => Array.isArray(baseline.segments)), true)
  assert.equal(data.walkForward.metrics.playerRatingShadow.enabled, false)
  assert.equal(data.walkForward.metrics.playerRatingShadow.predictionCount, data.walkForward.metrics.predictionCount)
  assert.equal(data.walkForward.metrics.executionResidualShadow.enabled, false)
  assert.equal(data.walkForward.metrics.executionResidualShadow.predictionCount, data.walkForward.metrics.predictionCount)
  assert.equal(data.playerData.awardSignals.status, 'source-missing')
  assert.equal(data.playerData.awardSignals.awardResidualsApplied, false)
  assert.equal(sampleMatches.every((match) => match.sourceProvider === 'seed'), true)
})

test('event filters preserve the global rating scale instead of rebuilding mini-models', () => {
  const data = createStaticRankingData({
    matches: sampleMatches,
    teams,
    rosters,
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
  const globalSnapshot = data.snapshots[data.defaultSnapshotKey]
  const eventSnapshot = data.snapshots[snapshotKey({ season: 'All', event: 'MSI 2026', region: 'All' })]
  const globalGenG = globalSnapshot.standings.find((standing) => standing.team === 'Gen.G')
  const eventGenG = eventSnapshot.standings.find((standing) => standing.team === 'Gen.G')

  assert.ok(globalGenG)
  assert.ok(eventGenG)
  assert.equal(eventGenG.rating, globalGenG.rating)
  assert.equal(eventSnapshot.modelVersion, data.model.version)
})

test('scoped snapshots carry only filter-relevant league strength history', () => {
  const scopedTeams: Record<string, TeamProfile> = {
    'Gen.G': { name: 'Gen.G', code: 'GEN', region: 'LCK', league: 'LCK' },
    T1: { name: 'T1', code: 'T1', region: 'LCK', league: 'LCK' },
    'G2 Esports': { name: 'G2 Esports', code: 'G2', region: 'LEC', league: 'LEC' },
    'Bilibili Gaming': { name: 'Bilibili Gaming', code: 'BLG', region: 'LPL', league: 'LPL' },
  }
  const internationalMatch = (
    id: string,
    date: string,
    event: string,
    teamA: string,
    teamB: string,
    winner: string,
    tier: MatchRecord['tier'] = 'msi-bracket',
  ): MatchRecord => ({
    id,
    sourceProvider: 'seed',
    dataCompleteness: 'complete',
    date,
    season: Number(date.slice(0, 4)),
    event,
    phase: 'Bracket',
    region: 'International',
    league: event,
    teamAHomeLeague: scopedTeams[teamA]?.league,
    teamBHomeLeague: scopedTeams[teamB]?.league,
    teamARegion: scopedTeams[teamA]?.region,
    teamBRegion: scopedTeams[teamB]?.region,
    patch: '26.1',
    bestOf: 1,
    tier,
    teamA,
    teamB,
    winner,
    teamAKills: winner === teamA ? 20 : 12,
    teamBKills: winner === teamB ? 20 : 12,
    teamAGold: winner === teamA ? 70000 : 58000,
    teamBGold: winner === teamB ? 70000 : 58000,
  })
  const data = createStaticRankingData({
    matches: [
      internationalMatch('msi-lck-lec', '2026-05-01', 'MSI 2026', 'Gen.G', 'G2 Esports', 'Gen.G'),
      internationalMatch('worlds-lck-lpl', '2026-10-01', 'Worlds 2026', 'T1', 'Bilibili Gaming', 'Bilibili Gaming', 'worlds-main'),
    ],
    teams: scopedTeams,
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
  const globalSnapshot = data.snapshots[data.defaultSnapshotKey]
  const eventSnapshot = data.snapshots[snapshotKey({ season: 'All', event: 'MSI 2026', region: 'All' })]
  const lckSnapshot = data.snapshots[snapshotKey({ season: 'All', event: 'All', region: 'LCK' })]

  assert.ok(globalSnapshot.leagueHistory.length > eventSnapshot.leagueHistory.length)
  assert.ok(eventSnapshot.leagueHistory.length > 0)
  assert.equal(eventSnapshot.leagueHistory.every((point) => point.event === 'MSI 2026'), true)
  assert.equal(eventSnapshot.leagueHistory.some((point) => point.event === 'Worlds 2026'), false)
  assert.ok(lckSnapshot.leagueHistory.length > 0)
  assert.equal(lckSnapshot.leagueHistory.every((point) => point.region === 'LCK'), true)
  assert.equal(lckSnapshot.leagueHistory.some((point) => point.region === 'LEC' || point.region === 'LPL'), false)
})

test('region filters list teams from that region instead of their opponents', () => {
  const data = createStaticRankingData({
    matches: sampleMatches,
    teams,
    rosters,
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
  const lecSnapshot = data.snapshots[snapshotKey({ season: 'All', event: 'All', region: 'LEC' })]
  const teamsInLecShard = new Set(lecSnapshot.standings.map((standing) => standing.team))

  assert.equal(teamsInLecShard.has('G2 Esports'), true)
  assert.equal(teamsInLecShard.has('Fnatic'), true)
  assert.equal(teamsInLecShard.has('Gen.G'), false)
  assert.equal(lecSnapshot.standings.every((standing) => standing.region === 'LEC'), true)
})

test('region filtered standings recompute movement against scoped ranks', () => {
  const scopedTeams: Record<string, TeamProfile> = {
    Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
    Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
    Gamma: { name: 'Gamma', code: 'GAM', region: 'LPL', league: 'LPL' },
    Delta: { name: 'Delta', code: 'DEL', region: 'LPL', league: 'LPL' },
  }
  const scopedMatch = (
    id: string,
    date: string,
    region: Region,
    league: string,
    teamA: string,
    teamB: string,
    winner: string,
  ): MatchRecord => ({
    id,
    sourceProvider: 'seed',
    dataCompleteness: 'complete',
    date,
    season: Number(date.slice(0, 4)),
    event: `${league} 2026 Spring`,
    phase: 'Regular season',
    region,
    league,
    teamAHomeLeague: scopedTeams[teamA]?.league,
    teamBHomeLeague: scopedTeams[teamB]?.league,
    teamARegion: scopedTeams[teamA]?.region,
    teamBRegion: scopedTeams[teamB]?.region,
    patch: '26.1',
    bestOf: 1,
    tier: 'regional-regular',
    teamA,
    teamB,
    winner,
    teamAKills: winner === teamA ? 20 : 8,
    teamBKills: winner === teamB ? 20 : 8,
    teamAGold: winner === teamA ? 70000 : 54000,
    teamBGold: winner === teamB ? 70000 : 54000,
  })
  const data = createStaticRankingData({
    matches: [
      scopedMatch('alpha-beta', '2026-01-01', 'LCK', 'LCK', 'Alpha', 'Beta', 'Alpha'),
      scopedMatch('gamma-delta-1', '2026-01-02', 'LPL', 'LPL', 'Gamma', 'Delta', 'Gamma'),
      scopedMatch('gamma-delta-2', '2026-01-09', 'LPL', 'LPL', 'Gamma', 'Delta', 'Gamma'),
      scopedMatch('gamma-delta-3', '2026-01-16', 'LPL', 'LPL', 'Gamma', 'Delta', 'Gamma'),
    ],
    teams: scopedTeams,
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
  const globalSnapshot = data.snapshots[data.defaultSnapshotKey]
  const lckSnapshot = data.snapshots[snapshotKey({ season: 'All', event: 'All', region: 'LCK' })]

  assert.ok(lckSnapshot.standings.some((standing) => (
    globalSnapshot.standings.find((globalStanding) => globalStanding.team === standing.team)?.rank !== standing.rank
  )))
  assert.equal(lckSnapshot.standings.every((standing) => standing.movement === standing.previousRank - standing.rank), true)
})

test('published rating universe excludes APAC feeder league teams from rating scopes', () => {
  const apacTeams: Record<string, TeamProfile> = {
    'CTBC Flying Oyster': { name: 'CTBC Flying Oyster', code: 'CFO', region: 'LCP', league: 'LCP' },
    'Team Secret Whales': { name: 'Team Secret Whales', code: 'TSW', region: 'LCP', league: 'LCP' },
    'PSG Talon': { name: 'PSG Talon', code: 'PSG', region: 'PCS', league: 'PCS' },
    'GAM Esports': { name: 'GAM Esports', code: 'GAM', region: 'VCS', league: 'VCS' },
  }
  const matches: MatchRecord[] = [
    apacRegionMatch('apac-lcp-lcp', 'LCP', 'LCP', 'LCP', 'CTBC Flying Oyster', 'Team Secret Whales', 'CTBC Flying Oyster'),
    apacRegionMatch('apac-lcp-pcs', 'LCP', 'LCP', 'PCS', 'CTBC Flying Oyster', 'PSG Talon', 'CTBC Flying Oyster'),
    apacRegionMatch('apac-vcs-pcs', 'VCS', 'VCS', 'PCS', 'GAM Esports', 'PSG Talon', 'GAM Esports'),
  ]

  const data = createStaticRankingData({
    matches,
    teams: apacTeams,
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
  const lcpSnapshot = data.snapshots[snapshotKey({ season: 'All', event: 'All', region: 'LCP' })]

  assert.equal(data.filterOptions.regions.includes('PCS'), false)
  assert.equal(data.filterOptions.regions.includes('VCS'), false)
  assert.equal(data.filterOptions.regions.includes('LCP'), true)
  assert.equal(data.snapshots[snapshotKey({ season: 'All', event: 'All', region: 'PCS' })], undefined)
  assert.equal(data.coverage.matchCount, 1)
  assert.ok(lcpSnapshot)
  assert.deepEqual(
    new Set(lcpSnapshot.standings.map((standing) => standing.team)),
    new Set(['CTBC Flying Oyster', 'Team Secret Whales']),
  )
  assert.equal(lcpSnapshot.regions.some((region) => region.region === 'PCS' || region.region === 'VCS'), false)
  assert.equal(lcpSnapshot.regions.some((region) => region.region === 'LCP'), true)
})

test('region filters use dated side regions instead of current global team identity', () => {
  const movedTeams: Record<string, TeamProfile> = {
    Moved: { name: 'Moved', code: 'MOV', region: 'LCK', league: 'LCK' },
    LecOpponent: { name: 'LecOpponent', code: 'LEC', region: 'LEC', league: 'LEC' },
    LckOpponent: { name: 'LckOpponent', code: 'LCK', region: 'LCK', league: 'LCK' },
  }
  const matches = [
    movedRegionMatch({
      id: 'moved-2025-lec',
      date: '2025-01-01',
      event: 'LEC 2025 Winter',
      region: 'LEC',
      league: 'LEC',
      opponent: 'LecOpponent',
      winner: 'Moved',
    }),
    movedRegionMatch({
      id: 'moved-2026-lck',
      date: '2026-01-01',
      event: 'LCK 2026 Cup',
      region: 'LCK',
      league: 'LCK',
      opponent: 'LckOpponent',
      winner: 'Moved',
    }),
  ]

  const data = createStaticRankingData({
    matches,
    teams: movedTeams,
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
  const lckSnapshot = data.snapshots[snapshotKey({ season: 'All', event: 'All', region: 'LCK' })]
  const moved = lckSnapshot.standings.find((standing) => standing.team === 'Moved')
  const lecOpponent = lckSnapshot.standings.find((standing) => standing.team === 'LecOpponent')

  assert.ok(moved)
  assert.equal(lecOpponent, undefined)
  assert.deepEqual(moved.history.map((point) => point.event), ['LCK 2026 Cup'])
  assert.deepEqual(moved.recentEvents, ['LCK 2026 Cup'])
})

test('region filters do not assign unknown competition-only teams from event region alone', () => {
  const competitionTeams: Record<string, TeamProfile> = {
    'G2 Esports': { name: 'G2 Esports', code: 'G2', region: 'LEC', league: 'LEC' },
    Fnatic: { name: 'Fnatic', code: 'FNC', region: 'LEC', league: 'LEC' },
    Witchcraft: { name: 'Witchcraft', code: 'WITC', region: 'International', league: 'Unknown' },
  }
  const data = createStaticRankingData({
    matches: [
      {
        id: 'lec-known-side',
        sourceProvider: 'seed',
        dataCompleteness: 'complete',
        date: '2026-01-01',
        season: 2026,
        event: 'LEC 2026 Winter',
        phase: 'Regular season',
        region: 'LEC',
        league: 'LEC',
        teamAHomeLeague: 'LEC',
        teamBHomeLeague: 'LEC',
        teamARegion: 'LEC',
        teamBRegion: 'LEC',
        patch: '26.1',
        bestOf: 1,
        tier: 'regional-regular',
        teamA: 'G2 Esports',
        teamB: 'Fnatic',
        winner: 'G2 Esports',
        teamAKills: 18,
        teamBKills: 10,
        teamAGold: 65000,
        teamBGold: 56000,
      },
      {
        id: 'em-unknown-side',
        sourceProvider: 'seed',
        dataCompleteness: 'complete',
        date: '2026-01-01',
        season: 2026,
        event: 'EM 2026 Winter',
        phase: 'Regular season',
        region: 'LEC',
        league: 'EM',
        patch: '26.1',
        bestOf: 1,
        tier: 'minor-international',
        teamA: 'G2 Esports',
        teamB: 'Witchcraft',
        winner: 'G2 Esports',
        teamAKills: 18,
        teamBKills: 10,
        teamAGold: 65000,
        teamBGold: 56000,
      },
    ],
    teams: competitionTeams,
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
  const lecSnapshot = data.snapshots[snapshotKey({ season: 'All', event: 'All', region: 'LEC' })]

  assert.equal(lecSnapshot.standings.some((standing) => standing.team === 'G2 Esports'), true)
  assert.equal(lecSnapshot.standings.some((standing) => standing.team === 'Witchcraft'), false)
  assert.equal(lecSnapshot.standings.every((standing) => standing.region === 'LEC'), true)
})

test('season filters publish calendar-aligned season-end standings instead of current global standings', () => {
  const seasonTeams: Record<string, TeamProfile> = {
    Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
    Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
  }
  const matches = [
    seasonFilterMatch('season-filter-2025-01', '2025-01-01', 'Alpha'),
    seasonFilterMatch('season-filter-2025-02', '2025-01-08', 'Alpha'),
    seasonFilterMatch('season-filter-2025-03', '2025-01-15', 'Alpha'),
    seasonFilterMatch('season-filter-2025-04', '2025-01-22', 'Alpha'),
    seasonFilterMatch('season-filter-2026-baseline-2025-date', '2025-12-20', 'Alpha', 2026),
    seasonFilterMatch('season-filter-2026-01', '2026-01-01', 'Beta'),
    seasonFilterMatch('season-filter-2026-02', '2026-01-08', 'Beta'),
    seasonFilterMatch('season-filter-2026-03', '2026-01-15', 'Beta'),
    seasonFilterMatch('season-filter-2026-04', '2026-01-22', 'Beta'),
    seasonFilterMatch('season-filter-2026-05', '2026-01-29', 'Beta'),
    seasonFilterMatch('season-filter-2026-06', '2026-02-05', 'Beta'),
  ]

  const data = createStaticRankingData({
    matches,
    teams: seasonTeams,
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
  const globalSnapshot = data.snapshots[data.defaultSnapshotKey]
  const season2025 = data.snapshots[snapshotKey({ season: '2025', event: 'All', region: 'All' })]
  const season2026 = data.snapshots[snapshotKey({ season: '2026', event: 'All', region: 'All' })]
  const globalAlpha = globalSnapshot.standings.find((standing) => standing.team === 'Alpha')
  const seasonAlpha = season2025.standings.find((standing) => standing.team === 'Alpha')
  const seasonBeta = season2025.standings.find((standing) => standing.team === 'Beta')
  const season2026Alpha = season2026.standings.find((standing) => standing.team === 'Alpha')
  const season2026Beta = season2026.standings.find((standing) => standing.team === 'Beta')
  const cold2026 = createStaticRankingData({
    matches: matches.filter((match) => match.date.startsWith('2026-')),
    teams: seasonTeams,
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
  const cold2026Beta = cold2026.snapshots[snapshotKey({ season: '2026', event: 'All', region: 'All' })]
    .standings.find((standing) => standing.team === 'Beta')

  assert.ok(globalAlpha)
  assert.ok(seasonAlpha)
  assert.ok(seasonBeta)
  assert.ok(season2026Alpha)
  assert.ok(season2026Beta)
  assert.ok(cold2026Beta)
  assert.equal(season2025.matchCount, 4)
  assert.equal(seasonAlpha.wins, 4)
  assert.equal(seasonAlpha.losses, 0)
  assert.equal(seasonBeta.wins, 0)
  assert.equal(seasonBeta.losses, 4)
  assert.equal(season2025.standings[0]?.team, 'Alpha')
  assert.equal(season2025.standings.some((standing) => standing.recentEvents.some((event) => event.includes('2026'))), false)
  assert.notEqual(seasonAlpha.rating, globalAlpha.rating)
  assert.equal(season2026.matchCount, 6)
  assert.equal(season2026Alpha.wins, 0)
  assert.equal(season2026Alpha.losses, 6)
  assert.equal(season2026Beta.wins, 6)
  assert.equal(season2026Beta.losses, 0)
  assert.deepEqual(season2026Beta.history.map((point) => point.date), [
    '2026-01-01',
    '2026-01-08',
    '2026-01-15',
    '2026-01-22',
    '2026-01-29',
    '2026-02-05',
  ])
  assert.equal(season2026Beta.history.some((point) => point.event.includes('2026') && point.date.startsWith('2025-')), false)
  assert.notEqual(season2026Beta.rating, cold2026Beta.rating)

  const history = createTeamHistory(data)
  const scoped2026 = history.scopeIndex?.[snapshotKey({ season: '2026', event: 'All', region: 'All' })]
  const betaSeries = history.series[teamStandingKey(season2026Beta)]
  assert.ok(scoped2026)
  assert.ok(scoped2026.includes(teamStandingKey(season2026Beta)))
  assert.deepEqual(betaSeries?.points.map((point) => point[0]), [
    '2025-01-01',
    '2025-01-08',
    '2025-01-15',
    '2025-01-22',
    '2025-12-20',
    '2026-01-01',
    '2026-01-08',
    '2026-01-15',
    '2026-01-22',
    '2026-01-29',
    '2026-02-05',
  ])
  assert.equal(betaSeries?.points.at(-1)?.[3]?.opponent, 'Alpha')
  assert.equal(betaSeries?.points.at(-1)?.[3]?.result, 'W')
})

test('season scoped standings use league observed inside that season', () => {
  const scopedTeams: Record<string, TeamProfile> = {
    Rats: { name: 'Rats', code: 'RAT', region: 'LEC', league: 'LEC' },
    Opponent: { name: 'Opponent', code: 'OPP', region: 'LEC', league: 'LEC' },
  }
  const matches = [
    scopedLeagueMatch('rats-2025-lcs', '2025-01-01', 2025, 'LCS', 'Rats'),
    scopedLeagueMatch('rats-2026-lec', '2026-01-01', 2026, 'LEC', 'Opponent'),
  ]

  const data = createStaticRankingData({
    matches,
    teams: scopedTeams,
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
  })
  const season2025 = data.snapshots[snapshotKey({ season: '2025', event: 'All', region: 'All' })]
  const season2026 = data.snapshots[snapshotKey({ season: '2026', event: 'All', region: 'All' })]
  const rats2025 = season2025.standings.find((standing) => standing.team === 'Rats')
  const rats2026 = season2026.standings.find((standing) => standing.team === 'Rats')

  assert.ok(rats2025)
  assert.ok(rats2026)
  assert.equal(rats2025.league, 'LCS')
  assert.equal(rats2025.region, 'LCS')
  assert.equal(rats2025.eligibility.reasons.includes('unanchored-league'), false)
  assert.equal(rats2026.league, 'LEC')
})

test('empty usable inputs create a no-data snapshot instead of seeded rankings', () => {
  const data = createStaticRankingData({
    matches: [],
    teams: {},
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
    source: 'no public match data available',
  })
  const snapshot = data.snapshots[data.defaultSnapshotKey]

  assert.equal(data.dataMode, 'no-data')
  assert.equal(data.coverage.matchCount, 0)
  assert.equal(data.coverage.seededSample, false)
  assert.equal(data.filterOptions.seasons.length, 1)
  assert.equal(snapshot.standings.length, 0)
  assert.equal(snapshot.leagues.length, 0)
  assert.equal(snapshot.players.length, 0)
})

test('scheduled public summaries omit standing histories and seed-source rows', () => {
  const data = createStaticRankingData({
    matches: sampleMatches.map((match) => ({ ...match, sourceProvider: 'oracles-elixir' as const })),
    teams,
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
    dataMode: 'scheduled-public-data',
    source: "Oracle's Elixir fixture",
  })
  const { manifest, snapshots } = createStaticRankingSummaryData(data)
  const publicArtifact = createStaticRankingSummaryData(data, {
    fullSnapshotUrl: '/data/ranking-snapshot.full.json',
    playerDirectoryUrl: '/data/entities/players.json',
    teamHistoryIndexUrl: '/data/history/team-series/index.json',
    regionHistoryUrl: '/data/history/region-series.json',
  })
  const publicArtifactManifest = publicArtifact.manifest
  const defaultShard = snapshots[manifest.defaultSnapshotKey]
  const firstStanding = defaultShard?.standings[0]
  const firstShardStanding = defaultShard?.standings[0]

  assert.equal(data.sources.some((source) => source.kind === 'seed'), false)
  assert.equal(manifest.artifactKind, 'public-ranking-manifest')
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, 'fullSnapshotUrl'), false)
  assert.equal(publicArtifactManifest.fullSnapshotUrl, '/data/ranking-snapshot.full.json')
  assert.equal(publicArtifactManifest.playerDirectoryUrl, '/data/entities/players.json')
  assert.equal(publicArtifactManifest.teamHistoryIndexUrl, '/data/history/team-series/index.json')
  assert.equal(Object.prototype.hasOwnProperty.call(publicArtifactManifest, 'teamHistoryUrl'), false)
  assert.equal(publicArtifactManifest.regionHistoryUrl, '/data/history/region-series.json')
  assert.equal(manifest.snapshots, undefined)
  assert.ok(defaultShard)
  assert.equal(defaultShard.artifactKind, 'public-snapshot-shard')
  assert.ok(firstStanding)
  assert.equal(typeof firstStanding.rosterBasis, 'string')
  assert.equal(typeof firstStanding.uncertainty, 'number')
  assert.equal(Array.isArray(firstStanding.form), true)
  assert.equal(Array.isArray(firstStanding.recentMatches), true)
  assert.equal(firstStanding.recentMatches.length > 0, true)
  assert.equal(typeof firstStanding.leagueScore, 'number')
  assert.equal(typeof firstStanding.leagueAdjustment, 'number')
  assert.equal(typeof firstStanding.ratingComponents?.leagueAnchor, 'number')
  assert.equal(typeof firstStanding.ratingComponents?.teamStableOffset, 'number')
  assert.equal(typeof firstStanding.ratingComponents?.momentum, 'number')
  assert.equal(firstStanding.ratingUpdate, undefined)
  assert.equal(typeof firstStanding.eligibility?.eligible, 'boolean')
  assert.ok(firstShardStanding)
  assert.equal(firstShardStanding.recentMatches.length > 0, true)
  assert.equal(typeof firstShardStanding.recentMatches[0]?.opponent, 'string')
  assert.equal(typeof firstShardStanding.recentMatches[0]?.event, 'string')
  assert.equal(typeof firstShardStanding.recentMatches[0]?.date, 'string')
  assert.equal(manifest.walkForward.metrics.target, 'published-game')
  assert.equal(defaultShard.standings.some((standing) => 'history' in standing), false)
})

test('standing eligibility uses match-level history instead of raw game rows', () => {
  const matches = Array.from({ length: 16 }).flatMap((_, index) => [
    seriesEligibilityMatch(index, 1),
    seriesEligibilityMatch(index, 2),
  ])
  const data = createStaticRankingData({
    matches,
    teams: sourcedTeams,
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
    dataMode: 'scheduled-public-data',
    source: "Oracle's Elixir fixture",
  })
  const { manifest, snapshots } = createStaticRankingSummaryData(data)
  const fullAlpha = data.snapshots[data.defaultSnapshotKey].standings.find((standing) => standing.team === 'Alpha')
  const publicAlpha = snapshots[manifest.defaultSnapshotKey]?.standings.find((standing) => standing.team === 'Alpha')

  assert.ok(fullAlpha)
  assert.equal(fullAlpha.wins, 32)
  assert.equal(fullAlpha.eligibility.totalGames, 16)
  assert.equal(fullAlpha.eligibility.eligible, false)
  assert.equal(fullAlpha.eligibility.reasons.includes('low-total-volume'), true)
  assert.ok(publicAlpha)
  assert.equal(publicAlpha.wins, 16)
  assert.equal(publicAlpha.losses, 0)
  assert.equal(publicAlpha.eligibility.eligible, false)
  assert.equal(publicAlpha.eligibility.reasons.includes('low-total-volume'), true)
})

test('scheduled public snapshots publish sourced player rating proof without shipping summary players', () => {
  const data = createStaticRankingData({
    matches: [sourcedMatchFixture()],
    teams: sourcedTeams,
    rosters: {},
    generatedAt: '2026-06-26T00:00:00.000Z',
    dataMode: 'scheduled-public-data',
    source: "Oracle's Elixir fixture",
  })
  const { manifest } = createStaticRankingSummaryData(data)
  const fullDefaultSnapshot = data.snapshots[data.defaultSnapshotKey]
  const { snapshots } = createStaticRankingSummaryData(data)
  const summaryDefaultSnapshot = snapshots[manifest.defaultSnapshotKey]
  const proof = manifest.playerData.ratingProof
  const playerDirectory = createPlayerDirectory(data)
  const seasonPlayers = playerDirectory.scopedPlayers?.[snapshotKey({ season: '2026', event: 'All', region: 'All' })] ?? []

  assert.equal(data.playerData.status, 'sourced-player-stats')
  assert.equal(data.playerData.metric.id, 'role-power')
  assert.equal(data.playerData.metric.teamResultSignal, 'included')
  assert.equal(data.playerData.metric.independentSkillClaim, false)
  assert.equal(manifest.playerData.metric.id, 'role-power')
  assert.equal(manifest.playerData.metric.independentSkillClaim, false)
  assert.equal(playerDirectory.metric.id, 'role-power')
  assert.ok(proof)
  assert.equal(proof.sourceProvider, 'oracles-elixir')
  assert.equal(proof.modelVersion, data.model.version)
  assert.equal(proof.modelConfigHash, data.model.configHash)
  assert.equal(proof.ratedPlayerCount, 10)
  assert.equal(proof.ratedTeamCount, 2)
  assert.equal(proof.sampleSize, 10)
  assert.ok(proof.topPlayers.length > 0)
  assert.equal(proof.topPlayers.every((player) => player.sourceProvider === 'oracles-elixir'), true)
  assert.equal(proof.topPlayers.every((player) => player.sourceGameId === 'oe-sourced-snapshot'), true)
  assert.equal(proof.topPlayers.every((player) => player.sourceFileName === 'oracle-fixture.csv'), true)
  assert.equal(proof.topPlayers.every((player) => player.latestObservedAt === '2026-01-01'), true)
  assert.equal(proof.topPlayers.every((player) => player.latestObservedEvent === 'LCK 2026 Spring'), true)
  assert.equal(proof.topPlayers.every((player) => player.appearance?.latestTeamGames === 1), true)
  assert.equal(proof.topPlayers.every((player) => player.appearance?.flags.includes('thin-latest-team-sample')), true)
  assert.equal(data.playerData.awardSignals.status, 'source-missing')
  assert.equal(data.playerData.awardSignals.awardResidualsApplied, false)
  assert.equal(fullDefaultSnapshot.players.every((player) => player.impactDrivers.awardResidualZ === 0), true)
  assert.equal(playerDirectory.players.every((player) => player.impactDrivers.awardResidualZ === 0), true)
  assert.equal(seasonPlayers.length, 0)
  assert.equal(fullDefaultSnapshot.players.length, 10)
  assert.equal(Object.prototype.hasOwnProperty.call(summaryDefaultSnapshot, 'players'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(summaryDefaultSnapshot, 'events'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(summaryDefaultSnapshot, 'seasons'), false)
  assert.equal(proof.topPlayers.some((player) => 'history' in player || 'form' in player || 'impactDrivers' in player), false)
})

const sourcedTeams: Record<string, TeamProfile> = {
  Alpha: { name: 'Alpha', code: 'ALP', region: 'LCK', league: 'LCK' },
  Beta: { name: 'Beta', code: 'BET', region: 'LCK', league: 'LCK' },
}

function sourcedMatchFixture(): MatchRecord {
  return {
    id: 'sourced-snapshot',
    sourceProvider: 'oracles-elixir',
    sourceGameId: 'oe-sourced-snapshot',
    sourceFileName: 'oracle-fixture.csv',
    dataCompleteness: 'complete',
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
    teamASide: 'blue',
    teamBSide: 'red',
    teamARoster: sourcedRosterFixture('alpha', 'blue', true),
    teamBRoster: sourcedRosterFixture('beta', 'red', false),
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
  }
}

function seriesEligibilityMatch(seriesIndex: number, gameIndex: 1 | 2): MatchRecord {
  const date = `2026-06-${String(seriesIndex + 1).padStart(2, '0')}`
  return {
    id: `series-eligibility-${seriesIndex}-${gameIndex}`,
    sourceProvider: 'oracles-elixir',
    sourceGameId: `oe-series-eligibility-${seriesIndex}-${gameIndex}`,
    sourceFileName: 'oracle-fixture.csv',
    dataCompleteness: 'complete',
    date,
    season: 2026,
    event: 'LCK 2026 Spring',
    phase: 'Regular season',
    region: 'LCK',
    league: 'LCK',
    teamAHomeLeague: 'LCK',
    teamBHomeLeague: 'LCK',
    teamARegion: 'LCK',
    teamBRegion: 'LCK',
    teamASide: 'blue',
    teamBSide: 'red',
    patch: '26.1',
    bestOf: 3,
    tier: 'regional-regular',
    teamA: 'Alpha',
    teamB: 'Beta',
    winner: 'Alpha',
    teamAKills: 20,
    teamBKills: 12,
    teamAGold: 65000,
    teamBGold: 59000,
  }
}

function seasonFilterMatch(id: string, date: string, winner: 'Alpha' | 'Beta', season = Number(date.slice(0, 4))): MatchRecord {
  return {
    id,
    sourceProvider: 'seed',
    dataCompleteness: 'complete',
    date,
    season,
    event: `LCK ${season} Spring`,
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
    winner,
    teamAKills: winner === 'Alpha' ? 18 : 10,
    teamBKills: winner === 'Beta' ? 18 : 10,
    teamAGold: winner === 'Alpha' ? 65000 : 56000,
    teamBGold: winner === 'Beta' ? 65000 : 56000,
  }
}

function scopedLeagueMatch(
  id: string,
  date: string,
  season: number,
  homeLeague: string,
  winner: 'Rats' | 'Opponent',
): MatchRecord {
  const region = homeLeague === 'LCS' ? 'LCS' : 'LEC'
  return {
    id,
    sourceProvider: 'seed',
    dataCompleteness: 'complete',
    date,
    season,
    event: `${homeLeague} ${season} Spring`,
    phase: 'Regular season',
    region,
    league: homeLeague,
    teamAHomeLeague: homeLeague,
    teamBHomeLeague: homeLeague,
    teamARegion: region,
    teamBRegion: region,
    patch: '26.1',
    bestOf: 1,
    tier: 'regional-regular',
    teamA: 'Rats',
    teamB: 'Opponent',
    winner,
    teamAKills: winner === 'Rats' ? 18 : 10,
    teamBKills: winner === 'Opponent' ? 18 : 10,
    teamAGold: winner === 'Rats' ? 65000 : 56000,
    teamBGold: winner === 'Opponent' ? 65000 : 56000,
  }
}

function movedRegionMatch({
  id,
  date,
  event,
  region,
  league,
  opponent,
  winner,
}: {
  id: string
  date: string
  event: string
  region: MatchRecord['region']
  league: string
  opponent: 'LecOpponent' | 'LckOpponent'
  winner: 'Moved' | 'LecOpponent' | 'LckOpponent'
}): MatchRecord {
  return {
    id,
    sourceProvider: 'seed',
    dataCompleteness: 'complete',
    date,
    season: Number(date.slice(0, 4)),
    event,
    phase: 'Regular season',
    region,
    league,
    teamAHomeLeague: league,
    teamBHomeLeague: league,
    patch: '26.1',
    bestOf: 1,
    tier: 'regional-regular',
    teamA: 'Moved',
    teamB: opponent,
    winner,
    teamAKills: winner === 'Moved' ? 18 : 10,
    teamBKills: winner === opponent ? 18 : 10,
    teamAGold: winner === 'Moved' ? 65000 : 56000,
    teamBGold: winner === opponent ? 65000 : 56000,
  }
}

function apacRegionMatch(
  id: string,
  eventRegion: MatchRecord['region'],
  leagueA: Region,
  leagueB: Region,
  teamA: string,
  teamB: string,
  winner: string,
): MatchRecord {
  return {
    id,
    sourceProvider: 'seed',
    dataCompleteness: 'complete',
    date: '2026-01-01',
    season: 2026,
    event: `${eventRegion} 2026 Spring`,
    phase: 'Regular season',
    region: eventRegion,
    league: eventRegion,
    teamAHomeLeague: leagueA,
    teamBHomeLeague: leagueB,
    teamARegion: leagueA,
    teamBRegion: leagueB,
    patch: '26.1',
    bestOf: 1,
    tier: 'regional-regular',
    teamA,
    teamB,
    winner,
    teamAKills: winner === teamA ? 18 : 10,
    teamBKills: winner === teamB ? 18 : 10,
    teamAGold: winner === teamA ? 65000 : 56000,
    teamBGold: winner === teamB ? 65000 : 56000,
  }
}

function leagueHistoryPoint(overrides: Partial<LeagueStrengthHistoryPoint> & Pick<LeagueStrengthHistoryPoint, 'league' | 'region' | 'opponentLeague' | 'opponentRegion'>): LeagueStrengthHistoryPoint {
  return {
    date: '2026-01-01',
    event: 'Example International',
    tier: 'minor-international',
    result: 'W',
    score: 1500,
    delta: 1,
    wins: 1,
    losses: 0,
    expectedWins: 0.5,
    winsOverExpected: 0.5,
    opponentAdjustedWinRate: 0.75,
    averageOpponentRating: 1500,
    internationalMatches: 1,
    ...overrides,
  }
}

function sourcedRosterFixture(
  prefix: string,
  side: Side,
  won: boolean,
): NonNullable<MatchRecord['teamARoster']> {
  const roles = ['Top', 'Jungle', 'Mid', 'Bot', 'Support'] as const satisfies readonly Role[]
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
      },
    })),
  }
}
