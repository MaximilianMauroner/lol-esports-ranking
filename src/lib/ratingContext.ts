import type { MatchRecord, TeamProfile } from '../types'
import { leaguePriorFor } from '../data/leagueTiers'
import { homeLeagueForMatch } from './matchContext'

export type ContextDecayConfig = {
  initialTeamRating: number
  recencyHalfLifeDays: number
  normalPatchTeamRetention: number
  splitBreakTeamRetention: number
  seasonStartTeamRetention: number
  splitBreakLeagueRetention: number
  seasonStartLeagueRetention: number
  splitBreakMinimumGapDays: number
  momentumSplitRetention: number
  momentumPatchRetention: number
}

export type EntityLocalRatingContext = {
  teamLastRatedDates: Map<string, string>
  teamLastSeasons: Map<string, number>
  teamLastSplits: Map<string, string>
  leagueLastRatedDates: Map<string, string>
  leagueLastSeasons: Map<string, number>
  leagueLastSplits: Map<string, string>
  lastPatchByTeam: Map<string, string>
}

export function applyEntityLocalContextDecayForDate(
  matches: readonly MatchRecord[],
  teams: Record<string, TeamProfile>,
  ratingChannels: Array<Map<string, number>>,
  momentums: Map<string, number>,
  leagueScores: Map<string, number>,
  context: EntityLocalRatingContext,
  config: ContextDecayConfig,
) {
  const firstMatchByTeam = new Map<string, MatchRecord>()
  const firstMatchByLeague = new Map<string, MatchRecord>()

  for (const match of matches) {
    if (!firstMatchByTeam.has(match.teamA)) firstMatchByTeam.set(match.teamA, match)
    if (!firstMatchByTeam.has(match.teamB)) firstMatchByTeam.set(match.teamB, match)
    const leagueA = homeLeagueForMatch(match, 'A', teams)
    const leagueB = homeLeagueForMatch(match, 'B', teams)
    if (!firstMatchByLeague.has(leagueA)) firstMatchByLeague.set(leagueA, match)
    if (!firstMatchByLeague.has(leagueB)) firstMatchByLeague.set(leagueB, match)
  }

  for (const [team, match] of firstMatchByTeam) {
    applyTeamContext(team, match, ratingChannels, momentums, context, config)
  }
  for (const [league, match] of firstMatchByLeague) {
    applyLeagueContext(league, match, leagueScores, context, config)
  }
}

export function normalizedSplitIdentity(match: Pick<MatchRecord, 'season' | 'event'>) {
  const season = String(match.season)
  const named = match.event.match(/\b(Winter|Spring|Summer|Fall|Autumn)\b/i)?.[1]?.toLowerCase()
  if (named) return `${season}:${named === 'autumn' ? 'fall' : named}`
  const numbered = match.event.match(/\bsplit\s*([1-4])\b/i)?.[1]
  return numbered ? `${season}:split-${numbered}` : undefined
}

function applyTeamContext(
  team: string,
  match: MatchRecord,
  ratingChannels: Array<Map<string, number>>,
  momentums: Map<string, number>,
  context: EntityLocalRatingContext,
  config: ContextDecayConfig,
) {
  const previousDate = context.teamLastRatedDates.get(team)
  const gapDays = previousDate ? daysBetween(previousDate, match.date) : 0
  if (gapDays > 0) {
    const retention = recencyRetentionForGap(gapDays, config.recencyHalfLifeDays)
    for (const ratings of ratingChannels) regressTeamOffset(team, ratings, retention, config.initialTeamRating)
  }

  const previousSeason = context.teamLastSeasons.get(team)
  const currentSplit = normalizedSplitIdentity(match)
  const previousSplit = context.teamLastSplits.get(team)
  const previousPatch = context.lastPatchByTeam.get(team)
  if (previousSeason !== undefined && match.season !== previousSeason) {
    for (const ratings of ratingChannels) regressTeamOffset(team, ratings, config.seasonStartTeamRetention, config.initialTeamRating)
    momentums.set(team, 0)
  } else if (currentSplit && previousSplit && currentSplit !== previousSplit && gapDays >= config.splitBreakMinimumGapDays) {
    for (const ratings of ratingChannels) regressTeamOffset(team, ratings, config.splitBreakTeamRetention, config.initialTeamRating)
    momentums.set(team, (momentums.get(team) ?? 0) * config.momentumSplitRetention)
  } else if (match.patch && previousPatch && match.patch !== previousPatch) {
    for (const ratings of ratingChannels) regressTeamOffset(team, ratings, config.normalPatchTeamRetention, config.initialTeamRating)
    momentums.set(team, (momentums.get(team) ?? 0) * config.momentumPatchRetention)
  }

  context.teamLastRatedDates.set(team, match.date)
  context.teamLastSeasons.set(team, match.season)
  if (currentSplit) context.teamLastSplits.set(team, currentSplit)
}

function applyLeagueContext(
  league: string,
  match: MatchRecord,
  leagueScores: Map<string, number>,
  context: EntityLocalRatingContext,
  config: ContextDecayConfig,
) {
  const previousDate = context.leagueLastRatedDates.get(league)
  const gapDays = previousDate ? daysBetween(previousDate, match.date) : 0
  const prior = leaguePriorFor(league)
  if (gapDays > 0) {
    const score = leagueScores.get(league) ?? prior
    const retention = recencyRetentionForGap(gapDays, config.recencyHalfLifeDays)
    leagueScores.set(league, prior + retention * (score - prior))
  }

  const previousSeason = context.leagueLastSeasons.get(league)
  const currentSplit = normalizedSplitIdentity(match)
  const previousSplit = context.leagueLastSplits.get(league)
  if (previousSeason !== undefined && match.season !== previousSeason) {
    const score = leagueScores.get(league) ?? prior
    leagueScores.set(league, prior + config.seasonStartLeagueRetention * (score - prior))
  } else if (currentSplit && previousSplit && currentSplit !== previousSplit && gapDays >= config.splitBreakMinimumGapDays) {
    const score = leagueScores.get(league) ?? prior
    leagueScores.set(league, prior + config.splitBreakLeagueRetention * (score - prior))
  }

  context.leagueLastRatedDates.set(league, match.date)
  context.leagueLastSeasons.set(league, match.season)
  if (currentSplit) context.leagueLastSplits.set(league, currentSplit)
}

function recencyRetentionForGap(days: number, halfLifeDays: number) {
  return 2 ** (-days / halfLifeDays)
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

function daysBetween(leftDate: string, rightDate: string) {
  return Math.max(0, Math.floor((Date.parse(rightDate) - Date.parse(leftDate)) / 86_400_000))
}
