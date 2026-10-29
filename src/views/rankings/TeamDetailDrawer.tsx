import { X } from 'lucide-react'
import { Suspense, useMemo } from 'react'
import type {
  TeamHistoryArtifactState
} from '../../browser/rankings/usePublicArtifacts'
import type { ChartSeries } from '../../components/LineChart'
import { TeamMark } from '../../components/TeamMark'
import { FormDots } from '../../components/ui'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { LoadingState } from '../../components/ui/loading'
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from '../../components/ui/sheet'
import {
  tournamentBoundaryLabel
} from '../../domains/rankings/evidence'
import { eventTierConfig } from '../../domains/rankings/policy'
import type { RankingTierLabel } from '../../domains/rankings/read'
import { estimatePublicMatchup, type PublicMatchupModel } from '../../domains/rankings/read'
import type { CompactPlayer, EventTier, PublicCurrentLineup, PublicTournamentMovementShard, PublicTournamentMovementTeam, RankingSummaryStanding, TeamHistorySeries } from '../../domains/rankings/types'
import { formatDate, formatModelVersion, formatNumber, formatRating, formatRatio, formatRecord, teamKey } from '../../shared/display'
import { cn } from '../../shared/utils'
import { TierBadge } from './BoardCells'
import { activeMovement, formatEventWeight, formatRankMovementLabel, formatRankValue, formatRatingMovement, formatUncertaintyBand, isEventTier, powerResumeGapSummary, rankMovementTone, recordBasisLabel, rollingMovementTitle, teamBoardRankLabel, teamRankFor, teamScoreFor } from './boardFormat'
import { LazyTeamHistoryLineChart } from './historyChart'
import { ComponentBreakdown, PlayerRankingCard } from './PlayerDisclosure'
import { LeagueSigil, RecentMatches } from './RecentMatches'
import { dailyChartPointsFromHistoryPoints, tournamentChartPoints } from './teamHistoryChart'
import { type PlayerLoadState } from './types'

type RankEvidenceSummary = {
  label: string
  detail: string
  title: string
}

function summarizeRankEvidence(team: RankingSummaryStanding, standings: readonly RankingSummaryStanding[]): RankEvidenceSummary | null {
  const score = teamScoreFor(team)
  const uncertainty = team.ratingComponents?.uncertainty ?? team.uncertainty
  if (typeof score !== 'number' || typeof uncertainty !== 'number' || !Number.isFinite(score) || !Number.isFinite(uncertainty)) {
    return null
  }

  const teamKeyValue = teamKey(team)
  const rankedRows = standings.filter((standing) => {
    if (team.eligibility?.eligible !== false && standing.eligibility?.eligible === false) return false
    return typeof teamScoreFor(standing) === 'number' && Number.isFinite(teamScoreFor(standing))
  })
  const high = score + Math.max(0, uncertainty)
  const low = score - Math.max(0, uncertainty)
  const bestRank = 1 + rankedRows.filter((standing) => teamKey(standing) !== teamKeyValue && (teamScoreFor(standing) ?? -Infinity) > high).length
  const worstRank = Math.max(bestRank, 1 + rankedRows.filter((standing) => teamKey(standing) !== teamKeyValue && (teamScoreFor(standing) ?? -Infinity) > low).length)
  const label = bestRank === worstRank
    ? formatRankValue(bestRank)
    : `${formatRankValue(bestRank)}-${formatRankValue(worstRank)}`
  return {
    label,
    detail: `from the ${formatUncertaintyBand(uncertainty)} model evidence band`,
    title: `Model evidence band ${formatRating(low)}-${formatRating(high)} compared against current ranked teams.`,
  }
}

type MatchWeightSummary = {
  label: string
  detail: string
  title: string
}

function summarizeTeamMatchWeights(series?: TeamHistorySeries): MatchWeightSummary | null {
  const summaries = new Map<EventTier, { count: number; maximumWeight: number }>()
  for (const point of series?.points ?? []) {
    const tier = point[3]?.tier
    if (!isEventTier(tier)) continue
    const configuredWeight = eventTierConfig[tier].weight
    const appliedWeight = point[3]?.model?.w
    const current = summaries.get(tier) ?? { count: 0, maximumWeight: 0 }
    summaries.set(tier, {
      count: current.count + 1,
      maximumWeight: Math.max(current.maximumWeight, typeof appliedWeight === 'number' ? appliedWeight : configuredWeight),
    })
  }
  const entries = [...summaries.entries()]
  if (entries.length === 0) return null
  const [tier, summary] = entries.sort(([, left], [, right]) => right.maximumWeight - left.maximumWeight)[0]
  const config = eventTierConfig[tier]
  const events = [...new Set((series?.points ?? []).filter((point) => point[3]?.tier === tier).map((point) => point[3]?.event).filter(Boolean))]
  return {
    label: `Up to ${formatEventWeight(summary.maximumWeight)}`,
    detail: `${events.join(', ')} · ${formatNumber(summary.count)} series`,
    title: `${config.label} weighting tier (shared across events). ${config.description}`,
  }
}

const tournamentDataNoteClassName = 'mx-5 mb-5 border-t border-border pt-3 text-xs leading-[1.5] text-muted-foreground'

export function TeamDetailDrawer({
  team,
  standings,
  rankedStandings,
  model,
  tier,
  series,
  historyState,
  tournament,
  tournamentMovement,
  players,
  currentLineup,
  playerLoadState,
  playerScopeLabel,
  onRequestPlayers,
  seeded,
  onClose,
}: {
  team: RankingSummaryStanding
  standings: readonly RankingSummaryStanding[]
  rankedStandings: readonly RankingSummaryStanding[]
  model?: PublicMatchupModel
  tier?: RankingTierLabel
  series?: TeamHistorySeries
  historyState: TeamHistoryArtifactState
  tournament?: PublicTournamentMovementShard
  tournamentMovement?: PublicTournamentMovementTeam
  players: CompactPlayer[]
  currentLineup?: PublicCurrentLineup
  playerLoadState: PlayerLoadState
  playerScopeLabel?: string
  onRequestPlayers?: () => void
  seeded: boolean
  onClose: () => void
}) {
  const trendSeries = useMemo<ChartSeries[]>(() => {
    if (!series || series.points.length < 2) return []
    return [{
      id: teamKey(team),
      label: team.code ?? team.team,
      color: 'var(--series-1)',
      points: tournament ? tournamentChartPoints(series.points, 'rating') : dailyChartPointsFromHistoryPoints(series.points),
    }]
  }, [series, team, tournament])

  const totalGames = team.wins + team.losses
  const opponentFactor = Math.round((team.factors?.opponent ?? 0) * 100)
  const trendSummary = useMemo(() => summarizeTeamTrend(series), [series])
  const score = teamScoreFor(team)
  const rank = teamRankFor(team)
  const rankEvidence = useMemo(() => summarizeRankEvidence(team, standings), [team, standings])
  const weightSummary = useMemo(() => summarizeTeamMatchWeights(series), [series])
  const powerResumeGap = powerResumeGapSummary(team)
  const movement = activeMovement(team)
  const opponents = useMemo(() => wouldBeatOdds(team, rankedStandings, model), [team, rankedStandings, model])
  const drawerLoading = [
    historyState.status === 'loading' ? 'rating and match history' : '',
    playerLoadState.status === 'loading' ? 'player rankings' : '',
  ].filter(Boolean).join(' and ')

  return (
    <Sheet open onOpenChange={(nextOpen) => {
      if (!nextOpen) onClose()
    }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-label={`${team.team} details`}
        aria-modal="true"
        className="team-detail-sheet h-dvh max-h-dvh gap-0 overflow-hidden border-l border-[var(--line-strong)] bg-[var(--detail-surface)] p-0 text-foreground shadow-[var(--shadow-pop)] [--detail-surface-2:var(--surface-2)] [--detail-surface-3:var(--surface-3)] [--detail-surface:var(--surface)] data-[side=right]:w-[min(820px,100vw)] data-[side=right]:max-w-none data-[side=right]:sm:w-[min(820px,94vw)] data-[side=right]:sm:max-w-none"
      >
        {drawerLoading ? <p className="sr-only" role="status" aria-live="polite">Loading {drawerLoading} for {team.team}.</p> : null}
        {/* The title is the team. Rank and Power sit beside it at the size the
            product exists to show. */}
        <SheetHeader className="flex-row items-center gap-3.5 border-b border-border bg-[var(--detail-surface)] px-5 py-4 text-left max-sm:p-3.5">
          <TeamMark team={team.team} code={team.code} className="size-11" />
          <div className="mr-auto grid min-w-0 gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <SheetTitle className="text-lg font-semibold text-[var(--text-strong)]">{team.team}</SheetTitle>
              {seeded ? <Badge variant="warning">Sample data</Badge> : null}
            </div>
            <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <LeagueSigil league={team.league} />
              {team.league}
              {tier ? <TierBadge tier={tier} /> : null}
            </span>
          </div>
          <div className="grid shrink-0 justify-items-end leading-none">
            <span className="text-2xl font-semibold text-[var(--text-strong)] tabular-nums">{teamBoardRankLabel(team, rank)}</span>
            <span className="mt-1 text-sm text-muted-foreground tabular-nums">{formatRating(score)} Power</span>
          </div>
          <SheetClose asChild>
            <Button type="button" variant="ghost" size="icon" aria-label="Close">
              <X size={18} aria-hidden="true" />
            </Button>
          </SheetClose>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain bg-[var(--detail-surface)] p-4 [&>*]:shrink-0 max-sm:gap-3 max-sm:p-3">
          <section className="grid grid-cols-4 gap-px overflow-hidden rounded-md border border-border bg-border max-[700px]:grid-cols-2 [&>div]:grid [&>div]:content-start [&>div]:gap-0.5 [&>div]:bg-[var(--detail-surface-2)] [&>div]:px-3.5 [&>div]:py-3 [&_b]:text-base [&_b]:font-bold [&_b]:text-[var(--text-strong)] [&_b]:tabular-nums [&_small]:text-xs [&_small]:text-[var(--faint)]" aria-label={`${team.team} key facts`}>
            {tournament && tournamentMovement ? (
              <>
                <div><small>Opening</small><b>{formatRankValue(tournamentMovement.startRank)} · {formatRating(tournamentMovement.startRating)}</b><small>{formatDate(tournament.startDate)}</small></div>
                <div><small>{tournamentBoundaryLabel(tournament.status)}</small><b>{formatRankValue(tournamentMovement.endRank)} · {formatRating(tournamentMovement.endRating)}</b><small>{formatDate(tournament.boundaryDate)}</small></div>
                <div><small>Record in event</small><b>{formatRecord(team.wins, team.losses)}</b><small>{formatRatio(totalGames > 0 ? team.wins / totalGames : undefined)} of scored series</small></div>
                <div><small>Net movement</small><b className={cn(rankMovementTone(tournamentMovement.rankMovement) === 'up' && 'text-[var(--up)]!', rankMovementTone(tournamentMovement.rankMovement) === 'down' && 'text-[var(--down)]!')}>{formatRankMovementLabel(tournamentMovement.rankMovement)}</b><small>{formatRatingMovement(tournamentMovement.ratingDelta)} Power</small></div>
              </>
            ) : (
              <>
                <div title={rankEvidence?.title}><small>Rank from evidence band</small><b>{rankEvidence?.label ?? 'Unavailable'}</b><small>model evidence band</small></div>
                <div title={rollingMovementTitle(team, 'last 30 days')}><small>Last 30 days</small><b className={cn(movement && (movement.rankMovement ?? 0) > 0 && 'text-[var(--up)]!', movement && (movement.rankMovement ?? 0) < 0 && 'text-[var(--down)]!')}>{movement ? formatRankMovementLabel(movement.rankMovement) : 'No series'}</b><small>{movement ? `${formatRatingMovement(movement.ratingDelta ?? 0)} Power` : 'no scored matches'}</small></div>
                <div><small>Record</small><b>{formatRecord(team.wins, team.losses)}</b><small>{formatRatio(totalGames > 0 ? team.wins / totalGames : undefined)} · {recordBasisLabel(team.recordBasis)}</small></div>
                <div title={powerResumeGap?.title}><small>Rank on results alone</small><b>{team.deservedStanding?.rank ? `#${team.deservedStanding.rank}` : 'Unavailable'}</b><small>{powerResumeGap?.rankDetail ?? 'results rank unavailable'}</small></div>
              </>
            )}
          </section>

          <section className="overflow-hidden rounded-md border border-[var(--line-strong)] bg-[var(--detail-surface-2,var(--surface))]" aria-label="Power over time">
            <div className="grid gap-2 border-b border-border px-5 pt-4 pb-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-base font-semibold text-[var(--text-strong)]">{tournament ? `${tournament.label} movement` : 'Power this season'}</h3>
                {trendSummary ? (
                  <p className="text-xs text-muted-foreground tabular-nums">
                    From {formatRating(trendSummary.opening)} on {formatDate(trendSummary.startDate)} · net <b className={cn('font-semibold', trendSummary.netChange >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]')}>{formatRatingMovement(trendSummary.netChange)}</b> · peak {formatRating(trendSummary.peak.value)}{typeof trendSummary.bestRank === 'number' ? ` · best #${trendSummary.bestRank}` : ''}
                  </p>
                ) : null}
              </div>
              {trendSeries.length > 0 ? (
                <p className="text-xs leading-[1.5] text-muted-foreground">Power is a model rating. Hover, tap or use arrow keys to inspect the recorded evidence below.</p>
              ) : null}
            </div>
            {trendSeries.length > 0 ? (
              <div className="px-2 pb-2 [&_.chart_svg]:min-h-[240px]">
                <Suspense fallback={<TrendChartSkeleton />}>
                  <LazyTeamHistoryLineChart series={trendSeries} height={280} yLabel="Power" />
                </Suspense>
              </div>
            ) : historyState.status === 'loading' ? (
              <TrendChartSkeleton />
            ) : historyState.status === 'missing' || historyState.status === 'error' ? (
              <p className="p-5 text-muted-foreground">{historyState.message}</p>
            ) : (
              <p className="p-5 text-muted-foreground">{historyState.status === 'idle' ? 'Rating history loads when this panel opens.' : 'Not enough history to chart this team yet.'}</p>
            )}
            {tournament ? (
              <p className={tournamentDataNoteClassName}>
                {tournamentBoundaryLabel(tournament.status)} {formatDate(tournament.boundaryDate)} · rated through {formatDate(tournament.ratedThroughDate)}
                {tournament.scheduledEndDate ? ` · scheduled end ${formatDate(tournament.scheduledEndDate)}` : ''}
                {tournament.dataLag ? ' · schedule results are ahead of rated evidence' : ''}
                {` · model ${formatModelVersion(tournament.modelVersion)}`}
              </p>
            ) : null}
          </section>

          {opponents.length > 0 ? (
            <section className="rounded-md border border-[var(--line-strong)] bg-[var(--detail-surface-2,var(--surface))] px-5 py-4" aria-label={`${team.code ?? team.team} against the top teams`}>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-base font-semibold text-[var(--text-strong)]">Chance to beat the top teams</h3>
                <span className="text-xs text-[var(--faint)]">best of three, neutral side · model {formatModelVersion(model?.version)}</span>
              </div>
              <ul className="grid gap-2">
                {opponents.map(({ opponent, chance }) => (
                  <li className="grid grid-cols-[56px_minmax(0,1fr)_44px] items-center gap-3 text-sm" key={teamKey(opponent)} title={`${team.team} vs ${opponent.team}: ${chance}% to win a best of three`}>
                    <b className="truncate font-mono font-bold text-[var(--text-strong)]">{opponent.code ?? opponent.team}</b>
                    <span className="relative h-2.5 overflow-hidden rounded-full bg-[var(--surface-3)]" aria-hidden="true">
                      <span className="absolute inset-y-0 left-0 rounded-full bg-[var(--series-1)]" style={{ width: `${chance}%` }} />
                      <span className="absolute inset-y-[-2px] left-1/2 w-px bg-muted-foreground" />
                    </span>
                    <b className="text-right font-semibold text-[var(--text-strong)] tabular-nums">{chance}%</b>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="overflow-hidden rounded-md border border-[var(--line-strong)] bg-[var(--detail-surface-2,var(--surface))] p-5 max-[900px]:p-4" aria-label="Match results">
            <div className="flex items-start justify-between gap-3.5 border-b border-[var(--line-strong)] pb-4 max-sm:flex-col">
              <h3 className="text-base font-semibold text-[var(--text-strong)]">Match results</h3>
              <FormDots form={team.form} />
            </div>
            <RecentMatches
              matches={team.recentMatches}
              series={series}
              standings={standings}
              historyState={historyState}
              seriesOnly={Boolean(tournament)}
            />
          </section>

          <details className="rounded-md border border-border bg-[var(--detail-surface-2)] p-3">
            <summary className="cursor-pointer text-sm font-semibold">How the score is built</summary>
            <p className="mt-3 text-sm text-muted-foreground">League strength plus this team's results, roster and form. Evidence band {formatUncertaintyBand(team.ratingComponents?.uncertainty ?? team.uncertainty)}.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 [&_small]:block [&_small]:text-xs [&_small]:text-muted-foreground [&_b]:block [&_em]:block [&_em]:text-xs [&_em]:not-italic [&_em]:text-muted-foreground">
              {!tournament ? (
                <span title={powerResumeGap?.title}>
                  <small>Power rank vs results rank</small>
                  <b>{powerResumeGap?.label ?? 'No results check'}</b>
                  <em>{powerResumeGap?.detail ?? 'results rank unavailable'}</em>
                </span>
              ) : null}
              <span>
                <small>Most important events</small>
                <b title={weightSummary?.title}>{weightSummary?.label ?? 'Pending'}</b>
                <em>{weightSummary?.detail ?? 'match rows show each event weight'}</em>
              </span>
              {!tournament ? (
                <span title="Normalized opponent strength across this team's scored schedule.">
                  <small>Schedule strength</small>
                  <b>{opponentFactor}%</b>
                  <em>of the strongest possible schedule</em>
                </span>
              ) : null}
              {!tournament ? (
                <span>
                  <small>Roster coverage</small>
                  <b>{team.deservedStanding ? formatRatio(team.deservedStanding.rosterValidity) : 'Match-based'}</b>
                  <em>{team.deservedStanding?.eligibility ?? (team.eligibility?.eligible === false ? 'Limited evidence' : 'Enough evidence to rank')}</em>
                </span>
              ) : null}
              {tournamentMovement ? (
                <span>
                  <small>Endpoint eligibility</small>
                  <b>{tournamentMovement.eligible ? 'Ranked' : 'Unranked'}</b>
                  <em>{tournamentMovement.eligibilityReasons.join(', ') || 'ranking checks passed'}</em>
                </span>
              ) : null}
            </div>
            {tournament ? null : <div className="mt-3"><ComponentBreakdown team={team} /></div>}
          </details>
          <details className="rounded-md border border-border p-3" onToggle={(event) => {
            if (event.currentTarget.open) onRequestPlayers?.()
          }}>
            <summary className="cursor-pointer text-sm font-semibold">Players</summary>
            <PlayerRankingCard team={team} players={players} currentLineup={currentLineup} loadState={playerLoadState} playerScopeLabel={playerScopeLabel} />
          </details>
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** Best-of-three chances against the top five ranked teams other than this one. */
function wouldBeatOdds(team: RankingSummaryStanding, rankedStandings: readonly RankingSummaryStanding[], model?: PublicMatchupModel) {
  if (team.eligibility?.eligible === false) return []
  return rankedStandings
    .filter((other) => teamKey(other) !== teamKey(team))
    .slice(0, 5)
    .map((opponent) => ({
      opponent,
      chance: Math.round(estimatePublicMatchup(team, opponent, model, { bestOf: 3 }).homeSeriesWinProbability * 100),
    }))
}

function TrendChartSkeleton() {
  return <LoadingState presentation="chart" className="trend-chart-skeleton" label="Loading rating trajectory" announce={false} />
}

type TeamTrendSummary = {
  opening: number
  current: number
  netChange: number
  startDate: string
  endDate: string
  pointCount: number
  peak: { value: number; date: string }
  bestRank?: number
}

function summarizeTeamTrend(series?: TeamHistorySeries): TeamTrendSummary | null {
  if (!series || series.points.length < 2) return null
  const points = series.points
  const first = points[0]
  const last = points.at(-1)!
  let peak = { value: first[1], date: first[0] }
  let bestRank: number | undefined
  for (const point of points) {
    if (point[1] > peak.value) peak = { value: point[1], date: point[0] }
    const rank = point[2]
    if (Number.isFinite(rank) && rank > 0) bestRank = typeof bestRank === 'number' ? Math.min(bestRank, rank) : rank
  }
  return {
    opening: first[1],
    current: last[1],
    netChange: last[1] - first[1],
    startDate: first[0],
    endDate: last[0],
    pointCount: points.length,
    peak,
    bestRank,
  }
}
