import { useState } from 'react'
import { estimatePublicMatchup, type PublicMatchupModel } from '../lib/publicMatchup'
import { formatModelVersion } from '../lib/display'
import type { RankingSummaryStanding } from '../lib/snapshot'
import { Segmented } from './ui'

const FORMATS = ['1', '3', '5'] as const
type Format = typeof FORMATS[number]

/**
 * Who would win, answered first. The comparison table used to open with model
 * internals and never showed the win chance, which is why most people compare.
 * The band under the bar is the model's likely range from team uncertainty.
 */
export function HeadToHead({ home, away, model }: { home: RankingSummaryStanding; away: RankingSummaryStanding; model?: PublicMatchupModel }) {
  const [format, setFormat] = useState<Format>('3')
  const bestOf = Number(format)
  const estimate = estimatePublicMatchup(home, away, model, { bestOf, sideAssumption: 'neutral', uncertaintyBands: true })
  const homeChance = Math.round(estimate.homeSeriesWinProbability * 100)
  const band = estimate.uncertaintyBand?.homeSeriesWinProbability
  const low = band ? Math.round(band.lower * 100) : undefined
  const high = band ? Math.round(band.upper * 100) : undefined
  const homeName = home.code ?? home.team
  const awayName = away.code ?? away.team

  return (
    <section className="grid gap-3 border-b border-[var(--line)] px-[22px] py-5 max-sm:px-3.5" aria-label={`${home.team} against ${away.team}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-[length:var(--t-5)] font-semibold text-[var(--text-strong)]">Who would win</h3>
        <Segmented
          value={format}
          options={FORMATS.map((value) => ({ value, label: `Bo${value}` }))}
          onChange={setFormat}
          ariaLabel="Series format"
        />
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
        <span className="grid">
          <b className="text-[length:var(--t-4)] font-semibold text-[var(--text-strong)]">{home.team}</b>
          <span className="text-[length:var(--t-8)] leading-none font-bold text-[var(--text-strong)]">{homeChance}%</span>
        </span>
        <span className="pb-1 text-xs text-[var(--faint)]">vs</span>
        <span className="grid justify-items-end text-right">
          <b className="text-[length:var(--t-4)] font-semibold text-[var(--text-strong)]">{away.team}</b>
          <span className="text-[length:var(--t-8)] leading-none font-bold text-[var(--text-strong)]">{100 - homeChance}%</span>
        </span>
      </div>
      <div className="grid gap-1">
        <span className="flex h-3 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
          <span className="rounded-l-full bg-[var(--series-1)]" style={{ width: `${homeChance}%` }} />
          <span className="rounded-r-full bg-[var(--series-2)]" style={{ width: `${100 - homeChance}%` }} />
        </span>
        {low !== undefined && high !== undefined ? (
          <span className="relative h-2" aria-hidden="true">
            <span className="absolute top-0.5 h-1 rounded-full bg-[var(--muted)] opacity-70" style={{ left: `${low}%`, width: `${Math.max(1, high - low)}%` }} />
          </span>
        ) : null}
      </div>
      <p className="text-sm text-[var(--muted)]">
        {low !== undefined && high !== undefined
          ? <>Likely range for {homeName}: {low}% to {high}%. {low < 50 && high > 50 ? 'Either team can win this.' : `${homeChance >= 50 ? homeName : awayName} are favoured.`} </>
          : null}
        <span className="text-xs text-[var(--faint)]">Neutral side, best of {bestOf}. Model {formatModelVersion(model?.version)}.</span>
      </p>
    </section>
  )
}
