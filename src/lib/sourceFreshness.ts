import type { DataSourceInfo, SnapshotSourceBreakdown } from './snapshot'

/**
 * Public freshness for one match provider. File names, warning text and
 * download errors are operator details: they stay in the manifest and logs.
 */
export type ProviderFreshness = {
  label: string
  matchCount: number
  /** Latest rated match from this provider across all published scopes. */
  through?: string
  /** Set when the latest refresh could not download all of this provider's files. */
  failedUpdate?: 'failed' | 'partial'
}

// Importers name each source "<sourceName>: <file>", for example
// "Oracle's Elixir CSV: 2026_LoL_esports_match_data_from_OraclesElixir.csv".
const PROVIDERS: Record<string, { label: string; sourceName: string }> = {
  'oracles-elixir': { label: "Oracle's Elixir", sourceName: "Oracle's Elixir CSV" },
  'leaguepedia-cargo': { label: 'Leaguepedia', sourceName: 'Leaguepedia Cargo' },
  seed: { label: 'Seeded sample', sourceName: 'Seeded sample' },
}

export function providerFreshness(
  breakdown: Pick<SnapshotSourceBreakdown, 'provider' | 'matchCount'>[],
  sources: DataSourceInfo[],
): ProviderFreshness[] {
  return [...breakdown]
    .sort((a, b) => b.matchCount - a.matchCount)
    .map(({ provider, matchCount }) => {
      const known = PROVIDERS[provider]
      const feeds = known ? sources.filter((source) => source.status === 'active' && source.name.startsWith(known.sourceName)) : []
      const through = feeds.map((source) => source.coverageEnd).filter((date): date is string => Boolean(date)).sort().at(-1)
      const receipts = feeds.map((source) => source.refreshReceipt?.status)
      const failedUpdate = receipts.includes('failed') ? 'failed' : receipts.includes('partial') ? 'partial' : undefined
      return { label: known?.label ?? provider, matchCount, through, failedUpdate }
    })
}
