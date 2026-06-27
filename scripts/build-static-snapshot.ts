import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { knownTeamIdentities } from '../src/data/teamIdentity'
import { mergeCommunityMatchSources } from '../src/lib/importers/communitySources'
import { importLeaguepediaSnapshot } from '../src/lib/importers/leaguepedia'
import { importOraclesElixirCsv } from '../src/lib/importers/oraclesElixir'
import { createPlayerDirectory, createStaticRankingData, createStaticRankingSummaryData, createTeamHistory } from '../src/lib/snapshot'
import {
  parsePublicPlayerDirectory,
  parsePublicRankingManifest,
  parsePublicRankingShard,
  parsePublicTeamHistory,
  snapshotShardFileName,
  snapshotShardUrlPathForKey,
} from '../src/lib/publicArtifacts/schema'
import { deriveTeamProfilesFromMatches, mergeTeamProfiles } from '../src/lib/teamProfiles'

const output = resolve(readArg('output') ?? 'data/derived/ranking-snapshot.full.json')
const publicDataDir = resolve(readArg('public-data-dir') ?? 'public/data')
const manifestPath = readArg('manifest')
const manifest = manifestPath ? JSON.parse(await readFile(resolve(manifestPath), 'utf8')) as LocalDataManifest : undefined
const oracleCsvPaths = uniquePaths([...readArgList('oracle-csv'), ...(manifest?.files.oracleCsv ?? [])])
const leaguepediaJsonPaths = uniquePaths([...readArgList('leaguepedia-json'), ...(manifest?.files.leaguepediaJson ?? [])])
const oracleImports = []
const leaguepediaImports = []
const MAX_PUBLIC_SNAPSHOT_SHARDS = 1_000
const MAX_PUBLIC_DATA_BYTES = 50_000_000

if (process.argv.includes('--seeded-sample')) {
  throw new Error('Seeded sample generation has been removed from the production build path. Provide public source files or use tests/fixtures/rankingFixtures.ts for unit fixtures.')
}

for (const csvPath of oracleCsvPaths) {
  const csvText = await readFile(csvPath, 'utf8')
  oracleImports.push(importOraclesElixirCsv(csvText, { sourceFileName: basename(csvPath) }))
}

for (const jsonPath of leaguepediaJsonPaths) {
  const jsonText = await readFile(jsonPath, 'utf8')
  leaguepediaImports.push(importLeaguepediaSnapshot(JSON.parse(jsonText), { sourceFileName: basename(jsonPath) }))
}

const importedMatches = mergeCommunityMatchSources({
  oracleMatches: oracleImports.flatMap((result) => result.matches),
  leaguepediaMatches: leaguepediaImports.flatMap((result) => result.matches),
})
const importedTeams = mergeTeamProfiles([...leaguepediaImports.map((result) => result.teams), ...oracleImports.map((result) => result.teams)])
const matches = importedMatches
const mergedTeams = importedMatches.length > 0 ? { ...deriveTeamProfilesFromMatches(importedMatches, importedTeams), ...knownTeamIdentities } : {}
const snapshot = createStaticRankingData({
  matches,
  teams: mergedTeams,
  rosters: {},
  source: importedMatches.length > 0 ? describeCommunitySource(oracleImports.length, leaguepediaImports.length) : 'no public match data available',
  dataMode: importedMatches.length > 0 ? 'scheduled-public-data' : 'no-data',
  externalSources: [
    ...oracleImports.map((result) => ({
      name: result.source.fileName ? `Oracle's Elixir CSV: ${result.source.fileName}` : "Oracle's Elixir CSV",
      kind: 'game-stats' as const,
      url: result.source.url,
      retrievedAt: result.source.retrievedAt,
      coverageStart: dateRange(result.matches).start,
      coverageEnd: dateRange(result.matches).end,
      rowCount: result.matches.length,
      description: `${result.source.gameCount} normalized games imported from Oracle's Elixir. ${result.source.attribution}`,
      status: 'active' as const,
    })),
    ...leaguepediaImports.map((result) => ({
      name: result.source.fileName ? `Leaguepedia Cargo: ${result.source.fileName}` : 'Leaguepedia Cargo',
      kind: 'match-data' as const,
      url: result.source.url,
      retrievedAt: result.source.retrievedAt,
      coverageStart: dateRange(result.matches).start,
      coverageEnd: dateRange(result.matches).end,
      rowCount: result.matches.length,
      description: `${result.source.gameCount} normalized games imported from Leaguepedia Cargo for requested range ${result.source.start ?? 'unknown'} to ${result.source.end ?? 'unknown'}. ${result.source.attribution}`,
      status: 'active' as const,
    })),
  ],
})

await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`)
const summaryOutput = resolve(publicDataDir, 'ranking-summary.json')
const snapshotDir = resolve(publicDataDir, 'snapshots')
const summary = createStaticRankingSummaryData(snapshot, {
  playerDirectoryUrl: '/data/players.json',
  teamHistoryUrl: '/data/team-history.json',
  snapshotUrlForKey: snapshotShardUrlPathForKey,
})
const summarySnapshots = Object.entries(summary.snapshots)
const playerDirectory = createPlayerDirectory(snapshot)
const playerDirectoryOutput = resolve(publicDataDir, 'players.json')
const teamHistory = createTeamHistory(snapshot)
const teamHistoryOutput = resolve(publicDataDir, 'team-history.json')
const publicWrites = [
  {
    path: playerDirectoryOutput,
    contents: `${JSON.stringify(playerDirectory)}\n`,
    validate: (value: unknown) => parsePublicPlayerDirectory(value),
  },
  {
    path: teamHistoryOutput,
    contents: `${JSON.stringify(teamHistory)}\n`,
    validate: (value: unknown) => parsePublicTeamHistory(value),
  },
  ...summarySnapshots.map(([key, compactSnapshot]) => ({
    path: resolve(snapshotDir, snapshotShardFileName(key)),
    contents: `${JSON.stringify(compactSnapshot)}\n`,
    validate: (value: unknown) => parsePublicRankingShard(value),
  })),
  {
    path: summaryOutput,
    contents: `${JSON.stringify(summary.manifest, null, 2)}\n`,
    validate: (value: unknown) => parsePublicRankingManifest(value),
  },
]
const plannedPublicDataBytes = publicWrites.reduce((total, write) => total + Buffer.byteLength(write.contents), 0)
if (summarySnapshots.length > MAX_PUBLIC_SNAPSHOT_SHARDS) {
  throw new Error(`Public snapshot shard budget exceeded: ${summarySnapshots.length} > ${MAX_PUBLIC_SNAPSHOT_SHARDS}`)
}
if (plannedPublicDataBytes > MAX_PUBLIC_DATA_BYTES) {
  throw new Error(`Public data budget exceeded: ${plannedPublicDataBytes} bytes > ${MAX_PUBLIC_DATA_BYTES} bytes`)
}

for (const write of publicWrites) {
  write.validate(JSON.parse(write.contents))
}

await mkdir(snapshotDir, { recursive: true })
for (const write of publicWrites) {
  await atomicWriteFile(write.path, write.contents)
}
await removeStaleShardFiles(snapshotDir, new Set(summarySnapshots.map(([key]) => snapshotShardFileName(key))))

const publicDataBytes = await directorySize(publicDataDir)

console.log(`Wrote ${Object.keys(snapshot.snapshots).length} ranking snapshots to ${output}`)
console.log(`Wrote browser summary to ${summaryOutput}`)
console.log(`Wrote ${playerDirectory.ratedPlayerCount} player ratings to ${playerDirectoryOutput}`)
console.log(`Wrote ${teamHistory.pointCount} rating-history points for ${teamHistory.teamCount} teams to ${teamHistoryOutput}`)
console.log(`Public data budget: ${summarySnapshots.length} shards, ${publicDataBytes} bytes`)

function readArg(name: string) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function readArgList(name: string) {
  const values: string[] = []
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== `--${name}`) continue
    const next = process.argv[index + 1]
    if (!next || next.startsWith('--')) continue
    values.push(...next.split(',').map((value) => value.trim()).filter(Boolean))
  }
  return values
}

function uniquePaths(paths: string[]) {
  return Array.from(new Set(paths.filter(Boolean).map((path) => resolve(path))))
}

type LocalDataManifest = {
  files: {
    oracleCsv?: string[]
    leaguepediaJson?: string[]
  }
}

function describeCommunitySource(oracleCount: number, leaguepediaCount: number) {
  if (oracleCount > 0 && leaguepediaCount > 0) return "Oracle's Elixir primary with Leaguepedia Cargo gap-fill"
  if (oracleCount > 0) return "Oracle's Elixir CSV import"
  return 'Leaguepedia Cargo import'
}

function dateRange(matches: { date: string }[]) {
  const dates = matches.map((match) => match.date).filter(Boolean).sort()
  return {
    start: dates[0],
    end: dates.at(-1),
  }
}

async function directorySize(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true })
  let total = 0
  for (const entry of entries) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      total += await directorySize(path)
    } else if (entry.isFile()) {
      total += (await stat(path)).size
    }
  }
  return total
}

async function atomicWriteFile(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, contents)
  await rename(tempPath, path)
}

async function removeStaleShardFiles(directory: string, expectedFiles: Set<string>) {
  const entries = await readdir(directory, { withFileTypes: true })
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.endsWith('.json') || expectedFiles.has(entry.name)) return
    await rm(resolve(directory, entry.name))
  }))
}
