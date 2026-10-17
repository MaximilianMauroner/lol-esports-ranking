import type { PublicMatchHistoryEntry, PublicMatchHistorySeriesRef } from '../../types'
import { formatEventName } from '../../../../shared/display'

export function matchEventLabel(event: string) {
  return formatEventName(event).replace(/\//g, ' · ').replace(/\b(\d{4}) Season\b/g, '$1')
}

export function compatibleMatchEvents(refs: readonly Pick<PublicMatchHistorySeriesRef, 'league' | 'event'>[], league: string) {
  return [...new Set(refs.filter((row) => league === 'All' || row.league === league).map((row) => row.event))].sort()
}

export function matchEventFilterLabels(refs: readonly Pick<PublicMatchHistorySeriesRef, 'league' | 'event'>[], league: string) {
  const seriesCounts = new Map<string, number>()
  for (const row of refs) {
    if (league !== 'All' && row.league !== league) continue
    seriesCounts.set(row.event, (seriesCounts.get(row.event) ?? 0) + 1)
  }
  const labelCounts = new Map<string, number>()
  for (const event of seriesCounts.keys()) {
    const label = matchEventLabel(event)
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1)
  }
  return new Map([...seriesCounts].map(([event, count]) => {
    const label = matchEventLabel(event)
    return [event, (labelCounts.get(label) ?? 0) > 1 ? `${label} · ${count} series (${event})` : label]
  }))
}

export function hasConsistentImpactDirection(match: PublicMatchHistoryEntry) {
  const { teamA, teamB } = match.impact
  if (typeof teamA !== 'number' || typeof teamB !== 'number' || !Number.isFinite(teamA) || !Number.isFinite(teamB) || (teamA === 0 && teamB === 0)) return false
  return match.winnerId === match.teamA.id ? teamA >= 0 && teamB <= 0 : teamB >= 0 && teamA <= 0
}
