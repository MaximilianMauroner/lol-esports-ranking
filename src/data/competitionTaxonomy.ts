import type { EventTier, LeagueTierName, Region } from '../types'

export type LeagueTierDefinition = {
  tier: LeagueTierName
  label: string
  priorRating: number
  description: string
  anchorEligible: boolean
}

export type CompetitionTierInput = {
  league: string
  event?: string
  phase?: string
  playoffs?: boolean
}

export type CompetitionHomeLeagueInput = {
  competitionLeague: string
  explicitHomeLeague?: string
  explicitLeague?: string
  identityLeague?: string
  unknownLeague?: string
}

export type CompetitionRegionInput = {
  explicitRegion?: string
  homeLeague?: string
  competitionLeague?: string
  identityRegion?: Region
  missingRegion?: Region
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

export const currentTopTierRegions = ['LCS', 'CBLOL', 'LEC', 'LCK', 'LPL', 'LCP'] as const

export const ratedTeamLeagues = currentTopTierRegions
export type RatedTeamLeague = typeof ratedTeamLeagues[number]
export const ratedTeamUniversePolicy = 'current-top-tier-domestic-league-only-v1'

export const ratedTeamUniverseModelParameters = {
  policy: ratedTeamUniversePolicy,
  ratedTeamLeagues,
  sideRule: 'A match enters the published rating run only when both sides resolve to a rated domestic home league.',
  teamRule: 'A team enters the published rating run only when its resolved league is one of the rated team leagues.',
} as const

export const majorRegionPowerRegions = currentTopTierRegions

export const apacDomesticFeederLeagues = ['PCS', 'VCS', 'LJL', 'LCO', 'LTS'] as const

export const currentRegionTaxonomyModelParameters = {
  source: 'Riot LoL Esports top-level region menu and LCP format update',
  sourceObservedAt: '2026-06-27',
  currentTopTierRegions,
  majorRegionPowerRegions,
  apacDomesticFeederLeagues,
  apacFlagshipRegion: 'LCP',
  policy: 'Region Power is limited to current international-participant top-tier regions. Domestic feeder and lower-tier ecosystems remain available for team scopes but are ignored for Region Power calculations unless they are part of the region power league layer.',
} as const

const currentTopTierRegionSet = new Set<string>(currentTopTierRegions)
const ratedTeamLeagueSet = new Set<string>(ratedTeamLeagues)
const majorRegionPowerRegionSet = new Set<string>(majorRegionPowerRegions)
const apacDomesticFeederLeagueSet = new Set<string>(apacDomesticFeederLeagues)
const apacDomesticFeederRegionSet = new Set<string>(['PCS', 'VCS'])

const emeaLeagueCodes = new Set(['AL', 'CCWS', 'CT', 'EBL', 'EM', 'HC', 'HLL', 'HM', 'HW', 'IC', 'LES', 'LFL2', 'LIT', 'LPLOL', 'NEXO', 'NL', 'PRMP', 'RL', 'ROL'])
const latamLeagueCodes = new Set(['CD', 'LRN', 'LRS'])
const apacLeagueCodes = new Set(['LTS'])

const knownRegions = new Set<Region>(['LCK', 'LPL', 'LEC', 'LCS', 'LCP', 'CBLOL', 'VCS', 'PCS', 'International'])

const leagueInferenceRules: { league: string; patterns: RegExp[] }[] = [
  { league: 'Worlds', patterns: [/\bworld championship\b/i, /\bworlds\b/i, /\bwlds?\b/i] },
  { league: 'MSI', patterns: [/\bmid-season invitational\b/i, /\bmsi\b/i] },
  { league: 'FST', patterns: [/\bfirst\s+stand\b/i, /\bfst\s+\d{4}\b/i] },
  { league: 'EWC', patterns: [/\besports\s+world\s+cup\b/i, /\bewc\s+\d{4}\b/i] },
  { league: 'Asia Master', patterns: [/\basia\s+masters?\b/i] },
  { league: 'KeSPA', patterns: [/\bkespa\b/i] },
  { league: 'DCup', patterns: [/\bdcup\b/i, /\bdemacia cup\b/i] },
  { league: 'EMEA Masters', patterns: [/\bemea masters\b/i, /\bem\s+\d{4}\b/i] },
  { league: 'LCK Academy', patterns: [/\blck\s+academy\b/i, /\blas\s+\d{4}\b/i] },
  { league: 'LCK CL', patterns: [/\blck\s*cl\b/i, /\blckc\b/i, /\blck\s+challengers?\b/i] },
  { league: 'LTA N', patterns: [/\blta\s+n(?:orth)?\b/i] },
  { league: 'LTA S', patterns: [/\blta\s+s(?:outh)?\b/i] },
  { league: 'NACL', patterns: [/\bnacl\b/i, /\bnorth american challengers league\b/i] },
  { league: 'LVP SL', patterns: [/\blvp\s+sl\b/i, /\bsuperliga(?:\s+domino's)?\b/i] },
  { league: 'PRM', patterns: [/\bprime league\b/i, /\bprm\b/i] },
  { league: 'LES', patterns: [/\bles\b/i, /\besports\s+series\s+madrid\b/i] },
  { league: 'LIT', patterns: [/\blit\b/i] },
  { league: 'EBL', patterns: [/\bebl\b/i, /\bbalkan\b/i] },
  { league: 'HLL', patterns: [/\bhll\b/i, /\bhellenic\s+legends\b/i] },
  { league: 'HC', patterns: [/\bhc\b/i, /\bhellenic\s+challengers?\s+cup\b/i] },
  { league: 'LPLOL', patterns: [/\blplol\b/i] },
  { league: 'RL', patterns: [/\brl\b/i, /\brift\s+legends\b/i] },
  { league: 'NEXO', patterns: [/\bnexo\b/i, /\bnexus\s+tour\b/i] },
  { league: 'NL', patterns: [/\bnexus\s+league\b/i, /\bnl\s+\d{4}\b/i] },
  { league: 'CCWS', patterns: [/\bccws\b/i, /\bcomedy\s+central\s+winter\s+snowdown\b/i] },
  { league: 'CT', patterns: [/\bcircuito\s+tormenta\b/i, /\bct\s+\d{4}\b/i] },
  { league: 'IC', patterns: [/\bic\s+\d{4}\b/i, /\biberian\s+cup\b/i] },
  { league: 'HW', patterns: [/\bhitpoint\s+winter\b/i, /\bhw\s+\d{4}\b/i] },
  { league: 'HM', patterns: [/\bhitpoint\b/i, /\bhm\s+\d{4}\b/i] },
  { league: 'AL', patterns: [/\barabian league\b/i, /\bal\s+\d{4}\b/i] },
  { league: 'ROL', patterns: [/\broad of legends\b/i, /\brol\s+\d{4}\b/i] },
  { league: 'CD', patterns: [/\bcircuito desafiante\b/i, /\bcd\s+\d{4}\b/i] },
  { league: 'LRN', patterns: [/\blrn\b/i, /\bliga\s+regional\s+norte\b/i] },
  { league: 'LRS', patterns: [/\blrs\b/i, /\bliga\s+regional\s+sur\b/i] },
  { league: 'LTS', patterns: [/\blts\b/i] },
  { league: 'LCK', patterns: [/\blck\b/i] },
  { league: 'LPL', patterns: [/\blpl\b/i] },
  { league: 'LEC', patterns: [/\blec\b/i] },
  { league: 'LCS', patterns: [/\blcs\b/i] },
  { league: 'LTA', patterns: [/\blta\b/i] },
  { league: 'LCP', patterns: [/\blcp\b/i] },
  { league: 'CBLOL', patterns: [/\bcblol\b/i] },
  { league: 'VCS', patterns: [/\bvcs\b/i] },
  { league: 'PCS', patterns: [/\bpcs\b/i] },
  { league: 'LLA', patterns: [/\blla\b/i] },
  { league: 'TCL', patterns: [/\btcl\b/i] },
  { league: 'LJL', patterns: [/\bljl\b/i] },
  { league: 'LCO', patterns: [/\blco\b/i] },
  { league: 'NLC', patterns: [/\bnlc\b/i] },
  { league: 'LFL2', patterns: [/\blfl2\b/i, /\blfl\s+division\s*2\b/i] },
  { league: 'LFL', patterns: [/\blfl\b/i] },
]

export const competitionTaxonomyModelParameters = {
  leagueTierModelParameters,
  currentRegionTaxonomyModelParameters,
  leagueInferenceRules,
} as const

export function inferLeagueFromEvent(event: string) {
  const explicitRegionalLeague = explicitRegionalLeagueFromEvent(event)
  if (explicitRegionalLeague) return explicitRegionalLeague
  return leagueInferenceRules.find((rule) => rule.patterns.some((pattern) => pattern.test(event)))?.league ?? 'Unknown'
}

export function inferEventTier(input: CompetitionTierInput): EventTier {
  const textValue = `${input.league} ${input.event ?? ''}`.toLowerCase()
  const playoffs = input.playoffs ?? input.phase === 'Playoffs'
  if (textValue.includes('road to msi') && !isInternationalCompetitionLeague(input.league)) return 'major-playoffs'
  if (textValue.includes('academic esports world tournament') || textValue.includes('university esports')) return 'qualifier'
  if (textValue.includes('online qualifier') || textValue.includes('online qualifiers')) return 'qualifier'
  if (/\bdcup\b/.test(textValue) || textValue.includes('demacia cup')) return playoffs ? 'major-playoffs' : 'regional-regular'
  if (textValue.includes('first stand') || /\bfst\b/.test(textValue)) return 'msi-bracket'
  if (textValue.includes('emea masters')
    || /\bem\b/.test(textValue)
    || textValue.includes('minor')
    || /\bewc\b/.test(textValue)
    || textValue.includes('esports world cup')
    || textValue.includes('asia master')
    || /\basi\b/.test(textValue)
    || /\bac\b/.test(textValue)
    || textValue.includes('kespa')) return 'minor-international'
  if (/\bwlds?\b/.test(textValue)) return playoffs ? 'worlds-playoffs' : 'worlds-main'
  if (textValue.includes('world') && playoffs) return 'worlds-playoffs'
  if (textValue.includes('world')) return 'worlds-main'
  if (textValue.includes('msi') && playoffs) return 'msi-bracket'
  if (textValue.includes('msi')) return 'msi-play-in'
  if (playoffs) return 'major-playoffs'
  return 'regional-regular'
}

export function eventTierRank(tier: EventTier) {
  const ranks: Record<EventTier, number> = {
    qualifier: 0,
    'regional-regular': 1,
    'major-playoffs': 2,
    'minor-international': 3,
    'msi-play-in': 4,
    'worlds-main': 5,
    'msi-bracket': 6,
    'worlds-playoffs': 7,
  }
  return ranks[tier]
}

export function resolveHomeLeagueForCompetition(input: CompetitionHomeLeagueInput) {
  const explicitHomeLeague = cleanLeagueValue(input.explicitHomeLeague)
  if (explicitHomeLeague) return explicitHomeLeague

  const explicitLeague = cleanLeagueValue(input.explicitLeague)
  if (explicitLeague) return explicitLeague

  const competitionLeague = cleanLeagueValue(input.competitionLeague) || input.unknownLeague
  if (!competitionLeague) return input.unknownLeague
  if (!isCompetitionOnlyLeague(competitionLeague)) return competitionLeague
  if (!shouldUseIdentityForCompetitionFallback(competitionLeague)) return input.unknownLeague
  return cleanLeagueValue(input.identityLeague) || input.unknownLeague
}

export function regionForCompetitionSide(input: CompetitionRegionInput): Region | undefined {
  if (input.explicitRegion && isKnownRegion(input.explicitRegion)) return input.explicitRegion
  if (input.homeLeague) {
    if (isUnknownLeague(input.homeLeague)) return 'International'
    if (!isCompetitionOnlyLeague(input.homeLeague)) return regionForLeague(input.homeLeague)
  }
  if (input.competitionLeague && shouldUseIdentityForCompetitionFallback(input.competitionLeague)) {
    return input.identityRegion ?? input.missingRegion
  }
  return input.missingRegion
}

export function shouldUseIdentityForCompetitionFallback(league: string) {
  return isCompetitionOnlyLeague(league) && normalizeLeagueName(league) !== 'LTA'
}

export function isKnownDomesticHomeLeague(league: string | undefined): league is string {
  return Boolean(league && !isUnknownLeague(league) && !isCompetitionOnlyLeague(league))
}

export function isCompetitionOnlyLeague(league: string) {
  const normalized = normalizeLeagueName(league)
  return normalized === 'MSI'
    || normalized === 'WORLDS'
    || normalized === 'WORLD'
    || normalized === 'WLD'
    || normalized === 'WLDS'
    || normalized === 'FST'
    || normalized === 'EWC'
    || normalized === 'ASI'
    || normalized === 'AC'
    || normalized === 'DCUP'
    || normalized === 'KESPA'
    || normalized === 'EM'
    || normalized === 'LTA'
    || normalized === 'EMEA MASTERS'
    || normalized.includes('WORLD CHAMPIONSHIP')
    || normalized.includes('MID-SEASON INVITATIONAL')
    || normalized.includes('FIRST STAND')
    || normalized.includes('ESPORTS WORLD CUP')
    || normalized.includes('ASIA MASTER')
    || normalized.includes('ASIA MASTERS')
}

export function isUnknownLeague(league: string) {
  return normalizeLeagueName(league) === 'UNKNOWN'
}

export function isKnownRegion(value: string): value is Region {
  return knownRegions.has(value as Region)
}

export function regionForLeague(league: string): Region {
  const normalized = normalizeLeagueName(league)
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

export function currentTopTierRegionForLeague(league: string | undefined, fallbackRegion: string | undefined) {
  const normalizedLeague = normalizeLeagueName(league ?? '')
  const normalizedRegion = normalizeLeagueName(fallbackRegion ?? '')
  if (apacDomesticFeederLeagueSet.has(normalizedLeague) || apacDomesticFeederRegionSet.has(normalizedRegion)) {
    return 'LCP' satisfies Region
  }
  return fallbackRegion ?? 'International'
}

export function isCurrentTopTierRegion(region: string | undefined): region is Region {
  return currentTopTierRegionSet.has(normalizeLeagueName(region ?? ''))
}

export function isRatedTeamLeague(league: string | undefined): league is RatedTeamLeague {
  return ratedTeamLeagueSet.has(normalizeLeagueName(league ?? ''))
}

export function isMajorRegionPowerRegion(region: string | undefined): region is Region {
  return majorRegionPowerRegionSet.has(normalizeLeagueName(region ?? ''))
}

export function formatCompetitionRegionLabel(region: string | undefined) {
  if (!region) return '—'
  const normalized = normalizeLeagueName(region)
  if (apacDomesticFeederRegionSet.has(normalized)) return `${region} domestic (LCP feeder)`
  return region
}

export function formatCompetitionLeagueLabel(league: string | undefined) {
  if (!league) return '—'
  const normalized = normalizeLeagueName(league)
  if (apacDomesticFeederLeagueSet.has(normalized)) return `${league} domestic (LCP feeder)`
  return league
}

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

export function leagueProfileScore(league: string) {
  const tier = leagueTierFor(league).tier
  if (tier === 'tier-one') return 5
  if (tier === 'tier-two') return 4
  if (tier === 'tier-three') return 3
  if (tier === 'emerging') return 2
  return 1
}

function cleanLeagueValue(value: string | undefined) {
  const cleaned = value?.trim()
  return cleaned || undefined
}

function normalizeLeagueName(league: string) {
  return league.trim().toUpperCase()
}

function explicitRegionalLeagueFromEvent(event: string) {
  const normalized = normalizeLeagueName(event)
  for (const league of Object.keys(exactLeagueTiers).sort((left, right) => right.length - left.length)) {
    if (isCompetitionOnlyLeague(league)) continue
    const pattern = new RegExp(`^${escapeRegExp(league)}(?:\\s+\\d{4}\\b|/|\\s*$|\\s+(?:Season|Split|Spring|Summer|Winter|Cup|Rounds|Lock-In|Versus)\\b)`)
    if (pattern.test(normalized)) return league
  }
  return undefined
}

function isInternationalCompetitionLeague(league: string) {
  const normalized = normalizeLeagueName(league)
  return ['MSI', 'WORLDS', 'WORLD', 'WLD', 'WLDS', 'FST', 'EWC'].includes(normalized)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
