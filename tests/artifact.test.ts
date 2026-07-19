import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  parsePublicMatchHistoryCatalog,
  parsePublicMatchHistoryIndex,
  parsePublicMatchHistoryPage,
  parsePublicPlayerDirectory,
  parsePublicRankingManifest,
  parsePublicRankingShard,
  parsePublicRegionHistory,
  parsePublicTeamDirectory,
  parsePublicTeamHistoryIndex,
  parsePublicTeamHistoryShard,
  parsePublicTournamentMovementIndex,
  parsePublicTournamentMovementShard,
  PUBLIC_ARTIFACT_SCHEMA_VERSION,
  snapshotKey,
  snapshotShardUrlPathForKey,
} from '../src/lib/publicArtifacts/schema.ts'
import { PUBLIC_ARTIFACT_BUDGETS } from '../src/lib/publicArtifacts/writePlan.ts'
import { ratedTeamLeagues } from '../src/data/regionTaxonomy.ts'
import { validatePublicArtifactBundle } from '../scripts/materialize-ranking-data.ts'
import { PUBLIC_ARTIFACT_FIXTURE_DIR, PUBLIC_ARTIFACT_FIXTURE_RUN } from './fixtures/publicArtifactBundle.ts'

test('deterministic browser fixture is a complete schema-valid artifact graph', async () => {
  const validated = await validatePublicArtifactBundle(PUBLIC_ARTIFACT_FIXTURE_DIR)
  assert.ok(validated.relativePaths.length > 10)
  assert.equal(validated.manifest.schemaVersion, PUBLIC_ARTIFACT_SCHEMA_VERSION)
  assert.equal(validated.manifest.artifactKind, 'public-ranking-manifest')
  const artifactMeta = validated.manifest.artifactMeta
  assert.ok(artifactMeta)
  assert.equal(artifactMeta.runId, PUBLIC_ARTIFACT_FIXTURE_RUN.runId)
})

test('browser artifacts stay compact and exclude full audit snapshots', async () => {
  const manifestPath = join(PUBLIC_ARTIFACT_FIXTURE_DIR, 'ranking-summary.json')
  const playersPath = join(PUBLIC_ARTIFACT_FIXTURE_DIR, 'entities/players.json')
  assert.ok((await stat(manifestPath)).size <= PUBLIC_ARTIFACT_BUDGETS.manifestBytes)
  assert.ok((await stat(playersPath)).size <= PUBLIC_ARTIFACT_BUDGETS.playersBytes)
  await assert.rejects(stat(join(PUBLIC_ARTIFACT_FIXTURE_DIR, 'ranking-snapshot.json')))
  await assert.rejects(stat(join(PUBLIC_ARTIFACT_FIXTURE_DIR, 'ranking-snapshot.full.json')))
  await assert.rejects(stat(join(PUBLIC_ARTIFACT_FIXTURE_DIR, 'team-history.json')))
  await assert.rejects(stat(join(PUBLIC_ARTIFACT_FIXTURE_DIR, 'history/team-series.json')))
})

test('browser contracts preserve summary, rating, player-evidence, and data-quality semantics', async () => {
  const manifest = parsePublicRankingManifest(await json('ranking-summary.json'))
  const shard = parsePublicRankingShard(await json(dataPath(manifest.snapshotIndex[manifest.defaultSnapshotKey].url)))
  const players = parsePublicPlayerDirectory(await json(dataPath(manifest.playerDirectoryUrl)))
  assert.equal(manifest.summaryMode, 'browser-summary')
  assert.equal(manifest.snapshots, undefined)
  assert.equal(shard.regions.every((region) => typeof region.score === 'number' && typeof region.teamCount === 'number'), true)
  assert.equal(shard.regions.every((region) => typeof region.ecosystemTeamCount === 'number'), true)
  assert.equal(shard.standings.some((standing) => 'history' in standing || 'ratingUpdate' in standing), false)
  assert.equal(shard.standings.every((standing) => Array.isArray(standing.recentMatches)), true)
  assert.equal(shard.standings.some((standing) => standing.recentMatches.some((match) => Boolean(match.opponent))), true)
  assert.equal(shard.standings.some((standing) => 'explanation' in standing || 'explanations' in standing), false)
  assert.equal(shard.standings.every((standing) => typeof standing.ratingComponents.leagueAnchor === 'number'), true)
  assert.equal(shard.standings.every((standing) => typeof standing.ratingComponents.teamStableOffset === 'number'), true)
  assert.equal(manifest.playerData?.metric?.id, 'role-power')
  assert.equal(manifest.playerData?.metric?.teamResultSignal, 'included')
  assert.equal(manifest.playerData?.metric?.independentSkillClaim, false)
  assert.equal(players.metric.id, manifest.playerData?.metric?.id)
  assert.equal(players.comparisonMetrics?.[0]?.id, 'individual-residual')
  assert.equal(players.comparisonMetrics?.[0]?.teamResultSignal, 'reduced')
  assert.equal(players.comparisonMetrics?.[0]?.independentSkillClaim, false)
  assert.equal(players.diagnostics?.sameTeamTopFiveClustering.status, 'diagnostic-not-failure')
  assert.equal(Array.isArray(players.diagnostics?.sameTeamTopFiveClustering.teams), true)
  assert.equal(players.players?.every((player) => String(player.id).startsWith('oe:player:') && player.playerId === player.id), true)
  assert.equal(players.players?.every((player) => typeof player.teamId === 'string' && player.sourceProvider === 'oracles-elixir'), true)
  assert.equal(players.players?.every((player) => Boolean(player.latestObservedAt) && typeof player.teamGames === 'number'), true)
  assert.equal(players.players?.every((player) => typeof player.appearance?.latestTeamGames === 'number' && typeof player.appearance?.primaryTeamGames === 'number' && typeof player.appearance?.roleGames === 'number'), true)
  assert.equal(players.players?.every((player) => Array.isArray(player.appearance?.teamHistory) && Array.isArray(player.appearance?.flags)), true)
  assert.equal(players.players?.every((player) => player.individualResidual?.sourceProvider === 'oracles-elixir' && player.individualResidual?.scope === 'shadow-rated-complete-role-matchups'), true)
  assert.equal(players.players?.every((player) => typeof player.individualResidual?.score === 'number' && typeof player.individualResidual?.confidence === 'number' && (player.individualResidual?.rank ?? 0) <= (players.players?.length ?? 0)), true)
  assert.equal(players.players?.some((player) => 'stats' in player || 'gameStats' in player), false)
  const proof = manifest.playerData?.ratingProof?.topPlayers ?? []
  assert.equal(proof.some((player) => 'history' in player || 'form' in player || 'impactDrivers' in player), false)
  assert.equal(proof.every((player) => player.sourceProvider === 'oracles-elixir' && Boolean(player.sourceGameId) && Boolean(player.sourceFileName) && Boolean(player.latestObservedAt)), true)
  assert.equal(proof.every((player) => typeof player.appearance?.latestTeamGames === 'number'), true)
  assert.equal(manifest.playerData?.awardSignals?.status, 'source-missing')
  assert.equal(manifest.playerData?.awardSignals?.awardResidualsApplied, false)
  assert.equal(players.players?.some((player) => Number(player.impactDrivers?.awardResidualZ ?? 0) !== 0), false)
  assert.equal(manifest.dataQuality?.matchCount, manifest.coverage?.matchCount)
  assert.equal(typeof manifest.dataQuality?.missing?.patchCount, 'number')
  assert.equal(typeof manifest.dataQuality?.rosterCoverage?.completeRosterSides, 'number')
  assert.equal(Array.isArray(manifest.dataQuality?.identityCoverage?.unresolvedLeagueSummaries), true)
})

test('generated fixture paths and contents never serialize HTML entity escapes', async () => {
  const validated = await validatePublicArtifactBundle(PUBLIC_ARTIFACT_FIXTURE_DIR)
  const entity = /&(?:[a-zA-Z][a-zA-Z0-9]+|#\d+|#x[0-9a-fA-F]+);|%26(?:[a-zA-Z][a-zA-Z0-9]+|%23\d+|%23x[0-9a-fA-F]+)%3B/i
  const violations: string[] = []
  for (const path of validated.relativePaths) {
    const contents = await readFile(join(PUBLIC_ARTIFACT_FIXTURE_DIR, path), 'utf8')
    if (entity.test(path) || entity.test(contents)) violations.push(path)
  }
  assert.deepEqual(violations, [])
})

test('manifest references schema-valid scope and entity companions with one provenance spine', async () => {
  const manifest = parsePublicRankingManifest(await json('ranking-summary.json'))
  const teams = parsePublicTeamDirectory(await json(dataPath(manifest.teamDirectoryUrl)))
  const players = parsePublicPlayerDirectory(await json(dataPath(manifest.playerDirectoryUrl)))
  assert.equal(teams.teamCount, teams.teams.length)
  assert.ok(Array.isArray(players.players))
  for (const [key, expected] of Object.entries(manifest.snapshotIndex)) {
    const shard = parsePublicRankingShard(await json(dataPath(expected.url)))
    const artifactMeta = shard.artifactMeta
    assert.ok(artifactMeta, key)
    assert.equal(artifactMeta.runId, manifest.artifactMeta?.runId, key)
    assert.equal(shard.modelVersion, manifest.model.version, key)
    assert.equal(shard.modelConfigHash, manifest.model.configHash, key)
    assert.equal(shard.matchCount, expected.matchCount, key)
  }
})

test('snapshot indexes, shard paths, filters, source counts, and checkpoint boundaries stay consistent', async () => {
  const manifest = parsePublicRankingManifest(await json('ranking-summary.json'))
  const indexedPaths = new Set<string>()
  const history = parsePublicTeamHistoryIndex(await json(dataPath(manifest.teamHistoryIndexUrl)))
  const regions = parsePublicRegionHistory(await json(dataPath(manifest.regionHistoryUrl)))
  for (const [key, expected] of Object.entries(manifest.snapshotIndex)) {
    assert.equal(key, snapshotKey(expected.filter))
    assert.equal(`/data/${dataPath(expected.url)}`, snapshotShardUrlPathForKey(key))
    indexedPaths.add(dataPath(expected.url).replace('scopes/', ''))
    const shard = parsePublicRankingShard(await json(dataPath(expected.url)))
    assert.deepEqual(shard.filter, expected.filter)
    assert.deepEqual(shard.sourceBreakdown, expected.sourceBreakdown)
    assert.equal(shard.sourceBreakdown.reduce((sum, source) => sum + (source.matchCount ?? 0), 0), shard.matchCount)
  }
  const scopeFiles = (await readdir(join(PUBLIC_ARTIFACT_FIXTURE_DIR, 'scopes'))).filter((path) => path.endsWith('.json')).sort()
  assert.deepEqual(scopeFiles, [...indexedPaths].sort())
  for (const [season, checkpoints] of Object.entries(manifest.filterOptions.checkpoints ?? {})) {
    assert.ok(checkpoints.length <= 3)
    assert.equal(checkpoints.some((checkpoint) => checkpoint.id === 'split-4' || /\bEWC\b|ESPORTS WORLD CUP/i.test(checkpoint.boundaryEvent)), false)
    for (const checkpoint of checkpoints) {
      const key = snapshotKey({ season, event: 'All', region: 'All', checkpoint: checkpoint.id })
      const entry = manifest.snapshotIndex[key]
      assert.ok(entry)
      assert.ok(history.scopeIndex[key])
      assert.ok(regions.scopes[key])
      assert.ok(Date.parse(`${checkpoint.startDate}T00:00:00.000Z`) <= Date.parse(`${checkpoint.endDate}T00:00:00.000Z`))
      const shard = parsePublicRankingShard(await json(dataPath(entry.url)))
      assert.equal(shard.filter.checkpoint, checkpoint.id)
      assert.ok(shard.matchCount > 0)
      assert.equal(shard.standings.some((standing) => standing.movement !== 0 || standing.delta !== 0), true)
    }
  }
})

test('team, region, and tournament history indexes resolve every referenced shard', async () => {
  const manifest = parsePublicRankingManifest(await json('ranking-summary.json'))
  const teamIndex = parsePublicTeamHistoryIndex(await json(dataPath(manifest.teamHistoryIndexUrl)))
  for (const [key, expected] of Object.entries(teamIndex.scopeIndex)) {
    const shard = parsePublicTeamHistoryShard(await json(dataPath(expected.url)))
    assert.equal(shard.teamCount, expected.teamCount, key)
    assert.equal(shard.pointCount, expected.pointCount, key)
  }
  const regions = parsePublicRegionHistory(await json(dataPath(manifest.regionHistoryUrl)))
  assert.ok(regions.scopes[regions.defaultScopeKey])
  const tournaments = parsePublicTournamentMovementIndex(await json(dataPath(manifest.tournamentMovementIndexUrl)))
  const tournamentFiles = new Set<string>()
  for (const expected of tournaments.tournaments) {
    tournamentFiles.add(dataPath(expected.url).replace('history/tournament-moves/', ''))
    const shard = parsePublicTournamentMovementShard(await json(dataPath(expected.url)))
    assert.equal(shard.id, expected.id)
    assert.equal(shard.artifactMeta.runId, manifest.artifactMeta?.runId)
    assert.equal(shard.participantCount, expected.participantCount)
    for (const team of shard.teams) {
      assert.equal(team.points[0]?.[3]?.kind, 'tournament-start')
      assert.equal(['tournament-end', 'tournament-today', 'tournament-latest-data'].includes(team.points.at(-1)?.[3]?.kind ?? ''), true)
      assert.equal(team.points.at(-1)?.[0], expected.boundaryDate)
      assert.equal(team.rankMovement, team.startRank - team.endRank)
      assert.equal(team.ratingDelta, team.endRating - team.startRating)
    }
  }
  const generatedTournamentFiles = (await readdir(join(PUBLIC_ARTIFACT_FIXTURE_DIR, 'history/tournament-moves'))).filter((path) => path !== 'index.json').sort()
  assert.deepEqual(generatedTournamentFiles, [...tournamentFiles].sort())
})

test('history families separate observed matches, current state, and region metrics', async () => {
  const manifest = parsePublicRankingManifest(await json('ranking-summary.json'))
  const teamIndex = parsePublicTeamHistoryIndex(await json(dataPath(manifest.teamHistoryIndexUrl)))
  const teamHistory = parsePublicTeamHistoryShard(await json(dataPath(teamIndex.scopeIndex[manifest.defaultSnapshotKey].url)))
  const regionHistory = parsePublicRegionHistory(await json(dataPath(manifest.regionHistoryUrl)))
  const regionScope = regionHistory.scopes[regionHistory.defaultScopeKey]
  assert.equal(Object.values(teamHistory.series).every((series) => series.currentStanding.asOf === teamHistory.generatedAt), true)
  assert.equal(Object.values(regionScope.leagueStrengthSeries).flatMap((series) => series.points).every((point) => point[3]?.source === 'league-strength-history'), true)
  assert.equal(Object.values(regionScope.regionPowerSeries).flatMap((series) => series.points).every((point) => point[3]?.source === 'region-power-history'), true)
})

test('confidence, lineup completeness, and player evidence expose their sample limits', async () => {
  const manifest = parsePublicRankingManifest(await json('ranking-summary.json'))
  const shard = parsePublicRankingShard(await json(dataPath(manifest.snapshotIndex[manifest.defaultSnapshotKey].url)))
  const players = parsePublicPlayerDirectory(await json(dataPath(manifest.playerDirectoryUrl)))
  const limited = shard.standings.filter((standing) => standing.eligibility.reasons.length > 0)
  assert.ok(limited.length > 0)
  assert.equal(Math.max(...limited.map((standing) => standing.confidence)) < 100, true)
  assert.ok(Object.keys(players.currentLineups).length > 0)
  assert.equal(Object.values(players.currentLineups).every((lineup) => lineup.coveredRoles.length + lineup.missingRoles.length === 5), true)
  assert.equal(Object.values(players.currentLineups).every((lineup) => lineup.starters.length === lineup.coveredRoles.length), true)
  assert.ok((players.players?.length ?? 0) > 0)
  assert.equal(players.players?.every((player) => (player.teamGames ?? 0) >= 20), true)
  assert.equal(players.players?.every((player) => (player.appearance?.roleGames ?? player.games) >= 20), true)
  assert.equal(players.players?.every((player) => player.sourceProvider === 'oracles-elixir' && Boolean(player.latestObservedAt)), true)
  assert.equal(players.players?.every((player) => player.individualResidual?.metricVersion === 'individual-residual-v0'), true)
})

test('match history index, catalogs, and pages form a complete count-consistent graph', async () => {
  const manifest = parsePublicRankingManifest(await json('ranking-summary.json'))
  const index = parsePublicMatchHistoryIndex(await json(dataPath(manifest.matchHistoryIndexUrl)))
  for (const [key, expected] of Object.entries(index.scopeIndex)) {
    const catalog = parsePublicMatchHistoryCatalog(await json(dataPath(expected.url)))
    const pages = await Promise.all(catalog.pages.map(async (entry) => parsePublicMatchHistoryPage(await json(dataPath(entry.url)))))
    assert.equal(pages.reduce((sum, page) => sum + page.gameCount, 0), catalog.gameCount, key)
    assert.equal(catalog.pages.length, expected.pageCount, key)
    assert.ok(pages.every((page) => page.artifactMeta.runId === manifest.artifactMeta?.runId))
    assert.ok(pages.flatMap((page) => page.matches).every((match) => Boolean(match.source.provider) && Boolean(match.source.gameId)))
    assert.ok(pages.flatMap((page) => page.matches).every((match) => match.impact.unit === 'series-applied' || match.impact.unit === 'held'))
    if (key === manifest.defaultSnapshotKey) {
      assert.ok(catalog.pages.length > 1)
      assert.ok(pages.every((page) => page.seriesCount <= 25 && page.gameCount < catalog.gameCount))
      assert.equal(pages.flatMap((page) => page.matches).some((match) => match.impact.unit === 'series-applied' && typeof match.impact.teamA === 'number'), true)
      assert.equal(pages.flatMap((page) => page.matches).some((match) => match.impact.unit === 'held'), true)
    }
  }
})

test('scope display records aggregate series while scoped histories remain season bounded', async () => {
  const manifest = parsePublicRankingManifest(await json('ranking-summary.json'))
  const entry = manifest.snapshotIndex['2026__All__All']
  assert.ok(entry)
  const shard = parsePublicRankingShard(await json(dataPath(entry.url)))
  const displayedRecordSides = shard.standings.reduce((sum, standing) => sum + standing.wins + standing.losses, 0)
  const sourceGameSides = shard.matchCount * 2
  const series = shard.standings.flatMap((standing) => standing.recentMatches).find((match) => (match.games ?? 0) > 1)
  assert.ok(displayedRecordSides > 0 && displayedRecordSides < sourceGameSides)
  assert.ok(series)
  assert.equal((series.wins ?? 0) + (series.losses ?? 0), series.games)
  const index = parsePublicTeamHistoryIndex(await json(dataPath(manifest.teamHistoryIndexUrl)))
  const history = parsePublicTeamHistoryShard(await json(dataPath(index.scopeIndex['2026__All__All'].url)))
  const dates = Object.values(history.series).flatMap((value) => value.points.map((point) => point[0]))
  assert.ok(dates.length > 0)
  assert.equal(dates.every((date) => date.startsWith('2026-')), true)
})

test('coverage, default snapshot, and source breakdown reconcile exactly', async () => {
  const manifest = parsePublicRankingManifest(await json('ranking-summary.json'))
  const entry = manifest.snapshotIndex[manifest.defaultSnapshotKey]
  const shard = parsePublicRankingShard(await json(dataPath(entry.url)))
  assert.equal(entry.matchCount, manifest.coverage?.matchCount)
  assert.equal(shard.matchCount, manifest.coverage?.matchCount)
  assert.equal(manifest.walkForward?.metrics?.predictionCount, manifest.coverage?.matchCount)
  assert.deepEqual(manifest.walkForward?.metrics?.baselineComparisons?.map((baseline) => baseline.key), ['coin-flip', 'pregame-win-rate', 'team-only'])
  assert.equal(manifest.coverage?.latestMatchDate, manifest.coverage?.coverageEnd)
  assert.equal(Date.parse(manifest.generatedAt) >= Date.parse(`${manifest.coverage?.coverageEnd}T00:00:00.000Z`), true)
  assert.deepEqual(entry.sourceBreakdown.map((source) => source.provider).filter(Boolean).sort(), manifest.coverage?.sourceProviders)
  const measured = (manifest.sources ?? []).filter((source) => source.status === 'active' && typeof source.rowCount === 'number' && ['match-data', 'game-stats', 'seed'].includes(source.kind))
  assert.ok(measured.length > 0)
  assert.equal(Math.min(...measured.map((source) => Date.parse(`${source.coverageStart}T00:00:00.000Z`))), Date.parse(`${manifest.coverage?.coverageStart}T00:00:00.000Z`))
  assert.equal(Math.max(...measured.map((source) => Date.parse(`${source.coverageEnd}T00:00:00.000Z`))), Date.parse(`${manifest.coverage?.coverageEnd}T00:00:00.000Z`))
  assert.equal(measured.every((source) => (source.rowCount ?? 0) > 0 && Boolean(source.coverageStart) && Boolean(source.coverageEnd)), true)
  const crossRegionBaselines = manifest.walkForward?.metrics?.baselineComparisons?.map((baseline) => baseline.segments?.find((segment) => segment.key === 'cross-region')).filter(Boolean)
  assert.equal(crossRegionBaselines?.length, 3)
})

test('rated team and player universe never leaks outside published leagues or standings', async () => {
  const rated = new Set<string>(ratedTeamLeagues)
  const manifest = parsePublicRankingManifest(await json('ranking-summary.json'))
  const teams = parsePublicTeamDirectory(await json(dataPath(manifest.teamDirectoryUrl)))
  const players = parsePublicPlayerDirectory(await json(dataPath(manifest.playerDirectoryUrl)))
  const histories = parsePublicTeamHistoryIndex(await json(dataPath(manifest.teamHistoryIndexUrl)))
  const regions = parsePublicRegionHistory(await json(dataPath(manifest.regionHistoryUrl)))
  const parameters = manifest.model.parameters as { ratingUniverse?: { ratedTeamLeagues?: readonly string[] } }
  assert.deepEqual(new Set(parameters.ratingUniverse?.ratedTeamLeagues ?? []), rated)
  assert.equal(teams.teams.every((team) => rated.has(team.league)), true)
  assert.equal([...(players.players ?? []), ...Object.values(players.scopedPlayers ?? {}).flat()].every((player) => !player.league || rated.has(player.league)), true)
  for (const [key, entry] of Object.entries(manifest.snapshotIndex)) {
    const shard = parsePublicRankingShard(await json(dataPath(entry.url)))
    assert.equal([...shard.standings.map((row) => row.league), ...shard.leagues.map((row) => row.league), ...shard.regions.map((row) => row.region)].every((league) => rated.has(league)), true)
    const standingTeams = new Set(shard.standings.map((standing) => standing.team))
    assert.equal((players.scopedPlayers?.[key] ?? []).every((player) => standingTeams.has(player.team)), true)
    const historyEntry = histories.scopeIndex[key]
    if (historyEntry) {
      const history = parsePublicTeamHistoryShard(await json(dataPath(historyEntry.url)))
      const standingIds = new Set(shard.standings.map((standing) => standing.teamId))
      assert.equal(Object.keys(history.series).every((teamId) => standingIds.has(teamId)), true)
    }
  }
  assert.equal(Object.values(regions.scopes).flatMap((scope) => [...Object.values(scope.leagueStrengthSeries), ...Object.values(scope.regionPowerSeries)]).every((series) => rated.has(series.region)), true)
})

function dataPath(url: string | undefined) {
  if (!url?.startsWith('/data/')) throw new Error(`Invalid public artifact URL: ${url ?? '<missing>'}`)
  return url.slice('/data/'.length).split('?', 1)[0]
}

async function json(relativePath: string) {
  return JSON.parse(await readFile(join(PUBLIC_ARTIFACT_FIXTURE_DIR, relativePath), 'utf8')) as unknown
}
