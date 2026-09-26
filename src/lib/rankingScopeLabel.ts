import { formatDate } from './display'
import type { SnapshotCheckpointOption } from './publicArtifacts/schema'

export function rankingScopePeriod(season: string | undefined, checkpoint?: SnapshotCheckpointOption) {
  if (checkpoint) return `Checkpoint window: ${formatDate(checkpoint.startDate)} to ${formatDate(checkpoint.endDate)}`
  if (!season || season === 'All') return 'All published seasons'
  return `Season window: ${formatDate(`${season}-01-01`)} to ${formatDate(`${season}-12-31`)}`
}
