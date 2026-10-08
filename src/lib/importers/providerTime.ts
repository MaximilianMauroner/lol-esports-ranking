const NAIVE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ Tt](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/

/**
 * Oracle's Elixir and Leaguepedia publish UTC timestamps without a zone, such
 * as `2025-01-11 17:13:25`. `Date.parse` reads that form as process-local time,
 * so parse it as UTC to keep published datetimes independent of the host.
 */
export function parseProviderInstant(value: string) {
  const naive = NAIVE_TIMESTAMP.exec(value)
  return Date.parse(naive ? `${naive[1]}T${naive[2]}Z` : value)
}

export function providerDate(value: string) {
  if (!value) return ''
  const sourceDate = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0]
  if (sourceDate) return sourceDate
  const parsed = parseProviderInstant(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : value.slice(0, 10)
}

export function providerDatetimeUtc(value: string) {
  if (!value) return undefined
  const parsed = parseProviderInstant(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}
