import { createPublicRankingManifestLoader } from './publicArtifacts/manifestLoader'
import { fetchPublicSnapshotShard } from './publicArtifacts/resolver'
import { resolvePublicArtifactUrl } from './publicArtifacts/urlResolver'
import { emptyForecastLedger, isForecastLedger, isTournamentTeamIdentityMap, type ForecastBasis, type ForecastLedger } from './tournamentForecast'

const MANIFEST_URL = import.meta.env.VITE_RANKING_DATA_URL || '/data/ranking-summary.json'
const IDENTITY_URL = '/data/tournaments/forecasts/team-ids.json'
const LEDGER_URL = '/data/tournaments/forecasts/ledger.json'

/** Optional read-only artifacts; absence leaves the schedule usable. No collector or publisher calls occur here. */
export async function loadTournamentForecastArtifacts(fetcher: typeof fetch = fetch): Promise<{
  basis: ForecastBasis | null; ledger: ForecastLedger; reason?: string
}> {
  const ledger = await loadTournamentForecastLedger(fetcher)
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
    }, ledger }
  } catch (error) {
    return { basis: null, ledger, reason: error instanceof Error ? error.message : 'Forecast inputs are unavailable.' }
  }
}

export async function loadTournamentForecastLedger(fetcher: typeof fetch = fetch): Promise<ForecastLedger> {
  return fetcher(LEDGER_URL, { cache: 'no-store' })
    .then(async (response) => response.ok ? response.json() as Promise<unknown> : null)
    .then((value) => isForecastLedger(value) ? value : emptyForecastLedger)
    .catch(() => emptyForecastLedger)
}
