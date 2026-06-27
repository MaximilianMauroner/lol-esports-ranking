import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlayerDirectory, createStaticRankingData, createStaticRankingSummaryData, createTeamHistory, snapshotKey, teamStandingKey } from '../src/lib/snapshot.ts'
import type { StaticRankingData } from '../src/lib/snapshot.ts'
import type { MatchRecord, PlayerStanding, Role, Side, TeamProfile, TeamStanding } from '../src/types.ts'
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

test('createPlayerDirectory flattens sourced players and joins region/league from standings', () => {
  const standing = {
    team: 'Gen.G',
    code: 'GEN',
    region: 'LCK',
    league: 'LCK',
  } as TeamStanding
  const data = {
    generatedAt: '2026-06-26T00:00:00.000Z',
    model: { version: 'transparent-gpr-vT', configHash: 'fnv1a-test' },
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
          }),
          sourcedPlayer({ id: 'p2', name: 'Demo', team: 'Gen.G', role: 'Top', rank: 2, ratingBasis: 'seeded-demo-rosters' }),
          sourcedPlayer({ id: 'p3', name: 'Zero', team: 'Gen.G', role: 'Jungle', rank: 3, games: 0 }),
        ],
      },
    },
  } as unknown as StaticRankingData

  const directory = createPlayerDirectory(data)

  assert.equal(directory.artifactKind, 'player-directory')
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
  assert.equal(chovy.sourceGameId, 'oe-player-proof')
  assert.equal(chovy.sourceFileName, 'oracle-fixture.csv')
  assert.equal(chovy.latestObservedAt, '2026-06-26')
  assert.equal(chovy.latestObservedEvent, 'LCK 2026 Rounds 1-2')
  assert.deepEqual(chovy.recentMatches, [{
    date: '2026-06-26',
    event: 'LCK 2026 Rounds 1-2',
    opponent: 'T1',
    opponentTeamCode: 'T1',
    playerTeam: 'Gen.G',
    playerTeamCode: 'GEN',
    result: 'W',
    teamKills: 16,
    opponentKills: 8,
    sourceProvider: 'oracles-elixir',
    sourceFileName: 'oracle-fixture.csv',
    sourceGameId: 'oe-player-proof',
    sourceUrl: undefined,
  }])
  assert.equal(chovy.appearance?.latestTeamGames, 100)
  assert.equal(chovy.appearance?.roleGames, 100)
  assert.deepEqual(chovy.appearance?.teamHistory, [{
    team: 'Gen.G',
    games: 100,
    latestObservedAt: '2026-06-26',
    latestObservedEvent: 'LCK 2026 Rounds 1-2',
  }])
  assert.equal(directory.modelVersion, 'transparent-gpr-vT')
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
  } as TeamStanding
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
  } as TeamStanding
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
    model: { version: 'transparent-gpr-vT', configHash: 'fnv1a-test' },
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
  } as TeamStanding
  const seasonKey = snapshotKey({ season: '2026', event: 'All', region: 'All' })
  const players = [
    sourcedPlayer({ id: 'thin', name: 'Thin Sample', team: 'Gen.G', role: 'Jungle', rank: 1, games: 19, rating: 240 }),
    sourcedPlayer({ id: 'ready', name: 'Ready Sample', team: 'Gen.G', role: 'Mid', rank: 2, games: 20, rating: 220 }),
  ]
  const data = {
    generatedAt: '2026-06-26T00:00:00.000Z',
    model: { version: 'transparent-gpr-vT', configHash: 'fnv1a-test' },
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
  } as TeamStanding
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
  } as TeamStanding
  const data = {
    generatedAt: '2026-06-26T00:00:00.000Z',
    model: { version: 'transparent-gpr-vT', configHash: 'fnv1a-test' },
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
  } as TeamStanding
  const omittedStanding = {
    team: 'Beta',
    code: 'BET',
    region: 'LCK',
    history: [
      { date: '2026-01-01', rating: 1490, rank: 2 },
    ],
  } as TeamStanding
  const data = {
    generatedAt: '2026-06-26T00:00:00.000Z',
    model: { version: 'transparent-gpr-vT', configHash: 'fnv1a-test' },
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
  assert.equal(history.series[teamStandingKey(includedStanding)].points[1][3]?.delta, 10)
  assert.equal(history.series[teamStandingKey(includedStanding)].points[1][3]?.sourceProvider, 'oracles-elixir')
  assert.equal(history.series[teamStandingKey(omittedStanding)], undefined)
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
  assert.equal(data.schemaVersion, 14)
  assert.equal(data.coverage.seededSample, true)
  assert.equal(data.coverage.sourceProviders.includes('seed'), true)
  assert.equal(data.dataQuality.matchCount, sampleMatches.length)
  assert.equal(data.dataQuality.sourceProviderCounts.seed, sampleMatches.length)
  assert.equal(typeof data.dataQuality.missing.patchCount, 'number')
  assert.equal(typeof data.dataQuality.rosterCoverage.missingRosterSides, 'number')
  assert.equal(Array.isArray(data.dataQuality.identityCoverage.unresolvedLeagueSummaries), true)
  assert.equal(data.sources.some((source) => source.kind === 'seed'), true)
  assert.match(data.model.version, /^transparent-gpr-v/)
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

test('region filters fold APAC feeder regions under current LCP scope', () => {
  const apacTeams: Record<string, TeamProfile> = {
    'CTBC Flying Oyster': { name: 'CTBC Flying Oyster', code: 'CFO', region: 'LCP', league: 'LCP' },
    'PSG Talon': { name: 'PSG Talon', code: 'PSG', region: 'PCS', league: 'PCS' },
    'GAM Esports': { name: 'GAM Esports', code: 'GAM', region: 'VCS', league: 'VCS' },
  }
  const matches: MatchRecord[] = [
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
  assert.ok(lcpSnapshot)
  assert.deepEqual(
    new Set(lcpSnapshot.standings.map((standing) => standing.team)),
    new Set(['CTBC Flying Oyster', 'PSG Talon', 'GAM Esports']),
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
    Witchcraft: { name: 'Witchcraft', code: 'WITC', region: 'International', league: 'Unknown' },
  }
  const data = createStaticRankingData({
    matches: [
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

test('season filters publish season-end standings instead of current global standings', () => {
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
  assert.equal(season2026.matchCount, 7)
  assert.equal(season2026Alpha.wins, 1)
  assert.equal(season2026Alpha.losses, 6)
  assert.equal(season2026Beta.wins, 6)
  assert.equal(season2026Beta.losses, 1)
  assert.deepEqual(season2026Beta.history.map((point) => point.date), [
    '2025-12-20',
    '2026-01-01',
    '2026-01-08',
    '2026-01-15',
    '2026-01-22',
    '2026-01-29',
    '2026-02-05',
  ])
  assert.notEqual(season2026Beta.rating, cold2026Beta.rating)

  const history = createTeamHistory(data)
  const scoped2026 = history.scopedSeries?.[snapshotKey({ season: '2026', event: 'All', region: 'All' })]
  assert.ok(scoped2026)
  assert.deepEqual(scoped2026[teamStandingKey(season2026Beta)]?.points.map((point) => point[0]), [
    '2025-12-20',
    '2026-01-01',
    '2026-01-08',
    '2026-01-15',
    '2026-01-22',
    '2026-01-29',
    '2026-02-05',
  ])
})

test('season scoped standings use league observed inside that season', () => {
  const scopedTeams: Record<string, TeamProfile> = {
    Rats: { name: 'Rats', code: 'RAT', region: 'LEC', league: 'LEC' },
    Opponent: { name: 'Opponent', code: 'OPP', region: 'LEC', league: 'LEC' },
  }
  const matches = [
    scopedLeagueMatch('rats-2025-nlc', '2025-01-01', 2025, 'NLC', 'Rats'),
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
  assert.equal(rats2025.league, 'NLC')
  assert.equal(rats2025.region, 'LEC')
  assert.equal(rats2025.ratingComponents.leagueAnchor, 1300)
  assert.equal(rats2025.eligibility.eligible, false)
  assert.equal(rats2025.eligibility.reasons.includes('unanchored-league'), true)
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
    playerDirectoryUrl: '/data/players.json',
    teamHistoryUrl: '/data/team-history.json',
  })
  const publicArtifactManifest = publicArtifact.manifest
  const defaultSnapshot = manifest.snapshots[manifest.defaultSnapshotKey]
  const defaultShard = snapshots[manifest.defaultSnapshotKey]
  const firstStanding = defaultSnapshot?.standings[0]
  const firstShardStanding = defaultShard?.standings[0]

  assert.equal(data.sources.some((source) => source.kind === 'seed'), false)
  assert.equal(manifest.artifactKind, 'public-ranking-manifest')
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, 'fullSnapshotUrl'), false)
  assert.equal(publicArtifactManifest.fullSnapshotUrl, '/data/ranking-snapshot.full.json')
  assert.equal(publicArtifactManifest.playerDirectoryUrl, '/data/players.json')
  assert.equal(publicArtifactManifest.teamHistoryUrl, '/data/team-history.json')
  assert.ok(defaultSnapshot)
  assert.equal(defaultSnapshot.artifactKind, 'public-snapshot-shard')
  assert.ok(firstStanding)
  assert.equal(typeof firstStanding.rosterBasis, 'string')
  assert.equal(typeof firstStanding.uncertainty, 'number')
  assert.equal(Array.isArray(firstStanding.form), true)
  assert.equal(Array.isArray(firstStanding.recentMatches), true)
  assert.equal(firstStanding.recentMatches.length, 0)
  assert.equal(typeof firstStanding.leagueScore, 'number')
  assert.equal(typeof firstStanding.leagueAdjustment, 'number')
  assert.equal(typeof firstStanding.ratingComponents?.leagueAnchor, 'number')
  assert.equal(typeof firstStanding.ratingComponents?.teamStableOffset, 'number')
  assert.equal(typeof firstStanding.ratingComponents?.momentum, 'number')
  assert.equal(typeof firstStanding.ratingUpdate?.teamStableDelta, 'number')
  assert.equal(typeof firstStanding.ratingUpdate?.leaguePlacementDelta, 'number')
  assert.equal(typeof firstStanding.eligibility?.eligible, 'boolean')
  assert.ok(firstShardStanding)
  assert.equal(firstShardStanding.recentMatches.length > 0, true)
  assert.equal(typeof firstShardStanding.recentMatches[0]?.opponent, 'string')
  assert.equal(typeof firstShardStanding.recentMatches[0]?.event, 'string')
  assert.equal(typeof firstShardStanding.recentMatches[0]?.date, 'string')
  assert.equal(manifest.walkForward.metrics.target, 'published-game')
  assert.equal(defaultSnapshot.standings.some((standing) => 'history' in standing), false)
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
  const summaryDefaultSnapshot = manifest.snapshots[manifest.defaultSnapshotKey]
  const proof = manifest.playerData.ratingProof
  const playerDirectory = createPlayerDirectory(data)
  const seasonPlayers = playerDirectory.scopedPlayers?.[snapshotKey({ season: '2026', event: 'All', region: 'All' })] ?? []

  assert.equal(data.playerData.status, 'sourced-player-stats')
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
  return {
    id,
    sourceProvider: 'seed',
    dataCompleteness: 'complete',
    date,
    season,
    event: `${homeLeague} ${season} Spring`,
    phase: 'Regular season',
    region: 'LEC',
    league: homeLeague,
    teamAHomeLeague: homeLeague,
    teamBHomeLeague: homeLeague,
    teamARegion: 'LEC',
    teamBRegion: 'LEC',
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
