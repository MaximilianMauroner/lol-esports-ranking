import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { rosters, sampleMatches, teams } from '../src/data/sampleData'
import { mergeCommunityMatchSources } from '../src/lib/importers/communitySources'
import { importLeaguepediaSnapshot } from '../src/lib/importers/leaguepedia'
import { importOraclesElixirCsv } from '../src/lib/importers/oraclesElixir'
import { createStaticRankingData } from '../src/lib/snapshot'

const output = resolve(readArg('output') ?? 'public/data/ranking-snapshot.json')
const manifestPath = readArg('manifest')
const manifest = manifestPath ? JSON.parse(await readFile(resolve(manifestPath), 'utf8')) as LocalDataManifest : undefined
const oracleCsvPaths = uniquePaths([...readArgList('oracle-csv'), ...(manifest?.files.oracleCsv ?? [])])
const leaguepediaJsonPaths = uniquePaths([...readArgList('leaguepedia-json'), ...(manifest?.files.leaguepediaJson ?? [])])
const useSeededSample = process.argv.includes('--seeded-sample')
const oracleImports = []
const leaguepediaImports = []

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
const importedTeams = Object.assign({}, ...leaguepediaImports.map((result) => result.teams), ...oracleImports.map((result) => result.teams))
const matches = importedMatches.length > 0 ? importedMatches : useSeededSample ? sampleMatches : []
const mergedTeams = importedMatches.length > 0 ? { ...importedTeams, ...teams } : useSeededSample ? teams : {}
const mergedRosters = matches.length > 0 ? rosters : {}
const snapshot = createStaticRankingData({
  matches,
  teams: mergedTeams,
  rosters: mergedRosters,
  source: importedMatches.length > 0 ? describeCommunitySource(oracleImports.length, leaguepediaImports.length) : useSeededSample ? 'seeded sample data generated at build time' : 'no public match data available',
  dataMode: importedMatches.length > 0 ? 'scheduled-public-data' : useSeededSample ? 'seeded-sample' : 'no-data',
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
      coverageStart: result.source.start ?? dateRange(result.matches).start,
      coverageEnd: result.source.end ?? dateRange(result.matches).end,
      rowCount: result.matches.length,
      description: `${result.source.gameCount} normalized games imported from Leaguepedia Cargo. ${result.source.attribution}`,
      status: 'active' as const,
    })),
  ],
})

await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`)

console.log(`Wrote ${Object.keys(snapshot.snapshots).length} ranking snapshots to ${output}`)

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
