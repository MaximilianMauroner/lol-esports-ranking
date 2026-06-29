/** Shared formatting + strength-heat helpers for the UI layer. */

const numberFormatter = new Intl.NumberFormat('en')
const ratingFormatter = new Intl.NumberFormat('en', { maximumFractionDigits: 0 })
const oneDecimal = new Intl.NumberFormat('en', { maximumFractionDigits: 1 })
const twoDecimal = new Intl.NumberFormat('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const dateFormatter = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' })
const dateTimeFormatter = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

export const HEAT_BINS = 6

/** Maps a value within [min, max] to a 1..6 strength-heat bin (cold to hot). */
export function heatBin(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return 1
  if (max <= min) return 3
  const t = (value - min) / (max - min)
  return Math.min(HEAT_BINS, Math.max(1, Math.ceil(t * HEAT_BINS)))
}

export function heatClass(value: number, min: number, max: number) {
  return `heat-${heatBin(value, min, max)}`
}

export function fillClass(value: number, min: number, max: number) {
  return `fill-${heatBin(value, min, max)}`
}

export function extent(values: number[]): [number, number] {
  let min = Infinity
  let max = -Infinity
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    if (value < min) min = value
    if (value > max) max = value
  }
  if (min === Infinity) return [0, 1]
  return [min, max]
}

export function pctWithin(value: number, min: number, max: number) {
  if (max <= min) return 100
  return Math.max(2, Math.min(100, Math.round(((value - min) / (max - min)) * 100)))
}

export function formatNumber(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) ? numberFormatter.format(value) : '—'
}

export function formatRating(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) ? ratingFormatter.format(value) : '—'
}

export function formatSigned(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return '0'
  return value > 0 ? `+${Math.round(value)}` : `${Math.round(value)}`
}

export function formatDecimal(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) ? oneDecimal.format(value) : '—'
}

export function formatMultiplier(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) ? twoDecimal.format(value) : '—'
}

/** Confidence-style values already on a 0-100 scale. */
export function formatPercentValue(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `${oneDecimal.format(value)}%`
}

/** Ratios on a 0-1 scale. */
export function formatRatio(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `${Math.round(value * 100)}%`
}

export function formatRecord(wins?: number, losses?: number) {
  if (typeof wins !== 'number' || typeof losses !== 'number') return '—'
  return `${wins}–${losses}`
}

export function formatDate(value?: string) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : dateFormatter.format(date)
}

export function formatDateTime(value?: string) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : dateTimeFormatter.format(date)
}

export function formatDateRange(start?: string, end?: string) {
  if (!start && !end) return 'Unknown window'
  return `${formatDate(start)} – ${formatDate(end)}`
}

export function movementClass(value?: number) {
  if (!value) return 'flat'
  return value > 0 ? 'up' : 'down'
}

/** Stable identity for a team standing, falling back for pre-v17 artifacts. */
export function teamKey(team: { teamId?: string; team: string; region?: string; code?: string }) {
  if (team.teamId) return team.teamId
  return `${team.team}__${team.region ?? ''}__${team.code ?? ''}`
}
