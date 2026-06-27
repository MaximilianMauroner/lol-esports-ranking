import type { MatchRecord, TeamProfile } from '../types'
import { leaguePriorFor } from '../data/leagueTiers'

export type ContextDecayConfig = {
  initialTeamRating: number
  recencyFloor: number
  recencyRange: number
  recencyDecayDays: number
  normalPatchTeamRetention: number
  splitBreakTeamRetention: number
  seasonStartTeamRetention: number
  splitBreakLeagueRetention: number
  seasonStartLeagueRetention: number
  splitBreakMinimumGapDays: number
}

export function applyContextDecayToRatingChannels(
  match: MatchRecord,
  previousMatch: MatchRecord | undefined,
  teams: Record<string, TeamProfile>,
  ratingChannels: Array<Map<string, number>>,
  leagueScores: Map<string, number>,
  config: ContextDecayConfig,
) {
  if (!previousMatch) return

  const gapDays = daysBetween(previousMatch.date, match.date)
  if (gapDays > 0) {
    const retention = recencyRetentionForGap(gapDays, config)
    regressAllTeamRatingChannels(teams, ratingChannels, retention, config.initialTeamRating)
    regressAllLeagueRatings(leagueScores, retention)
  }

  if (match.season !== previousMatch.season) {
    regressAllTeamRatingChannels(teams, ratingChannels, config.seasonStartTeamRetention, config.initialTeamRating)
    regressAllLeagueRatings(leagueScores, config.seasonStartLeagueRetention)
    return
  }

  if (splitLabel(match.event) !== splitLabel(previousMatch.event) && gapDays >= config.splitBreakMinimumGapDays) {
    regressAllTeamRatingChannels(teams, ratingChannels, config.splitBreakTeamRetention, config.initialTeamRating)
    regressAllLeagueRatings(leagueScores, config.splitBreakLeagueRetention)
    return
  }

  if (match.patch && previousMatch.patch && match.patch !== previousMatch.patch) {
    for (const ratings of ratingChannels) {
      regressTeamOffset(match.teamA, ratings, config.normalPatchTeamRetention, config.initialTeamRating)
      regressTeamOffset(match.teamB, ratings, config.normalPatchTeamRetention, config.initialTeamRating)
    }
  }
}

function recencyRetentionForGap(days: number, config: ContextDecayConfig) {
  return config.recencyFloor + config.recencyRange * Math.exp(-days / config.recencyDecayDays)
}

function regressAllTeamRatingChannels(
  teams: Record<string, TeamProfile>,
  ratingChannels: Array<Map<string, number>>,
  retention: number,
  initialTeamRating: number,
) {
  for (const ratings of ratingChannels) {
    for (const team of ratings.keys()) {
      if (!teams[team]) continue
      regressTeamOffset(team, ratings, retention, initialTeamRating)
    }
  }
}

function regressTeamOffset(
  team: string,
  ratings: Map<string, number>,
  retention: number,
  initialTeamRating: number,
) {
  const rating = ratings.get(team) ?? initialTeamRating
  ratings.set(team, initialTeamRating + retention * (rating - initialTeamRating))
}

function regressAllLeagueRatings(leagueScores: Map<string, number>, retention: number) {
  for (const [league, rating] of leagueScores.entries()) {
    const prior = leaguePriorFor(league)
    leagueScores.set(league, prior + retention * (rating - prior))
  }
}

function splitLabel(eventName: string) {
  const match = eventName.match(/\b(Winter|Spring|Summer|Fall|Autumn)\b/i)
  return match?.[1]?.toLowerCase() ?? eventName.toLowerCase()
}

function daysBetween(leftDate: string, rightDate: string) {
  return Math.max(0, Math.floor((Date.parse(rightDate) - Date.parse(leftDate)) / 86_400_000))
}
