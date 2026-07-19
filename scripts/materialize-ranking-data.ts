import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
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
} from '../src/lib/publicArtifacts/schema.ts'
import { replaceDirectory } from './replace-directory.ts'

export async function validatePublicArtifactBundle(sourceDir: string) {
  const root = resolve(sourceDir)
  const manifest = parsePublicRankingManifest(await readJson(resolve(root, 'ranking-summary.json')))
  const runId = manifest.artifactMeta?.runId
  if (!runId) throw new Error('Generated ranking manifest is missing exact run provenance')
  const spine = {
    runId,
    generatedAt: manifest.generatedAt,
    modelVersion: manifest.model.version,
    modelConfigHash: manifest.model.configHash,
  }
  const pending = ['ranking-summary.json']
  const visited = new Set<string>()
  while (pending.length > 0) {
    const relativePath = pending.shift()
    if (!relativePath || visited.has(relativePath)) continue
    const path = safeResolve(root, relativePath)
    let value: unknown
    try {
      const info = await stat(path)
      if (!info.isFile()) throw new Error('not a file')
      value = await readJson(path)
      parseArtifact(value)
      validateProvenance(value, spine, relativePath)
    } catch (error) {
      throw new Error(`Referenced ranking artifact is unavailable or invalid: ${relativePath}`, { cause: error })
    }
    visited.add(relativePath)
    for (const url of collectDataReferences(value)) {
      const referenced = relativePathFromDataUrl(url)
      if (!visited.has(referenced)) pending.push(referenced)
    }
  }
  return { manifest, relativePaths: [...visited].sort() }
}

export async function materializePublicArtifactBundle(sourceDir: string, destinationDir: string) {
  const source = resolve(sourceDir)
  const destination = resolve(destinationDir)
  const validated = await validatePublicArtifactBundle(source)
  const staged = `${destination}.materialized-${process.pid}-${Date.now()}`
  await rm(staged, { recursive: true, force: true })
  await mkdir(dirname(staged), { recursive: true })
  try {
    await cp(source, staged, { recursive: true, force: false, errorOnExist: false })
    await validatePublicArtifactBundle(staged)
    await replaceDirectory(staged, destination)
  } catch (error) {
    await rm(staged, { recursive: true, force: true })
    throw error
  }
  return validated
}

function parseArtifact(value: unknown) {
  const kind = record(value).artifactKind
  switch (kind) {
    case 'public-ranking-manifest': return parsePublicRankingManifest(value)
    case 'public-snapshot-shard': return parsePublicRankingShard(value)
    case 'player-directory': return parsePublicPlayerDirectory(value)
    case 'team-directory': return parsePublicTeamDirectory(value)
    case 'region-history': return parsePublicRegionHistory(value)
    case 'team-history-index': return parsePublicTeamHistoryIndex(value)
    case 'team-history-scope': return parsePublicTeamHistoryShard(value)
    case 'tournament-movement-index': return parsePublicTournamentMovementIndex(value)
    case 'tournament-movement': return parsePublicTournamentMovementShard(value)
    case 'match-history-index': return parsePublicMatchHistoryIndex(value)
    case 'match-history-catalog': return parsePublicMatchHistoryCatalog(value)
    case 'match-history-page': return parsePublicMatchHistoryPage(value)
    default: throw new Error(`Unknown public artifact kind: ${String(kind)}`)
  }
}

function validateProvenance(value: unknown, spine: { runId: string; generatedAt: string; modelVersion: string; modelConfigHash: string }, path: string) {
  const artifact = record(value)
  const meta = record(artifact.artifactMeta)
  const model = optionalRecord(artifact.model)
  const representations = {
    runId: [artifact.runId, meta.runId],
    generatedAt: [artifact.generatedAt, meta.generatedAt],
    modelVersion: [artifact.modelVersion, model.version, meta.modelVersion],
    modelConfigHash: [artifact.modelConfigHash, model.configHash, meta.modelConfigHash],
  }
  for (const key of ['runId', 'generatedAt', 'modelVersion', 'modelConfigHash'] as const) {
    const present = representations[key].filter((entry) => entry !== undefined)
    if (present.length === 0 || present.some((entry) => entry !== spine[key])) {
      throw new Error(`Public artifact provenance mismatch for ${path}: ${key}`)
    }
  }
}

function collectDataReferences(value: unknown) {
  const output = new Set<string>()
  const visit = (entry: unknown) => {
    if (Array.isArray(entry)) return entry.forEach(visit)
    if (!entry || typeof entry !== 'object') return
    for (const nested of Object.values(entry)) {
      if (typeof nested === 'string' && nested.startsWith('/data/')) output.add(nested)
      else visit(nested)
    }
  }
  visit(value)
  return output
}

function relativePathFromDataUrl(url: string) {
  const parsed = new URL(url, 'https://fixture.invalid')
  if (!parsed.pathname.startsWith('/data/')) throw new Error(`Unsupported public artifact URL: ${url}`)
  return parsed.pathname.slice('/data/'.length).split('/').map((segment) => {
    const decoded = decodeURIComponent(segment)
    if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) throw new Error(`Unsafe public artifact URL: ${url}`)
    return decoded
  }).join('/')
}

function safeResolve(root: string, relativePath: string) {
  if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')) throw new Error(`Invalid ranking artifact path: ${relativePath}`)
  const path = resolve(root, relativePath)
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`Ranking artifact escapes source directory: ${relativePath}`)
  return path
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Public artifact must be an object')
  return value as Record<string, unknown>
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sourceDir = resolve(process.env.RANKING_GENERATED_DATA_DIR ?? '.generated/ranking-data')
  const destinationDir = resolve(process.env.RANKING_STATIC_DATA_DIR ?? 'public/data')
  const result = await materializePublicArtifactBundle(sourceDir, destinationDir)
  console.log(`Materialized ${result.relativePaths.length} validated ranking artifacts from ${sourceDir} to ${destinationDir}`)
}
