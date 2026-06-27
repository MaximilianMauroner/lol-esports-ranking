import type { FactorBreakdown } from '../types'
import type { RankingSummaryStanding, TeamHistorySeries } from './snapshot'

/** Plain-language labels for the model factor that most explains a rating. */
export const FACTOR_LABELS: Record<keyof FactorBreakdown, string> = {
  context: 'stage context',
  recency: 'recent results',
  execution: 'in-game execution',
  opponent: 'strength of schedule',
  league: 'league strength',
}

export type TrajectoryInsight = {
  start: number
  current: number
  netChange: number
  peak: { value: number; date: string }
  trough: { value: number; date: string }
  startRank?: number
  currentRank?: number
  bestRank?: number
  /** Positive = climbed the table (rank number went down). */
  rankChange?: number
  /** Dominant model factor behind the current rating, if known. */
  driver?: { key: keyof FactorBreakdown; label: string }
  /** One-sentence explanation of what moved the trajectory. */
  summary: string
}

const monthDay = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' })

function fmtDate(value: string) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? monthDay.format(new Date(parsed)) : value
}

function signed(value: number) {
  const rounded = Math.round(value)
  return rounded > 0 ? `+${rounded}` : String(rounded)
}

function pickDriver(standing: RankingSummaryStanding): TrajectoryInsight['driver'] {
  const factors = standing.factors as Partial<FactorBreakdown> | undefined
  let key = standing.strongestFactor as keyof FactorBreakdown | undefined
  if ((!key || !(key in FACTOR_LABELS)) && factors) {
    const entries = (Object.keys(FACTOR_LABELS) as (keyof FactorBreakdown)[])
      .map((factor) => [factor, factors[factor] ?? -Infinity] as const)
      .sort((a, b) => b[1] - a[1])
    key = entries[0]?.[0]
  }
  return key && key in FACTOR_LABELS ? { key, label: FACTOR_LABELS[key] } : undefined
}

/**
 * Summarizes how a team's rating moved over its tracked history and why, using
 * only public series data plus the standing's factor mix and recent form.
 */
export function deriveTrajectoryInsight(
  standing: RankingSummaryStanding,
  series: TeamHistorySeries | undefined,
): TrajectoryInsight | null {
  const points = series?.points ?? []
  if (points.length < 2) return null

  const start = points[0][1]
  const current = points[points.length - 1][1]
  let peak = { value: points[0][1], date: points[0][0] }
  let trough = { value: points[0][1], date: points[0][0] }
  let bestRank: number | undefined
  for (const [date, rating, rank] of points) {
    if (rating > peak.value) peak = { value: rating, date }
    if (rating < trough.value) trough = { value: rating, date }
    if (typeof rank === 'number' && (bestRank === undefined || rank < bestRank)) bestRank = rank
  }

  const startRank = points[0][2]
  const currentRank = points[points.length - 1][2]
  const rankChange =
    typeof startRank === 'number' && typeof currentRank === 'number' ? startRank - currentRank : undefined

  const driver = pickDriver(standing)
  const netChange = current - start
  const form = (standing.form ?? []).slice(-5)
  const wins = form.filter((result) => result.toLowerCase() === 'w').length

  // Lead with the most recent swing: if the peak is the more recent extreme the
  // team has come off it (a slide); otherwise it has climbed off its low.
  const lastDate = points[points.length - 1][0]
  const peakTime = Date.parse(peak.date)
  const troughTime = Date.parse(trough.date)
  const climbedFromTrough = current - trough.value
  const fellFromPeak = peak.value - current
  const parts: string[] = []
  if (peakTime >= troughTime && fellFromPeak >= 12) {
    parts.push(`Down ${Math.round(fellFromPeak)} from a ${fmtDate(peak.date)} peak of ${Math.round(peak.value)}`)
  } else if (climbedFromTrough >= 12) {
    parts.push(`Up ${Math.round(climbedFromTrough)} from a ${fmtDate(trough.date)} low of ${Math.round(trough.value)}`)
  } else {
    parts.push(`Holding near ${Math.round(current)} since ${fmtDate(points[0][0])}`)
  }

  parts[0] += ` to ${Math.round(current)}${typeof currentRank === 'number' ? ` (#${currentRank})` : ''} on ${fmtDate(lastDate)}.`

  if (typeof rankChange === 'number' && Math.abs(rankChange) >= 2) {
    parts.push(rankChange > 0 ? `Up ${rankChange} places.` : `Down ${Math.abs(rankChange)} places.`)
  }
  if (form.length > 0) parts.push(`${wins}-${form.length - wins} last ${form.length}.`)

  return {
    start,
    current,
    netChange,
    peak,
    trough,
    startRank,
    currentRank,
    bestRank,
    rankChange,
    driver,
    summary: parts.join(' '),
  }
}

export { signed as formatSignedRounded }
