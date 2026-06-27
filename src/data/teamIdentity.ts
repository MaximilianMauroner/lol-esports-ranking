import type { Region, TeamProfile } from '../types'

export const knownTeamIdentities: Record<string, TeamProfile> = {
  'Bilibili Gaming': { name: 'Bilibili Gaming', code: 'BLG', region: 'LPL', league: 'LPL' },
  'BNK FEARX': { name: 'BNK FEARX', code: 'BFX', region: 'LCK', league: 'LCK' },
  Cloud9: { name: 'Cloud9', code: 'C9', region: 'LCS', league: 'LCS' },
  'CTBC Flying Oyster': { name: 'CTBC Flying Oyster', code: 'CFO', region: 'LCP', league: 'LCP' },
  'Dplus KIA': { name: 'Dplus KIA', code: 'DK', region: 'LCK', league: 'LCK' },
  'EDward Gaming': { name: 'EDward Gaming', code: 'EDG', region: 'LPL', league: 'LPL' },
  Fnatic: { name: 'Fnatic', code: 'FNC', region: 'LEC', league: 'LEC' },
  FlyQuest: { name: 'FlyQuest', code: 'FLY', region: 'LCS', league: 'LCS' },
  'G2 Esports': { name: 'G2 Esports', code: 'G2', region: 'LEC', league: 'LEC' },
  'GAM Esports': { name: 'GAM Esports', code: 'GAM', region: 'VCS', league: 'VCS' },
  'Gen.G': { name: 'Gen.G', code: 'GEN', region: 'LCK', league: 'LCK' },
  'Hanwha Life Esports': { name: 'Hanwha Life Esports', code: 'HLE', region: 'LCK', league: 'LCK' },
  'JD Gaming': { name: 'JD Gaming', code: 'JDG', region: 'LPL', league: 'LPL' },
  'Kiwoom DRX': { name: 'Kiwoom DRX', code: 'KRX', region: 'LCK', league: 'LCK' },
  'KT Rolster': { name: 'KT Rolster', code: 'KT', region: 'LCK', league: 'LCK' },
  'LNG Esports': { name: 'LNG Esports', code: 'LNG', region: 'LPL', league: 'LPL' },
  LOUD: { name: 'LOUD', code: 'LLL', region: 'CBLOL', league: 'CBLOL' },
  T1: { name: 'T1', code: 'T1', region: 'LCK', league: 'LCK' },
  'Team Liquid': { name: 'Team Liquid', code: 'TL', region: 'LCS', league: 'LCS' },
  'Team Secret': { name: 'Team Secret', code: 'TS', region: 'LCP', league: 'LCP' },
  'Team Secret Whales': { name: 'Team Secret Whales', code: 'TSW', region: 'LCP', league: 'LCP' },
  'Top Esports': { name: 'Top Esports', code: 'TES', region: 'LPL', league: 'LPL' },
  'Weibo Gaming': { name: 'Weibo Gaming', code: 'WBG', region: 'LPL', league: 'LPL' },
}

const exactTeamAliases: Record<string, string> = {
  '9Gaming Esports': '9Gaming',
  'DN Freecs': 'DN SOOPers',
  DRX: 'Kiwoom DRX',
  'Dplus Kia': 'Dplus KIA',
  'Dplus KIA': 'Dplus KIA',
  'Dplus KIA Academy': 'Dplus Kia Academy',
  'Dplus KIA Challengers': 'Dplus Kia Challengers',
  'Dplus KIA Youth': 'Dplus Kia Youth',
  GIANTX: 'GiantX',
  'LYON (2024 American Team)': 'LYON',
  'Ninjas in Pyjamas.CN': 'Ninjas in Pyjamas',
  'OKSavingsBank BRION': 'HANJIN BRION',
  'Rogue (European Team)': 'Rogue',
  'Team Secret (Vietnamese Team)': 'Team Secret',
  'ZEN Esports (Vietnamese Team)': 'ZEN Esports',
}

const normalizedTeamAliases = new Map(
  Object.entries(exactTeamAliases).map(([alias, canonical]) => [normalizeIdentityKey(alias), canonical]),
)

const emeaLeagueCodes = new Set(['AL', 'CCWS', 'CT', 'EBL', 'EM', 'HC', 'HLL', 'HM', 'HW', 'IC', 'LES', 'LFL2', 'LIT', 'LPLOL', 'NEXO', 'NL', 'PRMP', 'RL', 'ROL'])
const latamLeagueCodes = new Set(['CD', 'LRN', 'LRS'])
const apacLeagueCodes = new Set(['LTS'])

export function cleanDisplayName(value: string) {
  return decodeHtmlEntities(value).replace(/\s+/g, ' ').trim()
}

export function canonicalTeamNameFor(teamName: string) {
  const cleaned = cleanDisplayName(teamName)
  return exactTeamAliases[cleaned] ?? normalizedTeamAliases.get(normalizeIdentityKey(cleaned)) ?? cleaned
}

export function teamIdentityFor(teamName: string): TeamProfile | undefined {
  return knownTeamIdentities[canonicalTeamNameFor(teamName)] ?? knownTeamIdentities[cleanDisplayName(teamName)]
}

export function teamCodeFor(teamName: string) {
  const identity = teamIdentityFor(teamName)
  if (identity) return identity.code
  const cleaned = canonicalTeamNameFor(teamName)
  const acronym = cleaned
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .map((part) => part.replace(/[^A-Za-z0-9]/g, '')[0])
    .filter(Boolean)
    .join('')
    .slice(0, 4)
    .toUpperCase()
  if (acronym.length >= 2) return acronym
  return cleaned.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || 'UNK'
}

export function regionForLeague(league: string): Region {
  const normalized = league.toUpperCase()
  if (emeaLeagueCodes.has(normalized)) return 'LEC'
  if (latamLeagueCodes.has(normalized)) return 'CBLOL'
  if (apacLeagueCodes.has(normalized)) return 'LCP'
  if (normalized.includes('LCK')) return 'LCK'
  if (normalized.includes('LAS')) return 'LCK'
  if (normalized.includes('LPL')) return 'LPL'
  if (normalized.includes('DCUP') || normalized.includes('DEMACIA CUP')) return 'LPL'
  if (normalized.includes('LEC')) return 'LEC'
  if (normalized.includes('EMEA') || normalized.includes('LFL') || normalized.includes('NLC') || normalized.includes('PRM')) return 'LEC'
  if (normalized.includes('LVP') || normalized.includes('SUPERLIGA') || normalized.includes('TCL') || normalized.includes('ARABIAN')) return 'LEC'
  if (normalized.includes('HITPOINT') || normalized.includes('ROAD OF LEGENDS')) return 'LEC'
  if (normalized.includes('LCS')) return 'LCS'
  if (normalized.includes('LTA N') || normalized.includes('LTA NORTH') || normalized.includes('NACL')) return 'LCS'
  if (normalized.includes('LCP')) return 'LCP'
  if (normalized.includes('LJL') || normalized.includes('LCO')) return 'LCP'
  if (normalized.includes('CBLOL')) return 'CBLOL'
  if (normalized.includes('LTA S') || normalized.includes('LTA SOUTH') || normalized.includes('LLA') || normalized.includes('CIRCUITO DESAFIANTE')) return 'CBLOL'
  if (normalized.includes('VCS')) return 'VCS'
  if (normalized.includes('PCS')) return 'PCS'
  return 'International'
}

function normalizeIdentityKey(value: string) {
  return decodeHtmlEntities(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(e-?sports|gaming)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
}

function decodeHtmlEntities(value: string) {
  return value.replace(/&(#\d+|#x[\da-f]+|[a-z][a-z\d]+);/gi, (entity, rawName: string) => {
    const name = rawName.toLowerCase()
    if (name.startsWith('#x')) return decodeCodePoint(entity, Number.parseInt(name.slice(2), 16))
    if (name.startsWith('#')) return decodeCodePoint(entity, Number.parseInt(name.slice(1), 10))
    return htmlEntityMap[name] ?? entity
  })
}

function decodeCodePoint(entity: string, codePoint: number) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return entity
  return String.fromCodePoint(codePoint)
}

const htmlEntityMap: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
}
