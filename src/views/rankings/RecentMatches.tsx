import { useMemo, useState } from 'react'
import type {
  TeamHistoryArtifactState
} from '../../browser/rankings/usePublicArtifacts'
import { RegionBadge } from '../../components/ui'
import { LoadingState } from '../../components/ui/loading'
import { Pager } from '../../components/ui/pager'
import { eventTierConfig } from '../../domains/rankings/policy'
import type { EventTier, PublicRecentMatch, RankingSummaryStanding, TeamHistorySeries } from '../../domains/rankings/types'
import { formatDate, formatNumber, formatRating, formatRatio } from '../../shared/display'
import { cn } from '../../shared/utils'
import { formatEventWeight, formatRankValue, formatRatingMovement, isEventTier, movementTone, teamRankFor, teamScoreFor } from './boardFormat'
import { UPSET_CHANCE } from './upset'

const RECENT_MATCH_PAGE_SIZE = 10

type RecentMatchSource = Omit<PublicRecentMatch, 'delta'> & {
  tier?: EventTier
  expectedWinProbability?: number
  eventWeight?: number
}

type RecentMatchListItem = RecentMatchSource & {
  otherMovement?: number
}

type OpponentContext = {
  rank?: number
  rating?: number
  code?: string
  league?: string
}

export function RecentMatches({
  matches,
  series,
  standings,
  historyState,
  seriesOnly = false,
}: {
  matches?: PublicRecentMatch[]
  series?: TeamHistorySeries
  standings: readonly RankingSummaryStanding[]
  historyState: TeamHistoryArtifactState
  seriesOnly?: boolean
}) {
  const [pageState, setPageState] = useState({ scopeKey: '', page: 1 })
  const opponentLookup = useMemo(() => opponentContextLookup(standings), [standings])
  const historyPending = !series && historyState.status === 'loading'
  const orderedMatches = useMemo(() => {
    if (historyPending) return matchesWithOtherMovement(matches ?? []).toReversed().slice(0, 1)
    const historyMatches = recentMatchesFromHistorySeries(series)
    const sourceMatches = seriesOnly || historyMatches.length >= (matches?.length ?? 0) ? historyMatches : matches ?? []
    return matchesWithOtherMovement(sourceMatches).toReversed()
  }, [historyPending, matches, series, seriesOnly])
  const totalMatches = orderedMatches.length
  const totalPages = Math.max(1, Math.ceil(totalMatches / RECENT_MATCH_PAGE_SIZE))
  const newestMatch = orderedMatches[0]
  const oldestMatch = orderedMatches.at(-1)
  const matchScopeKey = [
    series?.team ?? '',
    series?.code ?? '',
    orderedMatches.length,
    newestMatch?.date ?? '',
    newestMatch?.opponent ?? '',
    oldestMatch?.date ?? '',
    oldestMatch?.opponent ?? '',
  ].join('\u0000')
  const requestedPage = pageState.scopeKey === matchScopeKey ? pageState.page : 1
  const currentPage = Math.min(requestedPage, totalPages)
  const pageStart = (currentPage - 1) * RECENT_MATCH_PAGE_SIZE
  const recentMatches = orderedMatches.slice(pageStart, pageStart + RECENT_MATCH_PAGE_SIZE)
  const pageEnd = totalMatches === 0 ? 0 : pageStart + recentMatches.length
  const resultSummary = `${formatNumber(totalMatches === 0 ? 0 : pageStart + 1)}-${formatNumber(pageEnd)} of ${formatNumber(totalMatches)}`

  const updatePage = (nextPage: number) => {
    setPageState({ scopeKey: matchScopeKey, page: Math.min(Math.max(1, nextPage), totalPages) })
  }

  return (
    <section className="mt-3.5 overflow-hidden rounded-sm border border-[var(--line-strong)] bg-[var(--detail-surface,var(--surface))]" aria-label="Recent form matches">
      <div className="grid grid-cols-[64px_minmax(0,1fr)_minmax(92px,auto)] items-center gap-2.5 border-b border-border px-3.5 py-2 text-2xs font-bold tracking-label text-[var(--faint)] uppercase [&>span:last-child]:text-right max-sm:hidden" aria-hidden="true">
        <span>Result</span>
        <span>Opponent</span>
        <span>Rating after / match impact</span>
      </div>
      {recentMatches.length > 0 ? (
        <div>
          {recentMatches.map((match, index) => {
            const opponent = opponentLookup.get(normalizeOpponentLookupKey(match.opponent))
            const outcomeSignal = matchOutcomeSignal(match)
            const tierChip = matchTierChip(match)
            return (
              <div
                className={cn('grid min-h-16 grid-cols-[64px_minmax(0,1fr)_minmax(92px,auto)] items-start gap-2.5 border-t border-dotted border-border px-3.5 py-3 first:border-t-0 max-sm:grid-cols-[26px_minmax(0,1fr)]', outcomeSignal?.tone === 'upset' && 'shadow-[inset_3px_0_0_color-mix(in_oklch,var(--warn)_72%,transparent)]', outcomeSignal?.tone === 'miss' && 'shadow-[inset_3px_0_0_color-mix(in_oklch,var(--down)_72%,transparent)]')}
                key={`${match.date}-${match.event}-${match.opponent}-${index}`}
              >
                <span className={cn('grid size-[22px] place-items-center rounded-full text-2xs font-extrabold', match.result === 'W' ? 'bg-[var(--win-soft)] text-[var(--win)]' : match.result === 'L' ? 'bg-[var(--loss-soft)] text-[var(--loss)]' : 'bg-[var(--surface-3)] text-muted-foreground')}>{match.result}</span>
                <div className="min-w-0">
                  <span className="flex min-w-0 items-baseline gap-2 max-sm:flex-col max-sm:items-start max-sm:gap-0.5">
                    <b className="inline-block min-w-0 whitespace-normal [overflow-wrap:anywhere] text-sm font-bold text-[var(--text-strong)]">vs {match.opponent}</b>
                    {opponent ? <span className="shrink-0 whitespace-nowrap text-2xs font-semibold text-muted-foreground tabular-nums" title="Current opponent rank and power score in this scope">{formatOpponentContext(opponent)}</span> : null}
                  </span>
                  <small className="mt-0.5 block whitespace-normal [overflow-wrap:anywhere] text-xs text-[var(--faint)]" title={formatTeamMatchDetail(match)}>{formatTeamMatchMeta(match)}</small>
                  <span className="mt-1.5 flex flex-wrap items-center gap-1 [&>span]:inline-flex [&>span]:min-h-[18px] [&>span]:max-w-full [&>span]:items-center [&>span]:whitespace-nowrap [&>span]:rounded-full [&>span]:border [&>span]:border-border [&>span]:bg-[color-mix(in_oklch,var(--detail-surface-2,var(--surface-2))_72%,transparent)] [&>span]:px-1.5 [&>span]:py-0.5 [&>span]:text-2xs [&>span]:font-bold [&>span]:leading-none [&>span]:text-muted-foreground [&>span.miss]:border-[color-mix(in_oklch,var(--down)_44%,var(--line))] [&>span.miss]:text-[var(--down)] [&>span.upset]:border-transparent [&>span.upset]:bg-[var(--warn-soft)] [&>span.upset]:text-[var(--warn)]" aria-label="Match context">
                    {tierChip ? <span title={tierChip.title}>{tierChip.label}</span> : null}
                    {typeof match.expectedWinProbability === 'number' ? (
                      <span title="Pregame expected series win probability for this team">
                        Expected {formatRatio(match.expectedWinProbability)}
                      </span>
                    ) : null}
                    {outcomeSignal ? <span className={outcomeSignal.tone} title={outcomeSignal.title}>{outcomeSignal.label}</span> : null}
                    {historyPending && !tierChip && typeof match.expectedWinProbability !== 'number' ? (
                      <LoadingState presentation="inline" announce={false} label="Loading context" />
                    ) : null}
                  </span>
                </div>
                <div className="pt-px text-right tabular-nums [&_small]:mt-0.5 [&_small]:block [&_small]:text-xs [&_small]:font-bold [&_small]:text-muted-foreground [&_small.down]:text-[var(--down)] [&_small.flat]:text-[var(--faint)] [&_small.up]:text-[var(--up)] [&_strong]:block [&_strong]:text-md [&_strong]:font-bold [&_strong]:text-[var(--text-strong)] max-sm:col-start-2 max-sm:flex max-sm:flex-wrap max-sm:items-baseline max-sm:justify-self-start max-sm:gap-2 max-sm:text-left">
                  <span className="hidden text-xs text-muted-foreground max-sm:block">Post-match Power</span>
                  <strong>{formatRating(match.rating)}</strong>
                  {typeof match.matchImpact === 'number' ? (
                    <small className={movementTone(match.matchImpact)} title={`Recorded match impact ${formatRatingMovement(match.matchImpact)}`}>
                      {formatRatingMovement(match.matchImpact)}
                    </small>
                  ) : <small>Match impact unavailable</small>}
                  {typeof match.otherMovement === 'number' ? (
                    <small title="Difference since the previous recorded rating, excluding this match's recorded impact. This also includes rounding differences.">
                      Other changes {formatRatingMovement(match.otherMovement)}
                    </small>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
      {historyPending ? (
        <MatchHistorySkeleton rowCount={Math.max(0, RECENT_MATCH_PAGE_SIZE - recentMatches.length)} compact={recentMatches.length > 0} />
      ) : recentMatches.length === 0 ? (
        <p className="px-3.5 py-4 text-xs text-muted-foreground">
          {historyState.status === 'missing' || historyState.status === 'error'
            ? historyState.message
            : 'No matches in this scope.'}
        </p>
      ) : null}
      {(historyState.status === 'missing' || historyState.status === 'error') && recentMatches.length > 0 ? (
        <p className="border-t border-border px-3.5 py-2.5 text-xs leading-[1.4] text-[var(--faint)]">{historyState.message}</p>
      ) : null}
      {totalMatches > RECENT_MATCH_PAGE_SIZE ? (
        <Pager
          label="Match results pagination"
          density="compact"
          page={currentPage}
          pageCount={totalPages}
          onPage={updatePage}
          rangeLabel={resultSummary}
          className="border-t border-border bg-[color-mix(in_oklch,var(--detail-surface-2,var(--surface-2))_64%,transparent)] px-3.5 py-2.5"
        />
      ) : null}
    </section>
  )
}

function MatchHistorySkeleton({
  rowCount = RECENT_MATCH_PAGE_SIZE,
  compact = false,
}: {
  rowCount?: number
  compact?: boolean
}) {
  if (rowCount <= 0 && compact) return null
  return (
    <div className="recent-match-skeleton" aria-hidden="true">
      <p>{compact ? 'Loading remaining match context...' : 'Loading detailed match context...'}</p>
      {Array.from({ length: rowCount }, (_, index) => (
        <div className="recent-match-skeleton__row" key={index} aria-hidden="true">
          <span className="detail-skeleton detail-skeleton--result" />
          <span className="recent-match-skeleton__main">
            <span className="detail-skeleton detail-skeleton--line is-wide" />
            <span className="detail-skeleton detail-skeleton--line is-mid" />
            <span className="recent-match-skeleton__chips">
              <span className="detail-skeleton detail-skeleton--chip" />
              <span className="detail-skeleton detail-skeleton--chip is-short" />
            </span>
          </span>
          <span className="recent-match-skeleton__rating">
            <span className="detail-skeleton detail-skeleton--line is-score" />
            <span className="detail-skeleton detail-skeleton--line is-delta" />
          </span>
        </div>
      ))}
    </div>
  )
}

function matchesWithOtherMovement(matches: RecentMatchSource[]): RecentMatchListItem[] {
  let previousRating: number | undefined
  return matches.map((match) => {
    const otherMovement = typeof previousRating === 'number' && Number.isFinite(match.rating) && typeof match.matchImpact === 'number'
      ? match.rating - previousRating - match.matchImpact
      : undefined
    previousRating = Number.isFinite(match.rating) ? match.rating : previousRating
    return {
      ...match,
      ...(typeof otherMovement === 'number' && Math.round(otherMovement) !== 0 ? { otherMovement } : {}),
    }
  })
}

function recentMatchesFromHistorySeries(series?: TeamHistorySeries): RecentMatchSource[] {
  if (!series) return []
  return series.points
    .map(([date, rating, , context]): RecentMatchSource | null => {
      if (!context?.event || !context.opponent || !context.result) return null
      return {
        date,
        event: context.event,
        opponent: context.opponent,
        result: context.result,
        rating,
        matchImpact: typeof context.delta === 'number' && Number.isFinite(context.delta) ? context.delta : undefined,
        ...(typeof context.wins === 'number' ? { wins: context.wins } : {}),
        ...(typeof context.losses === 'number' ? { losses: context.losses } : {}),
        ...(typeof context.games === 'number' ? { games: context.games } : {}),
        ...(typeof context.bestOf === 'number' ? { bestOf: context.bestOf } : {}),
        ...(isEventTier(context.tier) ? { tier: context.tier } : {}),
        ...(typeof context.model?.e === 'number' && Number.isFinite(context.model.e) ? { expectedWinProbability: context.model.e } : {}),
        ...(typeof context.model?.w === 'number' && Number.isFinite(context.model.w) ? { eventWeight: context.model.w } : {}),
      }
    })
    .filter((match): match is RecentMatchSource => match !== null)
}

function formatTeamMatchMeta(match: RecentMatchSource) {
  return [formatDate(match.date), match.event].filter(Boolean).join(' · ')
}

function formatTeamMatchDetail(match: RecentMatchSource) {
  if (typeof match.wins !== 'number' || typeof match.losses !== 'number') return undefined
  const score = `${match.wins}-${match.losses}`
  const bestOf = typeof match.bestOf === 'number' && match.bestOf > 1 ? `Bo${match.bestOf}` : undefined
  return [formatTeamMatchMeta(match), score, bestOf].filter(Boolean).join(' · ')
}

function opponentContextLookup(standings: readonly RankingSummaryStanding[]) {
  const lookup = new Map<string, OpponentContext>()
  for (const standing of standings) {
    const context: OpponentContext = {
      rank: teamRankFor(standing),
      rating: teamScoreFor(standing),
      code: standing.code,
      league: standing.league,
    }
    lookup.set(normalizeOpponentLookupKey(standing.team), context)
    if (standing.code) lookup.set(normalizeOpponentLookupKey(standing.code), context)
  }
  return lookup
}

function normalizeOpponentLookupKey(value: string) {
  return value.trim().toLocaleLowerCase('en')
}

function formatOpponentContext(opponent: OpponentContext) {
  return [
    typeof opponent.rank === 'number' ? formatRankValue(opponent.rank) : undefined,
    typeof opponent.rating === 'number' ? formatRating(opponent.rating) : undefined,
    opponent.league,
  ].filter(Boolean).join(' · ')
}

function matchTierChip(match: RecentMatchSource) {
  if (!match.tier) return undefined
  const config = eventTierConfig[match.tier]
  const weight = typeof match.eventWeight === 'number' ? match.eventWeight : config.weight
  return {
    label: `${config.label} ${formatEventWeight(weight)}`,
    title: `${config.description} Applied event weight ${formatEventWeight(weight)}.`,
  }
}

function matchOutcomeSignal(match: RecentMatchSource) {
  const expected = match.expectedWinProbability
  if (typeof expected !== 'number' || !Number.isFinite(expected)) return null
  if (match.result === 'W' && expected < UPSET_CHANCE) {
    return {
      label: 'Upset',
      tone: 'upset',
      title: `Won with ${formatRatio(expected)} expected win probability.`,
    }
  }
  if (match.result === 'L' && expected > 1 - UPSET_CHANCE) {
    return {
      label: 'Miss',
      tone: 'miss',
      title: `Lost with ${formatRatio(expected)} expected win probability.`,
    }
  }
  return null
}

export function LeagueSigil({
  league,
  fallbackLabel,
  small = false,
}: {
  league: string
  fallbackLabel?: string
  small?: boolean
}) {
  const code = league.trim().toUpperCase()
  const badgeRegion = code || (fallbackLabel ?? league)
  return (
    <span className={cn('inline-grid h-6 shrink-0 place-items-center [&_.region-badge]:size-full', small ? 'w-7' : 'w-[30px]')} aria-hidden="true">
      <RegionBadge region={badgeRegion} size="sm" />
    </span>
  )
}
