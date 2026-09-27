import type {
  PublicTeamStanding as RankingSummaryStanding,
} from '../lib/publicArtifacts/schema'
import {
  formatDecimal,
  formatNumber,
  formatRating,
  formatRatio,
  formatRecord,
  teamKey,
} from '../lib/display'
import {
  displayRegionPowerScore,
  displayRegionTotalTeamRating,
  type RegionStrength,
} from '../lib/regionStrength'
import type { CompareColumn, CompareRow } from './CompareDrawer'
import { FormDots, RegionBadge } from './ui'
import { MovementChip } from './WhatChanged'

export const REGION_COMPARE_ROWS: CompareRow<RegionStrength>[] = [
  { key: 'score', label: 'Region power', cell: (r) => formatRating(displayRegionPowerScore(r)), score: displayRegionPowerScore, better: 'high' },
  { key: 'rank', label: 'Global rank', cell: (r) => `#${r.rank}`, score: (r) => r.rank, better: 'low' },
  { key: 'flagship', label: 'Flagship league', cell: (r) => r.flagshipLeague ?? 'Multiple leagues' },
  { key: 'tier', label: 'League tier', cell: (r) => formatTier(r.tier) },
  { key: 'teams', label: 'Flagship teams', cell: (r) => formatNumber(r.teamCount), score: (r) => r.teamCount, better: 'high' },
  { key: 'topteam', label: 'Top team power', cell: (r) => formatRating(r.topTeamRating), score: (r) => r.topTeamRating, better: 'high' },
  { key: 'topthree', label: 'Top-three average', cell: (r) => formatRating(displayRegionPowerScore(r)), score: displayRegionPowerScore, better: 'high' },
  { key: 'totalregion', label: 'Flagship-team average', cell: (r) => formatRating(displayRegionTotalTeamRating(r)), score: displayRegionTotalTeamRating, better: 'high' },
  { key: 'record', label: 'International record', cell: (r) => formatRecord(r.internationalWins, r.internationalLosses) },
  {
    key: 'winrate',
    label: 'International win rate',
    cell: (r) => formatRatio(r.internationalWinRate),
    score: (r) => r.internationalWinRate ?? Number.NEGATIVE_INFINITY,
    better: 'high',
  },
  {
    key: 'adjusted',
    label: 'Win rate vs opponent strength',
    cell: (r) => formatRatio(r.opponentAdjustedWinRate),
    score: (r) => r.opponentAdjustedWinRate ?? Number.NEGATIVE_INFINITY,
    better: 'high',
  },
  {
    key: 'expected',
    label: 'Wins vs expected',
    cell: (r) => formatSignedDecimal(r.winsOverExpected),
    score: (r) => r.winsOverExpected ?? Number.NEGATIVE_INFINITY,
    better: 'high',
  },
  {
    key: 'opponent',
    label: 'Opponent power',
    cell: (r) => formatRating(r.averageOpponentRating),
    score: (r) => r.averageOpponentRating ?? Number.NEGATIVE_INFINITY,
    better: 'high',
  },
  { key: 'connectivity', label: 'Connectivity', cell: (r) => formatRatio(r.connectivity), score: (r) => r.connectivity, better: 'high' },
]

export const TEAM_COMPARE_ROWS: CompareRow<RankingSummaryStanding>[] = [
  { key: 'rating', label: 'Power', cell: (t) => formatRating(teamScore(t)), score: (t) => teamScore(t) ?? 0, better: 'high' },
  { key: 'rank', label: 'Rank', cell: (t) => `#${t.rank ?? '—'}`, score: (t) => t.rank ?? Infinity, better: 'low' },
  {
    key: 'results-rank',
    label: 'Rank on results alone',
    cell: (t) => (t.deservedStanding ? `#${formatNumber(t.deservedStanding.rank)}` : '—'),
    score: (t) => t.deservedStanding?.rank ?? Infinity,
    better: 'low',
  },
  { key: 'league', label: 'League', cell: (t) => t.league ?? '—' },
  { key: 'record', label: 'Record', cell: (t) => formatRecord(t.wins, t.losses) },
  {
    key: 'winrate',
    label: 'Win rate',
    cell: (t) => formatRatio(winRate(t.wins, t.losses)),
    score: (t) => winRate(t.wins, t.losses),
    better: 'high',
  },
  {
    key: 'movement',
    label: 'Last 30 days',
    cell: (t) => <MovementChip places={t.rollingMovement?.status === 'active' ? t.rollingMovement.rankMovement ?? undefined : undefined} />,
  },
  { key: 'form', label: 'Recent form', cell: (t) => <FormDots form={t.form} /> },
]

export type CompareProfileMetric<E> = {
  key: string
  label: string
  value: (entity: E) => number | undefined
  format: (value?: number) => string
  better?: 'high' | 'low'
}

export const REGION_PROFILE_METRICS: CompareProfileMetric<RegionStrength>[] = [
  { key: 'score', label: 'Region power', value: displayRegionPowerScore, format: formatRating },
  { key: 'topteam', label: 'Top team power', value: (r) => r.topTeamRating, format: formatRating },
  { key: 'topthree', label: 'Top-three avg', value: displayRegionPowerScore, format: formatRating },
  { key: 'totalregion', label: 'Flagship avg', value: displayRegionTotalTeamRating, format: formatRating },
  { key: 'adjusted', label: 'Vs opponent strength', value: (r) => r.opponentAdjustedWinRate, format: formatRatio },
  { key: 'expected', label: 'Vs expected', value: (r) => r.winsOverExpected, format: formatSignedDecimal },
  { key: 'opponent', label: 'Opponent power', value: (r) => r.averageOpponentRating, format: formatRating },
  { key: 'connectivity', label: 'Connectivity', value: (r) => r.connectivity, format: formatRatio },
]

export const TEAM_PROFILE_METRICS: CompareProfileMetric<RankingSummaryStanding>[] = [
  { key: 'rating', label: 'Power', value: teamScore, format: formatRating },
  { key: 'rank', label: 'Rank', value: (t) => t.rank, format: (value) => (typeof value === 'number' ? `#${Math.round(value)}` : '—'), better: 'low' },
  { key: 'results-rank', label: 'Rank on results alone', value: (t) => t.deservedStanding?.rank, format: (value) => (typeof value === 'number' ? `#${Math.round(value)}` : '—'), better: 'low' },
  { key: 'winrate', label: 'Win rate', value: (t) => winRate(t.wins, t.losses), format: formatRatio },
]

export function regionKey(region: RegionStrength) {
  return region.region
}

export function regionCompareColumns(regions: RegionStrength[]): CompareColumn[] {
  return regions.map((region) => ({
    id: regionKey(region),
    name: region.region,
    sub: `#${region.rank} · ${region.flagshipLeague ?? 'Multiple leagues'}`,
    badge: <RegionBadge region={region.region} size="sm" />,
  }))
}

export function teamCompareColumns(teams: RankingSummaryStanding[]): CompareColumn[] {
  return teams.map((team) => ({ id: teamKey(team), name: team.team, sub: `${team.region ?? '—'} · #${team.rank ?? '—'}` }))
}

function winRate(wins?: number, losses?: number) {
  if (typeof wins !== 'number' || typeof losses !== 'number') return 0
  const total = wins + losses
  return total > 0 ? wins / total : 0
}

function teamScore(team: RankingSummaryStanding) {
  return team.rating
}

function formatSignedDecimal(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (Math.abs(value) < 0.05) return '0'
  return value > 0 ? `+${formatDecimal(value)}` : formatDecimal(value)
}

function formatTier(value?: string) {
  if (!value) return '—'
  return value
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}
