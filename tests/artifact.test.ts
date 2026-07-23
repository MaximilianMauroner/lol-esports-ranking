import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import test from 'node:test'
import {
  parsePublicPlayerDirectory,
  parsePublicRegionHistory,
  parsePublicRankingManifest,
  parsePublicRankingShard,
  parsePublicTeamDirectory,
  parsePublicTeamHistoryIndex,
  parsePublicTeamHistoryShard,
  parsePublicTournamentMovementIndex,
  parsePublicTournamentMovementShard,
  parsePublicMatchHistoryIndex,
  parsePublicMatchHistoryCatalog,
  parsePublicMatchHistoryPage,
  PUBLIC_ARTIFACT_SCHEMA_VERSION,
  snapshotKey,
  snapshotShardUrlPathForKey,
  type SnapshotFilter,
  type SnapshotSourceBreakdown,
} from '../src/lib/publicArtifacts/schema.ts'
import { ratedTeamLeagues } from '../src/data/regionTaxonomy.ts'

const ratedTeamLeagueSet = new Set<string>(ratedTeamLeagues)

test('browser data artifact stays compact and does not ship the full snapshot', async () => {
  assert.equal(existsSync('public/data/ranking-snapshot.json'), false)
  assert.equal(existsSync('public/data/team-history.json'), false)
  assert.equal(existsSync('public/data/history/team-series.json'), false)
  assert.equal(existsSync('public/data/ranking-summary.json'), true)
  assert.ok(statSync('public/data/ranking-summary.json').size < 250_000)
  assert.ok(statSync('public/data/entities/players.json').size < 1_100_000)
  assert.equal(existsSync('public/data/matches/index.json'), true)

  const summary = parsePublicRankingManifest(await readJson('public/data/ranking-summary.json'))
  const playerDirectory = parsePublicPlayerDirectory(await readJson('public/data/entities/players.json'))
  const matchHistoryIndex = parsePublicMatchHistoryIndex(await readJson('public/data/matches/index.json'))
  const defaultShardEntry = summary.snapshotIndex[summary.defaultSnapshotKey]
  const defaultShard = defaultShardEntry ? parsePublicRankingShard(await readJson(publicPathForDataUrl(defaultShardEntry.url))) : undefined
  const defaultSnapshot = defaultShard
  const proofPlayers = summary.playerData?.ratingProof?.topPlayers ?? []

  assert.equal(summary.artifactKind, 'public-ranking-manifest')
  assert.equal(summary.schemaVersion, PUBLIC_ARTIFACT_SCHEMA_VERSION)
  assert.equal(summary.summaryMode, 'browser-summary')
  assert.equal(summary.matchHistoryIndexUrl?.startsWith('/data/matches/index.json?v='), true)
  assert.equal(matchHistoryIndex.artifactMeta.runId, summary.artifactMeta?.runId)
  const matchHistory2026 = parsePublicMatchHistoryCatalog(await readJson(publicPathForDataUrl(matchHistoryIndex.scopeIndex['2026__All__All'].url)))
  const matchHistory2026Page = parsePublicMatchHistoryPage(await readJson(publicPathForDataUrl(matchHistory2026.pages[0].url)))
  assert.equal(matchHistory2026.gameCount, summary.snapshotIndex['2026__All__All'].matchCount)
  assert.equal(matchHistory2026.pages.length > 1, true)
  assert.equal(matchHistory2026Page.seriesCount <= 25, true)
  assert.equal(matchHistory2026Page.gameCount < matchHistory2026.gameCount, true)
  assert.equal(matchHistory2026Page.matches.some((match) => match.impact.unit === 'series-applied' && typeof match.impact.teamA === 'number'), true)
  assert.equal(matchHistory2026Page.matches.some((match) => match.impact.unit === 'held'), true)
  assert.equal(summary.snapshots, undefined)
  assert.ok(defaultSnapshot)
  assert.equal(defaultSnapshot.artifactKind, 'public-snapshot-shard')
  assert.equal(defaultSnapshot.regions?.every((region) => typeof region.score === 'number'), true)
  assert.equal(defaultSnapshot.regions?.every((region) => typeof region.teamCount === 'number'), true)
  assert.equal(defaultSnapshot.regions?.every((region) => typeof region.ecosystemTeamCount === 'number'), true)
  assert.equal(Object.prototype.hasOwnProperty.call(defaultSnapshot, 'players'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(defaultSnapshot, 'events'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(defaultSnapshot, 'seasons'), false)
  assert.equal(defaultSnapshot.standings?.some((standing) => 'history' in standing), false)
  assert.equal(defaultSnapshot.standings?.every((standing) => Array.isArray(standing.recentMatches)), true)
  assert.equal(defaultSnapshot.standings?.some((standing) => standing.recentMatches?.length > 0), true)
  assert.equal(defaultShard?.standings?.some((standing) => standing.recentMatches?.some((match) => Boolean(match.opponent))), true)
  assert.equal(defaultSnapshot.standings?.some((standing) => 'explanation' in standing || 'explanations' in standing), false)
  assert.equal(defaultSnapshot.standings?.every((standing) => typeof standingComponent(standing, 'leagueAnchor') === 'number'), true)
  assert.equal(defaultSnapshot.standings?.every((standing) => typeof standingComponent(standing, 'teamStableOffset') === 'number'), true)
  assert.equal(defaultSnapshot.standings?.some((standing) => 'ratingUpdate' in standing), false)
  assert.equal(summary.playerData?.metric?.id, 'role-power')
  assert.equal(summary.playerData?.metric?.teamResultSignal, 'included')
  assert.equal(summary.playerData?.metric?.independentSkillClaim, false)
  assert.equal(playerDirectory.metric.id, summary.playerData?.metric?.id)
  assert.equal(playerDirectory.comparisonMetrics?.[0]?.id, 'individual-residual')
  assert.equal(playerDirectory.comparisonMetrics?.[0]?.teamResultSignal, 'reduced')
  assert.equal(playerDirectory.comparisonMetrics?.[0]?.independentSkillClaim, false)
  assert.equal(playerDirectory.diagnostics?.sameTeamTopFiveClustering.status, 'diagnostic-not-failure')
  assert.equal(Array.isArray(playerDirectory.diagnostics?.sameTeamTopFiveClustering.teams), true)
  assert.equal(proofPlayers.some((player) => 'history' in player || 'form' in player || 'impactDrivers' in player), false)
  assert.equal(summary.playerData?.awardSignals?.status, 'source-missing')
  assert.equal(summary.playerData?.awardSignals?.awardResidualsApplied, false)
  assert.equal(summary.dataQuality?.matchCount, summary.coverage?.matchCount)
  assert.equal(typeof summary.dataQuality?.missing?.patchCount, 'number')
  assert.equal(typeof summary.dataQuality?.rosterCoverage?.completeRosterSides, 'number')
  assert.equal(Array.isArray(summary.dataQuality?.identityCoverage?.unresolvedLeagueSummaries), true)
  assert.equal(playerDirectory.players?.every((player) => String(player.id).startsWith('oe:player:')), true)
  assert.equal(playerDirectory.players?.every((player) => player.playerId === player.id), true)
  assert.equal(playerDirectory.players?.every((player) => typeof player.teamId === 'string'), true)
  assert.equal(playerDirectory.players?.every((player) => player.sourceProvider === 'oracles-elixir'), true)
  assert.equal(playerDirectory.players?.every((player) => Boolean(player.latestObservedAt)), true)
  assert.equal(playerDirectory.players?.every((player) => typeof player.appearance?.latestTeamGames === 'number'), true)
  assert.equal(playerDirectory.players?.every((player) => typeof player.appearance?.primaryTeamGames === 'number'), true)
  assert.equal(playerDirectory.players?.every((player) => typeof player.teamGames === 'number'), true)
  assert.equal(playerDirectory.players?.every((player) => typeof player.appearance?.roleGames === 'number'), true)
  assert.equal(playerDirectory.players?.every((player) => Array.isArray(player.appearance?.teamHistory)), true)
  assert.equal(playerDirectory.players?.every((player) => Array.isArray(player.appearance?.flags)), true)
  assert.equal(playerDirectory.players?.every((player) => player.individualResidual?.sourceProvider === 'oracles-elixir'), true)
  assert.equal(playerDirectory.players?.every((player) => player.individualResidual?.metricVersion === 'individual-residual-v0'), true)
  assert.equal(playerDirectory.players?.every((player) => player.individualResidual?.scope === 'shadow-rated-complete-role-matchups'), true)
  assert.equal(playerDirectory.players?.every((player) => typeof player.individualResidual?.score === 'number'), true)
  assert.equal(playerDirectory.players?.every((player) => typeof player.individualResidual?.confidence === 'number'), true)
  assert.equal(playerDirectory.players?.every((player) => (player.individualResidual?.rank ?? 0) <= (playerDirectory.players?.length ?? 0)), true)
  assert.equal(playerDirectory.players?.some((player) => 'stats' in player || 'gameStats' in player), false)
  assert.equal(proofPlayers.every((player) => player.sourceProvider === 'oracles-elixir'), true)
  assert.equal(proofPlayers.every((player) => Boolean(player.sourceGameId)), true)
  assert.equal(proofPlayers.every((player) => Boolean(player.sourceFileName)), true)
  assert.equal(proofPlayers.every((player) => Boolean(player.latestObservedAt)), true)
  assert.equal(proofPlayers.every((player) => typeof player.appearance?.latestTeamGames === 'number'), true)
  assert.equal(playerDirectory.players?.some((player) => Number(player.impactDrivers?.awardResidualZ ?? 0) !== 0), false)
})

test('generated major-region scores preserve eastern-major separation and western-major ordering', async () => {
  const summary = parsePublicRankingManifest(await readJson('public/data/ranking-summary.json'))
  const defaultShardEntry = summary.snapshotIndex[summary.defaultSnapshotKey]
  assert.ok(defaultShardEntry)
  const defaultShard = parsePublicRankingShard(await readJson(publicPathForDataUrl(defaultShardEntry.url)))
  const lck = regionFor(defaultShard, 'LCK')
  const lpl = regionFor(defaultShard, 'LPL')
  const lec = regionFor(defaultShard, 'LEC')
  const lcs = regionFor(defaultShard, 'LCS')
  const season2026Entry = summary.snapshotIndex['2026__All__All']
  assert.ok(season2026Entry)
  const season2026Shard = parsePublicRankingShard(await readJson(publicPathForDataUrl(season2026Entry.url)))
  const lck2026 = regionFor(season2026Shard, 'LCK')
  const lec2026 = regionFor(season2026Shard, 'LEC')
  const lcs2026 = regionFor(season2026Shard, 'LCS')

  assert.deepEqual(new Set(defaultShard.regions.map((region) => region.region)), new Set(['LCK', 'LPL', 'LEC', 'LCS', 'LCP', 'CBLOL']))
  assert.equal(defaultShard.regions.every((region) => typeof region.topThreeTeamRating === 'number'), true)
  assert.equal(defaultShard.regions.every((region) => typeof region.totalTeamRating === 'number'), true)
  assert.ok(lpl.topThreeTeamRating >= lpl.totalTeamRating)
  assert.ok(Math.min(lck.score, lpl.score) - lec.score >= 35)
  assert.ok(Math.min(lck.score, lpl.score) > Math.max(lec.score, lcs.score))
  assert.ok(lck2026.topTeamRating - lec2026.topTeamRating >= 35)
  assert.ok(lcs2026.topTeamRating >= lcs2026.totalTeamRating)
})

test('generated 2026 scope lets LYON clear DRX and GiantX on team-local evidence', async () => {
  const summary = parsePublicRankingManifest(await readJson('public/data/ranking-summary.json'))
  const entry = summary.snapshotIndex['2026__All__All']
  assert.ok(entry)
  const shard = parsePublicRankingShard(await readJson(publicPathForDataUrl(entry.url)))
  const lyon = standingFor(shard, 'LYON')
  const drx = standingFor(shard, 'Kiwoom DRX')
  const giantx = standingFor(shard, 'GiantX')

  assert.equal(lyon.eligibility.eligible, true)
  assert.deepEqual([lyon.wins, lyon.losses], [20, 11])
  assert.deepEqual([drx.wins, drx.losses], [9, 20])
  assert.deepEqual([giantx.wins, giantx.losses], [15, 14])
  assert.equal(lyon.recentMatches.some((match) => match.opponent === 'Team Secret Whales' && match.result === 'W' && match.games === 3), true)
  assert.ok(lyon.rank < drx.rank)
  assert.ok(lyon.rank < giantx.rank)
})

test('generated 2026 scope records T1 current MSI evidence after Gen.G', async () => {
  const summary = parsePublicRankingManifest(await readJson('public/data/ranking-summary.json'))
  const entry = summary.snapshotIndex['2026__All__All']
  assert.ok(entry)
  const shard = parsePublicRankingShard(await readJson(publicPathForDataUrl(entry.url)))
  const t1 = standingFor(shard, 'T1')
  const geng = standingFor(shard, 'Gen.G')

  assert.deepEqual([t1.wins, t1.losses], [29, 10])
  assert.deepEqual([geng.wins, geng.losses], [27, 6])
  assert.equal(t1.recentMatches.some((match) => match.opponent === 'Bilibili Gaming' && match.result === 'L' && match.games === 5), true)
  assert.equal(t1.recentMatches.some((match) => match.opponent === 'Team Liquid' && match.result === 'W' && match.games === 3), true)
  assert.equal(t1.recentMatches.some((match) => match.opponent === 'G2 Esports' && match.result === 'L' && match.games === 4), true)
  assert.equal(geng.recentMatches.some((match) => match.opponent === 'T1' && match.result === 'L' && match.games === 5), true)
  assert.ok(geng.rank < t1.rank)
})

test('generated public fixture data does not serialize HTML entities', async () => {
  const publicDataFiles = await listJsonFiles('public/data')
  const entityViolations: string[] = []

  for (const file of publicDataFiles) {
    const contents = await readFile(file, 'utf8')
    if (containsHtmlEntityEscape(file) || containsHtmlEntityEscape(contents)) {
      entityViolations.push(relative(process.cwd(), file))
    }
  }

  assert.equal(
    entityViolations.length,
    0,
    `HTML entity escapes found in generated public data:\n${formatViolationList(entityViolations)}`,
  )
})

test('public summary snapshot index is consistent with generated shards', async () => {
  const summary = parsePublicRankingManifest(await readJson('public/data/ranking-summary.json'))
  const snapshotIndex = summary.snapshotIndex ?? {}
  const defaultSnapshotKey = summary.defaultSnapshotKey
  const indexedShardPaths = new Set<string>()
  const urls = new Set<string>()

  assert.ok(defaultSnapshotKey)
  assert.ok(snapshotIndex[defaultSnapshotKey])
  assert.equal(summary.snapshots, undefined)

  for (const [key, entry] of Object.entries(snapshotIndex)) {
    assert.equal(key, snapshotKeyFromFilter(entry.filter), `snapshot index key does not match its filter: ${key}`)
    assert.equal(dataUrlPath(entry.url), snapshotShardUrlPathForKey(key), `snapshot index URL does not match its key: ${key}`)
    assert.equal(urls.has(entry.url), false, `duplicate snapshot index URL: ${entry.url}`)
    urls.add(entry.url)

    const shardPath = publicPathForDataUrl(entry.url)
    assert.equal(existsSync(shardPath), true, `missing public snapshot shard: ${entry.url}`)
    indexedShardPaths.add(shardPath)

    const shard = parsePublicRankingShard(await readJson(shardPath))
    assert.equal(shard.artifactKind, 'public-snapshot-shard', `invalid shard artifact kind: ${entry.url}`)
    assert.deepEqual(shard.filter, entry.filter, `shard filter differs from snapshot index: ${entry.url}`)
    assert.equal(shard.matchCount, entry.matchCount, `shard match count differs from snapshot index: ${entry.url}`)
    assert.deepEqual(
      shard.sourceBreakdown,
      entry.sourceBreakdown,
      `shard source breakdown differs from snapshot index: ${entry.url}`,
    )
  }

  const unindexedShardFiles = (await listJsonFiles('public/data/scopes'))
    .filter((file) => !indexedShardPaths.has(file))
    .map((file) => relative(process.cwd(), file))

  assert.deepEqual(unindexedShardFiles, [], 'generated snapshot shard files without snapshot index entries')
})

test('generated public artifacts include season checkpoint scopes', async () => {
  const summary = parsePublicRankingManifest(await readJson('public/data/ranking-summary.json'))
  for (const seasonCheckpoints of Object.values(summary.filterOptions.checkpoints ?? {})) {
    assert.equal(seasonCheckpoints.length <= 3, true)
    assert.equal(seasonCheckpoints.some((entry) => entry.id === 'split-4'), false)
  }
  const checkpoints = summary.filterOptions.checkpoints?.['2026'] ?? []
  assert.equal(checkpoints.some((entry) => /\bEWC\b|ESPORTS WORLD CUP/i.test(entry.boundaryEvent)), false)
  const checkpoint = checkpoints.find((entry) => entry.id === 'split-2')
  assert.ok(checkpoint)
  const filter = { season: '2026', event: 'All', region: 'All', checkpoint: checkpoint.id } as const
  const key = snapshotKey(filter)
  const entry = summary.snapshotIndex[key]
  assert.ok(entry)
  assert.deepEqual(entry.filter, filter)
  assert.equal(dataUrlPath(entry.url), snapshotShardUrlPathForKey(key))

  const shard = parsePublicRankingShard(await readJson(publicPathForDataUrl(entry.url)))
  const teamHistoryIndex = parsePublicTeamHistoryIndex(await readJson('public/data/history/team-series/index.json'))
  const regionHistory = parsePublicRegionHistory(await readJson('public/data/history/region-series.json'))

  assert.match(checkpoint.boundaryEvent, /^(MSI 2026|2026 Mid-Season Invitational)$/)
  assert.equal(shard.filter.checkpoint, checkpoint.id)
  assert.equal(shard.matchCount > 0, true)
  assert.equal(shard.standings.some((standing) => standing.movement !== 0 || standing.delta !== 0), true)
  assert.ok(teamHistoryIndex.scopeIndex[key])
  assert.ok(regionHistory.scopes[key])
})

test('public manifest data URLs resolve to tracked public files', async () => {
  const summary = parsePublicRankingManifest(await readJson('public/data/ranking-summary.json'))
  const urls = new Set<string>()

  addLocalDataUrl(summary.fullSnapshotUrl, urls)
  addLocalDataUrl(summary.playerDirectoryUrl, urls)
  addLocalDataUrl(summary.teamDirectoryUrl, urls)
  addLocalDataUrl(summary.teamHistoryIndexUrl, urls)
  addLocalDataUrl(summary.regionHistoryUrl, urls)
  addLocalDataUrl(summary.tournamentMovementIndexUrl, urls)

  for (const entry of Object.values(summary.snapshotIndex ?? {})) {
    addLocalDataUrl(entry.url, urls)
  }

  const publicPaths = Array.from(urls).sort().map(publicPathForDataUrl)
  const missingPaths = publicPaths
    .filter((path) => !existsSync(path))
    .map((path) => relative(process.cwd(), path))

  assert.deepEqual(missingPaths, [], `manifest /data URLs resolve to missing public files:\n${formatViolationList(missingPaths)}`)

  const trackedPaths = gitTrackedPaths(publicPaths)
  if (!trackedPaths) return
  const untrackedPaths = publicPaths
    .map((path) => relative(process.cwd(), path))
    .filter((path) => !trackedPaths.has(path))

  assert.deepEqual(untrackedPaths, [], `manifest /data URLs resolve to untracked public files:\n${formatViolationList(untrackedPaths)}`)
})

test('public team history series store is consistent with scope indexes', async () => {
  const summary = parsePublicRankingManifest(await readJson('public/data/ranking-summary.json'))
  const teamHistory = parsePublicTeamHistoryIndex(await readJson('public/data/history/team-series/index.json'))

  assert.equal(dataUrlPath(summary.teamHistoryIndexUrl), '/data/history/team-series/index.json')
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'teamHistoryUrl'), false)
  assert.equal(teamHistory.artifactKind, 'team-history-index')
  assert.ok(Object.keys(teamHistory.scopeIndex).length > 0)

  for (const [key, entry] of Object.entries(teamHistory.scopeIndex)) {
    assert.ok(summary.snapshotIndex[key], `team history scope index has no ranking scope: ${key}`)
    assert.equal(entry.teamCount > 0, true, `team history scope has no teams: ${key}`)
    const shard = parsePublicTeamHistoryShard(await readJson(publicPathForDataUrl(entry.url)))
    assert.equal(shard.artifactKind, 'team-history-scope')
    assert.deepEqual(shard.filter, entry.filter)
    assert.equal(shard.teamCount, entry.teamCount)
    assert.equal(shard.pointCount, entry.pointCount)
  }
})

test('generated histories separate observed matches, current state, and region metric families', async () => {
  const teamHistory = parsePublicTeamHistoryShard(await readJson('public/data/history/team-series/All__All__All.json'))
  const regionHistory = parsePublicRegionHistory(await readJson('public/data/history/region-series.json'))
  const defaultRegionScope = regionHistory.scopes[regionHistory.defaultScopeKey]

  assert.equal(Object.values(teamHistory.series).every((series) => series.points.length >= 2), true)
  assert.equal(Object.values(teamHistory.series).every((series) => series.currentStanding.asOf === teamHistory.generatedAt), true)
  assert.equal(Object.values(teamHistory.series).flatMap((series) => series.points)
    .some((point) => (point[3] as { kind?: string } | undefined)?.kind === 'standing-adjustment'), false)
  assert.equal(Object.values(defaultRegionScope.leagueStrengthSeries).flatMap((series) => series.points).every((point) => point[3]?.source === 'league-strength-history'), true)
  assert.equal(Object.values(defaultRegionScope.regionPowerSeries).flatMap((series) => series.points).every((point) => point[3]?.source === 'region-power-history'), true)
})

test('generated confidence and lineups expose evidence limits instead of false precision', async () => {
  const shard = parsePublicRankingShard(await readJson('public/data/scopes/all.json'))
  const players = parsePublicPlayerDirectory(await readJson('public/data/entities/players.json'))
  const staleConfidence = shard.standings
    .filter((standing) => standing.eligibility.reasons.includes('stale'))
    .map((standing) => standing.confidence)

  assert.equal(Math.max(...staleConfidence) < 100, true)
  assert.equal(Object.values(players.currentLineups).every((lineup) => lineup.coveredRoles.length + lineup.missingRoles.length === 5), true)
  assert.equal(Object.values(players.currentLineups).every((lineup) => lineup.starters.length === lineup.coveredRoles.length), true)
})

test('public tournament movement index resolves versioned, boundary-correct shards', async () => {
  const summary = parsePublicRankingManifest(await readJson('public/data/ranking-summary.json'))
  const index = parsePublicTournamentMovementIndex(await readJson(publicPathForDataUrl(summary.tournamentMovementIndexUrl)))
  const ids = new Set<string>()
  const indexedPaths = new Set<string>()
  const shards = new Map<string, ReturnType<typeof parsePublicTournamentMovementShard>>()

  assert.equal(dataUrlPath(summary.tournamentMovementIndexUrl), '/data/history/tournament-moves/index.json')
  assert.ok(index.tournaments.length > 0)
  for (const entry of index.tournaments) {
    assert.equal(ids.has(entry.id), false, `duplicate tournament instance ${entry.id}`)
    ids.add(entry.id)
    const path = publicPathForDataUrl(entry.url)
    indexedPaths.add(path)
    assert.equal(existsSync(path), true, `missing tournament movement shard ${entry.url}`)
    const shard = parsePublicTournamentMovementShard(await readJson(path))
    shards.set(shard.id, shard)
    assert.equal(shard.id, entry.id)
    assert.equal(shard.participantCount, entry.participantCount)
    assert.equal(shard.teams.length, entry.participantCount)
    for (const team of shard.teams) {
      assert.equal(team.points[0]?.[3]?.kind, 'tournament-start')
      assert.equal(['tournament-end', 'tournament-today', 'tournament-latest-data'].includes(team.points.at(-1)?.[3]?.kind ?? ''), true)
      assert.equal(team.points.at(-1)?.[0], entry.boundaryDate)
      assert.equal(team.rankMovement, team.startRank - team.endRank)
      assert.equal(team.ratingDelta, team.endRating - team.startRating)
    }
  }
  assert.equal(shards.get('ewc:2026')?.startDate, '2026-07-15', 'EWC qualifiers must not move the main-event opening boundary')
  assert.equal(shards.get('worlds:2025')?.startDate, '2025-10-14', 'regional finals must not move the Worlds opening boundary')
  assert.equal(shards.get('msi:2025')?.teams.some((team) => team.team === 'GAM Esports'), true)
  assert.equal(shards.get('ewc:2025')?.teams.some((team) => team.team === 'GAM Esports'), true)
  const unindexedShardFiles = (await listJsonFiles('public/data/history/tournament-moves'))
    .filter((file) => !file.endsWith('/index.json') && !indexedPaths.has(file))
    .map((file) => relative(process.cwd(), file))
  assert.deepEqual(unindexedShardFiles, [], 'generated tournament movement shard files without index entries')
})

test('generated public artifacts share one model and generated-at provenance spine', async () => {
  const summary = parsePublicRankingManifest(await readJson('public/data/ranking-summary.json'))
  const players = parsePublicPlayerDirectory(await readJson('public/data/entities/players.json'))
  const teamHistoryIndex = parsePublicTeamHistoryIndex(await readJson('public/data/history/team-series/index.json'))
  const regionHistory = parsePublicRegionHistory(await readJson('public/data/history/region-series.json'))
  const tournamentMovementIndex = parsePublicTournamentMovementIndex(await readJson(publicPathForDataUrl(summary.tournamentMovementIndexUrl)))
  const snapshotIndex = summary.snapshotIndex ?? {}
  const defaultEntry = snapshotIndex[summary.defaultSnapshotKey]
  const defaultTeamHistoryEntry = teamHistoryIndex.scopeIndex[summary.defaultSnapshotKey]
  const defaultSnapshot = defaultEntry ? parsePublicRankingShard(await readJson(publicPathForDataUrl(defaultEntry.url))) : undefined
  const defaultTeamHistory = defaultTeamHistoryEntry ? parsePublicTeamHistoryShard(await readJson(publicPathForDataUrl(defaultTeamHistoryEntry.url))) : undefined
  const proof = summary.playerData?.ratingProof

  assert.ok(summary.generatedAt)
  assert.ok(summary.model?.version)
  assert.ok(summary.model?.configHash)
  assert.equal(dataUrlPath(summary.playerDirectoryUrl), '/data/entities/players.json')
  assert.equal(dataUrlPath(summary.teamDirectoryUrl), '/data/entities/teams.json')
  assert.equal(dataUrlPath(summary.teamHistoryIndexUrl), '/data/history/team-series/index.json')
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'teamHistoryUrl'), false)
  assert.equal(dataUrlPath(summary.regionHistoryUrl), '/data/history/region-series.json')
  assert.equal(summary.walkForward?.metrics?.modelVersion, summary.model.version)
  assert.equal(summary.walkForward?.metrics?.modelConfigHash, summary.model.configHash)
  assert.equal(proof?.modelVersion, summary.model.version)
  assert.equal(proof?.modelConfigHash, summary.model.configHash)
  assert.equal(defaultSnapshot?.modelVersion, summary.model.version)
  assert.equal(defaultSnapshot?.modelConfigHash, summary.model.configHash)

  assert.ok(defaultTeamHistory)
  for (const artifact of [players, teamHistoryIndex, defaultTeamHistory, regionHistory, tournamentMovementIndex]) {
    assert.equal(artifact.generatedAt, summary.generatedAt, `${artifact.artifactKind} generatedAt differs from manifest`)
    assert.equal(artifact.modelVersion, summary.model.version, `${artifact.artifactKind} modelVersion differs from manifest`)
    assert.equal(artifact.modelConfigHash, summary.model.configHash, `${artifact.artifactKind} modelConfigHash differs from manifest`)
  }


  for (const entry of tournamentMovementIndex.tournaments) {
    const shard = parsePublicTournamentMovementShard(await readJson(publicPathForDataUrl(entry.url)))
    assert.equal(shard.generatedAt, summary.generatedAt, `tournament shard generatedAt differs from manifest: ${entry.id}`)
    assert.equal(shard.modelVersion, summary.model.version, `tournament shard modelVersion differs from manifest: ${entry.id}`)
    assert.equal(shard.modelConfigHash, summary.model.configHash, `tournament shard modelConfigHash differs from manifest: ${entry.id}`)
  }

  for (const entry of Object.values(snapshotIndex)) {
    const shard = parsePublicRankingShard(await readJson(publicPathForDataUrl(entry.url)))
    assert.equal(shard.modelVersion, summary.model.version, `shard modelVersion differs from manifest: ${entry.url}`)
    assert.equal(shard.modelConfigHash, summary.model.configHash, `shard modelConfigHash differs from manifest: ${entry.url}`)
  }
})

test('generated public source coverage reconciles with default and shard snapshots', async () => {
  const summary = parsePublicRankingManifest(await readJson('public/data/ranking-summary.json'))
  const snapshotIndex = summary.snapshotIndex ?? {}
  const defaultEntry = summary.defaultSnapshotKey ? snapshotIndex[summary.defaultSnapshotKey] : undefined
  const defaultSnapshot = defaultEntry ? parsePublicRankingShard(await readJson(publicPathForDataUrl(defaultEntry.url))) : undefined
  const measuredSources = (summary.sources ?? []).filter((source) => source.status === 'active' && typeof source.rowCount === 'number' && ['match-data', 'game-stats', 'seed'].includes(source.kind))

  assert.ok(summary.coverage)
  assert.ok(defaultEntry)
  assert.ok(defaultSnapshot)
  assert.ok(measuredSources.length > 0)
  assert.equal(defaultEntry.matchCount, summary.coverage.matchCount)
  assert.equal(defaultSnapshot.matchCount, summary.coverage.matchCount)
  assert.equal(summary.walkForward?.metrics?.predictionCount, summary.coverage.matchCount)
  assert.deepEqual(
    summary.walkForward?.metrics?.baselineComparisons?.map((baseline) => baseline.key),
    ['coin-flip', 'pregame-win-rate', 'team-only'],
  )
  const crossRegionBaselineRows = summary.walkForward?.metrics?.baselineComparisons
    ?.map((baseline) => baseline.segments?.find((segment) => segment.key === 'cross-region'))
    .filter(Boolean)
  assert.equal(crossRegionBaselineRows?.length, 3)
  assert.equal(summary.coverage.latestMatchDate, summary.coverage.coverageEnd)
  assert.ok(Date.parse(`${summary.coverage.coverageStart}T00:00:00.000Z`) <= Date.parse(`${summary.coverage.coverageEnd}T00:00:00.000Z`))
  assert.ok(Date.parse(summary.generatedAt ?? '') >= Date.parse(`${summary.coverage.coverageEnd}T00:00:00.000Z`))
  assert.deepEqual(
    providersFor(defaultEntry.sourceBreakdown),
    summary.coverage.sourceProviders,
    'coverage sourceProviders differ from default snapshot sourceBreakdown providers',
  )

  const sourceCoverageStarts = measuredSources.map((source) => source.coverageStart).filter((date): date is string => Boolean(date)).sort()
  const sourceCoverageEnds = measuredSources.map((source) => source.coverageEnd).filter((date): date is string => Boolean(date)).sort()
  assert.equal(sourceCoverageStarts[0], summary.coverage.coverageStart)
  assert.equal(sourceCoverageEnds.at(-1), summary.coverage.coverageEnd)

  for (const source of measuredSources) {
    assert.ok((source.rowCount ?? 0) > 0, `active measured source has no rows: ${source.name}`)
    assert.ok(source.coverageStart, `active measured source missing coverageStart: ${source.name}`)
    assert.ok(source.coverageEnd, `active measured source missing coverageEnd: ${source.name}`)
    assert.ok(Date.parse(`${source.coverageStart}T00:00:00.000Z`) <= Date.parse(`${source.coverageEnd}T00:00:00.000Z`))
  }

  for (const entry of Object.values(snapshotIndex)) {
    const shard = parsePublicRankingShard(await readJson(publicPathForDataUrl(entry.url)))
    assert.equal(sumSourceBreakdown(shard.sourceBreakdown), shard.matchCount, `shard sourceBreakdown does not sum to matchCount: ${entry.url}`)
  }
})

test('generated 2026 scope exposes match-level display records and scoped history', async () => {
  const summary = parsePublicRankingManifest(await readJson('public/data/ranking-summary.json'))
  const entry = summary.snapshotIndex?.['2026__All__All']
  const teamHistoryIndex = parsePublicTeamHistoryIndex(await readJson('public/data/history/team-series/index.json'))
  const teamHistoryEntry = teamHistoryIndex.scopeIndex['2026__All__All']
  const teamHistory = teamHistoryEntry ? parsePublicTeamHistoryShard(await readJson(publicPathForDataUrl(teamHistoryEntry.url))) : undefined
  const scopedTeamIds = Object.keys(teamHistory?.series ?? {})

  assert.ok(entry)
  assert.ok(teamHistory)
  assert.ok(scopedTeamIds.length > 0)
  assert.deepEqual(entry.filter, { season: '2026', event: 'All', region: 'All' })

  const shard = parsePublicRankingShard(await readJson(publicPathForDataUrl(entry.url)))
  const displayedTeamRecordSides = shard.standings.reduce((total, standing) => total + standing.wins + standing.losses, 0)
  const sourceGameSides = shard.matchCount * 2
  const seriesRecentMatch = shard.standings
    .flatMap((standing) => standing.recentMatches)
    .find((match) => typeof match.games === 'number' && match.games > 1)
  const hle = shard.standings.find((standing) => standing.team === 'Hanwha Life Esports')
  assert.ok(hle)
  const hleVsGenGHistory = teamHistory.series[hle.teamId]?.points
    .filter((point) => point[0] === '2026-05-27' && point[3]?.opponent === 'Gen.G') ?? []
  const scopedDates = scopedTeamIds.flatMap((id) => teamHistory.series[id]?.points.map((point) => point[0]) ?? [])

  assert.ok(displayedTeamRecordSides > 0)
  assert.ok(displayedTeamRecordSides < sourceGameSides)
  assert.ok(seriesRecentMatch)
  assert.equal((seriesRecentMatch.wins ?? 0) + (seriesRecentMatch.losses ?? 0), seriesRecentMatch.games)
  assert.equal(hleVsGenGHistory.length, 1)
  assert.equal(hleVsGenGHistory[0]?.[3]?.wins, 1)
  assert.equal(hleVsGenGHistory[0]?.[3]?.losses, 2)
  assert.equal(hleVsGenGHistory[0]?.[3]?.games, 3)
  assert.equal(hleVsGenGHistory[0]?.[3]?.bestOf, 3)
  assert.ok(scopedDates.length > 0)
  assert.equal(scopedDates.some((date) => date.startsWith('2025-')), false)
  assert.equal(scopedDates.every((date) => date.startsWith('2026-')), true)
})

test('generated public artifacts only include the published rated team universe', async () => {
  const summary = parsePublicRankingManifest(await readJson('public/data/ranking-summary.json'))
  const teamDirectory = parsePublicTeamDirectory(await readJson('public/data/entities/teams.json'))
  const playerDirectory = parsePublicPlayerDirectory(await readJson('public/data/entities/players.json'))
  const teamHistoryIndex = parsePublicTeamHistoryIndex(await readJson('public/data/history/team-series/index.json'))
  const regionHistory = parsePublicRegionHistory(await readJson('public/data/history/region-series.json'))
  const snapshotIndex = summary.snapshotIndex ?? {}
  const universeParameters = summary.model.parameters as { ratingUniverse?: { ratedTeamLeagues?: readonly string[] } }
  const disallowedSpotlightTeams = new Set(['Vitality Rising Bees', 'Vantex Esports'])

  assert.deepEqual(new Set(universeParameters.ratingUniverse?.ratedTeamLeagues ?? []), ratedTeamLeagueSet)
  assert.equal(summary.filterOptions.regions.every((region) => region === 'All' || ratedTeamLeagueSet.has(region)), true)
  assert.equal(teamDirectory.teams.every((team) => ratedTeamLeagueSet.has(team.league)), true)

  const allPlayers = [
    ...(playerDirectory.players ?? []),
    ...Object.values(playerDirectory.scopedPlayers ?? {}).flat(),
  ]
  assert.equal(allPlayers.every((player) => !player.league || ratedTeamLeagueSet.has(player.league)), true)

  for (const [key, entry] of Object.entries(snapshotIndex)) {
    const shard = parsePublicRankingShard(await readJson(publicPathForDataUrl(entry.url)))
    assertShardUsesRatedTeamUniverse(shard)
    assert.equal(
      shard.standings.some((standing) => disallowedSpotlightTeams.has(standing.team)),
      false,
      `disallowed movement spotlight team leaked into ${entry.url}`,
    )

    const historyEntry = teamHistoryIndex.scopeIndex[key]
    if (historyEntry) {
      const history = parsePublicTeamHistoryShard(await readJson(publicPathForDataUrl(historyEntry.url)))
      const standingTeamIds = new Set(shard.standings.map((standing) => standing.teamId))
      assert.equal(
        Object.keys(history.series).every((teamId) => standingTeamIds.has(teamId)),
        true,
        `team-history series leaked a team outside the ranking shard for ${key}`,
      )
    }
  }

  for (const [key, scope] of Object.entries(regionHistory.scopes)) {
    assert.equal(
      [...Object.values(scope.leagueStrengthSeries), ...Object.values(scope.regionPowerSeries)]
        .every((series) => ratedTeamLeagueSet.has(series.region)),
      true,
      `region-history scope leaked a non-rated region: ${key}`,
    )
    assert.equal(
      Object.values(scope.leagueStrengthSeries).every((series) =>
        series.points.every((point) => (point[3]?.leagues ?? []).every((league) => ratedTeamLeagueSet.has(league))),
      ),
      true,
      `region-history scope leaked a non-rated league context: ${key}`,
    )
  }
})

test('generated ranked player directory excludes teams outside the rated universe', async () => {
  const summary = parsePublicRankingManifest(await readJson('public/data/ranking-summary.json'))
  const playerDirectory = parsePublicPlayerDirectory(await readJson('public/data/entities/players.json'))
  const entry = summary.snapshotIndex?.['2026__All__All']

  assert.ok(entry)

  const shard = parsePublicRankingShard(await readJson(publicPathForDataUrl(entry.url)))
  const ratedTeams = new Set(shard.standings.map((standing) => standing.team))
  const scopedPlayers = playerDirectory.scopedPlayers?.['2026__All__All'] ?? []

  assert.equal(scopedPlayers.every((player) => ratedTeams.has(player.team)), true)
  assert.equal(scopedPlayers.every((player) => !player.league || ratedTeamLeagueSet.has(player.league)), true)
})

test('generated ranked player directory requires displayed-team and role samples', async () => {
  const playerDirectory = parsePublicPlayerDirectory(await readJson('public/data/entities/players.json'))
  const allRows = [
    ...(playerDirectory.players ?? []),
    ...Object.values(playerDirectory.scopedPlayers ?? {}).flat(),
  ]

  assert.ok(allRows.length > 0)
  assert.equal(
    allRows.every((player) => (player.teamGames ?? 0) >= 20),
    true,
    'public player rows must have at least 20 games for the displayed team',
  )
  assert.equal(
    allRows.every((player) => (player.appearance?.roleGames ?? player.games) >= 20),
    true,
    'public player rows must have at least 20 games for the displayed role',
  )
  assert.equal(
    (playerDirectory.scopedPlayers?.['2025__All__All'] ?? []).some((player) =>
      player.name === 'Viper' && player.team === 'Bilibili Gaming' && (player.teamGames ?? 0) < 20,
    ),
    false,
    '2025 Viper-style transfer rows must not be credited to a thin latest-team sample',
  )
})

const htmlEntityPattern = /&(?:[a-zA-Z][a-zA-Z0-9]+|#\d+|#x[0-9a-fA-F]+);/
const encodedHtmlEntityPattern = /%26(?:[a-zA-Z][a-zA-Z0-9]+|%23\d+|%23x[0-9a-fA-F]+)%3B/i

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function listJsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return listJsonFiles(path)
      return entry.isFile() && entry.name.endsWith('.json') ? [path] : []
    }),
  )
  return files.flat().sort()
}

function containsHtmlEntityEscape(value: string) {
  return htmlEntityPattern.test(value) || encodedHtmlEntityPattern.test(value)
}

function formatViolationList(violations: string[]) {
  const visibleViolations = violations.slice(0, 20)
  const remaining = violations.length - visibleViolations.length
  return `${visibleViolations.join('\n')}${remaining > 0 ? `\n...and ${remaining} more` : ''}`
}

function snapshotKeyFromFilter(filter: SnapshotFilter) {
  return snapshotKey(filter)
}

function publicPathForDataUrl(url: string) {
  assert.equal(url.startsWith('/data/'), true, `snapshot URL must be rooted under /data: ${url}`)
  assert.equal(/[\\#]/.test(url), false, `snapshot URL must be a clean path: ${url}`)
  return join('public', ...dataUrlPath(url).slice(1).split('/').map(decodeUrlPathSegment))
}

function dataUrlPath(url: string | undefined) {
  assert.ok(url)
  return url.split('?', 1)[0]
}

function decodeUrlPathSegment(segment: string) {
  const decoded = decodeURIComponent(segment)
  assert.equal(decoded.includes('/') || decoded.includes('\\'), false, `data URL segment must not decode to a path separator: ${segment}`)
  assert.equal(decoded === '.' || decoded === '..', false, `data URL segment must not be traversal: ${segment}`)
  return decoded
}

function addLocalDataUrl(url: string | undefined, urls: Set<string>) {
  if (url?.startsWith('/data/')) urls.add(url)
}

function gitTrackedPaths(paths: string[]) {
  const relativePaths = paths.map((path) => relative(process.cwd(), path))
  try {
    const output = execFileSync('git', ['ls-files', '-z', '--', ...relativePaths], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return new Set(output.split('\0').filter(Boolean))
  } catch {
    return undefined
  }
}

function regionFor(shard: ReturnType<typeof parsePublicRankingShard>, region: string) {
  const row = shard.regions.find((candidate) => candidate.region === region)
  assert.ok(row)
  return row
}

function assertShardUsesRatedTeamUniverse(shard: ReturnType<typeof parsePublicRankingShard>) {
  assert.equal(
    shard.standings.every((standing) => ratedTeamLeagueSet.has(standing.league)),
    true,
    `ranking shard leaked standings outside rated leagues: ${shard.filter.season}/${shard.filter.event}/${shard.filter.region}`,
  )
  assert.equal(
    shard.leagues.every((league) => ratedTeamLeagueSet.has(league.league)),
    true,
    `ranking shard leaked league rows outside rated leagues: ${shard.filter.season}/${shard.filter.event}/${shard.filter.region}`,
  )
  assert.equal(
    shard.regions.every((region) => ratedTeamLeagueSet.has(region.region)),
    true,
    `ranking shard leaked region rows outside rated leagues: ${shard.filter.season}/${shard.filter.event}/${shard.filter.region}`,
  )
}

function standingFor(shard: ReturnType<typeof parsePublicRankingShard>, team: string) {
  const row = shard.standings.find((candidate) => candidate.team === team)
  assert.ok(row)
  return row
}

function sumSourceBreakdown(sourceBreakdown: SnapshotSourceBreakdown[] = []) {
  return sourceBreakdown.reduce((total, source) => total + (source.matchCount ?? 0), 0)
}

function standingComponent(standing: Record<string, unknown>, key: string) {
  return (standing.ratingComponents as Record<string, unknown> | undefined)?.[key]
}

function providersFor(sourceBreakdown: SnapshotSourceBreakdown[] = []) {
  return sourceBreakdown.map((source) => source.provider).filter((provider): provider is string => Boolean(provider)).sort()
}
