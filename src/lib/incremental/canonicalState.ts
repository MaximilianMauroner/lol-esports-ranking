import type { MatchRecord, TeamProfile } from '../../types'
import type { ProviderObservation } from './providerLedger'

export type CanonicalRankingInput = {
  matches: MatchRecord[]
  teams: Record<string, TeamProfile>
  importedMatches: MatchRecord[]
}

export type CanonicalObservationSet = {
  observations: ProviderObservation[]
  importedTeams: Record<string, TeamProfile>
}

export const DEFAULT_INCREMENTAL_STATE_DIR = '.ranking-crunch'

export function incrementalStateDirectory(configured?: string): string {
  return configured?.trim() || DEFAULT_INCREMENTAL_STATE_DIR
}
