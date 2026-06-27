import { useMemo } from 'react'
import { Globe2, Swords, Trophy } from 'lucide-react'
import type { RegionStrength } from '../lib/regionStrength'
import { extent, formatDecimal, formatRating, formatRatio, formatRecord } from '../lib/display'
import { DataState, HeatBar, HeatChip, PickButton } from '../components/ui'

export function RegionsView({
  regions,
  pickedIds,
  onToggle,
}: {
  regions: RegionStrength[]
  pickedIds: Set<string>
  onToggle: (region: RegionStrength) => void
}) {
  const [min, max] = useMemo(() => extent(regions.map((region) => region.score)), [regions])
  const strongest = regions[0]
  const bestRecord = useMemo(
    () => [...regions].sort((a, b) => (b.opponentAdjustedWinRate ?? 0) - (a.opponentAdjustedWinRate ?? 0))[0],
    [regions],
  )
  const pickedCount = regions.filter((region) => pickedIds.has(region.region)).length

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
          <div key={region.region} className={`region-row${pickedIds.has(region.region) ? ' is-picked' : ''}`}>
            <div className="region-rank">{region.rank}</div>
            <div className="region-id">
              <b>{region.region}</b>
              <small>
                {region.flagshipLeague ?? 'Multiple leagues'} · {region.teamCount} flagship teams
              </small>
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
            <div className="region-pick">
              <PickButton picked={pickedIds.has(region.region)} onToggle={() => onToggle(region)} label={region.region} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function RibbonCell({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
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

function formatSignedDecimal(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (Math.abs(value) < 0.05) return '0'
  return value > 0 ? `+${formatDecimal(value)}` : formatDecimal(value)
}
