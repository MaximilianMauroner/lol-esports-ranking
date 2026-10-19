import type { ChartSeries } from '../../components/LineChart'
import type { RankingSummaryStanding } from '../../domains/rankings/types'
import { formatNumber, formatRating, formatRatio, formatSigned } from '../../shared/display'

export function activeMovement(team: RankingSummaryStanding) {
  return team.rollingMovement?.status === 'active' ? team.rollingMovement : undefined
}

/**
 * The 30-day chip shows places moved. The exact ranks go in the tooltip with
 * their basis: the history baseline and the published board endpoint.
 */
export function rollingMovementTitle(team: RankingSummaryStanding, period: string) {
  const movement = activeMovement(team)
  if (!movement) return `${team.team}: no scored series ${period}.`
  return `${team.team}, ${period}: baseline rank #${movement.baselineRank} to published rank #${movement.currentRank}, ${formatRatingMovement(movement.ratingDelta ?? 0)} Power over ${formatNumber(movement.scoredSeries)} series.`
}

export function teamRankFor(team: RankingSummaryStanding) {
  return team.rank
}

export function teamBoardRankLabel(team: RankingSummaryStanding, rank?: number) {
  if (team.eligibility?.eligible === false) return 'Excluded'
  return typeof rank === 'number' ? `#${formatNumber(rank)}` : '#—'
}

export function teamScoreFor(team: RankingSummaryStanding) {
  return team.rating
}

export function formatUncertaintyBand(value: number) {
  return `±${formatRating(value)}`
}

export function teamScoreTitle(team: RankingSummaryStanding) {
  const dss = team.deservedStanding
  const base = [
    `Power score ${formatRating(team.rating)}`,
    'Published Power score; trend movement uses match history.',
    team.scoreFamily ? `score family ${scoreFamilyLabel(team.scoreFamily)}` : undefined,
    team.recordBasis ? `record basis ${recordBasisLabel(team.recordBasis)}` : undefined,
    typeof team.uncertainty === 'number' ? `uncertainty ${formatUncertaintyBand(team.uncertainty)}` : undefined,
    team.eligibility?.eligible === false ? eligibilityReasonsTitle(team) : undefined,
  ].filter(Boolean)
  if (!dss) return base.join(' · ')
  return [
    ...base,
    `deserved check #${dss.rank} (${formatRating(dss.score)})`,
    `WAE ${formatSigned(dss.winsAboveExpectation)}`,
    `roster validity ${formatRatio(dss.rosterValidity)}`,
    dss.eligibility,
  ].join(' · ')
}

type PowerResumeGapSummary = {
  label: string
  detail: string
  rankDetail: string
  title: string
}

export function powerResumeGapSummary(team: RankingSummaryStanding): PowerResumeGapSummary | undefined {
  const dss = team.deservedStanding
  if (!dss) return undefined
  const rankGap = dss.rankDeltaFromPower
  const scoreGap = dss.scoreDeltaFromPower
  const absRankGap = Math.abs(rankGap)
  const places = `${formatNumber(absRankGap)} ${absRankGap === 1 ? 'place' : 'places'}`
  const rankPhrase = rankGap > 0
    ? `Results rank is ${places} ahead`
    : rankGap < 0
      ? `Power rank is ${places} ahead`
      : 'Power and results ranks align'
  const scorePhrase = scoreGap === 0 ? 'no score gap' : `${formatSigned(scoreGap)} results score gap`
  return {
    label: rankGap > 0 ? 'Results ahead' : rankGap < 0 ? 'Power ahead' : 'Aligned',
    detail: `${rankPhrase}; ${scorePhrase}`,
    rankDetail: rankGap === 0 ? 'Same as its Power rank' : `${places} ${rankGap > 0 ? 'ahead of' : 'behind'} its Power rank`,
    title: `Power rank #${formatNumber(team.rank)} vs results rank #${formatNumber(dss.rank)}. ${rankPhrase}; ${scorePhrase}.`,
  }
}

function scoreFamilyLabel(scoreFamily: RankingSummaryStanding['scoreFamily']) {
  if (scoreFamily === 'deserved-standing') return 'Deserved Standing'
  return 'Power Index'
}

export function recordBasisLabel(recordBasis: RankingSummaryStanding['recordBasis']) {
  if (recordBasis === 'grouped-match-record-from-scope-history') return 'grouped match record in this scope'
  if (recordBasis === 'standing-record-from-ranking-model') return 'ranking-model standing record'
  return 'record basis unavailable'
}

export function formatRatingMovement(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unknown'
  const rounded = Math.round(value)
  if (rounded === 0) return '0'
  return rounded > 0 ? `+${formatNumber(Math.abs(rounded))}` : `-${formatNumber(Math.abs(rounded))}`
}

export function movementTone(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.round(value) === 0) return 'flat'
  return value > 0 ? 'up' : 'down'
}

type RankMovementTone = 'up' | 'down' | 'flat'

export function rankMovementTone(value?: number): RankMovementTone {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.round(value) === 0) return 'flat'
  return value > 0 ? 'up' : 'down'
}

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function formatRankMovementLabel(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'No prior rank'
  const places = Math.abs(Math.round(value))
  if (places === 0) return 'No change'
  return `${value > 0 ? 'Up' : 'Down'} ${formatNumber(places)} ${places === 1 ? 'place' : 'places'}`
}

export function formatRankValue(rank?: number) {
  return typeof rank === 'number' && Number.isFinite(rank) ? `#${formatNumber(Math.round(rank))}` : '—'
}

export function eligibilitySummary(team: RankingSummaryStanding) {
  const reasons = eligibilityReasonLabels(team)
  if (reasons.length === 0) return 'not ranked'
  return reasons.slice(0, 2).join('; ')
}

export function eligibilityReasonsTitle(team: RankingSummaryStanding) {
  const reasons = eligibilityReasonLabels(team)
  if (reasons.length === 0) return 'Not ranked in the current board.'
  return `Not ranked: ${reasons.join('; ')}.`
}

function eligibilityReasonLabels(team: RankingSummaryStanding) {
  return (team.eligibility?.reasons ?? []).map((reason) => eligibilityReasonLabel(reason, team))
}

function eligibilityReasonLabel(reason: string, team: RankingSummaryStanding) {
  const eligibility = team.eligibility
  switch (reason) {
    case 'low-total-volume':
      return typeof eligibility?.totalGames === 'number' && typeof eligibility.minTotalGames === 'number'
        ? `too few scored matches (${formatNumber(eligibility.totalGames)}/${formatNumber(eligibility.minTotalGames)})`
        : 'too few scored matches'
    case 'low-current-volume':
      return typeof eligibility?.currentWindowGames === 'number' && typeof eligibility.minCurrentWindowGames === 'number'
        ? `too few recent matches (${formatNumber(eligibility.currentWindowGames)}/${formatNumber(eligibility.minCurrentWindowGames)})`
        : 'too few recent matches'
    case 'stale':
      return typeof eligibility?.daysSinceLastMatch === 'number'
        ? `stale schedule: last match ${formatNumber(eligibility.daysSinceLastMatch)}d ago`
        : 'stale schedule'
    case 'high-uncertainty':
      return 'rating uncertainty above the ranked-board cutoff'
    case 'unanchored-league':
      return 'league not yet connected to the global pool'
    default:
      return reason.replaceAll('-', ' ')
  }
}

export function rankAxisForSeries(series: ChartSeries[]) {
  const ranks = series
    .flatMap((entry) => entry.points.map((point) => point.y))
    .filter((rank) => Number.isFinite(rank) && rank >= 1)
    .map((rank) => Math.round(rank))
  if (ranks.length === 0) return undefined
  const axisMax = Math.max(5, Math.max(...ranks))
  const ticks = axisMax <= 8
    ? Array.from({ length: axisMax }, (_, index) => index + 1)
    : uniqueSorted([1, Math.round(axisMax * 0.25), Math.round(axisMax * 0.5), Math.round(axisMax * 0.75), axisMax])
  return {
    domain: { min: 1, max: axisMax },
    ticks,
  }
}

function uniqueSorted(values: number[]) {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value >= 1).map(Math.round))].sort((a, b) => a - b)
}

export function isEventTier(value: string | undefined): value is EventTier {
  return typeof value === 'string' && value in eventTierConfig
}

export function formatEventWeight(weight: number) {
  return `${formatDecimal(weight)}x`
}

import { eventTierConfig } from '../../domains/rankings/policy'
import type { EventTier } from '../../domains/rankings/types'
import { formatDecimal } from '../../shared/display'
