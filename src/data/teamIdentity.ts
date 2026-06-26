import type { Region, TeamProfile } from '../types'

export const knownTeamIdentities: Record<string, TeamProfile> = {
  'Bilibili Gaming': { name: 'Bilibili Gaming', code: 'BLG', region: 'LPL', league: 'LPL' },
  Cloud9: { name: 'Cloud9', code: 'C9', region: 'LCS', league: 'LCS' },
  'CTBC Flying Oyster': { name: 'CTBC Flying Oyster', code: 'CFO', region: 'LCP', league: 'LCP' },
  Fnatic: { name: 'Fnatic', code: 'FNC', region: 'LEC', league: 'LEC' },
  FlyQuest: { name: 'FlyQuest', code: 'FLY', region: 'LCS', league: 'LCS' },
  'G2 Esports': { name: 'G2 Esports', code: 'G2', region: 'LEC', league: 'LEC' },
  'GAM Esports': { name: 'GAM Esports', code: 'GAM', region: 'VCS', league: 'VCS' },
  'Gen.G': { name: 'Gen.G', code: 'GEN', region: 'LCK', league: 'LCK' },
  'Hanwha Life Esports': { name: 'Hanwha Life Esports', code: 'HLE', region: 'LCK', league: 'LCK' },
  'JD Gaming': { name: 'JD Gaming', code: 'JDG', region: 'LPL', league: 'LPL' },
  LOUD: { name: 'LOUD', code: 'LLL', region: 'CBLOL', league: 'CBLOL' },
  T1: { name: 'T1', code: 'T1', region: 'LCK', league: 'LCK' },
  'Team Liquid': { name: 'Team Liquid', code: 'TL', region: 'LCS', league: 'LCS' },
  'Top Esports': { name: 'Top Esports', code: 'TES', region: 'LPL', league: 'LPL' },
  'Weibo Gaming': { name: 'Weibo Gaming', code: 'WBG', region: 'LPL', league: 'LPL' },
}

export function teamIdentityFor(teamName: string): TeamProfile | undefined {
  return knownTeamIdentities[teamName]
}

export function regionForLeague(league: string): Region {
  const normalized = league.toUpperCase()
  if (normalized.includes('LCK')) return 'LCK'
  if (normalized.includes('LPL')) return 'LPL'
  if (normalized.includes('LEC')) return 'LEC'
  if (normalized.includes('LCS')) return 'LCS'
  if (normalized.includes('LCP')) return 'LCP'
  if (normalized.includes('CBLOL')) return 'CBLOL'
  if (normalized.includes('VCS')) return 'VCS'
  if (normalized.includes('PCS')) return 'PCS'
  return 'International'
}
