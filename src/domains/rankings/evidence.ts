export {
  type LolEsportsReferenceEvent,
  type LolEsportsReferenceGame,
  type LolEsportsReferenceTeam,
  mergeCommunityMatchSources,
} from './internal/evidence/communitySources.ts'
export {
  formatCompetitionRegionLabel,
  inferEventTier,
  inferLeagueFromEvent,
  regionForCompetitionSide,
  regionForLeague,
  resolveHomeLeagueForCompetition,
} from './internal/evidence/competitionTaxonomy.ts'
export {
  type TournamentFilterValue,
  type TournamentInstanceId,
  canonicalScheduleReferences,
  deriveTournamentInstances,
  tournamentBoundaryLabel,
  tournamentEntriesForScope,
  tournamentFamilyLabel,
  tournamentIdFromFilter,
  tournamentInstanceForEvent,
} from './internal/evidence/internationalTournaments.ts'
export {
  filterPublishedRatingUniverseInput,
} from './internal/evidence/ratingUniverse.ts'
export {
  isSeasonHistoryLeadIn,
} from './internal/evidence/seasonHistory.ts'
export {
  canonicalSeriesForMatches,
  canonicalSeriesOutcomeForTeam,
  resolveCanonicalSeries,
} from './internal/evidence/seriesResolver.ts'
export {
  LEAGUEPEDIA_SOURCE_PREFIX,
  ORACLE_SOURCE_PREFIX,
  type ProviderFreshness,
  providerFreshness,
} from './internal/evidence/sourceFreshness.ts'
export {
  canonicalTeamNameFor,
  cleanDisplayName,
  knownTeamIdentities,
  teamCodeFor,
  teamIdentityFor,
} from './internal/evidence/teamIdentity.ts'
export {
  deriveTeamProfilesFromMatches,
  mergeTeamProfiles,
  resolveCompetitionHomeLeagues,
} from './internal/evidence/teamProfiles.ts'
export {
  type ConditionalSeriesOutcome,
  type PowerPreviewUnavailable,
  type RatingContest,
  type RatingContestStatus,
  conditionalOutcomeProblem,
  ratingContestStateVersion,
  ratingContestStatus,
  stableResultAssumptions,
  stableResultPolicy,
  unavailablePowerPreview,
} from './internal/scenarios/contest.ts'
export { legalConditionalScores } from './internal/scenarios/contest.ts'
