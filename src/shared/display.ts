export function formatEventName(event: string) {
  return event.replace(/\bdcup\b/gi, 'Demacia Cup')
}

const numberFormatter = new Intl.NumberFormat('en')
const ratingFormatter = new Intl.NumberFormat('en', { maximumFractionDigits: 0 })
const oneDecimal = new Intl.NumberFormat('en', { maximumFractionDigits: 1 })
const dateFormatter = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' })
const calendarDateFormatter = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

export const HEAT_BINS = 6

/** Maps a value within [min, max] to a 1..6 strength-heat bin (cold to hot). */
export function heatBin(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return 1
  if (max <= min) return 3
  const t = (value - min) / (max - min)
  return Math.min(HEAT_BINS, Math.max(1, Math.ceil(t * HEAT_BINS)))
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

export function formatModelVersion(value?: string) {
  if (!value) return 'unknown'
  return value.replaceAll('transparent-gpr', 'transparent-power-index')
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

/** Orders records from worst to best: fewer wins first, then more losses first. */
export function compareRecord(a: { wins?: number; losses?: number }, b: { wins?: number; losses?: number }) {
  return (a.wins ?? 0) - (b.wins ?? 0) || (b.losses ?? 0) - (a.losses ?? 0)
}

export function formatDate(value?: string) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  // Date-only artifact values are calendar dates; timestamps retain local display semantics.
  const formatter = /^\d{4}-\d{2}-\d{2}$/.test(value) ? calendarDateFormatter : dateFormatter
  return Number.isNaN(date.getTime()) ? 'Unknown' : formatter.format(date)
}

export function formatDateRange(start?: string, end?: string) {
  if (!start && !end) return 'Unknown window'
  return `${formatDate(start)} – ${formatDate(end)}`
}

/** Stable identity for a team standing, falling back for pre-v17 artifacts. */
export function teamKey(team: { teamId?: string; team: string; region?: string; code?: string }) {
  if (team.teamId) return team.teamId
  return `${team.team}__${team.region ?? ''}__${team.code ?? ''}`
}
