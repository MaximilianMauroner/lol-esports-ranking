import { useMemo } from 'react'
import { CountBadge, HeatChip } from '../../components/ui'
import { Badge } from '../../components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { POWER_COMPONENT_LABELS } from '../../domains/rankings/read'
import type { CompactPlayer, PublicCurrentLineup, RankingSummaryStanding } from '../../domains/rankings/types'
import { extent, formatDate, formatDecimal, formatNumber, formatRating } from '../../shared/display'
import { cn } from '../../shared/utils'
import { clampNumber, formatRatingMovement, formatUncertaintyBand, movementTone } from './boardFormat'
import { componentLedgerRowClassName, detailCardClassName, emptyPlayerRankCardClassName, playerRankCardHeadClassName } from './detailStyles'
import { PlayerPerformancePanel } from './PlayerPerformancePanel'
import { type PlayerLoadState } from './types'

export function PlayerRankingCard({
  team,
  players,
  currentLineup,
  loadState,
  playerScopeLabel = 'the current scope',
}: {
  team: RankingSummaryStanding
  players: CompactPlayer[]
  currentLineup?: PublicCurrentLineup
  loadState: PlayerLoadState
  playerScopeLabel?: string
}) {
  const [ratingMin, ratingMax] = useMemo(() => extent(players.map((player) => player.rating)), [players])
  const observedLineupIds = new Set(currentLineup?.starters.map((player) => player.playerId) ?? [])

  if (players.length === 0) {
    if (loadState.status === 'loading') {
      return (
        <aside className={emptyPlayerRankCardClassName} aria-label={`${team.team} player rankings`}>
          <div className={playerRankCardHeadClassName}>
            <div>
              <h3>
                Player Rankings
                <CountBadge>Loading</CountBadge>
              </h3>
              <p>Loading players.</p>
            </div>
          </div>
          <PlayerRankingSkeleton />
        </aside>
      )
    }

    if (loadState.status === 'idle') {
      return (
        <aside className={emptyPlayerRankCardClassName} aria-label={`${team.team} player rankings`}>
          <div className={playerRankCardHeadClassName}>
            <h3>Player Rankings</h3>
          </div>
        </aside>
      )
    }

    if (loadState.status === 'missing' || loadState.status === 'error') {
      return (
        <aside className={emptyPlayerRankCardClassName} aria-label={`${team.team} player rankings`}>
          <div className={playerRankCardHeadClassName}>
            <div>
              <h3>
                Player Rankings
                <CountBadge>Unavailable</CountBadge>
              </h3>
              <p>{loadState.message}</p>
            </div>
          </div>
        </aside>
      )
    }

    return (
      <aside className={emptyPlayerRankCardClassName} aria-label={`${team.team} player rankings`}>
        <div className={playerRankCardHeadClassName}>
          <div>
            <h3>
              Player Rankings
              <CountBadge>Source gap</CountBadge>
            </h3>
            <p>No player data in {playerScopeLabel}.</p>
          </div>
        </div>
      </aside>
    )
  }

  return (
    <div className={detailCardClassName}>
      <div className={playerRankCardHeadClassName}>
        <div>
          <h3>Player Rankings</h3>
          <p>
            {currentLineup
              ? `Last lineup ${formatDate(currentLineup.observedAt)}${currentLineup.observedEvent ? ` at ${currentLineup.observedEvent}` : ''}`
              : `Career rows in ${playerScopeLabel}`}
          </p>
          {currentLineup?.missingRoles.length ? <small>Missing roles: {currentLineup.missingRoles.join(', ')}</small> : null}
        </div>
        <CountBadge>{players.length} players</CountBadge>
      </div>

        <Table containerClassName="player-rank-table mt-4 max-h-[360px] overflow-auto rounded-md border border-border max-sm:max-h-none max-sm:overflow-visible [&_.right]:text-right [&_.ent_b]:block [&_.ent_b]:overflow-hidden [&_.ent_b]:text-ellipsis [&_.ent_b]:whitespace-nowrap [&_.ent_small]:block [&_.ent_small]:overflow-hidden [&_.ent_small]:text-ellipsis [&_.ent_small]:whitespace-nowrap [&_table]:w-full [&_table]:table-fixed [&_table]:border-collapse [&_table]:max-sm:block [&_tbody]:max-sm:block [&_td]:border-b [&_td]:border-border [&_td]:px-2 [&_td]:py-2.5 [&_td]:text-left [&_td]:align-middle [&_td]:text-sm [&_th]:sticky [&_th]:top-0 [&_th]:z-[1] [&_th]:border-b [&_th]:border-border [&_th]:bg-[var(--detail-surface-3,var(--surface-3))] [&_th]:py-2.5 [&_tr:last-child_td]:border-b-0">
          <TableHeader>
            <TableRow>
              <TableHead>Rank</TableHead>
              <TableHead>Player</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="text-right">Rating</TableHead>
              <TableHead className="text-right" title="Team games">Games</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {players.map((player) => (
              <TableRow key={player.id} className="hover:bg-transparent">
                <TableCell className={cn('font-mono font-semibold text-muted-foreground tabular-nums', player.rank <= 3 && 'text-[var(--rank-gold)]')}>#{player.rank}</TableCell>
                <TableCell>
                  <div className="flex flex-col gap-px [&_b]:font-semibold [&_b]:text-[var(--text-strong)] [&_small]:text-xs [&_small]:text-[var(--faint)]">
                    <b>{player.name}</b>
                    <small>
                      {observedLineupIds.has(player.playerId ?? player.id)
                        ? 'Last observed starter'
                        : 'Historical affiliation'} · impact ×{formatDecimal(player.impactMultiplier)}
                    </small>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="whitespace-nowrap text-xs">{player.role}</Badge>
                </TableCell>
                <TableCell className="right">
                  <HeatChip value={player.rating} min={ratingMin} max={ratingMax} label={formatRating(player.rating)} />
                </TableCell>
                <TableCell className="right num">{formatTeamGames(player)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <PlayerPerformancePanel players={players} scopeLabel={playerScopeLabel} />
    </div>
  )
}

function PlayerRankingSkeleton() {
  return (
    <div className="player-rank-skeleton" aria-hidden="true">
      {Array.from({ length: 5 }, (_, index) => (
        <div className="player-rank-skeleton__row" key={index} aria-hidden="true">
          <span className="detail-skeleton detail-skeleton--rank" />
          <span className="player-rank-skeleton__main">
            <span className="detail-skeleton detail-skeleton--line is-wide" />
            <span className="detail-skeleton detail-skeleton--line is-short" />
          </span>
          <span className="detail-skeleton detail-skeleton--chip is-short" />
          <span className="player-rank-skeleton__score">
            <span className="detail-skeleton detail-skeleton--line is-score" />
          </span>
        </div>
      ))}
    </div>
  )
}

export function ComponentBreakdown({ team }: { team: RankingSummaryStanding }) {
  const components = team.ratingComponents
  if (!components) return null
  const contributionRows = [
    { label: POWER_COMPONENT_LABELS.stable, value: components.teamStableOffset },
    { label: POWER_COMPONENT_LABELS.roster, value: components.rosterPriorOffset },
    { label: POWER_COMPONENT_LABELS.form, value: components.momentum },
    { label: POWER_COMPONENT_LABELS.context, value: components.contextAdjustment },
  ].filter((row) => Math.abs(row.value) >= 0.5)
  const maxComponentMagnitude = Math.max(
    Math.abs(components.leagueAnchor),
    ...contributionRows.map((row) => Math.abs(row.value)),
  )

  return (
    <div className={cn(detailCardClassName, 'px-5 py-4')} aria-label={`${team.team} rating components`}>
      <div className="mb-3.5 flex items-start justify-between gap-3 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-[var(--text-strong)] [&_p]:mt-1 [&_p]:text-sm [&_p]:leading-[1.4] [&_p]:text-[var(--faint)] [&>span]:shrink-0 [&>span]:text-sm [&>span]:font-bold [&>span]:text-muted-foreground [&>span]:tabular-nums">
        <h3>Power Score Breakdown</h3>
        <span>{formatRating(team.rating)} {formatUncertaintyBand(components.uncertainty)}</span>
      </div>
      <div className="grid gap-px overflow-hidden rounded-md border border-border bg-border">
        <div className={cn(componentLedgerRowClassName, 'bg-[var(--detail-surface-3,var(--surface-3))]')} title="League anchor baseline before team-specific adjustments.">
          <span>{POWER_COMPONENT_LABELS.league}</span>
          <b>{formatRating(components.leagueAnchor)}</b>
          <ComponentBar value={components.leagueAnchor} max={maxComponentMagnitude} />
        </div>
        {contributionRows.map((row) => (
          <div className={componentLedgerRowClassName} key={row.label}>
            <span>{row.label}</span>
            <b className={movementTone(row.value)}>{formatRatingMovement(row.value)}</b>
            <ComponentBar value={row.value} max={maxComponentMagnitude} />
          </div>
        ))}
        <div className={cn(componentLedgerRowClassName, 'border-t border-[var(--line-strong)] bg-[var(--detail-surface-3,var(--surface-3))]')}>
          <span>Power score</span>
          <b>{formatRating(team.rating)}</b>
        </div>
      </div>
    </div>
  )
}

function ComponentBar({ value, max }: { value: number; max: number }) {
  const width = max > 0 ? clampNumber((Math.abs(value) / max) * 100, 2, 100) : 0
  return (
    <span className="relative col-span-full block h-1 overflow-hidden rounded-full bg-[color-mix(in_oklch,var(--line)_68%,transparent)]" aria-hidden="true">
      <span className={cn('absolute inset-y-0 left-0 block min-w-0.5 rounded-[inherit]', value < 0 ? 'bg-[color-mix(in_oklch,var(--down)_82%,transparent)]' : 'bg-[color-mix(in_oklch,var(--up)_76%,var(--accent-strong))]')} style={{ width: `${width}%` }} />
    </span>
  )
}

function formatTeamGames(player: CompactPlayer) {
  const teamGames = player.teamGames ?? player.appearance?.latestTeamGames
  if (typeof teamGames !== 'number') return formatNumber(player.games)
  return `${formatNumber(teamGames)} / ${formatNumber(player.games)}`
}
