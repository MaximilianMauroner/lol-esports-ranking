import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  parsePublicRankingManifest,
  parsePublicRankingShard,
  snapshotKey,
  type SnapshotFilter,
} from '../src/lib/publicArtifacts/schema'
import { validatePublicSnapshotShard } from '../src/lib/publicArtifacts/resolver'
import { normalizeExternalRankingManifestUrl, resolvePublicArtifactUrl } from '../src/lib/publicArtifacts/url'

type JsonResponse = {
  status(code: number): JsonResponse
  json(value: unknown): void
  setHeader(name: string, value: string): void
}

type JsonRequest = {
  method?: string
  query?: Record<string, string | string[] | undefined>
}

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

export default async function handler(request: JsonRequest, response: JsonResponse) {
  if (request.method && request.method !== 'GET') {
    response.status(405).json({ ok: false, error: 'Method not allowed' })
    return
  }

  try {
    const manifest = parsePublicRankingManifest(await readPublicJson('ranking-summary.json'))
    const filter = filterForScope(firstQueryValue(request.query?.scope) ?? 'all')
    const key = snapshotKey(filter)
    const expected = manifest.snapshotIndex[key]
    if (!expected) {
      response.status(404).json({ ok: false, error: `No generated ranking scope exists for ${firstQueryValue(request.query?.scope) ?? 'all'}` })
      return
    }

    const shard = parsePublicRankingShard(await readPublicJsonFromUrl(expected.url))
    validatePublicSnapshotShard(key, expected, shard, manifest)

    const pageSize = clampInteger(firstQueryValue(request.query?.pageSize), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
    const total = shard.standings.length
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const page = clampInteger(firstQueryValue(request.query?.page), 1, 1, totalPages)
    const start = (page - 1) * pageSize

    response.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600')
    response.status(200).json({
      ok: true,
      scope: firstQueryValue(request.query?.scope) ?? 'all',
      filter,
      page,
      pageSize,
      total,
      totalPages,
      standings: shard.standings.slice(start, start + pageSize),
      artifactMeta: shard.artifactMeta ?? manifest.artifactMeta,
      provenance: {
        schemaVersion: manifest.schemaVersion,
        generatedAt: manifest.generatedAt,
        modelVersion: manifest.model.version,
        modelConfigHash: manifest.model.configHash,
        dataMode: manifest.dataMode,
        sourceBreakdown: shard.sourceBreakdown,
      },
    })
  } catch (error) {
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Unable to read generated ranking artifacts' })
  }
}

export function filterForScope(scope: string): SnapshotFilter {
  if (scope === 'all') return { season: 'All', event: 'All', region: 'All' }
  const checkpointScope = /^season:(\d{4}):(?:checkpoint:)?([A-Za-z0-9_-]+)$/.exec(scope)
  if (checkpointScope) return { season: checkpointScope[1], event: 'All', region: 'All', checkpoint: checkpointScope[2] }
  const checkpointSlug = /^season-(\d{4})-(split-[A-Za-z0-9_-]+)$/.exec(scope)
  if (checkpointSlug) return { season: checkpointSlug[1], event: 'All', region: 'All', checkpoint: checkpointSlug[2] }
  if (scope.startsWith('season-')) return { season: scope.slice('season-'.length), event: 'All', region: 'All' }
  if (scope.startsWith('season:')) return { season: scope.slice('season:'.length), event: 'All', region: 'All' }
  return { season: 'All', event: 'All', region: 'All' }
}

async function readPublicJson(relativePath: string) {
  const externalBase = process.env.RANKING_DATA_URL ?? process.env.VITE_RANKING_DATA_URL
  if (externalBase) {
    const manifestUrl = normalizeExternalRankingManifestUrl(externalBase)
    const artifactUrl = relativePath === 'ranking-summary.json'
      ? manifestUrl
      : resolvePublicArtifactUrl(`/data/${relativePath}`, manifestUrl)
    const response = await fetch(artifactUrl)
    if (!response.ok) throw new Error(`Artifact fetch failed with ${response.status}`)
    return response.json()
  }
  return JSON.parse(await readFile(resolve(process.cwd(), process.env.RANKING_PUBLIC_DATA_DIR ?? '.generated/ranking-data', relativePath), 'utf8'))
}

async function readPublicJsonFromUrl(url: string) {
  if (!url.startsWith('/data/')) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`Artifact fetch failed with ${response.status}`)
    return response.json()
  }
  const externalBase = process.env.RANKING_DATA_URL ?? process.env.VITE_RANKING_DATA_URL
  if (externalBase) {
    const artifactUrl = resolvePublicArtifactUrl(url, normalizeExternalRankingManifestUrl(externalBase))
    const response = await fetch(artifactUrl, { headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`Artifact fetch failed with ${response.status}`)
    return response.json()
  }
  return readPublicJson(localDataRelativePath(url))
}

function localDataRelativePath(url: string) {
  const path = url.split('?', 1)[0]
  return path.slice('/data/'.length)
}

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

function clampInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}
