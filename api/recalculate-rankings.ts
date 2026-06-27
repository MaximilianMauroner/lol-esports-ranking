import { put } from '@vercel/blob'
import { knownTeamIdentities } from '../src/data/teamIdentity'
import { mergeCommunityMatchSources } from '../src/lib/importers/communitySources'
import { importLeaguepediaSnapshot, type LeaguepediaSnapshot } from '../src/lib/importers/leaguepedia'
import { importOraclesElixirCsv } from '../src/lib/importers/oraclesElixir'
import { createStaticRankingData, createStaticRankingSummaryData } from '../src/lib/snapshot'
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

  const matches = importedMatches
  const importedTeams = mergeTeamProfiles([leaguepediaImport?.teams ?? {}, oracleImport?.teams ?? {}])
  const mergedTeams = importedMatches.length ? { ...deriveTeamProfilesFromMatches(importedMatches, importedTeams), ...knownTeamIdentities } : {}
  const dataMode = importedMatches.length ? 'scheduled-public-data' : 'no-data'
  const snapshot = createStaticRankingData({
    matches,
    teams: mergedTeams,
    rosters: {},
    source: importedMatches.length ? describeCommunitySource(Boolean(oracleImport), Boolean(leaguepediaImport)) : 'no public match data available',
    dataMode,
    externalSources: [
      ...(oracleImport
        ? [
            {
              name: "Oracle's Elixir CSV",
              kind: 'game-stats' as const,
              url: oracleCsvUrl,
              retrievedAt: oracleImport.source.retrievedAt,
              coverageStart: dateRange(oracleImport.matches).start,
              coverageEnd: dateRange(oracleImport.matches).end,
              rowCount: oracleImport.matches.length,
              description: `${oracleImport.matches.length} normalized games imported during scheduled recalculation. ${oracleImport.source.attribution}`,
              status: 'active' as const,
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
              coverageStart: dateRange(leaguepediaImport.matches).start,
              coverageEnd: dateRange(leaguepediaImport.matches).end,
              rowCount: leaguepediaImport.matches.length,
              description: `${leaguepediaImport.matches.length} normalized games imported during scheduled recalculation for requested range ${leaguepediaImport.source.start ?? 'unknown'} to ${leaguepediaImport.source.end ?? 'unknown'}. ${leaguepediaImport.source.attribution}`,
              status: 'active' as const,
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

  const summary = createStaticRankingSummaryData(snapshot, {
    fullSnapshotUrl: 'rankings/latest-full.json',
    snapshotUrlForKey: (key) => `rankings/snapshots/${key}.json`,
  })
  const [summaryBlob, fullBlob] = await Promise.all([
    put('rankings/latest-summary.json', JSON.stringify(summary.manifest), {
      access: 'public',
      allowOverwrite: true,
      contentType: 'application/json',
    }),
    put('rankings/latest-full.json', JSON.stringify(snapshot), {
      access: 'public',
      allowOverwrite: true,
      contentType: 'application/json',
    }),
  ])
  await Promise.all(Object.entries(summary.snapshots).map(([key, compactSnapshot]) =>
    put(`rankings/snapshots/${key}.json`, JSON.stringify(compactSnapshot), {
      access: 'public',
      allowOverwrite: true,
      contentType: 'application/json',
    }),
  ))

  response.status(200).json({
    ok: true,
    generatedAt: snapshot.generatedAt,
    snapshotCount: Object.keys(snapshot.snapshots).length,
    dataMode: snapshot.dataMode,
    source: snapshot.source,
    modelVersion: snapshot.model.version,
    modelConfigHash: snapshot.model.configHash,
    blobUrl: summaryBlob.url,
    fullBlobUrl: fullBlob.url,
  })
}

export function isAuthorizedCronRequest(authorization: string | undefined, secret: string | undefined) {
  if (!secret) return false
  return authorization === `Bearer ${secret}`
}

async function fetchOracleCsv(url: string) {
  const csvResponse = await fetch(url, {
    headers: {
      'user-agent': 'lol-esports-ranking-vercel-cron/0.1',
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
      'user-agent': 'lol-esports-ranking-vercel-cron/0.1',
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
