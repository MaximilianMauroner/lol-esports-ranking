import type { DeservedStandingRosterEra, MatchRecord, MatchRosterSnapshot, Role, Side } from '../types'
import { clamp } from './ratingCalculations'
import {
  buildCausalContextIdentity,
  buildCausalPrefixSummary,
  causalInputRow,
  reconcileCausalPrefix,
  type CausalInputRow,
  type CausalPrefixSummary,
} from './causalRecompute'

export const dssRosterEraModelParameters = {
  retainedSynergyWeights: {
    jungleMid: 0.35,
    botDuo: 0.3,
    topJungle: 0.15,
    shotcaller: 0.1,
    coachSystem: 0.1,
  },
  orgCoachContinuityWeights: {
    organizationSlot: 0.6,
    headCoach: 0.4,
  },
  rosterCarryoverWeights: {
    orgCoachContinuity: 0.2,
    retainedPlayerContributionShare: 0.5,
    retainedSynergy: 0.2,
    roleCriticalContinuity: 0.1,
  },
  roleCriticalContinuityWeights: {
    jungleMid: 0.4,
    botDuo: 0.3,
    topJungle: 0.15,
    shotcaller: 0.15,
  },
  unknownShotcallerProxyWeights: {
    support: 0.1,
    jungle: 0.05,
  },
  substituteEraThreshold: {
    seriesCount: 3,
    splitGameShare: 0.2,
  },
  patchSimilarity: {
    none: 1,
    moderate: 0.85,
    major: 0.7,
    preseason: 0.55,
  },
  seasonCarryover: {
    teamResume: 0.25,
    playerResume: 0.4,
    playerSkillPrior: 0.6,
    leagueTranslation: 0.8,
    regionResume: 0.35,
    regionTranslationPrior: 0.75,
  },
  splitCarryover: {
    teamResume: 0.55,
    playerResume: 0.65,
    playerSkillPrior: 0.75,
    leagueTranslation: 0.9,
    regionResume: 0.7,
  },
} as const

export type RosterContributionShare = {
  playerId: string
  role: Role
  share: number
}

export type RosterSynergyInput = {
  previousRoster?: MatchRosterSnapshot
  currentRoster?: MatchRosterSnapshot
  previousCoachId?: string
  currentCoachId?: string
  shotcallerId?: string
}

export type OrgCoachContinuityInput = {
  sameOrganizationSlot: boolean
  previousCoachId?: string
  currentCoachId?: string
}

export type SubstituteEraInput = {
  seriesCount?: number
  splitGameShare?: number
  permanent?: boolean
}

export type PatchSimilarityKind = keyof typeof dssRosterEraModelParameters.patchSimilarity

export type DssRosterEraMatchContext = {
  match: MatchRecord
  team: string
  side: Side
}

export type DssRosterEraObservation = {
  team: string
  matchId: string
  date: string
  roster: MatchRosterSnapshot
  coachId?: string
  resumeLedger: string[]
  playerContributionLedger: string[]
  synergyLedger: string[]
}

export type BuildDssRosterErasOptions = {
  includePartialRosters?: boolean
  coachIdFor?: (context: DssRosterEraMatchContext) => string | undefined
  resumeLedgerIdsFor?: (observation: DssRosterEraObservation) => string[]
  playerContributionLedgerIdsFor?: (observation: DssRosterEraObservation) => string[]
  synergyLedgerIdsFor?: (observation: DssRosterEraObservation) => string[]
  uncertaintyFor?: (era: Omit<DeservedStandingRosterEra, 'uncertainty'>) => number
}

export function dssRetainedPlayerContributionShare(
  priorShares: RosterContributionShare[],
  currentRoster?: MatchRosterSnapshot,
) {
  if (!currentRoster || currentRoster.completeness !== 'complete-five-role') return 0
  const currentPlayerIds = new Set(currentRoster.players.map((player) => player.id))
  return priorShares.reduce((sum, player) => sum + (currentPlayerIds.has(player.playerId) ? player.share : 0), 0)
}

export function dssRetainedSynergy({
  previousRoster,
  currentRoster,
  previousCoachId,
  currentCoachId,
  shotcallerId,
}: RosterSynergyInput) {
  if (!previousRoster || !currentRoster) return 0
  if (previousRoster.completeness !== 'complete-five-role' || currentRoster.completeness !== 'complete-five-role') {
    return retainedPlayerCountShare(previousRoster, currentRoster)
  }
  if (!shotcallerId) return retainedPlayerCountShare(previousRoster, currentRoster)

  const weights = dssRosterEraModelParameters.retainedSynergyWeights
  const retained = retainedRolePairs(previousRoster, currentRoster)
  const shotcallerRetained = retainedPlayerIds(previousRoster, currentRoster).has(shotcallerId)
  const coachSystemRetained = previousCoachId && currentCoachId ? previousCoachId === currentCoachId : previousRoster.teamId === currentRoster.teamId

  return weights.jungleMid * Number(retained.jungleMid)
    + weights.botDuo * Number(retained.botDuo)
    + weights.topJungle * Number(retained.topJungle)
    + weights.shotcaller * retainedNumeric(shotcallerRetained)
    + weights.coachSystem * Number(coachSystemRetained)
}

export function dssOrgCoachContinuity({
  sameOrganizationSlot,
  previousCoachId,
  currentCoachId,
}: OrgCoachContinuityInput) {
  const weights = dssRosterEraModelParameters.orgCoachContinuityWeights
  if (!previousCoachId || !currentCoachId) return Number(sameOrganizationSlot)
  return weights.organizationSlot * Number(sameOrganizationSlot)
    + weights.headCoach * Number(previousCoachId === currentCoachId)
}

export function dssRoleCriticalContinuity(input: RosterSynergyInput) {
  const { previousRoster, currentRoster, shotcallerId } = input
  if (!previousRoster || !currentRoster) return 0

  const retained = retainedRolePairs(previousRoster, currentRoster)
  const weights = dssRosterEraModelParameters.roleCriticalContinuityWeights
  const knownShotcallerContribution = shotcallerId
    ? weights.shotcaller * Number(retainedPlayerIds(previousRoster, currentRoster).has(shotcallerId))
    : unknownShotcallerProxy(previousRoster, currentRoster)

  return weights.jungleMid * Number(retained.jungleMid)
    + weights.botDuo * Number(retained.botDuo)
    + weights.topJungle * Number(retained.topJungle)
    + knownShotcallerContribution
}

export function dssRosterCarryover({
  orgCoachContinuity,
  retainedPlayerContributionShare,
  retainedSynergy,
  roleCriticalContinuity,
}: {
  orgCoachContinuity: number
  retainedPlayerContributionShare: number
  retainedSynergy: number
  roleCriticalContinuity: number
}) {
  const weights = dssRosterEraModelParameters.rosterCarryoverWeights
  return weights.orgCoachContinuity * orgCoachContinuity
    + weights.retainedPlayerContributionShare * retainedPlayerContributionShare
    + weights.retainedSynergy * retainedSynergy
    + weights.roleCriticalContinuity * roleCriticalContinuity
}

export function dssSubstituteCreatesRosterEra({
  seriesCount = 0,
  splitGameShare = 0,
  permanent = false,
}: SubstituteEraInput) {
  const threshold = dssRosterEraModelParameters.substituteEraThreshold
  return permanent || seriesCount >= threshold.seriesCount || splitGameShare >= threshold.splitGameShare
}

export function dssPatchSimilarity(kind: PatchSimilarityKind = 'none') {
  return dssRosterEraModelParameters.patchSimilarity[kind]
}

export function dssPatchAdjustedRosterValidity(rosterValidity: number, kind: PatchSimilarityKind = 'none') {
  return clamp(rosterValidity * dssPatchSimilarity(kind), 0, 1)
}

export function dssRosterEraObservationsForMatches(
  matches: MatchRecord[],
  options: BuildDssRosterErasOptions = {},
): DssRosterEraObservation[] {
  const observations: DssRosterEraObservation[] = []
  for (const match of matches.toSorted(compareMatchesByDateAndId)) {
    addRosterEraObservation(observations, match, 'blue', match.teamA, match.teamARoster, options)
    addRosterEraObservation(observations, match, 'red', match.teamB, match.teamBRoster, options)
  }
  return observations
}

export function buildDssRosterEras(
  matches: MatchRecord[],
  options: BuildDssRosterErasOptions = {},
): DeservedStandingRosterEra[] {
  const observations = dssRosterEraObservationsForMatches(matches, options)
  const observationsByTeam = groupBy(observations, (observation) => observation.team)
  const eras: DeservedStandingRosterEra[] = []

  for (const teamObservations of observationsByTeam.values()) {
    let currentEra: DeservedStandingRosterEra | undefined
    let currentSignature: string | undefined

    for (const observation of teamObservations) {
      const signature = dssRosterEraSignature(observation.roster, observation.coachId)
      if (!currentEra || signature !== currentSignature) {
        if (currentEra) currentEra.endDate = observation.date
        currentEra = createRosterEra(observation, options)
        currentSignature = signature
        eras.push(currentEra)
      } else {
        currentEra.matches.push(observation.matchId)
        currentEra.resumeLedger.push(...observation.resumeLedger)
        currentEra.playerContributionLedger.push(...observation.playerContributionLedger)
        currentEra.synergyLedger.push(...observation.synergyLedger)
      }
    }
  }

  return eras.map((era) => ({
    ...era,
    uncertainty: options.uncertaintyFor?.(eraWithoutUncertainty(era)) ?? era.uncertainty,
  }))
}

export type DssRosterEraCausalSummary = {
  prefix: CausalPrefixSummary
  openEras: { team: string; startDate: string; signature: string }[]
}

export type DssRosterEraCallbackSemanticIds = Partial<Record<
  | 'coachIdFor'
  | 'resumeLedgerIdsFor'
  | 'playerContributionLedgerIdsFor'
  | 'synergyLedgerIdsFor'
  | 'uncertaintyFor',
  string
>>

export type DssRosterEraCausalContext = {
  options: BuildDssRosterErasOptions
  callbackSemanticIds: DssRosterEraCallbackSemanticIds
}

export function buildDssRosterEraCausalSummary({
  prefixMatches,
  processedThroughUtcDate,
  causalContext,
  contextInputs = [],
}: {
  prefixMatches: MatchRecord[]
  processedThroughUtcDate: string
  causalContext: DssRosterEraCausalContext
  contextInputs?: readonly CausalInputRow[]
}): DssRosterEraCausalSummary {
  const { options } = causalContext
  const contextIdentity = dssRosterEraContextIdentity(causalContext)
  if (!contextIdentity) throw new Error('Roster-era callback semantic ids are incomplete')
  const eras = buildDssRosterEras(prefixMatches, options)
  return {
    prefix: buildCausalPrefixSummary({
      surface: 'roster-era',
      processedThroughUtcDate,
      inputs: rosterEraCausalInputs(prefixMatches, contextInputs),
      contextIdentity,
    }),
    openEras: eras
      .filter((era) => era.endDate === undefined)
      .map((era) => ({
        team: era.team,
        startDate: era.startDate,
        signature: dssRosterEraSignature(era.roster, era.coachId),
      }))
      .sort((left, right) => compareCodeUnits(left.team, right.team)),
  }
}

export function reconcileDssRosterEraCausality({
  summary,
  freshMatches,
  causalContext,
  contextInputs = [],
  availableProcessedThroughUtcDates = [],
}: {
  summary: DssRosterEraCausalSummary
  freshMatches: MatchRecord[]
  causalContext?: DssRosterEraCausalContext
  contextInputs?: readonly CausalInputRow[]
  availableProcessedThroughUtcDates?: readonly string[]
}) {
  const appendedTeams = new Set(
    freshMatches
      .filter((match) => match.date > summary.prefix.processedThroughUtcDate)
      .flatMap((match) => [match.teamA, match.teamB]),
  )
  const openEraBoundary = summary.openEras
    .filter((era) => appendedTeams.has(era.team))
    .map((era) => era.startDate)
    .sort(compareCodeUnits)[0]
  return reconcileCausalPrefix({
    summary: summary.prefix,
    freshInputs: rosterEraCausalInputs(freshMatches, contextInputs),
    freshContextIdentity: causalContext
      ? dssRosterEraContextIdentity(causalContext)
      : undefined,
    availableProcessedThroughUtcDates,
    earliestRecomputeUtcDate: openEraBoundary,
  })
}

function dssRosterEraContextIdentity({
  options,
  callbackSemanticIds,
}: DssRosterEraCausalContext) {
  return buildCausalContextIdentity({
    semanticId: 'dss-roster-era-context-v1',
    serializableInputs: {
      modelParameters: dssRosterEraModelParameters,
      includePartialRosters: options.includePartialRosters ?? false,
      defaultPolicies: 'dss-roster-era-defaults-v1',
    },
    callbacks: [
      rosterCallbackBinding('coachIdFor', options.coachIdFor, callbackSemanticIds),
      rosterCallbackBinding('resumeLedgerIdsFor', options.resumeLedgerIdsFor, callbackSemanticIds),
      rosterCallbackBinding('playerContributionLedgerIdsFor', options.playerContributionLedgerIdsFor, callbackSemanticIds),
      rosterCallbackBinding('synergyLedgerIdsFor', options.synergyLedgerIdsFor, callbackSemanticIds),
      rosterCallbackBinding('uncertaintyFor', options.uncertaintyFor, callbackSemanticIds),
    ],
  })
}

function rosterCallbackBinding(
  name: keyof DssRosterEraCallbackSemanticIds,
  implementation: unknown,
  semanticIds: DssRosterEraCallbackSemanticIds,
) {
  return { name, implementation, semanticId: semanticIds[name] }
}

export function recomputeDssRosterEraCausalState(
  matches: MatchRecord[],
  { options }: DssRosterEraCausalContext,
) {
  return buildDssRosterEras(matches, options)
}

function rosterEraCausalInputs(
  matches: readonly MatchRecord[],
  contextInputs: readonly CausalInputRow[],
) {
  return [
    ...matches
      .filter((match) => match.teamARoster || match.teamBRoster)
      .map((match) => causalInputRow(`match:${match.id}`, match.date, match)),
    ...contextInputs,
  ]
}

function compareCodeUnits(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

export function dssRosterEraSignature(roster: MatchRosterSnapshot, coachId?: string) {
  const players = roster.players
    .toSorted((left, right) => roleOrder(left.role) - roleOrder(right.role) || left.id.localeCompare(right.id))
    .map((player) => `${player.role}:${player.id}`)
    .join('|')
  return `${roster.completeness}|${players}|coach:${coachId ?? ''}`
}

function retainedRolePairs(previousRoster: MatchRosterSnapshot, currentRoster: MatchRosterSnapshot) {
  const previousByRole = playersByRole(previousRoster)
  const currentByRole = playersByRole(currentRoster)
  return {
    jungleMid: sameRolePlayer(previousByRole, currentByRole, 'Jungle') && sameRolePlayer(previousByRole, currentByRole, 'Mid'),
    botDuo: sameRolePlayer(previousByRole, currentByRole, 'Bot') && sameRolePlayer(previousByRole, currentByRole, 'Support'),
    topJungle: sameRolePlayer(previousByRole, currentByRole, 'Top') && sameRolePlayer(previousByRole, currentByRole, 'Jungle'),
  }
}

function playersByRole(roster: MatchRosterSnapshot) {
  return new Map(roster.players.map((player) => [player.role, player.id]))
}

function sameRolePlayer(previousByRole: Map<Role, string>, currentByRole: Map<Role, string>, role: Role) {
  const previous = previousByRole.get(role)
  return Boolean(previous && previous === currentByRole.get(role))
}

function retainedPlayerIds(previousRoster: MatchRosterSnapshot, currentRoster: MatchRosterSnapshot) {
  const current = new Set(currentRoster.players.map((player) => player.id))
  return new Set(previousRoster.players.map((player) => player.id).filter((playerId) => current.has(playerId)))
}

function retainedPlayerCountShare(previousRoster: MatchRosterSnapshot, currentRoster: MatchRosterSnapshot) {
  if (previousRoster.players.length === 0) return 0
  return retainedPlayerIds(previousRoster, currentRoster).size / previousRoster.players.length
}

function unknownShotcallerProxy(previousRoster: MatchRosterSnapshot, currentRoster: MatchRosterSnapshot) {
  const previousByRole = playersByRole(previousRoster)
  const currentByRole = playersByRole(currentRoster)
  const weights = dssRosterEraModelParameters.unknownShotcallerProxyWeights
  return weights.support * Number(sameRolePlayer(previousByRole, currentByRole, 'Support'))
    + weights.jungle * Number(sameRolePlayer(previousByRole, currentByRole, 'Jungle'))
}

function retainedNumeric(value: boolean | number) {
  return typeof value === 'number' ? value : Number(value)
}

function addRosterEraObservation(
  observations: DssRosterEraObservation[],
  match: MatchRecord,
  side: Side,
  team: string,
  roster: MatchRosterSnapshot | undefined,
  options: BuildDssRosterErasOptions,
) {
  if (!roster) return
  if (!options.includePartialRosters && roster.completeness !== 'complete-five-role') return

  const observation: DssRosterEraObservation = {
    team,
    matchId: match.id,
    date: match.date,
    roster,
    coachId: options.coachIdFor?.({ match, team, side }),
    resumeLedger: [],
    playerContributionLedger: [],
    synergyLedger: [],
  }
  observation.resumeLedger.push(...(options.resumeLedgerIdsFor?.(observation) ?? []))
  observation.playerContributionLedger.push(...(options.playerContributionLedgerIdsFor?.(observation) ?? []))
  observation.synergyLedger.push(...(options.synergyLedgerIdsFor?.(observation) ?? []))
  observations.push(observation)
}

function createRosterEra(
  observation: DssRosterEraObservation,
  options: BuildDssRosterErasOptions,
): DeservedStandingRosterEra {
  const era = {
    team: observation.team,
    roster: observation.roster,
    ...(observation.coachId === undefined ? {} : { coachId: observation.coachId }),
    startDate: observation.date,
    matches: [observation.matchId],
    resumeLedger: [...observation.resumeLedger],
    playerContributionLedger: [...observation.playerContributionLedger],
    synergyLedger: [...observation.synergyLedger],
  }
  return {
    ...era,
    uncertainty: options.uncertaintyFor?.(era) ?? 0,
  }
}

function eraWithoutUncertainty(era: DeservedStandingRosterEra): Omit<DeservedStandingRosterEra, 'uncertainty'> {
  return {
    team: era.team,
    roster: era.roster,
    ...(era.coachId === undefined ? {} : { coachId: era.coachId }),
    startDate: era.startDate,
    ...(era.endDate === undefined ? {} : { endDate: era.endDate }),
    matches: era.matches,
    resumeLedger: era.resumeLedger,
    playerContributionLedger: era.playerContributionLedger,
    synergyLedger: era.synergyLedger,
  }
}

function compareMatchesByDateAndId(left: MatchRecord, right: MatchRecord) {
  return left.date.localeCompare(right.date) || left.id.localeCompare(right.id)
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

function roleOrder(role: Role) {
  return ['Top', 'Jungle', 'Mid', 'Bot', 'Support'].indexOf(role)
}
