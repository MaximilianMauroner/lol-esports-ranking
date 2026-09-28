import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { RankingSummaryStanding } from '../lib/snapshot'
import { estimatePublicMatchup, type PublicMatchupModel } from '../lib/publicMatchup'
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
 * Comparison tray, fixed to the bottom of the Rankings and Regions views.
 *
 * It is visible before the first pick, with empty slots and a sentence that
 * says what picking does, so the feature is legible before it is used. Two
 * team picks answer the question most people are asking inline: the chance
 * each side wins a single game and a best-of-five. The full comparison is one
 * button away.
 */
export function CompareDock({
  subject,
  entities,
  limit,
  matchup,
  onRemove,
  onClear,
  onOpen,
  className,
}: {
  subject: 'teams' | 'regions'
  entities: CompareDockEntity[]
  limit: number
  /** Only supplied by the team board. Regions have no matchup model. */
  matchup?: { home: RankingSummaryStanding; away: RankingSummaryStanding; model?: PublicMatchupModel }
  onRemove: (id: string) => void
  onClear: () => void
  onOpen: () => void
  className?: string
}) {
  const ready = entities.length >= 2
  const odds = ready && matchup ? matchupOdds(matchup) : undefined

  return (
    <div
      className={cn('mx-auto flex min-h-11 max-w-[1400px] items-center gap-x-3 gap-y-1.5 max-sm:flex-wrap', className)}
      role="region"
      aria-label={`Compare ${subject}: ${entities.length} selected`}
    >
      <b className="shrink-0 text-sm font-semibold text-[var(--text-strong)] max-sm:sr-only">Compare</b>
      <div className="flex min-w-0 items-center gap-1.5">
        {entities.map((entity) => (
          <span
            key={entity.id}
            className="inline-flex min-w-0 items-center gap-1.5 rounded-[var(--r-2)] border border-[var(--selected-line)] bg-[var(--selected-bg)] py-0.5 pr-0.5 pl-2 text-sm"
            title={entity.meta ? `${entity.name} · ${entity.meta}` : entity.name}
          >
            {entity.badge}
            <b className="max-w-[10ch] overflow-hidden text-ellipsis whitespace-nowrap font-semibold text-[var(--text-strong)]">{entity.code}</b>
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
            className="grid h-8 w-11 place-items-center rounded-[var(--r-2)] border border-dashed border-[var(--line-strong)] text-xs text-[var(--faint)] tabular-nums"
            aria-hidden="true"
          >
            {entities.length + index + 1}
          </span>
        ))}
      </div>

      {odds ? (
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <p className="shrink-0 text-sm whitespace-nowrap text-[var(--muted)]">
            <b className="font-semibold text-[var(--text-strong)]">{odds.homeCode} {odds.game}%</b> per game
            <span className="max-md:hidden"> · <b className="font-semibold text-[var(--text)]">{odds.bo5}%</b> in a Bo5</span>
          </p>
          <span className="flex h-2 min-w-[80px] max-w-[240px] flex-1 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
            <span className="rounded-l-full bg-[var(--series-1)]" style={{ width: `${odds.game}%` }} />
            <span className="rounded-r-full bg-[var(--series-2)]" style={{ width: `${100 - odds.game}%` }} />
          </span>
          <span className="sr-only">{odds.awayCode} {100 - odds.game}% per game.</span>
        </div>
      ) : (
        <p className="min-w-0 flex-1 text-sm text-[var(--muted)]">
          {ready
            ? `${entities.length} ${subject} selected.`
            : entities.length === 0
              ? subject === 'teams' ? 'Tick Compare on two teams to see who would win.' : 'Tick Compare on two regions to put them side by side.'
              : `Pick one more ${subject === 'teams' ? 'team' : 'region'}.`}
        </p>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {entities.length > 0 ? (
          <Button type="button" variant="ghost" size="sm" onClick={onClear}>
            Clear
          </Button>
        ) : null}
        {/* Outline until it can actually do something. A disabled solid accent
            button still reads as the loudest thing in the bar. */}
        <Button type="button" variant={ready ? 'default' : 'outline'} size="sm" onClick={onOpen} disabled={!ready}>
          Open comparison
        </Button>
      </div>

      {entities.length >= limit ? (
        <p className="basis-full text-2xs text-[var(--faint)]">Comparing the latest {limit}. Picking another replaces the oldest.</p>
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
  model?: PublicMatchupModel
}) {
  // The board's ratings are on the published scale, so the shared estimator
  // does the scale conversion and the uncertainty penalty rather than this
  // component reimplementing either.
  const estimate = estimatePublicMatchup(home, away, model, { bestOf: 5, sideAssumption: 'neutral' })
  return {
    homeCode: home.code ?? home.team.slice(0, 3).toUpperCase(),
    awayCode: away.code ?? away.team.slice(0, 3).toUpperCase(),
    game: Math.round(estimate.homeGameWinProbability * 100),
    bo5: Math.round(estimate.homeSeriesWinProbability * 100),
  }
}
