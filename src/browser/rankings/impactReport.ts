import type { PublicMatchHistoryEntry } from '../../domains/rankings/types'
import { PROJECT_REPOSITORY_URL } from '../../data/legal'

export function impactReportUrl(match: PublicMatchHistoryEntry, publication: string) {
  const body = `Power impact could not be reconciled for this series.\n\n${publication}\nDate: ${match.date}\nEvent: ${match.event}\nSeries ID: ${JSON.stringify(match.seriesId)}\nGame ID: ${match.id}\nSource: ${match.source.provider}\nTeams: ${match.teamA.name} / ${match.teamB.name}\nReported deltas: ${match.impact.teamA} / ${match.impact.teamB}\n\nRelated investigation: #37.\nAdditional context:\n`
  return `${PROJECT_REPOSITORY_URL}/issues/new?${new URLSearchParams({ title: '[Data] Match Power impact', body })}`
}
