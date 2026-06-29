const fullDate = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' })

export const invalidDateLabel = 'Unknown date'

export function formatChartTimestamp(value: unknown, formatter: Intl.DateTimeFormat = fullDate) {
  const timestamp = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(timestamp)) return invalidDateLabel
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return invalidDateLabel
  return formatter.format(date)
}

export function formatChartTooltipTimestamp(payload: unknown) {
  if (!Array.isArray(payload)) return invalidDateLabel
  return formatChartTimestamp(payload[0]?.payload?.t, fullDate)
}
