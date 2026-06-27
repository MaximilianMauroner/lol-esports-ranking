import type { Region } from '../types'

export const currentTopTierRegions = ['LCS', 'CBLOL', 'LEC', 'LCK', 'LPL', 'LCP'] as const

export const apacDomesticFeederLeagues = ['PCS', 'VCS', 'LJL', 'LCO', 'LTS'] as const

export const currentRegionTaxonomyModelParameters = {
  source: 'Riot LoL Esports top-level region menu and LCP format update',
  sourceObservedAt: '2026-06-27',
  currentTopTierRegions,
  apacDomesticFeederLeagues,
  apacFlagshipRegion: 'LCP',
  policy: 'PCS, VCS, and LJL remain domestic feeder ecosystems and are folded under LCP for current top-tier region strength.',
} as const

const currentTopTierRegionSet = new Set<string>(currentTopTierRegions)
const apacDomesticFeederLeagueSet = new Set<string>(apacDomesticFeederLeagues)
const apacDomesticFeederRegionSet = new Set<string>(['PCS', 'VCS'])

export function currentTopTierRegionForLeague(league: string | undefined, fallbackRegion: string | undefined) {
  const normalizedLeague = normalizeCode(league)
  const normalizedRegion = normalizeCode(fallbackRegion)
  if (apacDomesticFeederLeagueSet.has(normalizedLeague) || apacDomesticFeederRegionSet.has(normalizedRegion)) {
    return 'LCP' satisfies Region
  }
  return fallbackRegion ?? 'International'
}

export function isCurrentTopTierRegion(region: string | undefined): region is Region {
  return currentTopTierRegionSet.has(normalizeCode(region))
}

export function formatCompetitionRegionLabel(region: string | undefined) {
  if (!region) return '—'
  const normalized = normalizeCode(region)
  if (apacDomesticFeederRegionSet.has(normalized)) return `${region} domestic (LCP feeder)`
  return region
}

export function formatCompetitionLeagueLabel(league: string | undefined) {
  if (!league) return '—'
  const normalized = normalizeCode(league)
  if (apacDomesticFeederLeagueSet.has(normalized)) return `${league} domestic (LCP feeder)`
  return league
}

function normalizeCode(value: string | undefined) {
  return (value ?? '').trim().toUpperCase()
}
