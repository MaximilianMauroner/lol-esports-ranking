import {
  eventTierConfig,
  preseasonEventWeightMultiplier,
} from '../data/rankingConfig'
import type { MatchRecord } from '../types'

export type EventWeightContext = {
  worldsEndDateByCalendarYear: ReadonlyMap<number, string>
}

export const emptyEventWeightContext: EventWeightContext = {
  worldsEndDateByCalendarYear: new Map<number, string>(),
}

export function eventWeightContextForMatches(matches: readonly MatchRecord[]): EventWeightContext {
  const worldsEndDateByCalendarYear = new Map<number, string>()
  for (const match of matches) {
    if (!isWorldsMatch(match)) continue
    const year = calendarYearForDate(match.date)
    if (year === undefined) continue
    const currentEndDate = worldsEndDateByCalendarYear.get(year)
    if (!currentEndDate || match.date > currentEndDate) {
      worldsEndDateByCalendarYear.set(year, match.date)
    }
  }
  return { worldsEndDateByCalendarYear }
}

export function eventWeightMultiplierForMatch(
  match: MatchRecord,
  context: EventWeightContext = emptyEventWeightContext,
) {
  return isPostWorldsPreseasonMatch(match, context) ? preseasonEventWeightMultiplier : 1
}

export function eventKFactorForMatch(
  match: MatchRecord,
  context: EventWeightContext = emptyEventWeightContext,
) {
  return eventTierConfig[match.tier].kFactor * eventWeightMultiplierForMatch(match, context)
}

export function leagueKFactorForMatch(
  match: MatchRecord,
  context: EventWeightContext = emptyEventWeightContext,
) {
  return eventTierConfig[match.tier].leagueKFactor * eventWeightMultiplierForMatch(match, context)
}

export function eventWeightForMatch(
  match: MatchRecord,
  context: EventWeightContext = emptyEventWeightContext,
) {
  return eventTierConfig[match.tier].weight * eventWeightMultiplierForMatch(match, context)
}

export function isPostWorldsPreseasonMatch(
  match: MatchRecord,
  context: EventWeightContext = emptyEventWeightContext,
) {
  if (isWorldsMatch(match)) return false
  const year = calendarYearForDate(match.date)
  if (year === undefined) return false
  const worldsEndDate = context.worldsEndDateByCalendarYear.get(year)
  if (!worldsEndDate) return false
  return match.date > worldsEndDate && match.date < `${year + 1}-01-01`
}

function isWorldsMatch(match: MatchRecord) {
  if (match.tier === 'worlds-playoffs' || match.tier === 'worlds-main') return true
  return /\b(?:wlds?|worlds|world championship)\b/i.test(`${match.league} ${match.event}`)
}

function calendarYearForDate(date: string) {
  const year = Number(date.slice(0, 4))
  return Number.isInteger(year) ? year : undefined
}
