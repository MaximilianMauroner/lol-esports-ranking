import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Globe2, Info, Swords, Trophy, X } from 'lucide-react'
import type { RegionStrength } from '../lib/regionStrength'
import type { PublicTeamStanding } from '../lib/publicArtifacts/schema'
import { extent, formatDecimal, formatNumber, formatRating, formatRatio, formatRecord } from '../lib/display'
import { currentTopTierRegionForLeague } from '../data/regionTaxonomy'
import { DataState, HeatBar, HeatChip, PickButton, RegionBadge } from '../components/ui'
import { Button } from '../components/ui/button'
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from '../components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'

export function RegionsView({
  regions,
  standings,
  pickedIds,
  onToggle,
}: {
  regions: RegionStrength[]
  standings: RegionStanding[]
  pickedIds: Set<string>
  onToggle: (region: RegionStrength) => void
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
        Regional power is the match-volume-weighted strength of each region's leagues, anchored to the same global
        rating scale and tempered by international results. Add regions to compare their power profile in the shared drawer.
      </p>

      <div className="ribbon">
        <RibbonCell icon={<Trophy size={18} />} label="Strongest region" value={strongest?.region ?? '—'} detail={`Power score ${formatRating(strongest?.score)}`} />
        <RibbonCell icon={<Globe2 size={18} />} label="Regions tracked" value={String(regions.length)} detail="Excludes international events" />
        <RibbonCell
          icon={<Swords size={18} />}
          label="Best intl. résumé"
          value={bestRecord?.region ?? '—'}
          detail={`${formatRatio(bestRecord?.opponentAdjustedWinRate)} adj · ${formatSignedDecimal(bestRecord?.winsOverExpected)} vs exp`}
        />
      </div>

      <section className="panel region-panel">
        <div className="panel__head region-panel__head">
          <div>
            <p className="eyebrow">Compare regions</p>
            <h2>{pickedCount > 0 ? `${pickedCount} selected` : 'Add regions to compare'}</h2>
          </div>
          <span className="heatscale">
            Cold<i aria-hidden="true" />Hot
          </span>
        </div>

        <div className="region-board">
          {regions.map((region) => (
            <div
              key={region.region}
              className={`region-row${pickedIds.has(region.region) ? ' is-picked' : ''}`}
            >
              <Button
                type="button"
                variant="ghost"
                className="region-row__open"
                aria-label={`Open ${region.region} region detail`}
                onClick={() => setSelectedRegionId(region.region)}
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
                  <HeatChip value={region.score} min={min} max={max} label={formatRating(region.score)} />
                  <HeatBar value={region.score} min={min} max={max} />
                  <span className="region-mobile-stat">{formatSignedDecimal(region.winsOverExpected)} vs exp</span>
                </span>
                <span className="region-intl">
                  <span>
                    <b>{formatRecord(region.internationalWins, region.internationalLosses)}</b> intl ·{' '}
                    {formatRatio(region.internationalWinRate)}
                  </span>
                  <small>
                    vs {formatRating(region.averageOpponentRating)} avg · {formatSignedDecimal(region.winsOverExpected)} vs exp
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
                <PickButton picked={pickedIds.has(region.region)} onToggle={() => onToggle(region)} label={region.region} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <RegionDetailDrawer region={selectedRegion} teams={selectedRegionTeams} onClose={closeRegionDetail} />
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

function RegionDetailDrawer({ region, teams, onClose }: { region: RegionStrength | null; teams: RegionDrawerTeam[]; onClose: () => void }) {
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
              <p>
                {region.flagshipLeague ?? 'Multiple flagship leagues'} · {formatTier(region.tier)} · {formatNumber(region.teamCount)} flagship teams
              </p>
            </div>
            <strong>
              {formatRating(region.score)}
              <span>Power score</span>
            </strong>
          </section>

          <section className="region-detail__stats" aria-label={`${region.region} metrics`}>
            <DetailStat
              label="Top team power"
              value={formatRating(region.topTeamRating)}
              description="Rating of the strongest eligible team in this region's flagship league layer."
            />
            <DetailStat
              label="Flagship leagues"
              value={formatNumber(region.leagueCount)}
              description="Top competitive league layer used to calculate the region score."
            />
            <DetailStat
              label="Ecosystem leagues"
              value={formatNumber(region.ecosystemLeagueCount)}
              description="All leagues mapped into the broader regional ecosystem, including lower tiers."
            />
            <DetailStat
              label="Intl. record"
              value={formatRecord(region.internationalWins, region.internationalLosses)}
              description="Wins and losses by flagship leagues against teams from other regions."
            />
            <DetailStat
              label="Intl. win rate"
              value={formatRatio(region.internationalWinRate)}
              description="Raw international match win rate before opponent strength adjustment."
            />
            <DetailStat
              label="Adjusted intl. rate"
              value={formatRatio(region.opponentAdjustedWinRate)}
              description="International win rate adjusted for opponent power."
            />
            <DetailStat
              label="Wins vs expected"
              value={formatSignedDecimal(region.winsOverExpected)}
              description="International wins above or below the model's opponent-adjusted expectation."
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
    .filter((team) => {
      const teamRegion = currentTopTierRegionForLeague(team.league, team.region)
      if (teamRegion !== region.region) return false
      return region.leagueCount === 1 && region.flagshipLeague ? team.league === region.flagshipLeague : true
    })
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

function formatSignedDecimal(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (Math.abs(value) < 0.05) return '0'
  return value > 0 ? `+${formatDecimal(value)}` : formatDecimal(value)
}
