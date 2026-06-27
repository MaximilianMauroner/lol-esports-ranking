import { leagueTierDefinitions } from '../data/leagueTiers'
import type { EligibilityReason, LeagueTierName, TeamEligibility, TeamHistoryPoint } from '../types'

export const defaultEligibilityConfig = {
  currentWindowDays: 90,
  minCurrentWindowGames: 6,
  maxUncertainty: 105,
  minInternationalMatchesForUnanchoredLeague: 2,
} as const

export type EligibilityInput = {
  history: TeamHistoryPoint[]
  lastDate: string
  uncertainty: number
  leagueTier: LeagueTierName
  leagueInternationalMatches: number
}

export function evaluateTeamEligibility(
  input: EligibilityInput,
  config = defaultEligibilityConfig,
): TeamEligibility {
  const lastPlayed = input.history.at(-1)?.date
  const daysSinceLastMatch = lastPlayed ? daysBetween(lastPlayed, input.lastDate) : undefined
  const currentWindowGames = input.history.filter((point) => daysBetween(point.date, input.lastDate) <= config.currentWindowDays).length
  const reasons: EligibilityReason[] = []

  if (currentWindowGames < config.minCurrentWindowGames) reasons.push('low-current-volume')
  if (daysSinceLastMatch === undefined || daysSinceLastMatch > config.currentWindowDays) reasons.push('stale')
  if (input.uncertainty > config.maxUncertainty) reasons.push('high-uncertainty')
  if (input.leagueTier === 'emerging' || input.leagueTier === 'unknown') {
    reasons.push('unanchored-league')
  } else if (!leagueTierDefinitions[input.leagueTier].anchorEligible && input.leagueInternationalMatches < config.minInternationalMatchesForUnanchoredLeague) {
    reasons.push('unanchored-league')
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    currentWindowGames,
    minCurrentWindowGames: config.minCurrentWindowGames,
    windowDays: config.currentWindowDays,
    daysSinceLastMatch,
    lastPlayed,
  }
}

function daysBetween(leftDate: string, rightDate: string) {
  return Math.max(0, Math.floor((Date.parse(rightDate) - Date.parse(leftDate)) / 86_400_000))
}
