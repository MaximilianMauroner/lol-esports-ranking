import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import test from 'node:test'
import {
  parsePublicPlayerDirectory,
  parsePublicRankingManifest,
  parsePublicRankingShard,
  parsePublicTeamHistory,
  snapshotKey,
  type SnapshotFilter,
  type SnapshotSourceBreakdown,
} from '../src/lib/publicArtifacts/schema.ts'

test('browser data artifact stays compact and does not ship the full snapshot', async () => {
  assert.equal(existsSync('public/data/ranking-snapshot.json'), false)
  assert.equal(existsSync('public/data/ranking-summary.json'), true)
  assert.ok(statSync('public/data/ranking-summary.json').size < 3_000_000)

  const summary = parsePublicRankingManifest(await readJson('public/data/ranking-summary.json'))
  const playerDirectory = parsePublicPlayerDirectory(await readJson('public/data/players.json'))
  const defaultSnapshot = summary.defaultSnapshotKey ? summary.snapshots?.[summary.defaultSnapshotKey] : undefined
  const proofPlayers = summary.playerData?.ratingProof?.topPlayers ?? []

  assert.equal(summary.artifactKind, 'public-ranking-manifest')
  assert.equal(summary.schemaVersion, 12)
  assert.equal(summary.summaryMode, 'browser-summary')
  assert.ok(defaultSnapshot)
  assert.equal(defaultSnapshot.artifactKind, 'public-snapshot-shard')
  assert.equal(defaultSnapshot.regions?.every((region) => typeof region.score === 'number'), true)
  assert.equal(defaultSnapshot.regions?.every((region) => typeof region.teamCount === 'number'), true)
  assert.equal(defaultSnapshot.regions?.every((region) => typeof region.ecosystemTeamCount === 'number'), true)
  assert.equal(Object.prototype.hasOwnProperty.call(defaultSnapshot, 'players'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(defaultSnapshot, 'events'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(defaultSnapshot, 'seasons'), false)
  assert.equal(defaultSnapshot.standings?.some((standing) => 'history' in standing), false)
  assert.equal(defaultSnapshot.standings?.some((standing) => 'explanation' in standing || 'explanations' in standing), false)
  assert.equal(defaultSnapshot.standings?.every((standing) => typeof standingComponent(standing, 'leagueAnchor') === 'number'), true)
  assert.equal(defaultSnapshot.standings?.every((standing) => typeof standingComponent(standing, 'teamStableOffset') === 'number'), true)
  assert.equal(defaultSnapshot.standings?.every((standing) => typeof standingUpdate(standing, 'teamStableDelta') === 'number'), true)
  assert.equal(defaultSnapshot.standings?.every((standing) => typeof standingUpdate(standing, 'leaguePlacementDelta') === 'number'), true)
  assert.equal(proofPlayers.some((player) => 'history' in player || 'form' in player || 'impactDrivers' in player), false)
  assert.equal(summary.playerData?.awardSignals?.status, 'source-missing')
  assert.equal(summary.playerData?.awardSignals?.awardResidualsApplied, false)
  assert.equal(summary.dataQuality?.matchCount, summary.coverage?.matchCount)
  assert.equal(typeof summary.dataQuality?.missing?.patchCount, 'number')
  assert.equal(typeof summary.dataQuality?.rosterCoverage?.completeRosterSides, 'number')
  assert.equal(Array.isArray(summary.dataQuality?.identityCoverage?.unresolvedLeagueSummaries), true)
  assert.equal(playerDirectory.players?.every((player) => String(player.id).startsWith('oe:player:')), true)
  assert.equal(playerDirectory.players?.every((player) => player.sourceProvider === 'oracles-elixir'), true)
  assert.equal(playerDirectory.players?.every((player) => Boolean(player.sourceGameId)), true)
  assert.equal(playerDirectory.players?.every((player) => Boolean(player.sourceFileName)), true)
  assert.equal(playerDirectory.players?.every((player) => Boolean(player.latestObservedAt)), true)
  assert.equal(proofPlayers.every((player) => player.sourceProvider === 'oracles-elixir'), true)
  assert.equal(proofPlayers.every((player) => Boolean(player.sourceGameId)), true)
  assert.equal(proofPlayers.every((player) => Boolean(player.sourceFileName)), true)
  assert.equal(proofPlayers.every((player) => Boolean(player.latestObservedAt)), true)
  assert.equal(playerDirectory.players?.some((player) => Number(player.impactDrivers?.awardResidualZ ?? 0) !== 0), false)
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
  assert.ok(summary.snapshots?.[defaultSnapshotKey])

  for (const [key, entry] of Object.entries(snapshotIndex)) {
    assert.equal(key, snapshotKeyFromFilter(entry.filter), `snapshot index key does not match its filter: ${key}`)
    assert.equal(entry.url, `/data/snapshots/${key}.json`, `snapshot index URL does not match its key: ${key}`)
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

  const unindexedShardFiles = (await listJsonFiles('public/data/snapshots'))
    .filter((file) => !indexedShardPaths.has(file))
    .map((file) => relative(process.cwd(), file))

  assert.deepEqual(unindexedShardFiles, [], 'generated snapshot shard files without snapshot index entries')
})

test('generated public artifacts share one model and generated-at provenance spine', async () => {
  const summary = parsePublicRankingManifest(await readJson('public/data/ranking-summary.json'))
  const players = parsePublicPlayerDirectory(await readJson('public/data/players.json'))
  const teamHistory = parsePublicTeamHistory(await readJson('public/data/team-history.json'))
  const snapshotIndex = summary.snapshotIndex ?? {}
  const defaultSnapshot = summary.defaultSnapshotKey ? summary.snapshots?.[summary.defaultSnapshotKey] : undefined
  const proof = summary.playerData?.ratingProof

  assert.ok(summary.generatedAt)
  assert.ok(summary.model?.version)
  assert.ok(summary.model?.configHash)
  assert.equal(summary.walkForward?.metrics?.modelVersion, summary.model.version)
  assert.equal(summary.walkForward?.metrics?.modelConfigHash, summary.model.configHash)
  assert.equal(proof?.modelVersion, summary.model.version)
  assert.equal(proof?.modelConfigHash, summary.model.configHash)
  assert.equal(defaultSnapshot?.modelVersion, summary.model.version)
  assert.equal(defaultSnapshot?.modelConfigHash, summary.model.configHash)

  for (const artifact of [players, teamHistory]) {
    assert.equal(artifact.generatedAt, summary.generatedAt, `${artifact.artifactKind} generatedAt differs from manifest`)
    assert.equal(artifact.modelVersion, summary.model.version, `${artifact.artifactKind} modelVersion differs from manifest`)
    assert.equal(artifact.modelConfigHash, summary.model.configHash, `${artifact.artifactKind} modelConfigHash differs from manifest`)
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
  const defaultSnapshot = summary.defaultSnapshotKey ? summary.snapshots?.[summary.defaultSnapshotKey] : undefined
  const measuredSources = (summary.sources ?? []).filter((source) => source.status === 'active' && typeof source.rowCount === 'number')

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
  return join('public', url.slice(1))
}

function sumSourceBreakdown(sourceBreakdown: SnapshotSourceBreakdown[] = []) {
  return sourceBreakdown.reduce((total, source) => total + (source.matchCount ?? 0), 0)
}

function standingComponent(standing: Record<string, unknown>, key: string) {
  return (standing.ratingComponents as Record<string, unknown> | undefined)?.[key]
}

function standingUpdate(standing: Record<string, unknown>, key: string) {
  return (standing.ratingUpdate as Record<string, unknown> | undefined)?.[key]
}

function providersFor(sourceBreakdown: SnapshotSourceBreakdown[] = []) {
  return sourceBreakdown.map((source) => source.provider).filter((provider): provider is string => Boolean(provider)).sort()
}
