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
  assert.equal(chovy.sourceProvider, 'oracles-elixir')
  assert.equal(chovy.sourceGameId, 'oe-player-proof')
  assert.equal(chovy.sourceFileName, 'oracle-fixture.csv')
  assert.equal(chovy.latestObservedAt, '2026-06-26')
  assert.equal(chovy.latestObservedEvent, 'LCK 2026 Rounds 1-2')
  assert.equal(directory.modelVersion, 'transparent-gpr-vT')
})

test('createTeamHistory reports omitted standings with fewer than two points', () => {
  const includedStanding = {
    team: 'Alpha',
    code: 'ALP',
    region: 'LCK',
    history: [
      { date: '2026-01-01', rating: 1500, rank: 2 },
      { date: '2026-01-02', rating: 1510, rank: 1 },
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
  assert.equal(data.schemaVersion, 12)
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
  const { manifest } = createStaticRankingSummaryData(data)
  const publicArtifactManifest = createStaticRankingSummaryData(data, {
    fullSnapshotUrl: '/data/ranking-snapshot.full.json',
    playerDirectoryUrl: '/data/players.json',
    teamHistoryUrl: '/data/team-history.json',
  }).manifest
  const defaultSnapshot = manifest.snapshots[manifest.defaultSnapshotKey]
  const firstStanding = defaultSnapshot?.standings[0]

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
  assert.equal(typeof firstStanding.leagueScore, 'number')
  assert.equal(typeof firstStanding.leagueAdjustment, 'number')
  assert.equal(typeof firstStanding.ratingComponents?.leagueAnchor, 'number')
  assert.equal(typeof firstStanding.ratingComponents?.teamStableOffset, 'number')
  assert.equal(typeof firstStanding.ratingComponents?.momentum, 'number')
  assert.equal(typeof firstStanding.ratingUpdate?.teamStableDelta, 'number')
  assert.equal(typeof firstStanding.ratingUpdate?.leaguePlacementDelta, 'number')
  assert.equal(typeof firstStanding.eligibility?.eligible, 'boolean')
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
  assert.equal(data.playerData.awardSignals.status, 'source-missing')
  assert.equal(data.playerData.awardSignals.awardResidualsApplied, false)
  assert.equal(fullDefaultSnapshot.players.every((player) => player.impactDrivers.awardResidualZ === 0), true)
  assert.equal(createPlayerDirectory(data).players.every((player) => player.impactDrivers.awardResidualZ === 0), true)
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
