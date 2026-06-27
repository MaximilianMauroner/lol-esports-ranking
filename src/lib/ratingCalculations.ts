import { eventTierConfig } from '../data/rankingConfig'
import type { MatchRecord, RatingComponents, RatingUpdateLedger } from '../types'
import { normalizedBestOf } from './matchFormat'
import {
  initialLeagueRating,
  initialTeamRating,
  leagueEloWeight,
  maximumUncertainty,
  minimumUncertainty,
  momentumExecutionKFactor,
  momentumKFactor,
  momentumPatchRetention,
  momentumSplitRetention,
  normalUncertainty,
  recencyDecayDays,
  recencyFloor,
  recencyRange,
  rosterVolatilityKCeiling,
  splitBreakMinimumGapDays,
  uncertaintyKMultiplierCeiling,
  uncertaintyKMultiplierFloor,
  uncertaintyKScale,
} from './modelConfig'

export function expectedScore(ratingA: number, ratingB: number) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400))
}

export function recencyWeight(date: string, lastDate: string) {
  const days = Math.max(0, (Date.parse(lastDate) - Date.parse(date)) / 86_400_000)
  return Number((recencyFloor + recencyRange * Math.exp(-days / recencyDecayDays)).toFixed(3))
}

export function applyMomentumBoundaryDecay(
  match: MatchRecord,
  previousMatch: MatchRecord | undefined,
  momentums: Map<string, number>,
) {
  if (!previousMatch) return
  if (match.season !== previousMatch.season) {
    for (const team of momentums.keys()) momentums.set(team, 0)
    return
  }
  const gapDays = Math.max(0, Math.floor((Date.parse(match.date) - Date.parse(previousMatch.date)) / 86_400_000))
  if (splitLabel(match.event) !== splitLabel(previousMatch.event) && gapDays >= splitBreakMinimumGapDays) {
    for (const [team, momentum] of momentums.entries()) momentums.set(team, momentum * momentumSplitRetention)
    return
  }
  if (match.patch && previousMatch.patch && match.patch !== previousMatch.patch) {
    for (const team of [match.teamA, match.teamB]) {
      momentums.set(team, (momentums.get(team) ?? 0) * momentumPatchRetention)
    }
  }
}

export function nextUncertainty(current: number, match: MatchRecord, league: string, opponentLeague: string) {
  const contextSignal = normalize(eventTierConfig[match.tier].kFactor, 12, 34) * 8
  const crossLeagueSignal = league !== opponentLeague && isInternationalMatch(match) ? 7 : 0
  return clamp(current - 5 - contextSignal - crossLeagueSignal, minimumUncertainty, maximumUncertainty)
}

export function normalize(value: number, min: number, max: number) {
  return clamp((value - min) / (max - min), 0, 1)
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function powerRating(teamRating: number, leagueRating: number) {
  return teamRating + (leagueRating - initialLeagueRating) * leagueEloWeight
}

export function ratingComponents({
  teamRating,
  leagueScore,
  rosterPriorOffset,
  momentum,
  contextAdjustment,
  uncertainty,
}: {
  teamRating: number
  leagueScore: number
  rosterPriorOffset: number
  momentum: number
  contextAdjustment: number
  uncertainty: number
}): RatingComponents {
  return {
    leagueAnchor: Math.round(leagueScore),
    teamStableOffset: Math.round(teamRating - initialTeamRating),
    rosterPriorOffset: Number(rosterPriorOffset.toFixed(1)),
    momentum: Number(momentum.toFixed(1)),
    contextAdjustment: Number(contextAdjustment.toFixed(1)),
    uncertainty: Math.round(uncertainty),
  }
}

export function ratingFromComponents(components: RatingComponents) {
  return components.leagueAnchor
    + components.teamStableOffset
    + components.rosterPriorOffset
    + components.momentum
    + components.contextAdjustment
}

export function emptyRatingUpdateLedger(): RatingUpdateLedger {
  return {
    teamStableDelta: 0,
    leagueGameDelta: 0,
    leaguePlacementDelta: 0,
    momentumDelta: 0,
    rosterPriorDelta: 0,
    uncertaintyDelta: 0,
    sideAdjustment: 0,
    patchAdjustment: 0,
  }
}

export function roundedRatingUpdateLedger(update: RatingUpdateLedger): RatingUpdateLedger {
  return {
    teamStableDelta: Number(update.teamStableDelta.toFixed(1)),
    leagueGameDelta: Number(update.leagueGameDelta.toFixed(1)),
    leaguePlacementDelta: Number(update.leaguePlacementDelta.toFixed(1)),
    momentumDelta: Number(update.momentumDelta.toFixed(1)),
    rosterPriorDelta: Number(update.rosterPriorDelta.toFixed(1)),
    uncertaintyDelta: Number(update.uncertaintyDelta.toFixed(1)),
    sideAdjustment: Number(update.sideAdjustment.toFixed(1)),
    patchAdjustment: Number(update.patchAdjustment.toFixed(1)),
  }
}

export function leagueAdjustment(teamRating: number, leagueRating: number) {
  return Math.round(powerRating(teamRating, leagueRating) - teamRating)
}

export function gameKFor(match: MatchRecord) {
  return eventTierConfig[match.tier].kFactor / Math.sqrt(normalizedBestOf(match.bestOf))
}

export function uncertaintyKMultiplier(sigma: number) {
  return clamp(
    1 + (sigma - normalUncertainty) / uncertaintyKScale,
    uncertaintyKMultiplierFloor,
    uncertaintyKMultiplierCeiling,
  )
}

export function rosterVolatilityMultiplier(continuity?: number) {
  if (continuity === undefined) return 1
  return clamp(1 + (1 - continuity) * 0.5, 1, rosterVolatilityKCeiling)
}

export function momentumDelta(resultResidual: number, executionResidual: number) {
  return momentumKFactor * resultResidual + momentumExecutionKFactor * executionResidual
}

export function isInternationalMatch(match: MatchRecord) {
  return match.region === 'International' || ['worlds-playoffs', 'worlds-main', 'msi-bracket', 'msi-play-in', 'minor-international'].includes(match.tier)
}

function splitLabel(eventName: string) {
  const match = eventName.match(/\b(Winter|Spring|Summer|Fall|Autumn)\b/i)
  return match?.[1]?.toLowerCase() ?? eventName.toLowerCase()
}
