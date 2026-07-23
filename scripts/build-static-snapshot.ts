import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { replaceDirectory } from './replace-directory.ts'
import { createStaticRankingData, type PlayerLifecycleEvent, type PlayerLifecycleReleaseEvent } from '../src/lib/snapshot'
import type { RankingModelOutput } from '../src/lib/model'
import type { MatchRecord } from '../src/types'
import type { TournamentInstanceId } from '../src/lib/internationalTournaments'
import { createPublicArtifactWritePlan, PUBLIC_ARTIFACT_PATHS } from '../src/lib/publicArtifacts/writePlan'
import { resolveCanonicalSeries } from '../src/lib/seriesResolver'
import { appendRefreshStages, createRefreshMetrics } from './refresh-metrics.mjs'
import { importRankingSourceData, type RankingSourceImport } from './ranking-source-import.ts'
import { collectRefreshGarbage } from './refresh-worker-memory.mjs'

export type StaticSnapshotBuildOptions = {
  output?: string
  publicDataDir?: string
  reconciliationOutput?: string
  manifestPath?: string
  oracleCsvPaths?: string[]
  leaguepediaJsonPaths?: string[]
  lolEsportsJsonPaths?: string[]
  generatedAt?: string
  precomputedGlobalRanking?: RankingModelOutput
  affectedLogicalPaths?: ReadonlySet<string>
  affectedSnapshotKeys?: ReadonlySet<string>
  affectedTournamentIds?: ReadonlySet<TournamentInstanceId>
  previousArtifacts?: Readonly<Record<string, unknown>>
  writeFullSnapshot?: boolean
  replacePublicDirectory?: boolean
  env?: NodeJS.ProcessEnv
  sourceData?: RankingSourceImport
  importedMatchCount?: number
  releaseImportAuditBeforeSnapshot?: boolean
  compactPlayerDirectory?: boolean
  silent?: boolean
}

export type FullSnapshotDescriptor = {
  artifactKind: 'full-ranking-artifact'
  schemaVersion: number
  generatedAt: string
  source: string
  sources: Array<{ name: string }>
  model: { version: string; configHash: string }
  sha256: string
  bytes: number
}

export async function buildStaticSnapshot(options: StaticSnapshotBuildOptions = {}) {
const env = options.env ?? process.env
const metrics = createRefreshMetrics({
  runId: env.RANKING_REFRESH_RUN_ID ?? `snapshot-${process.pid}`,
  mode: env.RANKING_REFRESH_MODE === 'shadow' ? 'shadow' : 'gated',
  cause: env.RANKING_FORCE_REFRESH === 'true' ? 'manual-force' : 'pending-match',
})

const output = resolve(options.output ?? 'data/derived/ranking-snapshot.full.json')
const publicDataTargetDir = resolve(options.publicDataDir ?? 'public/data')
const reconciliationOutput = options.reconciliationOutput ? resolve(options.reconciliationOutput) : undefined
const publicDataDir = `${publicDataTargetDir}.next-${process.pid}-${Date.now()}`
const sourceData = options.sourceData ?? await importRankingSourceData({
  manifestPath: options.manifestPath,
  oracleCsvPaths: options.oracleCsvPaths,
  leaguepediaJsonPaths: options.leaguepediaJsonPaths,
  lolEsportsJsonPaths: options.lolEsportsJsonPaths,
})
const { importedMatches, matches, teams } = sourceData
const importedMatchCount = options.importedMatchCount ?? importedMatches.length
const generatedAt = options.generatedAt ?? new Date().toISOString()
const playerLifecycleEvents: Array<PlayerLifecycleEvent & { rssBytes: number }> = []
const playerReleaseCollections: Array<PlayerLifecycleReleaseEvent & ReturnType<typeof collectRefreshGarbage>> = []
if (reconciliationOutput) await writeReconciliationOutput({ reconciliationOutput, importedMatches, generatedAt })
if (options.releaseImportAuditBeforeSnapshot) {
  if (importedMatches !== matches) importedMatches.length = 0
  sourceData.mergedTeams = {}
}
const snapshot = createStaticRankingData({
  matches,
  teams,
  rosters: {},
  source: sourceData.source,
  dataMode: sourceData.dataMode,
  externalSources: sourceData.externalSources,
  tournamentScheduleReferences: sourceData.tournamentScheduleReferences,
  pipelineAudit: { importedMatchCount },
  generatedAt,
  ...(options.precomputedGlobalRanking ? { precomputedGlobalRanking: options.precomputedGlobalRanking } : {}),
  ...(options.affectedSnapshotKeys ? { materializeSnapshotKeys: options.affectedSnapshotKeys } : {}),
  ...(options.affectedTournamentIds ? { materializeTournamentIds: options.affectedTournamentIds } : {}),
  compactPlayerDirectory: options.compactPlayerDirectory ?? options.writeFullSnapshot === false,
  onPlayerLifecycleStage: (event) => {
    playerLifecycleEvents.push({
      ...event,
      rssBytes: Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024),
    })
  },
  onPlayerLifecycleRelease: (event) => {
    playerReleaseCollections.push({ ...event, ...collectRefreshGarbage() })
  },
})

const playerLifecycleStages = (['player-build', 'player-compaction'] as const).flatMap((name) => {
  const events = playerLifecycleEvents.filter((event) => event.name === name)
  if (events.length === 0) return []
  return [{
    name,
    durationMs: events.reduce((total, event) => total + event.durationMs, 0),
    input: { operationCount: events.length },
    output: {
      peakRssBytes: Math.max(...events.map((event) => event.rssBytes)),
      maxPlayerCount: Math.max(...events.map((event) => event.playerCount)),
      scopes: events.map(({ scope, scopeKey, durationMs, playerCount, rssBytes }) => ({
        scope,
        scopeKey,
        durationMs,
        playerCount,
        rssBytes,
      })),
      ...(name === 'player-compaction' ? { releaseCollections: playerReleaseCollections } : {}),
    },
  }]
})
for (const stage of playerLifecycleStages) {
  metrics.recordStage(stage.name, stage)
}

let fullSnapshotDescriptor: FullSnapshotDescriptor | undefined
if (options.writeFullSnapshot !== false) {
  await mkdir(dirname(output), { recursive: true })
  const written = await writeJsonFile(output, snapshot)
  fullSnapshotDescriptor = {
    artifactKind: snapshot.artifactKind,
    schemaVersion: snapshot.schemaVersion,
    generatedAt: snapshot.generatedAt,
    source: snapshot.source,
    sources: snapshot.sources.map(({ name }) => ({ name })),
    model: { version: snapshot.model.version, configHash: snapshot.model.configHash },
    sha256: written.sha256,
    bytes: written.bytes,
  }
}
const serializationFinished = metrics.startStage('public-serialization', {
  importedGameCount: importedMatchCount,
  ratedGameCount: matches.length,
})
const publicPlan = createPublicArtifactWritePlan(snapshot, {
  ...(options.affectedLogicalPaths ? { affectedLogicalPaths: options.affectedLogicalPaths } : {}),
  ...(options.previousArtifacts ? { previousArtifacts: options.previousArtifacts } : {}),
})
const summaryOutput = resolve(publicDataTargetDir, PUBLIC_ARTIFACT_PATHS.manifest)
const summarySnapshots = Object.entries(publicPlan.snapshots)
const publicWrites = publicPlan.writes.map((entry) => ({
  path: resolve(publicDataDir, entry.relativePath),
  contents: entry.contents,
  validate: entry.validate,
}))

await rm(publicDataDir, { recursive: true, force: true })
try {
  for (const write of publicWrites) {
    write.validate(JSON.parse(write.contents))
  }
  for (const write of publicWrites) {
    await atomicWriteFile(write.path, write.contents)
  }

  if (options.replacePublicDirectory !== false) {
    await replaceDirectory(publicDataDir, publicDataTargetDir, { publishLast: PUBLIC_ARTIFACT_PATHS.manifest })
  } else {
    await rm(publicDataTargetDir, { recursive: true, force: true })
    await rename(publicDataDir, publicDataTargetDir)
  }
  const publicDataBytes = await directorySize(publicDataTargetDir)
  serializationFinished('completed', {
    importedGameCount: importedMatchCount,
    ratedGameCount: matches.length,
    artifactCount: publicWrites.length,
    outputBytes: publicDataBytes,
  })
  await appendRefreshStages(env.RANKING_REFRESH_METRICS_PATH, metrics.snapshot({ result: 'running' }))

  if (!options.silent) {
    console.log(`${options.writeFullSnapshot === false ? 'Materialized' : 'Wrote'} ${Object.keys(snapshot.snapshots).length} ranking snapshots${options.writeFullSnapshot === false ? '' : ` to ${output}`}`)
    console.log(`Wrote browser summary to ${summaryOutput}`)
    console.log(`Wrote ${summarySnapshots.length} public ranking scopes to ${resolve(publicDataTargetDir, PUBLIC_ARTIFACT_PATHS.scopeDir)}`)
    console.log(`Public data budget: ${publicDataBytes} bytes`)
  }
  const result = { publicPlan, publicDataBytes, publicDataDir: publicDataTargetDir, playerLifecycleStages }
  if (options.writeFullSnapshot === false) {
    for (const write of publicPlan.writes) write.contents = ''
    return result
  }
  return { snapshot, fullSnapshotDescriptor, ...result, ...sourceData }
} catch (error) {
  await rm(publicDataDir, { recursive: true, force: true })
  throw error
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--seeded-sample')) {
    throw new Error('Seeded sample generation has been removed from the production build path. Provide public source files or use tests/fixtures/rankingFixtures.ts for unit fixtures.')
  }
  await buildStaticSnapshot({
    output: readArg('output'),
    publicDataDir: readArg('public-data-dir'),
    reconciliationOutput: readArg('reconciliation-output'),
    manifestPath: readArg('manifest'),
    oracleCsvPaths: readArgList('oracle-csv'),
    leaguepediaJsonPaths: readArgList('leaguepedia-json'),
    lolEsportsJsonPaths: readArgList('lolesports-json'),
  })
}

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

export async function writeReconciliationOutput({
  reconciliationOutput,
  importedMatches,
  generatedAt,
}: {
  reconciliationOutput: string
  importedMatches: MatchRecord[]
  generatedAt: string
}) {
  const matches = reconciliationEntries(importedMatches)
  await atomicWriteFile(reconciliationOutput, `${JSON.stringify({ schemaVersion: 1, generatedAt, matches }, null, 2)}\n`)
  return matches
}

function reconciliationEntries(importedMatches: MatchRecord[]) {
  return resolveCanonicalSeries(importedMatches).flatMap((series) => {
    const officialIds = [...new Set(series.games.map((game) => game.officialMatchId).filter((value): value is string => Boolean(value)))]
    if (officialIds.length !== 1) return []
    return [{
      matchId: officialIds[0],
      status: series.state === 'completed' ? 'exact' : 'unresolved',
      canonicalSeriesId: series.id,
      scoredGameIds: series.games.map((game) => game.officialGameId ?? game.sourceGameId ?? game.id),
    }]
  })
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
  const hash = createHash('sha256')
  let bytes = 0

  async function writeChunk(chunk: string) {
    hash.update(chunk)
    bytes += Buffer.byteLength(chunk)
    if (!stream.write(chunk)) await once(stream, 'drain')
  }

  try {
    await writeJsonValue(writeChunk, value, 0, false)
    await writeChunk('\n')
    stream.end()
    await once(stream, 'finish')
    return { sha256: hash.digest('hex'), bytes }
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
