import type { MatchRecord, PublishedRatingScale, RatingComponents, RatingUpdateLedger, RosterBasis } from '../types'
import { eventKFactorForMatch, type EventWeightContext } from './eventWeighting'
import { normalizedBestOf } from './matchFormat'
import { isDemaciaCupEvent } from '../data/competitionTaxonomy'
import {
  initialLeagueRating,
  initialTeamRating,
  leagueEloWeight,
  maximumUncertainty,
  minimumUncertainty,
  normalUncertainty,
  publishedLeagueAnchorReliefConfig,
  publishedLeagueAnchorShrinkageConfig,
  publishedRatingScale,
  publishedSparseStandingConfig,
  publishedRosterPriorConfig,
  publishedTeamStableOffsetConfig,
  recencyHalfLifeDays,
  rosterVolatilityKCeiling,
  uncertaintyKMultiplierCeiling,
  uncertaintyKMultiplierFloor,
  uncertaintyKScale,
} from './modelConfig'

export function expectedScore(ratingA: number, ratingB: number) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400))
}

export function recencyWeight(date: string, lastDate: string) {
  const days = Math.max(0, (Date.parse(lastDate) - Date.parse(date)) / 86_400_000)
  return 2 ** (-days / recencyHalfLifeDays)
}

export function nextUncertainty(
  current: number,
  match: MatchRecord,
  league: string,
  opponentLeague: string,
  eventWeightContext?: EventWeightContext,
) {
  const contextSignal = normalize(eventKFactorForMatch(match, eventWeightContext), 12, 34) * 8
  const crossLeagueSignal = league !== opponentLeague && isInternationalMatch(match) ? 7 : 0
  return clamp(current - 5 - contextSignal - crossLeagueSignal, minimumUncertainty, maximumUncertainty)
}

export function normalize(value: number, min: number, max: number) {
  return clamp((value - min) / (max - min), 0, 1)
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function toPublishedRating(internalRating: number, scale: PublishedRatingScale = publishedRatingScale) {
  if (!Number.isFinite(internalRating)) return internalRating
  return clamp(
    scale.publishedAnchor + (internalRating - scale.internalAnchor) * scale.spreadMultiplier,
    scale.publishedMinimum,
    scale.publishedMaximum,
  )
}

export function toInternalRating(publishedRating: number, scale: PublishedRatingScale = publishedRatingScale) {
  if (!Number.isFinite(publishedRating)) return publishedRating
  const clamped = clamp(publishedRating, scale.publishedMinimum, scale.publishedMaximum)
  return scale.internalAnchor + (clamped - scale.publishedAnchor) / scale.spreadMultiplier
}

export function toPublishedRatingDelta(internalDelta: number, scale: PublishedRatingScale = publishedRatingScale) {
  if (!Number.isFinite(internalDelta)) return internalDelta
  return internalDelta * scale.spreadMultiplier
}

export function toInternalRatingDelta(publishedDelta: number, scale: PublishedRatingScale = publishedRatingScale) {
  if (!Number.isFinite(publishedDelta)) return publishedDelta
  return publishedDelta / scale.spreadMultiplier
}

export function toPublishedRatingComponents(
  components: RatingComponents,
  scale: PublishedRatingScale = publishedRatingScale,
): RatingComponents {
  return {
    leagueAnchor: Math.round(toPublishedRating(components.leagueAnchor, scale)),
    teamStableOffset: roundScaledDelta(components.teamStableOffset, scale),
    rosterPriorOffset: roundScaledDelta(components.rosterPriorOffset, scale),
    momentum: roundScaledDelta(components.momentum, scale),
    contextAdjustment: roundScaledDelta(components.contextAdjustment, scale),
    uncertainty: Math.round(toPublishedRatingDelta(components.uncertainty, scale)),
  }
}

export function ratingScaleFromUnknown(value: unknown): PublishedRatingScale | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.version !== 'string'
    || typeof candidate.internalAnchor !== 'number'
    || typeof candidate.publishedAnchor !== 'number'
    || typeof candidate.spreadMultiplier !== 'number'
    || typeof candidate.publishedMinimum !== 'number'
    || typeof candidate.publishedMaximum !== 'number'
    || typeof candidate.label !== 'string'
    || typeof candidate.shortLabel !== 'string'
    || typeof candidate.description !== 'string'
  ) {
    return undefined
  }
  if (
    !Number.isFinite(candidate.internalAnchor)
    || !Number.isFinite(candidate.publishedAnchor)
    || !Number.isFinite(candidate.spreadMultiplier)
    || !Number.isFinite(candidate.publishedMinimum)
    || !Number.isFinite(candidate.publishedMaximum)
    || candidate.spreadMultiplier <= 0
    || candidate.publishedMinimum >= candidate.publishedMaximum
  ) {
    return undefined
  }
  return {
    version: candidate.version,
    internalAnchor: candidate.internalAnchor,
    publishedAnchor: candidate.publishedAnchor,
    spreadMultiplier: candidate.spreadMultiplier,
    publishedMinimum: candidate.publishedMinimum,
    publishedMaximum: candidate.publishedMaximum,
    label: candidate.label,
    shortLabel: candidate.shortLabel,
    description: candidate.description,
  }
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
    leagueAnchor: leagueScore,
    teamStableOffset: publishedTeamStableOffset(teamRating - initialTeamRating),
    rosterPriorOffset: rosterPriorOffset,
    momentum: momentum,
    contextAdjustment: contextAdjustment,
    uncertainty: uncertainty,
  }
}

export function publishedTeamStableOffset(
  rawOffset: number,
  config = publishedTeamStableOffsetConfig,
) {
  if (rawOffset <= config.positiveSoftCap) return rawOffset
  return config.positiveSoftCap + (rawOffset - config.positiveSoftCap) * config.positiveOverflowScale
}

export function publishedLeagueAnchorContextAdjustment(
  {
    leagueScore,
    teamRating,
    wins,
    losses,
    uncertainty,
    rosterBasis,
  }: {
    leagueScore: number
    teamRating: number
    wins: number
    losses: number
    uncertainty: number
    rosterBasis?: RosterBasis
  },
  config = publishedLeagueAnchorReliefConfig,
) {
  if (rosterBasis !== 'sourced') return 0
  if (wins + losses < config.minimumGames) return 0
  if (uncertainty > config.maxUncertainty) return 0

  const stableOffset = teamRating - initialTeamRating
  const recordMargin = wins - losses
  const leagueGap = leagueScore - initialLeagueRating
  if (Math.abs(stableOffset) < config.minStableOffset) return 0
  if (recordMargin === 0 || Math.sign(recordMargin) !== Math.sign(stableOffset)) return 0
  if (leagueGap === 0 || Math.sign(leagueGap) === Math.sign(stableOffset)) return 0

  const adjustment = Math.min(config.maxAdjustment, Math.abs(leagueGap) * config.leagueGapShare)
  return Math.sign(stableOffset) * adjustment
}

export function evidenceWeightedPublishedLeagueAnchor(
  leagueScore: number,
  matches: number,
  config = publishedLeagueAnchorShrinkageConfig,
) {
  const progress = clamp(matches / Math.max(1, config.fullReliabilityMatches), 0, 1)
  const reliability = config.minimumReliability + (1 - config.minimumReliability) * progress
  return initialLeagueRating + (leagueScore - initialLeagueRating) * reliability
}

export function evidenceWeightedPublishedStanding(
  currentRating: number,
  lastMatchRating: number | undefined,
  matches: number,
  config = publishedSparseStandingConfig,
) {
  if (typeof lastMatchRating !== 'number' || !Number.isFinite(lastMatchRating)) return currentRating
  const progress = clamp(matches / Math.max(1, config.fullReliabilityMatches), 0, 1)
  const reliability = config.minimumReliability + (1 - config.minimumReliability) * progress
  return lastMatchRating + (currentRating - lastMatchRating) * reliability
}

export function ratingFromComponents(components: RatingComponents) {
  return components.leagueAnchor
    + components.teamStableOffset
    + components.rosterPriorOffset
    + components.momentum
    + components.contextAdjustment
}

export function publishedRosterPriorOffset(
  rawOffset: number,
  wins: number,
  losses: number,
  config = publishedRosterPriorConfig,
) {
  if (rawOffset <= 0) return rawOffset
  const games = wins + losses
  if (games < config.minimumGames) return rawOffset

  const winRate = games > 0 ? wins / games : config.fullScaleWinRate
  if (winRate >= config.fullScaleWinRate) return rawOffset
  if (winRate <= config.floorScaleWinRate) return rawOffset * config.floorScale

  const capRange = config.fullScaleWinRate - config.floorScaleWinRate
  const progress = capRange > 0 ? (winRate - config.floorScaleWinRate) / capRange : 1
  const scale = config.floorScale + (1 - config.floorScale) * progress
  return rawOffset * scale
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
    ratingTarget: 'context-neutral-latent-team-strength',
    updateUnit: 'series-atomic',
    resultEvidence: 0,
    baseTeamStableDelta: 0,
    baseTeamFormDelta: 0,
    baseLeagueDelta: 0,
    uncertaintyMultiplier: 1,
    rosterVolatilityMultiplier: 1,
    stableTransferWeight: 1,
    neutralResultResidual: 0,
    seriesStrengthSignal: 1,
    teamStableShare: 0,
    teamFormShare: 0,
    playerSignalShare: 0,
    lineupSignalShare: 0,
    leagueSignalShare: 0,
    directRegionSignalShare: 0,
    playerSignalDelta: 0,
    lineupSignalDelta: 0,
    directRegionSignalDelta: 0,
    unavailableChannels: [],
  }
}

function roundScaledDelta(value: number, scale: PublishedRatingScale) {
  return Number(toPublishedRatingDelta(value, scale).toFixed(1))
}

export function leagueAdjustment(teamRating: number, leagueRating: number) {
  return powerRating(teamRating, leagueRating) - teamRating
}

export function gameKFor(match: MatchRecord, eventWeightContext?: EventWeightContext, resolvedBestOf = match.bestOf) {
  return eventKFactorForMatch(match, eventWeightContext) / Math.sqrt(normalizedBestOf(resolvedBestOf))
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

export function isInternationalMatch(match: MatchRecord) {
  if (isDemaciaCupEvent(`${match.league} ${match.event}`)) return false
  return match.region === 'International' || ['worlds-playoffs', 'worlds-main', 'msi-bracket', 'msi-play-in', 'minor-international'].includes(match.tier)
}
