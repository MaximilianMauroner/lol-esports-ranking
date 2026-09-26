import type { SnapshotCheckpointOption } from './publicArtifacts/schema'

export function rankingScopePeriod(season: string | undefined, checkpoint?: SnapshotCheckpointOption) {
  if (checkpoint) return `Checkpoint window: ${formatScopeDate(checkpoint.startDate)} to ${formatScopeDate(checkpoint.endDate)}`
  if (!season || season === 'All') return 'All published seasons'
  return `Season window: ${formatScopeDate(`${season}-01-01`)} to ${formatScopeDate(`${season}-12-31`)}`
}

// These are calendar dates, not local instants: keep both boundaries in UTC.
function formatScopeDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(date)
}
