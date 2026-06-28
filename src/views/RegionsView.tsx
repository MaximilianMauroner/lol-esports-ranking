import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Globe2, Swords, Trophy, X } from 'lucide-react'
import type { RegionStrength } from '../lib/regionStrength'
import { extent, formatDecimal, formatNumber, formatRating, formatRatio, formatRecord } from '../lib/display'
import { DataState, HeatBar, HeatChip, PickButton, RegionBadge } from '../components/ui'
import { Button } from '../components/ui/button'

export function RegionsView({
  regions,
  pickedIds,
  onToggle,
}: {
  regions: RegionStrength[]
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
  const closeRegionDetail = useCallback(() => setSelectedRegionId(null), [])

  function onRegionKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, region: RegionStrength) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    setSelectedRegionId(region.region)
  }

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
        <RibbonCell icon={<Trophy size={18} />} label="Strongest region" value={strongest?.region ?? '—'} detail={`Power ${formatRating(strongest?.score)}`} />
        <RibbonCell icon={<Globe2 size={18} />} label="Regions tracked" value={String(regions.length)} detail="Excludes international events" />
        <RibbonCell
          icon={<Swords size={18} />}
          label="Best intl. résumé"
          value={bestRecord?.region ?? '—'}
          detail={`${formatRatio(bestRecord?.opponentAdjustedWinRate)} adj · ${formatSignedDecimal(bestRecord?.winsOverExpected)} vs exp`}
        />
      </div>

      <div className="section-head">
        <div>
          <p className="eyebrow">Compare regions</p>
          <h2>{pickedCount > 0 ? `${pickedCount} selected` : 'Add regions to compare'}</h2>
        </div>
        <span className="heatscale">
          Cold<i />Hot
        </span>
      </div>

      <div className="region-board">
        {regions.map((region) => (
          <div
            key={region.region}
            className={`region-row${pickedIds.has(region.region) ? ' is-picked' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={`Open ${region.region} region detail`}
            onClick={() => setSelectedRegionId(region.region)}
            onKeyDown={(event) => onRegionKeyDown(event, region)}
          >
            <div className="region-rank">{region.rank}</div>
            <div className="region-id">
              <RegionBadge region={region.region} />
              <span>
                <b>{region.region}</b>
                <small>
                  {region.flagshipLeague ?? 'Multiple leagues'} · {region.teamCount} flagship teams
                </small>
              </span>
            </div>
            <div className="region-score">
              <HeatChip value={region.score} min={min} max={max} label={formatRating(region.score)} />
              <HeatBar value={region.score} min={min} max={max} />
            </div>
            <div className="region-intl">
              <span>
                <b>{formatRecord(region.internationalWins, region.internationalLosses)}</b> intl ·{' '}
                {formatRatio(region.internationalWinRate)}
              </span>
              <small>
                vs {formatRating(region.averageOpponentRating)} avg · {formatSignedDecimal(region.winsOverExpected)} vs exp
              </small>
            </div>
            <div className="region-teams">
              {region.topTeams.slice(0, 3).map((team) => (
                <span className="tag" key={team.team}>
                  <b>{team.code ?? team.team.slice(0, 3).toUpperCase()}</b>
                  {formatRating(team.rating)}
                </span>
              ))}
            </div>
            <div className="region-pick" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
              <PickButton picked={pickedIds.has(region.region)} onToggle={() => onToggle(region)} label={region.region} />
            </div>
          </div>
        ))}
      </div>

      <RegionDetailDrawer region={selectedRegion} onClose={closeRegionDetail} />
    </div>
  )
}

function RegionDetailDrawer({ region, onClose }: { region: RegionStrength | null; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!region) return
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (activeElement && !activeElement.closest('.drawer')) previousFocusRef.current = activeElement
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const previousFocus = previousFocusRef.current
      window.setTimeout(() => {
        if (document.querySelector('.drawer.is-open')) return
        if (previousFocus?.isConnected) previousFocus.focus()
        previousFocusRef.current = null
      }, 0)
    }
  }, [region, onClose])

  if (!region) return null

  return (
    <div className="drawer region-detail is-open" role="dialog" aria-modal="true" aria-label={`${region.region} region detail`}>
      <div className="drawer__scrim" onClick={onClose} />
      <div className="drawer__panel">
        <div className="drawer__head">
          <h2>{region.region} region detail</h2>
          <Button ref={closeRef} type="button" variant="ghost" className="border border-transparent bg-transparent text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]" onClick={onClose}>
            <X size={16} aria-hidden="true" />
            Close
          </Button>
        </div>
        <div className="drawer__body region-detail__body">
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
            <DetailStat label="Top team rating" value={formatRating(region.topTeamRating)} />
            <DetailStat label="Flagship leagues" value={formatNumber(region.leagueCount)} />
            <DetailStat label="Ecosystem leagues" value={formatNumber(region.ecosystemLeagueCount)} />
            <DetailStat label="Intl. record" value={formatRecord(region.internationalWins, region.internationalLosses)} />
            <DetailStat label="Intl. win rate" value={formatRatio(region.internationalWinRate)} />
            <DetailStat label="Adjusted intl. rate" value={formatRatio(region.opponentAdjustedWinRate)} />
            <DetailStat label="Wins vs expected" value={formatSignedDecimal(region.winsOverExpected)} />
            <DetailStat label="Avg opponent" value={formatRating(region.averageOpponentRating)} />
            <DetailStat label="Connectivity" value={formatRatio(region.connectivity)} />
          </section>

          <section className="region-detail__section" aria-label={`${region.region} top teams`}>
            <div className="region-detail__section-head">
              <p className="eyebrow">Top teams</p>
              <h3>Flagship representatives</h3>
            </div>
            <div className="region-detail__teams">
              {region.topTeams.length > 0 ? (
                region.topTeams.map((team, index) => (
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
      </div>
    </div>
  )
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="region-detail__stat">
      <span>{label}</span>
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
