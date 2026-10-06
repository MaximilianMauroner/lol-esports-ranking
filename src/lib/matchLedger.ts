import type { PublicMatchHistoryEntry, PublicMatchHistorySeriesRef } from './publicArtifacts/schema'
import { PROJECT_REPOSITORY_URL } from './legal'
import { formatEventName } from './display'

export function matchEventLabel(event: string) {
  return formatEventName(event).replace(/\//g, ' · ').replace(/\b(\d{4}) Season\b/g, '$1')
}

export function compatibleMatchEvents(refs: readonly PublicMatchHistorySeriesRef[], league: string) {
  return [...new Set(refs.filter((row) => league === 'All' || row.league === league).map((row) => row.event))].sort()
}

export function hasConsistentImpactDirection(match: PublicMatchHistoryEntry) {
  const { teamA, teamB } = match.impact
  if (typeof teamA !== 'number' || typeof teamB !== 'number' || !Number.isFinite(teamA) || !Number.isFinite(teamB) || (teamA === 0 && teamB === 0)) return false
  return match.winnerId === match.teamA.id ? teamA >= 0 && teamB <= 0 : teamB >= 0 && teamA <= 0
}

export function impactReportUrl(match: PublicMatchHistoryEntry, publication: string) {
  const body = `Power impact could not be reconciled for this series.\n\n${publication}\nDate: ${match.date}\nEvent: ${match.event}\nSeries ID: ${JSON.stringify(match.seriesId)}\nGame ID: ${match.id}\nSource: ${match.source.provider}\nTeams: ${match.teamA.name} / ${match.teamB.name}\nReported deltas: ${match.impact.teamA} / ${match.impact.teamB}\n\nRelated investigation: #37.\nAdditional context:\n`
  return `${PROJECT_REPOSITORY_URL}/issues/new?${new URLSearchParams({ title: '[Data] Match Power impact', body })}`
}
