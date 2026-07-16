import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, Check, ChevronLeft, ChevronRight, Globe2, Info, Plus, Swords, Trophy, X } from 'lucide-react'
import {
  displayRegionPowerScore,
  displayRegionTotalTeamRating,
  isRegionPowerTeam,
  type RegionStrength,
} from '../lib/regionStrength'
import type { PublicMatchHistoryEntry, PublicRegionHistoryScope, PublicRegionHistorySeries, PublicTeamStanding } from '../lib/publicArtifacts/schema'
import type { MatchHistoryState } from '../hooks/usePublicArtifacts'
import { useHistoryDetail } from '../hooks/useHistoryDetail'
import {
  extent,
  formatDate,
  formatDecimal,
  formatNumber,
  formatRating,
  formatRatio,
  formatRecord,
  formatSigned,
  pctWithin,
} from '../lib/display'
import { DataState, RegionBadge } from '../components/ui'
import { Button } from '../components/ui/button'
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from '../components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { cn } from '../lib/utils'

export function RegionsView({
  regions,
  standings,
  regionHistory,
  matchHistoryState,
  onRequestMatchHistoryPages,
  pickedIds,
  onToggle,
  onRequestRegionHistory,
}: {
  regions: RegionStrength[]
  standings: RegionStanding[]
  regionHistory?: PublicRegionHistoryScope
  matchHistoryState: MatchHistoryState
  onRequestMatchHistoryPages: (pages: number[]) => void
  pickedIds: Set<string>
  onToggle: (region: RegionStrength) => void
  onRequestRegionHistory?: () => void
}) {
  const { value: selectedRegionId, open: openRegionDetail, close: closeRegionDetail } = useHistoryDetail('regionDetail')
  const [min, max] = useMemo(() => extent(regions.map(displayRegionPowerScore)), [regions])
  const strongest = useMemo(
    () => [...regions].sort((a, b) => displayRegionPowerScore(b) - displayRegionPowerScore(a))[0],
    [regions],
  )
  const bestRecord = useMemo(
    () => [...regions].sort((a, b) => (b.opponentAdjustedWinRate ?? 0) - (a.opponentAdjustedWinRate ?? 0))[0],
    [regions],
  )
  const selectedRegion = useMemo(
    () => regions.find((region) => region.region === selectedRegionId) ?? null,
    [regions, selectedRegionId],
  )
  const selectedRegionTeams = useMemo(
    () => selectedRegion ? flagshipTeamsForRegion(selectedRegion, standings) : [],
    [selectedRegion, standings],
  )

  if (regions.length === 0) {
    return (
      <div className="flex min-w-0 flex-col gap-[22px] px-[var(--page-x)] pt-6">
        <DataState icon={<Globe2 size={26} aria-hidden="true" />} title="No regional data in this scope">
          This snapshot has no league-anchored regions. Try a broader scope.
        </DataState>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-[22px] px-[var(--page-x)] pt-6">
      <p className="max-w-[70ch] text-[0.9rem] leading-[1.55] text-[var(--muted)]">
        Region power uses the average Power Index of the three strongest ranked teams. Each row compares that with the average across all ranked teams:
        a small gap means greater regional depth, while a large gap means the region is more top-heavy.
      </p>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-px overflow-hidden rounded-[var(--r-lg)] border border-[var(--line-strong)] bg-[var(--line-strong)]">
        <RibbonCell icon={<Trophy size={18} />} label="Strongest region" value={strongest?.region ?? '—'} detail={`Region power ${formatRating(strongest ? displayRegionPowerScore(strongest) : undefined)}`} />
        <RibbonCell icon={<Globe2 size={18} />} label="Regions tracked" value={String(regions.length)} detail="Excludes international events" />
        <RibbonCell
          icon={<Swords size={18} />}
          label="Best international resume"
          value={bestRecord?.region ?? '—'}
          detail={`${formatRatio(bestRecord?.opponentAdjustedWinRate)} adjusted · ${formatSignedDecimal(bestRecord?.winsOverExpected)} vs expected`}
        />
      </div>

      <section className="min-w-0 overflow-hidden rounded-[var(--r-lg)] border border-[var(--line-strong)] bg-[var(--surface)]">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--line)] bg-[var(--surface-2)] px-[18px] py-4 max-sm:grid max-sm:items-start [&_.eyebrow]:text-[0.66rem] [&_.eyebrow]:tracking-[0.14em] [&_.eyebrow]:text-[var(--faint)] [&_.eyebrow]:uppercase [&_h2]:text-base [&_h2]:font-[660] [&_h2]:text-[var(--text-strong)]">
          <div>
            <p className="eyebrow">Regional standings</p>
            <h2>Select a region to explore its history</h2>
          </div>
        </div>

        <div className="flex flex-col">
          {regions.map((region) => {
            const picked = pickedIds.has(region.region)

            return (
              <div
                key={region.region}
                className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-center border-t border-[var(--line)] transition-[background] duration-150 first:border-t-0 hover:bg-[var(--surface-2)] max-sm:grid-cols-[minmax(0,1fr)_62px]', picked && 'bg-[var(--accent-soft)] shadow-[inset_3px_0_0_var(--accent)] hover:bg-[var(--accent-soft)]')}
              >
                <Button
                  type="button"
                  variant="ghost"
                  className="grid h-auto min-h-0 w-full min-w-0 grid-cols-[52px_minmax(150px,1.25fr)_minmax(150px,1fr)_minmax(150px,0.95fr)_minmax(160px,1.4fr)] items-center justify-stretch justify-items-stretch gap-[18px] rounded-none border-0 bg-transparent py-4 pr-0 pl-[18px] text-left font-[inherit] whitespace-normal text-[inherit] hover:bg-transparent focus-visible:bg-[var(--surface-2)] focus-visible:shadow-[inset_0_0_0_1px_var(--focus)] max-[1180px]:grid-cols-[44px_minmax(120px,1.3fr)_minmax(120px,1fr)_minmax(150px,1.4fr)] max-[900px]:grid-cols-[40px_minmax(120px,1fr)_minmax(98px,auto)] max-[900px]:gap-3 max-sm:grid-cols-[34px_minmax(0,1fr)] max-sm:gap-2.5 max-sm:py-3.5 max-sm:pr-0 max-sm:pl-3"
                  title={`Open ${region.region} region detail`}
                  onClick={() => {
                    onRequestRegionHistory?.()
                    openRegionDetail(region.region)
                  }}
                  onFocus={onRequestRegionHistory}
                  onPointerEnter={onRequestRegionHistory}
                >
                  <span className="text-center text-[1.4rem] font-bold text-[var(--text-strong)] max-sm:row-span-2 max-sm:text-left">{region.rank}</span>
                  <span className="flex min-w-0 items-center gap-3 [&>span]:min-w-0 [&_b]:text-[1.02rem] [&_b]:font-[660] [&_b]:tracking-normal [&_b]:text-[var(--text-strong)] [&_small]:mt-px [&_small]:block [&_small]:text-[0.74rem] [&_small]:text-[var(--muted)] max-sm:gap-[9px] max-sm:[&_b]:overflow-hidden max-sm:[&_b]:text-ellipsis max-sm:[&_b]:whitespace-nowrap max-sm:[&_small]:overflow-hidden max-sm:[&_small]:text-ellipsis max-sm:[&_small]:whitespace-nowrap">
                    <RegionBadge region={region.region} />
                    <span>
                      <b>{region.region}</b>
                      <small>
                        {region.flagshipLeague ?? 'Multiple leagues'} · {region.teamCount} flagship teams
                      </small>
                    </span>
                  </span>
                  <span className="grid gap-1.5 max-[900px]:min-w-24 max-sm:col-start-2 max-sm:max-w-[220px] max-sm:min-w-0 max-sm:grid-cols-[minmax(0,1fr)_minmax(72px,auto)] max-sm:items-center">
                    <RegionPowerMeter value={displayRegionPowerScore(region)} average={displayRegionTotalTeamRating(region)} min={min} max={max} />
                    <span className="hidden max-sm:inline max-sm:min-w-0 max-sm:overflow-hidden max-sm:text-ellipsis max-sm:whitespace-nowrap max-sm:text-[0.72rem] max-sm:leading-[1.2] max-sm:text-[var(--muted)]">{formatSignedDecimal(region.winsOverExpected)} vs expected</span>
                  </span>
                  <span className="grid min-w-0 gap-0.5 text-[0.84rem] text-[var(--muted)] tabular-nums [&_b]:font-[640] [&_b]:text-[var(--text)] [&_small]:block [&_small]:leading-[1.25] [&_small]:text-[var(--faint)] [&_span]:block max-[1180px]:hidden">
                    <span>
                      <b>{formatRecord(region.internationalWins, region.internationalLosses)}</b> intl ·{' '}
                      {formatRatio(region.internationalWinRate)}
                    </span>
                    <small>
                      vs {formatRating(region.averageOpponentRating)} average · {formatSignedDecimal(region.winsOverExpected)} vs expected
                    </small>
                  </span>
                  <span className="flex flex-wrap gap-[5px] max-[900px]:hidden">
                    {region.topTeams.slice(0, 3).map((team) => (
                      <span className="inline-flex items-center gap-[5px] whitespace-nowrap rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-3)] px-2 py-0.5 text-[0.74rem] text-[var(--muted)] [&_b]:font-semibold [&_b]:text-[var(--text)]" key={team.team}>
                        <b>{team.code ?? team.team.slice(0, 3).toUpperCase()}</b>
                        {formatRating(team.rating)}
                      </span>
                    ))}
                  </span>
                </Button>
                <div className="justify-self-end py-4 pr-[18px] pl-0 max-sm:grid max-sm:self-stretch max-sm:place-items-center max-sm:py-0 max-sm:pr-3.5 max-sm:pl-0">
                  <RegionCompareButton picked={picked} onToggle={() => onToggle(region)} label={region.region} />
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <RegionDetailDrawer
        region={selectedRegion}
        teams={selectedRegionTeams}
        series={selectedRegion ? regionHistory?.regionPowerSeries[selectedRegion.region] : undefined}
        matchHistoryState={matchHistoryState}
        onRequestMatchHistoryPages={onRequestMatchHistoryPages}
        onClose={closeRegionDetail}
      />
    </div>
  )
}

type RegionStanding = Pick<PublicTeamStanding, 'team' | 'code' | 'region' | 'league' | 'rating' | 'rank' | 'eligibility'>

type RegionDrawerTeam = {
  team: string
  code?: string
  rating: number
  rank?: number
}

function RegionPowerMeter({ value, average, min, max }: { value: number; average: number; min: number; max: number }) {
  const averagePct = pctWithin(average, min, max)
  const topThreePct = pctWithin(value, min, max)
  const rangeStart = Math.min(averagePct, topThreePct)
  const rangeWidth = Math.max(2, Math.abs(topThreePct - averagePct))
  const gap = value - average

  return (
    <span className="grid w-[min(100%,210px)] min-w-0 justify-self-start gap-1.5 max-sm:w-full" role="img" aria-label={`Top-three average ${formatRating(value)}, all-team average ${formatRating(average)}, gap ${formatSigned(gap)}`}>
      <span className="grid gap-px text-[0.68rem] leading-[1.25] tabular-nums">
        <strong className="font-[680] text-[var(--text-strong)]">Top 3 avg {formatRating(value)}</strong>
        <small className="text-[var(--faint)]">All teams avg {formatRating(average)} · Gap {formatSigned(gap)}</small>
      </span>
      <span className="relative h-[7px] min-w-24 overflow-hidden rounded-full bg-[var(--surface-3)] max-sm:hidden" aria-hidden="true">
        <span className="absolute inset-y-0 rounded-[inherit] bg-[var(--accent)] transition-[left,width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]" style={{ left: `${rangeStart}%`, width: `${rangeWidth}%` }} />
      </span>
    </span>
  )
}

function RegionCompareButton({ picked, onToggle, label }: { picked: boolean; onToggle: () => void; label: string }) {
  const tooltip = picked ? `Remove ${label} from comparison` : `Compare ${label}`
  const accessibleLabel = picked ? `Comparing ${label}, remove from comparison` : tooltip

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className={cn('min-w-[106px] border-[var(--line-strong)] bg-[var(--surface-2)] text-[var(--text)] hover:border-[var(--accent-line)] hover:bg-[var(--surface-3)] hover:text-[var(--text-strong)] focus-visible:border-[var(--accent-line)] focus-visible:text-[var(--text-strong)] max-sm:w-full', picked && 'border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent-strong)]')}
      onClick={onToggle}
      aria-label={accessibleLabel}
      aria-pressed={picked}
      title={tooltip}
    >
      {picked ? <Check size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
      <span>{picked ? 'Comparing' : 'Compare'}</span>
    </Button>
  )
}

const REGION_SPARKLINE_WIDTH = 150
const REGION_SPARKLINE_HEIGHT = 42

function RegionPowerSparkline({ series, region }: { series?: PublicRegionHistorySeries; region: string }) {
  const shape = useMemo(() => {
    const values = (series?.points ?? []).slice(-24).map((point) => point[1]).filter(Number.isFinite)
    return sparklineShape(values, REGION_SPARKLINE_WIDTH, REGION_SPARKLINE_HEIGHT)
  }, [series])
  const first = series?.points[0]
  const last = series?.points.at(-1)
  const delta = first && last ? last[1] - first[1] : undefined
  const deltaTone = typeof delta === 'number' && delta < 0
    ? 'down'
    : typeof delta === 'number' && delta > 0
      ? 'up'
      : undefined

  if (!shape || !first || !last) {
    return (
      <div className="grid min-w-[180px] grid-cols-1 items-center gap-3 rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2.5 text-[var(--muted)] max-[820px]:min-w-[min(260px,100%)] max-[820px]:flex-[1_1_260px]" aria-label={`${region} region trajectory unavailable`}>
        <small className="block text-[0.68rem] tracking-[0.08em] text-[var(--faint)] uppercase">Power trajectory</small>
        <b className="mt-[3px] block text-[var(--text-strong)] tabular-nums">History pending</b>
      </div>
    )
  }

  return (
    <div
      className="grid min-w-[260px] grid-cols-[minmax(92px,auto)_150px] items-center gap-3 rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2.5 max-[820px]:min-w-[min(260px,100%)] max-[820px]:flex-[1_1_260px] max-[560px]:w-full max-[560px]:grid-cols-1 [&_circle]:fill-[var(--accent)] [&_polyline]:fill-none [&_polyline]:stroke-[var(--accent)] [&_polyline]:stroke-[2.2] [&_polyline]:[stroke-linecap:round] [&_polyline]:[stroke-linejoin:round] [&_svg]:h-[42px] [&_svg]:w-[150px] [&_svg]:overflow-visible max-[560px]:[&_svg]:w-full"
      aria-label={`${region} region power trajectory ${formatSignedDecimal(delta)} from ${formatDate(first[0])} to ${formatDate(last[0])}`}
    >
      <div>
        <small className="block text-[0.68rem] tracking-[0.08em] text-[var(--faint)] uppercase">Power trajectory</small>
        <b className={`mt-[3px] block tabular-nums ${deltaTone === 'up' ? 'text-[var(--up)]' : deltaTone === 'down' ? 'text-[var(--down)]' : 'text-[var(--text-strong)]'}`}>{formatSignedDecimal(delta)}</b>
      </div>
      <svg viewBox={`0 0 ${REGION_SPARKLINE_WIDTH} ${REGION_SPARKLINE_HEIGHT}`} role="img" focusable="false">
        <polyline points={shape.points} />
        <circle cx={shape.last.x} cy={shape.last.y} r="2.8" />
      </svg>
    </div>
  )
}

type SparklineShape = {
  points: string
  last: { x: number; y: number }
}

function sparklineShape(values: number[], width: number, height: number): SparklineShape | null {
  const finiteValues = values.filter(Number.isFinite)
  if (finiteValues.length < 2) return null
  const [min, max] = extent(finiteValues)
  const range = max - min
  const inset = 4
  const drawableWidth = width - inset * 2
  const drawableHeight = height - inset * 2
  const coords = finiteValues.map((value, index) => {
    const x = inset + (index / (finiteValues.length - 1)) * drawableWidth
    const y = range === 0
      ? height / 2
      : inset + (1 - (value - min) / range) * drawableHeight
    return { x: roundSparklineCoord(x), y: roundSparklineCoord(y) }
  })
  const last = coords.at(-1)!
  return {
    points: coords.map((point) => `${point.x},${point.y}`).join(' '),
    last,
  }
}

function roundSparklineCoord(value: number) {
  return Math.round(value * 10) / 10
}

function RegionDetailDrawer({
  region,
  teams,
  series,
  matchHistoryState,
  onRequestMatchHistoryPages,
  onClose,
}: {
  region: RegionStrength | null
  teams: RegionDrawerTeam[]
  series?: PublicRegionHistorySeries
  matchHistoryState: MatchHistoryState
  onRequestMatchHistoryPages: (pages: number[]) => void
  onClose: () => void
}) {
  const displayedTeams = teams.length > 0 ? teams : region?.topTeams ?? []

  return (
    <Sheet open={Boolean(region)} onOpenChange={(nextOpen) => {
      if (!nextOpen) onClose()
    }}>
      {region ? (
        <SheetContent
          side="right"
          showCloseButton={false}
          className="data-[side=right]:w-[min(980px,100vw)] data-[side=right]:max-w-none gap-0 border-l border-[var(--line-strong)] bg-[var(--surface)] p-0 text-[var(--text)] shadow-[var(--shadow-pop)] data-[side=right]:sm:w-[min(980px,94vw)] data-[side=right]:sm:max-w-none"
        >
          <SheetHeader className="flex-row items-center gap-3 border-b border-[var(--line)] p-[18px_22px] text-left">
            <SheetTitle className="mr-auto text-[1.1rem] font-semibold text-[var(--text-strong)]">{region.region} region detail</SheetTitle>
            <SheetClose asChild>
              <Button type="button" variant="ghost">
                <X size={16} aria-hidden="true" />
                Close
              </Button>
            </SheetClose>
          </SheetHeader>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-auto overscroll-contain bg-[var(--surface-2)] px-[22px] pt-[18px] pb-6 [&>*]:shrink-0 max-[560px]:p-3">
            <section className="flex items-end justify-between gap-[18px] rounded-[var(--r)] border border-[var(--line-strong)] bg-[var(--surface)] p-[18px] max-[820px]:flex-wrap max-[820px]:items-start max-[820px]:[&>div:first-child]:basis-full max-[560px]:p-3" aria-label={`${region.region} summary`}>
              <div>
                <p className="eyebrow">Region #{region.rank}</p>
                <h3 className="mt-[3px] text-[2rem] leading-none font-[720] text-[var(--text-strong)]">{region.region}</h3>
                <p className="mt-[7px] flex max-w-[72ch] flex-wrap gap-x-2.5 gap-y-[5px] text-[0.86rem] text-[var(--muted)] [&>span]:inline-flex [&>span]:min-w-0 [&>span]:items-center [&>span:not(:last-child)::after]:ml-2.5 [&>span:not(:last-child)::after]:text-[var(--faint)] [&>span:not(:last-child)::after]:content-['·']">
                  <span>{region.flagshipLeague ?? 'Multiple flagship leagues'}</span>
                  <span>{formatTier(region.tier)}</span>
                  <span>{formatCountWithUnit(region.teamCount, 'flagship team')}</span>
                  <span>{formatCountWithUnit(region.leagueCount, 'flagship league')}</span>
                  <span>{formatCountWithUnit(region.ecosystemLeagueCount, 'ecosystem league')}</span>
                </p>
              </div>
              <strong className="grid justify-items-end gap-[3px] text-[2rem] leading-none text-[var(--rank-gold)] tabular-nums max-[560px]:justify-items-start">
                {formatRating(displayRegionPowerScore(region))}
                <span className="text-[0.7rem] font-semibold tracking-[0.1em] text-[var(--faint)] uppercase">Region power</span>
              </strong>
              <RegionPowerSparkline series={series} region={region.region} />
            </section>

            <section className="grid grid-cols-3 overflow-hidden rounded-[var(--r)] border border-[var(--line)] bg-[var(--surface)] [&>*:nth-child(3n)]:border-r-0 [&>*:nth-last-child(-n+3)]:border-b-0 max-[820px]:grid-cols-2 max-[820px]:[&>*:nth-child(3n)]:border-r max-[820px]:[&>*:nth-child(2n)]:border-r-0 max-[820px]:[&>*:nth-last-child(-n+3)]:border-b max-[820px]:[&>*:nth-last-child(-n+2)]:border-b-0 max-[560px]:grid-cols-1 max-[560px]:[&>*]:border-r-0 max-[560px]:[&>*]:border-b max-[560px]:[&>*:last-child]:border-b-0" aria-label={`${region.region} metrics`}>
              <DetailStat
                label="International record"
                value={formatRecord(region.internationalWins, region.internationalLosses)}
                description={`Wins and losses by flagship leagues against teams from other regions. Raw rate: ${formatRatio(region.internationalWinRate)}.`}
              />
              <DetailStat
                label="Adjusted international rate"
                value={formatRatio(region.opponentAdjustedWinRate)}
                description="International win rate adjusted for opponent power."
              />
              <DetailStat
                label="Wins vs expected"
                value={formatSignedDecimal(region.winsOverExpected)}
                description="International wins above or below the model's opponent-adjusted expectation."
              />
              <DetailStat
                label="Top team power"
                value={formatRating(region.topTeamRating)}
                description="Rating of the strongest eligible team in this region's flagship league layer."
              />
              <DetailStat
                label="Region power"
                value={formatRating(displayRegionPowerScore(region))}
                description="Headline regional score used for ranking regions: the average rating of the three strongest eligible flagship teams. If a region has fewer than three eligible teams, it averages the available teams."
              />
              <DetailStat
                label="Flagship-team average"
                value={formatRating(displayRegionTotalTeamRating(region))}
                description="Average rating across every eligible flagship team in the region. This is an average, not a sum, so larger leagues do not get automatic credit for team count."
              />
              <DetailStat
                label="Opponent power"
                value={formatRating(region.averageOpponentRating)}
                description="Average rating of international opponents faced by flagship leagues."
              />
              <DetailStat
                label="Connectivity"
                value={formatRatio(region.connectivity)}
                description="How strongly this region is linked into the global match graph."
              />
            </section>

            <RegionMatchHistory key={region.region} region={region} teams={displayedTeams} series={series} state={matchHistoryState} onRequestPages={onRequestMatchHistoryPages} />

            <section className="grid gap-3 rounded-[var(--r)] border border-[var(--line)] bg-[var(--surface)] px-[18px] py-4 max-[560px]:p-3" aria-label={`${region.region} teams`}>
              <div>
                <p className="eyebrow">League teams</p>
                <h3 className="mt-0.5 text-base font-[660] text-[var(--text-strong)]">All flagship representatives</h3>
              </div>
              <div className="grid max-h-[min(420px,42vh)] overflow-y-auto pr-1.5 [scrollbar-gutter:stable]">
                {displayedTeams.length > 0 ? (
                  displayedTeams.map((team, index) => (
                    <div className="grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-3 border-t border-[var(--line)] py-[11px] first:border-t-0 max-[560px]:grid-cols-[38px_minmax(0,1fr)_auto]" key={team.team}>
                      <span className="font-mono text-[0.74rem] text-[var(--faint)]">{team.rank ? `#${team.rank}` : `#${index + 1}`}</span>
                      <div>
                        <b className="block text-[0.92rem] text-[var(--text-strong)] [overflow-wrap:anywhere]">{team.team}</b>
                        {team.code ? <small className="mt-0.5 block text-[0.74rem] text-[var(--muted)]">{team.code}</small> : null}
                      </div>
                      <strong className="text-[var(--rank-gold)] tabular-nums">{formatRating(team.rating)}</strong>
                    </div>
                  ))
                ) : (
                  <p className="text-[var(--muted)]">No team rows are available for this region in the current scope.</p>
                )}
              </div>
            </section>
          </div>
        </SheetContent>
      ) : null}
    </Sheet>
  )
}

const REGION_MATCH_PAGE_SIZE = 15

type RegionMatchSeries = {
  id: string
  games: PublicMatchHistoryEntry[]
  summary: PublicMatchHistoryEntry
}

function RegionMatchHistory({
  region,
  teams,
  series,
  state,
  onRequestPages,
}: {
  region: RegionStrength
  teams: RegionDrawerTeam[]
  series?: PublicRegionHistorySeries
  state: MatchHistoryState
  onRequestPages: (pages: number[]) => void
}) {
  const [page, setPage] = useState(1)
  const teamNames = useMemo(() => new Set(teams.map((team) => team.team)), [teams])
  const refs = useMemo(
    () => state.status === 'ready' ? state.data.catalog.series.filter((match) => teamNames.has(match.teamA.name) || teamNames.has(match.teamB.name)) : [],
    [state, teamNames],
  )
  const movements = useMemo(() => regionMovementsByDate(series), [series])
  const pageCount = Math.max(1, Math.ceil(refs.length / REGION_MATCH_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const pageStart = (currentPage - 1) * REGION_MATCH_PAGE_SIZE
  const visibleRefs = refs.slice(pageStart, pageStart + REGION_MATCH_PAGE_SIZE)
  const neededPages = useMemo(() => [...new Set(visibleRefs.map((entry) => entry.page))], [visibleRefs])
  const neededPagesKey = neededPages.join(',')
  const loadedMatches = useMemo(() => state.status === 'ready' ? neededPages.flatMap((pageNumber) => {
    const pageState = state.data.pages[pageNumber]
    return pageState?.status === 'ready' ? pageState.data.matches : []
  }) : [], [neededPages, state])
  const loadedSeries = useMemo(() => new Map(regionMatchSeries(loadedMatches, teamNames).map((entry) => [entry.id, entry])), [loadedMatches, teamNames])
  const visibleMatches = visibleRefs.map((entry) => loadedSeries.get(entry.id)).filter((entry): entry is RegionMatchSeries => Boolean(entry))
  const pageError = state.status === 'ready' ? neededPages.map((pageNumber) => state.data.pages[pageNumber]).find((entry) => entry?.status === 'error') : undefined
  const pageLoading = state.status === 'ready' && neededPages.some((pageNumber) => state.data.pages[pageNumber]?.status !== 'ready')

  useEffect(() => {
    if (!neededPagesKey) return
    onRequestPages(neededPagesKey.split(',').map(Number))
  }, [neededPagesKey, onRequestPages])

  return (
    <section className="overflow-hidden rounded-[var(--r)] border border-[var(--line)] bg-[var(--surface)]" aria-label={`${region.region} match and score history`}>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--line)] px-[18px] py-4 max-[560px]:p-3">
        <div>
          <p className="eyebrow">Match history</p>
          <h3 className="mt-0.5 text-base font-[660] text-[var(--text-strong)]">Results and region score movement</h3>
        </div>
        <p className="max-w-[420px] text-right text-[0.72rem] leading-[1.4] text-[var(--faint)] max-[560px]:text-left">
          Team power is applied per completed series. Region movement is the top-three average change at that day's checkpoint.
        </p>
      </div>

      {state.status === 'idle' || state.status === 'loading' ? (
        <p className="px-[18px] py-5 text-[0.82rem] text-[var(--muted)]">Loading scoped match history…</p>
      ) : state.status === 'missing' || state.status === 'error' ? (
        <p className="px-[18px] py-5 text-[0.82rem] text-[var(--muted)]">{state.message}</p>
      ) : refs.length === 0 ? (
        <p className="px-[18px] py-5 text-[0.82rem] text-[var(--muted)]">No matches are available for this region in the current scope.</p>
      ) : pageError?.status === 'error' ? (
        <p className="px-[18px] py-5 text-[0.82rem] text-[var(--loss)]">{pageError.message}</p>
      ) : pageLoading ? (
        <div className="grid gap-2 p-3" aria-busy="true">{Array.from({ length: 6 }, (_, index) => <div className="h-16 animate-pulse rounded-[var(--r-sm)] bg-[var(--surface-2)]" key={index} />)}</div>
      ) : (
        <>
          <div>
            {visibleMatches.map((match) => (
              <RegionMatchRow
                key={match.id}
                match={match}
                teamNames={teamNames}
                movement={movements.get(match.summary.date)}
              />
            ))}
          </div>
          {pageCount > 1 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] px-[18px] py-3 text-[0.78rem] text-[var(--muted)] max-[560px]:px-3" aria-label={`${region.region} match history pagination`}>
              <span>{formatNumber(pageStart + 1)}–{formatNumber(pageStart + visibleRefs.length)} of {formatNumber(refs.length)}</span>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="icon" onClick={() => setPage(Math.max(1, currentPage - 1))} disabled={currentPage === 1} aria-label={`Previous ${region.region} match history page`}><ChevronLeft /></Button>
                <span className="min-w-20 text-center font-semibold text-[var(--text)]">Page {currentPage} of {pageCount}</span>
                <Button type="button" variant="outline" size="icon" onClick={() => setPage(Math.min(pageCount, currentPage + 1))} disabled={currentPage === pageCount} aria-label={`Next ${region.region} match history page`}><ChevronRight /></Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

function RegionMatchRow({
  match,
  teamNames,
  movement,
}: {
  match: RegionMatchSeries
  teamNames: Set<string>
  movement?: RegionDailyMovement
}) {
  const { summary } = match
  const teamAIsRegional = teamNames.has(summary.teamA.name)
  const teamBIsRegional = teamNames.has(summary.teamB.name)
  const regionalClash = teamAIsRegional && teamBIsRegional
  const regionWon = regionalClash
    ? undefined
    : teamAIsRegional
      ? summary.seriesWinsA > summary.seriesWinsB
      : summary.seriesWinsB > summary.seriesWinsA
  const impactParts = [
    teamAIsRegional && typeof summary.impact.teamA === 'number' ? `${summary.teamA.code} ${formatSigned(summary.impact.teamA)}` : undefined,
    teamBIsRegional && typeof summary.impact.teamB === 'number' ? `${summary.teamB.code} ${formatSigned(summary.impact.teamB)}` : undefined,
  ].filter((part): part is string => Boolean(part))
  const contributors = movement?.context?.contributingTeams ?? []
  const contributingTeam = [summary.teamA.name, summary.teamB.name].find((team) => teamNames.has(team) && contributors.includes(team))
  const directRegionEffect = summary.impact.unit === 'series-applied' && contributors.length > 0
    ? [
        teamAIsRegional && contributors.includes(summary.teamA.name) ? summary.impact.teamA : undefined,
        teamBIsRegional && contributors.includes(summary.teamB.name) ? summary.impact.teamB : undefined,
      ].reduce<number>((total, impact) => total + (typeof impact === 'number' ? impact : 0), 0) / contributors.length
    : undefined

  return (
    <article className="grid grid-cols-[108px_minmax(0,1.45fr)_minmax(150px,0.8fr)_minmax(170px,0.9fr)] items-center gap-4 border-t border-[var(--line)] px-[18px] py-3.5 first:border-t-0 max-[820px]:grid-cols-[90px_minmax(0,1fr)_minmax(140px,auto)] max-[820px]:[&>div:last-child]:col-start-2 max-[820px]:[&>div:last-child]:col-end-4 max-[560px]:grid-cols-1 max-[560px]:gap-2.5 max-[560px]:px-3 max-[560px]:[&>div:last-child]:col-start-1 max-[560px]:[&>div:last-child]:col-end-2">
      <div className="text-[0.72rem] text-[var(--faint)]">
        <span className="block">{formatDate(summary.datetimeUtc ?? summary.date)}</span>
        <span className="mt-1 block">Bo{summary.bestOf} · {match.games.length} {match.games.length === 1 ? 'game' : 'games'}</span>
      </div>
      <div className="min-w-0">
        <p className="truncate text-[0.72rem] text-[var(--muted)]" title={summary.event}>{summary.event}</p>
        <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[0.86rem]">
          <strong className={cn('truncate', teamAIsRegional && 'text-[var(--text-strong)]')}>{summary.teamA.name}</strong>
          <span className="shrink-0 font-extrabold text-[var(--text-strong)] tabular-nums">{summary.seriesWinsA}–{summary.seriesWinsB}</span>
          <strong className={cn('truncate', teamBIsRegional && 'text-[var(--text-strong)]')}>{summary.teamB.name}</strong>
        </div>
      </div>
      <div>
        <span className={cn(
          'inline-flex items-center rounded-full px-2 py-1 text-[0.68rem] font-bold',
          regionalClash ? 'bg-[var(--surface-3)] text-[var(--muted)]' : regionWon ? 'bg-[var(--win-soft)] text-[var(--win)]' : 'bg-[var(--loss-soft)] text-[var(--loss)]',
        )}>
          {regionalClash ? 'Regional matchup' : regionWon ? 'Region win' : 'Region loss'}
        </span>
        <p className="mt-1.5 text-[0.72rem] text-[var(--muted)] tabular-nums">
          {impactParts.length > 0 ? `Team power ${impactParts.join(' · ')}` : 'Team power held'}
        </p>
      </div>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 border-l border-[var(--line)] pl-4 max-[820px]:border-l-0 max-[820px]:border-t max-[820px]:pt-2.5 max-[820px]:pl-0">
        <ArrowRight className="size-4 text-[var(--faint)]" aria-hidden="true" />
        <div>
          <strong className={cn('block text-[0.8rem] tabular-nums', typeof directRegionEffect === 'number' && directRegionEffect > 0 ? 'text-[var(--up)]' : typeof directRegionEffect === 'number' && directRegionEffect < 0 ? 'text-[var(--down)]' : 'text-[var(--text)]')}>
            {typeof directRegionEffect === 'number' && directRegionEffect !== 0
              ? `≈ ${formatSignedDecimal(directRegionEffect)} direct region effect`
              : contributingTeam
                ? 'Region effect held'
                : 'Outside the top three'}
          </strong>
          <small className="mt-0.5 block text-[0.68rem] text-[var(--faint)]">
            {movement
              ? `Daily checkpoint ${formatSignedDecimal(movement.delta)} → ${formatRating(movement.score)}${contributingTeam ? ` · ${contributingTeam} contributed` : ''}`
              : 'No score checkpoint was published for this date'}
          </small>
        </div>
      </div>
    </article>
  )
}

type RegionDailyMovement = {
  score: number
  delta: number
  context?: PublicRegionHistorySeries['points'][number][3]
}

function regionMovementsByDate(series?: PublicRegionHistorySeries) {
  const movements = new Map<string, RegionDailyMovement>()
  const points = [...(series?.points ?? [])].sort((left, right) => left[0].localeCompare(right[0]))
  points.forEach((point, index) => {
    const previous = points[index - 1]
    movements.set(point[0], {
      score: point[1],
      delta: previous ? Number((point[1] - previous[1]).toFixed(1)) : 0,
      context: point[3],
    })
  })
  return movements
}

function regionMatchSeries(matches: PublicMatchHistoryEntry[], teamNames: Set<string>): RegionMatchSeries[] {
  const groups = new Map<string, PublicMatchHistoryEntry[]>()
  for (const match of matches) {
    if (!teamNames.has(match.teamA.name) && !teamNames.has(match.teamB.name)) continue
    groups.set(match.seriesId, [...(groups.get(match.seriesId) ?? []), match])
  }
  return [...groups.entries()]
    .map(([id, games]) => {
      const sortedGames = games.toSorted((left, right) => left.gameNumber - right.gameNumber || left.id.localeCompare(right.id))
      const summary = sortedGames.findLast((game) => game.impact.unit === 'series-applied') ?? sortedGames.at(-1)
      if (!summary) throw new Error(`Cannot display empty regional match series ${id}`)
      return { id, games: sortedGames, summary }
    })
    .sort((left, right) => (right.summary.datetimeUtc ?? right.summary.date).localeCompare(left.summary.datetimeUtc ?? left.summary.date) || right.id.localeCompare(left.id))
}

function flagshipTeamsForRegion(region: RegionStrength, standings: RegionStanding[]): RegionDrawerTeam[] {
  return standings
    .filter((team) => isRegionPowerTeam(region, team))
    .slice()
    .sort((left, right) => right.rating - left.rating)
    .map((team) => ({
      team: team.team,
      code: team.code,
      rating: team.rating,
      rank: team.rank,
    }))
}

function DetailStat({ label, value, description }: { label: string; value: string; description: string }) {
  return (
    <div className="grid min-w-0 gap-[5px] border-r border-b border-[var(--line)] px-4 py-3.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="w-fit min-w-0 cursor-help gap-[5px] border-0 bg-transparent p-0 text-left font-[inherit] text-[var(--faint)] hover:bg-transparent hover:text-[var(--text)] focus-visible:rounded-sm focus-visible:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[var(--focus)] [&_span]:text-[0.68rem] [&_span]:font-[620] [&_span]:tracking-[0.1em] [&_span]:uppercase [&_svg]:shrink-0 [&_svg]:opacity-72"
            aria-label={`${label}: ${description}`}
          >
            <span>{label}</span>
            <Info size={13} aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{description}</TooltipContent>
      </Tooltip>
      <strong className="text-[1.05rem] text-[var(--text-strong)] tabular-nums [overflow-wrap:anywhere]">{value}</strong>
    </div>
  )
}

function RibbonCell({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="flex gap-3 bg-[var(--surface)] px-5 py-[18px]">
      <span className="grid size-[34px] shrink-0 place-items-center rounded-[var(--r-sm)] bg-[var(--surface-3)] text-[var(--accent-strong)]">{icon}</span>
      <div>
        <span className="text-[0.72rem] tracking-[0.08em] text-[var(--faint)] uppercase">{label}</span>
        <strong className="mt-0.5 block text-[1.4rem] leading-[1.1] font-[660] tracking-normal text-[var(--text-strong)] tabular-nums">{value}</strong>
        <small className="text-[0.74rem] text-[var(--muted)]">{detail}</small>
      </div>
    </div>
  )
}

function formatTier(value?: string) {
  if (!value) return 'Unknown tier'
  return value
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function formatCountWithUnit(value: number | undefined, singular: string) {
  const unit = value === 1 ? singular : `${singular}s`
  return `${formatNumber(value)} ${unit}`
}

function formatSignedDecimal(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (Math.abs(value) < 0.05) return '0'
  return value > 0 ? `+${formatDecimal(value)}` : formatDecimal(value)
}
