const dateFormatter = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' })
const dateTimeFormatter = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export function formatSigned(value: number, digits = 0) {
  const formatted = digits > 0 ? value.toFixed(digits) : Math.round(value).toString()
  return value > 0 ? `+${formatted}` : formatted
}

export function formatDate(value?: string) {
  if (!value) return 'Unknown'
  return dateFormatter.format(new Date(value))
}

export function formatDateTime(value?: string) {
  if (!value) return 'Unknown'
  return dateTimeFormatter.format(new Date(value))
}

export function percent(value: number) {
  return `${Math.round(value * 100)}%`
}
