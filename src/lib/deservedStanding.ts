import type {
  DeservedStandingSeriesResumeInput,
  DeservedStandingTeamComponents,
  DeservedStandingWeightedSeries,
  EventTier,
  MatchRecord,
  Region,
  Role,
} from '../types'
import {
  eventWeightContextForMatches,
  eventWeightMultiplierForMatch,
  type EventWeightContext,
} from './eventWeighting'
import { causalInputRow, type CausalInputRow } from './causalRecompute'
import type { NormalizedBestOf } from './matchFormat'
import { clamp } from './ratingCalculations'
import { resolveCanonicalSeries } from './seriesResolver'

export const deservedStandingModelParameters = {
  baseScore: 1500,
  resumeScale: 420,
  scheduleScale: 90,
  volumePrior: 120,
  teamUncertainty: {
    minimum: 30,
    maximum: 140,
    base: 30,
    currentEraWeightScale: 160,
    currentEraWeightMultiplier: 80,
    rosterValidityMultiplier: 20,
  },
  resumeWeights: {
    actual: 0.5,
    winsAboveExpectation: 0.35,
    gameDifferentialAboveExpectation: 0.15,
  },
  regionResumeWeights: {
    actual: 0.45,
    winsAboveExpectation: 0.4,
    gameDifferentialAboveExpectation: 0.15,
  },
  rosterValidityWeights: {
    retainedPlayerContributionShare: 0.75,
    retainedSynergy: 0.15,
    orgCoachContinuity: 0.1,
  },
  rosterValidityClamp: {
    minimum: 0.05,
    maximum: 1,
  },
  currentRosterValidityPenaltyThreshold: 0.65,
  instabilityPenaltyScale: 20,
  incomingPlayerBridgeCreditClamp: {
    minimum: -30,
    maximum: 30,
  },
  incomingPlayerBridgeWeightScale: 80,
  incomingPlayerAssetWeights: {
    skillOffset: 0.55,
    resumeOffset: 0.35,
    internationalTranslationOffset: 0.1,
  },
  integrationFactors: {
    sameRoleSameLeagueSameLanguage: 0.9,
    sameRoleSameRegion: 0.8,
    crossRegionImportSameRole: 0.7,
    emergencySubstitute: 0.55,
    offRolePlayer: 0.45,
  },
  stagePointEventCapShare: 0.15,
  stageAchievementPoints: {
    worlds: {
      qualified: 6,
      firstRound: 8,
      semifinal: 10,
      final: 14,
    },
    msi: {
      qualified: 5,
      firstRound: 7,
      semifinal: 9,
      final: 12,
    },
    majorRegion: {
      qualified: 3,
      firstRound: 5,
      semifinal: 6,
      final: 8,
    },
    minorInternational: {
      qualified: 3,
      firstRound: 4,
      semifinal: 5,
      final: 6,
    },
  },
  playerContributionShare: {
    zMultiplier: 0.35,
    minimumBeforeNormalization: 0.08,
    maximumBeforeNormalization: 0.35,
  },
  roleShares: {
    Top: 0.18,
    Jungle: 0.22,
    Mid: 0.23,
    Bot: 0.21,
    Support: 0.16,
  },
  eventWeights: {
    'worlds-playoffs': 36,
    'worlds-main': 28,
    'msi-bracket': 34,
    'msi-play-in': 24,
    'major-playoffs': 20,
    'regional-regular': 12,
    'minor-international': 18,
    qualifier: 8,
  },
  formatMultipliers: {
    bo1: 1,
    bo2: 1.05,
    bo3: 1.12,
    bo5: 1.25,
  },
  region: {
    resumeScale: 380,
    seedPerformanceScale: 90,
    connectivityPriorWeight: 160,
    topEndWeight: 0.6,
    depthWeight: 0.4,
    maximumDepthConnectivity: 0.75,
    stagePointEventCapShare: 0.2,
  },
} as const

export type DssStageCategory = keyof typeof deservedStandingModelParameters.stageAchievementPoints
export type DssStageAchievement = keyof typeof deservedStandingModelParameters.stageAchievementPoints[DssStageCategory]
export type DssIntegrationFactorKey = keyof typeof deservedStandingModelParameters.integrationFactors

export type PlayerContributionInput = {
  id: string
  role: Role
  performanceZ?: number
}

export type PlayerContributionShare = PlayerContributionInput & {
  share: number
}

export type TeamDssInput = {
  resumePoints: number
  scheduleStrengthPoints: number
  stagePoints?: number
  incomingPlayerBridgeCredit?: number
  instabilityPenalty?: number
  baseScore?: number
}

export type TeamDssComponentsInput = {
  series: DeservedStandingWeightedSeries[]
  stagePoints?: number
  incomingPlayerBridgeCredit?: number
  currentRosterValidity?: number
  uncertainty?: number
  baseScore?: number
}

export type WeightedSeriesFromLedgerOptions = {
  rosterValidity?: number
  standardOpponentReferenceStrength?: number
}

export type RegionDssInput = {
  internationalResumeRate: number
  seedPerformanceRate: number
  regionStagePoints: number
  topEndScore: number
  depthScore: number
  connectivity: number
  regionPrior: number
}

export type IncomingPlayerAssetInput = {
  playerSkillOffset: number
  playerResumeOffset: number
  internationalTranslationOffset: number
}

export type IncomingPlayerCreditInput = IncomingPlayerAssetInput & {
  role: Role
}

export type DssReferenceStrengthContext = {
  team: string
  opponent: string
  match: MatchRecord
}

export type DssSeriesLedgerOptions = {
  referenceStrengthFor?: (context: DssReferenceStrengthContext) => number
  contextAdjustmentFor?: (context: DssReferenceStrengthContext) => number
  eventWeightContext?: EventWeightContext
}

export function dssCausalInputsForMatches(
  matches: readonly MatchRecord[],
  contextInputs: readonly CausalInputRow[] = [],
) {
  return [
    ...matches.map((match) => causalInputRow(`match:${match.id}`, match.date, match)),
    ...contextInputs,
  ]
}

export type DssSeriesLedgerEntry = {
  seriesKey: string
  date: string
  event: string
  tier: EventTier
  bestOf: NormalizedBestOf
  finalMatchId: string
  team: string
  opponent: string
  teamLeague: string
  opponentLeague: string
  teamRegion: Region
  opponentRegion: Region
  teamSeed?: number
  opponentSeed?: number
  gamesWon: number
  gamesLost: number
  gamesPlayed: number
  observedSeriesResult: number
  observedGameWinRate: number
  expectedSeriesResult: number
  expectedGameWinRate: number
  referenceStrength: number
  opponentReferenceStrength: number
  contextAdjustment: number
  rawSeriesValue: number
  seriesWeight: number
  weightedSeriesValue: number
}

export function dssGameWinProbability({
  referenceStrength,
  opponentReferenceStrength,
  contextAdjustment = 0,
}: {
  referenceStrength: number
  opponentReferenceStrength: number
  contextAdjustment?: number
}) {
  return 1 / (1 + 10 ** ((opponentReferenceStrength - referenceStrength - contextAdjustment) / 400))
}

export function dssSeriesWinProbability(gameWinProbability: number, bestOf = 1) {
  const games = normalizeBestOf(bestOf)
  const neededWins = Math.floor(games / 2) + 1
  const p = clamp(gameWinProbability, 0, 1)
  let probability = 0

  for (let wins = neededWins; wins <= games; wins += 1) {
    probability += binomial(games, wins) * p ** wins * (1 - p) ** (games - wins)
  }

  return probability
}

export function dssExpectedSeriesResult(gameWinProbability: number, bestOf = 1) {
  const games = normalizeBestOf(bestOf)
  const p = clamp(gameWinProbability, 0, 1)
  if (games === 2) return p
  return dssSeriesWinProbability(p, games)
}

export function dssEventWeight(tier: EventTier) {
  return deservedStandingModelParameters.eventWeights[tier]
}

export function dssFormatMultiplier(bestOf: number) {
  const normalized = normalizeBestOf(bestOf)
  if (normalized >= 5) return deservedStandingModelParameters.formatMultipliers.bo5
  if (normalized >= 3) return deservedStandingModelParameters.formatMultipliers.bo3
  if (normalized === 2) return deservedStandingModelParameters.formatMultipliers.bo2
  return deservedStandingModelParameters.formatMultipliers.bo1
}

export function dssSeriesWeight(
  tier: EventTier,
  bestOf: number,
  match?: MatchRecord,
  eventWeightContext?: EventWeightContext,
) {
  const preseasonMultiplier = match ? eventWeightMultiplierForMatch(match, eventWeightContext) : 1
  return dssEventWeight(tier) * dssFormatMultiplier(bestOf) * preseasonMultiplier
}

export function dssRawSeriesValue(input: DeservedStandingSeriesResumeInput) {
  const weights = deservedStandingModelParameters.resumeWeights
  return weights.actual * (input.observedSeriesResult - 0.5)
    + weights.winsAboveExpectation * (input.observedSeriesResult - input.expectedSeriesResult)
    + weights.gameDifferentialAboveExpectation * (input.observedGameWinRate - input.expectedGameWinRate)
}

export function dssWeightedSeriesValue(input: DeservedStandingSeriesResumeInput & {
  eventTier: EventTier
  bestOf: number
  match?: MatchRecord
  eventWeightContext?: EventWeightContext
}) {
  return dssRawSeriesValue(input) * dssSeriesWeight(input.eventTier, input.bestOf, input.match, input.eventWeightContext)
}

export function dssRegionWeightedSeriesValue(input: DeservedStandingSeriesResumeInput & {
  eventTier: EventTier
  bestOf: number
  rosterValidity?: number
  match?: MatchRecord
  eventWeightContext?: EventWeightContext
}) {
  return dssRegionRawSeriesValue(input) * dssSeriesWeight(input.eventTier, input.bestOf, input.match, input.eventWeightContext) * (input.rosterValidity ?? 1)
}

export function dssSeriesLedgerEntriesForMatches(
  matches: MatchRecord[],
  options: DssSeriesLedgerOptions = {},
): DssSeriesLedgerEntry[] {
  const resolvedOptions = {
    ...options,
    eventWeightContext: options.eventWeightContext ?? eventWeightContextForMatches(matches),
  }
  const entries: DssSeriesLedgerEntry[] = []
  for (const group of dssSeriesGroupsForMatches(matches)) {
    entries.push(...dssSeriesLedgerEntriesForGroup(group, resolvedOptions))
  }
  return entries
}

export function dssWeightedSeriesFromLedgerEntry(
  entry: DssSeriesLedgerEntry,
  {
    rosterValidity = 1,
    standardOpponentReferenceStrength = deservedStandingModelParameters.baseScore,
  }: WeightedSeriesFromLedgerOptions = {},
): DeservedStandingWeightedSeries {
  return {
    weightedSeriesValue: entry.weightedSeriesValue,
    seriesWeight: entry.seriesWeight,
    rosterValidity,
    opponentReferenceStrength: entry.opponentReferenceStrength,
    standardOpponentReferenceStrength,
  }
}

export function dssRegionRawSeriesValue(input: DeservedStandingSeriesResumeInput) {
  const weights = deservedStandingModelParameters.regionResumeWeights
  return weights.actual * (input.observedSeriesResult - 0.5)
    + weights.winsAboveExpectation * (input.observedSeriesResult - input.expectedSeriesResult)
    + weights.gameDifferentialAboveExpectation * (input.observedGameWinRate - input.expectedGameWinRate)
}

export function dssRosterValidity({
  retainedPlayerContributionShare,
  retainedSynergy,
  orgCoachContinuity,
}: {
  retainedPlayerContributionShare: number
  retainedSynergy: number
  orgCoachContinuity: number
}) {
  const weights = deservedStandingModelParameters.rosterValidityWeights
  const raw = weights.retainedPlayerContributionShare * retainedPlayerContributionShare
    + weights.retainedSynergy * retainedSynergy
    + weights.orgCoachContinuity * orgCoachContinuity
  return clamp(
    raw,
    deservedStandingModelParameters.rosterValidityClamp.minimum,
    deservedStandingModelParameters.rosterValidityClamp.maximum,
  )
}

export function dssCurrentRosterResume(series: DeservedStandingWeightedSeries[]) {
  const numerator = series.reduce((sum, entry) => sum + entry.weightedSeriesValue * entry.rosterValidity, 0)
  const denominator = dssCurrentRosterWeight(series)
  const resumeRate = denominator > 0 ? numerator / denominator : 0
  const volumeReliability = dssVolumeReliability(denominator)

  return {
    numerator,
    denominator,
    resumeRate,
    volumeReliability,
    resumePoints: dssResumePoints(resumeRate, volumeReliability),
  }
}

export function dssCurrentRosterWeight(series: Pick<DeservedStandingWeightedSeries, 'seriesWeight' | 'rosterValidity'>[]) {
  return series.reduce((sum, entry) => sum + entry.seriesWeight * entry.rosterValidity, 0)
}

export function dssVolumeReliability(currentRosterWeight: number, volumePrior = deservedStandingModelParameters.volumePrior) {
  if (currentRosterWeight <= 0) return 0
  return Math.sqrt(currentRosterWeight / (currentRosterWeight + volumePrior))
}

export function dssResumePoints(resumeRate: number, volumeReliability: number) {
  return deservedStandingModelParameters.resumeScale * resumeRate * volumeReliability
}

export function dssScheduleStrength(series: DeservedStandingWeightedSeries[], volumeReliability: number) {
  const denominator = dssCurrentRosterWeight(series)
  const scheduleRate = denominator > 0
    ? series.reduce((sum, entry) => {
      const opponentTerm = (entry.opponentReferenceStrength - entry.standardOpponentReferenceStrength) / 400
      return sum + entry.seriesWeight * entry.rosterValidity * opponentTerm
    }, 0) / denominator
    : 0

  return {
    scheduleRate,
    scheduleStrengthPoints: deservedStandingModelParameters.scheduleScale * scheduleRate * volumeReliability,
  }
}

export function dssIncomingPlayerBridgeCredit(rawCredit: number, currentEraWeight: number, integrationFactor = 1) {
  const bridgeWeight = Math.exp(-Math.max(0, currentEraWeight) / deservedStandingModelParameters.incomingPlayerBridgeWeightScale)
  return clamp(
    rawCredit * integrationFactor * bridgeWeight,
    deservedStandingModelParameters.incomingPlayerBridgeCreditClamp.minimum,
    deservedStandingModelParameters.incomingPlayerBridgeCreditClamp.maximum,
  )
}

export function dssPlayerAsset({
  playerSkillOffset,
  playerResumeOffset,
  internationalTranslationOffset,
}: IncomingPlayerAssetInput) {
  const weights = deservedStandingModelParameters.incomingPlayerAssetWeights
  return weights.skillOffset * playerSkillOffset
    + weights.resumeOffset * playerResumeOffset
    + weights.internationalTranslationOffset * internationalTranslationOffset
}

export function dssIncomingCreditRaw(players: IncomingPlayerCreditInput[], newPairSynergyCredit = 0) {
  return players.reduce((sum, player) => {
    return sum + deservedStandingModelParameters.roleShares[player.role] * dssPlayerAsset(player)
  }, newPairSynergyCredit)
}

export function dssIntegrationFactor(key: DssIntegrationFactorKey) {
  return deservedStandingModelParameters.integrationFactors[key]
}

export function dssStageAchievementPoints({
  category,
  achievement,
  rosterValidity = 1,
  eventResumePoints,
}: {
  category: DssStageCategory
  achievement: DssStageAchievement
  rosterValidity?: number
  eventResumePoints?: number
}) {
  const raw = deservedStandingModelParameters.stageAchievementPoints[category][achievement] * rosterValidity
  return eventResumePoints === undefined
    ? raw
    : dssCappedStagePoints(raw, eventResumePoints, deservedStandingModelParameters.stagePointEventCapShare)
}

export function dssCappedStagePoints(rawStagePoints: number, resumePoints: number, capShare: number) {
  const cap = Math.abs(resumePoints) * capShare
  if (cap === 0) return 0
  return clamp(rawStagePoints, -cap, cap)
}

export function dssRegionStagePoints(rawRegionStagePoints: number, internationalResumePoints: number) {
  return dssCappedStagePoints(
    rawRegionStagePoints,
    internationalResumePoints,
    deservedStandingModelParameters.region.stagePointEventCapShare,
  )
}

export function dssInstabilityPenalty(currentRosterValidity: number) {
  return Math.max(
    0,
    deservedStandingModelParameters.currentRosterValidityPenaltyThreshold - currentRosterValidity,
  ) * deservedStandingModelParameters.instabilityPenaltyScale
}

export function dssTeamScore({
  resumePoints,
  scheduleStrengthPoints,
  stagePoints = 0,
  incomingPlayerBridgeCredit = 0,
  instabilityPenalty = 0,
  baseScore = deservedStandingModelParameters.baseScore,
}: TeamDssInput) {
  return baseScore
    + resumePoints
    + scheduleStrengthPoints
    + stagePoints
    + incomingPlayerBridgeCredit
    - instabilityPenalty
}

export function dssTeamComponentsFromSeries({
  series,
  stagePoints = 0,
  incomingPlayerBridgeCredit = 0,
  currentRosterValidity,
  uncertainty,
  baseScore = deservedStandingModelParameters.baseScore,
}: TeamDssComponentsInput): DeservedStandingTeamComponents {
  const resume = dssCurrentRosterResume(series)
  const schedule = dssScheduleStrength(series, resume.volumeReliability)
  const resolvedRosterValidity = currentRosterValidity ?? dssCurrentRosterValidity(series)
  const instabilityPenalty = dssInstabilityPenalty(resolvedRosterValidity)
  const dss = dssTeamScore({
    resumePoints: resume.resumePoints,
    scheduleStrengthPoints: schedule.scheduleStrengthPoints,
    stagePoints,
    incomingPlayerBridgeCredit,
    instabilityPenalty,
    baseScore,
  })

  return {
    baseScore,
    resumeRate: resume.resumeRate,
    volumeReliability: resume.volumeReliability,
    resumePoints: resume.resumePoints,
    scheduleRate: schedule.scheduleRate,
    scheduleStrengthPoints: schedule.scheduleStrengthPoints,
    stagePoints,
    incomingPlayerBridgeCredit,
    instabilityPenalty,
    dss,
    ...(uncertainty === undefined ? {} : { conservativeDss: dssConservativeScore(dss, uncertainty) }),
  }
}

export function dssCurrentRosterValidity(series: Pick<DeservedStandingWeightedSeries, 'seriesWeight' | 'rosterValidity'>[]) {
  const totalWeight = series.reduce((sum, entry) => sum + entry.seriesWeight, 0)
  if (totalWeight <= 0) return 0
  return series.reduce((sum, entry) => sum + entry.seriesWeight * entry.rosterValidity, 0) / totalWeight
}

export function dssTeamUncertainty({
  currentEraWeight,
  currentRosterValidity,
  inactivityPenalty = 0,
  substitutePenalty = 0,
}: {
  currentEraWeight: number
  currentRosterValidity: number
  inactivityPenalty?: number
  substitutePenalty?: number
}) {
  const config = deservedStandingModelParameters.teamUncertainty
  const raw = config.base
    + config.currentEraWeightMultiplier * Math.exp(-Math.max(0, currentEraWeight) / config.currentEraWeightScale)
    + config.rosterValidityMultiplier * (1 - currentRosterValidity)
    + inactivityPenalty
    + substitutePenalty
  return clamp(raw, config.minimum, config.maximum)
}

export function dssInactivityPenalty(daysSinceLastMatch: number) {
  if (daysSinceLastMatch <= 30) return 0
  if (daysSinceLastMatch <= 60) return 5
  if (daysSinceLastMatch <= 90) return 10
  return 20
}

export function dssConservativeScore(teamDss: number, uncertainty: number) {
  return teamDss - 0.35 * uncertainty
}

export function dssPlayerContributionShares(players: PlayerContributionInput[]): PlayerContributionShare[] {
  if (players.length === 0) return []

  const config = deservedStandingModelParameters.playerContributionShare
  const clamped = players.map((player) => {
    const baseShare = deservedStandingModelParameters.roleShares[player.role]
    const performanceZ = player.performanceZ ?? 0
    return {
      player,
      value: clamp(
        baseShare * Math.exp(config.zMultiplier * performanceZ),
        config.minimumBeforeNormalization,
        config.maximumBeforeNormalization,
      ),
    }
  })
  const total = clamped.reduce((sum, entry) => sum + entry.value, 0)

  return clamped.map(({ player, value }) => ({
    ...player,
    share: total > 0 ? value / total : 1 / players.length,
  }))
}

export function dssRegionConnectivity(effectiveInternationalWeight: number) {
  if (effectiveInternationalWeight <= 0) return 0
  return effectiveInternationalWeight / (
    effectiveInternationalWeight + deservedStandingModelParameters.region.connectivityPriorWeight
  )
}

export function dssRegionInternationalResumePoints(internationalResumeRate: number, connectivity: number) {
  return deservedStandingModelParameters.region.resumeScale * internationalResumeRate * connectivity
}

export function dssRegionSeedPerformancePoints(seedPerformanceRate: number, connectivity: number) {
  return deservedStandingModelParameters.region.seedPerformanceScale * seedPerformanceRate * connectivity
}

export function dssEffectiveRegionDepthTerm({
  topEndScore,
  depthScore,
  connectivity,
}: Pick<RegionDssInput, 'topEndScore' | 'depthScore' | 'connectivity'>) {
  const regionConfig = deservedStandingModelParameters.region
  const currentDepthTerm = regionConfig.topEndWeight * topEndScore + regionConfig.depthWeight * depthScore
  return currentDepthTerm * Math.min(connectivity, regionConfig.maximumDepthConnectivity)
}

export function dssRegionScoreRaw(input: RegionDssInput) {
  return deservedStandingModelParameters.baseScore
    + dssRegionInternationalResumePoints(input.internationalResumeRate, input.connectivity)
    + dssRegionSeedPerformancePoints(input.seedPerformanceRate, input.connectivity)
    + input.regionStagePoints
    + dssEffectiveRegionDepthTerm(input)
}

export function dssRegionScore(input: RegionDssInput) {
  const raw = dssRegionScoreRaw(input)
  return input.connectivity * raw + (1 - input.connectivity) * input.regionPrior
}

function normalizeBestOf(bestOf: number) {
  if (!Number.isFinite(bestOf)) return 1
  return Math.max(1, Math.floor(bestOf))
}

type DssSeriesGroup = {
  seriesKey: string
  matches: MatchRecord[]
  finalMatch: MatchRecord
  teamA: string
  teamB: string
  winsA: number
  winsB: number
  gamesPlayed: number
  bestOf: NormalizedBestOf
  observedSeriesResultA: number
}

function dssSeriesLedgerEntriesForGroup(
  group: DssSeriesGroup,
  options: DssSeriesLedgerOptions,
): [DssSeriesLedgerEntry, DssSeriesLedgerEntry] {
  const referenceStrengthA = referenceStrengthFor({
    team: group.teamA,
    opponent: group.teamB,
    match: group.finalMatch,
  }, options)
  const referenceStrengthB = referenceStrengthFor({
    team: group.teamB,
    opponent: group.teamA,
    match: group.finalMatch,
  }, options)
  const contextAdjustmentA = contextAdjustmentFor({
    team: group.teamA,
    opponent: group.teamB,
    match: group.finalMatch,
  }, options)
  const contextAdjustmentB = contextAdjustmentFor({
    team: group.teamB,
    opponent: group.teamA,
    match: group.finalMatch,
  }, options)
  const gameProbabilityA = dssGameWinProbability({
    referenceStrength: referenceStrengthA,
    opponentReferenceStrength: referenceStrengthB,
    contextAdjustment: contextAdjustmentA - contextAdjustmentB,
  })
  const expectedSeriesResultA = dssExpectedSeriesResult(gameProbabilityA, group.bestOf)
  const expectedSeriesResultB = dssExpectedSeriesResult(1 - gameProbabilityA, group.bestOf)
  const seriesWeight = dssSeriesWeight(group.finalMatch.tier, group.bestOf, group.finalMatch, options.eventWeightContext)
  const contextA = matchContextForTeam(group.finalMatch, group.teamA)
  const contextB = matchContextForTeam(group.finalMatch, group.teamB)

  return [
    dssSeriesLedgerEntry({
      group,
      team: group.teamA,
      opponent: group.teamB,
      teamLeague: contextA.league,
      opponentLeague: contextB.league,
      teamRegion: contextA.region,
      opponentRegion: contextB.region,
      teamSeed: contextA.seed,
      opponentSeed: contextB.seed,
      gamesWon: group.winsA,
      gamesLost: group.winsB,
      observedSeriesResult: group.observedSeriesResultA,
      expectedSeriesResult: expectedSeriesResultA,
      expectedGameWinRate: gameProbabilityA,
      referenceStrength: referenceStrengthA,
      opponentReferenceStrength: referenceStrengthB,
      contextAdjustment: contextAdjustmentA - contextAdjustmentB,
      seriesWeight,
    }),
    dssSeriesLedgerEntry({
      group,
      team: group.teamB,
      opponent: group.teamA,
      teamLeague: contextB.league,
      opponentLeague: contextA.league,
      teamRegion: contextB.region,
      opponentRegion: contextA.region,
      teamSeed: contextB.seed,
      opponentSeed: contextA.seed,
      gamesWon: group.winsB,
      gamesLost: group.winsA,
      observedSeriesResult: 1 - group.observedSeriesResultA,
      expectedSeriesResult: expectedSeriesResultB,
      expectedGameWinRate: 1 - gameProbabilityA,
      referenceStrength: referenceStrengthB,
      opponentReferenceStrength: referenceStrengthA,
      contextAdjustment: contextAdjustmentB - contextAdjustmentA,
      seriesWeight,
    }),
  ]
}

function dssSeriesLedgerEntry({
  group,
  team,
  opponent,
  teamLeague,
  opponentLeague,
  teamRegion,
  opponentRegion,
  teamSeed,
  opponentSeed,
  gamesWon,
  gamesLost,
  observedSeriesResult,
  expectedSeriesResult,
  expectedGameWinRate,
  referenceStrength,
  opponentReferenceStrength,
  contextAdjustment,
  seriesWeight,
}: {
  group: DssSeriesGroup
  team: string
  opponent: string
  teamLeague: string
  opponentLeague: string
  teamRegion: Region
  opponentRegion: Region
  teamSeed?: number
  opponentSeed?: number
  gamesWon: number
  gamesLost: number
  observedSeriesResult: number
  expectedSeriesResult: number
  expectedGameWinRate: number
  referenceStrength: number
  opponentReferenceStrength: number
  contextAdjustment: number
  seriesWeight: number
}): DssSeriesLedgerEntry {
  const observedGameWinRate = group.gamesPlayed > 0 ? gamesWon / group.gamesPlayed : 0
  const rawSeriesValue = dssRawSeriesValue({
    observedSeriesResult,
    observedGameWinRate,
    expectedSeriesResult,
    expectedGameWinRate,
  })

  return {
    seriesKey: group.seriesKey,
    date: group.finalMatch.date,
    event: group.finalMatch.event,
    tier: group.finalMatch.tier,
    bestOf: group.bestOf,
    finalMatchId: group.finalMatch.id,
    team,
    opponent,
    teamLeague,
    opponentLeague,
    teamRegion,
    opponentRegion,
    ...(teamSeed === undefined ? {} : { teamSeed }),
    ...(opponentSeed === undefined ? {} : { opponentSeed }),
    gamesWon,
    gamesLost,
    gamesPlayed: group.gamesPlayed,
    observedSeriesResult,
    observedGameWinRate,
    expectedSeriesResult,
    expectedGameWinRate,
    referenceStrength,
    opponentReferenceStrength,
    contextAdjustment,
    rawSeriesValue,
    seriesWeight,
    weightedSeriesValue: rawSeriesValue * seriesWeight,
  }
}

function dssSeriesGroupsForMatches(matches: MatchRecord[]): DssSeriesGroup[] {
  return resolveCanonicalSeries(matches)
    .filter((series) => series.state === 'completed')
    .map((series) => ({
      seriesKey: series.id,
      matches: series.games,
      finalMatch: series.finalMatch,
      teamA: series.teamA,
      teamB: series.teamB,
      winsA: series.winsA,
      winsB: series.winsB,
      gamesPlayed: series.games.length,
      bestOf: series.format,
      observedSeriesResultA: series.outcomeA,
    }))
}

function referenceStrengthFor(context: DssReferenceStrengthContext, options: DssSeriesLedgerOptions) {
  return options.referenceStrengthFor?.(context) ?? deservedStandingModelParameters.baseScore
}

function contextAdjustmentFor(context: DssReferenceStrengthContext, options: DssSeriesLedgerOptions) {
  return options.contextAdjustmentFor?.(context) ?? 0
}

function matchContextForTeam(match: MatchRecord, team: string) {
  const isTeamA = match.teamA === team
  return {
    league: (isTeamA ? match.teamAHomeLeague : match.teamBHomeLeague) ?? match.league,
    region: (isTeamA ? match.teamARegion : match.teamBRegion) ?? match.region,
    seed: isTeamA ? match.teamASeed : match.teamBSeed,
  }
}

function binomial(n: number, k: number) {
  let coefficient = 1
  for (let index = 1; index <= k; index += 1) {
    coefficient = (coefficient * (n + 1 - index)) / index
  }
  return coefficient
}
