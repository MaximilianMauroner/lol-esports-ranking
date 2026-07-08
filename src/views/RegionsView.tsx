import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Check, Globe2, Info, Plus, Swords, Trophy, X } from 'lucide-react'
import { isRegionPowerTeam, type RegionStrength } from '../lib/regionStrength'
import type { PublicRegionHistoryScope, PublicRegionHistorySeries, PublicTeamStanding } from '../lib/publicArtifacts/schema'
import {
  extent,
  formatDate,
  formatDecimal,
  formatNumber,
  formatRating,
  formatRatio,
  formatRecord,
  pctWithin,
} from '../lib/display'
import { DataState, RegionBadge } from '../components/ui'
import { Button } from '../components/ui/button'
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from '../components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'

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
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null)
  const [min, max] = useMemo(() => extent(regions.map((region) => region.score)), [regions])
  const strongest = regions[0]
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
  const closeRegionDetail = useCallback(() => setSelectedRegionId(null), [])

  if (regions.length === 0) {
    return (
      <div className="view">
        <DataState icon={<Globe2 size={26} aria-hidden="true" />} title="No regional data in this scope">
          This snapshot has no league-anchored regions. Try a broader scope.
        </DataState>
      </div>
    )
  }

  return (
    <div className="view">
      <p className="view__intro">
        Region power is the average rating of each region's top three eligible flagship teams, with whole-region depth shown alongside it.
        Add regions to compare their profile in the shared drawer.
      </p>

      <div className="ribbon">
        <RibbonCell icon={<Trophy size={18} />} label="Strongest region" value={strongest?.region ?? '—'} detail={`Region power ${formatRating(strongest?.score)}`} />
        <RibbonCell icon={<Globe2 size={18} />} label="Regions tracked" value={String(regions.length)} detail="Excludes international events" />
        <RibbonCell
          icon={<Swords size={18} />}
          label="Best international resume"
          value={bestRecord?.region ?? '—'}
          detail={`${formatRatio(bestRecord?.opponentAdjustedWinRate)} adjusted · ${formatSignedDecimal(bestRecord?.winsOverExpected)} vs expected`}
        />
      </div>

      <section className="panel region-panel">
        <div className="panel__head region-panel__head">
          <div>
            <p className="eyebrow">Compare regions</p>
            <h2>{pickedCount > 0 ? `${pickedCount} selected` : 'Add regions to compare'}</h2>
          </div>
          <span className="region-power-key">
            <span>Region power</span>
            <i aria-hidden="true" />
            <strong>Top-three avg</strong>
          </span>
        </div>

        <div className="region-board">
          {regions.map((region) => {
            const picked = pickedIds.has(region.region)

            return (
              <div
                key={region.region}
                className={`region-row${picked ? ' is-picked' : ''}`}
              >
                <Button
                  type="button"
                  variant="ghost"
                  className="region-row__open"
                  title={`Open ${region.region} region detail`}
                  onClick={() => {
                    onRequestRegionHistory?.()
                    setSelectedRegionId(region.region)
                  }}
                  onFocus={onRequestRegionHistory}
                  onPointerEnter={onRequestRegionHistory}
                >
                  <span className="region-rank">{region.rank}</span>
                  <span className="region-id">
                    <RegionBadge region={region.region} />
                    <span>
                      <b>{region.region}</b>
                      <small>
                        {region.flagshipLeague ?? 'Multiple leagues'} · {region.teamCount} flagship teams
                      </small>
                    </span>
                  </span>
                  <span className="region-score">
                    <RegionPowerMeter value={region.score} min={min} max={max} label="Region power" />
                    <span className="region-mobile-stat">{formatSignedDecimal(region.winsOverExpected)} vs expected</span>
                  </span>
                  <span className="region-intl">
                    <span>
                      <b>{formatRecord(region.internationalWins, region.internationalLosses)}</b> intl ·{' '}
                      {formatRatio(region.internationalWinRate)}
                    </span>
                    <small>
                      vs {formatRating(region.averageOpponentRating)} average · {formatSignedDecimal(region.winsOverExpected)} vs expected
                    </small>
                  </span>
                  <span className="region-teams">
                    {region.topTeams.slice(0, 3).map((team) => (
                      <span className="tag" key={team.team}>
                        <b>{team.code ?? team.team.slice(0, 3).toUpperCase()}</b>
                        {formatRating(team.rating)}
                      </span>
                    ))}
                  </span>
                </Button>
                <div className="region-pick">
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
        series={selectedRegion ? regionHistory?.series[selectedRegion.region] : undefined}
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

function RegionPowerMeter({ value, min, max, label }: { value: number; min: number; max: number; label: string }) {
  const pct = pctWithin(value, min, max)

  return (
    <span className="region-power" role="img" aria-label={`${label} ${formatRating(value)}`}>
      <span className="region-power__score">{formatRating(value)}</span>
      <span className="region-power__meter" aria-hidden="true">
        <span className="region-power__fill" style={{ width: `${pct}%` }} />
      </span>
    </span>
  )
}

function RegionCompareButton({ picked, onToggle, label }: { picked: boolean; onToggle: () => void; label: string }) {
  const tooltip = picked ? `Remove ${label} from comparison` : `Compare ${label}`
  const accessibleLabel = picked ? `Comparing ${label}, remove from comparison` : tooltip

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className={`region-compare${picked ? ' is-picked' : ''}`}
          onClick={onToggle}
          aria-label={accessibleLabel}
          aria-pressed={picked}
        >
          {picked ? <Check size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
          <span>{picked ? 'Comparing' : 'Compare'}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
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
      <div className="region-sparkline region-sparkline--empty" aria-label={`${region} region trajectory unavailable`}>
        <small>Power trajectory</small>
        <b>History pending</b>
      </div>
    )
  }

  return (
    <div
      className="region-sparkline"
      aria-label={`${region} region power trajectory ${formatSignedDecimal(delta)} from ${formatDate(first[0])} to ${formatDate(last[0])}`}
    >
      <div>
        <small>Power trajectory</small>
        <b className={deltaTone}>{formatSignedDecimal(delta)}</b>
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
          className="w-full max-w-none gap-0 border-l border-[var(--line-strong)] bg-[var(--surface)] p-0 text-[var(--text)] shadow-[var(--shadow-pop)] sm:w-[min(980px,94vw)] sm:max-w-none"
          style={{ width: 'min(980px, 100vw)', maxWidth: 'none' }}
        >
          <SheetHeader className="drawer__head flex-row items-center p-[18px_22px] text-left">
            <SheetTitle className="mr-auto text-[1.1rem] font-semibold text-[var(--text-strong)]">{region.region} region detail</SheetTitle>
            <SheetClose asChild>
              <Button type="button" variant="ghost">
                <X size={16} aria-hidden="true" />
                Close
              </Button>
            </SheetClose>
          </SheetHeader>
          <div className="drawer__body region-detail__body min-h-0 flex-1 overflow-auto overscroll-contain">
            <section className="region-detail__hero" aria-label={`${region.region} summary`}>
              <div>
                <p className="eyebrow">Region #{region.rank}</p>
                <h3>{region.region}</h3>
                <p className="region-detail__meta">
                  <span>{region.flagshipLeague ?? 'Multiple flagship leagues'}</span>
                  <span>{formatTier(region.tier)}</span>
                  <span>{formatCountWithUnit(region.teamCount, 'flagship team')}</span>
                  <span>{formatCountWithUnit(region.leagueCount, 'flagship league')}</span>
                  <span>{formatCountWithUnit(region.ecosystemLeagueCount, 'ecosystem league')}</span>
                </p>
              </div>
              <strong>
                {formatRating(region.score)}
                <span>Region power</span>
              </strong>
              <RegionPowerSparkline series={series} region={region.region} />
            </section>

            <section className="region-detail__stats" aria-label={`${region.region} metrics`}>
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
                value={formatRating(region.score)}
                description="Headline regional score used for ranking regions: the average rating of the three strongest eligible flagship teams. If a region has fewer than three eligible teams, it averages the available teams."
              />
              <DetailStat
                label="Flagship-team average"
                value={formatRating(region.totalTeamRating)}
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

            <section className="region-detail__section" aria-label={`${region.region} teams`}>
              <div className="region-detail__section-head">
                <p className="eyebrow">League teams</p>
                <h3>All flagship representatives</h3>
              </div>
              <div className="region-detail__teams">
                {displayedTeams.length > 0 ? (
                  displayedTeams.map((team, index) => (
                    <div className="region-detail__team" key={team.team}>
                      <span>{team.rank ? `#${team.rank}` : `#${index + 1}`}</span>
                      <div>
                        <b>{team.team}</b>
                        {team.code ? <small>{team.code}</small> : null}
                      </div>
                      <strong>{formatRating(team.rating)}</strong>
                    </div>
                  ))
                ) : (
                  <p className="muted">No team rows are available for this region in the current scope.</p>
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
    <div className="region-detail__stat">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="region-detail__stat-label"
            aria-label={`${label}: ${description}`}
          >
            <span>{label}</span>
            <Info size={13} aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{description}</TooltipContent>
      </Tooltip>
      <strong>{value}</strong>
    </div>
  )
}

function RibbonCell({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="ribbon__cell">
      <span className="ribbon__icon">{icon}</span>
      <div>
        <span className="lbl">{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
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
