import type { MatchRecord } from '../../types'
import {
  createRatingReplayContext,
  materializeRankingModel,
  replayRatingDates,
  type RankingModelOutput,
  type RatingReplayContext,
} from '../model'
import type { RatingRunState } from '../ratingRunState'

export type RankingReplayResult = {
  context: RatingReplayContext
  state: RatingRunState
  model: RankingModelOutput
  replayedUtcDates: string[]
  replayedMatchCount: number
}

export function replayRankingState({
  authoritativeMatches,
  teams,
  checkpointState,
  replayFromUtcDate,
  tournamentLifecycles,
}: {
  authoritativeMatches: readonly MatchRecord[]
  teams: RatingReplayContext['teams']
  checkpointState?: RatingRunState
  replayFromUtcDate?: string
  tournamentLifecycles?: RatingReplayContext['tournamentLifecycles']
}): RankingReplayResult {
  const context = createRatingReplayContext(authoritativeMatches, teams, { tournamentLifecycles })
  const effectiveReplayDate = replayFromUtcDate
    ?? (checkpointState?.processedThroughUtcDate ? utcDateAfter(checkpointState.processedThroughUtcDate) : undefined)
  if (checkpointState?.processedThroughUtcDate && effectiveReplayDate
    && checkpointState.processedThroughUtcDate >= effectiveReplayDate) {
    throw new Error('A rating checkpoint must be strictly earlier than the first replayed UTC date')
  }
  const replayMatches = effectiveReplayDate
    ? context.authoritativeMatches.filter((match) => match.date >= effectiveReplayDate)
    : context.authoritativeMatches
  const state = replayRatingDates({ context, state: checkpointState, replayMatches })
  return {
    context,
    state,
    model: materializeRankingModel({ context, state }),
    replayedUtcDates: [...new Set(replayMatches.map((match) => match.date))],
    replayedMatchCount: replayMatches.length,
  }
}

function utcDateAfter(date: string) {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  parsed.setUTCDate(parsed.getUTCDate() + 1)
  return parsed.toISOString().slice(0, 10)
}
