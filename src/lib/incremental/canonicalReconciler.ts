import { knownTeamIdentities } from '../../data/teamIdentity'
import { mergeCommunityMatchSources } from '../importers/communitySources'
import { filterPublishedRatingUniverseInput } from '../ratingUniverse'
import { deriveTeamProfilesFromMatches, mergeTeamProfiles } from '../teamProfiles'
import type { CanonicalObservationSet, CanonicalRankingInput } from './canonicalState'

/** Uses the same source merge and universe functions as the direct full path. */
export function reconcileCanonicalObservations(input: CanonicalObservationSet): CanonicalRankingInput {
  const oracleMatches = input.observations.flatMap((observation) => (
    observation.kind === 'match' && observation.provider === 'oracles-elixir' ? [observation.payload] : []
  ))
  const leaguepediaMatches = input.observations.flatMap((observation) => (
    observation.kind === 'match' && observation.provider === 'leaguepedia-cargo' ? [observation.payload] : []
  ))
  const lolEsportsReferences = input.observations.flatMap((observation) => (
    observation.kind === 'schedule' ? [observation.payload] : []
  ))
  const importedMatches = mergeCommunityMatchSources({ oracleMatches, leaguepediaMatches, lolEsportsReferences })
  const importedTeams = mergeTeamProfiles([input.importedTeams])
  const mergedTeams = importedMatches.length > 0
    ? { ...deriveTeamProfilesFromMatches(importedMatches, importedTeams), ...knownTeamIdentities }
    : {}
  const ratingUniverse = filterPublishedRatingUniverseInput(importedMatches, mergedTeams)
  return { ...ratingUniverse, importedMatches }
}
