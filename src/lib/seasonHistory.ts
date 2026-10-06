import type { SnapshotFilter } from './publicArtifacts/schema'
import { isDemaciaCupEvent } from '../data/competitionTaxonomy'

/** December's Demacia Cup supplies context for the following season's history. */
export function isSeasonHistoryLeadIn(date: string, event: string, filter: SnapshotFilter) {
  if (filter.season === 'All' || filter.event !== 'All' || filter.checkpoint) return false
  const previousYear = Number(filter.season) - 1
  return date.startsWith(`${previousYear}-12-`) && isDemaciaCupEvent(event)
}
