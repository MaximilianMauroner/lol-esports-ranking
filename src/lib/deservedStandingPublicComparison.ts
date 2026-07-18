import type {
  DeservedStandingEligibilityLabel,
  MatchRecord,
  MatchRosterSnapshot,
  TeamProfile,
  TeamStanding,
} from '../types'
import { isDevelopmentalTeamName } from './model'
import type { PublicDeservedStandingComparison, PublicTeamRollingMovement } from './publicArtifacts/schema'
import { type RegionDeservedStandingComparison, type RegionStrength } from './regionStrength'
import { dssRosterValidity, type DssReferenceStrengthContext, type DssSeriesLedgerEntry } from './deservedStanding'
import { buildDeservedStandingModel, type DeservedStandingTeamSummary } from './deservedStandingModel'
import { buildDeservedStandingRegionModel, type DeservedStandingRegionSummary } from './deservedStandingRegions'

export type ComputedTeamStanding = TeamStanding & {
  deservedStanding?: PublicDeservedStandingComparison
  rollingMovement?: PublicTeamRollingMovement
}

export function withDeservedStandingComparison(
  standings: TeamStanding[],
  matches: MatchRecord[],
  {
    contextStandings = standings,
    useCheckpointBaseline = false,
  }: { contextStandings?: TeamStanding[], useCheckpointBaseline?: boolean } = {},
): ComputedTeamStanding[] {
  if (standings.length === 0 || matches.length === 0) return standings

  const dssContext = standingContextForDss(contextStandings, useCheckpointBaseline)
  const rosterValidityFor = dssRosterValidityResolver(matches, dssContext.standingByTeam)
  const model = buildDeservedStandingModel(matches, {
    baseScoreFor: dssContext.baseScoreFor,
    referenceStrengthFor: dssContext.referenceStrengthFor,
    rosterValidityFor,
  })
  const dssByTeam = new Map(model.teams.map((team) => [team.team, team]))

  return standings.map((standing) => {
    const deservedStanding = compactDeservedStandingComparison(standing, dssByTeam.get(standing.team))
    return deservedStanding ? { ...standing, deservedStanding } : standing
  })
}

export function withDeservedStandingRegionComparison(
  regions: RegionStrength[],
  matches: MatchRecord[],
  teams: Record<string, TeamProfile>,
  standings: ComputedTeamStanding[],
  {
    contextStandings = standings,
    useCheckpointBaseline = false,
  }: { contextStandings?: TeamStanding[], useCheckpointBaseline?: boolean } = {},
): RegionStrength[] {
  if (regions.length === 0 || matches.length === 0) return regions

  const dssContext = standingContextForDss(contextStandings, useCheckpointBaseline)
  const regionByName = new Map(regions.map((region) => [region.region, region]))
  const rosterValidityFor = dssRosterValidityResolver(matches, dssContext.standingByTeam)
  const model = buildDeservedStandingRegionModel(matches, teams, {
    baseScoreFor: dssContext.baseScoreFor,
    referenceStrengthFor: dssContext.referenceStrengthFor,
    regionPriorFor: (region) => regionByName.get(region)?.score ?? 1500,
    rosterValidityFor,
  })
  const dssByRegion = new Map<string, DeservedStandingRegionSummary>(model.regions.map((region) => [region.region, region]))

  return regions.map((region) => {
    const deservedStanding = compactDeservedStandingRegionComparison(region, dssByRegion.get(region.region))
    return deservedStanding ? { ...region, deservedStanding } : region
  })
}

export function teamNamesForDssContext(matches: MatchRecord[]) {
  return new Set(matches.flatMap((match) => [match.teamA, match.teamB]))
}

function standingContextForDss(contextStandings: TeamStanding[], useCheckpointBaseline: boolean) {
  const standingByTeam = new Map(contextStandings.map((standing) => [standing.team, standing]))

  return {
    standingByTeam,
    baseScoreFor(team: string) {
      const standing = standingByTeam.get(team)
      if (!standing) return undefined
      return useCheckpointBaseline ? standing.previousRating : standing.rating
    },
    referenceStrengthFor({ team }: DssReferenceStrengthContext) {
      return standingByTeam.get(team)?.rating ?? 1500
    },
  }
}

function compactDeservedStandingComparison(
  standing: TeamStanding,
  dss: DeservedStandingTeamSummary | undefined,
): PublicDeservedStandingComparison | undefined {
  if (!dss) return undefined

  return {
    leaderboard: 'main-deserved-standings',
    rank: dss.rank,
    score: Math.round(dss.dss),
    rankDeltaFromPower: standing.rank - dss.rank,
    scoreDeltaFromPower: Math.round(dss.dss - standing.rating),
    eligibility: deservedStandingEligibilityFor(standing),
    rosterValidity: roundedNumber(dss.currentRosterValidity, 3),
    winsAboveExpectation: roundedNumber(dss.winsAboveExpectation, 2),
    gameDifferentialAboveExpectation: roundedNumber(dss.gameDifferentialAboveExpectation, 2),
    resumePoints: Math.round(dss.components.resumePoints),
    scheduleStrengthPoints: Math.round(dss.components.scheduleStrengthPoints),
    stagePoints: Math.round(dss.components.stagePoints),
    incomingPlayerBridgeCredit: Math.round(dss.components.incomingPlayerBridgeCredit),
  }
}

function compactDeservedStandingRegionComparison(
  region: RegionStrength,
  dss: DeservedStandingRegionSummary | undefined,
): RegionDeservedStandingComparison | undefined {
  if (!dss) return undefined

  return {
    rank: dss.rank,
    score: Math.round(dss.dss),
    rankDeltaFromPower: region.rank - dss.rank,
    scoreDeltaFromPower: Math.round(dss.dss - region.score),
    internationalResumePoints: Math.round(dss.internationalResumePoints),
    seedPerformancePoints: Math.round(dss.seedPerformancePoints),
    stagePoints: Math.round(dss.stagePoints),
    seedPerformanceRate: roundedNumber(dss.seedPerformanceRate, 3),
    internationalWinsAboveExpectation: roundedNumber(dss.internationalWinsAboveExpectation, 2),
    connectivity: roundedNumber(dss.connectivity, 3),
  }
}

function dssRosterValidityResolver(
  matches: MatchRecord[],
  standingByTeam: ReadonlyMap<string, TeamStanding>,
) {
  const matchById = new Map(matches.map((match) => [match.id, match]))
  const latestRosterByTeam = latestCompleteRosterByTeam(matches)

  return (entry: DssSeriesLedgerEntry) => {
    const standingFallback = dssRosterValidityForStanding(standingByTeam.get(entry.team))
    const match = matchById.get(entry.finalMatchId)
    const currentRoster = latestRosterByTeam.get(entry.team)
    const entryRoster = match ? rosterForMatchTeam(match, entry.team) : undefined
    if (!currentRoster || !entryRoster) return standingFallback
    if (currentRoster.completeness !== 'complete-five-role' || entryRoster.completeness !== 'complete-five-role') {
      return standingFallback
    }

    const retainedPlayerContributionShare = retainedPlayerShare(entryRoster, currentRoster)
    return dssRosterValidity({
      retainedPlayerContributionShare,
      retainedSynergy: retainedPlayerContributionShare,
      orgCoachContinuity: 1,
    })
  }
}

function dssRosterValidityForStanding(standing: TeamStanding | undefined) {
  if (!standing) return 0.5
  if (standing.rosterBasis === 'sourced') return 1
  if (standing.rosterBasis === 'assumed-continuous') return 0.65
  return 0.5
}

function latestCompleteRosterByTeam(matches: MatchRecord[]) {
  const latest = new Map<string, MatchRosterSnapshot>()
  for (const match of matches.toSorted(compareMatchesByDateAndId)) {
    for (const team of [match.teamA, match.teamB]) {
      const roster = rosterForMatchTeam(match, team)
      if (roster?.completeness === 'complete-five-role') latest.set(team, roster)
    }
  }
  return latest
}

function rosterForMatchTeam(match: MatchRecord, team: string): MatchRosterSnapshot | undefined {
  if (match.teamA === team) return match.teamARoster
  if (match.teamB === team) return match.teamBRoster
  return undefined
}

function retainedPlayerShare(previousRoster: MatchRosterSnapshot, currentRoster: MatchRosterSnapshot) {
  if (previousRoster.players.length === 0) return 0
  const currentPlayerIds = new Set(currentRoster.players.map((player) => player.id))
  return previousRoster.players.filter((player) => currentPlayerIds.has(player.id)).length / previousRoster.players.length
}

function compareMatchesByDateAndId(left: MatchRecord, right: MatchRecord) {
  return left.date.localeCompare(right.date) || left.id.localeCompare(right.id)
}

function deservedStandingEligibilityFor(standing: TeamStanding): DeservedStandingEligibilityLabel {
  if (isDevelopmentalTeamName(standing.team)) return 'Developmental'
  if (standing.rosterBasis !== 'sourced') return 'Provisional'
  if (standing.eligibility.reasons.includes('stale')) return 'Inactive'
  if (standing.eligibility.reasons.includes('low-current-volume')) return 'Insufficient current-roster sample'
  if (standing.eligibility.reasons.includes('unanchored-league')) return 'Insufficient league connectivity'
  if (!standing.eligibility.eligible) return 'Provisional'
  return 'Eligible'
}

function roundedNumber(value: number, digits: number) {
  return Number(value.toFixed(digits))
}
