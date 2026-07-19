import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  parsePublicPlayerDirectory,
  parsePublicRankingManifest,
  parsePublicRankingShard,
  parsePublicTeamHistoryIndex,
  parsePublicTeamHistoryShard,
  parsePublicTournamentMovementIndex,
  parsePublicTournamentMovementShard,
} from '../src/lib/publicArtifacts/schema.ts'
import { validatePublicArtifactBundle } from './materialize-ranking-data.ts'

export async function assertReleaseData(dataDir: string, { allowFixture = false } = {}) {
  const root = resolve(dataDir)
  const manifestPath = join(root, 'ranking-summary.json')
  try {
    const info = await stat(manifestPath)
    if (!info.isFile()) throw new Error('not a file')
  } catch (error) {
    throw new Error(`Release data is unavailable at ${root}. Materialize .generated/ranking-data before running test:release-data.`, { cause: error })
  }
  await validatePublicArtifactBundle(root)
  const read = async (relativePath: string) => JSON.parse(await readFile(join(root, relativePath), 'utf8')) as unknown
  const pathFor = (url: string | undefined) => {
    assert.ok(url?.startsWith('/data/'))
    return url.slice('/data/'.length).split('?', 1)[0]
  }
  const manifest = parsePublicRankingManifest(await read('ranking-summary.json'))
  const fixture = manifest.artifactMeta?.runId === 'fixture_public_artifacts_v1'
  if (fixture) {
    assert.equal(allowFixture, true, 'Deterministic fixture requires RANKING_RELEASE_DATA_ALLOW_FIXTURE=true')
    const players = parsePublicPlayerDirectory(await read(pathFor(manifest.playerDirectoryUrl)))
    assert.ok((manifest.coverage?.matchCount ?? 0) >= 20)
    assert.ok((players.players?.length ?? 0) > 0)
    assert.equal(manifest.coverage?.seededSample, false)
    return { profile: 'deterministic-fixture', runId: manifest.artifactMeta?.runId }
  }

  const defaultShard = parsePublicRankingShard(await read(pathFor(manifest.snapshotIndex[manifest.defaultSnapshotKey].url)))
  const region = (name: string) => {
    const value = defaultShard.regions.find((entry) => entry.region === name)
    assert.ok(value, `missing release region ${name}`)
    return value
  }
  const lck = region('LCK')
  const lpl = region('LPL')
  const lec = region('LEC')
  const lcs = region('LCS')
  assert.deepEqual(new Set(defaultShard.regions.map((entry) => entry.region)), new Set(['LCK', 'LPL', 'LEC', 'LCS', 'LCP', 'CBLOL']))
  assert.equal(defaultShard.regions.every((entry) => typeof entry.topThreeTeamRating === 'number' && typeof entry.totalTeamRating === 'number'), true)
  assert.ok(lpl.topThreeTeamRating >= lpl.totalTeamRating)
  assert.ok(Math.min(lck.score, lpl.score) - lec.score >= 35)
  assert.ok(Math.min(lck.score, lpl.score) > Math.max(lec.score, lcs.score))

  const seasonEntry = manifest.snapshotIndex['2026__All__All']
  assert.ok(seasonEntry, 'missing 2026 release scope')
  const season = parsePublicRankingShard(await read(pathFor(seasonEntry.url)))
  const seasonRegion = (name: string) => {
    const value = season.regions.find((entry) => entry.region === name)
    assert.ok(value, `missing 2026 release region ${name}`)
    return value
  }
  assert.ok(seasonRegion('LCK').topTeamRating - seasonRegion('LEC').topTeamRating >= 35)
  assert.ok(seasonRegion('LCS').topTeamRating >= seasonRegion('LCS').totalTeamRating)
  const standing = (team: string) => {
    const value = season.standings.find((entry) => entry.team === team)
    assert.ok(value, `missing release team ${team}`)
    return value
  }
  const lyon = standing('LYON')
  const drx = standing('Kiwoom DRX')
  const giantx = standing('GiantX')
  assert.equal(lyon.eligibility.eligible, true)
  assert.deepEqual([lyon.wins, lyon.losses], [20, 11])
  assert.deepEqual([drx.wins, drx.losses], [9, 20])
  assert.deepEqual([giantx.wins, giantx.losses], [15, 14])
  assert.equal(lyon.recentMatches.some((match) => match.opponent === 'Team Secret Whales' && match.result === 'W' && match.games === 3), true)
  assert.ok(lyon.rank < drx.rank && lyon.rank < giantx.rank)
  const t1 = standing('T1')
  const geng = standing('Gen.G')
  assert.deepEqual([t1.wins, t1.losses], [29, 10])
  assert.deepEqual([geng.wins, geng.losses], [27, 6])
  assert.equal(t1.recentMatches.some((match) => match.opponent === 'Bilibili Gaming' && match.result === 'L' && match.games === 5), true)
  assert.equal(t1.recentMatches.some((match) => match.opponent === 'Team Liquid' && match.result === 'W' && match.games === 3), true)
  assert.equal(t1.recentMatches.some((match) => match.opponent === 'G2 Esports' && match.result === 'L' && match.games === 4), true)
  assert.equal(geng.recentMatches.some((match) => match.opponent === 'T1' && match.result === 'L' && match.games === 5), true)
  assert.ok(geng.rank < t1.rank)

  const splitTwo = manifest.filterOptions.checkpoints?.['2026']?.find((entry) => entry.id === 'split-2')
  assert.equal(splitTwo?.boundaryEvent, '2026 Split 3 regional opening')
  const tournamentIndex = parsePublicTournamentMovementIndex(await read(pathFor(manifest.tournamentMovementIndexUrl)))
  const tournaments = new Map<string, ReturnType<typeof parsePublicTournamentMovementShard>>()
  for (const entry of tournamentIndex.tournaments) tournaments.set(entry.id, parsePublicTournamentMovementShard(await read(pathFor(entry.url))))
  assert.equal(tournaments.get('ewc:2026')?.startDate, '2026-07-15')
  assert.equal(tournaments.get('worlds:2025')?.startDate, '2025-10-14')
  assert.equal(tournaments.get('msi:2025')?.teams.some((team) => team.team === 'GAM Esports'), true)
  assert.equal(tournaments.get('ewc:2025')?.teams.some((team) => team.team === 'GAM Esports'), true)

  const historyIndex = parsePublicTeamHistoryIndex(await read(pathFor(manifest.teamHistoryIndexUrl)))
  const historyEntry = historyIndex.scopeIndex['2026__All__All']
  assert.ok(historyEntry)
  const history = parsePublicTeamHistoryShard(await read(pathFor(historyEntry.url)))
  const hle = standing('Hanwha Life Esports')
  const hleVsGenG = history.series[hle.teamId]?.points.filter((point) => point[0] === '2026-05-27' && point[3]?.opponent === 'Gen.G') ?? []
  assert.equal(hleVsGenG.length, 1)
  assert.deepEqual([hleVsGenG[0]?.[3]?.wins, hleVsGenG[0]?.[3]?.losses, hleVsGenG[0]?.[3]?.games, hleVsGenG[0]?.[3]?.bestOf], [1, 2, 3, 3])
  const scopedDates = Object.values(history.series).flatMap((series) => series.points.map((point) => point[0]))
  assert.ok(scopedDates.length > 0)
  assert.equal(scopedDates.every((date) => date.startsWith('2026-')), true)
  const disallowedSpotlightTeams = new Set(['Vitality Rising Bees', 'Vantex Esports'])
  for (const entry of Object.values(manifest.snapshotIndex)) {
    const shard = parsePublicRankingShard(await read(pathFor(entry.url)))
    assert.equal(shard.standings.some((row) => disallowedSpotlightTeams.has(row.team)), false)
  }
  const players = parsePublicPlayerDirectory(await read(pathFor(manifest.playerDirectoryUrl)))
  assert.equal((players.scopedPlayers?.['2025__All__All'] ?? []).some((player) => player.name === 'Viper' && player.team === 'Bilibili Gaming' && (player.teamGames ?? 0) < 20), false)
  return { profile: 'live-release', runId: manifest.artifactMeta?.runId }
}
