import type { DataSourceInfo, SnapshotSourceBreakdown } from './snapshot'

// The importer names each source "<prefix>: <file>", for example
// "Oracle's Elixir CSV: 2026_LoL_esports_match_data_from_OraclesElixir.csv".
// The panel finds a provider's sources by these prefixes.
export const ORACLE_SOURCE_PREFIX = "Oracle's Elixir CSV"
export const LEAGUEPEDIA_SOURCE_PREFIX = 'Leaguepedia Cargo'

/**
 * Public freshness for one match provider. File names, warning text and
 * download errors are operator details: they stay in the manifest and logs.
 */
export type ProviderFreshness = {
  label: string
  /** Games from this provider in the selected view. */
  matchCount: number
  /** Latest rated match from this provider in all published data, not only the selected view. */
  publishedThrough?: string
  /** Set when the latest refresh could not download all of this provider's files. */
  failedUpdate?: 'failed' | 'partial'
}

const PROVIDERS: Partial<Record<string, { label: string; sourcePrefix?: string }>> = {
  'oracles-elixir': { label: "Oracle's Elixir", sourcePrefix: ORACLE_SOURCE_PREFIX },
  'leaguepedia-cargo': { label: 'Leaguepedia', sourcePrefix: LEAGUEPEDIA_SOURCE_PREFIX },
  seed: { label: 'Seeded sample' },
}

/**
 * Every provider in the view's breakdown or in the published sources, most
 * games in the view first. Providers outside the view have a match count of 0.
 */
export function providerFreshness(
  breakdown: Pick<SnapshotSourceBreakdown, 'provider' | 'matchCount'>[],
  sources: DataSourceInfo[],
): ProviderFreshness[] {
  const viewCounts = new Map(breakdown.map(({ provider, matchCount }) => [provider, matchCount]))
  return [...new Set([...viewCounts.keys(), ...Object.keys(PROVIDERS)])]
    .map((provider): ProviderFreshness => {
      const known = PROVIDERS[provider]
      const prefix = known?.sourcePrefix
      const feeds = prefix ? sources.filter((source) => source.status === 'active' && source.name.startsWith(prefix)) : []
      const publishedThrough = feeds.map((source) => source.coverageEnd).filter((date): date is string => Boolean(date)).sort().at(-1)
      const receipts = feeds.map((source) => source.refreshReceipt?.status)
      const failedUpdate = receipts.includes('failed') ? 'failed' : receipts.includes('partial') ? 'partial' : undefined
      return { label: known?.label ?? provider, matchCount: viewCounts.get(provider) ?? 0, publishedThrough, failedUpdate }
    })
    .sort((a, b) => b.matchCount - a.matchCount)
}
