import {
  eventTierConfig,
  preseasonEventWeightMultiplier,
} from '../data/rankingConfig'
import type { MatchRecord } from '../types'
import { isDemaciaCupEvent } from '../data/competitionTaxonomy'
import { resolveCanonicalSeries } from './seriesResolver'

export type EventWeightContext = {
  worldsEndDateByCalendarYear: ReadonlyMap<number, string>
}

export const emptyEventWeightContext: EventWeightContext = {
  worldsEndDateByCalendarYear: new Map<number, string>(),
}

export function eventWeightContextForMatches(matches: readonly MatchRecord[]): EventWeightContext {
  const worldsEndDateByCalendarYear = new Map<number, string>()
  const finals = matches.filter((match) => isWorldsMatch(match)
    && !/\bplay[ -]?in\b/i.test(match.event)
    && /^(?:grand\s+)?finals?$/i.test(match.phase.trim()))
  for (const series of resolveCanonicalSeries(finals)) {
    if (series.state !== 'completed' || series.format !== 5 || series.outcomeA === 0.5) continue
    const match = series.finalMatch
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
  if (isDemaciaCupEvent(`${match.league} ${match.event}`)) return 1
  return isPostWorldsPreseasonMatch(match, context) ? preseasonEventWeightMultiplier : 1
}

export function eventKFactorForMatch(
  match: MatchRecord,
  context: EventWeightContext = emptyEventWeightContext,
) {
  return eventTierConfig[powerEvidenceTierForMatch(match)].kFactor * eventWeightMultiplierForMatch(match, context)
}

export function eventWeightForMatch(
  match: MatchRecord,
  context: EventWeightContext = emptyEventWeightContext,
) {
  return eventTierConfig[powerEvidenceTierForMatch(match)].weight * eventWeightMultiplierForMatch(match, context)
}

function powerEvidenceTierForMatch(match: MatchRecord) {
  return match.tier === 'msi-play-in' && /\b(?:fst|first stand)\b/i.test(`${match.league} ${match.event}`)
    ? 'msi-bracket'
    : match.tier
}

export function isPostWorldsPreseasonMatch(
  match: MatchRecord,
  context: EventWeightContext = emptyEventWeightContext,
) {
  if (isWorldsMatch(match)) return false
  if (match.tier === 'regional-regular' || match.tier === 'major-playoffs') return false
  const year = calendarYearForDate(match.date)
  if (year === undefined) return false
  const worldsEndDate = context.worldsEndDateByCalendarYear.get(year)
  if (!worldsEndDate) return false
  return match.date > worldsEndDate && match.date < `${year + 1}-01-01`
}

function isWorldsMatch(match: MatchRecord) {
  if (match.tier === 'qualifier' || /\b(?:regional finals?|qualifiers?|road to)\b/i.test(`${match.event} ${match.phase}`)) return false
  if (match.tier === 'worlds-playoffs' || match.tier === 'worlds-main') return true
  return /\b(?:wlds?|worlds|world championship)\b/i.test(`${match.league} ${match.event}`)
}

function calendarYearForDate(date: string) {
  const year = Number(date.slice(0, 4))
  return Number.isInteger(year) ? year : undefined
}
