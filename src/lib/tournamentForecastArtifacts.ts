import { createPublicRankingManifestLoader } from './publicArtifacts/manifestLoader'
import { fetchPublicSnapshotShard } from './publicArtifacts/resolver'
import { resolvePublicArtifactUrl } from './publicArtifacts/urlResolver'
import { isForecastLedger, isTournamentTeamIdentityMap, type ForecastBasis, type ForecastLedger } from './tournamentForecast'

const MANIFEST_URL = import.meta.env?.VITE_RANKING_DATA_URL || '/data/ranking-summary.json'
const IDENTITY_URL = '/tournament-data/forecasts/team-ids.json'
const LEDGER_URL = '/tournament-data/forecasts/ledger.json'

/** Optional read-only artifacts; absence leaves the schedule usable. No collector or publisher calls occur here. */
export async function loadTournamentForecastArtifacts(fetcher: typeof fetch = fetch): Promise<{
  basis: ForecastBasis | null; reason?: string
}> {
  try {
    const identityResponse = await fetcher(IDENTITY_URL, { cache: 'no-store' })
    if (!identityResponse.ok) throw new Error('No reviewed source-to-ranking team ID map is published.')
    const identityValue: unknown = await identityResponse.json()
    if (!isTournamentTeamIdentityMap(identityValue)) throw new Error('The source-to-ranking team ID map is invalid.')
    const manifest = await createPublicRankingManifestLoader(MANIFEST_URL, fetcher)()
    const key = manifest.defaultSnapshotKey
    const entry = manifest.snapshotIndex[key]
    if (!entry) throw new Error('The current default rating snapshot is unavailable.')
    const snapshot = await fetchPublicSnapshotShard(resolvePublicArtifactUrl(entry.url, MANIFEST_URL), key, entry, manifest, { fetcher })
    return { basis: {
      snapshotId: `${manifest.artifactMeta?.runId ?? manifest.generatedAt}/${key}`,
      ratingDataAsOf: manifest.coverage.latestMatchDate ?? '', ratingPublishedAt: manifest.generatedAt,
      dataMode: manifest.dataMode, model: manifest.model, snapshot, identityMap: identityValue,
    } }
  } catch (error) {
    return { basis: null, reason: error instanceof Error ? error.message : 'Forecast inputs are unavailable.' }
  }
}

export async function loadTournamentForecastLedger(fetcher: typeof fetch = fetch, timeoutMs = 15_000): Promise<ForecastLedger> {
  const response = await fetcher(LEDGER_URL, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`Forecast ledger returned HTTP ${response.status}`)
  const value: unknown = await response.json()
  if (!isForecastLedger(value)) throw new Error('Forecast ledger schema is invalid')
  return value
}
