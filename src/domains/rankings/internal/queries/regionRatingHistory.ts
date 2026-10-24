import type { PublicRegionHistoryScope } from './publishedTypes.ts'

const DAY_MS = 86_400_000

/** A region's power on one day: the mean published Power of its three highest-rated eligible flagship teams. */
export type RegionRatingPoint = {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string
  meanTop3: number
  /** The teams behind the mean, highest rated first. Fewer than three until three teams have a rating. */
  teams: string[]
}

export type RegionRatingSeries = {
  region: string
  points: RegionRatingPoint[]
}

/**
 * The published region power series of the given regions, one point per
 * calendar day. The days run from the first to the last update of any of these
 * regions. From its first update on, a region has a point on every day. A day
 * without an update keeps the last value, because the mean only changes when
 * one of the region's teams gets a new rating.
 */
export function regionRatingHistory(history: PublicRegionHistoryScope, regions: readonly string[]): RegionRatingSeries[] {
  const published = regions.map((region) => ({ region, points: history.regionPowerSeries[region]?.points ?? [] }))
  const updates = published.flatMap(({ points }) => points.map(([date]) => Date.parse(date)))
  const last = Math.max(...updates)
  const days: string[] = []
  for (let day = Math.min(...updates); day <= last; day += DAY_MS) days.push(new Date(day).toISOString().slice(0, 10))

  return published.map(({ region, points }) => {
    const aligned: RegionRatingPoint[] = []
    let next = 0
    let latest: Omit<RegionRatingPoint, 'date'> | undefined
    for (const date of days) {
      for (; next < points.length && points[next][0] <= date; next += 1) {
        const [, meanTop3, , context] = points[next]
        latest = { meanTop3, teams: context?.contributingTeams ?? [] }
      }
      if (latest) aligned.push({ date, ...latest })
    }
    return { region, points: aligned }
  })
}
