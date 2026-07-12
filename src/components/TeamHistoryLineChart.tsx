import { useState } from 'react'
import { LineChart, type LineChartProps, type LineChartTooltipPayloadItem } from './LineChart'
import {
  formatChartAttribution,
  formatChartInfluence,
  formatPreciseSignedDelta,
  formatProbability,
  isChartPointDetail,
  isMatchChartPointDetail,
  nonMatchDeltaFor,
  type ChartPointDetail,
} from '../lib/chartPoints'
import { formatChartTooltipTimestamp } from '../lib/chartTime'

export type TeamHistoryLineChartProps = Omit<LineChartProps, 'tooltipContent'>

const defaultValueFormat = (value: number) => String(Math.round(value))
const chartDetailDataKey = (key: string) => `${key}Detail`

export function TeamHistoryLineChart({ yFormat, ...props }: TeamHistoryLineChartProps) {
  const formatValue = yFormat ?? defaultValueFormat
  const [detailsPortal, setDetailsPortal] = useState<HTMLDivElement | null>(null)
  return (
    <div className="min-w-0">
      <LineChart
        {...props}
        yFormat={formatValue}
        tooltipContent={<TeamHistoryTooltip yFormat={formatValue} />}
        tooltipPortal={detailsPortal}
        tooltipWrapperStyle={{ position: 'static', width: '100%' }}
        persistentTooltip
      />
      <div ref={setDetailsPortal} className="min-w-0 px-[18px] pb-3" role="region" aria-label="Selected chart point details" />
    </div>
  )
}

function TeamHistoryTooltip({
  active,
  payload,
  yFormat,
}: {
  active?: boolean
  payload?: LineChartTooltipPayloadItem[]
  yFormat: (value: number) => string
}) {
  if (!active || !payload?.length) return null

  const rows = payload
    .map((item) => {
      const value = Number(item.value)
      const key = String(item.dataKey ?? '')
      const detail = item.payload?.[chartDetailDataKey(key)]
      if (!Number.isFinite(value)) return null
      const pointDetail = isChartPointDetail(detail) ? detail : undefined
      return {
        key,
        label: String(item.name ?? key),
        value,
        color: item.color ?? 'var(--muted)',
        detail: pointDetail,
        influence: formatChartInfluence(pointDetail),
      }
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)

  if (rows.length === 0) return null
  return (
    <div className="grid min-w-0 gap-2 border-t border-[var(--line)] pt-3 text-[0.78rem] whitespace-normal">
      <b className="mb-0.5 text-[0.74rem] text-[var(--text-strong)]">{formatChartTooltipTimestamp(payload)}</b>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-x-5 gap-y-3">
        {rows.map((row) => {
          const closeNote = dailyCloseNote(row.detail)
          return (
            <div className="grid min-w-0 content-start gap-1" key={row.key}>
              <div className="grid grid-cols-[12px_minmax(0,1fr)_minmax(70px,auto)] items-center gap-2 text-[var(--muted)]">
                <i className="inline-block h-[3px] w-[11px] shrink-0 rounded-full" style={{ background: row.color }} aria-hidden="true" />
                <em className="min-w-0 overflow-hidden text-ellipsis not-italic">{row.label}</em>
                <div className="grid justify-items-end gap-px">
                  <strong className="text-[var(--text)] tabular-nums">{yFormat(row.value)}</strong>
                  {typeof row.detail?.visibleDelta === 'number' && Number.isFinite(row.detail.visibleDelta) ? (
                    <b className="text-[0.66rem] font-semibold text-[var(--faint)] uppercase tabular-nums">Vs previous day {formatPreciseSignedDelta(row.detail.visibleDelta)}</b>
                  ) : null}
                </div>
              </div>
              {row.influence ? <small className="ml-5 text-[0.72rem] leading-[1.35] text-[var(--faint)]">{row.influence}</small> : null}
              {closeNote ? <div className="ml-5 text-[0.7rem] leading-[1.35] text-[var(--muted)] [overflow-wrap:anywhere]">{closeNote}</div> : null}
              <TooltipMatchList detail={row.detail} />
              <TooltipModelDetail detail={row.detail} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TooltipMatchList({ detail }: { detail?: ChartPointDetail }) {
  const matches = detail?.dayMatches
  if (!matches || matches.length <= 1) return null
  return (
    <div className="ml-5 grid gap-[5px] text-[0.7rem] leading-[1.35] text-[var(--muted)] [&>div]:[overflow-wrap:anywhere]">
      {matches.map((match, index) => {
        const label = formatChartInfluence(match)
        return label ? <div key={`${match.event ?? 'match'}-${match.opponent ?? index}-${index}`}>{label}</div> : null
      })}
    </div>
  )
}

function TooltipModelDetail({ detail }: { detail?: ChartPointDetail }) {
  if (!detail?.model && typeof detail?.visibleDelta !== 'number') return null
  const expected = typeof detail.model?.expectedWinProbability === 'number'
    ? formatProbability(detail.model.expectedWinProbability)
    : undefined
  const residual = typeof detail.model?.residual === 'number' && Number.isFinite(detail.model.residual)
    ? formatPreciseSignedDelta(detail.model.residual, 2)
    : undefined
  const attribution = (detail.model?.componentAttribution ?? detail.model?.attribution ?? [])
    .toSorted((left, right) => Math.abs(right.value) - Math.abs(left.value))
  const otherDelta = nonMatchDeltaFor(detail)

  if (!expected && !residual && attribution.length === 0 && typeof otherDelta !== 'number') return null

  return (
    <div className="ml-5 grid gap-[5px]">
      {expected || residual ? (
        <div className="text-[0.7rem] leading-[1.35] text-[var(--faint)]">
          {expected ? `Expected win ${expected}` : null}
          {expected && residual ? ' / ' : null}
          {residual ? `Residual ${residual}` : null}
        </div>
      ) : null}
      {attribution.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {attribution.map((entry) => (
            <span className="inline-flex w-fit items-center rounded-sm border border-[color-mix(in_oklch,var(--line-strong),transparent_20%)] bg-[color-mix(in_oklch,var(--surface),transparent_55%)] px-[5px] py-0.5 text-[0.68rem] text-[var(--muted)] tabular-nums" key={entry.key}>{formatChartAttribution(entry)}</span>
          ))}
        </div>
      ) : null}
      {typeof otherDelta === 'number' ? (
        <div className="text-[0.7rem] leading-[1.35] text-[var(--faint)]">Unattributed adjustment {formatPreciseSignedDelta(otherDelta)}</div>
      ) : null}
    </div>
  )
}

function dailyCloseNote(detail?: ChartPointDetail) {
  const visibleDelta = finiteNumber(detail?.visibleDelta)
  if (typeof visibleDelta !== 'number' || visibleDelta === 0) return undefined

  const matchDelta = matchLedgerDelta(detail)
  if (typeof matchDelta !== 'number' || matchDelta === 0 || Math.sign(matchDelta) === Math.sign(visibleDelta)) {
    return undefined
  }

  const driver = strongestComponentDriver(detail)
  const driverText = driver ? ` Largest component change: ${driver.label} ${formatPreciseSignedDelta(driver.value)}.` : ''
  return `Match result effect: ${formatPreciseSignedDelta(matchDelta)}. Overall change from previous day: ${formatPreciseSignedDelta(visibleDelta)}.${driverText}`
}

function matchLedgerDelta(detail?: ChartPointDetail) {
  const matches = (detail?.dayMatches ?? (detail ? [detail] : []))
    .filter(isMatchChartPointDetail)
  if (matches.length === 0) return undefined

  let total = 0
  let seen = false
  for (const match of matches) {
    const delta = finiteNumber(match.delta)
    if (typeof delta !== 'number') continue
    total += delta
    seen = true
  }
  return seen ? Math.round(total * 10) / 10 : undefined
}

function strongestComponentDriver(detail?: ChartPointDetail) {
  return detail?.model?.componentAttribution
    ?.toSorted((left, right) => Math.abs(right.value) - Math.abs(left.value))
    .at(0)
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
