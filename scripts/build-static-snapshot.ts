import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { manifestWithResolvedFiles } from './local-data-manifest.js'
import { knownTeamIdentities } from '../src/data/teamIdentity'
import { mergeCommunityMatchSources } from '../src/lib/importers/communitySources'
import { importLeaguepediaSnapshot } from '../src/lib/importers/leaguepedia'
import { importLolEsportsScheduleSnapshot } from '../src/lib/importers/lolEsports'
import { importOraclesElixirCsv } from '../src/lib/importers/oraclesElixir'
import { createStaticRankingData, type DataSourceWarning } from '../src/lib/snapshot'
import { createPublicArtifactWritePlan, publicScopeArtifactPath, PUBLIC_ARTIFACT_PATHS } from '../src/lib/publicArtifacts/writePlan'
import { filterPublishedRatingUniverseInput, filterPublishedRatingUniverseMatches } from '../src/lib/ratingUniverse'
import { deriveTeamProfilesFromMatches, mergeTeamProfiles } from '../src/lib/teamProfiles'

const output = resolve(readArg('output') ?? 'data/derived/ranking-snapshot.full.json')
const publicDataDir = resolve(readArg('public-data-dir') ?? 'public/data')
const manifestPath = readArg('manifest')
const resolvedManifestPath = manifestPath ? resolve(manifestPath) : undefined
const manifest = resolvedManifestPath
  ? manifestWithResolvedFiles(JSON.parse(await readFile(resolvedManifestPath, 'utf8')) as LocalDataManifest, dirname(resolvedManifestPath)) as LocalDataManifest
  : undefined
const oracleCsvPaths = uniquePaths([...readArgList('oracle-csv'), ...(manifest?.files.oracleCsv ?? [])])
const leaguepediaJsonPaths = uniquePaths([...readArgList('leaguepedia-json'), ...(manifest?.files.leaguepediaJson ?? [])])
const lolEsportsJsonPaths = uniquePaths([...readArgList('lolesports-json'), ...(manifest?.files.lolEsportsJson ?? [])])
const oracleImports = []
const leaguepediaImports = []
const lolEsportsImports = []
const oracleWarnings = manifestSourceWarnings('oracle', manifest?.warnings)
const leaguepediaWarnings = manifestSourceWarnings('leaguepedia', manifest?.warnings)
const lolEsportsWarnings = manifestSourceWarnings('lolesports', manifest?.warnings)

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

for (const jsonPath of lolEsportsJsonPaths) {
  const jsonText = await readFile(jsonPath, 'utf8')
  lolEsportsImports.push(importLolEsportsScheduleSnapshot(JSON.parse(jsonText), { sourceFileName: basename(jsonPath) }))
}

const importedMatches = mergeCommunityMatchSources({
  oracleMatches: oracleImports.flatMap((result) => result.matches),
  leaguepediaMatches: leaguepediaImports.flatMap((result) => result.matches),
  lolEsportsReferences: lolEsportsImports.flatMap((result) => result.events),
})
const importedTeams = mergeTeamProfiles([...leaguepediaImports.map((result) => result.teams), ...oracleImports.map((result) => result.teams)])
const mergedTeams = importedMatches.length > 0 ? { ...deriveTeamProfilesFromMatches(importedMatches, importedTeams), ...knownTeamIdentities } : {}
const ratingUniverse = filterPublishedRatingUniverseInput(importedMatches, mergedTeams)
const matches = ratingUniverse.matches
const teams = ratingUniverse.teams
const snapshot = createStaticRankingData({
  matches,
  teams,
  rosters: {},
  source: matches.length > 0
    ? describeCommunitySource(oracleImports.length, leaguepediaImports.length)
    : importedMatches.length > 0 ? 'no rated public match data available for published team universe' : 'no public match data available',
  dataMode: matches.length > 0 ? 'scheduled-public-data' : 'no-data',
  externalSources: [
    ...lolEsportsImports.map((result) => ({
      name: result.source.fileName ? `LoL Esports schedule API: ${result.source.fileName}` : 'LoL Esports schedule API',
      kind: 'official-reference' as const,
      url: result.source.url,
      retrievedAt: result.source.retrievedAt,
      coverageStart: dateRange(result.events).start,
      coverageEnd: dateRange(result.events).end,
      rowCount: result.source.eventCount,
      description: `${result.source.eventCount} schedule/result events and ${result.source.gameCount} game IDs cached from LoL Esports persisted APIs. Used only to attach official event/match/game IDs and audit schedule/results; not a rich stat source or standalone model input. ${result.source.attribution}`,
      status: result.source.eventCount > 0 ? 'active' as const : 'reference-only' as const,
      warnings: [
        {
          kind: 'source-policy' as const,
          severity: 'warning' as const,
          message: 'LoL Esports persisted APIs are public site endpoints, not a supported official data API; cache responses and keep them reference-only.',
        },
        ...lolEsportsWarnings,
      ],
      ...(sourceRefreshReceipt('lolesports', manifest) ? { refreshReceipt: sourceRefreshReceipt('lolesports', manifest) } : {}),
    })),
    ...oracleImports.map((result) => {
      const ratedMatches = filterPublishedRatingUniverseMatches(result.matches, mergedTeams)
      return {
        name: result.source.fileName ? `Oracle's Elixir CSV: ${result.source.fileName}` : "Oracle's Elixir CSV",
        kind: 'game-stats' as const,
        url: result.source.url,
        retrievedAt: result.source.retrievedAt,
        coverageStart: dateRange(ratedMatches).start,
        coverageEnd: dateRange(ratedMatches).end,
        rowCount: ratedMatches.length,
        description: `${ratedMatches.length} rated games retained from ${result.source.gameCount} Oracle's Elixir imports after the published team-universe filter. ${result.source.attribution}`,
        status: ratedMatches.length > 0 ? 'active' as const : 'reference-only' as const,
        ...(oracleWarnings.length > 0 ? { warnings: oracleWarnings } : {}),
        ...(sourceRefreshReceipt('oracle', manifest) ? { refreshReceipt: sourceRefreshReceipt('oracle', manifest) } : {}),
      }
    }),
    ...leaguepediaImports.map((result) => {
      const ratedMatches = filterPublishedRatingUniverseMatches(result.matches, mergedTeams)
      return {
        name: result.source.fileName ? `Leaguepedia Cargo: ${result.source.fileName}` : 'Leaguepedia Cargo',
        kind: 'match-data' as const,
        url: result.source.url,
        retrievedAt: result.source.retrievedAt,
        coverageStart: dateRange(ratedMatches).start,
        coverageEnd: dateRange(ratedMatches).end,
        rowCount: ratedMatches.length,
        description: `${ratedMatches.length} rated games retained from ${result.source.gameCount} Leaguepedia Cargo imports for requested range ${result.source.start ?? 'unknown'} to ${result.source.end ?? 'unknown'} after the published team-universe filter. ${result.source.attribution}`,
        status: ratedMatches.length > 0 ? 'active' as const : 'reference-only' as const,
        ...(leaguepediaWarnings.length > 0 ? { warnings: leaguepediaWarnings } : {}),
        ...(sourceRefreshReceipt('leaguepedia', manifest) ? { refreshReceipt: sourceRefreshReceipt('leaguepedia', manifest) } : {}),
      }
    }),
  ],
  tournamentScheduleReferences: lolEsportsImports.flatMap((result) => {
    const coverage = dateRange(result.events)
    return result.events.map((event) => ({
      matchId: event.matchId,
      tournamentId: event.tournamentId,
      leagueName: event.leagueName,
      leagueSlug: event.leagueSlug,
      startTime: event.startTime,
      date: event.date,
      state: event.state,
      retrievedAt: result.source.retrievedAt,
      coverageStart: coverage.start,
      coverageEnd: coverage.end,
      coverageEndComplete: result.source.coverageEndComplete,
    }))
  }),
  pipelineAudit: { importedMatchCount: importedMatches.length },
})

await mkdir(dirname(output), { recursive: true })
await writeJsonFile(output, snapshot)
const publicPlan = createPublicArtifactWritePlan(snapshot)
const summaryOutput = resolve(publicDataDir, PUBLIC_ARTIFACT_PATHS.manifest)
const summarySnapshots = Object.entries(publicPlan.snapshots)
const publicWrites = publicPlan.writes.map((entry) => ({
  path: resolve(publicDataDir, entry.relativePath),
  contents: entry.contents,
  validate: entry.validate,
}))

for (const write of publicWrites) {
  write.validate(JSON.parse(write.contents))
}

await rm(resolve(publicDataDir, PUBLIC_ARTIFACT_PATHS.teamHistoryShardDir), { recursive: true, force: true })
await rm(resolve(publicDataDir, PUBLIC_ARTIFACT_PATHS.tournamentMovementShardDir), { recursive: true, force: true })
await rm(resolve(publicDataDir, PUBLIC_ARTIFACT_PATHS.teamHistory), { force: true })

for (const write of publicWrites) {
  await atomicWriteFile(write.path, write.contents)
}
await removeStaleShardFiles(resolve(publicDataDir, PUBLIC_ARTIFACT_PATHS.scopeDir), new Set(summarySnapshots.map(([key]) => publicScopeArtifactPath(key).split('/').at(-1)!)))
await rm(resolve(publicDataDir, 'snapshots'), { recursive: true, force: true })
await rm(resolve(publicDataDir, 'team-history'), { recursive: true, force: true })
await rm(resolve(publicDataDir, 'players.json'), { force: true })
await rm(resolve(publicDataDir, 'region-history.json'), { force: true })
await rm(resolve(publicDataDir, 'team-history.json'), { force: true })

const publicDataBytes = await directorySize(publicDataDir)

console.log(`Wrote ${Object.keys(snapshot.snapshots).length} ranking snapshots to ${output}`)
console.log(`Wrote browser summary to ${summaryOutput}`)
console.log(`Wrote ${summarySnapshots.length} public ranking scopes to ${resolve(publicDataDir, PUBLIC_ARTIFACT_PATHS.scopeDir)}`)
console.log(`Public data budget: ${publicDataBytes} bytes`)

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
  start?: string
  end?: string
  generatedAt?: string
  files: {
    oracleCsv?: string[]
    leaguepediaJson?: string[]
    lolEsportsJson?: string[]
  }
  warnings?: string[]
  sources?: Partial<Record<'oracle' | 'leaguepedia' | 'lolesports', {
    status?: string
    downloadedCount?: number
    reusedCount?: number
    failedCount?: number
  }>>
}

function sourceRefreshReceipt(provider: 'oracle' | 'leaguepedia' | 'lolesports', value: LocalDataManifest | undefined) {
  const source = value?.sources?.[provider]
  if (!source?.status) return undefined
  return {
    requestedStart: value?.start,
    requestedEnd: value?.end,
    attemptedAt: value?.generatedAt,
    status: source.status,
    downloadedCount: source.downloadedCount ?? 0,
    reusedCount: source.reusedCount ?? 0,
    failedCount: source.failedCount ?? 0,
  }
}

function manifestSourceWarnings(provider: 'oracle' | 'leaguepedia' | 'lolesports', warnings: string[] | undefined): DataSourceWarning[] {
  return (warnings ?? [])
    .filter((warning) => warningMatchesProvider(provider, warning))
    .map((message) => ({
      kind: sourceWarningKind(message),
      severity: sourceWarningSeverity(message),
      message,
    }))
}

function warningMatchesProvider(provider: 'oracle' | 'leaguepedia' | 'lolesports', warning: string) {
  const lower = warning.toLowerCase()
  if (provider === 'oracle') return lower.includes('oracle')
  if (provider === 'lolesports') return lower.includes('lol esports') || lower.includes('lolesports')
  return lower.includes('leaguepedia') || lower.includes('cargo')
}

function sourceWarningKind(message: string): DataSourceWarning['kind'] {
  const lower = message.toLowerCase()
  if (lower.includes('rate-limit')) return 'rate-limit'
  if (lower.includes('download')) return 'download'
  if (lower.includes('coverage') || lower.includes('through') || lower.includes('preserved')) return 'coverage'
  return 'source-policy'
}

function sourceWarningSeverity(message: string): DataSourceWarning['severity'] {
  const lower = message.toLowerCase()
  if (lower.includes('failed') || lower.includes('unavailable')) return 'error'
  if (lower.includes('rate-limit') || lower.includes('preserved')) return 'warning'
  return 'info'
}

function describeCommunitySource(oracleCount: number, leaguepediaCount: number) {
  if (oracleCount > 0 && leaguepediaCount > 0) return "Oracle's Elixir primary with Leaguepedia Cargo gap-fill"
  if (oracleCount > 0) return "Oracle's Elixir CSV import"
  return 'Leaguepedia Cargo import'
}

function dateRange(matches: { date?: string }[]) {
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

async function writeJsonFile(path: string, value: unknown) {
  const stream = createWriteStream(path, { encoding: 'utf8' })

  async function writeChunk(chunk: string) {
    if (!stream.write(chunk)) await once(stream, 'drain')
  }

  try {
    await writeJsonValue(writeChunk, value, 0, false)
    await writeChunk('\n')
    stream.end()
    await once(stream, 'finish')
  } catch (error) {
    stream.destroy()
    throw error
  }
}

async function writeJsonValue(
  writeChunk: (chunk: string) => Promise<void>,
  value: unknown,
  depth: number,
  inArray: boolean,
) {
  if (typeof value === 'object' && value !== null && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    value = (value as { toJSON: () => unknown }).toJSON()
  }

  if (value === null || typeof value !== 'object') {
    await writeChunk(JSON.stringify(value) ?? (inArray ? 'null' : 'null'))
    return
  }

  if (Array.isArray(value)) {
    await writeChunk('[')
    for (let index = 0; index < value.length; index += 1) {
      await writeChunk(`${index === 0 ? '\n' : ',\n'}${indent(depth + 1)}`)
      await writeJsonValue(writeChunk, value[index] ?? null, depth + 1, true)
    }
    if (value.length > 0) await writeChunk(`\n${indent(depth)}`)
    await writeChunk(']')
    return
  }

  const entries = Object.entries(value).filter(([, entryValue]) => {
    return entryValue !== undefined && typeof entryValue !== 'function' && typeof entryValue !== 'symbol'
  })
  await writeChunk('{')
  for (let index = 0; index < entries.length; index += 1) {
    const [key, entryValue] = entries[index]
    await writeChunk(`${index === 0 ? '\n' : ',\n'}${indent(depth + 1)}${JSON.stringify(key)}: `)
    await writeJsonValue(writeChunk, entryValue, depth + 1, false)
  }
  if (entries.length > 0) await writeChunk(`\n${indent(depth)}`)
  await writeChunk('}')
}

function indent(depth: number) {
  return '  '.repeat(depth)
}

async function removeStaleShardFiles(directory: string, expectedFiles: Set<string>) {
  const entries = await readdir(directory, { withFileTypes: true })
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.endsWith('.json') || expectedFiles.has(entry.name)) return
    await rm(resolve(directory, entry.name))
  }))
}
