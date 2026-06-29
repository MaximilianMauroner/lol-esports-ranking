export type ChartAttributionEntry = {
  key: 'stable' | 'league' | 'placement' | 'form' | 'roster' | 'uncertainty' | 'context'
  label: string
  value: number
}

export type ChartModelDetail = {
  expectedWinProbability?: number
  residual?: number
  evidence?: number
  strengthSignal?: number
  attribution?: ChartAttributionEntry[]
  components?: ChartAttributionEntry[]
  componentAttribution?: ChartAttributionEntry[]
}

export type ChartPointDetail = {
  kind?: 'match' | 'standing-adjustment'
  adjustmentReason?: 'published-standing-reconciliation'
  event?: string
  opponent?: string
  result?: 'W' | 'L'
  wins?: number
  losses?: number
  games?: number
  bestOf?: number
  delta?: number
  visibleDelta?: number
  passive?: boolean
  dayMatchCount?: number
  dayMatches?: ChartPointDetail[]
  model?: ChartModelDetail
  sourceProvider?: string
}

export type ChartPoint = {
  t: number
  y: number
  detail?: ChartPointDetail
}

export function isValidChartPoint(point: ChartPoint) {
  return Number.isFinite(point.t) && Number.isFinite(point.y)
}

export function isChartPointDetail(value: unknown): value is ChartPointDetail {
  return Boolean(value && typeof value === 'object')
}

export function formatChartInfluence(detail?: ChartPointDetail) {
  if (!detail) return undefined

  if (detail.dayMatchCount && detail.dayMatchCount > 1) {
    const parts = [
      `Day close · ${detail.dayMatchCount} matches`,
      typeof detail.delta === 'number' && Number.isFinite(detail.delta) ? `match ledger ${formatSignedDelta(detail.delta)}` : undefined,
    ].filter((part): part is string => Boolean(part))
    return parts.join(' · ')
  }

  if (detail.passive) return 'Passive rank movement'
  if (detail.kind === 'standing-adjustment') {
    const parts = [
      detail.event ?? 'Published standing adjustment',
      typeof detail.delta === 'number' && Number.isFinite(detail.delta) ? formatSignedDelta(detail.delta) : undefined,
    ].filter((part): part is string => Boolean(part))
    return parts.join(' · ')
  }

  const result = formatResult(detail)
  const parts = [
    detail.opponent ? [result, `vs ${detail.opponent}`].filter(Boolean).join(' ') : result,
    detail.event,
    typeof detail.delta === 'number' && Number.isFinite(detail.delta) ? formatSignedDelta(detail.delta) : undefined,
  ].filter((part): part is string => Boolean(part))

  return parts.length > 0 ? parts.join(' · ') : undefined
}

export function formatSignedDelta(value: number) {
  const rounded = Math.round(value)
  if (rounded === 0) return '0'
  return rounded > 0 ? `+${rounded}` : String(rounded)
}

export function formatPreciseSignedDelta(value: number, decimals = 1) {
  const factor = 10 ** decimals
  const rounded = Math.round(value * factor) / factor
  if (Object.is(rounded, -0) || rounded === 0) return '0'
  return rounded > 0 ? `+${rounded}` : String(rounded)
}

export function formatProbability(value: number) {
  if (!Number.isFinite(value)) return undefined
  return `${Math.round(value * 100)}%`
}

export function formatChartAttribution(entry: ChartAttributionEntry) {
  return `${entry.label} ${formatPreciseSignedDelta(entry.value)}`
}

export function modelDeltaFor(detail?: ChartPointDetail) {
  if (!detail) return undefined
  const values = (detail.model?.componentAttribution ?? detail.model?.attribution)?.map((entry) => entry.value) ?? []
  if (values.length === 0) return detail.delta
  return values.reduce((total, value) => total + value, 0)
}

export function nonMatchDeltaFor(detail?: ChartPointDetail) {
  if (typeof detail?.visibleDelta !== 'number' || !Number.isFinite(detail.visibleDelta)) return undefined
  const modelDelta = modelDeltaFor(detail)
  if (typeof modelDelta !== 'number' || !Number.isFinite(modelDelta)) return undefined
  const difference = detail.visibleDelta - modelDelta
  return Math.abs(difference) >= 1 ? difference : undefined
}

function formatResult(detail: ChartPointDetail) {
  const score = typeof detail.wins === 'number' && typeof detail.losses === 'number'
    ? `${detail.wins}-${detail.losses}`
    : undefined
  return [detail.result, score].filter(Boolean).join(' ') || undefined
}
