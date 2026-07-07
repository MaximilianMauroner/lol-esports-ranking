import { put } from '@vercel/blob'
import { knownTeamIdentities } from '../src/data/teamIdentity'
import { mergeCommunityMatchSources } from '../src/lib/importers/communitySources'
import { importLeaguepediaSnapshot, type LeaguepediaSnapshot } from '../src/lib/importers/leaguepedia'
import { importOraclesElixirCsv } from '../src/lib/importers/oraclesElixir'
import { createStaticRankingData } from '../src/lib/snapshot'
import { createPublicArtifactWritePlan, PUBLIC_ARTIFACT_PATHS } from '../src/lib/publicArtifacts/writePlan'
import { filterPublishedRatingUniverseInput, filterPublishedRatingUniverseMatches } from '../src/lib/ratingUniverse'
import { deriveTeamProfilesFromMatches, mergeTeamProfiles } from '../src/lib/teamProfiles'
import type { MatchRecord } from '../src/types'

type JsonResponse = {
  status(code: number): JsonResponse
  json(value: unknown): void
  setHeader(name: string, value: string): void
}

type JsonRequest = {
  method?: string
  headers: {
    authorization?: string
    'user-agent'?: string
  }
}

export const config = {
  maxDuration: 60,
}

export default async function handler(request: JsonRequest, response: JsonResponse) {
  if (request.method && !['GET', 'POST'].includes(request.method)) {
    response.status(405).json({ ok: false, error: 'Method not allowed' })
    return
  }

  const secret = process.env.CRON_SECRET
  const authorization = request.headers.authorization

  if (!isAuthorizedCronRequest(authorization, secret)) {
    response.status(401).json({ ok: false, error: 'Unauthorized' })
    return
  }

  const oracleCsvUrl = process.env.ORACLES_ELIXIR_CSV_URL
  const leaguepediaJsonUrl = process.env.LEAGUEPEDIA_MATCHES_JSON_URL
  const oracleImport = oracleCsvUrl ? await fetchOracleCsv(oracleCsvUrl) : null
  const leaguepediaImport = leaguepediaJsonUrl ? await fetchLeaguepediaJson(leaguepediaJsonUrl) : null
  const importedMatches = mergeCommunityMatchSources({
    oracleMatches: oracleImport?.matches ?? [],
    leaguepediaMatches: leaguepediaImport?.matches ?? [],
  })

  const importedTeams = mergeTeamProfiles([leaguepediaImport?.teams ?? {}, oracleImport?.teams ?? {}])
  const mergedTeams = importedMatches.length ? { ...deriveTeamProfilesFromMatches(importedMatches, importedTeams), ...knownTeamIdentities } : {}
  const ratingUniverse = filterPublishedRatingUniverseInput(importedMatches, mergedTeams)
  const matches = ratingUniverse.matches
  const teams = ratingUniverse.teams
  const dataMode = matches.length ? 'scheduled-public-data' : 'no-data'
  const oracleRatedMatches = oracleImport ? filterPublishedRatingUniverseMatches(oracleImport.matches, mergedTeams) : []
  const leaguepediaRatedMatches = leaguepediaImport ? filterPublishedRatingUniverseMatches(leaguepediaImport.matches, mergedTeams) : []
  const snapshot = createStaticRankingData({
    matches,
    teams,
    rosters: {},
    source: matches.length
      ? describeCommunitySource(Boolean(oracleImport), Boolean(leaguepediaImport))
      : importedMatches.length ? 'no rated public match data available for published team universe' : 'no public match data available',
    dataMode,
    externalSources: [
      ...(oracleImport
        ? [
            {
              name: "Oracle's Elixir CSV",
              kind: 'game-stats' as const,
              url: oracleCsvUrl,
              retrievedAt: oracleImport.source.retrievedAt,
              coverageStart: dateRange(oracleRatedMatches).start,
              coverageEnd: dateRange(oracleRatedMatches).end,
              rowCount: oracleRatedMatches.length,
              description: `${oracleRatedMatches.length} rated games retained from ${oracleImport.matches.length} Oracle's Elixir imports during scheduled recalculation. ${oracleImport.source.attribution}`,
              status: oracleRatedMatches.length > 0 ? 'active' as const : 'reference-only' as const,
            },
          ]
        : []),
      ...(leaguepediaImport
        ? [
            {
              name: 'Leaguepedia Cargo',
              kind: 'match-data' as const,
              url: leaguepediaJsonUrl,
              retrievedAt: leaguepediaImport.source.retrievedAt,
              coverageStart: dateRange(leaguepediaRatedMatches).start,
              coverageEnd: dateRange(leaguepediaRatedMatches).end,
              rowCount: leaguepediaRatedMatches.length,
              description: `${leaguepediaRatedMatches.length} rated games retained from ${leaguepediaImport.matches.length} Leaguepedia Cargo imports during scheduled recalculation for requested range ${leaguepediaImport.source.start ?? 'unknown'} to ${leaguepediaImport.source.end ?? 'unknown'}. ${leaguepediaImport.source.attribution}`,
              status: leaguepediaRatedMatches.length > 0 ? 'active' as const : 'reference-only' as const,
            },
          ]
        : []),
    ],
  })

  response.setHeader('Cache-Control', 'no-store')

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    response.status(200).json({
      ok: true,
      generatedAt: snapshot.generatedAt,
      snapshotCount: Object.keys(snapshot.snapshots).length,
      dataMode: snapshot.dataMode,
      source: snapshot.source,
      modelVersion: snapshot.model.version,
      modelConfigHash: snapshot.model.configHash,
      warning: 'BLOB_READ_WRITE_TOKEN is not configured, so the snapshot was calculated but not published.',
    })
    return
  }

  const published = await publishSnapshot(snapshot)

  response.status(200).json({
    ok: true,
    generatedAt: snapshot.generatedAt,
    snapshotCount: Object.keys(snapshot.snapshots).length,
    dataMode: snapshot.dataMode,
    source: snapshot.source,
    modelVersion: snapshot.model.version,
    modelConfigHash: snapshot.model.configHash,
    blobUrl: published.summaryBlobUrl,
    fullBlobUrl: published.fullBlobUrl,
    playerDirectoryBlobUrl: published.playerDirectoryBlobUrl,
    teamHistoryBlobUrl: published.teamHistoryIndexBlobUrl,
    teamHistoryIndexBlobUrl: published.teamHistoryIndexBlobUrl,
    regionHistoryBlobUrl: published.regionHistoryBlobUrl,
  })
}

type BlobUploadOptions = {
  access: 'public'
  allowOverwrite: true
  contentType: 'application/json'
}

type BlobUploadResult = {
  url: string
}

type BlobUpload = (pathname: string, body: string, options: BlobUploadOptions) => Promise<BlobUploadResult>

export async function publishSnapshot(
  snapshot: ReturnType<typeof createStaticRankingData>,
  upload: BlobUpload = put,
  {
    uploadFullSnapshot = parseBoolean(process.env.RANKING_BLOB_UPLOAD_FULL_SNAPSHOT),
  }: {
    uploadFullSnapshot?: boolean
  } = {},
) {
  const localPlan = createPublicArtifactWritePlan(snapshot)
  const teamHistoryShardCount = localPlan.writes.filter((entry) =>
    entry.relativePath.startsWith(`${PUBLIC_ARTIFACT_PATHS.teamHistoryShardDir}/`)
    && entry.relativePath !== PUBLIC_ARTIFACT_PATHS.teamHistoryIndex,
  ).length
  const companionWrites = localPlan.writes.filter((entry) =>
    entry.relativePath !== PUBLIC_ARTIFACT_PATHS.manifest
    && entry.relativePath !== PUBLIC_ARTIFACT_PATHS.teamHistoryIndex,
  )
  const [fullBlob, uploadedEntries] = await Promise.all([
    uploadFullSnapshot ? uploadJson(upload, 'rankings/latest-full.json', snapshot) : Promise.resolve(undefined),
    Promise.all(
      companionWrites.map(async (entry) => {
        const blob = await uploadJson(upload, `rankings/${entry.relativePath}`, entry.value)
        return [entry.relativePath, blob.url] as const
      }),
    ),
  ])
  const blobUrls = new Map(uploadedEntries)
  const indexPlan = createPublicArtifactWritePlan(snapshot, {
    fullSnapshotUrl: fullBlob?.url,
    urlForPath: (relativePath) => {
      if (relativePath === PUBLIC_ARTIFACT_PATHS.teamHistoryIndex) return `/data/${relativePath}`
      const url = blobUrls.get(relativePath)
      if (!url) throw new Error(`Missing uploaded public artifact URL for ${relativePath}`)
      return url
    },
  })
  const teamHistoryIndex = indexPlan.writes.find((entry) => entry.relativePath === PUBLIC_ARTIFACT_PATHS.teamHistoryIndex)
  if (!teamHistoryIndex) throw new Error('Missing generated team history index artifact')
  const teamHistoryIndexBlob = await uploadJson(upload, `rankings/${teamHistoryIndex.relativePath}`, teamHistoryIndex.value)
  blobUrls.set(PUBLIC_ARTIFACT_PATHS.teamHistoryIndex, teamHistoryIndexBlob.url)

  const blobPlan = createPublicArtifactWritePlan(snapshot, {
    fullSnapshotUrl: fullBlob?.url,
    urlForPath: (relativePath) => {
      const url = blobUrls.get(relativePath)
      if (!url) throw new Error(`Missing uploaded public artifact URL for ${relativePath}`)
      return url
    },
  })
  const summaryBlob = await uploadJson(upload, 'rankings/latest-summary.json', blobPlan.manifest)

  return {
    summaryBlobUrl: summaryBlob.url,
    fullBlobUrl: fullBlob?.url,
    playerDirectoryBlobUrl: blobUrls.get(PUBLIC_ARTIFACT_PATHS.players),
    teamHistoryIndexBlobUrl: blobUrls.get(PUBLIC_ARTIFACT_PATHS.teamHistoryIndex),
    regionHistoryBlobUrl: blobUrls.get(PUBLIC_ARTIFACT_PATHS.regionHistory),
    snapshotShardCount: Object.keys(blobPlan.snapshots).length,
    teamHistoryShardCount,
  }
}

function uploadJson(upload: BlobUpload, pathname: string, value: unknown) {
  return upload(pathname, JSON.stringify(value), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
  })
}

function parseBoolean(value: unknown) {
  return value === true || value === 'true' || value === '1'
}

export function isAuthorizedCronRequest(authorization: string | undefined, secret: string | undefined) {
  if (!secret) return false
  return authorization === `Bearer ${secret}`
}

async function fetchOracleCsv(url: string) {
  const csvResponse = await fetch(url, {
    headers: {
      'user-agent': 'lol-esports-power-index-vercel-cron/0.1',
    },
  })

  if (!csvResponse.ok) {
    throw new Error(`Oracle CSV fetch failed with HTTP ${csvResponse.status}`)
  }

  return importOraclesElixirCsv(await csvResponse.text(), { sourceUrl: url })
}

async function fetchLeaguepediaJson(url: string) {
  const jsonResponse = await fetch(url, {
    headers: {
      'user-agent': 'lol-esports-power-index-vercel-cron/0.1',
    },
  })

  if (!jsonResponse.ok) {
    throw new Error(`Leaguepedia JSON fetch failed with HTTP ${jsonResponse.status}`)
  }

  return importLeaguepediaSnapshot((await jsonResponse.json()) as LeaguepediaSnapshot, { sourceUrl: url })
}

function describeCommunitySource(hasOracle: boolean, hasLeaguepedia: boolean) {
  if (hasOracle && hasLeaguepedia) return "Oracle's Elixir primary with Leaguepedia Cargo gap-fill"
  if (hasOracle) return "Oracle's Elixir CSV scheduled import"
  return 'Leaguepedia Cargo scheduled import'
}

function dateRange(matches: Pick<MatchRecord, 'date'>[]) {
  const dates: string[] = []
  for (const match of matches) {
    if (match.date) dates.push(match.date)
  }
  dates.sort()
  return {
    start: dates[0],
    end: dates.at(-1),
  }
}
