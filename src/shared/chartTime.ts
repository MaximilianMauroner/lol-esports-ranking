const fullDate = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const monthDay = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const month = new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' })
const monthYear = new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric', timeZone: 'UTC' })
const formats = { 'full-date': fullDate, 'month-day': monthDay, month, 'month-year': monthYear }

export const invalidDateLabel = 'Unknown date'

export function formatChartTimestamp(value: unknown, format: keyof typeof formats = 'full-date') {
  const timestamp = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(timestamp)) return invalidDateLabel
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return invalidDateLabel
  return formats[format].format(date)
}

const MONTH_TICK_STEPS = [1, 2, 3, 4, 6, 12]
const MAX_MONTH_TICKS = 6

/**
 * Month starts for a date axis that spans three months or more, so the axis
 * reads like a calendar. The step is the smallest one that gives at most six
 * ticks, or a year, and ticks fall on months that are a multiple of the step
 * from January. Shorter spans return undefined.
 */
export function monthTicks(min: number, max: number) {
  const start = new Date(min)
  const end = new Date(max)
  const months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth()
  if (months < 3) return undefined
  const step = MONTH_TICK_STEPS.find((candidate) => months / candidate <= MAX_MONTH_TICKS) ?? 12
  const year = start.getUTCFullYear()
  const first = start.getUTCMonth() + (Date.UTC(year, start.getUTCMonth(), 1) < min ? 1 : 0)
  const ticks: number[] = []
  for (let index = Math.ceil(first / step) * step; Date.UTC(year, index, 1) <= max; index += step) ticks.push(Date.UTC(year, index, 1))
  return ticks
}
