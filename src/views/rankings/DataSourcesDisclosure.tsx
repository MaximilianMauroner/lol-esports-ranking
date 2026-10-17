import { providerFreshness, type ProviderFreshness } from '../../domains/rankings/evidence'
import type { ModelInfo } from '../../domains/rankings/types'
import { formatDate, formatDateRange, formatModelVersion, formatNumber } from '../../shared/display'
import { type TeamDataSummary } from './types'

/** Visitor-facing data freshness. Operator details stay in the manifest and refresh logs. */
export function DataSourcesDisclosure({ model, data }: { model?: Pick<ModelInfo, 'version'>; data?: TeamDataSummary }) {
  // Rows describe the selected view. Refresh notices describe all published data.
  const providers = providerFreshness(data?.sourceBreakdown ?? [], data?.sources ?? [])
  const viewProviders = providers.filter((provider) => provider.matchCount > 0).slice(0, 3)

  return (
    <details className="group w-full overflow-hidden rounded-lg border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-[var(--text-strong)] after:ml-auto after:text-base after:leading-none after:text-muted-foreground after:content-['+'] group-open:border-b group-open:border-border group-open:after:content-['-'] [&::-webkit-details-marker]:hidden">
        <span className="text-base font-semibold">Data and sources</span>
      </summary>
      <div className="mx-3 mt-3.5 grid grid-cols-2 gap-px bg-border last:mb-3 [&>span]:grid [&>span]:min-w-0 [&>span]:gap-1 [&>span]:bg-[var(--rail)] [&>span]:px-3 [&>span]:py-2.5 [&_b]:overflow-hidden [&_b]:text-ellipsis [&_b]:whitespace-nowrap [&_b]:text-sm [&_b]:text-[var(--text-strong)] [&_b]:tabular-nums [&_small]:text-2xs [&_small]:tracking-label [&_small]:text-[var(--faint)] [&_small]:uppercase">
        <span>
          <small>Model</small>
          <b>{formatModelVersion(model?.version)}</b>
        </span>
        <span>
          <small>Matches</small>
          <b>{formatNumber(data?.matchCount)}</b>
        </span>
        <span>
          <small>Coverage</small>
          <b>{formatDateRange(data?.coverageStart, data?.coverageEnd)}</b>
        </span>
        <span>
          <small>Team rows</small>
          <b>{formatNumber(data?.tableTeamCount)} / {formatNumber(data?.scopeTeamCount)}</b>
        </span>
        <span>
          <small>Latest match</small>
          <b>{formatDate(data?.latestMatchDate)}</b>
        </span>
        <span>
          <small>Hidden from ranked board</small>
          <b>{formatNumber(data?.hiddenFromRankedCount)}</b>
        </span>
        <span>
          <small>Complete lineup sides</small>
          <b>{formatNumber(data?.rosterCoverage?.completeRosterSides)} / {formatNumber(data?.rosterCoverage?.rosterSides)}</b>
        </span>
        <span>
          <small>Missing or partial lineup sides</small>
          <b>{formatNumber((data?.rosterCoverage?.missingRosterSides ?? 0) + (data?.rosterCoverage?.partialRosterSides ?? 0))}</b>
        </span>
      </div>
      {viewProviders.length > 0 ? (
        <div className="mx-3 mt-3 grid gap-px bg-border last:mb-3" aria-label="Match providers">
          {viewProviders.map((provider) => (
            <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 bg-background px-3 py-2 text-xs text-muted-foreground" key={provider.label}>
              {/* Narrow phones stack every row the same way instead of wrapping only the longer counts. */}
              <span className="text-foreground max-[360px]:basis-full">{provider.label}</span>
              <span><b className="text-foreground tabular-nums">{formatNumber(provider.matchCount)}</b> games in this view</span>
              {provider.publishedThrough ? <span className="basis-full">Published data through {formatDate(provider.publishedThrough)}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      {data?.seeded ? (
        <p className="mx-3 mt-3 text-xs text-[var(--down)] last:mb-3 [overflow-wrap:anywhere]">Seeded sample data is active. Do not treat these rows as official rankings.</p>
      ) : providers.filter((provider) => provider.failedUpdate).map((provider) => (
        <p className="mx-3 mt-3 text-xs text-muted-foreground last:mb-3 [overflow-wrap:anywhere]" key={provider.label}>
          {failedUpdateNotice(provider, providers)}
        </p>
      ))}
    </details>
  )
}

/** Says only what the published coverage shows: where this provider's data ends and which providers have later matches. */
function failedUpdateNotice(provider: ProviderFreshness, providers: ProviderFreshness[]) {
  const sentences = [`${provider.label} ${provider.failedUpdate === 'partial' ? 'was only partly updated' : 'could not be updated'} in the latest refresh.`]
  const through = provider.publishedThrough
  if (through) {
    sentences.push(`Its published data ends on ${formatDate(through)}.`)
    const later = providers.filter((other) => other.publishedThrough && other.publishedThrough > through).map((other) => other.label)
    if (later.length > 0) sentences.push(`Later published matches come from ${later.join(' and ')}.`)
  }
  return sentences.join(' ')
}
