import { currentTopTierRegionForLeague, isMajorRegionPowerRegion } from '../data/regionTaxonomy'
import type { MatchRecord, Region, TeamProfile } from '../types'
import {
  deservedStandingModelParameters,
  dssCausalInputsForMatches,
  dssGameWinProbability,
  dssRegionConnectivity,
  dssRegionInternationalResumePoints,
  dssRegionRawSeriesValue,
  dssRegionScore,
  dssRegionScoreRaw,
  dssRegionSeedPerformancePoints,
  dssRegionStagePoints,
  dssSeriesWinProbability,
  type DssSeriesLedgerEntry,
} from './deservedStanding'
import {
  buildDeservedStandingModel,
  type DeservedStandingModel,
  type DeservedStandingModelOptions,
  type DeservedStandingTeamSummary,
} from './deservedStandingModel'
import { isCompetitionOnlyLeague, isUnknownLeague } from './teamProfiles'
import {
  buildCausalPrefixSummary,
  causalInputRow,
  reconcileCausalPrefix,
  type CausalInputRow,
  type CausalPrefixSummary,
} from './causalRecompute'

export type DeservedStandingRegionSeedExpectationContext = {
  entry: DssSeriesLedgerEntry
  region: Region
  opponentRegion: Region
  seed?: number
  opponentSeed?: number
}

export type DeservedStandingRegionModelOptions = DeservedStandingModelOptions & {
  regionPriorFor?: (region: Region) => number
  teamRegionFor?: (team: string, entry: DssSeriesLedgerEntry) => Region
  seedExpectedSeriesResultFor?: (context: DeservedStandingRegionSeedExpectationContext) => number | undefined
  regionStagePointsFor?: (region: Region, entries: DeservedStandingRegionLedgerEntry[]) => number
  teamEligibleForDepth?: (team: DeservedStandingTeamSummary) => boolean
  includeInternationalRegion?: boolean
}

export type DeservedStandingRegionLedgerEntry = Pick<
  DssSeriesLedgerEntry,
  | 'seriesKey'
  | 'date'
  | 'event'
  | 'tier'
  | 'bestOf'
  | 'team'
  | 'opponent'
  | 'teamSeed'
  | 'opponentSeed'
  | 'gamesWon'
  | 'gamesLost'
  | 'observedSeriesResult'
  | 'observedGameWinRate'
  | 'expectedSeriesResult'
  | 'expectedGameWinRate'
  | 'opponentReferenceStrength'
  | 'seriesWeight'
> & {
  region: Region
  opponentRegion: Region
  rosterValidity: number
  regionRawSeriesValue: number
  regionWeightedSeriesValue: number
  seedExpectedSeriesResult?: number
  seedPerformanceValue?: number
  seedPerformanceWeightedValue?: number
}

export type DeservedStandingRegionRecord = {
  wins: number
  losses: number
}

export type DeservedStandingRegionSummary = {
  region: Region
  rank: number
  dss: number
  rawScore: number
  prior: number
  connectivity: number
  effectiveInternationalWeight: number
  internationalResumeRate: number
  internationalResumePoints: number
  seedPerformanceRate: number
  seedPerformancePoints: number
  stagePoints: number
  topEndScore: number
  depthScore: number
  topTeamDss: number
  internationalWins: number
  internationalLosses: number
  expectedInternationalWins: number
  internationalWinsAboveExpectation: number
  gameDifferentialAboveExpectation: number
  averageOpponentReferenceStrength?: number
  bo5Record: DeservedStandingRegionRecord
  recordVsMajorRegions: DeservedStandingRegionRecord
  recordVsMinorRegions: DeservedStandingRegionRecord
  topTeams: DeservedStandingTeamSummary[]
  ledgerEntries: DeservedStandingRegionLedgerEntry[]
}

export type DeservedStandingRegionModel = {
  regions: DeservedStandingRegionSummary[]
  ledgerEntries: DeservedStandingRegionLedgerEntry[]
  teamModel: DeservedStandingModel
}

const defaultRegionSeedReferenceStrengths: Record<Region, readonly number[]> = {
  LCK: [1660, 1625, 1590, 1555, 1525],
  LPL: [1655, 1620, 1585, 1550, 1520],
  LEC: [1585, 1550, 1515, 1480, 1450],
  LCS: [1545, 1510, 1475, 1445, 1415],
  LCP: [1535, 1505, 1475, 1445, 1415],
  VCS: [1495, 1465, 1435, 1405, 1375],
  PCS: [1485, 1455, 1425, 1395, 1365],
  CBLOL: [1465, 1435, 1405, 1375, 1345],
  International: [deservedStandingModelParameters.baseScore],
}

export function buildDeservedStandingRegionModel(
  matches: MatchRecord[],
  teams: Record<string, TeamProfile>,
  options: DeservedStandingRegionModelOptions = {},
): DeservedStandingRegionModel {
  const teamModel = buildDeservedStandingModel(matches, options)
  const ledgerEntries = teamModel.ledgerEntries
    .map((entry) => regionLedgerEntryFor(entry, teams, options))
    .filter((entry): entry is DeservedStandingRegionLedgerEntry => {
      if (!entry) return false
      if (!options.includeInternationalRegion && entry.region === 'International') return false
      return entry.region !== entry.opponentRegion
    })

  const entriesByRegion = groupBy(ledgerEntries, (entry) => entry.region)
  const teamSummariesByRegion = groupTeamsByRegion(teamModel.teams, teams, entriesByRegion, options)
  const regionNames = new Set<Region>([
    ...entriesByRegion.keys(),
    ...teamSummariesByRegion.keys(),
  ])

  const regions = Array.from(regionNames)
    .filter((region) => options.includeInternationalRegion || region !== 'International')
    .map((region) => regionSummaryFor(region, entriesByRegion.get(region) ?? [], teamSummariesByRegion.get(region) ?? [], options))
    .sort((left, right) => {
      return right.dss - left.dss
        || right.internationalWinsAboveExpectation - left.internationalWinsAboveExpectation
        || right.depthScore - left.depthScore
        || right.topTeamDss - left.topTeamDss
        || left.region.localeCompare(right.region)
    })
    .map((region, index) => ({ ...region, rank: index + 1 }))

  return {
    regions,
    ledgerEntries,
    teamModel,
  }
}

export function buildDssRegionCausalSummary({
  prefixMatches,
  teams,
  processedThroughUtcDate,
  contextInputs = [],
}: {
  prefixMatches: readonly MatchRecord[]
  teams: Record<string, TeamProfile>
  processedThroughUtcDate: string
  contextInputs?: readonly CausalInputRow[]
}) {
  return buildCausalPrefixSummary({
    surface: 'dss-region',
    processedThroughUtcDate,
    inputs: dssRegionCausalInputs(prefixMatches, teams, contextInputs),
  })
}

export function reconcileDssRegionCausality({
  summary,
  freshMatches,
  teams,
  contextInputs = [],
  availableProcessedThroughUtcDates = [],
}: {
  summary: CausalPrefixSummary
  freshMatches: readonly MatchRecord[]
  teams: Record<string, TeamProfile>
  contextInputs?: readonly CausalInputRow[]
  availableProcessedThroughUtcDates?: readonly string[]
}) {
  if (summary.surface !== 'dss-region') throw new Error('Expected dss-region causal summary')
  return reconcileCausalPrefix({
    summary,
    freshInputs: dssRegionCausalInputs(freshMatches, teams, contextInputs),
    availableProcessedThroughUtcDates,
  })
}

export function recomputeDssRegionCausalState(
  matches: MatchRecord[],
  teams: Record<string, TeamProfile>,
  options: DeservedStandingRegionModelOptions = {},
) {
  return buildDeservedStandingRegionModel(matches, teams, options)
}

function dssRegionCausalInputs(
  matches: readonly MatchRecord[],
  teams: Record<string, TeamProfile>,
  contextInputs: readonly CausalInputRow[],
) {
  const earliestMatchByTeam = new Map<string, string>()
  for (const match of matches) {
    for (const team of [match.teamA, match.teamB]) {
      const current = earliestMatchByTeam.get(team)
      if (!current || match.date < current) earliestMatchByTeam.set(team, match.date)
    }
  }
  const teamInputs = [...earliestMatchByTeam.entries()].map(([team, utcDate]) =>
    causalInputRow(`team-profile:${team}`, utcDate, teams[team] ?? null),
  )
  return [...dssCausalInputsForMatches(matches), ...teamInputs, ...contextInputs]
}

function regionLedgerEntryFor(
  entry: DssSeriesLedgerEntry,
  teams: Record<string, TeamProfile>,
  options: DeservedStandingRegionModelOptions,
): DeservedStandingRegionLedgerEntry | undefined {
  const region = normalizedRegionFor(entry.team, entry, teams, 'team', options)
  const opponentRegion = normalizedRegionFor(entry.opponent, entry, teams, 'opponent', options)
  if (!region || !opponentRegion) return undefined

  const rosterValidity = options.rosterValidityFor?.(entry) ?? 1
  const regionRawSeriesValue = dssRegionRawSeriesValue(entry)
  const regionWeightedSeriesValue = regionRawSeriesValue * entry.seriesWeight * rosterValidity
  const seedExpectedSeriesResult = seedExpectedSeriesResultFor({
    entry,
    region,
    opponentRegion,
    ...(entry.teamSeed === undefined ? {} : { seed: entry.teamSeed }),
    ...(entry.opponentSeed === undefined ? {} : { opponentSeed: entry.opponentSeed }),
  }, options)
  const seedPerformanceValue = seedExpectedSeriesResult === undefined
    ? undefined
    : entry.observedSeriesResult - seedExpectedSeriesResult
  const seedPerformanceWeightedValue = seedPerformanceValue === undefined
    ? undefined
    : seedPerformanceValue * entry.seriesWeight * rosterValidity

  return {
    seriesKey: entry.seriesKey,
    date: entry.date,
    event: entry.event,
    tier: entry.tier,
    bestOf: entry.bestOf,
    team: entry.team,
    opponent: entry.opponent,
    ...(entry.teamSeed === undefined ? {} : { teamSeed: entry.teamSeed }),
    ...(entry.opponentSeed === undefined ? {} : { opponentSeed: entry.opponentSeed }),
    gamesWon: entry.gamesWon,
    gamesLost: entry.gamesLost,
    observedSeriesResult: entry.observedSeriesResult,
    observedGameWinRate: entry.observedGameWinRate,
    expectedSeriesResult: entry.expectedSeriesResult,
    expectedGameWinRate: entry.expectedGameWinRate,
    opponentReferenceStrength: entry.opponentReferenceStrength,
    seriesWeight: entry.seriesWeight,
    region,
    opponentRegion,
    rosterValidity,
    regionRawSeriesValue,
    regionWeightedSeriesValue,
    ...(seedExpectedSeriesResult === undefined ? {} : { seedExpectedSeriesResult }),
    ...(seedPerformanceValue === undefined ? {} : { seedPerformanceValue }),
    ...(seedPerformanceWeightedValue === undefined ? {} : { seedPerformanceWeightedValue }),
  }
}

function seedExpectedSeriesResultFor(
  context: DeservedStandingRegionSeedExpectationContext,
  options: DeservedStandingRegionModelOptions,
) {
  const explicit = options.seedExpectedSeriesResultFor?.(context)
  if (explicit !== undefined) return explicit
  return defaultSeedExpectedSeriesResult(context)
}

function defaultSeedExpectedSeriesResult({
  entry,
  region,
  opponentRegion,
  seed,
  opponentSeed,
}: DeservedStandingRegionSeedExpectationContext) {
  if (seed === undefined || opponentSeed === undefined) return undefined
  const referenceStrength = defaultRegionSeedReferenceStrength(region, seed)
  const opponentReferenceStrength = defaultRegionSeedReferenceStrength(opponentRegion, opponentSeed)
  if (referenceStrength === undefined || opponentReferenceStrength === undefined) return undefined
  const gameWinProbability = dssGameWinProbability({ referenceStrength, opponentReferenceStrength })
  return dssSeriesWinProbability(gameWinProbability, entry.bestOf)
}

function defaultRegionSeedReferenceStrength(region: Region, seed: number) {
  if (!Number.isFinite(seed) || seed <= 0) return undefined
  const strengths = defaultRegionSeedReferenceStrengths[region]
  const index = Math.floor(seed) - 1
  const listed = strengths[index]
  if (listed !== undefined) return listed
  const last = strengths.at(-1) ?? deservedStandingModelParameters.baseScore
  return last - (index - strengths.length + 1) * 25
}

function regionSummaryFor(
  region: Region,
  entries: DeservedStandingRegionLedgerEntry[],
  teams: DeservedStandingTeamSummary[],
  options: DeservedStandingRegionModelOptions,
): DeservedStandingRegionSummary {
  const effectiveInternationalWeight = entries.reduce((sum, entry) => sum + entry.seriesWeight * entry.rosterValidity, 0)
  const weightedResume = entries.reduce((sum, entry) => sum + entry.regionWeightedSeriesValue, 0)
  const internationalResumeRate = effectiveInternationalWeight > 0 ? weightedResume / effectiveInternationalWeight : 0
  const connectivity = dssRegionConnectivity(effectiveInternationalWeight)
  const internationalResumePoints = dssRegionInternationalResumePoints(internationalResumeRate, connectivity)
  const seedWeightedValue = entries.reduce((sum, entry) => sum + (entry.seedPerformanceWeightedValue ?? 0), 0)
  const seedPerformanceRate = effectiveInternationalWeight > 0 ? seedWeightedValue / effectiveInternationalWeight : 0
  const seedPerformancePoints = dssRegionSeedPerformancePoints(seedPerformanceRate, connectivity)
  const stagePoints = dssRegionStagePoints(options.regionStagePointsFor?.(region, entries) ?? 0, internationalResumePoints)
  const topTeams = teams
    .filter(options.teamEligibleForDepth ?? defaultTeamEligibleForDepth)
    .slice()
    .sort((left, right) => right.dss - left.dss)
  const topEndScore = averageResidual(topTeams.slice(0, 2))
  const depthScore = averageResidual(topTeams.slice(0, 4))
  const prior = options.regionPriorFor?.(region) ?? deservedStandingModelParameters.baseScore
  const input = {
    internationalResumeRate,
    seedPerformanceRate,
    regionStagePoints: stagePoints,
    topEndScore,
    depthScore,
    connectivity,
    regionPrior: prior,
  }
  const rawScore = dssRegionScoreRaw(input)
  const dss = dssRegionScore(input)
  const internationalWins = entries.filter((entry) => entry.observedSeriesResult > 0.5).length
  const internationalLosses = entries.filter((entry) => entry.observedSeriesResult < 0.5).length
  const expectedInternationalWins = entries.reduce((sum, entry) => sum + entry.expectedSeriesResult, 0)
  const gameDifferentialAboveExpectation = entries.reduce((sum, entry) => sum + entry.observedGameWinRate - entry.expectedGameWinRate, 0)

  return {
    region,
    rank: 0,
    dss,
    rawScore,
    prior,
    connectivity,
    effectiveInternationalWeight,
    internationalResumeRate,
    internationalResumePoints,
    seedPerformanceRate,
    seedPerformancePoints,
    stagePoints,
    topEndScore,
    depthScore,
    topTeamDss: topTeams[0]?.dss ?? deservedStandingModelParameters.baseScore,
    internationalWins,
    internationalLosses,
    expectedInternationalWins,
    internationalWinsAboveExpectation: internationalWins - expectedInternationalWins,
    gameDifferentialAboveExpectation,
    averageOpponentReferenceStrength: weightedAverage(entries, (entry) => entry.opponentReferenceStrength, (entry) => entry.seriesWeight * entry.rosterValidity),
    bo5Record: recordFor(entries.filter((entry) => entry.bestOf >= 5)),
    recordVsMajorRegions: recordFor(entries.filter((entry) => isMajorRegion(entry.opponentRegion))),
    recordVsMinorRegions: recordFor(entries.filter((entry) => !isMajorRegion(entry.opponentRegion))),
    topTeams,
    ledgerEntries: entries,
  }
}

function normalizedRegionFor(
  team: string,
  entry: DssSeriesLedgerEntry,
  teams: Record<string, TeamProfile>,
  side: 'team' | 'opponent',
  options: DeservedStandingRegionModelOptions,
): Region | undefined {
  if (side === 'team') {
    const explicit = options.teamRegionFor?.(team, entry)
    if (explicit) return explicit
  }

  const profile = teams[team]
  const league = side === 'team' ? entry.teamLeague : entry.opponentLeague
  const region = side === 'team' ? entry.teamRegion : entry.opponentRegion
  if (profile && shouldPreferProfileRegion(league, region)) {
    return knownRegion(currentTopTierRegionForLeague(profile.league, profile.region))
  }
  return knownRegion(currentTopTierRegionForLeague(league ?? profile?.league, region ?? profile?.region))
}

function shouldPreferProfileRegion(league: string | undefined, region: Region | undefined) {
  if (!league || isUnknownLeague(league) || isCompetitionOnlyLeague(league)) return true
  return !region || region === 'International'
}

function groupTeamsByRegion(
  teamSummaries: DeservedStandingTeamSummary[],
  teams: Record<string, TeamProfile>,
  entriesByRegion: Map<Region, DeservedStandingRegionLedgerEntry[]>,
  options: DeservedStandingRegionModelOptions,
) {
  const regionByTeamFromEntries = new Map<string, Region>()
  for (const entries of entriesByRegion.values()) {
    for (const entry of entries) {
      regionByTeamFromEntries.set(entry.team, entry.region)
    }
  }

  const groups = new Map<Region, DeservedStandingTeamSummary[]>()
  for (const team of teamSummaries) {
    const profile = teams[team.team]
    const region = regionByTeamFromEntries.get(team.team)
      ?? knownRegion(currentTopTierRegionForLeague(profile?.league, profile?.region))
    if (!region) continue
    if (!options.includeInternationalRegion && region === 'International') continue
    const group = groups.get(region)
    if (group) group.push(team)
    else groups.set(region, [team])
  }

  return groups
}

function defaultTeamEligibleForDepth(team: DeservedStandingTeamSummary) {
  return team.seriesCount > 0
}

function averageResidual(teams: DeservedStandingTeamSummary[]) {
  if (teams.length === 0) return 0
  const base = deservedStandingModelParameters.baseScore
  return teams.reduce((sum, team) => sum + team.dss - base, 0) / teams.length
}

function recordFor(entries: DeservedStandingRegionLedgerEntry[]): DeservedStandingRegionRecord {
  return {
    wins: entries.filter((entry) => entry.observedSeriesResult > 0.5).length,
    losses: entries.filter((entry) => entry.observedSeriesResult < 0.5).length,
  }
}

function isMajorRegion(region: Region) {
  return isMajorRegionPowerRegion(region)
}

function knownRegion(region: string): Region | undefined {
  if (
    region === 'LCK'
    || region === 'LPL'
    || region === 'LEC'
    || region === 'LCS'
    || region === 'LCP'
    || region === 'CBLOL'
    || region === 'VCS'
    || region === 'PCS'
    || region === 'International'
  ) {
    return region
  }
  return undefined
}

function weightedAverage<T>(items: T[], value: (item: T) => number, weight: (item: T) => number) {
  let weightedTotal = 0
  let weightTotal = 0
  for (const item of items) {
    const itemWeight = Math.max(0, weight(item))
    if (itemWeight === 0) continue
    weightedTotal += value(item) * itemWeight
    weightTotal += itemWeight
  }
  return weightTotal > 0 ? weightedTotal / weightTotal : undefined
}

function groupBy<T, K extends string>(items: T[], keyFor: (item: T) => K) {
  const groups = new Map<K, T[]>()
  for (const item of items) {
    const key = keyFor(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  return groups
}
