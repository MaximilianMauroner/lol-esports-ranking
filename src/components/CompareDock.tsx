import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ModelInfo, RankingSummaryStanding } from '../lib/snapshot'
import { estimatePublicMatchup } from '../lib/publicMatchup'
import { formatPercentValue, formatSigned } from '../lib/display'
import { Button } from './ui/button'
import { cn } from '../lib/utils'

export type CompareDockEntity = {
  id: string
  code: string
  name: string
  meta?: string
  badge?: ReactNode
}

/**
 * Persistent comparison dock.
 *
 * It replaced a tray that only appeared after the first pick and opened with a
 * disabled primary button, which meant nothing on a first visit said the
 * feature existed and the first thing it ever showed was greyed out.
 *
 * Two picks are enough to answer the question most people are asking, so the
 * headline answer is inline: the score gap and the game win probability it
 * implies. The drawer is still there for the full metric table, but it is now
 * a choice rather than the only way to see anything.
 */
export function CompareDock({
  label,
  entities,
  limit,
  matchup,
  onRemove,
  onClear,
  onOpen,
  className,
}: {
  label: string
  entities: CompareDockEntity[]
  limit: number
  /** Only supplied by the team board. Regions have no matchup model. */
  matchup?: { home: RankingSummaryStanding; away: RankingSummaryStanding; model?: Pick<ModelInfo, 'version' | 'configHash'> }
  onRemove: (id: string) => void
  onClear: () => void
  onOpen: () => void
  className?: string
}) {
  const ready = entities.length >= 2
  const odds = ready && matchup ? matchupOdds(matchup) : undefined

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--r-3)] border px-3 py-2.5',
        ready ? 'border-[var(--selected-line)] bg-[var(--selected-bg)]' : 'border-dashed border-[var(--line)] bg-[var(--surface)]',
        className,
      )}
      role="region"
      aria-label={`${label}: ${entities.length} selected`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {entities.map((entity) => (
          <span
            key={entity.id}
            className="inline-flex min-w-0 items-center gap-2 rounded-[var(--r-2)] border border-[var(--line)] bg-[var(--surface-2)] py-1 pr-1 pl-2 text-sm"
          >
            {entity.badge}
            <span className="min-w-0">
              <b className="block max-w-[16ch] overflow-hidden text-ellipsis whitespace-nowrap font-semibold text-[var(--text-strong)]">{entity.name}</b>
              {entity.meta ? <small className="block text-2xs text-[var(--faint)] tabular-nums">{entity.meta}</small> : null}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="shrink-0 hover:text-[var(--loss)]"
              onClick={() => onRemove(entity.id)}
              aria-label={`Remove ${entity.name}`}
            >
              <X aria-hidden="true" />
            </Button>
          </span>
        ))}
        {/* Empty slots make the feature legible before it is used. */}
        {Array.from({ length: Math.max(0, 2 - entities.length) }, (_, index) => (
          <span
            key={`slot-${index}`}
            className="grid h-9 w-11 place-items-center rounded-[var(--r-2)] border border-dashed border-[var(--line-strong)] text-xs text-[var(--faint)] tabular-nums"
            aria-hidden="true"
          >
            {entities.length + index + 1}
          </span>
        ))}
      </div>

      {odds ? (
        <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-2xs whitespace-nowrap text-[var(--faint)]">
            <span>
              {odds.homeCode} <b className="font-bold text-[var(--text-strong)] tabular-nums">{formatPercentValue(odds.homePercent)}</b>
            </span>
            <span className="tabular-nums">{formatSigned(odds.gap)} score gap</span>
            <span>
              <b className="font-bold text-[var(--text)] tabular-nums">{formatPercentValue(100 - odds.homePercent)}</b> {odds.awayCode}
            </span>
          </div>
          <span className="flex h-1.5 overflow-hidden rounded-full bg-[var(--surface-3)]" aria-hidden="true">
            <span className="bg-[var(--accent)]" style={{ width: `${odds.homePercent}%` }} />
          </span>
          <span className="sr-only">
            {odds.homeCode} has a {formatPercentValue(odds.homePercent)} neutral single-game win chance against {odds.awayCode}.
          </span>
        </div>
      ) : (
        <p className="min-w-0 flex-1 text-sm text-[var(--muted)]">
          {entities.length === 0 ? 'Pick two to compare' : `Pick ${2 - entities.length} more`}
          {matchup === undefined ? null : <span className="max-sm:hidden"> to see the matchup odds</span>}
        </p>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {entities.length > 0 ? (
          <Button type="button" variant="ghost" size="sm" onClick={onClear}>
            Clear
          </Button>
        ) : null}
        {/* Outline until it can actually do something. A disabled solid accent
            button still reads as the loudest thing in the bar. */}
        <Button type="button" variant={ready ? 'default' : 'outline'} size="sm" onClick={onOpen} disabled={!ready}>
          {ready && entities.length > 2 ? `Full compare (${entities.length})` : 'Full compare'}
        </Button>
      </div>

      {entities.length >= limit ? (
        <p className="basis-full text-2xs text-[var(--faint)]">Comparing the most recent {limit}. Picking another replaces the oldest.</p>
      ) : null}
    </div>
  )
}

function matchupOdds({
  home,
  away,
  model,
}: {
  home: RankingSummaryStanding
  away: RankingSummaryStanding
  model?: Pick<ModelInfo, 'version' | 'configHash'>
}) {
  // The board's ratings are on the published scale, so the shared estimator
  // does the scale conversion and the uncertainty penalty rather than this
  // component reimplementing either.
  const estimate = estimatePublicMatchup(home, away, model, { bestOf: 1, sideAssumption: 'neutral' })
  return {
    homeCode: home.code ?? home.team.slice(0, 3).toUpperCase(),
    awayCode: away.code ?? away.team.slice(0, 3).toUpperCase(),
    homePercent: Math.round(estimate.homeGameWinProbability * 100),
    gap: Math.round(home.rating - away.rating),
  }
}
