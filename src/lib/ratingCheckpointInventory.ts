import type { RatingRunState } from './ratingRunState'

const includedRatingRunStateFields = [
  'ratings',
  'executionRatings',
  'previousDisplayRatings',
  'momentums',
  'rosterPriorOffsets',
  'latestRatingUpdates',
  'leaguePlacementDeltas',
  'wins',
  'losses',
  'forms',
  'histories',
  'factorSums',
  'factorCounts',
  'leagueScores',
  'previousLeagueScores',
  'uncertainties',
  'leagueWins',
  'leagueLosses',
  'leagueExpectedWins',
  'leagueOpponentRatingSums',
  'leagueForms',
  'leagueMatchCounts',
  'leagueLastEvents',
  'leagueLastUpdated',
  'leagueHistory',
  'predictions',
  'sideAdjustmentSamples',
  'lastRosterByTeam',
  'currentRosterContinuity',
  'lastPatchByTeam',
  'lastRosterFingerprintByTeam',
  'eventTrackers',
  'eventWeightContext',
  'previousMatch',
  'processedThroughUtcDate',
  'processedMatchCount',
] as const satisfies readonly (keyof RatingRunState)[]

export const ratingCheckpointInventory = {
  stateOwner: 'RatingRunState',
  includedFields: includedRatingRunStateFields,
  externalState: [
    {
      engine: 'SourcedPlayerState/player-model',
      status: 'external-deferred',
      resumeRequirement: 'Recompute pregame player edges from the authoritative raw prefix before rating resume.',
    },
    {
      engine: 'deserved-standing-state',
      status: 'external-deferred',
      resumeRequirement: 'Rebuild DSS ledgers and outputs independently; this checkpoint cannot resume them.',
    },
    {
      engine: 'roster-era-ledger',
      status: 'external-deferred',
      resumeRequirement: 'Rebuild external roster-era attribution; only RatingRunState roster continuity is included.',
    },
  ],
  activation: 'foundation-only-production-disabled',
} as const

export type RatingCheckpointReplayDecision = {
  changedUtcDate: string
  replayFromUtcDate: string
  resumeAfterUtcDate?: string
  requiresFullReplay: boolean
  requiresWholeUtcDateReplay: true
  reason: 'predecessor-boundary' | 'no-predecessor-checkpoint' | 'manual-full-invalidation'
}

export function selectRatingCheckpointReplayBoundary({
  availableProcessedThroughUtcDates,
  changedUtcDate,
  forceFullReplay = false,
}: {
  availableProcessedThroughUtcDates: readonly string[]
  changedUtcDate: string
  forceFullReplay?: boolean
}): RatingCheckpointReplayDecision {
  assertUtcDate(changedUtcDate)
  if (forceFullReplay) {
    return {
      changedUtcDate,
      replayFromUtcDate: changedUtcDate,
      requiresFullReplay: true,
      requiresWholeUtcDateReplay: true,
      reason: 'manual-full-invalidation',
    }
  }

  const predecessor = availableProcessedThroughUtcDates
    .filter((date) => {
      assertUtcDate(date)
      return date < changedUtcDate
    })
    .sort()
    .at(-1)

  return predecessor
    ? {
        changedUtcDate,
        replayFromUtcDate: changedUtcDate,
        resumeAfterUtcDate: predecessor,
        requiresFullReplay: false,
        requiresWholeUtcDateReplay: true,
        reason: 'predecessor-boundary',
      }
    : {
        changedUtcDate,
        replayFromUtcDate: changedUtcDate,
        requiresFullReplay: true,
        requiresWholeUtcDateReplay: true,
        reason: 'no-predecessor-checkpoint',
      }
}

function assertUtcDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid UTC date ${date}`)
}
