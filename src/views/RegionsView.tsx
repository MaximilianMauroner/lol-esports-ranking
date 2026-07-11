import { useMemo, type ReactNode } from 'react'
import { Check, Globe2, Info, Plus, Swords, Trophy, X } from 'lucide-react'
import {
  displayRegionPowerScore,
  displayRegionTotalTeamRating,
  isRegionPowerTeam,
  type RegionStrength,
} from '../lib/regionStrength'
import type { PublicRegionHistoryScope, PublicRegionHistorySeries, PublicTeamStanding } from '../lib/publicArtifacts/schema'
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
  pickedIds,
  onToggle,
  onRequestRegionHistory,
}: {
  regions: RegionStrength[]
  standings: RegionStanding[]
  regionHistory?: PublicRegionHistoryScope
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
  const pickedCount = regions.filter((region) => pickedIds.has(region.region)).length
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

      <section className="min-w-0 overflow-hidden rounded-[var(--r-lg)] border border-[var(--region-line-strong)] bg-[var(--region-surface)] [--region-line-strong:oklch(0.48_0.055_78/0.55)] [--region-line:oklch(0.34_0.025_62/0.66)] [--region-surface-low:oklch(0.13_0.01_55)] [--region-surface-raised:oklch(0.2_0.012_55)] [--region-surface:oklch(0.16_0.012_55)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-[18px] py-4 max-sm:grid max-sm:items-start [&_.eyebrow]:text-[0.66rem] [&_.eyebrow]:tracking-[0.14em] [&_.eyebrow]:text-[var(--faint)] [&_.eyebrow]:uppercase [&_h2]:text-base [&_h2]:font-[640] [&_h2]:text-[var(--text-strong)]">
          <div>
            <p className="eyebrow">Compare regions</p>
            <h2>{pickedCount > 0 ? `${pickedCount} selected` : 'Add regions to compare'}</h2>
          </div>
          <span className="max-w-[430px] text-right text-[0.72rem] leading-[1.35] text-[var(--faint)] max-sm:text-left">
            <strong className="font-[620] text-[var(--text)]">Range shown:</strong>{' '}
            all-team average → top-three average · gap = difference
          </span>
        </div>

        <div className="flex flex-col">
          {regions.map((region) => {
            const picked = pickedIds.has(region.region)

            return (
              <div
                key={region.region}
                className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-center border-t border-[var(--region-line)] transition-[background] duration-150 first:border-t-0 hover:bg-[var(--region-surface-raised)] max-sm:grid-cols-[minmax(0,1fr)_62px]', picked && 'bg-[color-mix(in_oklch,var(--accent)_10%,var(--region-surface))] shadow-[inset_0_0_0_1px_var(--accent-line)] hover:bg-[color-mix(in_oklch,var(--accent)_10%,var(--region-surface))]')}
              >
                <Button
                  type="button"
                  variant="ghost"
                  className="grid h-auto min-h-0 w-full min-w-0 grid-cols-[52px_minmax(150px,1.25fr)_minmax(150px,1fr)_minmax(150px,0.95fr)_minmax(160px,1.4fr)] items-center justify-stretch justify-items-stretch gap-[18px] rounded-none border-0 bg-transparent py-4 pr-0 pl-[18px] text-left font-[inherit] whitespace-normal text-[inherit] hover:bg-transparent focus-visible:bg-[var(--region-surface-raised)] focus-visible:shadow-[inset_0_0_0_1px_var(--focus)] max-[1180px]:grid-cols-[44px_minmax(120px,1.3fr)_minmax(120px,1fr)_minmax(150px,1.4fr)] max-[900px]:grid-cols-[40px_minmax(120px,1fr)_minmax(98px,auto)] max-[900px]:gap-3 max-sm:grid-cols-[34px_minmax(0,1fr)] max-sm:gap-2.5 max-sm:py-3.5 max-sm:pr-0 max-sm:pl-3"
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
      <span className="relative h-[7px] min-w-24 overflow-hidden rounded-full bg-[color-mix(in_oklch,var(--rank-gold)_14%,var(--region-surface-low))] max-sm:hidden" aria-hidden="true">
        <span className="absolute inset-y-0 rounded-[inherit] bg-[color-mix(in_oklch,var(--rank-gold)_84%,var(--text-strong))] transition-[left,width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]" style={{ left: `${rangeStart}%`, width: `${rangeWidth}%` }} />
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
      className={cn('min-w-[106px] border-[var(--region-line-strong)] bg-[var(--region-surface-low)] text-[var(--text)] hover:border-[var(--accent-line)] hover:bg-[color-mix(in_oklch,var(--accent)_9%,var(--region-surface-low))] hover:text-[var(--text-strong)] focus-visible:border-[var(--accent-line)] focus-visible:bg-[color-mix(in_oklch,var(--accent)_9%,var(--region-surface-low))] focus-visible:text-[var(--text-strong)] max-sm:w-full', picked && 'border-[var(--accent-line)] bg-[color-mix(in_oklch,var(--accent)_16%,var(--region-surface-low))] text-[var(--accent-strong)]')}
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
      <div className="grid min-w-[180px] grid-cols-1 items-center gap-3 rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--region-detail-surface-low)] px-3 py-2.5 text-[var(--muted)] max-[820px]:min-w-[min(260px,100%)] max-[820px]:flex-[1_1_260px]" aria-label={`${region} region trajectory unavailable`}>
        <small className="block text-[0.68rem] tracking-[0.08em] text-[var(--faint)] uppercase">Power trajectory</small>
        <b className="mt-[3px] block text-[var(--text-strong)] tabular-nums">History pending</b>
      </div>
    )
  }

  return (
    <div
      className="grid min-w-[260px] grid-cols-[minmax(92px,auto)_150px] items-center gap-3 rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--region-detail-surface-low)] px-3 py-2.5 max-[820px]:min-w-[min(260px,100%)] max-[820px]:flex-[1_1_260px] max-[560px]:w-full max-[560px]:grid-cols-1 [&_circle]:fill-[var(--rank-gold)] [&_polyline]:fill-none [&_polyline]:stroke-[var(--rank-gold)] [&_polyline]:stroke-[2.2] [&_polyline]:[stroke-linecap:round] [&_polyline]:[stroke-linejoin:round] [&_svg]:h-[42px] [&_svg]:w-[150px] [&_svg]:overflow-visible max-[560px]:[&_svg]:w-full"
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
  onClose,
}: {
  region: RegionStrength | null
  teams: RegionDrawerTeam[]
  series?: PublicRegionHistorySeries
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
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-auto overscroll-contain bg-[var(--region-detail-surface-low)] px-[22px] pt-[18px] pb-6 [--line:var(--region-detail-line)] [--line-strong:var(--region-detail-line-strong)] [--region-detail-line:oklch(0.34_0.025_62/0.66)] [--region-detail-line-strong:oklch(0.48_0.055_78/0.55)] [--region-detail-surface:oklch(0.16_0.012_55)] [--region-detail-surface-low:oklch(0.13_0.01_55)] [--region-detail-surface-raised:oklch(0.2_0.012_55)] [--surface:var(--region-detail-surface)] [--surface-2:var(--region-detail-surface-low)] [--surface-3:var(--region-detail-surface-raised)] [&>*]:shrink-0 max-[560px]:p-3">
            <section className="flex items-end justify-between gap-[18px] rounded-[var(--r)] border border-[var(--line-strong)] bg-[var(--region-detail-surface)] p-[18px] max-[820px]:flex-wrap max-[820px]:items-start max-[820px]:[&>div:first-child]:basis-full max-[560px]:p-3" aria-label={`${region.region} summary`}>
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

            <section className="grid gap-3 rounded-[var(--r)] border border-[var(--line)] bg-[var(--region-detail-surface)] px-[18px] py-4 max-[560px]:p-3" aria-label={`${region.region} teams`}>
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
