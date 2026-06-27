import type { LeagueTierName } from '../types'

export type LeagueTierDefinition = {
  tier: LeagueTierName
  label: string
  priorRating: number
  description: string
  anchorEligible: boolean
}

export const leagueTierDefinitions: Record<LeagueTierName, LeagueTierDefinition> = {
  'tier-one': {
    tier: 'tier-one',
    label: 'Tier-one major',
    priorRating: 1500,
    description: 'Globally anchored leagues with regular international title contention.',
    anchorEligible: true,
  },
  'tier-two': {
    tier: 'tier-two',
    label: 'Tier-two major',
    priorRating: 1450,
    description: 'Major-region leagues with recurring international representation but lower title baseline.',
    anchorEligible: true,
  },
  'tier-three': {
    tier: 'tier-three',
    label: 'Tier-three regional',
    priorRating: 1375,
    description: 'First-division minor or merged regional leagues that need current international signal for global-board certainty.',
    anchorEligible: false,
  },
  emerging: {
    tier: 'emerging',
    label: 'Emerging or academy',
    priorRating: 1300,
    description: 'Developmental, national, academy, ERL, lower-division, or lower-connectivity leagues.',
    anchorEligible: false,
  },
  unknown: {
    tier: 'unknown',
    label: 'Unknown',
    priorRating: 1250,
    description: 'League identity is missing or not mapped to a competitive tier.',
    anchorEligible: false,
  },
}

const exactLeagueTiers: Record<string, LeagueTierName> = {
  LCK: 'tier-one',
  LPL: 'tier-one',
  LEC: 'tier-two',
  LCS: 'tier-two',
  LTA: 'tier-two',
  'LTA N': 'tier-two',
  'LTA S': 'tier-three',
  LCP: 'tier-two',
  CBLOL: 'tier-three',
  VCS: 'tier-three',
  PCS: 'tier-three',
  LJL: 'tier-three',
  LLA: 'tier-three',
  TCL: 'emerging',
  LCO: 'tier-three',
  NACL: 'emerging',
  LCKC: 'emerging',
  'LCK CL': 'emerging',
  LAS: 'emerging',
  LFL: 'emerging',
  LFL2: 'emerging',
  NLC: 'emerging',
  NL: 'emerging',
  PRM: 'emerging',
  PRMP: 'emerging',
  'LVP SL': 'emerging',
  LES: 'emerging',
  LIT: 'emerging',
  RL: 'emerging',
  NEXO: 'emerging',
  CCWS: 'emerging',
  HC: 'emerging',
  IC: 'emerging',
  EM: 'emerging',
  'EMEA MASTERS': 'emerging',
  AL: 'emerging',
  HM: 'emerging',
  HW: 'emerging',
  HLL: 'emerging',
  EBL: 'emerging',
  LPLOL: 'emerging',
  CD: 'emerging',
  ROL: 'emerging',
  LRN: 'emerging',
  LRS: 'emerging',
  LTS: 'emerging',
  CT: 'emerging',
}

const emergingLeaguePatternRules = [
  { source: String.raw`\bacademy\b`, flags: 'i' },
  { source: String.raw`\bchallengers?\b`, flags: 'i' },
  { source: String.raw`\bdevelopment\b`, flags: 'i' },
  { source: String.raw`\bdivision\s*2\b`, flags: 'i' },
  { source: String.raw`\bd2\b`, flags: 'i' },
  { source: String.raw`\belite\b`, flags: 'i' },
  { source: String.raw`\bnational\b`, flags: 'i' },
  { source: String.raw`\bproving grounds\b`, flags: 'i' },
  { source: String.raw`\bsecondary\b`, flags: 'i' },
] as const

const emergingLeaguePatterns = emergingLeaguePatternRules.map((rule) => new RegExp(rule.source, rule.flags))

export const leagueConnectivityShrinkageMatches = 8

export const leagueEffectiveRatingCapsByTier: Partial<Record<LeagueTierName, number>> = {
  emerging: leagueTierDefinitions['tier-three'].priorRating,
  unknown: leagueTierDefinitions.unknown.priorRating,
}

export const leagueTierModelParameters = {
  leagueTierDefinitions,
  exactLeagueTiers,
  emergingLeaguePatternRules,
  leagueConnectivityShrinkageMatches,
  leagueEffectiveRatingCapsByTier,
} as const

export function leagueTierFor(league: string): LeagueTierDefinition {
  const normalized = normalizeLeagueName(league)
  if (!normalized || normalized === 'UNKNOWN') return leagueTierDefinitions.unknown
  const exactTier = exactLeagueTiers[normalized]
  if (exactTier) return leagueTierDefinitions[exactTier]
  if (emergingLeaguePatterns.some((pattern) => pattern.test(league))) return leagueTierDefinitions.emerging
  return leagueTierDefinitions.unknown
}

export function leaguePriorFor(league: string) {
  return leagueTierFor(league).priorRating
}

export function leagueConnectivity(internationalMatches: number) {
  return internationalMatches / (internationalMatches + leagueConnectivityShrinkageMatches)
}

export function effectiveLeagueRating(league: string, rawRating: number, internationalMatches: number) {
  const prior = leaguePriorFor(league)
  const connectivity = leagueConnectivity(internationalMatches)
  return cappedLeagueRatingForTier(league, prior + connectivity * (rawRating - prior))
}

export function cappedLeagueRatingForTier(league: string, rating: number) {
  const cap = leagueEffectiveRatingCapsByTier[leagueTierFor(league).tier]
  return cap === undefined ? rating : Math.min(rating, cap)
}

function normalizeLeagueName(league: string) {
  return league.trim().toUpperCase()
}
