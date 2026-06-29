import { LineChart, type LineChartProps, type LineChartTooltipPayloadItem } from './LineChart'
import {
  formatChartAttribution,
  formatChartInfluence,
  formatPreciseSignedDelta,
  formatProbability,
  isChartPointDetail,
  nonMatchDeltaFor,
  type ChartPointDetail,
} from '../lib/chartPoints'
import { formatChartTooltipTimestamp } from '../lib/chartTime'

export type TeamHistoryLineChartProps = Omit<LineChartProps, 'tooltipContent'>

const defaultValueFormat = (value: number) => String(Math.round(value))
const chartDetailDataKey = (key: string) => `${key}Detail`

export function TeamHistoryLineChart({ yFormat, ...props }: TeamHistoryLineChartProps) {
  const formatValue = yFormat ?? defaultValueFormat
  return (
    <LineChart
      {...props}
      yFormat={formatValue}
      tooltipContent={<TeamHistoryTooltip yFormat={formatValue} />}
    />
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
    <div className="chart__tooltip chart__tooltip--rich">
      <b>{formatChartTooltipTimestamp(payload)}</b>
      <div className="chart__tooltip-list">
        {rows.map((row) => (
          <div className="chart__tooltip-row" key={row.key}>
            <div className="chart__tooltip-main">
              <i style={{ background: row.color }} aria-hidden="true" />
              <em>{row.label}</em>
              <div className="chart__tooltip-value">
                <strong>{yFormat(row.value)}</strong>
                {typeof row.detail?.visibleDelta === 'number' && Number.isFinite(row.detail.visibleDelta) ? (
                  <b className="chart__tooltip-net">Net {formatPreciseSignedDelta(row.detail.visibleDelta)}</b>
                ) : null}
              </div>
            </div>
            {row.influence ? <small>{row.influence}</small> : null}
            <TooltipMatchList detail={row.detail} />
            <TooltipModelDetail detail={row.detail} />
          </div>
        ))}
      </div>
    </div>
  )
}

function TooltipMatchList({ detail }: { detail?: ChartPointDetail }) {
  const matches = detail?.dayMatches
  if (!matches || matches.length <= 1) return null
  const listedMatches = detail.kind === 'standing-adjustment' && detail.dayMatchCount === 1
    ? matches.slice(0, -1)
    : matches
  if (listedMatches.length === 0) return null
  const visibleMatches = listedMatches.slice(-4)
  const hiddenCount = listedMatches.length - visibleMatches.length
  return (
    <div className="chart__tooltip-matches">
      {visibleMatches.map((match, index) => {
        const label = formatChartInfluence(match)
        return label ? <div key={`${match.event ?? 'match'}-${match.opponent ?? index}-${index}`}>{label}</div> : null
      })}
      {hiddenCount > 0 ? <div>+{hiddenCount} earlier</div> : null}
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
    .slice(0, 4)
  const otherDelta = nonMatchDeltaFor(detail)

  if (!expected && !residual && attribution.length === 0 && typeof otherDelta !== 'number') return null

  return (
    <div className="chart__tooltip-model">
      {expected || residual ? (
        <div className="chart__tooltip-expectation">
          {expected ? `Expected win ${expected}` : null}
          {expected && residual ? ' / ' : null}
          {residual ? `Residual ${residual}` : null}
        </div>
      ) : null}
      {attribution.length > 0 ? (
        <div className="chart__tooltip-attribution">
          {attribution.map((entry) => (
            <span className="chart__tooltip-chip" key={entry.key}>{formatChartAttribution(entry)}</span>
          ))}
        </div>
      ) : null}
      {typeof otherDelta === 'number' ? (
        <div className="chart__tooltip-expectation">Unattributed adjustment {formatPreciseSignedDelta(otherDelta)}</div>
      ) : null}
    </div>
  )
}
