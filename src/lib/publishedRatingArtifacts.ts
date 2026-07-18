import type {
  LeagueStrength,
  PublishedRatingScale,
  RatingComponents,
  RatingUpdateLedger,
  TeamHistoryPoint,
  TeamStanding,
} from '../types'
import type { PublicDeservedStandingComparison, PublicTeamRollingMovement } from './publicArtifacts/schema'
import type { RegionDeservedStandingComparison, RegionStrength } from './regionStrength'
import {
  toPublishedRating,
  toPublishedRatingComponents,
  toPublishedRatingDelta,
} from './ratingCalculations'
import { publishedRatingScale } from './modelConfig'

export type PublishedRatingTeamStandingInput = TeamStanding & {
  deservedStanding?: PublicDeservedStandingComparison
  rollingMovement?: PublicTeamRollingMovement
}

export function toPublishedTeamStanding(
  standing: PublishedRatingTeamStandingInput,
  scale: PublishedRatingScale = publishedRatingScale,
): PublishedRatingTeamStandingInput {
  const rating = publishedRatingValue(standing.rating, scale)
  const previousRating = publishedRatingValue(standing.previousRating, scale, standing.rating)
  const ratingComponents = optionalRatingComponents(standing)
  const ratingUpdate = optionalRatingUpdate(standing)
  const history = optionalHistory(standing)

  const publishedStanding = {
    ...standing,
    baseRating: publishedRatingValue(standing.baseRating, scale, standing.rating),
    leagueScore: publishedRatingValue(standing.leagueScore, scale, scale.internalAnchor),
    leagueAdjustment: publishedDeltaValue(standing.leagueAdjustment, scale),
    leagueDelta: publishedDeltaValue(standing.leagueDelta, scale),
    ...(ratingComponents ? { ratingComponents: publishedComponents(ratingComponents, scale) } : {}),
    ...(ratingUpdate ? { ratingUpdate: toPublishedRatingUpdate(ratingUpdate, scale) } : {}),
    rating,
    previousRating,
    delta: rating - previousRating,
    uncertainty: publishedDeltaValue(standing.uncertainty, scale),
    history: history.map((point) => toPublishedTeamHistoryPoint(point, scale)),
    ...(standing.rollingMovement ? { rollingMovement: toPublishedRollingMovement(standing.rollingMovement, scale) } : {}),
  } as PublishedRatingTeamStandingInput
  return standing.deservedStanding
    ? {
        ...publishedStanding,
        deservedStanding: toPublishedDeservedStandingComparison(standing.deservedStanding, standing.rating, scale),
      }
    : publishedStanding
}

function toPublishedRollingMovement(movement: PublicTeamRollingMovement, scale: PublishedRatingScale): PublicTeamRollingMovement {
  const currentRating = publishedRating(movement.currentRating, scale)
  const biggestUpsetWin = movement.biggestUpsetWin
    ? { ...movement.biggestUpsetWin, ratingDelta: publishedDelta(movement.biggestUpsetWin.ratingDelta, scale) }
    : undefined
  if (movement.status === 'missing-baseline' || movement.baselineRating === undefined) {
    return { ...movement, currentRating, ...(biggestUpsetWin ? { biggestUpsetWin } : {}) }
  }
  const baselineRating = publishedRating(movement.baselineRating, scale)
  return { ...movement, currentRating, baselineRating, ratingDelta: currentRating - baselineRating, ...(biggestUpsetWin ? { biggestUpsetWin } : {}) }
}

export function toPublishedLeagueStrength(
  league: LeagueStrength,
  scale: PublishedRatingScale = publishedRatingScale,
): LeagueStrength {
  return {
    ...league,
    priorScore: publishedRating(league.priorScore, scale),
    rawScore: publishedRating(league.rawScore, scale),
    score: publishedRating(league.score, scale),
    adjustment: publishedDelta(league.adjustment, scale),
    delta: publishedDelta(league.delta, scale),
    ...(league.averageOpponentRating !== undefined
      ? { averageOpponentRating: publishedRating(league.averageOpponentRating, scale) }
      : {}),
  }
}

export function toPublishedRegionStrength(
  region: RegionStrength,
  scale: PublishedRatingScale = publishedRatingScale,
): RegionStrength {
  const topTeams = region.topTeams.map((team) => ({
    ...team,
    rating: publishedRating(team.rating, scale),
  }))
  const topThreeTeamRating = averagePublishedTeamRating(
    topTeams.slice(0, 3),
    publishedRating(region.topThreeTeamRating, scale),
  )
  const totalTeamRating = averagePublishedTeamRating(
    topTeams,
    publishedRating(region.totalTeamRating, scale),
  )
  return {
    ...region,
    score: topThreeTeamRating,
    topTeamRating: topTeams[0]?.rating ?? publishedRating(region.topTeamRating, scale),
    topThreeTeamRating,
    totalTeamRating,
    ...(region.deservedStanding
      ? { deservedStanding: toPublishedRegionDeservedStandingComparison(region.deservedStanding, topThreeTeamRating, scale) }
      : {}),
    ...(region.averageOpponentRating !== undefined
      ? { averageOpponentRating: publishedRating(region.averageOpponentRating, scale) }
      : {}),
    topTeams,
  }
}

export function publishedRating(value: number, scale: PublishedRatingScale = publishedRatingScale) {
  return Math.round(toPublishedRating(value, scale))
}

export function publishedDelta(value: number, scale: PublishedRatingScale = publishedRatingScale) {
  return Math.round(toPublishedRatingDelta(value, scale))
}

export function publishedDeltaOneDecimal(value: unknown, scale: PublishedRatingScale = publishedRatingScale, fallback = 0) {
  return Number(toPublishedRatingDelta(finiteNumber(value) ? value : fallback, scale).toFixed(1))
}

function toPublishedTeamHistoryPoint(
  point: TeamHistoryPoint,
  scale: PublishedRatingScale,
): TeamHistoryPoint {
  const ratingComponents = optionalHistoryRatingComponents(point)
  const ratingUpdate = optionalHistoryRatingUpdate(point)
  const rating = publishedRatingValue(point.rating, scale)

  return {
    ...point,
    rating,
    baseRating: publishedRatingValue(point.baseRating, scale, point.rating),
    leagueAdjustment: publishedDeltaValue(point.leagueAdjustment, scale),
    sideAdjustment: publishedDeltaValue(point.sideAdjustment, scale),
    ...(ratingComponents ? { ratingComponents: publishedComponents(ratingComponents, scale) } : {}),
    ...(ratingUpdate ? { ratingUpdate: toPublishedRatingUpdate(ratingUpdate, scale) } : {}),
    delta: publishedDeltaValue(point.delta, scale),
  } as TeamHistoryPoint
}

function toPublishedDeservedStandingComparison(
  comparison: PublicDeservedStandingComparison,
  internalPowerRating: number,
  scale: PublishedRatingScale,
): PublicDeservedStandingComparison {
  const score = publishedRating(comparison.score, scale)
  const powerScore = publishedRating(internalPowerRating, scale)

  return {
    ...comparison,
    score,
    scoreDeltaFromPower: score - powerScore,
    resumePoints: publishedDelta(comparison.resumePoints, scale),
    scheduleStrengthPoints: publishedDelta(comparison.scheduleStrengthPoints, scale),
    stagePoints: publishedDelta(comparison.stagePoints, scale),
    incomingPlayerBridgeCredit: publishedDelta(comparison.incomingPlayerBridgeCredit, scale),
  }
}

function toPublishedRegionDeservedStandingComparison(
  comparison: RegionDeservedStandingComparison,
  publishedPowerScore: number,
  scale: PublishedRatingScale,
): RegionDeservedStandingComparison {
  const score = publishedRating(comparison.score, scale)

  return {
    ...comparison,
    score,
    scoreDeltaFromPower: score - publishedPowerScore,
    internationalResumePoints: publishedDelta(comparison.internationalResumePoints, scale),
    seedPerformancePoints: publishedDelta(comparison.seedPerformancePoints, scale),
    stagePoints: publishedDelta(comparison.stagePoints, scale),
  }
}

function toPublishedRatingUpdate(
  update: RatingUpdateLedger,
  scale: PublishedRatingScale,
): RatingUpdateLedger {
  return {
    ...update,
    teamStableDelta: publishedDeltaOneDecimal(update.teamStableDelta, scale),
    leagueGameDelta: publishedDeltaOneDecimal(update.leagueGameDelta, scale),
    leaguePlacementDelta: publishedDeltaOneDecimal(update.leaguePlacementDelta, scale),
    momentumDelta: publishedDeltaOneDecimal(update.momentumDelta, scale),
    rosterPriorDelta: publishedDeltaOneDecimal(update.rosterPriorDelta, scale),
    uncertaintyDelta: publishedDeltaOneDecimal(update.uncertaintyDelta, scale),
    sideAdjustment: publishedDeltaOneDecimal(update.sideAdjustment, scale),
    patchAdjustment: publishedDeltaOneDecimal(update.patchAdjustment, scale),
    ...(update.resultEvidence !== undefined ? { resultEvidence: publishedDeltaOneDecimal(update.resultEvidence, scale) } : {}),
    ...(update.playerSignalDelta !== undefined ? { playerSignalDelta: publishedDeltaOneDecimal(update.playerSignalDelta, scale) } : {}),
    ...(update.lineupSignalDelta !== undefined ? { lineupSignalDelta: publishedDeltaOneDecimal(update.lineupSignalDelta, scale) } : {}),
    ...(update.directRegionSignalDelta !== undefined ? { directRegionSignalDelta: publishedDeltaOneDecimal(update.directRegionSignalDelta, scale) } : {}),
  }
}

function publishedComponents(components: RatingComponents, scale: PublishedRatingScale) {
  return toPublishedRatingComponents({
    leagueAnchor: finiteNumber(components.leagueAnchor) ? components.leagueAnchor : scale.internalAnchor,
    teamStableOffset: finiteNumber(components.teamStableOffset) ? components.teamStableOffset : 0,
    rosterPriorOffset: finiteNumber(components.rosterPriorOffset) ? components.rosterPriorOffset : 0,
    momentum: finiteNumber(components.momentum) ? components.momentum : 0,
    contextAdjustment: finiteNumber(components.contextAdjustment) ? components.contextAdjustment : 0,
    uncertainty: finiteNumber(components.uncertainty) ? components.uncertainty : 0,
  }, scale)
}

function publishedRatingValue(value: unknown, scale: PublishedRatingScale, fallback = scale.internalAnchor) {
  return publishedRating(finiteNumber(value) ? value : fallback, scale)
}

function publishedDeltaValue(value: unknown, scale: PublishedRatingScale, fallback = 0) {
  return publishedDelta(finiteNumber(value) ? value : fallback, scale)
}

function optionalRatingComponents(standing: PublishedRatingTeamStandingInput) {
  return completeRatingComponents((standing as { ratingComponents?: RatingComponents }).ratingComponents)
}

function optionalRatingUpdate(standing: PublishedRatingTeamStandingInput) {
  return (standing as { ratingUpdate?: RatingUpdateLedger }).ratingUpdate
}

function optionalHistory(standing: PublishedRatingTeamStandingInput) {
  return (standing as { history?: TeamHistoryPoint[] }).history ?? []
}

function optionalHistoryRatingComponents(point: TeamHistoryPoint) {
  return completeRatingComponents((point as { ratingComponents?: RatingComponents }).ratingComponents)
}

function optionalHistoryRatingUpdate(point: TeamHistoryPoint) {
  return (point as { ratingUpdate?: RatingUpdateLedger }).ratingUpdate
}

function averagePublishedTeamRating(teams: readonly { rating: number }[], fallback: number) {
  const values = teams.map((team) => team.rating).filter(finiteNumber)
  if (values.length === 0) return fallback
  return Math.round(values.reduce((total, rating) => total + rating, 0) / values.length)
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function completeRatingComponents(components: RatingComponents | undefined) {
  if (!components) return undefined
  return finiteNumber(components.leagueAnchor)
    && finiteNumber(components.teamStableOffset)
    && finiteNumber(components.rosterPriorOffset)
    && finiteNumber(components.momentum)
    && finiteNumber(components.contextAdjustment)
    ? components
    : undefined
}
